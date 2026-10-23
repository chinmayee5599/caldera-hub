// Sign-up funnel clean-up: crawlers aren't counted, signed-out actions open a panel before GitHub (and count as "gate"),
// and "get a sign-up link by email" sends one link that works on any device without ever making a second profile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir; const sent = [];
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const NAV = { "user-agent": CHROME, "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html" };
const ids = { mike: C.newIdentity(), ana: C.newIdentity() };
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const form = (p, data, headers = {}) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://hub.test", ...NAV, ...headers }, body: new URLSearchParams(data).toString() });
async function login(id) { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; }
const steps = (step) => hub.db.prepare("SELECT detail FROM funnel_events WHERE step=?").all(step).map(r => r.detail);
const clear = () => hub.db.prepare("DELETE FROM funnel_events").run();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-gate-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 }, email: { send: async m => { sent.push(m); } } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const who of ["mike", "ana"]) {
    const m = C.sign(ids[who], "profile.manifest", { name: who === "mike" ? "Mike Jones" : "Ana", handle: who, boxKey: ids[who].boxPublic });
    await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body><h1>hi</h1><p>hi</p></body></html>").toString("base64") } });
  }
  await post(`/v1/owner/${ids.mike.id}/email`, { email: "mike@realmail.org" }, await login(ids.mike));
  const link = sent[0].text.match(/https:\/\/hub\.test(\/v1\/email\/confirm\?t=[\w-]+)/)[1];
  await fetch(base + link, { method: "POST" }); sent.length = 0;
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const gate = (k, headers) => fetch(base + "/v1/funnel/gate", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: k });

test("crawlers and scripts dressed as Chrome aren't counted; real browsers are", async () => {
  clear();
  const bots = ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Mozilla/5.0 (compatible; GoogleOther)", "BigBug/1.0 (Wrendex)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "meta-webindexer/1.1"];
  for (const ua of bots) await gate("follow", { "user-agent": ua });
  assert.equal(steps("gate").length, 0, "named crawlers never counted");
  await gate("follow", { "user-agent": CHROME + " prefetch", "sec-fetch-mode": "no-cors" });   // not a navigation or a page's own request
  assert.equal(steps("gate").length, 0, "no-cors fetches never counted");
  const n0 = 0;
  await gate("follow", { "user-agent": CHROME, "sec-fetch-mode": "cors" });
  await gate("follow", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" });
  assert.equal(steps("gate").length - n0, 2, "a real Chrome request and an older Safari (no Sec-Fetch headers) both count");
});

test("signed-out profile page: no crawlable sign-up link, the panel script instead, with the member's name", async () => {
  const html = await (await fetch(`${base}/@mike/`, { headers: NAV })).text();
  assert.doesNotMatch(html, /href="[^"]*\/auth\/github/, "nothing on the page for crawlers to follow to GitHub");
  assert.match(html, /window\.calGate/); assert.match(html, /data-nm="Mike Jones"/); assert.match(html, /data-back="\/@mike\/"/);
  assert.match(html, /Message '\+nm\+' on Caldera/);
});

test("the panel opening counts as gate, per action, and only known actions", async () => {
  clear();
  for (const k of ["follow", "message", "nonsense"]) await gate(k, { "user-agent": CHROME + " " + k, "sec-fetch-mode": "cors" });   // one row per visitor per step per day: a visitor each
  await gate("kudos", { "user-agent": "meta-externalagent/1.1" });
  assert.deepEqual(steps("gate").sort(), ["follow", "message"]);
});

test("signed-out Message: the sign-up page explains, says read-only, offers the email link, and counts as gate", async () => {
  clear();
  const html = await (await fetch(`${base}/signin?back=${encodeURIComponent("/messages/@mike")}`, { headers: NAV })).text();
  assert.match(html, /Sign up to message Mike Jones/); assert.match(html, /Read-only: your public GitHub profile and email/);
  assert.match(html, /action="\/signin\/signup-email"/); assert.match(html, /name="back" value="\/messages\/@mike"/); assert.match(html, /name="invite" value="mike"/);
  assert.deepEqual(steps("gate"), ["message"]);
});

test("email sign-up link: a new address gets a GitHub link for any device plus a no-GitHub way, and no account is made", async () => {
  clear(); sent.length = 0;
  const before = hub.db.prepare("SELECT COUNT(*) n FROM profiles").get().n;
  const r = await form("/signin/signup-email", { email: "New@Person.dev", back: "/messages/@mike", invite: "mike" });
  assert.equal(r.status, 200); assert.match(await r.text(), /Check your email/);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, "new@person.dev"); assert.match(sent[0].subject, /sign-up link/);
  assert.match(sent[0].text, /https:\/\/hub\.test\/auth\/github\?back=%2Fmessages%2F%40mike&invite=mike/);
  assert.match(sent[0].text, /https:\/\/hub\.test\/start\?back=%2Fmessages%2F%40mike&invite=mike/);
  assert.match(sent[0].text, /Read-only/);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM profiles").get().n, before, "no profile until they actually sign up");
  assert.deepEqual(steps("email-start"), ["from /messages"]); assert.deepEqual(steps("email-sent"), ["new"]);
});

test("email sign-up link: an address that already has a page signs into THAT page (same answer on screen)", async () => {
  sent.length = 0;
  const r = await form("/signin/signup-email", { email: "mike@realmail.org" }, { "user-agent": CHROME + " x" });
  assert.match(await r.text(), /Check your email/);
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /already have a Caldera page/); assert.match(sent[0].text, /@mike/);
  const link = sent[0].text.match(/https:\/\/hub\.test(\/signin\/link\?c=[\w%-]+)/)[1], c = decodeURIComponent(new URL(base + link).searchParams.get("c"));
  const use = await form("/signin/link", { c }); assert.equal(use.status, 303); assert.equal(use.headers.get("location"), "/@mike/");
});

test("email sign-up link: bad addresses and floods are refused, cross-site posts too", async () => {
  sent.length = 0;
  assert.equal((await form("/signin/signup-email", { email: "nope" })).status, 400);
  assert.equal((await form("/signin/signup-email", { email: "a@b.dev" }, { origin: "https://evil.example" })).status, 403);
  for (let i = 0; i < 3; i++) await form("/signin/signup-email", { email: "flood@x.dev" }, { "user-agent": CHROME + " f" + i });
  assert.equal((await form("/signin/signup-email", { email: "flood@x.dev" }, { "user-agent": CHROME + " f9" })).status, 429);
  assert.equal(sent.filter(m => m.to === "flood@x.dev").length, 3);
});

test("a script claiming to be modern Chrome but sending no Sec-Fetch-Mode isn't counted", async () => {
  const http = await import("node:http"), port = new URL(base).port; clear();
  const send = (ua, extra = {}) => new Promise(r => { const q = http.request({ port, method: "POST", path: "/v1/funnel/gate", headers: { "content-type": "text/plain", "user-agent": ua, ...extra } }, s => { s.resume(); s.on("end", r); }); q.end("follow"); });
  await send(CHROME.replace("Macintosh", "Windows NT 10.0"));   // raw request: no Sec-Fetch headers at all
  assert.equal(steps("gate").length, 0);
  await send(CHROME + " real", { "sec-fetch-mode": "cors" });
  assert.equal(steps("gate").length, 1);
});
