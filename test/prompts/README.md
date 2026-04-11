# Agent Team QA Prompts

Reusable prompts for running AI agent teams against the mails-agent API.

## Why agent teams?

Single-AI QA misses bugs that humans and unit tests also miss. We ran 3 AI agents
(OpenAI Codex, Google Gemini, Claude subagent) as independent black-box testers
against v1.9.0 and they found **25 real bugs in 2 hours** — 3 of them P0 (crash,
method bypass, cross-tenant leak) that all other testing methods had missed.

Three independent perspectives + parallel execution + willingness to probe at
scale = a much better bug-finding ratio than any single tester.

## Prompts

### `01-regression.md`

Single-mailbox regression check. Tests the 17+ P0/P1 bugs from v1.9.0 → v1.9.1.
Run this before every release to catch regressions. Takes ~5-10 minutes per agent.

**Usage:**
```bash
# Create a test mailbox first, then for each agent:
codex exec "$(cat test/prompts/01-regression.md | envsubst)" -s workspace-write
gemini -p "$(cat test/prompts/01-regression.md | envsubst)"
# Claude: use Agent tool with the prompt content
```

Set env vars before running:
```bash
export API_KEY=mk_xxx
export MAILBOX=test@mails0.com
```

### `02-multi-agent-scenario.md`

Three-mailbox scenario where agents email each other. Tests:
- Cross-mailbox send/receive
- Threading with `in_reply_to`
- CC propagation
- Verification code extraction end-to-end
- Structured data extraction (order)

This is how we found the cross-mailbox thread_id leak (P0). Run this when you
change anything in `handlers/send.ts`, `handlers/mailbox.ts`, or `threading.ts`.

**Usage:** you need 3 separate mailboxes (one per agent). See the prompt for
setup.

### `03-exploratory.md`

Open-ended black-box exploration. Gives the agent a list of endpoints and asks
it to find bugs however it wants. Slowest but highest-signal — this is what
found most of the 25 bugs. Run before major releases.

## Expected output format

Each prompt asks the agent to report findings as:
- `PASS: <what was tested>`
- `BUG P0/P1/P2: <description>`
- `WEIRD: <surprising behavior>`
- `QUESTION: <needs clarification>`

## Cross-model consensus

When 2+ agents independently report the same bug, treat it as confirmed (high
signal). Single-agent findings are lower confidence and should be verified
before fixing.

## Cleanup

All prompts instruct the agent to clean up test data. If something was missed,
just DELETE /v1/mailbox on the test mailbox — it cascades.
