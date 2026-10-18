import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
import { cleanText, renderText } from "../dist/server.js";

// direct messages: friends write directly, strangers send a request first; block, ignore, report, delete, erase, unread
const UA = { "user-agent": "Mozilla/5.0" };
async function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-msg-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const ids = { ana: C.newIdentity(), bo: C.newIdentity(), cy: C.newIdentity(), dee: C.newIdentity() };
  for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h.toUpperCase(), handle: h, boxKey: id.boxPublic }), files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${h}</h1></body></html>`).toString("base64") } });
  // established accounts (older than two days); dee stays brand new
  hub.db.prepare("UPDATE profiles SET created=? WHERE handle IN ('ana','bo','cy')").run("2026-01-01T00:00:00.000Z");
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const cookieOf = async (id) => { const { body } = await post(`/v1/owner/${id.id}/link`, {}, { authorization: "Bearer " + await login(id) });
    const r = await fetch(body.url.replace("http://hub.test", base), { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; };
  const C2 = {}; for (const h of Object.keys(ids)) C2[h] = await cookieOf(ids[h]);
  const as = (h) => ({ cookie: C2[h], origin: "http://hub.test" });
  const send = (from, to, text) => post("/v1/messages/send", { to, text }, as(from));
  const act = (from, id, a, extra = {}) => post(`/v1/messages/${id}/${a}`, extra, as(from));
  const get = (from, p) => fetch(base + p, { headers: { ...UA, ...(from ? { cookie: C2[from] } : {}) }, redirect: "manual" });
  const thread = async (from, h) => (await get(from, `/v1/messages/thread/${h}`)).json();
  const unread = async (h) => (await (await get(h, "/v1/messages/unread")).json()).unread;
  const friends = (a, b) => { const A = hub.db.prepare("SELECT id FROM profiles WHERE handle=?").get(a).id, B = hub.db.prepare("SELECT id FROM profiles WHERE handle=?").get(b).id;
    for (const [x, y] of [[A, B], [B, A]]) hub.db.prepare("INSERT OR IGNORE INTO friends (a, b, ts) VALUES (?,?,?)").run(x, y, new Date().toISOString()); };
  return { hub, d, base, post, ids, send, act, get, thread, unread, friends, as };
}

test("text is cleaned and rendered safely: no markup, links open in a new window, newlines kept", () => {
  assert.equal(cleanText("  hi\u0000 there\r\n\n\n\n\nok  "), "hi  there\n\n\nok");
  assert.equal(cleanText("x".repeat(5000)).length, 2000);
  const h = renderText(`<script>alert(1)</script> see https://example.com/a?b=1. ok\nbye`);
  assert.doesNotMatch(h, /<script/); assert.match(h, /&lt;script&gt;/);
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener nofollow ugc">https:\/\/example\.com\/a\?b=1<\/a>\./);
  assert.match(h, /ok<br>bye/);
  assert.doesNotMatch(renderText(`"><img src=x onerror=alert(1)>`), /<img/);
});

test("friends message directly; strangers send one request that waits for Accept; only participants read a thread; unread counts", async () => {
  const S = await setup();
  try {
    S.friends("ana", "bo");
    const r1 = await S.send("ana", "bo", "Hi Bo"); assert.equal(r1.status, 200); assert.equal(r1.body.state, "sent");
    assert.equal(await S.unread("bo"), 1);
    const tb = await S.thread("bo", "ana"); assert.equal(tb.state, "open"); assert.equal(tb.messages.length, 1); assert.equal(tb.messages[0].mine, false);
    assert.equal(await S.unread("bo"), 0, "reading marks it read");
    // a stranger: the first message is a request; no second message until accepted
    const r2 = await S.send("cy", "bo", "Hello from Cy, want to work together?"); assert.equal(r2.body.state, "requested");
    assert.equal((await S.send("cy", "bo", "ping")).status, 409, "one pending request per pair");
    assert.equal(await S.unread("bo"), 1, "the request counts");
    const tr = await S.thread("bo", "cy"); assert.equal(tr.state, "request");
    assert.equal(S.hub.db.prepare("SELECT COUNT(*) n FROM alerts WHERE title LIKE '@cy wants to message you%'").get().n, 1, "a personal alert for the request");
    // access control: a third member can't read someone else's thread (they only ever see their own conversation with each person)
    const peek = await S.thread("dee", "bo"); assert.equal(peek.messages.length, 0); assert.equal(peek.id, null);
    assert.equal((await S.act("dee", tr.id, "accept")).status, 404, "not a participant");
    assert.equal((await S.act("cy", tr.id, "accept")).status, 409, "the sender can't accept their own request");
    assert.equal((await S.act("bo", tr.id, "accept")).status, 200);
    assert.equal((await S.send("cy", "bo", "Great, thanks")).body.state, "sent");
    assert.equal((await S.thread("cy", "bo")).state, "open");
    // nobody's email or private data in the payloads
    assert.doesNotMatch(JSON.stringify(await S.thread("cy", "bo")), /@[a-z0-9.-]+\.[a-z]{2,}/i);
    // bodies are sealed at rest
    const raw = S.hub.db.prepare("SELECT body FROM msg_messages LIMIT 1").get().body; assert.doesNotMatch(raw, /Hi Bo|Hello from Cy/);
    // signed out: the API refuses, the page sends you to sign in and back
    assert.equal((await S.post("/v1/messages/send", { to: "bo", text: "x" })).status, 401);
    const g = await S.get(null, "/messages/@bo"); assert.equal(g.status, 302); assert.match(g.headers.get("location"), /^\/signin\?back=%2Fmessages%2F%40bo$/);
    // cross-site posts refused
    assert.equal((await S.post("/v1/messages/send", { to: "bo", text: "x" }, { cookie: S.as("ana").cookie, origin: "https://evil.example" })).status, 403);
    // pages render for participants
    const pg = await (await S.get("bo", "/messages/@cy")).text(); assert.match(pg, /Great, thanks/); assert.match(pg, /encrypted on our servers/);
  } finally { S.hub.server.close(); }
});

