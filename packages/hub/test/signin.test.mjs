import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
import { cleanImage, sniff } from "../dist/images.js";

let hub, base, dir; const sent = [];
const UA = { "user-agent": "Mozilla/5.0" };
const ids = { mike: C.newIdentity(), ana: C.newIdentity(), cy: C.newIdentity() };
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const form = (p, data) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });
async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}
const ownerPage = async cookie => (await fetch(`${base}/@mike/`, { headers: { ...UA, cookie } })).text();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-signin-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 }, email: { send: async m => { sent.push(m); } } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const who of ["mike", "ana", "cy"]) {
    const m = C.sign(ids[who], "profile.manifest", { name: who, handle: who, boxKey: ids[who].boxPublic });
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body><p>hi</p></body></html>").toString("base64") } });
  }
  // mike has a confirmed summary address; cy has none
  await post(`/v1/owner/${ids.mike.id}/email`, { email: "mike@realmail.org" }, await login(ids.mike));
  const link = sent[0].text.match(/https:\/\/hub\.test(\/v1\/email\/confirm\?t=[\w-]+)/)[1];
  await fetch(base + link, { method: "POST" }); sent.length = 0;
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("anonymous bar links to /signin; the sign-in page lists the right ways in", async () => {
  const html = await (await fetch(`${base}/@mike/`, { headers: UA })).text();
  assert.match(html, /href="https:\/\/hub\.test\/signin\?h=mike"/); assert.match(html, /Get your own page/);
  const si = await (await fetch(base + "/signin?h=mike")).text();
  assert.match(si, /Email me a sign-in link/); assert.match(si, /Pair from Obsidian/); assert.doesNotMatch(si, /Sign in with GitHub/);
  assert.match(await (await fetch(base + "/signin?h=cy")).text(), /no confirmed summary email/);
  assert.equal((await fetch(base + "/signin?h=nobody")).status, 404);
});

test("email sign-in: same answer for right and wrong addresses, link only to the confirmed one, button page, single use", async () => {
  const wrong = await (await form("/signin/email", { h: "mike", email: "someone@else.org" })).text();
  const right = await (await form("/signin/email", { h: "mike", email: "Mike@RealMail.org" })).text();
  const msg = /If that&#39;s the email on this page|If that's the email on this page/;
  assert.match(wrong, msg); assert.match(right, msg);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sent.length, 1, "only the matching address gets mail"); assert.equal(sent[0].to, "mike@realmail.org");
  const link = sent[0].text.match(/https:\/\/hub\.test(\/signin\/link\?c=[\w-]+)/)[1], c = new URL(base + link).searchParams.get("c");
  const show = await fetch(base + link); assert.equal(show.status, 200); assert.equal(show.headers.get("set-cookie"), null, "GET never signs in (mail scanners)");
  const use = await form("/signin/link", { c }); assert.equal(use.status, 303); assert.equal(use.headers.get("location"), "/@mike/");
  const cookie = (use.headers.get("set-cookie") || "").split(";")[0]; assert.match(cookie, /^cal_own=[0-9a-f]{64}$/);
  assert.match(await ownerPage(cookie), /viewing your public page/);
  assert.equal((await form("/signin/link", { c })).status, 400, "single use");
});

test("email sign-in links expire", async () => {
  sent.length = 0;
  await form("/signin/email", { h: "mike", email: "mike@realmail.org" }); await new Promise(r => setTimeout(r, 50));
  const c = new URL(sent[0].text.match(/(https:\/\/hub\.test\/signin\/link\?c=[\w-]+)/)[1]).searchParams.get("c");
  hub.db.prepare("UPDATE signin_links SET expires=?").run(Date.now() - 1);
  assert.equal((await form("/signin/link", { c })).status, 400);
});

test("email sign-in is rate limited per page", async () => {
  let limited = false;
  for (let i = 0; i < 8; i++) if (/Too many tries/.test(await (await form("/signin/email", { h: "ana", email: "x@realmail.org" })).text())) limited = true;
  assert.ok(limited);
});

test("pairing: only the page's own key can approve; approved code signs in once; codes expire", async () => {
  const { body: pc } = await post("/signin/pair", { h: "mike" });
  assert.match(pc.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal((await (await fetch(base + "/signin/pair/status?p=" + pc.poll)).json()).state, "waiting");
  assert.equal((await post(`/v1/owner/${ids.mike.id}/pair`, { code: pc.code })).status, 401, "needs the vault's key");
  assert.equal((await post(`/v1/owner/${ids.ana.id}/pair`, { code: pc.code }, await login(ids.ana))).status, 404, "another profile can't approve mike's code");
  assert.equal((await (await fetch(base + "/signin/pair/status?p=" + pc.poll)).json()).state, "waiting");
  const before = await form("/signin/pair/done", { p: pc.poll }); assert.equal(before.status, 400, "not approved yet");
  // that attempt used up the poll token; make a fresh one and approve it with spaces and lower case
  const { body: pc2 } = await post("/signin/pair", { h: "mike" });
  const ok = await post(`/v1/owner/${ids.mike.id}/pair`, { code: pc2.code.slice(0, 3).toLowerCase() + " " + pc2.code.slice(3) }, await login(ids.mike));
  assert.equal(ok.status, 200); assert.equal(ok.body.handle, "mike");
  assert.equal((await (await fetch(base + "/signin/pair/status?p=" + pc2.poll)).json()).state, "approved");
  const done = await form("/signin/pair/done", { p: pc2.poll }); assert.equal(done.status, 303);
  assert.match(await ownerPage((done.headers.get("set-cookie") || "").split(";")[0]), /viewing your public page/);
  assert.equal((await form("/signin/pair/done", { p: pc2.poll })).status, 400, "single use");
  const { body: pc3 } = await post("/signin/pair", { h: "mike" });
  hub.db.prepare("UPDATE pair_codes SET expires=?").run(Date.now() - 1);
  assert.equal((await post(`/v1/owner/${ids.mike.id}/pair`, { code: pc3.code }, await login(ids.mike))).status, 404, "expired");
  assert.equal((await (await fetch(base + "/signin/pair/status?p=" + pc3.poll)).json()).state, "expired");
});

test("uploaded images: magic bytes checked, metadata stripped", () => {
  assert.equal(sniff(Buffer.from("GIF89a....")), null);
  assert.equal(cleanImage(Buffer.from("<svg></svg>")).ok, false);
  // a minimal JPEG with an EXIF APP1 segment holding a GPS-like string, then SOS
  const ex = Buffer.from("Exif\0\0GPS-SECRET"), exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, ex.length + 2]), ex]);
  const jfif = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x07]), Buffer.from("JFIF\0")]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]);
  const r = cleanImage(jpg); assert.ok(r.ok); assert.equal(r.ext, "jpg");
  assert.ok(!r.data.includes("GPS-SECRET")); assert.ok(r.data.includes("JFIF"));
  assert.equal(cleanImage(Buffer.alloc(3 * 1024 * 1024 + 10, 0xff)).ok, false);
});
