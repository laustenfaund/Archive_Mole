# In Your Base

A fork of [Archive Mole](../README.md), generalized to read more than just
ChatGPT and Claude exports. Same build philosophy, same single-file app, same
local-only privacy model — nothing here talks to a server except the
optional AI assistant, which talks directly to `api.anthropic.com` the same
way Archive Mole's does. This is its own app: separate `index.html`, separate
browser storage (a different IndexedDB database and key names), so it can sit
in the same repo and even the same browser as Archive Mole without either
touching the other's data.

## What's different from Archive Mole

- **A third import path.** ChatGPT and Claude exports are still parsed
  precisely, exactly as before. Anything else lands in a generic reader that
  looks for an array of turns with something role-like (`role`/`author`/
  `sender`/`from`) and something text-like (`text`/`content`/`message`/
  `body`) on each one, and skips whatever it can't confidently read rather
  than guessing. It hasn't been tested against any specific third export
  format's real output — it's a best-effort shape-matcher, not a verified
  parser for e.g. Gemini or Slack specifically. If it misreads a real export,
  that's a parser bug to fix, not a sign the whole approach is wrong.
- **Platform is open-ended.** The old two-chip filter (chatgpt / claude) is
  now built from whatever platform labels are actually present in your
  loaded archive. A generically-imported file is labeled from its own
  `platform`/`source`/`provider`/`model` field, or `other` if it doesn't say.
- Everything else — search, tags, timeline, the search brief, the AI
  assistant and its findings compiler — is unchanged from Archive Mole.

## Not carried over (yet)

This fork is the core app only. It doesn't (yet) have Archive Mole's
`manifest.json`/`sw.js`/`icons/` (PWA install), or the `hosted/` + `worker/`
shared-key variant. Ask if you want those added — they'd follow the same
pattern, just pointed at this app's own files and storage keys.