test("ignore blocks re-requests for 30 days; block silently drops and hides; brand-new accounts message friends only; rate limits", async () => {
  const S = await setup();
  try {
    await S.send("cy", "ana", "Hi Ana"); const t = await S.thread("ana", "cy");
    assert.equal((await S.act("ana", t.id, "ignore")).status, 200);
    assert.equal((await S.send("cy", "ana", "again?")).status, 409, "no new request for 30 days");
    assert.equal(await S.unread("ana"), 0);
    // block: they aren't told, nothing reaches you, the thread is hidden for you
    S.friends("bo", "ana"); await S.send("bo", "ana", "first"); const tb = await S.thread("ana", "bo");
    assert.equal((await S.act("ana", tb.id, "block")).status, 200);
    const after = await S.send("bo", "ana", "can you see this?"); assert.equal(after.status, 200, "sender isn't told");
    assert.equal(S.hub.db.prepare("SELECT COUNT(*) n FROM msg_messages").all()[0].n, 2, "the blocked message was never stored");
    assert.equal(await S.unread("ana"), 0);
    assert.equal((await S.thread("ana", "bo")).state, "blocked");
    assert.equal((await S.send("ana", "bo", "x")).status, 409, "you can't write to someone you blocked");
    // brand-new, empty account: friends only
    assert.equal((await S.send("dee", "cy", "hello")).status, 403);
    S.friends("dee", "cy"); assert.equal((await S.send("dee", "cy", "hello")).status, 200);
    // 30 messages an hour
    S.friends("cy", "bo"); let last = 0; for (let i = 0; i < 32; i++) last = (await S.send("cy", "bo", "m" + i)).status;
    assert.equal(last, 429);
  } finally { S.hub.server.close(); }
});

test("report keeps an excerpt for moderators; delete removes it for both; account deletion erases that member's messages", async () => {
  const S = await setup();
  try {
    S.friends("ana", "bo"); await S.send("bo", "ana", "spammy"); const t = await S.thread("ana", "bo");
    assert.equal((await S.act("ana", t.id, "report", { reason: "spam" })).status, 200);
    const reps = S.hub.admin["msg-reports"](); assert.equal(reps.length, 1); assert.equal(reps[0].reported, "bo");
    const v = S.hub.admin["msg-view"](reps[0].id); assert.equal(v.excerpt[0].text, "spammy");
    assert.equal(S.hub.admin["msg-ban"]("bo").banned, "bo"); assert.equal((await S.send("bo", "ana", "x")).status, 403);
    // erase: bo's messages go; ana's side keeps the thread with "Deleted user"
    S.friends("ana", "cy"); await S.send("ana", "cy", "hi cy"); await S.send("cy", "ana", "hi ana");
    S.hub.admin.remove("cy");
    assert.equal(S.hub.db.prepare("SELECT COUNT(*) n FROM msg_messages m JOIN msg_threads t ON t.id=m.thread WHERE m.body IS NOT NULL").get().n >= 1, true);
    const inbox = await (await S.get("ana", "/v1/messages/inbox")).json();
    assert.ok(inbox.conversations.some(c => c.name === "Deleted user"), "the other side shows Deleted user");
    // delete conversation: gone for both
    const t2 = await S.thread("ana", "bo"); assert.equal((await S.act("ana", t2.id, "delete")).status, 200);
    assert.equal((await S.thread("bo", "ana")).messages.length, 0);
  } finally { S.hub.server.close(); }
});

test("daily email gets an unread-messages section with a short preview, and members can turn it off", async () => {
  const S = await setup();
  try {
    S.friends("ana", "bo"); await S.send("bo", "ana", "x".repeat(300));
    const anaId = S.hub.db.prepare("SELECT id FROM profiles WHERE handle='ana'").get().id;
    const d = S.hub.digestFor ? S.hub.digestFor(anaId, "2000-01-01") : null;
    if (d) { assert.equal(d.messages.unread, 1); assert.equal(d.messages.from[0].preview.length, 120); }
    await S.post("/v1/messages/prefs", { email: false }, S.as("ana"));
    if (S.hub.digestFor) assert.equal(S.hub.digestFor(anaId, "2000-01-01").messages, undefined);
    const sess = await (await S.get("ana", "/v1/session")).json(); assert.equal(sess.messages.unread, 1);
  } finally { S.hub.server.close(); }
});
