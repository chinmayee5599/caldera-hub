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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-comments-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const w of who) {
    const m = C.sign(ids[w], "profile.manifest", { name: w.toUpperCase(), handle: w, boxKey: ids[w].boxPublic, ...MANIFEST[w] });
    await post(`/v1/profiles/${ids[w].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${w.toUpperCase()}</h1><p class="lede">${MANIFEST[w].headline}</p></body></html>`).toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });


const get = async (p, w) => { const r = await fetch(base + p, { headers: w ? { cookie: await ownerCookie(w) } : {} }); return { status: r.status, text: await r.text() }; };

test("threaded comments: post, reply, nest, notify, delete, moderate", async () => {
  const p = await as("ana", "/v1/posts", { type: "someone", text: "a designer for a social app built with TypeScript" });
  assert.equal(p.status, 200); const pid = p.body.post.id;
  assert.equal((await post(`/v1/posts/${pid}/comments`, { text: "hi there" }, ORIGIN)).status, 401, "signed out can't comment");
  assert.equal((await as("hid", `/v1/posts/${pid}/comments`, { text: "unlisted here" })).status, 403, "unlisted members can't comment");
  assert.equal((await as("bo", `/v1/posts/${pid}/comments`, { text: " " })).status, 400, "empty refused");
  const c1 = await as("bo", `/v1/posts/${pid}/comments`, { text: "I'm a designer <script>x</script>\n\n\n\nhttps://bo.example.com" });
  assert.equal(c1.status, 200); assert.equal(c1.body.count, 1);
  assert.doesNotMatch(c1.body.html, /<script>/, "markup stripped");
  assert.match(c1.body.html, /href="https:\/\/bo\.example\.com" target="_blank" rel="noopener noreferrer nofollow ugc"/, "links are nofollow ugc");
  assert.equal((await as("bo", `/v1/posts/${pid}/comments`, { text: "I'm a designer x\n\nhttps://bo.example.com" })).status, 409, "exact repeat refused");
  // reply chain: ana -> bo's comment, then nesting past the cap joins the deepest level
  const r1 = await as("ana", `/v1/posts/${pid}/comments`, { text: "Great, tell me more", parent: c1.body.id });
  assert.equal(r1.body.parent, c1.body.id);
  let last = r1.body.id;
  for (let i = 0; i < 4; i++) { const r = await as(i % 2 ? "ana" : "bo", `/v1/posts/${pid}/comments`, { text: "deeper " + i, parent: last }); assert.equal(r.status, 200); last = r.body.id; }
  const t = await (await fetch(`${base}/v1/posts/${pid}/comments`)).json();
  assert.equal(t.count, 6); assert.equal(t.comments.length, 1, "one top-level comment");
  let d = 0, n = t.comments[0]; while (n.replies.length) { n = n.replies[n.replies.length - 1]; d++; }
  assert.equal(d, 4, "nesting capped at 4 levels");
  assert.equal(t.comments[0].replies[0].replies[0].replies[0].replies.length, 2, "reply to the deepest level sits beside it");
  // reply to a missing / other post's comment
  const p2 = await as("cy", "/v1/posts", { type: "feedback", text: "feedback on my trading bot dashboard please" });
  assert.equal((await as("bo", `/v1/posts/${p2.body.post.id}/comments`, { text: "wrong thread", parent: c1.body.id })).status, 404);
  // the post page shows the thread server-side, to everyone (search engines too)
  const pg = await get(`/feed/p/${pid}`);
  assert.match(pg.text, /id="comments"/); assert.match(pg.text, /6 comments/); assert.match(pg.text, /Great, tell me more/); assert.match(pg.text, /Sign in with GitHub<\/a> to comment/);
  const feedHtml = await get("/feed", "cy");
  assert.match(feedHtml.text, /data-refresh data-type="all"/, "refresh button at the top");
  assert.match(feedHtml.text, /data-comments[^>]*>&#128172; <span data-ccount>6<\/span>/, "feed card shows the count");
  // permissions: cy can't delete bo's comment; ana (post author) can remove it, which leaves a stub because it has replies
  assert.equal((await as("cy", `/v1/comments/${c1.body.id}/delete`, {})).status, 404);
  assert.equal((await as("cy", `/v1/comments/${c1.body.id}/report`, { reason: "spam" })).status, 200);
  const del = await as("ana", `/v1/comments/${c1.body.id}/delete`, {});
  assert.equal(del.body.state, "deleted"); assert.equal(del.body.count, 5);
  const t2 = await (await fetch(`${base}/v1/posts/${pid}/comments`)).json();
  assert.equal(t2.comments[0].deleted, true); assert.equal(t2.comments[0].text, ""); assert.equal(t2.comments[0].author, null);
  // a leaf goes completely
  const leaf = t2.comments[0].replies[0].replies[0].replies[0].replies[1].id;
  const dl = await as("ana", `/v1/comments/${leaf}/delete`, {}); assert.equal(dl.body.state, "removed"); assert.equal(dl.body.count, 4);
  // notifications reached the bell
  const al = await (await fetch(`${base}/v1/owner/${ids.ana.id}/alerts`, { headers: { authorization: "Bearer " + await login(ids.ana) } })).json();
  assert.ok(al.alerts.some(a => /@bo commented on your post/.test(a.title)), "post author told");
  const bl = await (await fetch(`${base}/v1/owner/${ids.bo.id}/alerts`, { headers: { authorization: "Bearer " + await login(ids.bo) } })).json();
  assert.ok(bl.alerts.some(a => /@ana replied to your comment/.test(a.title)), "comment author told about the reply");
  // deleting the post takes its comments
  const pd = await as("ana", `/v1/posts/${pid}/delete`, {}); assert.equal(pd.status, 200, JSON.stringify(pd.body));
  assert.equal((await fetch(`${base}/v1/posts/${pid}/comments`)).status, 404);
});
