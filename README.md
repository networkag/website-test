# Test contact form — setup

Files:
- `index.html` — the form (no design, just functional). Open it directly or host it anywhere.
- `worker.js` — the Cloudflare Worker backend.
- `wrangler.toml` — Worker config/deploy file.

Stack: **HTML form → Cloudflare Turnstile → Cloudflare Worker → Resend → your inbox.** No storage.

---

## A. Cloudflare Turnstile (bot check)

1. Cloudflare dashboard → **Turnstile** → **Add site**.
2. Domain: add the real domain you'll host this on. For local testing, also
   add `localhost` as a second hostname on the same widget — Turnstile
   explicitly supports this for local dev.
3. Widget mode: **Managed** (recommended default).
4. Copy the **Site Key** → paste into `index.html` as `TURNSTILE_SITE_KEY`.
5. Copy the **Secret Key** → you'll set this as a Worker secret in step D.

## B. Resend (email sending)

1. Sign up at [resend.com](https://resend.com) — no card required.
2. Dashboard → **API Keys** → create one, copy it (starts with `re_`).
3. Two paths for `FROM_EMAIL`:
   - **Fastest for testing**: leave `FROM_EMAIL` as `onboarding@resend.dev`
     (already set in `wrangler.toml`). No domain setup needed at all — but
     Resend will only actually deliver to the email address you signed up
     with, so `TO_EMAIL` must be that same address.
   - **To send to anyone / use your own domain**: Resend dashboard →
     **Domains** → add your domain → add the shown DKIM/SPF DNS records →
     wait for verification. Then set `FROM_EMAIL` to an address on that
     domain (e.g. `form@yourdomain.com`).

## C. Workers KV (rate limiting + duplicate detection)

```bash
npm install -g wrangler   # if you don't have it
wrangler login
wrangler kv namespace create RATE_LIMIT_KV
```

Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

## D. Deploy the Worker

```bash
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put RESEND_API_KEY

wrangler deploy
```

Wrangler prints your Worker's URL
(`https://contact-form-worker.<your-subdomain>.workers.dev`). Paste it into
`index.html` as `WORKER_URL`.

## E. Run the form

Don't just double-click `index.html` — opening it as a `file://` page sends
`Origin: null`, which Turnstile and some browsers handle inconsistently.
Serve it locally instead:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/index.html` (this matches the `localhost`
hostname you added to the Turnstile widget in step A).

## F. Test it works

- Normal submission → email arrives in `TO_EMAIL`, form shows "Thanks —
  your message was sent."
- Submit again immediately with the same text → rejected (duplicate/rate
  limit).
- In devtools, set the hidden `website` field's value and submit → you get
  a fake "success" response but **no email is sent** — the honeypot working
  as intended.
- Try `test@test` or `notanemail` in the email field → rejected client-side
  immediately, before Turnstile is even checked.

---

## Troubleshooting the 3 things you ran into

**"No verification challenge appears."**
This is expected, not broken. Turnstile's Managed mode automatically decides whether a visible check is needed based on risk signals from the browser — it only prompts for interaction if it can't already tell you're human. For a normal browser on a low-risk connection, it typically passes silently in the background with nothing to click, and just hands your JS a token. You can force something visible for testing by switching the widget to "Non-Interactive" mode in the Turnstile dashboard (shows a spinner) — but Managed mode showing nothing at all is normal, working behavior.

**The "troubleshoot"-looking thing that did nothing.**
That was almost certainly Turnstile's own inline error state, not a real button — it shows up when the sitekey doesn't match a real widget (e.g. it's still the `YOUR_TURNSTILE_SITE_KEY` placeholder) or the current hostname isn't registered for that widget. I've now wired up `error-callback` in `index.html`, so instead of that opaque state you'll get a plain-English message in the status area telling you exactly that. If you still see it after setting a real site key, double check the hostname you're testing from is added to the widget in step A.

**"It asks to complete a verification challenge yet shows none."**
Same root cause as above: the widget errored out (bad/placeholder sitekey or disallowed hostname) so it never produced a token, but the form still correctly refuses to submit without one. Once A is done properly, this resolves — and per the first point, "resolves" often just means it submits instantly with no visible challenge, which is correct behavior.

---

## What's protecting this endpoint

- **Turnstile** — verified server-side against Cloudflare's `siteverify` API, never trusted from the client.
- **Honeypot field** — invisible to real users; bots that auto-fill every input trip it.
- **Server-side validation** — required fields, max lengths, and an email format check (`name@domain.tld`, minimum 2-char TLD) enforced independently on the server, regardless of what client-side JS did or didn't catch.
- **Rate limiting** — per-IP via Workers KV: 3/minute and 20/day by default (tune `PER_MINUTE_LIMIT` / `PER_DAY_LIMIT` in `worker.js`). KV is eventually consistent (writes can take up to ~60s to propagate globally), so treat this as a strong deterrent, not an atomic hard limit.
- **Duplicate detection** — identical `(ip, email, message)` submissions within 5 minutes are rejected.
- **CORS/origin check** — set `ALLOWED_ORIGIN` in `wrangler.toml` to your real site's exact origin before going live (leave `"*"` only for testing).
- Nothing from the browser is trusted as-is: every field is re-validated, re-sanitized, and re-length-checked on the server regardless of what the HTML form's `required`/`maxlength` attributes already enforce client-side.

## Storage

None — intentionally stateless beyond the KV counters above (which expire automatically). If you later want a record of submissions, the cleanest addition is writing each accepted one to a D1 database or a KV log before calling `sendEmail`.
