# Behavior integration contract

Poise is a trigger and orchestration layer. It does not read GitHub source,
construct reviews, or mutate review threads itself.

Each behavior follows one transaction shape:

1. Gate on fresh `github-datastore` consumer state.
2. Read one immutable fact packet from `github-interface`, including head SHA
   and acting GitHub identity.
3. Persist launch intent with behavior, target, actor, source, correlation ID,
   and expected head before starting detached work.
4. Let `agent-interface` perform model work using only the permitted
   `github-interface` primitives.
5. Reconcile the durable agent outcome by exact correlation ID. Accept only
   an expected action/outcome pair on the expected head.
6. Dead-letter uncertain terminal work. Never retry an ambiguous side effect.

`review-new-prs` accepts either one atomic `requested_changes` review or the
authoritative `reviewed_clean` outcome. `approve-prs` accepts one head-pinned
approval or one atomic change request. A clean review becomes approval-eligible
on the next scheduler scan. `resolve-unblocking` uses the upstream strong
resolution primitive, which revalidates the complete gate before every thread
mutation.

New behaviors must add the required atomic fact or mutation upstream first.
They must not add GitHub authentication, GraphQL, REST, or repository-source
access to Poise.
