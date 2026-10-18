import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const who = ["ana", "bo", "cy", "dee"];
const ids = Object.fromEntries(who.map(w => [w, C.newIdentity()]));
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const DEPS = {
  ana: ["langgraph", "pgvector", "playwright", "@modelcontextprotocol/sdk", "react", "typescript", "eslint"],
  bo: ["langgraph", "pgvector", "playwright", "@modelcontextprotocol/sdk", "react", "typescript"],
  cy: ["react", "typescript", "eslint", "lodash"],
  dee: ["langgraph", "react"],
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-stack-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const w of who) {
    const m = C.sign(ids[w], "profile.manifest", { name: w.toUpperCase(), handle: w, boxKey: ids[w].boxPublic, headline: "builder", links: [["GitHub", `https://github.com/${w}-gh`]] });
    await post(`/v1/profiles/${ids[w].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${w}</h1><p class="lede">builder</p></body></html>`).toString("base64") } });
    hub.db.prepare("INSERT OR REPLACE INTO tag_repo_cache VALUES (?,?,?,?)").run(`${w}-gh/app`, "2026-10-01", JSON.stringify({ repo: "app", desc: "", topics: [], lang: "TypeScript", readme: "", deps: DEPS[w] }), "2026-10-01");
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("builds with a similar stack: shared public dependencies, minus tooling, shown on the profile", async () => {
  const r = await (await fetch(base + "/v1/people/ana/similar-stack")).json();
  assert.deepEqual(r.similar.map(x => x.handle), ["bo"], "only bo shares 3+ telling packages");
  const deps = r.similar[0].shared.map(s => s.dep);
  assert.ok(deps.includes("langgraph") && deps.includes("pgvector") && deps.includes("playwright"));
  assert.ok(!deps.includes("typescript") && !deps.includes("eslint"), "tooling never counts");
  assert.deepEqual(r.similar[0].shared.find(s => s.dep === "pgvector").theirs, ["app"], "with the repo it came from");
  assert.equal((await (await fetch(base + "/v1/people/cy/similar-stack")).json()).similar.length, 0);
  const page = await (await fetch(base + "/@ana/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.match(page, /Builds with a similar stack/); assert.match(page, /<code[^>]*>pgvector<\/code>/);
  assert.doesNotMatch(await (await fetch(base + "/@cy/", { headers: { "user-agent": "Mozilla/5.0" } })).text(), /Builds with a similar stack/, "nothing when no one matches");
  assert.equal((await fetch(base + "/v1/people/nobody/similar-stack")).status, 404);
  // the world map draws it as a "same stack" line (kind 4), naming the packages
  const w = await (await fetch(base + "/v1/world")).json(), l = (w.links || []).filter(x => x[2] === 4);
  assert.equal(l.length, 1); assert.deepEqual([l[0][0], l[0][1]].sort(), ["@ana", "@bo"]); assert.match(l[0][3], /langgraph|pgvector|playwright/);
});
