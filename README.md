# Archive Mole

A personal, local-only browser for your ChatGPT and Claude conversation exports. Import the `.json` files either platform gives you, then search, filter, tag, and read back through your own archive — entirely on your own device.

## What it does

- **Imports** ChatGPT and Claude.ai conversation export files, parsing both formats into one common view.
- **Searches and filters** by keyword, platform, date range, and your own tags.
- **Timeline** view of your archive's activity by month.
- **A search brief** — a written procedure meant to be handed to an AI assistant, describing how to work through a large personal archive deliberately (scope, catalog, flag, read) rather than skimming it.
- **An optional AI assistant** that runs that brief live, using an Anthropic API key you supply. Off by default; nothing is sent anywhere unless you turn it on.

## Privacy

Archive Mole is a single self-contained HTML file with no server behind it. Everything it parses — conversations, tags, your saved brief — is written to your browser's local storage on your device, and nothing is sent out over the network, with one exception: if you set up the AI assistant, your messages and API key go directly from your browser to `api.anthropic.com`. No part of this app has a backend of its own, and nothing routes through any server of ours.

Your archive is tied to one browser, on one device — it doesn't sync. There's no built-in export, so keep your original `.json` export files; re-importing them is how you'd rebuild the archive elsewhere.

## Usage

Download `Archive_Mole.html` and open it in a browser — double-click works, no install or build step needed. The in-app **manual** button covers every feature in detail once it's open.

## License

All rights reserved. This repository is shared for personal reference; reuse requires asking first.
