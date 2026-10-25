import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const UA = { "user-agent": "Mozilla/5.0" };
const ids = { ana: C.newIdentity(), bo: C.newIdentity() };
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
const page = (h, cookie) => fetch(`${base}/@${h}/`, { headers: { ...UA, ...(cookie ? { cookie } : {}) } }).then(r => r.text());

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-share-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const who of Object.keys(ids)) {
    const m = C.sign(ids[who], "profile.manifest", { name: who === "ana" ? "Ana <Lee>" : who, handle: who, boxKey: ids[who].boxPublic });
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${who}</h1><p>hi</p></body></html>`).toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("every viewer gets a Share button with the profile's public address", async () => {
  const anon = await page("ana");
  assert.match(anon, /class="cb-shb"[^>]*data-url="https:\/\/hub\.test\/@ana\/"/, "anonymous visitor can share");
  assert.match(anon, /data-nm="Ana &lt;Lee&gt;"/, "name is escaped");
  assert.ok(anon.includes("Copy link") && anon.includes("sms:?&body=") && anon.includes("mailto:?subject="), "menu script ships with the page");
  const member = await page("ana", await ownerCookie(ids.bo));
  assert.match(member, /class="cb-shb"[^>]*data-url="https:\/\/hub\.test\/@ana\/"/, "signed-in member can share");
  const owner = await page("ana", await ownerCookie(ids.ana));
  assert.match(owner, /class="cb-shb"[^>]*data-url="https:\/\/hub\.test\/@ana\/"[^>]*title="Share your page/, "owner can share their own page");
});
