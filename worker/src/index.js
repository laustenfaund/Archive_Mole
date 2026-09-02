// Archive Mole — hosted assistant proxy
//
// Sits between the hosted/index.html clone and api.anthropic.com. It holds
// the real Anthropic API key (as a Worker secret, never in this source),
// gates access behind a passcode, and enforces a hard spending cap before
// ever placing the upstream call — not just after, which would let a burst
// of concurrent requests all slip through before any of them get counted.
//
// Threat model this defends against: a small invited group, one of whom
// runs a buggy loop or a much heavier session than expected. It is NOT
// hardened against a sophisticated attacker deliberately racing this
// Worker's KV reads/writes — Workers KV is only eventually consistent, so
// under real concurrency two requests can still both read the same "spent
// so far" value before either write lands. For an invite-only personal
// tool this is an acceptable, well-understood gap; if that ever matters,
// swap the USAGE KV reads/writes below for a Durable Object, which can
// serialize them properly.
//
// ── REQUIRED SETUP — do this before deploying ──────────────────────────
// 1. wrangler kv namespace create USAGE
//    wrangler kv namespace create PASSCODES
//    → paste the two printed ids into wrangler.toml
// 2. wrangler secret put ANTHROPIC_API_KEY
//    → paste your real key when prompted; it is never written to disk here
// 3. Edit ALLOWED_ORIGIN in wrangler.toml to the exact origin hosted/ is
//    served from (e.g. https://yourname.github.io — no trailing slash).
// 4. Add at least one passcode with worker/scripts/add-passcode.mjs
//    (see worker/README.md).
// 5. VERIFY the PRICING table below against your current Anthropic console
//    pricing (console.anthropic.com → Settings → Billing, or
//    docs.anthropic.com pricing page) before trusting the caps. Getting
//    this wrong in the "too cheap" direction means the cap enforces less
//    protection than you think.

// Dollars per million tokens. Verified against Anthropic's published
// pricing (docs.claude.com/en/docs/about-claude/pricing) as of this
// writing — rates can change, so recheck there if the caps below ever
// seem to be tripping at the wrong point.
const PRICING = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
const ALLOWED_MODELS = Object.keys(PRICING);

// Ephemeral (5-minute) prompt-cache pricing, as a multiplier of the base
// input price. Also verify these.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// The app's own callClaude() always asked for this; enforced here too so a
// tampered client request can't raise it.
const MAX_OUTPUT_TOKENS = 4096;

// Coarse anti-hammering limit, independent of the cost cap below — caps
// how many requests per passcode can even be attempted per minute.
const RATE_LIMIT_PER_MINUTE = 10;

const TTL_DAY = 60 * 60 * 24 * 2; // usage keys outlive a day so late writes still land
const TTL_MONTH = 60 * 60 * 24 * 40;
const TTL_MINUTE = 120;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

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
    // just stops other websites from using a visitor's browser to spend
    // your budget without them noticing.
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
        `Too many requests — limit is ${RATE_LIMIT_PER_MINUTE}/minute per passcode. Try again shortly.`,
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
    const model = body.model;

    // Rebuild the outgoing request from scratch rather than forwarding the
    // client's body verbatim — max_tokens in particular is fixed here, not
    // trusted from the client, since it's the single biggest lever on cost
    // per call.
    const outgoing = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: body.system,
      tools: body.tools,
      output_config: body.output_config,
      messages: body.messages,
    };

    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const month = day.slice(0, 7); // YYYY-MM
    const userDayKey = `user:${userId}:${day}`;
    const globalMonthKey = `global:${month}`;
    const perUserCapCents = parseInt(env.PER_USER_DAILY_CAP_CENTS, 10);
    const globalCapCents = parseInt(env.GLOBAL_MONTHLY_CAP_CENTS, 10);

    const [userSpent, globalSpent] = await Promise.all([
      readInt(env.USAGE, userDayKey),
      readInt(env.USAGE, globalMonthKey),
    ]);

    const estimateCents = estimateCostCents(model, outgoing);

    if (userSpent + estimateCents > perUserCapCents) {
      return jsonError(
        429,
        `Daily cap reached for this passcode ($${(perUserCapCents / 100).toFixed(
          2
        )}/day). Resets at midnight UTC.`,
        cors
      );
    }
    if (globalSpent + estimateCents > globalCapCents) {
      return jsonError(
        429,
        `This instance's monthly budget cap has been reached. Resets next month.`,
        cors
      );
    }

    // Reserve the worst-case cost BEFORE the slow upstream call. This is
    // what closes the race where several requests could otherwise all pass
    // the checks above while none of them has been recorded yet.
    await Promise.all([
      env.USAGE.put(userDayKey, String(userSpent + estimateCents), {
        expirationTtl: TTL_DAY,
      }),
      env.USAGE.put(globalMonthKey, String(globalSpent + estimateCents), {
        expirationTtl: TTL_MONTH,
      }),
    ]);

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
      await releaseReservation(env, userDayKey, globalMonthKey, estimateCents);
      return jsonError(502, 'Could not reach Anthropic: ' + e.message, cors);
    }

    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave parsed null
    }

    if (upstream.ok && parsed && parsed.usage) {
      const actualCents = actualCostCents(model, parsed.usage);
      await reconcileReservation(env, userDayKey, globalMonthKey, estimateCents, actualCents);
    } else {
      // Upstream call failed outright — nothing was billed, release the hold.
      await releaseReservation(env, userDayKey, globalMonthKey, estimateCents);
    }

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

async function releaseReservation(env, userDayKey, globalMonthKey, estimateCents) {
  await reconcileReservation(env, userDayKey, globalMonthKey, estimateCents, 0);
}

// Replaces a held reservation with the real cost. Not perfectly atomic
// under concurrent requests (see the top-of-file note on KV consistency),
// but re-reads immediately before writing to keep the window small.
async function reconcileReservation(env, userDayKey, globalMonthKey, estimateCents, actualCents) {
  const delta = actualCents - estimateCents;
  if (delta === 0) return;
  const [userSpent, globalSpent] = await Promise.all([
    readInt(env.USAGE, userDayKey),
    readInt(env.USAGE, globalMonthKey),
  ]);
  await Promise.all([
    env.USAGE.put(userDayKey, String(Math.max(0, userSpent + delta)), {
      expirationTtl: TTL_DAY,
    }),
    env.USAGE.put(globalMonthKey, String(Math.max(0, globalSpent + delta)), {
      expirationTtl: TTL_MONTH,
    }),
  ]);
}

// Rough, deliberately conservative token estimate (chars/3, i.e. fewer
// chars per token than English text really averages) so the pre-call
// reservation errs toward over-counting rather than under-counting.
function estimateInputTokens(outgoing) {
  return Math.ceil(JSON.stringify(outgoing).length / 3);
}

function estimateCostCents(model, outgoing) {
  const price = PRICING[model];
  const inputTokens = estimateInputTokens(outgoing);
  const inCost = (inputTokens * price.in) / 1e6;
  const outCost = (MAX_OUTPUT_TOKENS * price.out) / 1e6;
  return Math.ceil((inCost + outCost) * 100);
}

function actualCostCents(model, usage) {
  const price = PRICING[model];
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const dollars =
    (input * price.in +
      cacheWrite * price.in * CACHE_WRITE_MULTIPLIER +
      cacheRead * price.in * CACHE_READ_MULTIPLIER) /
      1e6 +
    (output * price.out) / 1e6;
  return Math.ceil(dollars * 100);
}
