# Cloudflare Email Service Research

Date: 2026-04-10
Status: Research complete, waiting for GA

## Summary

Cloudflare Email Service was announced in private beta on September 26, 2025. It unifies Email Routing (receiving) and Email Sending into a single service with native Workers bindings.

## Key Facts

- **Status:** Private beta (as of April 2026). Apply via Cloudflare Dashboard.
- **Pricing:** Requires paid Workers plan. Charged per message sent. Exact pricing not finalized.
- **Bindings:** Native Workers bindings (no API keys needed for sending).
- **DNS:** Auto-configures SPF, DKIM, DMARC records.
- **API:** Supports REST API and SMTP.
- **Frameworks:** Compatible with React Email and other templating libraries.

## Integration Plan for mails-agent

### Architecture (when GA)

```
Current:
  handleSend() → Resend API (via RESEND_API_KEY)

Target:
  handleSend() → CF Email Service binding (primary, if available)
                → Resend API (fallback, if CF binding unavailable)
```

### Implementation Steps

1. Add `email_send` binding to `wrangler.toml`:
   ```toml
   [email_send]
   binding = "EMAIL_SEND"
   ```

2. Create `worker/src/providers/cf-email.ts`:
   ```typescript
   export async function sendViaCFEmail(env: Env, payload: SendPayload): Promise<string> {
     // Use env.EMAIL_SEND binding
     // Returns message ID
   }
   ```

3. Modify `handleSend()` to try CF Email first, fall back to Resend:
   ```typescript
   if (env.EMAIL_SEND) {
     return await sendViaCFEmail(env, payload)
   }
   if (env.RESEND_API_KEY) {
     return await sendViaResend(env, payload)
   }
   ```

4. Delivery status: CF Email Service likely has its own callback mechanism. Need to research equivalent of Resend's Svix webhooks.

### What Changes for Users

- **Self-hosted users:** Add `email_send` binding to wrangler.toml. No more RESEND_API_KEY needed for sending. Resend becomes optional fallback.
- **Cost:** Potentially cheaper than Resend for high-volume senders (CF pricing TBD vs Resend's $0.0004/email on paid plans).
- **Simplicity:** One fewer external service to configure. All on Cloudflare.

### Blockers

1. CF Email Service not yet in GA
2. Pricing details not finalized
3. Need to verify delivery callback mechanism
4. Need early access to test integration

### Decision

Wait for GA announcement. When available:
1. Apply for early access to test
2. Implement dual-provider pattern (CF primary, Resend fallback)
3. Update deploy command to configure CF Email binding
4. Update docs with new setup flow

### References

- Blog: https://blog.cloudflare.com/email-service/
- Docs: https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/
- InfoQ coverage: https://www.infoq.com/news/2025/10/cloudflare-email-service/
