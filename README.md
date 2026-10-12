# Caldera Hub

The reference hub for the [Caldera protocol](https://github.com/schoettle-cmd/caldera/blob/main/spec/PROTOCOL.md) and the website at [caldera.social](https://caldera.social).

The **Obsidian plugin**, `@caldera/core` and the protocol spec live in **[schoettle-cmd/caldera](https://github.com/schoettle-cmd/caldera)**. This repo expects that repo checked out next to it:

```
git clone https://github.com/schoettle-cmd/caldera
git clone https://github.com/schoettle-cmd/caldera-hub
cd caldera && npm install && npm run build && cd ../caldera-hub
npm install && npm run build && npm test
```

| Package | What it is | License |
|---|---|---|
| `packages/hub` | Stores and verifies signed envelopes, hosts profile and garden pages, delivers encrypted cards, enforces gravity/credit rules, leaderboards, discovery, the garden index and `/gardens` feed. Node 22, zero frameworks, SQLite | AGPL-3.0 |
| `packages/cli` | `caldera publish --vault <path>`: publish a profile without opening Obsidian, using the plugin's own code | MIT |
| `packages/site` | caldera.social: landing page, guide, changelog (`releases.json` is the source of truth), SEO pages, privacy and terms | All rights reserved, mjonesone, LLC |

Run a hub:

```
CALDERA_DATA=./data PORT=8787 CALDERA_PUBLIC_URL=http://localhost:8787 CALDERA_SITE=packages/site node --no-warnings packages/hub/dist/server.js
```

Rebuild the site after changing prompts or release notes: `npm run site`.

Caldera is developed by **mjonesone, LLC**. Copyright (c) 2026 mjonesone, LLC.
