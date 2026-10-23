import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const UA = { "user-agent": "Mozilla/5.0" };
const ids = { mike: C.newIdentity(), ana: C.newIdentity(), bo: C.newIdentity() };
const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}
async function ownerCookie(id) {
  const { body } = await post(`/v1/owner/${id.id}/link`, {}, { authorization: "Bearer " + await login(id) });
  const r = await fetch(body.url.replace("https://hub.test", base), { redirect: "manual" });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const send = (h, kind, cookie, origin = "https://hub.test") => post(`/v1/kudos/${h}`, { kind }, { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) });
const page = (h, cookie) => fetch(`${base}/@${h}/`, { headers: { ...UA, ...(cookie ? { cookie } : {}) } }).then(r => r.text());

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-kudos-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const who of Object.keys(ids)) {
    const m = C.sign(ids[who], "profile.manifest", { name: who, handle: who, boxKey: ids[who].boxPublic, ...(who === "bo" ? { showViews: false } : {}) });
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body><p>hi</p></body></html>").toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("only signed-in members can send; same-origin only; never to yourself; known kinds only", async () => {
  assert.equal((await send("ana", "heart")).status, 401, "anonymous visitors can't send");
  const mike = await ownerCookie(ids.mike);
  assert.equal((await send("ana", "heart", mike, "https://evil.example")).status, 403, "cross-site refused");
  assert.equal((await send("ana", "heart", mike, "")).status, 403, "no Origin refused");
  assert.equal((await send("mike", "heart", mike)).status, 400, "not to yourself");
  assert.equal((await send("ana", "poop", mike)).status, 400, "unknown kind");
  assert.equal((await send("nobody", "heart", mike)).status, 404);
  const ok = await send("ana", "fire", mike);
  assert.equal(ok.status, 200); assert.deepEqual(Object.fromEntries(ok.body.tally).fire, 1);
});

test("one kudos per sender per recipient per day; public tally; the kudos window", async () => {
  const mike = await ownerCookie(ids.mike);
  const again = await send("ana", "heart", mike);
  assert.equal(again.status, 409); assert.match(again.body.error, /already sent @ana kudos today/);
  const bo = await ownerCookie(ids.bo);
  assert.equal((await send("ana", "heart", bo)).status, 200, "another member can");
  const t = await (await fetch(`${base}/v1/kudos/ana`)).json();
  assert.deepEqual(t.tally, { heart: 1, up: 0, fire: 1, sparkle: 0 });
  assert.match(await (await fetch(`${base}/kudos/ana`)).text(), /Kudos come from Caldera members/, "anonymous window offers sign-in");
  const w = await (await fetch(`${base}/kudos/ana`, { headers: { cookie: mike } })).text();
  assert.match(w, /Kudos sent today/); assert.match(w, /disabled/);
  assert.match(await (await fetch(`${base}/kudos/mike`, { headers: { cookie: mike } })).text(), /This is your page/);
});

test("plugin API: send and read kudos with the vault's key; owner sees who", async () => {
  const tok = await login(ids.ana);
  const r = await post(`/v1/owner/${ids.ana.id}/kudos`, { to: "mike", kind: "sparkle" }, { authorization: "Bearer " + tok });
  assert.equal(r.status, 200);
  assert.equal((await post(`/v1/owner/${ids.ana.id}/kudos`, { to: "mike", kind: "sparkle" })).status, 401, "needs the key");
  const mine = await (await fetch(`${base}/v1/owner/${ids.mike.id}/kudos?since=2000-01-01`, { headers: { authorization: "Bearer " + await login(ids.mike) } })).json();
  assert.equal(mine.kudos[0].from, "ana"); assert.equal(mine.kudos[0].kind, "sparkle");
  assert.equal((await fetch(`${base}/v1/owner/${ids.mike.id}/kudos`, { headers: { authorization: "Bearer " + tok } })).status, 401, "not someone else's list");
  const act = await (await fetch(`${base}/v1/owner/${ids.ana.id}/activity?since=2000-01-01`, { headers: { authorization: "Bearer " + tok } })).json();
  assert.equal(act.kudos.length, 2); assert.equal(typeof act.viewsAll, "number"); assert.equal(typeof act.viewsWeek, "number");
});

test("the bar: public views + inline kudos row; owner can hide views (and still sees them)", async () => {
  await page("ana"); await page("ana");
  const anon = await page("ana");
  assert.match(anon, /class="cb-views"[^>]*><b>1<\/b> view</, "one visitor today = 1 view"); assert.match(anon, /class="cb-k" data-k="heart"/); assert.match(anon, /data-api="https:\/\/hub\.test"/); assert.doesNotMatch(anon, /data-act=/, "no action token for anonymous visitors"); assert.match(anon, /window\.calGate/, "signed-out visitors get the sign-up panel"); assert.doesNotMatch(anon, /href="[^"]*\/auth\/github/, "and no crawlable GitHub link");
  const boAnon = await page("bo");
  assert.doesNotMatch(boAnon, /&#128065;/, "hidden views aren't shown to visitors");
  const boOwn = await page("bo", await ownerCookie(ids.bo));
  assert.match(boOwn, /only you see this/); assert.doesNotMatch(boOwn, /class="cb-k/, "no kudos buttons on your own page");
  assert.equal((await (await fetch(`${base}/v1/kudos/bo`)).json()).views, null);
});

test("sign out of everything clears kudos-sending ability; erase removes kudos", async () => {
  const bo = await ownerCookie(ids.bo);
  await fetch(`${base}/signout`, { method: "POST", headers: { cookie: bo, origin: "https://hub.test" }, redirect: "manual" });
  assert.equal((await send("mike", "up", bo)).status, 401);
  hub.db.prepare("DELETE FROM kudos").run();
});
