# Archive Mole invite-build proxy

A Cloudflare Worker that stands between the [`invite/`](../invite) build of
Archive Mole and Anthropic's API. It holds your real Anthropic API key as a
server-side secret — the browser never sees it — and enforces a spending
cap before forwarding any request, gated by a per-visitor credential that
this build mints for itself with no action from the visitor.

**This is a separate Worker from [`worker/`](../worker), on purpose — do
not deploy this code to the `archive-mole-assistant` Worker that backs
`hosted/index.html`.** `hosted/index.html` is the public, passcode-only
build: someone needs a passcode you handed them before it does anything.
This build (`invite/index.html`) is the opposite — the first time someone
opens its assistant panel, their browser silently calls `POST /v1/register`
against *this* Worker and gets back its own working token, no passcode, no
screen, nothing to ask you for. That's exactly why `invite/` is meant to sit
behind its own access gate (Cloudflare Access, see step 9) on its own
Cloudflare Pages deployment, entirely separate from the public GitHub Pages
site that serves `index.html` and `hosted/index.html` — if this Worker's
`/v1/register` were reachable from the same origin as the public passcode
build, or if `invite/` were published on the same public site, anyone could
mint themselves a token and the passcode gate on `hosted/` would mean
nothing.

Hand-issued passcodes (the same mechanism `worker/` uses, but in *this*
Worker's own `PASSCODES` namespace — the two Workers don't share KV) still
work here too if you ever want to invite someone directly instead of
relying on self-registration — see [Adding a credential](#adding-a-credential-optional)
below. Both kinds are just entries in this Worker's `PASSCODES` KV and
behave identically once issued.

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
     a name (e.g. `archive-mole-invite` — this becomes part of its
     URL) → deploy the placeholder it starts you with.
   - Open the new Worker → **Edit code**. Select all of the placeholder
     code and delete it, then paste in the entire contents of
     [`src/index.js`](src/index.js) from this folder. Click **Deploy**.
   - Whenever you update the code later, always replace the *whole* file
     this way (select all, delete, paste the new whole file) rather than
     editing just part of it in the dashboard editor — a partial edit in
     that editor is easy to get subtly wrong.

2. **Create two new KV namespaces — don't reuse `worker/`'s.**
   - Dashboard → **Storage & Databases** → **KV** → **Create a
     namespace**. Create one for usage tracking and one for passcodes —
     name them anything unique to your account, e.g.
     `archive-mole-invite-usage` and `archive-mole-invite-passcodes`, to
     keep them visually distinct from the `archive-mole-assistant` Worker's
     namespaces in the dashboard list. This namespace name is just a label
     in your account; it doesn't need to match anything in the code —
     what matters is that this Worker's KV bindings (next step) point at
     these new namespaces, not the other Worker's.

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
     - `ALLOWED_ORIGIN` — the exact origin the **Cloudflare Pages** site
       serving `invite/index.html` ends up at, no trailing slash — its
       `*.pages.dev` URL, or your custom domain if you add one (e.g.
       `https://archive-mole-invite.pages.dev`). This is deliberately NOT
       your GitHub Pages origin — `invite/` should never be served from
       the same public site as `hosted/index.html`. Requests from any
       other origin are rejected before a credential is even checked or
       minted.
     - `PER_USER_DAILY_CAP_CENTS` — cents per person per day. Start lower
       than `worker/`'s cap (e.g. `300` = $3.00) — see the note below.
     - `GLOBAL_MONTHLY_CAP_CENTS` — cents total per month (e.g. `1500` =
       $15.00).
     - Both caps used to bound a small, hand-invited group — here, anyone
       who reaches the page (i.e. anyone Cloudflare Access lets through)
       gets their own bucket via `/v1/register` with zero invite step, so
       worst-case monthly spend is a function of these two numbers alone.
       Pick real numbers before deploying, and watch actual usage closely
       for the first week or two.

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
   overview page: `https://archive-mole-invite.<your-subdomain>.workers.dev`.
   Paste that into `ASSISTANT_PROXY_URL` near the top of the `<script>`
   block in `invite/index.html`.

9. **Deploy `invite/` on its own Cloudflare Pages project, behind
   Cloudflare Access — this is what actually makes it "share with whoever
   I choose" rather than public.**
   - Dashboard → **Workers & Pages** → **Create** → **Pages** → connect
     this repo (or upload the `invite/` folder's files directly) → set
     the build output directory to `invite/` if connecting the repo, or
     just the folder contents if uploading manually. Deploy.
   - Note the `*.pages.dev` URL it gives you (or attach a custom domain)
     and go back and fill that into `ALLOWED_ORIGIN` in step 4, then
     redeploy this Worker (step 6) so the setting actually takes.
   - Dashboard → **Zero Trust** → **Access** → **Applications** → **Add
     an application** → **Self-hosted**. Point it at the Pages URL from
     above. Add a policy allowing only the specific people you want in —
     an email allowlist is simplest (Cloudflare emails them a one-time
     code on visit; free for up to 50 users).
   - This is the real gate: only people Access lets through ever load
     `invite/index.html` in the first place, so only they can trigger
     `/v1/register`. Without this step, `invite/` is exactly as public as
     `hosted/` — just without the passcode.

10. **That's it from there — visitors no longer need anything from you.**
   Once someone gets past Access, their browser calls `POST /v1/register`,
   gets back its own token, and stores it — no passcode to type, nothing
   to ask you for. Each auto-issued token
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
