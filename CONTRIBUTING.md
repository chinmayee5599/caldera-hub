# Contributing to Caldera Hub

Thanks for helping. Small, focused pull requests are the easiest to review and merge.

## Set up

This repo builds against the plugin, so check out both repos side by side:

```
git clone https://github.com/schoettle-cmd/caldera
git clone https://github.com/schoettle-cmd/caldera-hub
cd caldera && npm install && npm run build && cd ../caldera-hub
npm install && npm run build && npm test
```

Useful places:

- `packages/hub/src/ghpreview.ts`: `caldera.social/gh/<user>` (anyone's public GitHub as a city) and the README badges (`badgeSvg`).
- `packages/hub/src/server.ts`: routes and the rest of the hub.
- `packages/hub/test/`: tests (`node --test`). GitHub calls are faked, so tests run offline.

## Good first issues

Look for the [`good first issue`](https://github.com/schoettle-cmd/caldera-hub/labels/good%20first%20issue) label here and in [schoettle-cmd/caldera](https://github.com/schoettle-cmd/caldera). Comment on an issue before you start so two people don't build the same thing.

**Hacktoberfest:** both repos take part. Merged pull requests get the `hacktoberfest-accepted` label.

## Pull requests

- Run `npm test` before you push, and add a test when you change behavior.
- Never include anyone's private data in tests or screenshots.
- `packages/hub` is AGPL-3.0 and `packages/cli` is MIT. By opening a pull request you agree your change is shared under the same license.
