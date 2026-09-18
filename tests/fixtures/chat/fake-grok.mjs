// A stand-in for `grok --permission-mode default agent stdio` (grok 1.0.34):
// serves one of the recorded, sanitized live ACP traces back to the adapter
// (`--replay <trace>`), so the tests exercise the exact frames the real
// binary produced, including its client-bound requests.

import { replayTrace } from './fake-rpc.mjs'

const replayAt = process.argv.indexOf('--replay')
if (replayAt === -1) {
  process.stderr.write('fake-grok: --replay <trace> is required\n')
  process.exit(2)
}
replayTrace(process.argv[replayAt + 1])
