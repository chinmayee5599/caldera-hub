import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const ORIGIN = { origin: "https://hub.test" };
const who = ["mike", "ana", "bo", "cy", "hid"];
const ids = Object.fromEntries(who.map(w => [w, C.newIdentity()]));
const MANIFEST = {
  mike: { headline: "Founder and investor", topics: [["ai agents", 9]], languages: ["TypeScript"] },
  ana: { headline: "Full-stack developer building AI agents", topics: [["ai agents", 5], ["social features", 3]], languages: ["TypeScript", "Python"] },
  bo: { headline: "Designer", topics: [["design", 4]], languages: ["CSS"] },
  cy: { headline: "ML engineer", topics: [["trading bots", 2]], languages: ["Python"] },
  hid: { headline: "Secret developer building AI agents", topics: [["ai agents", 9]], languages: ["TypeScript"], listed: false },
};
const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}
const cookies = {};
async function ownerCookie(w) {
  if (cookies[w]) return cookies[w];
  const { body } = await post(`/v1/owner/${ids[w].id}/link`, {}, { authorization: "Bearer " + await login(ids[w]) });
  const r = await fetch(body.url.replace("https://hub.test", base), { redirect: "manual" });
  return (cookies[w] = (r.headers.get("set-cookie") || "").split(";")[0]);
}
const as = async (w, p, body, extra = {}) => post(p, body, { cookie: await ownerCookie(w), ...ORIGIN, ...extra });
const ASK = { type: "someone", role: "a co-founder", commitment: "equity", topic: "AI agents", detail: "Building a social layer for Obsidian with TypeScript" };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-gifts-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", founder: "mike", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const w of who) {
    const m = C.sign(ids[w], "profile.manifest", { name: w.toUpperCase(), handle: w, boxKey: ids[w].boxPublic, ...MANIFEST[w] });
    await post(`/v1/profiles/${ids[w].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${w.toUpperCase()}</h1><p class="lede">${MANIFEST[w].headline}</p></body></html>`).toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });


test("light-ups: one gift a day (founder two), not yourself, one per city, public repos only; shows on the world, feed and bell", async () => {
  const me = async w => (await fetch(base + "/v1/gifts/me", { headers: { cookie: await ownerCookie(w) } })).json();
  assert.deepEqual(await (await fetch(base + "/v1/gifts/me")).json(), { member: false, listed: false, left: 0, max: 0, today: [] });
  assert.equal((await me("ana")).left, 1); assert.equal((await me("mike")).max, 2, "founder gets two");
  assert.equal((await post("/v1/gifts", { to: "bo" }, ORIGIN)).status, 401, "sign in first");
  assert.equal((await as("ana", "/v1/gifts", { to: "ana" })).status, 400, "not yourself");
  assert.equal((await as("ana", "/v1/gifts", { to: "hid" })).status, 404, "unlisted cities aren't on the map");
  assert.equal((await as("hid", "/v1/gifts", { to: "bo" })).status, 403, "unlisted members can't give");
  assert.equal((await as("ana", "/v1/gifts", { to: "bo", repo: "secret-thing" })).status, 400, "only their public buildings");
  const g = await as("ana", "/v1/gifts", { to: "bo" });
  assert.equal(g.status, 200); assert.equal(g.body.left, 0); assert.deepEqual(g.body.lit.by, ["ana"]);
  assert.equal((await as("ana", "/v1/gifts", { to: "cy" })).status, 429, "one a day");
  assert.equal((await as("mike", "/v1/gifts", { to: "bo" })).status, 200);
  assert.equal((await as("mike", "/v1/gifts", { to: "bo" })).status, 409, "one per city per day");
  assert.equal((await as("mike", "/v1/gifts", { to: "cy" })).status, 200, "the founder's second gift");
  const lit = (await (await fetch(base + "/v1/world/live")).json()).lit;
  assert.equal(lit["@bo"].n, 2); assert.deepEqual(lit["@bo"].by.sort(), ["ana", "mike"]); assert.equal(lit["@cy"].n, 1);
  const feed = await (await fetch(base + "/v1/feed?format=html&type=cities")).json();
  assert.match(feed.html, /lit up <a href="\/@bo\/">BO<\/a>'s city/);
  const al = await (await fetch(`${base}/v1/owner/${ids.bo.id}/alerts`, { headers: { authorization: "Bearer " + await login(ids.bo) } })).json();
  assert.ok(al.alerts.some(a => /2 people lit up your city today/.test(a.title)), "one bell alert, folded");
  const world = await (await fetch(base + "/world")).text();
  assert.match(world, /CALDERA_GIFTS/);
});
