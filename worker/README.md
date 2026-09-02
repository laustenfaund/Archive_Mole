# Archive Mole assistant proxy

A Cloudflare Worker that stands between the [`hosted/`](../hosted) build of
Archive Mole and Anthropic's API. It holds your real Anthropic API key as a
server-side secret — the browser never sees it — and enforces a spending
cap before forwarding any request, gated by a passcode you hand out.

This exists because a plain static site (like the root `index.html`, which
is genuinely BYOK — each visitor supplies and pays for their own key) has
nowhere to hide a shared key: anything in that HTML/JS is visible to
anyone who opens dev tools. If you want people to use *your* key instead of
their own, that key has to live behind a server you control, with limits
you control. That's this Worker.

## What it does and doesn't protect against

- **Does**: keep your Anthropic key out of client-side code; require a
  passcode per person; cap spend per passcode per day and in total per
  month, checked *before* the expensive call is made so a burst of
  requests can't all sneak in under the cap at once; restrict which
  models and how many output tokens a request can ask for.
- **Doesn't**: defend against a truly adversarial user who has a valid
  passcode and is deliberately trying to race the cap — Workers KV
  (used for the spend counters) is only eventually consistent. For an
  invite-only personal tool that's an accepted tradeoff. If you ever need
  stronger guarantees, replace the `USAGE` KV reads/writes in
  `src/index.js` with a Durable Object, which can serialize them.

## Setup

Requires a Cloudflare account (free tier is enough) and
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) installed
(`npm install -g wrangler`, then `wrangler login`).

1. **Create the two KV namespaces:**

   ```
   wrangler kv namespace create USAGE
   wrangler kv namespace create PASSCODES
   ```

   Each prints an `id`. Paste them into the matching `[[kv_namespaces]]`
   block in `wrangler.toml`.

2. **Set your real Anthropic key as a secret** (never put it in
   `wrangler.toml` or anywhere else in this repo):

   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```

3. **Set the allowed origin.** Edit `ALLOWED_ORIGIN` in `wrangler.toml` to
   the exact origin `hosted/index.html` will be served from — e.g.
   `https://yourname.github.io` if using GitHub Pages, no trailing slash.
   Requests from any other origin are rejected before the passcode is even
   checked.

4. **Set your caps.** `PER_USER_DAILY_CAP_CENTS` and
   `GLOBAL_MONTHLY_CAP_CENTS` in `wrangler.toml` are in cents (defaults:
   500 = $5.00/day per person, 2000 = $20.00/month total).

5. **Verify the pricing table.** `PRICING` at the top of `src/index.js` is
   a placeholder — check your actual per-model, per-million-token rates at
   `console.anthropic.com` (Settings → Billing) or the Anthropic pricing
   docs, and update the numbers. The caps above are only as accurate as
   this table.

6. **Deploy:**

   ```
   wrangler deploy
   ```

   This prints your Worker's URL, e.g.
   `https://archive-mole-assistant.<your-subdomain>.workers.dev`. Paste
   that into `ASSISTANT_PROXY_URL` near the top of the `<script>` block in
   `hosted/index.html`.

7. **Add a passcode for yourself (and anyone you invite):**

   ```
   node scripts/add-passcode.mjs "a long random passcode" "your-name"
   ```

   This prints a `wrangler kv key put ...` command — run it as shown. Hand
   the *passcode* (not the hash it prints) to whoever it's for, out of
   band (not by email/Slack in plaintext if you want to be careful — a
   password manager's sharing feature works well).

   To revoke someone, re-run the same `wrangler kv key put` command with
   `"active": false` in the JSON value instead of deleting the key — this
   keeps their usage history intact.

## Local testing

`wrangler dev` runs the Worker locally. Put your key in `.dev.vars`
(git-ignored) as `ANTHROPIC_API_KEY=sk-ant-...` for local runs — `wrangler
secret put` only affects the deployed Worker, not `wrangler dev`.

## Cost note

The Worker's own Cloudflare usage (requests, KV reads/writes) stays
comfortably inside Cloudflare's free tier for a small invite-only group.
The only real cost is what you already expect: Anthropic API usage, now
bounded by the caps above instead of open-ended.
