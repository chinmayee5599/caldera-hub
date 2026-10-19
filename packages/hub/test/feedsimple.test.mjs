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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-feedsimple-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  for (const w of who) {
    const m = C.sign(ids[w], "profile.manifest", { name: w.toUpperCase(), handle: w, boxKey: ids[w].boxPublic, ...MANIFEST[w] });
    await post(`/v1/profiles/${ids[w].id}/bundle`, { manifest: m, files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${w.toUpperCase()}</h1><p class="lede">${MANIFEST[w].headline}</p></body></html>`).toString("base64") } });
  }
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("simple composer: one choice + free text; link lifted out; recommendations need a link; tags read from the text", async () => {
  assert.equal((await as("bo", "/v1/posts", { type: "nope", text: "a designer for my app" })).status, 400, "unknown kinds refused");
  assert.equal((await as("bo", "/v1/posts", { type: "someone", text: "hi" })).status, 400, "too short");
  assert.equal((await as("bo", "/v1/posts", { type: "recommend", rec: "tool", text: "Claude Code is the best coding agent I've used" })).status, 400, "tools need a link");
  assert.equal((await as("bo", "/v1/posts", { type: "recommend", rec: "tool", text: "Great tool http://example.com/x for agents" })).status, 400, "https only");
  const a = await as("bo", "/v1/posts", { type: "someone", text: "a co-founder for a social features app built with <b>TypeScript</b>" });
  assert.equal(a.status, 200);
  assert.match(a.body.post.text, /^@bo is looking for someone: a co-founder for a social features app built with TypeScript\.$/);
  assert.doesNotMatch(a.body.html, /<b>/, "markup stripped");
  assert.ok(a.body.post.fields.simple && a.body.post.fields.audience.map(x => String(x).toLowerCase()).includes("social features"), "topic tag read from the text");
  assert.ok(Array.isArray(a.body.matches), "matches panel after posting");
  const r = await as("cy", "/v1/posts", { type: "recommend", rec: "tool", text: "Claude Code - best coding agent I've used https://claude.com/claude-code." });
  assert.equal(r.status, 200);
  assert.equal(r.body.post.fields.link, "https://claude.com/claude-code", "first https link, trailing period dropped");
  assert.equal(r.body.post.fields.name, "Claude Code");
  assert.match(r.body.post.text, /^@cy recommends: Claude Code - best coding agent I've used\.$/, "link lifted out of the sentence");
  assert.match(r.body.html, /class="fd-link" href="https:\/\/claude.com\/claude-code" target="_blank"/, "link chip opens in a new window");
  const feedHtml = await (await fetch(base + "/feed", { headers: { cookie: await ownerCookie("mike") } })).text();
  assert.match(feedHtml, /data-fam="ask"[\s\S]*I need\.\.\.[\s\S]*data-fam="rec"[\s\S]*I recommend\.\.\./, "two big choices");
  assert.match(feedHtml, /data-kind="someone"[\s\S]*data-kind="recommend:model"/, "tappable chips");
  assert.doesNotMatch(feedHtml.slice(feedHtml.indexOf("fd-comp"), feedHtml.indexOf("fd-match")), /<select/, "no dropdown");
  assert.doesNotMatch(feedHtml, /name="commitment"|name="role"|data-family/, "no sub-fields");
  for (const [, js] of feedHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(js), "the page's script compiles");
  const anon = await (await fetch(base + "/feed")).text();
  for (const [, js] of anon.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(js), "the signed-out page's script compiles");
});

test("own posts: ... menu with Close and Delete (inline confirm); delete takes the post's notices; authors only", async () => {
  const r = await as("ana", "/v1/posts", { type: "feedback", text: "honest feedback on my onboarding flow please" });
  assert.equal(r.status, 200); const id = r.body.post.id;
  assert.match(r.body.html, /data-own[\s\S]*data-close[\s\S]*data-delete[\s\S]*Delete this post\?[\s\S]*data-yes/, "menu with inline confirm");
  assert.equal((await as("bo", "/v1/posts/" + id + "/kudos", { kind: "fire" })).status, 200);
  const n = () => hub.db.prepare("SELECT COUNT(*) n FROM alerts WHERE cta_url LIKE ?").get(`%/feed/p/${id}%`).n;
  assert.ok(n() >= 1, "the author got a kudos notice");
  assert.equal((await as("bo", "/v1/posts/" + id + "/delete", {})).status, 404, "not the author");
  assert.equal((await as("ana", "/v1/posts/" + id + "/delete", {})).status, 200);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM posts WHERE id=?").get(id).n, 0);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM post_kudos WHERE post=?").get(id).n, 0);
  assert.equal(n(), 0, "its notices are gone");
});

test("profile activity card: posts then activity, one at a time; owner gets Close/Delete via the owner token; visitors can't delete", async () => {
  const anon = await (await fetch(base + "/@cy/")).text();
  assert.match(anon, /class="pc"[\s\S]*Posts &amp; activity[\s\S]*1 \/ \d+/, "card with a counter");
  assert.match(anon, /recommends: Claude Code/, "their post is in it");
  assert.match(anon, /\/feed\?author=cy/, "See all in Feed");
  assert.doesNotMatch(anon, /pc-dots" data-own/, "visitors get no owner menu");
  for (const [, js] of anon.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(js), "scripts compile");
  const ownHtml = await (await fetch(base + "/@cy/", { headers: { cookie: await ownerCookie("cy") } })).text();
  assert.match(ownHtml, /pc-dots" data-own[\s\S]*Delete this post\?/, "owner menu");
  const tok = ownHtml.match(/class="pc"[^>]*data-act="([^"]+)"/)[1], pid = ownHtml.match(/class="pc-item" data-post="([0-9a-f]{12})"/)[1];
  const visitorHtml = await (await fetch(base + "/@cy/", { headers: { cookie: await ownerCookie("bo") } })).text();
  const vtok = visitorHtml.match(/class="pc"[^>]*data-act="([^"]+)"/)[1];
  const act = (t, o) => fetch(base + "/v1/act", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ t, ...o }) }).then(r => r.status);
  assert.equal(await act(vtok, { action: "post-delete", post: pid }), 403, "a visitor's token can't delete");
  assert.equal(await act(vtok, { action: "post-kudos", post: pid, kind: "heart" }), 200, "a visitor can send kudos from the card");
  assert.equal(await act(tok, { action: "post-close", post: pid }), 200, "owner closes");
  assert.equal(hub.db.prepare("SELECT status FROM posts WHERE id=?").get(pid).status, "closed");
  assert.equal(await act(tok, { action: "post-delete", post: pid }), 200, "owner deletes");
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM posts WHERE id=?").get(pid).n, 0);
  const feed = await (await fetch(base + "/feed?author=bo")).text();
  assert.match(feed, /Showing posts and activity from <a href="\/@bo\/">@bo<\/a>/);
  assert.doesNotMatch(feed, /@cy is looking|>CY<\/a> recommends/, "only bo's items");
});

test("feed rail: people you might know, with one-tap Follow; followed people drop off; hidden and signed-out get none", async () => {
  const page = async w => (await fetch(base + "/feed", { headers: w ? { cookie: await ownerCookie(w) } : {} })).text();
  const rail = html => (html.match(/<aside class="fd-rail">([\s\S]*?)<\/aside>/) || [])[1] || "";
  const html = await page("ana"), r = rail(html);
  assert.match(r, /People you might know/);
  assert.match(r, /data-follow="mike"/, "suggests members with a Follow button");
  assert.doesNotMatch(r, /data-follow="(ana|hid)"/, "never yourself or an unlisted member");
  assert.match(html, /class="fd-card fd-people fd-people-top"/, "the same list sits above the feed on phones");
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(js), "the page's scripts compile");
  const f = await as("ana", "/v1/friend/mike", {});
  assert.equal(f.status, 200);
  assert.doesNotMatch(rail(await page("ana")), /data-follow="mike"/, "someone you follow is no longer suggested");
  assert.doesNotMatch(await page(null), /<aside class="fd-rail">|aria-label="People you might know"/, "signed-out visitors get no rail");
  assert.doesNotMatch(await (await fetch(base + "/feed?author=bo", { headers: { cookie: await ownerCookie("ana") } })).text(), /<aside class="fd-rail">/, "one member's posts: no rail");
});
