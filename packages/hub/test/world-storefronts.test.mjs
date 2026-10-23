import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// buildWorld isn't exported from the server bundle: bundle the module itself for this test
const out = await build({ entryPoints: [new URL("../src/world.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "text" }, write: false });
const { buildWorld } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

test("world: a member's storefronts always make the per-member building cap, even beside many busy repos", () => {
  const repos = Array.from({ length: 45 }, (_, i) => ({ name: "repo" + i, project: "Work", public: true, language: "TypeScript", commits: 500 - i, weeks: [1], week: 1, today: 0, url: "https://github.com/a/repo" + i }));
  const fronts = [{ name: "Shop", project: "Work", public: true, language: "Web", commits: 0, weeks: [], week: 0, today: 0, url: "https://shop.example.org/", kind: "site", sites: ["shop.example.org"], meta: { host: "shop.example.org" } },
    { name: "App", project: "Work", public: true, language: "App", commits: 0, weeks: [], week: 0, today: 0, url: "https://apps.apple.com/app/id1234567", kind: "app", meta: { store: "apple" } }];
  const w = buildWorld([{ handle: "ana", name: "Ana", headline: "", created: "2026-01-01T00:00:00Z", groups: [], friends: 0, city: { districts: [{ name: "Work", notes: 0, repos: [...repos, ...fronts] }], private: false }, notes: 0, busy: 1 }], [], null, "https://caldera.social");
  const all = w.city.districts.flatMap(d => d.repos);
  assert.ok(all.length <= 30, "the cap still holds");
  assert.deepEqual(all.filter(r => r.kind).map(r => r.name).sort(), ["App", "Shop"]);
});
