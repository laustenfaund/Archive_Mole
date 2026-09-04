# Archive Mole assistant proxy

A Cloudflare Worker that stands between the [`hosted/`](../hosted) build of
Archive Mole and Anthropic's API. It holds your real Anthropic API key as a
server-side secret — the browser never sees it — and enforces a spending
cap before forwarding any request, gated by a per-visitor credential.

That credential is no longer something you have to hand out yourself: the
first time someone opens the hosted build's assistant panel, their browser
silently calls `POST /v1/register` and gets back its own token, which it
then sends on every request exactly like a hand-typed passcode used to.
There's no screen, no field, no action required from the visitor. You can
still hand-issue a passcode the old way for someone you want to invite
directly (see [Adding a credential](#adding-a-credential-optional) below)
— both kinds are just entries in the same KV namespace and work identically
from here on.

This exists because a plain static site (like the root `index.html`, which
is genuinely BYOK — each visitor supplies and pays for their own key) has
nowhere to hide a shared key: anything in that HTML/JS is visible to
anyone who opens dev tools. If you want people to use *your* key instead of
their own, that key has to live behind a server you control, with limits
you control. That's this Worker.

## What it does and doesn't protect against

- **Does**: keep your Anthropic key out of client-side code; give every
  visitor their own credential (self-issued via `/v1/register`, or
  hand-issued by you) with its own independent daily cap, checked
  *before* the expensive call is made so a burst of requests can't all
  sneak in under the cap at once, plus a shared monthly cap across
  everyone; restrict which models and how many output tokens a request
  can ask for; separately rate-limit registration itself, since minting
  is now the thing standing between "one abuser, capped" and "one
  abuser, capped N thousand times over."
- **Doesn't**: defend against a truly adversarial user who has a valid
  passcode and is deliberately trying to race the cap — Workers KV
  (used for the spend counters) is only eventually consistent. For an
  invite-only personal tool that's an accepted tradeoff. If you ever need
  stronger guarantees, replace the `USAGE` KV reads/writes in
  `src/index.js` with a Durable Object, which can serialize them.

## Setup — dashboard only, no command line needed

Everything below is done by clicking through Cloudflare's website at
[dash.cloudflare.com](https://dash.cloudflare.com). A free account is
enough. This is the path that was actually used to set this up — not
`wrangler` — so it doesn't assume Node, npm, or any installed tools.

1. **Create the Worker.**
   - Dashboard → **Workers & Pages** → **Create** → **Workers** → give it
     a name (e.g. `archive-mole-assistant` — this becomes part of its
     URL) → deploy the placeholder it starts you with.
   - Open the new Worker → **Edit code**. Select all of the placeholder
     code and delete it, then paste in the entire contents of
     [`src/index.js`](src/index.js) from this folder. Click **Deploy**.
   - Whenever you update the code later, always replace the *whole* file
     this way (select all, delete, paste the new whole file) rather than
     editing just part of it in the dashboard editor — a partial edit in
     that editor is easy to get subtly wrong.

2. **Create two KV namespaces.**
   - Dashboard → **Storage & Databases** → **KV** → **Create a
     namespace**. Create one for usage tracking and one for passcodes —
     name them anything unique to your account, e.g.
     `archive-mole-usage` and `archive-mole-passcodes`. This namespace
     name is just a label in your account; it doesn't need to match
     anything in the code.

3. **Bind the namespaces to the Worker.**
   - Worker → **Settings** → **Bindings** → **Add binding** → **KV
     Namespace**.
   - Add one binding with **Variable name** typed exactly `USAGE`,
     pointing at your usage namespace.
   - Add a second with **Variable name** typed exactly `PASSCODES`,
     pointing at your passcodes namespace.
   - These two names are hardcoded in `src/index.js` and must match
     exactly, including case, or the Worker can't find them.

4. **Add the plain-text settings.**
   - Same **Settings** page → **Variables and Secrets** → add three
     plain-text variables:
     - `ALLOWED_ORIGIN` — the exact origin `hosted/index.html` is served
       from, no trailing slash (e.g. `https://yourname.github.io`).
       Requests from any other origin are rejected before the credential
       is even checked, and before a new one can be registered.
     - `PER_USER_DAILY_CAP_CENTS` — cents per person per day (e.g. `500`
       = $5.00).
     - `GLOBAL_MONTHLY_CAP_CENTS` — cents total per month (e.g. `2000` =
       $20.00).
     - Both caps used to bound a small, hand-invited group — now that
       anyone who loads the hosted build gets their own bucket via
       `/v1/register`, worst-case monthly spend is no longer bounded by
       "how many passcodes did I hand out." Consider lowering both,
       and watch actual usage closely for the first week or two after
       turning self-registration on.

5. **Add your real Anthropic key as a secret.**
   - Same page → **Variables and Secrets** → add `ANTHROPIC_API_KEY`,
     but set its type to **Secret** (encrypted), not plain text. Paste
     your real key from `console.anthropic.com`. Never put the real key
     anywhere in this repo.

6. **Redeploy after saving Settings.** This is a real Cloudflare quirk,
   confirmed repeatedly while setting these up: variables, bindings, and
   secrets sometimes don't actually take effect until the Worker's code
   is redeployed, even though the dashboard shows them as saved. After
   adding everything above, go back to **Edit code** and click **Deploy**
   again — no code change needed — to force it to pick everything up. If
   something that looks correctly configured still doesn't work, this is
   the first thing to try.

7. **Check the pricing table.** `PRICING` at the top of `src/index.js`
   has already been verified against Anthropic's published per-model
   rates. If you add a model that isn't in that table, or Anthropic
   changes its pricing, update the numbers there — the spending caps are
   only as accurate as this table.

8. **Copy the Worker's URL.** It's shown at the top of the Worker's
   overview page: `https://archive-mole-assistant.<your-subdomain>.workers.dev`.
   Paste that into `ASSISTANT_PROXY_URL` near the top of the `<script>`
   block in `hosted/index.html`.

9. **That's it — visitors no longer need anything from you.** The first
   time someone opens the hosted build's assistant panel, their browser
   calls `POST /v1/register`, gets back its own token, and stores it —
   no passcode to type, nothing to ask you for. Each auto-issued token
   writes a `passcode:<hash>` entry into your `PASSCODES` namespace just
   like a hand-issued one would (`{"name":"auto-xxxxxxxx","active":true,
   "autoIssued":true,"issuedAt":...}`), so it shows up there and gets its
   own independent daily cap for free.

   `/v1/register` has its own rate limit, separate from and stricter than
   the per-message one — `REGISTER_LIMIT_PER_HOUR` near the top of
   `src/index.js` (default 5 per IP per hour). It's a code constant, not
   a dashboard setting, so change it there and redeploy if you need a
   different number.

### Adding a credential (optional)

You can still hand-issue a passcode yourself for someone you want to
invite directly — useful if you'd rather they not rely on
self-registration, or you want a friendlier `name` in the KV than
`auto-xxxxxxxx`. No installs needed — this is done entirely in your
browser:
   - Open any webpage, open DevTools (F12) → **Console** tab, and run:
     ```js
     async function hashPasscode(p) {
       const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p));
       return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
     }
     await hashPasscode('choose-a-long-random-passcode-here');
     ```
   - This prints a long hex string — that's the hash. **Write the
     passcode itself down somewhere safe before you close this tab.**
     Once it's hashed there's no way to recover the original from the
     hash, and you'll need the raw passcode again if you ever want to
     re-share or double-check it.
   - Dashboard → **Storage & Databases** → **KV** → your `PASSCODES`
     namespace → **Add entry**.
     - **Key**: `passcode:` followed by the hash, all lowercase, exactly
       like that — e.g. `passcode:3a7f...`.
     - **Value**: `{"name":"your-name","active":true}`
   - Hand the *passcode* (not the hash) to whoever it's for, out of band
     — not in plaintext over email/Slack if you want to be careful; a
     password manager's sharing feature works well.
   - To revoke a credential later — hand-issued or auto-issued — edit
     that same KV entry's value to `{"...","active":false}` instead of
     deleting it. This keeps its usage history intact and works
     identically for both kinds.

## If something looks broken but the settings look right

Test in an Incognito/Private browser window before assuming a config
value is wrong. Service Workers and cached local storage can make a
*browser* look broken (stale passcode, stale proxy URL) even when the
server side is fine — a private window starts with none of that cached
state, so it isolates whether the problem is client-side or server-side.

## If you have Node and `wrangler` installed

None of the above requires it, but everything can also be done from the
command line with [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
— `wrangler kv namespace create`, `wrangler secret put`,
`wrangler deploy`, and so on. `wrangler.toml` in this folder documents
the same settings for that path, and `scripts/add-passcode.mjs` will
print the exact `wrangler kv key put` command for the optional
hand-issued path above. Use whichever path you have the tools for — they
produce the same result.

## Cost note

The Worker's own Cloudflare usage (requests, KV reads/writes) stays
comfortably inside Cloudflare's free tier even with self-service
registration. The only real cost is what you already expect: Anthropic
API usage, bounded by the caps above — but since anyone who loads the
page can now register their own capped bucket instead of only people you
personally invited, worst-case total spend is a function of the caps
themselves, not of how selective you were about handing out passcodes.
Check actual usage against `GLOBAL_MONTHLY_CAP_CENTS` for the first
week or two after shipping this to make sure the cap is where you want
it.
