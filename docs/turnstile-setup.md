# Turnstile setup — anti-bot for `/v1/claim/confirm`

Turnstile is Cloudflare's invisible CAPTCHA. We use it as the single
highest-value defense against scripted mass-registration attacks (see the
2026-05-12 phishing campaign, where a curl loop registered 119 mailboxes
in 4 hours). When configured, every browser-side mailbox claim must come
with a valid human-verification token — pure-API attackers (curl, aiohttp)
cannot produce one.

The code lives in `mails-web/functions/v1/claim/{guards,confirm}.ts` and
`mails-web/public/index.html`. **The code ships disabled by default** —
when `TURNSTILE_SECRET` is unset, verification is skipped (warning
logged), so deploying the code does not break the page. Follow the steps
below to turn it on.

## 1. Create a Turnstile site

1. Sign in to https://dash.cloudflare.com → **Turnstile** in the sidebar
2. Click **Add Site**
3. Name: `mails0.com claim form`
4. Domain: `mails0.com` (Cloudflare automatically allows the apex and `www.`)
5. Widget mode: **Managed** (lets CF decide interactive vs invisible per request)
6. Pre-clearance: **No** (we don't need page-load clearance, just the claim form)
7. Click **Create**. Copy the **Site Key** and **Secret Key**

## 2. Set the secret on Cloudflare Pages

```bash
# From inside mails-web/
wrangler pages secret put TURNSTILE_SECRET --project-name mails-web
# Paste the secret key when prompted
```

Verify with:
```bash
wrangler pages secret list --project-name mails-web
```

You should see `TURNSTILE_SECRET` in the list.

## 3. Update the site key in `index.html`

Open `mails-web/public/index.html` and replace the placeholder:

```diff
-           data-sitekey="REPLACE_WITH_TURNSTILE_SITEKEY"
+           data-sitekey="0x4AAAAAAA..."   <!-- your site key -->
```

Commit and push — Cloudflare Pages auto-deploys.

## 4. Verify it works

Open https://mails0.com in an incognito window. Try claiming a name.
You should see the Turnstile widget appear briefly (interaction-only mode
means it's usually invisible unless CF decides the request is suspicious).

Then verify the audit trail:
```bash
wrangler d1 execute mails --remote \
  --command="SELECT turnstile_verified, COUNT(*) FROM claim_sessions
             WHERE status='complete' AND created_at > '2026-05-31'
             GROUP BY turnstile_verified;"
```

You should see `turnstile_verified=1` for all new claims. Any
`turnstile_verified=0` after this point means either:
- The secret is unset (check `wrangler pages secret list`)
- The frontend sitekey is still the placeholder
- An attacker bypassed (very unlikely — investigate)

## 5. Reverse / disable

To disable Turnstile temporarily without redeploying:

```bash
wrangler pages secret delete TURNSTILE_SECRET --project-name mails-web
```

Verification will skip with a console warning at the worker level. The
widget will still render in the browser (until you also revert the
sitekey), but its token is no longer required.

## Reference

- Server-side validation: <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Widget config reference: <https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/>
- Error codes: <https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/>
