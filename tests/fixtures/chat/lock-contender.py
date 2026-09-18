#!/usr/bin/env python3
"""A foreign holder of the per-checkout lease, written the way Caller's
fix-failing-ci worker is expected to hold it (poise-contract.md §1).

Used by tests/chat/checkout-lock.test.ts to prove the TypeScript lock and a
Python sqlite3 client agree on the file, the schema and the rules.

Usage:
  lock-contender.py acquire <checkout> <hold-seconds> [--worker-pid PID]
      prints `acquired <token>` (or `busy <owner_label>` and exits 3), holds
      the lease with heartbeats for hold-seconds, then releases and prints
      `released`.
  lock-contender.py try <checkout>
      one attempt; prints `acquired <token>` (then releases at once) or
      `busy <reason> <owner_label>`.
"""
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import time
from datetime import datetime, timezone

LEASE_MS = 90_000
HEARTBEAT_MS = 20_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS lease (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  token          TEXT    NOT NULL,
  checkout       TEXT    NOT NULL,
  owner_kind     TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL,
  owner_label    TEXT    NOT NULL,
  instance       TEXT    NOT NULL,
  host_pid       INTEGER NOT NULL,
  worker_pid     INTEGER,
  worker_pgid    INTEGER,
  worker_ident   TEXT,
  branch         TEXT,
  acquired_at    TEXT    NOT NULL,
  heartbeat_at   TEXT    NOT NULL,
  lease_until    INTEGER NOT NULL
)
"""


def lock_path(checkout: str):
    canonical = os.path.realpath(checkout).rstrip("/") or "/"
    key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
    directory = os.environ.get("POISE_LOCK_DIR") or os.path.join(os.path.expanduser("~"), ".poise", "locks")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    return os.path.join(directory, f"checkout-{key}.sqlite3"), canonical


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def pgid_alive(pgid):
    if not pgid:
        return False
    try:
        os.kill(-int(pgid), 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def now_ms():
    return int(time.time() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def connect(path):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    os.chmod(path, 0o600)
    db.execute(SCHEMA)
    return db


def try_acquire(db, canonical, token, worker_pid=None):
    now = now_ms()
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT * FROM lease WHERE id = 1").fetchone()
        cols = [c[1] for c in db.execute("PRAGMA table_info(lease)")]
        if row is not None:
            row = dict(zip(cols, row))
            if token and row["token"] == token:
                db.execute("UPDATE lease SET heartbeat_at = ?, lease_until = ? WHERE id = 1 AND token = ?", (iso(now), now + LEASE_MS, token))
                db.execute("COMMIT")
                return "acquired", token
            if alive(row["host_pid"]):
                db.execute("COMMIT")
                return "busy live_host", row["owner_label"]
            if row["lease_until"] >= now:
                db.execute("COMMIT")
                return "busy lease_valid", row["owner_label"]
            if pgid_alive(row["worker_pgid"]) or alive(row["worker_pid"]):
                db.execute("COMMIT")
                return "busy orphan_worker", row["owner_label"]
        token = secrets.token_hex(16)
        db.execute(
            "INSERT OR REPLACE INTO lease (id, token, checkout, owner_kind, owner_id, owner_label, instance, host_pid, worker_pid, worker_pgid, worker_ident, branch, acquired_at, heartbeat_at, lease_until)"
            " VALUES (1, ?, ?, 'caller:fix-failing-ci', 'call-test', 'fix-failing-ci test (python)', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            (token, canonical, f"caller:{os.getpid()}", os.getpid(), worker_pid, worker_pid, iso(now), iso(now), now + LEASE_MS),
        )
        db.execute("COMMIT")
        return "acquired", token
    except Exception:
        db.execute("ROLLBACK")
        raise


def release(db, token):
    db.execute("BEGIN IMMEDIATE")
    changed = db.execute("DELETE FROM lease WHERE id = 1 AND token = ?", (token,)).rowcount
    db.execute("COMMIT")
    return changed == 1


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 64
    mode, checkout = argv[1], argv[2]
    path, canonical = lock_path(checkout)
    db = connect(path)
    if mode == "try":
        status, detail = try_acquire(db, canonical, None)
        if status == "acquired":
            release(db, detail)
        print(status, detail, flush=True)
        return 0 if status == "acquired" else 3
    if mode == "acquire":
        hold = float(argv[3])
        worker_pid = None
        if "--worker-pid" in argv:
            worker_pid = int(argv[argv.index("--worker-pid") + 1])
        status, detail = try_acquire(db, canonical, None, worker_pid)
        if status != "acquired":
            print(status, detail, flush=True)
            return 3
        token = detail
        print("acquired", token, flush=True)
        deadline = time.time() + hold
        while time.time() < deadline:
            time.sleep(min(0.2, max(0.0, deadline - time.time())))
            now = now_ms()
            db.execute("BEGIN IMMEDIATE")
            renewed = db.execute("UPDATE lease SET heartbeat_at = ?, lease_until = ? WHERE id = 1 AND token = ?", (iso(now), now + LEASE_MS, token)).rowcount
            db.execute("COMMIT")
            if renewed != 1:
                print("lost", flush=True)
                return 4
        release(db, token)
        print("released", flush=True)
        return 0
    print(json.dumps({"error": "unknown mode"}))
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
