# U/I — design notes

This document is the distilled spec from a scoping conversation. It exists so the
shape of the tool doesn't have to be re-derived from memory later, and so future
changes can be checked against the reasoning that produced them, not just the
resulting feature list.

## What this is

A text-to-text tool that takes a message a neurodivergent (ND) person has
written and produces a version reworded to be more legible to a neurotypical
(NT) reader — aimed at **diffusing the tension that misunderstanding causes**,
not just at literal semantic fidelity. Those two goals usually agree; when they
don't, this tool optimizes for the first.

## Why the direction is ND → NT only, on purpose

The double empathy problem (Milton) holds that miscommunication between
neurotypes is mutual, not a one-sided ND deficit. This tool doesn't dispute
that. It's scoped narrower anyway: in practice, the burden of crossing the gap
already falls disproportionately on ND people (masking, code-switching,
constant self-translation). A tool that meets people where that labor already
sits isn't endorsing the imbalance — it's declining to pretend a translation
tool alone can rebalance something structural. This is a scope choice, not a
claim about fairness, and it doesn't rule out an NT → ND direction later.

## Personalization

**What gets personalized, and why it isn't generic.** A single canned
"neurodivergent communication style" template would just be a different
flattening projection, not an improvement on the NT world's flattening. The
tool needs an actual model of *this* person's voice, not a category.

**Where that signal comes from.** Not curated messages to coworkers — how
someone talks *to an LLM* itself: register shifts, syntax breaks, associative
leaps, self-interruption. There's less masking pressure writing to a model
than to a human who might judge you, so it's a more honest sample than
polished human-facing text. LLMs already have real capacity to parse messy,
non-linear, self-correcting input — the failure mode to guard against is
their opposite default of *smoothing that back out* on the way to an output.
This tool's job is to use the comprehension side without reintroducing the
tidying side.

**How the profile gets built — user-authored, not silently inferred.** The
system should never build an opaque behavioral profile behind someone's back;
that's uncomfortably close to the external diagnosing ND people already
contend with. Concretely:
- A **freeform, user-editable "how I naturally communicate" note** is the
  actual profile — the person's own words, always visible, always editable.
- An **optional chat-archive upload** (ChatGPT/Claude JSON exports) can draft
  a starting version of that note by having the model characterize patterns
  it observes only in the person's own messages — but the draft is shown for
  review and never saved without the person accepting or editing it first.
- Nothing about *listeners* (a specific manager, partner, friend) is modeled
  in v1 — talking to a model isn't the same act as talking to a specific
  person in your life (no turn-taking pressure, no visible impatience), so
  this corpus is honest signal about the sender, not about who receives the
  message. That's an acknowledged gap, not a solved problem.

**Storage footprint stays deliberately small.** Only the user's own extracted
messages (not full conversations, not the assistant's turns) are kept from an
uploaded archive, and only to let the profile draft be regenerated later — not
as a general searchable archive. Archive Mole's job (full retrieval) is not
this tool's job.

## Output honesty

Not every message translates completely — some lived experience genuinely
doesn't have a clean NT-legible equivalent. The tool says so rather than
faking completeness: a translation can come back with a short note on what
didn't fully carry over, instead of silently discarding it. A confidently
wrong translation is worse than an honestly incomplete one, because it lets
someone believe they understood when they didn't.

## Forwarding, and showing both

Output has a one-click copy so it can be dropped straight into a text/email/
Slack thread — that's the whole point of the tool. A **subtle, per-message,
opt-in toggle** lets the original be included alongside the translation when
copying. This matters structurally: a translator that only ever hands out the
smoothed version and hides the original is still asking the ND person to
erase their own voice, just doing the erasing on their behalf. Showing both
is closer to subtitling than dubbing — the original stays visible and
authentic, the translation is offered *alongside* it, not *instead of* it.
Over time, a specific recipient seeing both repeatedly may start parsing the
person's native phrasing on their own — a way the tool could reduce its own
necessity for that one relationship. (There's also a noted, accepted
possibility that people use the side-by-side view out of sheer novelty/
curiosity, independent of the accessibility purpose — that's fine, and a
reason to make that view good rather than a buried afterthought.)

## Engine: bring-your-own-key (BYOK)

No backend, no account with this tool, no subscription. The person supplies
their own Anthropic API key; the browser calls the Claude API directly. The
app itself costs nothing to run; the person bears their own (small) usage
cost directly, with no markup. This was chosen over a fully local/offline
on-device model for v1 because the hard part of this task is precisely the
subtle stuff (register, subtext, what a rewrite quietly loses), where small
on-device models are currently weaker. A fully local/offline model remains a
**separate, deferred prototyping effort** — explicitly out of scope for this
build, not abandoned.

## Storage & privacy model — same pattern as Archive Mole

Single HTML file, no server. Everything (API key, communication profile,
archive-derived message corpus) is written to this browser's local storage on
this device and never sent anywhere except the direct, user-initiated call to
Anthropic's API. An explicit **clear-all-local-data** action, with a
confirmation showing exactly what will be deleted, purges it for real — not a
soft UI reset. There's no export/backup built in: the person's own archive
export files remain their durable copy.

Translated messages themselves are **not persisted** by default — only the
communication profile and the archive-derived corpus survive a reload. This
keeps the tool from becoming an incidental log of someone's private outgoing
messages just by using it.

## Delivery format

A single portable `.html` file, openable directly from disk (desktop) — same
as Archive Mole. It can also be hosted for free on GitHub Pages (or similar
static hosting) purely so it becomes installable on a phone: phones require a
page be served over `https://` (even from free static hosting) before a
service worker can register and the page can be added to a home screen —
`file://` can't do that. Both access paths serve the same file; neither
compromises the other.

## Explicit non-goals for this version

- Real-time / live conversational mode (mic input, streaming) — text-to-text
  only, deliberately, to "give it space to actually work" rather than adding
  latency and ASR-accuracy problems on top of an already hard translation
  problem.
- NT → ND direction — not ruled out, just not built yet.
- A model of specific listeners/recipients — not attempted in v1.
- A fully local/offline on-device model — separate future prototype.
- Persisted translation history — only the profile persists, not the
  messages themselves, by default.
