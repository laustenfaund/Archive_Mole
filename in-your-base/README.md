# In Your Base

A personal, local-only browser for your own exported chat data. Import the
`.json` files ChatGPT and Claude give you — or, through a generic best-effort
reader, JSON exports from other sources — then search, filter, tag, and read
back through your own archive, entirely on your own device.

A fork of [Archive Mole](https://github.com/laustenfaund/Archive_Mole), kept
as its own separate app and repo rather than a mode of that one: same build
philosophy, same single-file design, own storage, so the two never collide
even installed side by side.

## What it does

- **Imports** ChatGPT and Claude.ai conversation export files precisely, and
  falls back to a generic reader for other JSON chat exports — an array of
  turns with a role-like field and a text-like field, under whatever names
  that export happens to use. What it can't confidently read, it skips
  rather than guesses at.
- **Searches and filters** by keyword, platform, date range, and your own
  tags. The platform filter isn't fixed to two values — it's built from
  whatever's actually in your loaded archive.
- **Timeline** view of your archive's activity by month.
- **A search brief** — a written procedure meant to be handed to an AI
  assistant, describing how to work through a large personal archive
  deliberately (scope, catalog, flag, read, record) rather than skimming it.
- **An optional AI assistant** that runs that brief live, using an Anthropic
  API key you supply. Off by default; nothing is sent anywhere unless you
  turn it on. As it reads, it logs short quote-plus-note findings instead of
  holding full conversation text in context — keeps token spend from
  climbing every round of a long search.

## Privacy

In Your Base is a single self-contained HTML file with no server behind it.
Everything it parses — conversations, tags, your saved brief — is written
to your browser's local storage on your device, and nothing is sent out
over the network, with one exception: if you set up the AI assistant, your
messages and API key go directly from your browser to `api.anthropic.com`.
No part of this app has a backend of its own, and nothing routes through
any server of ours.

Your archive is tied to one browser, on one device — it doesn't sync.
There's no built-in export, so keep your original `.json` export files;
re-importing them is how you'd rebuild the archive elsewhere.

## Usage

Download `index.html` and open it in a browser — double-click works, no
install or build step needed. The in-app **manual** button covers every
feature in detail once it's open.

## The hosted variant

[`hosted/`](hosted) is a clone of this same app with one change: instead of
each person pasting in their own Anthropic API key, the AI assistant is
gated by a passcode and routed through a small proxy (in [`worker/`](worker))
that holds a single shared key server-side, with hard per-person and
total spending caps enforced before any request goes out. Use this if you
want to give a few people access to the assistant without also giving them
your API key. See [`worker/README.md`](worker/README.md) to deploy the
proxy; the UI is otherwise identical to the plain version above.

## Installing on your phone

This app is installable as a PWA (Progressive Web App) once hosted somewhere
over `https://` — e.g. GitHub Pages. `manifest.json`, `sw.js`, and `icons/`
give it a name, an app icon, and a minimal offline shell cache so it behaves
like a real app on your home screen instead of just a bookmark.

1. Make sure this repo is public (Settings → Danger Zone → Change
   visibility), then enable GitHub Pages (Settings → Pages → Deploy from
   branch → `main` → `/` root).
2. Once it's live, open `https://<your-username>.github.io/<repo-name>/`
   on your phone — not the repo's `github.com` page.
3. Use your browser's "Add to Home Screen" / "Install app" option.

## Differences from Archive Mole

- A third, generic import path alongside the precise ChatGPT/Claude
  parsers (see `extractGenericMessages` in `index.html`), for JSON exports
  from anything else.
- The platform filter chips and the assistant's `filter_conversations` tool
  are built dynamically from whatever platform labels are actually present,
  instead of a hardcoded chatgpt/claude pair.
- Its own IndexedDB database and storage-key names, so it can be installed
  and used in the same browser as Archive Mole without either touching the
  other's data.
- Everything else — search, tags, timeline, the brief, the assistant and
  its findings compiler — is unchanged.

## License

All rights reserved — see [`LICENSE`](LICENSE). This repository is shared
for personal reference; reuse requires asking first.
