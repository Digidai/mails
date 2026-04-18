IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. Black-box HTTP test only, using curl.

You are AI agent "$AGENT_ROLE" participating in a multi-agent email scenario against the mails-agent production API. Three independent agents each have their own mailbox and email each other to simulate real cross-tenant usage.

## Your identity

- Your mailbox: $MY_MAILBOX
- Your API key: $MY_KEY
- Base URL: https://api.mails0.com

## Team members (do NOT use their keys)

- INITIATOR at: $INITIATOR_MB
- RESPONDER_1 at: $RESPONDER_1_MB
- RESPONDER_2 at: $RESPONDER_2_MB

## Your role

### If you are INITIATOR (Codex-style)

1. **Send kick-off email** to RESPONDER_1 (CC RESPONDER_2):
   - Subject: "Weekend Hackathon — Your verification code: 482913"
   - Body: "Your verification code is 482913. Please reply with your availability."
2. **Poll inbox** every 15s for up to 120s, waiting for replies from both responders.
3. **Extract** using `POST /v1/extract` type=code on each reply.
4. **Send final confirmation** using `in_reply_to` (set to one of the replies' message_ids).
5. **Verify thread** via `GET /v1/threads`.

### If you are RESPONDER_1 (Gemini-style)

1. **Wait for email** from INITIATOR (poll every 15s, up to 120s).
2. **Extract code** from the email using `POST /v1/extract`.
3. **Reply** with `in_reply_to` set to INITIATOR's message_id:
   - Subject: "Re: Weekend Hackathon — I'm in"
   - Body: "I'm available. My verification code is 579246."
   - CC: RESPONDER_2
4. **Send order follow-up** to RESPONDER_2:
   - Subject: "FYI: Hackathon supplies order #HACKATHON-GEMINI-7"
   - Body: "Your total is $42.50. Order #HACKATHON-GEMINI-7."
5. **Verify** your thread contains the Codex email.

### If you are RESPONDER_2 (Claude-style)

1. **Wait** for CC'd email from INITIATOR and direct email from RESPONDER_1.
2. **Extract** code from INITIATOR's email (expect 482913).
3. **Extract** order from RESPONDER_1's email (expect total 42.50, order_id HACKATHON-GEMINI-7).
4. **Reply-all to INITIATOR** using in_reply_to, CC RESPONDER_1:
   - Subject: "Re: Weekend Hackathon — Security confirmation code: 315072"
   - Body: "Confirmed. Your security code is 315072."
5. **Verify search** — `GET /v1/inbox?query=Hackathon` should return your received emails.

## What to report

- `STEP N: <result> — <details>`
- `EXTRACTED: <codes>, <orders>`
- `THREADS: <count>`
- `ANY_BUGS_FOUND: [...]`

Pay special attention to:
- **Thread isolation** — your reply should be in YOUR OWN thread, not inherit the initiator's thread_id (that would be a cross-mailbox leak)
- **from_address** — should show the real sender mailbox, not a SES return-path
- **Extraction accuracy** — codes and order data should be correct
- **CC propagation** — CC'd recipients should actually receive the email

## Budget

~10 minutes. The other two agents run in parallel. Don't delete anything (others need the data). If you don't see expected emails by 90s, proceed with what you have.
