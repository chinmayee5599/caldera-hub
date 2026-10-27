import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
import { cityData, publicCity, renderCity, citySnapshot } from "../../../../caldera/packages/plugin/test/city.build.mjs";

const repo = (name, project, pub, commits, week) => ({ name, project, public: pub, language: pub ? "TypeScript" : "Rust", commits, weeks: [1, week], week, today: 0, ...(pub ? { url: `https://github.com/rae/${name}` } : {}) });
const full = cityData([repo("app", "Shop", true, 300, 4), repo("shop-secret", "Shop", false, 900, 7), repo("lab-1", "Secret Lab", false, 120, 3), repo("lab-2", "Secret Lab", false, 40, 0)], () => ({ n: 0, paths: [] }), "2026-10-18T00:00:00Z");
const pubCity = publicCity(full, ["Shop"], "show");   // what an older plugin publishes: padlocks in place
const b64 = s => Buffer.from(s).toString("base64");
const files = { "index.html": b64(`<html><head></head><body><h1 class="title">Rae</h1>${citySnapshot(pubCity, { name: "Rae" })}</body></html>`), "city.html": b64(renderCity({ name: "Rae", handle: "rae" }, pubCity)) };
const cityData_ = html => JSON.parse(html.match(/id="city-data">([\s\S]*?)<\/script>/)[1]);
const lockedIn = c => c.districts.flatMap(d => d.repos).filter(r => r.locked);

async function hubWithRae() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-pm-"));
  const h = createHub({ privateNamedSince: "9999-12-31T00:00:00Z", privateModeSince: "2999-01-01T00:00:00Z", dataDir: d });   // Rae joined before the setting existed
  const base = "http://127.0.0.1:" + await h.listen(0);
  const rae = C.newIdentity();
  const r = await fetch(`${base}/v1/profiles/${rae.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(rae, "profile.manifest", { name: "Rae", handle: "rae", boxKey: rae.boxPublic }), files }) });
  assert.equal(r.status, 200);
  const get = async p => (await fetch(base + p, { headers: { "user-agent": "Mozilla/5.0 test" } })).text();
  return { h, d, base, rae, get };
}

test("members from before the setting: private repos show (padlocked, in place) by default; every public surface follows the setting, whatever built the page", async () => {
  const { h, d, base, rae, get } = await hubWithRae();
  assert.equal(h.privateModes.modeFor(h.db.prepare("SELECT * FROM profiles WHERE id=?").get(rae.id)), "show", "unset = show, for everyone");
  h.privateModes.set(rae.id, "anonymous");
  let city = cityData_(await get("/@rae/city.html"));
  const apart = city.districts.filter(x => x.apart);
  assert.equal(apart.length, 1); assert.equal(apart[0].repos.length, 3, "3 private repos -> the small cluster");
  assert.ok(apart[0].repos.every(r => r.week === 0 && r.commits === 25), "no activity, identical sizes");
  assert.equal(city.districts.find(x => x.name === "Shop").repos.filter(r => r.locked).length, 0, "no padlock beside the named project");
  let page = await get("/@rae/city.html");
  assert.ok(!/shop-secret|lab-\d|Secret Lab|<b>900<\/b>/.test(page));
  let index = await get("/@rae/");
  assert.ok(index.includes("+ private work"), "the profile's city preview is redrawn");
  let world = await (await fetch(base + "/v1/world")).json();
  const raeRepos = world.city.districts.filter(x => x.nb === "@rae").flatMap(x => x.repos);
  assert.equal(raeRepos.filter(r => r.locked).length, 3);
  // hidden: no trace anywhere public
  h.privateModes.set(rae.id, "hidden");
  city = cityData_(await get("/@rae/city.html"));
  assert.equal(lockedIn(city).length, 0); assert.deepEqual(city.totals, { commits: 300, active: 1 });
  page = await get("/@rae/city.html"); index = await get("/@rae/");
  assert.ok(!page.includes("&#128274; Private</span>"), "no padlock legend");
  assert.ok(!page.includes("Glass buildings with a padlock"), "no padlock lede");
  assert.ok(!/class="[^"]*cp-cool/.test(index), "preview has no lit padlocks");
  assert.ok(!index.includes("+ private work"), "preview caption has no private work");
  world = await (await fetch(base + "/v1/world")).json();
  assert.equal(world.city.districts.filter(x => x.nb === "@rae").flatMap(x => x.repos).filter(r => r.locked).length, 0);
  // show: the published page as it was
  h.privateModes.set(rae.id, "show");
  city = cityData_(await get("/@rae/city.html"));
  assert.equal(lockedIn(city).length, 3);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("members from before the setting keep padlocks until they choose, and are asked once", async () => {
  const { h, d, rae, get } = await hubWithRae();
  h.db.prepare("UPDATE profiles SET created=? WHERE id=?").run("2026-01-01T00:00:00.000Z", rae.id);
  assert.equal(h.privateModes.modeFor(h.db.prepare("SELECT * FROM profiles WHERE id=?").get(rae.id)), "show");
  assert.equal(lockedIn(cityData_(await get("/@rae/city.html"))).length, 3, "an existing member's city doesn't change silently");
  h.promptPrivateChoice(); h.promptPrivateChoice();
  const n = h.db.prepare("SELECT COUNT(*) n FROM alerts WHERE target=? AND dkey='private-repos-choice'").get(rae.id).n;
  assert.equal(n, 1, "one alert, once");
  h.privateModes.set(rae.id, "anonymous");
  assert.equal(h.privateModes.chosen(h.db.prepare("SELECT * FROM profiles WHERE id=?").get(rae.id)), "anonymous");
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("new members start Anonymous (names only by choice); existing members get a one-tap offer that Obsidian also picks up", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-pm-named-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const old = C.newIdentity(), fresh = C.newIdentity();
    for (const [h, id] of [["rae", old], ["neo", fresh]]) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h, handle: h, boxKey: id.boxPublic }), files });
    hub.db.prepare("UPDATE profiles SET created=? WHERE handle='rae'").run("2026-01-01T00:00:00.000Z");
    const PM = hub.privateModes, pr = h => hub.db.prepare("SELECT * FROM profiles WHERE handle=?").get(h);
    assert.equal(PM.modeFor(pr("rae")), "show", "existing members keep padlocks until they choose");
    assert.equal(PM.modeFor(pr("neo")), "anonymous", "new members start Anonymous: private repo names are never published by default");

    assert.equal(hub.offerNamed(), 1, "only the existing member with padlocks is offered names");
    assert.equal(hub.offerNamed(), 0, "once each");
    const al = hub.db.prepare("SELECT * FROM alerts WHERE target=? AND dkey='private-named-offer'").get(old.id);
    assert.match(al.cta_url, /^http:\/\/hub\.test\/v1\/private-mode\/named\?t=/);
    assert.equal((await fetch(base + "/v1/private-mode/named?t=forged")).status, 400);
    const ok = await fetch(al.cta_url.replace("http://hub.test", base));
    assert.equal(ok.status, 200); assert.match(await ok.text(), /show by name/);
    assert.equal(PM.modeFor(pr("rae")), "named");
    // Obsidian reads the web choice from its alerts poll
    const { body: ch } = await post("/v1/auth/challenge", { id: old.id }), tok = (await post("/v1/auth/verify", C.sign(old, "message", { nonce: ch.nonce }))).body.token;
    const r = await (await fetch(base + `/v1/owner/${old.id}/alerts`, { headers: { authorization: "Bearer " + tok } })).json();
    assert.equal(r.privateRepos.mode, "named"); assert.ok(r.privateRepos.ts);
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
