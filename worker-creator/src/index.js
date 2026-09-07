// Archive Mole — creator (uncapped) assistant proxy
//
// Same shape as worker/src/index.js (the guest-facing hosted/ proxy) — sits
// between the creator/index.html clone and api.anthropic.com, holds the
// real Anthropic API key as a Worker secret, gates access behind a
// passcode. The difference: this one is for the app owner's own use, so it
// does NOT enforce a spend cap or clamp max_tokens. Nothing here checks
// what anything costs before or after the call.
//
// This is a deliberately separate deployment from worker/, not a flag on
// it — a guest passcode from the capped Worker will not work here, and an
// owner passcode from here should never be handed to a guest. Point
// creator/index.html's ASSISTANT_PROXY_URL at THIS Worker's URL, not the
// hosted/ one.
//
// Threat model this defends against: basically none, on purpose — it's
// your own key, your own passcode, your own usage. What it still does:
// keeps the real key out of client-side code (so it's not sitting in a
// GitHub Pages-served HTML file for anyone who opens dev tools), requires
// a passcode so a stranger who finds the Worker's URL can't use it, and
// keeps a coarse per-minute rate limit purely as a bug-loop guard — not a
// budget control. If you don't want even that, see the note above
// RATE_LIMIT_PER_MINUTE below.
//
// ── REQUIRED SETUP — do this before deploying ──────────────────────────
// 1. wrangler kv namespace create USAGE
//    wrangler kv namespace create PASSCODES
//    → paste the two printed ids into wrangler.toml (USE DIFFERENT
//      namespaces than worker/'s — sharing them would mix your own rate-
//      limit counters with guests' spend counters under similarly-shaped
//      keys, which is confusing even though the key prefixes wouldn't
//      literally collide)
// 2. wrangler secret put ANTHROPIC_API_KEY
//    → can be the same key as worker/'s, or a separate one if you want
//      your own usage billed/visible separately in the Anthropic console
// 3. Edit ALLOWED_ORIGIN in wrangler.toml to the exact origin creator/ is
//    served from (e.g. https://yourname.github.io — no trailing slash).
// 4. Add exactly one passcode (yourself) with
//    worker-creator/scripts/add-passcode.mjs (see worker-creator/README.md).

const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];

// Coarse anti-hammering limit — not a budget control, just a guard against
// a genuine bug (an infinite retry loop, a runaway tool-use round-trip)
// silently hammering your own Anthropic account while you're not looking.
// Raised well above what any real interactive session needs. Set both of
// these to something absurdly high (or remove the checks below entirely)
// if you'd rather have zero limits of any kind.
const RATE_LIMIT_PER_MINUTE = 60;
const IP_RATE_LIMIT_PER_MINUTE = 90;
const TTL_MINUTE = 120;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipRateKey = `iprate:${clientIp}:${Math.floor(Date.now() / 60000)}`;
    const ipRateCount = (await readInt(env.USAGE, ipRateKey)) + 1;
    if (ipRateCount > IP_RATE_LIMIT_PER_MINUTE) {
      return jsonError(429, 'Too many requests from this address. Try again shortly.', cors);
    }
    await env.USAGE.put(ipRateKey, String(ipRateCount), { expirationTtl: TTL_MINUTE });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/v1/messages') {
      return jsonError(404, 'Not found', cors);
    }
    if (request.method !== 'POST') {
      return jsonError(405, 'Method not allowed', cors);
    }

    // Origin header can be forged by a non-browser client (curl, etc.), so
    // this is not the real access control — the passcode below is. This
    // just stops other websites from using your own browser session to
    // fire requests through this proxy without you noticing.
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) {
      return jsonError(403, 'Origin not allowed', cors);
    }

    const passcode = request.headers.get('x-passcode') || '';
    if (!passcode) return jsonError(401, 'Missing passcode', cors);

    const passHash = await sha256Hex(passcode);
    const record = await env.PASSCODES.get(`passcode:${passHash}`, 'json');
    if (!record || record.active === false) {
      return jsonError(401, 'Invalid or revoked passcode', cors);
    }
    const userId = record.name || passHash;

    const rateKey = `rate:${userId}:${Math.floor(Date.now() / 60000)}`;
    const rateCount = (await readInt(env.USAGE, rateKey)) + 1;
    if (rateCount > RATE_LIMIT_PER_MINUTE) {
      return jsonError(
        429,
        `Too many requests — limit is ${RATE_LIMIT_PER_MINUTE}/minute. If this is expected, raise RATE_LIMIT_PER_MINUTE in src/index.js.`,
        cors
      );
    }
    await env.USAGE.put(rateKey, String(rateCount), { expirationTtl: TTL_MINUTE });

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, 'Invalid JSON body', cors);
    }

    if (!ALLOWED_MODELS.includes(body.model)) {
      return jsonError(400, `Model not allowed: ${body.model}`, cors);
    }

    // Forwarded as the client sent it — no ceiling, no cost estimate, no
    // spend reservation. Anthropic's own API is the only limiter on
    // request size here. The 8192 fallback only fires if the client omits
    // max_tokens entirely (Archive Mole's client usually does) — it's
    // there because Anthropic's API requires the field, not as a cap; a
    // client that does send its own value always wins.
    const outgoing = {
      model: body.model,
      max_tokens: body.max_tokens || 8192,
      system: body.system,
      tools: body.tools,
      output_config: body.output_config,
      messages: body.messages,
    };

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(outgoing),
      });
    } catch (e) {
      return jsonError(502, 'Could not reach Anthropic: ' + e.message, cors);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  },
};

function corsHeaders(env, origin) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-passcode',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonError(status, message, cors) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readInt(kv, key) {
  const v = await kv.get(key);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
