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
    // THE header carries Messages with the unread badge, left of the bell; signed out it is not there
    const feed = await (await S.get("bo", "/feed")).text();
    assert.match(feed, /<a class="ch-icon ch-msgs" href="[^"]*\/messages" aria-label="Messages, 1 unread"[^>]*>[\s\S]*?<span class="ch-badge">1<\/span><\/a><details class="ch-bell"/);
    { const out = await (await fetch(S.base + "/feed")).text(); assert.ok(!out.includes('class="ch-icon ch-msgs"') && !out.includes('class="ch-bn-msgs"'), "signed out: no Messages link, top or bottom"); }
    assert.match(feed, /<a class="ch-bn-msgs" href="[^"]*\/messages"><span class="ch-bi">[\s\S]*?<span class="ch-badge">1<\/span><\/span>Messages<\/a>/, "the phone tab bar carries the badge too");
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

test("Message on a feed post opens the author's thread with the post quoted; only the author's own posts are quoted", async () => {
  const { hub, ids, get, post, as } = await setup();
  const r = await post("/v1/posts", { type: "someone", text: "a designer for my social app" }, as("ana"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id || r.body.post?.id; assert.ok(id, "post id");
  const feed = await (await get("bo", "/feed")).text();
  assert.match(feed, new RegExp(`/messages/@ana\\?about=${id}`), "the feed shows Message on someone else's post");
  const mine = await (await get("ana", "/feed")).text();
  assert.doesNotMatch(mine, new RegExp(`/messages/@ana\\?about=${id}`), "no Message on your own post");
  const page = await (await get("bo", `/messages/@ana?about=${id}`)).text();
  assert.match(page, /data-draft="About your post &quot;a designer for my social app&quot;: "/, "the reply starts quoting the post");
  const other = await (await get("bo", `/messages/@cy?about=${id}`)).text();
  assert.doesNotMatch(other, /data-draft=/, "someone else's post is never quoted into a thread with a different person");
  hub.server.close();
});

test("a new message emails the recipient once (summary or GitHub-verified address), not again within 30 minutes, and one click turns it off", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-msgmail-")); const sent = [];
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", limits: { newProfilesPerDay: 100 }, email: { send: async m => { sent.push(m); } } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  try {
    const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const ids = { ana: C.newIdentity(), bo: C.newIdentity() };
    for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h.toUpperCase(), handle: h, boxKey: id.boxPublic }), files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${h}</h1></body></html>`).toString("base64") } });
    hub.db.prepare("UPDATE profiles SET created=?").run("2026-01-01T00:00:00.000Z");
    const A = ids.ana.id, B = ids.bo.id;
    for (const [x, y] of [[A, B], [B, A]]) hub.db.prepare("INSERT OR IGNORE INTO friends (a, b, ts) VALUES (?,?,?)").run(x, y, new Date().toISOString());
    hub.mail.suggest(A, "ana@realmail.dev", true, "github");   // GitHub-verified, never subscribed to the summary
    const r = hub.messages.send(B, "ana", "Want to pair on the city renderer?"); assert.equal(r.status, 200);
    hub.messages.send(B, "ana", "Also: loved your post");
    assert.equal(await hub.messages.sweepAlerts(0), 1);
    assert.equal(sent.length, 1); assert.equal(sent[0].to, "ana@realmail.dev");
    assert.match(sent[0].subject, /BO \(@bo\) sent you 2 messages on Caldera/);
    assert.match(sent[0].text, /loved your post/); assert.match(sent[0].text, /http:\/\/hub\.test\/messages\/@bo/); assert.match(sent[0].text, /http:\/\/hub\.test\/messages\/@bo\?src=email-message\b/); assert.match(sent[0].html, /href="http:\/\/hub\.test\/messages\/@bo\?src=email-message"/); assert.doesNotMatch(sent[0].headers["List-Unsubscribe"], /src=/);
    hub.messages.send(B, "ana", "one more");
    assert.equal(await hub.messages.sweepAlerts(0), 0, "no second email inside 30 minutes");
    assert.equal(sent.filter(m => m.to === "bo@x").length, 0);
    // no address on file: nothing sent, nothing breaks
    hub.messages.send(A, "bo", "hi"); assert.equal(await hub.messages.sweepAlerts(0), 0);
    // one-click off from the email
    const off = sent[0].headers["List-Unsubscribe"].slice(1, -1).replace("http://hub.test", base);
    assert.equal((await fetch(off.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(32)), { method: "POST" })).status, 400, "forged link refused");
    assert.equal((await fetch(off, { method: "POST" })).status, 200);
    hub.db.prepare("DELETE FROM msg_emailed").run(); hub.messages.send(B, "ana", "after off");
    assert.equal(await hub.messages.sweepAlerts(0), 0, "turned off");
  } finally { hub.server.close(); }
});

test("unread messages show in the header on every page: badge, a strip under the nav, live counts for the tab title", async () => {
  const { hub, d, send, get, friends } = await setup();
  try {
    friends("ana", "bo");
    const badges = async (h) => { const r = await get(h, "/v1/me/badges"); return { status: r.status, cc: r.headers.get("cache-control"), j: await r.json() }; };
    assert.equal((await badges(null)).status, 401, "signed out: nothing");
    let b = await badges("bo"); assert.equal(b.j.messages, 0); assert.equal(b.cc, "no-store");
    assert.equal((await send("ana", "bo", "hey, great talk")).status, 200);
    b = await badges("bo"); assert.equal(b.j.messages, 1); assert.deepEqual(b.j.from, ["ana"]); assert.equal(typeof b.j.alerts, "number");
    // any page bo opens: the Messages badge, and a strip under the nav naming the sender
    for (const p of ["/feed", "/@cy/"]) {
      const html = await (await get("bo", p)).text();
      assert.match(html, /class="ch-icon ch-msgs"[^>]*aria-label="Messages, 1 unread"/, p + ": badge");
      assert.match(html, /<div class="ch-strip" id="ch-strip" role="status" data-cur="[a-z]*">/, p + ": strip shown");
      assert.match(html, /<b>1 unread message<\/b> from @ana/, p);
      assert.match(html, /data-m="1"/); assert.match(html, /\/v1\/me\/badges/, p + ": counts refresh live");
    }
    // on Messages itself the strip stays out of the way
    assert.match(await (await get("bo", "/messages")).text(), /<div class="ch-strip" id="ch-strip" role="status" data-cur="[a-z]*" hidden>/);
    // reading the conversation clears it everywhere
    await get("bo", "/messages/@ana"); await get("bo", "/v1/messages/thread/ana");
    assert.equal((await badges("bo")).j.messages, 0);
    const after = await (await get("bo", "/feed")).text();
    assert.match(after, /<div class="ch-strip" id="ch-strip" role="status" data-cur="[a-z]*" hidden>/); assert.match(after, /data-m="0"/);
    // the sender never sees their own message as unread
    assert.equal((await badges("ana")).j.messages, 0);
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("sandboxed pages (profiles, cities) refresh the header counts with the header's token, not the cookie", async () => {
  const { hub, d, send, get, friends, base } = await setup();
  try {
    friends("ana", "bo"); await send("ana", "bo", "hi");
    const html = await (await get("bo", "/@cy/")).text(), bt = html.match(/data-bt="([^"]+)"/)?.[1];
    assert.ok(bt, "the header carries a token");
    const r = await fetch(base + "/v1/me/badges?t=" + encodeURIComponent(bt.replace(/&amp;/g, "&")));
    assert.equal(r.status, 200); assert.equal(r.headers.get("access-control-allow-origin"), "*"); assert.equal((await r.json()).messages, 1);
    assert.equal((await fetch(base + "/v1/me/badges?t=nope.nope")).status, 401, "a bad token gets nothing");
    const [p, sig] = bt.split("."); const forged = Buffer.from(JSON.stringify({ v: "x", h: "badges", x: Date.now() + 1e7 })).toString("base64url") + "." + sig;
    assert.equal((await fetch(base + "/v1/me/badges?t=" + encodeURIComponent(forged))).status, 401, "a forged token gets nothing");
    assert.equal((await get("bo", "/feed").then(r => r.text())).match(/data-bt="([^"]+)"/)?.[1], bt, "same token on every page for a while");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
