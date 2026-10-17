import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const UA = { "user-agent": "Mozilla/5.0" };
const ids = { mike: C.newIdentity(), ana: C.newIdentity() };
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const page = (h, cookie) => fetch(`${base}/@${h}/`, { headers: { ...UA, ...(cookie ? { cookie } : {}) } });
async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}
async function ownerCookie(id) {
  const { body } = await post(`/v1/owner/${id.id}/link`, {}, await login(id));
  const r = await fetch(body.url.replace("https://hub.test", base), { redirect: "manual" });
  return { r, code: body.url, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const views = async id => (await (await fetch(`${base}/v1/owner/${id.id}/activity?since=2000-01-01`, { headers: { authorization: "Bearer " + await login(id) } })).json()).views;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-owner-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", privateUrl: "https://priv.tailnet.test", tailnetOwners: { "mike@example.com": "mike" }, limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const who of ["mike", "ana"]) {
    const m = C.sign(ids[who], "profile.manifest", { name: who, handle: who, boxKey: ids[who].boxPublic });
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body><p>hi</p></body></html>").toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("anonymous visitors: sign-up bar, view counted, no private address anywhere", async () => {
  const r = await page("mike"); const html = await r.text();
  assert.match(html, /Get your own page/); assert.doesNotMatch(html, /priv\.tailnet|viewing your public page|Private view/);
  assert.equal(r.headers.get("vary"), "Cookie");
  assert.equal(await views(ids.mike), 1);
});

test("owner link: signed-in only, single use, sets an HttpOnly owner cookie", async () => {
  assert.equal((await post(`/v1/owner/${ids.mike.id}/link`, {})).status, 401);
  assert.equal((await post(`/v1/owner/${ids.mike.id}/link`, {}, await login(ids.ana))).status, 401, "not someone else's");
  const { r, code } = await ownerCookie(ids.mike);
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/@mike/");
  assert.match(r.headers.get("set-cookie"), /^cal_own=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure/);
  const again = await fetch(code.replace("https://hub.test", base), { redirect: "manual" });
  assert.equal(again.status, 400, "a code works once");
  assert.equal((await fetch(base + "/v1/own?c=nope", { redirect: "manual" })).status, 400);
  const { body } = await post(`/v1/owner/${ids.mike.id}/link`, {}, await login(ids.mike));
  const deep = await fetch(body.url.replace("https://hub.test", base) + "&to=city.html", { redirect: "manual" });
  assert.equal(deep.headers.get("location"), "/@mike/city.html");
  const { body: b2 } = await post(`/v1/owner/${ids.mike.id}/link`, {}, await login(ids.mike));
  assert.equal((await fetch(b2.url.replace("https://hub.test", base) + "&to=//evil.example", { redirect: "manual" })).headers.get("location"), "/@mike/", "no open redirect");
});

test("owner sees a Private view button on their own page only, and their visits aren't counted", async () => {
  const { cookie } = await ownerCookie(ids.mike);
  const before = await views(ids.mike);
  const html = await (await page("mike", cookie)).text();
  assert.match(html, /You're viewing your public page/); assert.match(html, /href="https:\/\/priv\.tailnet\.test\/@mike\/"[^>]*>&#128274; Private view</);
  assert.doesNotMatch(html, /Get your own page/);
  assert.equal(await views(ids.mike), before, "owner views not counted");
  const other = await (await page("ana", cookie)).text();
  assert.doesNotMatch(other, /priv\.tailnet|viewing your public page/, "mike's cookie means nothing on ana's page");
  assert.doesNotMatch(await (await page("mike", "cal_own=" + "0".repeat(64))).text(), /Private view/, "forged cookie");
});

test("stale page: only the owner sees 'Last updated N days ago'", async () => {
  hub.db.prepare("UPDATE profiles SET updated=? WHERE handle='mike'").run(new Date(Date.now() - 5 * 86400_000 - 60_000).toISOString());
  try {
    const { cookie } = await ownerCookie(ids.mike);
    const mine = await (await page("mike", cookie)).text();
    assert.match(mine, /Last updated 5 days ago/); assert.match(mine, /Private view/);
    assert.doesNotMatch(await (await page("mike")).text(), /Last updated|days ago/, "anonymous visitors never see staleness");
    hub.db.prepare("UPDATE profiles SET updated=? WHERE handle='mike'").run(new Date(Date.now() - 2 * 86400_000).toISOString());
    assert.doesNotMatch(await (await page("mike", cookie)).text(), /Last updated/, "under 3 days: no notice");
  } finally { hub.db.prepare("UPDATE profiles SET updated=? WHERE handle='mike'").run(new Date().toISOString()); }
});

test("plugin owner without a private address gets an Obsidian link; sign out clears it", async () => {
  const { cookie } = await ownerCookie(ids.ana);
  assert.match(await (await page("ana", cookie)).text(), /href="obsidian:\/\/caldera\?open=private" target="_blank"[^>]*>&#128274; Private view in Obsidian/);
  const out = await fetch(`${base}/v1/own/out?h=ana`, { headers: { cookie }, redirect: "manual" });
  assert.equal(out.status, 302); assert.match(out.headers.get("set-cookie"), /^cal_own=; .*Max-Age=0/);
  assert.doesNotMatch(await (await page("ana", cookie)).text(), /Private view/, "session deleted server-side");
});
