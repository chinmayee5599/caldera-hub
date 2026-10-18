import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// inline kudos + Add friend on hosted pages, and the new-window rule for off-site links
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const UA = { "user-agent": "Mozilla/5.0" };
const PAGE = `<html><head></head><body><nav><a class="tree-row friend-row" href="obsidian://caldera?friend=HANDLE" target="_blank" rel="noopener">+ Add @HANDLE as friend</a></nav>
<table><tr><td><a href="https://github.com/x/proj">proj</a></td><td><a href="http://hub.test/@other/">in</a></td><td><a href="#top">top</a></td></tr></table></body></html>`;

async function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-inline-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const fake = async (u) => { u = String(u);
    if (u.endsWith("/access_token")) return J({ access_token: "tok", expires_in: 28800 });
    if (u.endsWith("/user")) return J({ id: 99, login: "gina", name: "Gina", created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/gina", avatar_url: "https://avatars.githubusercontent.com/u/1" });
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const ids = { ana: C.newIdentity(), bo: C.newIdentity(), cy: C.newIdentity() };
  for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h, handle: h, boxKey: id.boxPublic }), files: { "index.html": Buffer.from(PAGE.replaceAll("HANDLE", h)).toString("base64") } });
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const ownerCookie = async (id) => { const { body } = await post(`/v1/owner/${id.id}/link`, {}, { authorization: "Bearer " + await login(id) });
    const r = await fetch(body.url.replace("http://hub.test", base), { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; };
  const page = (h, cookie) => fetch(`${base}/@${h}/`, { headers: { ...UA, ...(cookie ? { cookie } : {}) } });
  const act = (t, action, kind) => fetch(base + "/v1/act", { method: "POST", headers: { "content-type": "text/plain", origin: "null" }, body: JSON.stringify({ t, action, kind }) }).then(async r => ({ status: r.status, body: await r.json(), acao: r.headers.get("access-control-allow-origin") }));
  const tokenIn = (html) => (html.match(/data-act="([^"]+)"/) || [])[1];
  return { hub, d, base, post, ids, login, ownerCookie, page, act, tokenIn };
}

test("members get an action token for that page only; inline kudos works from a sandboxed page; forgery, expiry and recipient swap refused", async () => {
  const S = await setup();
  try {
    const anaC = await S.ownerCookie(S.ids.ana);
    const anon = await (await S.page("bo")).text();
    assert.equal(S.tokenIn(anon), undefined, "no token for anonymous viewers");
    assert.match(anon, /href="http:\/\/hub\.test\/kudos\/bo" data-caldera-friend="bo" data-state="none"/, "obsidian:// add-friend link rewritten");
    assert.doesNotMatch(anon, /obsidian:\/\/caldera\?friend=/);
    const r = await S.page("bo", anaC), html = await r.text(), t = S.tokenIn(html);
    assert.ok(t, "member gets a token"); assert.match(r.headers.get("content-security-policy"), /^sandbox /); assert.match(r.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.doesNotMatch(r.headers.get("content-security-policy"), /allow-same-origin/);
    assert.match(html, /@ana</, "the bar shows who's signed in");
    // own page: no token, no add-friend link
    const own = await (await S.page("ana", anaC)).text();
    assert.equal(S.tokenIn(own), undefined); assert.doesNotMatch(own, /data-caldera-friend/);
    // anonymous can't act
    assert.equal((await S.act("", "kudos", "heart")).status, 401);
    // kudos with the token, Origin null, CORS open; once a day
    const k = await S.act(t, "kudos", "fire"); assert.equal(k.status, 200); assert.equal(k.acao, "*");
    assert.equal(S.hub.db.prepare("SELECT COUNT(*) n FROM kudos k JOIN profiles p ON p.id=k.recipient WHERE p.handle='bo'").get().n, 1);
    assert.equal((await S.act(t, "kudos", "heart")).status, 409, "one kudos per day");
    const again = await (await S.page("bo", anaC)).text();
    assert.match(again, /class="cb-k on" data-k="fire" disabled/, "already-sent shows disabled");
    // forgery: tampered payload (point the token at ana's own page or change the expiry) is refused
    const [p] = t.split("."), o = JSON.parse(Buffer.from(p, "base64url").toString());
    const swap = Buffer.from(JSON.stringify({ ...o, h: "ana" })).toString("base64url") + "." + t.split(".")[1];
    assert.equal((await S.act(swap, "kudos", "up")).status, 401, "recipient swap refused");
    assert.equal((await S.act(t.slice(0, -2) + "xx", "kudos", "up")).status, 401, "bad signature refused");
    assert.equal((await S.act(S.hub.act.token(S.ids.ana.id, "bo", -1000), "kudos", "up")).status, 401, "expired token refused");
    // a token minted for a deleted viewer stops working
    assert.equal((await S.act(S.hub.act.token("cal:nobody", "bo"), "kudos", "up")).status, 401);
  } finally { S.hub.server.close(); fs.rmSync(S.d, { recursive: true, force: true }); }
});

test("Add friend inline: Obsidian member's tap is queued, plugin picks it up and the hub clears it; GitHub member signs now; Friends state", async () => {
  const S = await setup();
  try {
    const anaC = await S.ownerCookie(S.ids.ana);
    const t = S.tokenIn(await (await S.page("bo", anaC)).text());
    const f = await S.act(t, "friend"); assert.equal(f.status, 200); assert.equal(f.body.state, "queued");
    assert.equal((await S.act(t, "friend")).body.state, "queued", "idempotent");
    assert.match(await (await S.page("bo", anaC)).text(), /data-state="queued"/);
    // the plugin: list intents (signed in), sign + send, intent cleared
    const tok = await S.login(S.ids.ana);
    const list = await fetch(S.base + `/v1/owner/${S.ids.ana.id}/intents`, { headers: { authorization: "Bearer " + tok } }).then(r => r.json());
    assert.deepEqual(list.intents.map(x => [x.handle, x.kind]), [["bo", "add"]]);
    assert.equal((await fetch(S.base + `/v1/owner/${S.ids.bo.id}/intents`, { headers: { authorization: "Bearer " + tok } })).status, 401, "only your own queue");
    assert.equal((await S.post("/v1/envelopes", C.sign(S.ids.ana, "friend.request", { to: S.ids.bo.id, note: "" }))).status, 200);
    assert.equal((await fetch(S.base + `/v1/owner/${S.ids.ana.id}/intents`, { headers: { authorization: "Bearer " + tok } }).then(r => r.json())).intents.length, 0, "cleared when the request lands");
    assert.match(await (await S.page("bo", anaC)).text(), /data-state="requested"/);
    // ana follows bo: bo sees "Follow back" on ana's page; following back -> friends
    const boC = await S.ownerCookie(S.ids.bo);
    const bt = S.tokenIn(await (await S.page("ana", boC)).text());
    assert.match(await (await S.page("ana", boC)).text(), /data-state="incoming"/);
    assert.equal((await S.act(bt, "accept")).body.state, "friends", "following back makes friends at once, Obsidian or not");
    const now = await (await S.page("ana", boC)).text();
    assert.match(now, /data-state="friends"/); assert.match(now, /Friends ✓/);
    // a GitHub sign-up (hub holds the key) adds a friend right away
    const a = await fetch(S.base + "/auth/github", { redirect: "manual" });
    const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    const cb = await fetch(S.base + `/auth/github/callback?code=x&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
    const sess = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).find(c => c.startsWith("cal_s="));
    const gt = S.tokenIn(await (await S.page("bo", sess)).text()); assert.ok(gt, "GitHub member gets a token");
    const g = await S.act(gt, "friend"); assert.equal(g.body.state, "requested");
    assert.equal(S.hub.db.prepare("SELECT COUNT(*) n FROM envelopes WHERE type='friend.request' AND recipient=?").get(S.ids.bo.id).n, 2);
    // cookie route from the hub's own pages: cross-site refused
    assert.equal((await fetch(S.base + "/v1/friend/bo", { method: "POST", headers: { cookie: anaC, origin: "https://evil.example" } })).status, 403);
  } finally { S.hub.server.close(); fs.rmSync(S.d, { recursive: true, force: true }); }
});

test("off-site links open in a new window on every hosted page; internal links untouched", async () => {
  const S = await setup();
  try {
    const html = await (await S.page("bo")).text();
    assert.match(html, /<a href="https:\/\/github.com\/x\/proj" target="_blank" rel="noopener noreferrer">proj<\/a>/);
    assert.match(html, /<a href="http:\/\/hub.test\/@other\/">in<\/a>/);
    assert.match(html, /<a href="#top">top<\/a>/);
    assert.equal((await fetch(S.base + "/friend/bo", { redirect: "manual" })).headers.get("location"), "/kudos/bo");
  } finally { S.hub.server.close(); fs.rmSync(S.d, { recursive: true, force: true }); }
});

test("follow model: one-way follows count as followers/following, following back makes friends, unfollow undoes it, counts on the page", async () => {
  const S = await setup();
  try {
    const anaC = await S.ownerCookie(S.ids.ana), boC = await S.ownerCookie(S.ids.bo);
    const t = S.tokenIn(await (await S.page("bo", anaC)).text());
    await S.act(t, "friend");   // ana follows bo (Obsidian member: counts at once, signed later)
    let bo = await (await S.page("bo", anaC)).text();
    assert.match(bo, /data-state="queued"[^>]*>Following</);
    assert.match(bo, /class="cb-counts"[\s\S]*?<b[^>]*>0<\/b> friends &middot; <b[^>]*>1<\/b> follower &middot; <b[^>]*>0<\/b> following/);
    const alerts = S.hub.db.prepare("SELECT title FROM alerts WHERE target=?").all(S.ids.bo.id).map(r => r.title);
    assert.ok(alerts.includes("@ana followed you"), "bo gets one alert");
    // unfollow, then follow again
    assert.equal((await S.act(t, "unfollow")).body.state, "none");
    assert.match(await (await S.page("bo", anaC)).text(), /<b[^>]*>0<\/b> followers/);
    await S.act(t, "friend");
    // bo follows ana back: friends, and neither is a follower any more
    const bt = S.tokenIn(await (await S.page("ana", boC)).text());
    assert.match(await (await S.page("ana", boC)).text(), />Follow back</);
    assert.equal((await S.act(bt, "accept")).body.state, "friends");
    assert.match(await (await S.page("ana", boC)).text(), /<b[^>]*>1<\/b> friend &middot; <b[^>]*>0<\/b> followers &middot; <b[^>]*>0<\/b> following/);
    // a plugin-signed follow from someone you already follow makes friends too (mutual = friends)
    const cyC = await S.ownerCookie(S.ids.cy);
    const ct = S.tokenIn(await (await S.page("ana", cyC)).text());
    await S.act(ct, "friend");   // cy follows ana (queued)
    assert.equal((await S.post("/v1/envelopes", C.sign(S.ids.ana, "friend.request", { to: S.ids.cy.id, note: "" }))).status, 200);
    assert.match(await (await S.page("cy", anaC)).text(), /data-state="friends"/);
    // ana unfollows bo (friends): the friendship ends; bo followed back last, so bo still follows ana only if bo's follow was a request
    assert.equal((await S.act(t, "unfollow")).status, 200);
    assert.doesNotMatch(await (await S.page("bo", anaC)).text(), /data-state="friends"/);
  } finally { S.hub.server.close(); }
});

test("profile SEO: listed members who joined after the change are indexable with ProfilePage JSON-LD; earlier members wait 7 days; opt-out and unlisted stay noindex", async () => {
  const S = await setup();
  try {
    // ana/bo were created in setup (now): after seo_since -> indexable
    let r = await S.page("ana"); let h = await r.text();
    assert.equal(r.headers.get("x-robots-tag"), "index, follow, max-image-preview:large");
    assert.match(h, /<meta name="robots" content="index, follow/); assert.doesNotMatch(h, /noindex/);
    assert.match(h, /"@type":"ProfilePage"/); assert.match(h, /"alternateName":"@ana"/); assert.match(h, /<link rel="canonical" href="http:\/\/hub.test\/@ana\/">/);
    const sm = await (await fetch(S.base + "/sitemap-profiles.xml")).text(); assert.match(sm, /@ana\//);
    // an older member, inside the notice period: not yet
    S.hub.db.prepare("UPDATE profiles SET created='2020-01-01T00:00:00.000Z' WHERE handle='bo'").run();
    r = await S.page("bo"); assert.equal(r.headers.get("x-robots-tag"), "noindex");
    // opting out
    const id = S.hub.db.prepare("SELECT id FROM profiles WHERE handle='ana'").get().id;
    S.hub.db.prepare("INSERT OR REPLACE INTO search_prefs VALUES (?,?,?)").run(id, 0, new Date().toISOString());
    r = await S.page("ana"); assert.equal(r.headers.get("x-robots-tag"), "noindex");
    assert.doesNotMatch(await (await fetch(S.base + "/sitemap-profiles.xml")).text(), /@ana\//);
  } finally { S.hub.server.close(); }
});
