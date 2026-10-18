import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const ids = { mike: C.newIdentity(), ana: C.newIdentity(), hid: C.newIdentity() };
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const b64 = s => Buffer.from(s).toString("base64");
// a public city as the plugin publishes it: one public repo, one locked one (which must never gain a name), plus a
// "locked" building that someone tampered with to carry a name - the world must strip it
const city = (pub, secret) => `<html><body><script type="application/json" id="city-data">${JSON.stringify({ private: false, districts: [
  { name: "Proj", notes: 3, repos: [
    { name: pub, project: "Proj", public: true, language: "TypeScript", commits: 40, weeks: [1, 2, 3], week: 2, today: 0, url: `https://github.com/x/${pub}`, description: "ok" },
    { name: "", project: "Proj", public: false, locked: true, language: "Private", commits: 25, weeks: [], week: 1, today: 0 },
    { name: secret, project: "Proj", public: false, locked: true, language: "Private", commits: 10, weeks: [9], week: 0, today: 0, url: `https://github.com/x/${secret}` },
  ] }] })}</script></body></html>`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-world-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", founder: "mike", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  const pages = { mike: city("open-thing", "secret-mike"), ana: city("ana-lib", "secret-ana"), hid: city("hid-lib", "secret-hid") };
  for (const who of ["mike", "ana", "hid"])
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: C.sign(ids[who], "profile.manifest", { name: who === "ana" ? "Ana <b>" : who, handle: who, boxKey: ids[who].boxPublic, listed: who !== "hid", groups: who === "ana" ? ["pkm"] : [] }),
      files: { "index.html": b64("<html><body>hi</body></html>"), "city.html": b64(pages[who]) } });
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("/v1/world: listed members only, public repos keep names, everything else is a nameless padlock", async () => {
  const w = await (await fetch(`${base}/v1/world`)).json();
  const handles = w.members.map(m => m.handle).sort();
  assert.deepEqual(handles, ["ana", "mike"], "unlisted profiles never appear");
  const raw = JSON.stringify(w);
  for (const s of ["secret-mike", "secret-ana", "hid-lib", "secret-hid", "@hid"]) assert.ok(!raw.includes(s), `${s} must not leak`);
  const repos = w.city.districts.flatMap(d => d.repos);
  assert.ok(repos.some(r => r.name === "open-thing" && r.url === "https://github.com/x/open-thing"));
  for (const r of repos.filter(r => r.locked)) { assert.equal(r.name, ""); assert.equal(r.url, undefined); assert.deepEqual(r.weeks, []); }
  assert.deepEqual([...new Set(w.city.districts.map(d => d.nb))].sort(), ["@ana", "@mike"], "one neighborhood per listed member");
  assert.deepEqual(w.city.districts.map(d => d.name).sort(), ["@ana/Proj", "@mike/Proj"], "members keep their public district names");
  assert.ok(w.city.districts.every(d => d.label === "Proj"));
  assert.ok(w.links.some(l => l.includes("@ana") && l.includes("@mike") && l[2] === 1), "the founder's welcome friendship is a (faint) ray");
});

test("/world page: renderer in world mode, names escaped, strict policy, live feed folds per member", async () => {
  const r = await fetch(`${base}/world`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await r.text();
  assert.match(html, /id="city-data"/); assert.match(html, /"world":\{/); assert.match(html, /\/v1\/world\/live/);
  assert.ok(!html.includes("Ana <b>"), "member names are escaped inside the page data");
  const live = await (await fetch(`${base}/v1/world/live`)).json();
  assert.ok(live.at && typeof live.districts === "object");
  for (const k of Object.keys(live.districts)) assert.match(k, /^@/, "live data is keyed by member, never by project");
  const png = await fetch(`${base}/world/preview.png`);
  assert.equal(png.status, 200); assert.equal(png.headers.get("content-type"), "image/png");
});
