// Archive Mole — hosted assistant proxy
//
// Sits between the hosted/index.html clone and api.anthropic.com. It holds
// the real Anthropic API key (as a Worker secret, never in this source),
// gates access behind a passcode, and enforces a hard spending cap before
// ever placing the upstream call — not just after, which would let a burst
// of concurrent requests all slip through before any of them get counted.
//
// Streams the response straight through rather than buffering it: the
// client reads it as an ordinary SSE stream, and this Worker's own cost
// accounting is reconciled from a second, independent copy of the same
// stream (via ReadableStream.tee()) read in the background after the
// response has already gone out (ctx.waitUntil), so streaming adds no
// extra latency for the client. See the tee() call below for why.
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
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const ALLOWED_MODELS = Object.keys(PRICING);

// Ephemeral (5-minute) prompt-cache pricing, as a multiplier of the base
// input price. Also verify these.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Archive Mole's own callClaude() doesn't send max_tokens today, so 4096
// also serves as the default when the client omits it — the value this app
// has always used. Honors whatever a client does ask for, but never above
// the ceiling for that model, since a tampered request could otherwise ask
// for far more than any real feature needs.
//
// One ceiling per model rather than a single flat value: this Worker fronts
// your own paid key for guests, so the ceiling is sized to bound worst-case
// cost per request, not to maximize output room. Opus 5 is the priciest
// model per output token ($25/M vs Sonnet's $10 and Haiku's $5), so it gets
// the tightest ceiling — a buggy loop or a much heavier session than
// expected costs the least there per response, not the most. Now that
// responses are streamed through rather than buffered, these are no
// longer bounded by the client-timeout risk a large non-streaming
// max_tokens used to carry — raise a value if guests are hitting the
// ceiling on legitimate answers and the per-user/global $ caps below are
// the protection you'd rather rely on instead.
const MAX_OUTPUT_TOKENS_CEILING = {
  'claude-haiku-4-5': 8192,
  'claude-sonnet-5': 8192,
  'claude-opus-5': 4096,
};

// Coarse anti-hammering limit, independent of the cost cap below — caps
// how many requests per passcode can even be attempted per minute.
const RATE_LIMIT_PER_MINUTE = 10;

// Pre-auth throttle, checked before the passcode is even looked up. Without
// this, a request with no passcode or a wrong one skips RATE_LIMIT_PER_MINUTE
// entirely — that one only ever runs after a passcode has already been
// validated — so junk/missing passcodes previously faced no rate limiting at
// all. CF-Connecting-IP is set by Cloudflare at the edge, so a client can't
// spoof it to dodge this.
const IP_RATE_LIMIT_PER_MINUTE = 20;

const TTL_DAY = 60 * 60 * 24 * 2; // usage keys outlive a day so late writes still land
const TTL_MONTH = 60 * 60 * 24 * 40;
const TTL_MINUTE = 120;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    // Pre-auth throttle, checked before anything else — including OPTIONS,
    // which otherwise costs a Worker invocation with no rate limit at all.
    // CF-Connecting-IP is set by Cloudflare at the edge, so a client can't
    // spoof it to dodge this.
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
    // client's body verbatim — max_tokens in particular is clamped here,
    // not trusted from the client as-is, since it's the single biggest
    // lever on cost per call.
    const maxTokens = clamp(parseInt(body.max_tokens, 10) || 4096, 1, MAX_OUTPUT_TOKENS_CEILING[model]);
    const outgoing = {
      model,
      max_tokens: maxTokens,
      stream: true,
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

    const estimateCents = estimateCostCents(model, outgoing, maxTokens);

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

    if (!upstream.ok) {
      // A rejected request (bad auth, bad params, a cap Anthropic itself
      // enforces) never starts streaming — it comes back as an ordinary
      // buffered JSON error body, same as the old non-streaming path, so
      // handle it exactly the same way: nothing was billed, release the
      // hold and relay the error as-is.
      const text = await upstream.text();
      await releaseReservation(env, userDayKey, globalMonthKey, estimateCents);
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, 'content-type': 'application/json' },
      });
    }

    // Split the stream in two: one copy goes straight to the browser as it
    // arrives (so a large max_tokens no longer risks the client's own
    // read timeout — see index.html/hosted's streamClaude()), the other is
    // read here to recover the final `usage` object once the stream ends,
    // for the same cost reconciliation the old buffered path did from the
    // parsed JSON body. ctx.waitUntil keeps that second read running after
    // the response has already been returned, so it adds no latency for
    // the client either way.
    const [clientStream, accountingStream] = upstream.body.tee();
    ctx.waitUntil(
      reconcileFromStream(accountingStream, env, model, userDayKey, globalMonthKey, estimateCents)
    );

    return new Response(clientStream, {
      status: upstream.status,
      headers: { ...cors, 'content-type': 'text/event-stream' },
    });
  },
};

function corsHeaders(env, origin) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-passcode',
    // Lets the browser cache a preflight for a day instead of re-sending an
    // OPTIONS request before every single POST — halves real request volume
    // against the Workers free-tier quota, on top of the throttle above.
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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

// Reads one branch of the tee'd upstream SSE stream purely to recover the
// final `usage` object — it only appears in the message_start and
// message_delta events, not as a separate field anywhere else — then
// reconciles the spend reservation to the real cost, same accounting the
// old buffered path did from the parsed JSON body. Runs via ctx.waitUntil
// after the response has already gone out; never touches the copy of the
// stream the client is reading.
async function reconcileFromStream(stream, env, model, userDayKey, globalMonthKey, estimateCents) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = {};
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const raw of events) {
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let evt;
        try {
          evt = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        if (evt.type === 'message_start' && evt.message && evt.message.usage) {
          usage = { ...usage, ...evt.message.usage };
        }
        if (evt.type === 'message_delta' && evt.usage) {
          usage = { ...usage, ...evt.usage };
        }
      }
    }
  } catch {
    // The client disconnecting early (or any other read failure on this
    // branch) means the real cost can never be known here — release the
    // worst-case hold rather than leave it stuck at the estimate forever.
    await releaseReservation(env, userDayKey, globalMonthKey, estimateCents);
    return;
  }
  if (usage.input_tokens || usage.output_tokens) {
    const actualCents = actualCostCents(model, usage);
    await reconcileReservation(env, userDayKey, globalMonthKey, estimateCents, actualCents);
  } else {
    // Stream ended without ever producing a usage object — treat it the
    // same as an outright failure rather than silently keeping the
    // worst-case estimate charged against the cap.
    await releaseReservation(env, userDayKey, globalMonthKey, estimateCents);
  }
}

// Rough, deliberately conservative token estimate (chars/3, i.e. fewer
// chars per token than English text really averages) so the pre-call
// reservation errs toward over-counting rather than under-counting.
function estimateInputTokens(outgoing) {
  return Math.ceil(JSON.stringify(outgoing).length / 3);
}

function estimateCostCents(model, outgoing, maxTokens) {
  const price = PRICING[model];
  const inputTokens = estimateInputTokens(outgoing);
  const inCost = (inputTokens * price.in) / 1e6;
  const outCost = (maxTokens * price.out) / 1e6;
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
