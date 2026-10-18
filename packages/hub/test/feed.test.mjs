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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-feed-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const w of who) {
    const m = C.sign(ids[w], "profile.manifest", { name: w.toUpperCase(), handle: w, boxKey: ids[w].boxPublic, ...MANIFEST[w] });
    await post(`/v1/profiles/${ids[w].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body><p>hi</p></body></html>").toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("posting: members only, same-origin only, every field validated server-side, text only", async () => {
  assert.equal((await post("/v1/posts", ASK, ORIGIN)).status, 401, "anonymous can't post");
  assert.equal((await as("ana", "/v1/posts", ASK, { origin: "https://evil.example" })).status, 403, "cross-site refused");
  assert.equal((await as("ana", "/v1/posts", { ...ASK, type: "spam" })).status, 400);
  assert.equal((await as("ana", "/v1/posts", { ...ASK, role: "a wizard" })).status, 400, "only listed roles");
  assert.equal((await as("ana", "/v1/posts", { ...ASK, commitment: "free beer" })).status, 400);
  assert.equal((await as("ana", "/v1/posts", { type: "feedback", kind: "ux", link: "javascript:alert(1)", detail: "please look at my app" })).status, 400, "only http(s) links");
  assert.equal((await as("ana", "/v1/posts", { type: "code", what: "short" })).status, 400, "too short");
  const r = await as("ana", "/v1/posts", { ...ASK, detail: "<img src=x onerror=alert(1)>Need <b>help</b> with TypeScript agents" + "x".repeat(400) });
  assert.equal(r.status, 200);
  assert.ok(r.body.post.detail.length <= 280, "capped at 280");
  assert.doesNotMatch(r.body.html, /<img|<b>|onerror/, "markup stripped");
  assert.match(r.body.post.text, /^@ana is looking for a co-founder \(equity\) for AI agents\.$/);
  assert.equal((await as("ana", "/v1/posts", ASK)).status, 409, "one open post per kind of ask");
});

test("rate limit: 3 posts a day per member", async () => {
  const kinds = [{ type: "code", what: "A parser for Obsidian vault links", stack: ["TypeScript"] }, { type: "feedback", kind: "ux", detail: "Is the onboarding clear enough?" }, { type: "clients", offer: "An AI inbox", stage: "beta" }];
  const s = [];
  for (const k of kinds) s.push((await as("bo", "/v1/posts", k)).status);
  assert.deepEqual(s, [200, 200, 200]);
  const fourth = await as("bo", "/v1/posts", { type: "other", detail: "Anyone in LA this week?" });
  assert.equal(fourth.status, 429); assert.match(fourth.body.error, /3 posts today/);
});

test("matching: structured fields first; never unlisted members or the author; the author only", async () => {
  const pid = hub.db.prepare("SELECT id FROM posts WHERE type='someone'").get().id;
  assert.equal((await fetch(`${base}/v1/posts/${pid}/matches`, { headers: { cookie: await ownerCookie("bo") } })).status, 404, "only the author sees matches");
  const m = (await (await fetch(`${base}/v1/posts/${pid}/matches`, { headers: { cookie: await ownerCookie("ana") } })).json()).matches;
  const hs = m.map(x => x.handle);
  assert.ok(!hs.includes("ana"), "not the author"); assert.ok(!hs.includes("hid"), "never unlisted members");
  assert.equal(hs[0], "mike", "a founder into AI agents: best match for a co-founder");
  assert.match(m[0].why, /ai agents/i);
});

test("sending: double opt-in; caps; no repeats; accept connects them", async () => {
  const pid = hub.db.prepare("SELECT id FROM posts WHERE type='someone'").get().id;
  assert.equal((await as("bo", `/v1/posts/${pid}/send`, { to: ["mike"] })).status, 404, "only the author sends");
  const r = await as("ana", `/v1/posts/${pid}/send`, { to: ["mike", "hid", "ana", "mike"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map(x => [x.handle, x.state]), [["mike", "sent"], ["hid", "unknown"], ["ana", "unknown"]]);
  const again = await as("ana", `/v1/posts/${pid}/send`, { to: ["mike"] });
  assert.equal(again.body.results[0].state, "sent"); assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM post_links WHERE post=? AND kind='send'").get(pid).n, 1, "no repeat");
  const notices = await (await fetch(`${base}/v1/me/notices`, { headers: { cookie: await ownerCookie("mike") } })).json();
  assert.equal(notices.waiting.length, 1); assert.match(notices.waiting[0].text, /@ana is looking for a co-founder/);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM friends WHERE a=? AND b=?").get(ids.mike.id, ids.ana.id).n, 0, "not friends until they accept");
  const bell = hub.db.prepare("SELECT title, cta_url FROM alerts WHERE target=?").all(ids.mike.id);
  assert.ok(bell.some(x => /@ana sent you a post: you match/.test(x.title) && x.cta_url === `/feed/p/${pid}`), "the recipient's bell has it");
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM alerts WHERE target=?").get(ids.cy.id).n, 0, "nobody else's");
  assert.equal((await as("mike", `/v1/posts/${pid}/answer`, { from: "ana", yes: true })).body.state, "friends");
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM friends WHERE a=? AND b=?").get(ids.mike.id, ids.ana.id).n, 1);
  // the 10-per-post cap
  hub.db.prepare("UPDATE post_links SET kind='send' WHERE post=?").run(pid);
  for (let i = 0; i < 9; i++) hub.db.prepare("INSERT INTO post_links VALUES (?,?,?,?,?,?,?)").run(pid, ids.ana.id, "x" + i, "send", "sent", new Date().toISOString(), null);
  const capped = await as("ana", `/v1/posts/${pid}/send`, { to: ["cy"] });
  assert.equal(capped.body.results[0].state, "limit");
});

test("post kudos: members only, not your own, one per post per day; the author hears about it", async () => {
  const pid = hub.db.prepare("SELECT id FROM posts WHERE type='someone'").get().id;
  assert.equal((await post(`/v1/posts/${pid}/kudos`, { kind: "fire" }, ORIGIN)).status, 401);
  assert.equal((await as("ana", `/v1/posts/${pid}/kudos`, { kind: "fire" })).status, 400, "not your own post");
  assert.equal((await as("cy", `/v1/posts/${pid}/kudos`, { kind: "poop" })).status, 400);
  assert.equal((await as("cy", `/v1/posts/${pid}/kudos`, { kind: "fire" })).status, 200);
  assert.equal((await as("cy", `/v1/posts/${pid}/kudos`, { kind: "heart" })).status, 409, "once a day per post");
  const n = await (await fetch(`${base}/v1/me/notices`, { headers: { cookie: await ownerCookie("ana") } })).json();
  assert.equal(n.kudos[0].from.handle, "cy"); assert.equal(n.kudos[0].emoji, "\u{1F525}");
  await as("mike", `/v1/posts/${pid}/kudos`, { kind: "up" });
  const kb = hub.db.prepare("SELECT title FROM alerts WHERE target=? AND dkey LIKE 'pk:%'").all(ids.ana.id);
  assert.equal(kb.length, 1, "kudos on one post fold into one unread alert"); assert.match(kb[0].title, /2 people sent kudos on your post today/);
});

test("feed privacy: unlisted members and founder auto-links never appear; filters work", async () => {
  await as("hid", "/v1/posts", { type: "other", detail: "This should never show in the feed" });
  const all = await (await fetch(`${base}/v1/feed`)).json();
  const text = JSON.stringify(all);
  assert.doesNotMatch(text, /"hid"|never show/, "unlisted member's join and post are hidden");
  assert.ok(all.items.some(i => i.kind === "join" && i.who.handle === "ana"));
  assert.ok(all.items.some(i => i.kind === "post"));
  assert.ok(all.items.some(i => i.kind === "friends"), "the real friendship (accepted) shows");
  const posts = await (await fetch(`${base}/v1/feed?type=posts`)).json();
  assert.ok(posts.items.length && posts.items.every(i => i.kind === "post"));
  const members = await (await fetch(`${base}/v1/feed?type=members`)).json();
  assert.ok(members.items.every(i => i.kind === "join" || i.kind === "obsidian"));
  const html = await (await fetch(`${base}/feed`)).text();
  assert.match(html, /Sign in with GitHub to post/); assert.doesNotMatch(html, /never show/);
  const mine = await (await fetch(`${base}/feed`, { headers: { cookie: await ownerCookie("mike") } })).text();
  assert.match(mine, /I need\.\.\./); assert.match(mine, /I recommend\.\.\./);
});

test("share: permalink with og tags + a text-only card; the sharer's invite carries through sign-up", async () => {
  const pid = hub.db.prepare("SELECT id FROM posts WHERE type='someone'").get().id;
  const anon = await (await fetch(`${base}/feed/p/${pid}?invite=mike`)).text();
  assert.match(anon, /property="og:title" content="@ana is looking for a co-founder/);
  assert.match(anon, new RegExp(`og:image" content="https://hub.test/feed/p/${pid}.png`));
  assert.match(anon, /MIKE<\/b> shared this with you/);
  assert.match(anon, new RegExp(`/auth/github\\?invite=mike&(amp;)?back=%2Ffeed%2Fp%2F${pid}`), "sign-up credits the sharer and comes back to the post");
  const a = await fetch(`${base}/auth/github?invite=mike&back=${encodeURIComponent("/feed/p/" + pid)}`, { redirect: "manual" });
  const set = (a.headers.getSetCookie?.() || []).join(";");
  if (a.status === 302 && /github\.com/.test(a.headers.get("location") || "")) {
    assert.match(set, /cal_inv=mike/); assert.match(set, new RegExp(`cal_back=%2Ffeed%2Fp%2F${pid}`));
  }
  assert.equal((await fetch(`${base}/feed/p/${pid}?invite=hid`)).status, 200);
  assert.doesNotMatch(await (await fetch(`${base}/feed/p/${pid}?invite=hid`)).text(), /shared this with you/, "unlisted sharers aren't named");
  assert.equal((await fetch(`${base}/feed/p/000000000000`)).status, 404);
});

// link policy (shorteners, new-account limits) and ranking are the private matcher's: tested in caldera-private
test("moderation: report, hide, ban; deleting a profile takes its posts", async () => {
  const pid = hub.db.prepare("SELECT id FROM posts WHERE type='someone'").get().id;
  assert.equal((await as("cy", `/v1/posts/${pid}/report`, { reason: "spam" })).status, 200);
  assert.equal(hub.admin["post-list"]()[0].reports, 1);
  hub.admin["post-hide"](pid);
  assert.equal((await fetch(`${base}/feed/p/${pid}`)).status, 404);
  hub.admin["post-ban"]("bo", "spam");
  assert.equal((await as("bo", "/v1/posts", { type: "other", detail: "Trying to post again" })).status, 403);
  hub.admin.remove("ana", "test");
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM posts WHERE author=?").get(ids.ana.id).n, 0);
});
