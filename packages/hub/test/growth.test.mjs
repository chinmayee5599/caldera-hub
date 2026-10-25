import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir; const sent = [];
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(base + p, { headers: { "user-agent": "Mozilla/5.0" } });
const today = new Date().toISOString().slice(0, 10);
const ids = { mike: C.newIdentity(), ana: C.newIdentity(), bo: C.newIdentity(), cy: C.newIdentity(), dee: C.newIdentity() };
const man = (who, extra = {}) => C.sign(ids[who], "profile.manifest", { name: who.toUpperCase(), handle: who, boxKey: ids[who].boxPublic, headline: "", daily: [{ date: today, score: 10 }], ...extra });
async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}
const CITY = `<a class="city-peek" href="city.html"><svg viewBox="-10 -20 300 200" preserveAspectRatio="xMidYMid meet"><polygon class="cp-pad" points="0,0 10,0 10,10"/><polygon fill="rgb(49,120,198)" points="1,1 2,2 3,3"/><polygon fill="rgb(40,100,160)" points="1,1 2,2 3,3"/><polygon fill="rgb(60,130,210)" points="1,1 2,2 3,3"/><polygon class="cp-w cp-on2" points="4,4 5,5 6,6"/><script>alert(1)</script><polygon fill="url(javascript:x)" points="1,1 2,2 3,3"/></svg></a>`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-growth-"));
  hub = createHub({ privateNamedSince: "9999-12-31T00:00:00Z",  privateModeSince: "2999-01-01T00:00:00Z", dataDir: dir, publicUrl: "http://hub.test", limits: { newProfilesPerDay: 100, writesPerMinute: 1000, perMinute: 5000 }, email: { send: async m => { sent.push(m); } } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  const files = { "index.html": Buffer.from(`<html><head><title>Mike</title></head><body>${CITY}</body></html>`).toString("base64") };
  await post(`/v1/profiles/${ids.mike.id}/bundle`, { manifest: man("mike", { headline: "Building AI agents and Obsidian plugins", topics: [["ai", 5], ["typescript", 3]], groups: ["producthunt"] }), files });
  await post("/v1/envelopes", man("ana", { headline: "AI agents for research", topics: [["ai", 2]], groups: ["producthunt"] }));
  await post("/v1/envelopes", man("bo", { headline: "Gardening and cooking" }));
  await post("/v1/envelopes", man("cy", { headline: "Rust compilers", listed: false }));
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("suggestions: shared topics/groups first, never self, friends, pending requests or unlisted", async () => {
  let s = (await (await get("/v1/suggest/mike?n=10")).json()).suggestions;
  assert.equal(s[0].handle, "ana"); assert.match(s[0].why, /producthunt|ai/);
  assert.ok(!s.some(x => x.handle === "mike" || x.handle === "cy"), "no self, no unlisted");
  assert.ok(!("score" in s[0]), "score stays internal");
  await post("/v1/envelopes", C.sign(ids.mike, "friend.request", { to: ids.ana.id, note: "hi" }));
  s = (await (await get("/v1/suggest/mike?n=10")).json()).suggestions;
  assert.ok(!s.some(x => x.handle === "ana"), "pending request excluded");
  assert.equal((await get("/v1/suggest/nobody")).status, 404);
});

test("referrals: invitedBy on a new profile credits the inviter once; not self, not unknown", async () => {
  const before = (await (await get(`/v1/credits/${ids.mike.id}`)).json()).balance;
  await post("/v1/envelopes", man("dee", { invitedBy: "mike" }));
  await post("/v1/envelopes", man("dee", { invitedBy: "mike", headline: "updated" }));   // update: no second reward
  const c = await (await get(`/v1/credits/${ids.mike.id}`)).json();
  assert.equal(c.balance, before + 25); assert.ok(c.ledger.some(l => l.reason === "invited @dee"));
  const dirRow = (await (await get("/v1/directory")).json()).profiles.find(p => p.handle === "mike");
  assert.equal(dirRow.invited, 1);
  const x = C.newIdentity(); await post("/v1/envelopes", C.sign(x, "profile.manifest", { name: "X", handle: "xx", boxKey: x.boxPublic, invitedBy: "no-such-person" }));
  assert.equal((await (await get(`/v1/directory`)).json()).profiles.find(p => p.handle === "xx").invited, 0);
});

test("link previews: og tags on profile pages, a PNG card, city shapes sanitised", async () => {
  const html = await (await get("/@mike/")).text();
  assert.match(html, /property="og:image" content="http:\/\/hub\.test\/@mike\/card\.png\?v=\d+"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  const r = await get("/@mike/card.png"); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
  const png = Buffer.from(await r.arrayBuffer()); assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.ok(fs.existsSync(path.join(dir, "cards", "mike.png")), "cached");
  const card2 = await get("/@ana/card.png"); assert.equal(card2.status, 200, "no page/city: initials card");
});

test("groups: town page lists listed members with their cities, cleaned", async () => {
  const html = await (await get("/g/producthunt")).text();
  assert.ok(html.includes("@mike") && html.includes("@ana") && !html.includes("@bo"));
  assert.ok(html.includes("<polygon") && !/<script(?![^>]*src="\/assets\/site\.js")/.test(html) && !html.includes("javascript:"), "only clean polygons (the one script is the site's own nav script)");
  assert.ok(html.includes('<header class="nav">') || html.includes("/world"), "site header on group pages");
  assert.ok(html.includes("/auth/github?group=producthunt") && html.includes("obsidian://caldera?group=producthunt"));
  assert.equal((await get("/g/x")).status, 404, "slug too short");
});

test("daily email: double opt-in, sealed at rest, digest only when something happened, one-click unsubscribe + suppression", async () => {
  const t = await login(ids.mike);
  assert.equal((await post(`/v1/owner/${ids.mike.id}/email`, { email: "a@example.com" }, t)).status, 400, "test domains refused");
  assert.equal((await post(`/v1/owner/${ids.mike.id}/email`, { email: "a@gmial.com" }, t)).status, 400, "typo domains refused");
  assert.equal((await post(`/v1/owner/${ids.ana.id}/email`, { email: "a@realmail.org" }, t)).status, 401, "owner only");
  const ok = await post(`/v1/owner/${ids.mike.id}/email`, { email: "Mike@RealMail.org" }, t);
  assert.equal(ok.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, "mike@realmail.org");
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith("hub.sqlite"))) assert.ok(!fs.readFileSync(path.join(dir, f)).includes("realmail"), "address sealed at rest");
  const link = sent[0].text.match(/http:\/\/hub\.test(\/v1\/email\/confirm\?t=[\w-]+)/)[1];
  // not confirmed yet: no digest
  assert.equal((await hub.mail.runDigest(true)).sent, 0);
  assert.equal((await fetch(base + link)).status, 200); assert.equal((await hub.mail.status(ids.mike.id)).confirmed, false, "GET only shows a button (scanners prefetch links)");
  assert.match(await (await fetch(base + link, { method: "POST" })).text(), /subscribed/);
  assert.equal(hub.mail.status(ids.mike.id).confirmed, true);
  // something happened: a view + a friend request from bo
  await get("/@mike/");
  await post("/v1/envelopes", C.sign(ids.bo, "friend.request", { to: ids.mike.id, note: "hello" }));
  let r = await hub.mail.runDigest(true); assert.equal(r.sent, 1);
  const d = sent.at(-1);
  assert.match(d.subject, /^Caldera: /); assert.ok(/^[\x20-\x7e]+$/.test(d.subject), "ascii subject");
  assert.ok(d.html.includes("hello") && d.text.includes("Unsubscribe"));
  assert.match(d.headers["List-Unsubscribe"], /^<http:\/\/hub\.test\/v1\/email\/unsub\?t=/); assert.equal(d.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // nothing new since: quiet digest at most once a week
  r = await hub.mail.runDigest(true); const quiet = r.sent; r = await hub.mail.runDigest(true);
  assert.ok(quiet <= 1); assert.equal(r.sent, 0, "no second quiet email");
  // once a day unless forced
  assert.equal((await hub.mail.runDigest(false)).sent + (await hub.mail.runDigest(false)).sent <= 1, true);
  // one-click unsubscribe (RFC 8058 POST) -> suppressed until a fresh confirmed opt-in
  const unsub = d.headers["List-Unsubscribe"].slice(1, -1).replace("http://hub.test", base);
  assert.equal((await fetch(unsub, { method: "POST", body: "List-Unsubscribe=One-Click" })).status, 200);
  assert.equal(hub.mail.status(ids.mike.id), null);
  await post("/v1/envelopes", C.sign(ids.cy, "friend.request", { to: ids.mike.id }));
  assert.equal((await hub.mail.runDigest(true)).sent, 0, "unsubscribed: nothing sent");
});

test("daily email: a vault page not updated in 3+ days gets the refresh line instead of a finish-your-page step", async () => {
  const dee = C.newIdentity(), eve = C.newIdentity();
  for (const [id, h] of [[dee, "stale-dee"], [eve, "stale-eve"]]) { const b = await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h, handle: h, boxKey: id.boxPublic }), files: { "index.html": Buffer.from("<html><body>x</body></html>").toString("base64") } }); assert.equal(b.status, 200, h + " " + JSON.stringify(b.body)); }
  const t = await login(dee);
  assert.equal((await post(`/v1/owner/${dee.id}/email`, { email: "dee@realmail.org" }, t)).status, 200);
  const link = sent.at(-1).text.match(/http:\/\/hub\.test(\/v1\/email\/confirm\?t=[\w-]+)/)[1];
  await fetch(base + link, { method: "POST" });
  hub.db.prepare("UPDATE profiles SET updated=? WHERE id=?").run(new Date(Date.now() - 4 * 86400_000 - 60_000).toISOString(), dee.id);
  const fr = await post("/v1/envelopes", C.sign(eve, "friend.request", { to: dee.id, note: "hi" })); assert.equal(fr.status, 200, JSON.stringify(fr.body));
  assert.equal(hub.mail.status(dee.id)?.confirmed, true, "confirmed");
  const n = sent.length; await hub.mail.runDigest(true);
  const d = sent.slice(n).find(m => m.to === "dee@realmail.org");
  assert.ok(d, "digest sent");
  assert.match(d.text, /Your page last updated 4 days ago - open Obsidian to refresh it\./); assert.match(d.html, /last updated 4 days ago/);
  assert.doesNotMatch(d.text, /FINISH YOUR PAGE/, "the stale line takes the one nudge slot");
  // fresh again: back to the finish-your-page step
  hub.db.prepare("UPDATE profiles SET updated=? WHERE id=?").run(new Date().toISOString(), dee.id);
  await post("/v1/envelopes", C.sign(eve, "friend.request", { to: dee.id, note: "again" }));
  const m = sent.length; await hub.mail.runDigest(true);
  const d2 = sent.slice(m).find(x => x.to === "dee@realmail.org");
  assert.ok(d2); assert.doesNotMatch(d2.text, /last updated/); assert.match(d2.text, /NEXT FOR YOUR PAGE|FINISH YOUR PAGE/);
  assert.equal((d2.text.match(/NEXT FOR YOUR PAGE|FINISH YOUR PAGE/g) || []).length, 1, "exactly one setup step");
});

test("GitHub sign-up from an invite + group: referral, friend request to the inviter, /me friends, accept, email", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-gh-growth-")), mails = [];
  const crypto = await import("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const fake = async (u, init = {}) => { u = String(u);
    if (u.endsWith("/access_token")) return J({ access_token: "tok", expires_in: 28800 });
    if (u.endsWith("/user")) return J({ id: 7, login: "octo", name: "Octo", email: "octo@realmail.org", created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/octo", avatar_url: "https://avatars.githubusercontent.com/u/7" });
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  const h = createHub({ privateNamedSince: "9999-12-31T00:00:00Z",  privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  const b = "http://127.0.0.1:" + await h.listen(0), mk = C.newIdentity();
  await fetch(b + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(mk, "profile.manifest", { name: "Mike", handle: "mike", boxKey: mk.boxPublic })) });
  const a = await fetch(b + "/auth/github?invite=mike&group=producthunt", { redirect: "manual" });
  const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]);
  assert.ok(jar.some(c => c.startsWith("cal_inv=mike")) && jar.some(c => c.startsWith("cal_grp=producthunt")));
  const state = new URL(a.headers.get("location")).searchParams.get("state");
  const cb = await fetch(b + `/auth/github/callback?code=1&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
  const cookie = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => c.startsWith("cal_s=")).join("; ");
  const octo = await (await fetch(b + "/v1/profiles/octo")).json();
  assert.deepEqual(octo.manifest.body.groups, ["producthunt"]);
  assert.equal((await (await fetch(b + `/v1/credits/${mk.id}`)).json()).balance, 125, "inviter credited");
  const reqs = await (await fetch(b + "/v1/directory")).json(); assert.equal(reqs.profiles.find(p => p.handle === "mike").invited, 1);
  // mike sees the request from octo; octo's /me shows friends + email prefilled with the public GitHub email
  const env = h.db.prepare("SELECT json FROM envelopes WHERE type='friend.request' AND recipient=?").get(mk.id); assert.ok(env, "invitee -> inviter request");
  // mike asks octo to be friends; octo accepts from /me
  const r2 = C.sign(mk, "friend.request", { to: octo.id, note: "welcome!" });
  await fetch(b + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r2) });
  let me = await (await fetch(b + "/me", { headers: { cookie } })).text();
  assert.ok(me.includes("This week") && me.includes("card.png") && me.includes("?invite=octo") && me.includes("octo@realmail.org"));
  // octo's own request to mike is open, so mike shows under "Sent"; accept mike's incoming one isn't shown twice
  const hash = C.envelopeHash(r2);
  const post = (body) => fetch(b + "/me", { method: "POST", headers: { cookie, origin: "http://hub.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }).then(r => r.text());
  assert.match(await post({ do: "accept", req: hash, to: mk.id }), /you.re friends now/);
  assert.equal((await (await fetch(b + `/v1/friends/${mk.id}`)).json()).friends[0].handle, "octo");
  assert.match(await post({ do: "email", email: "octo@realmail.org" }), /confirmation link/);
  assert.equal(mails.length, 1);
  me = await (await fetch(b + "/me", { headers: { cookie } })).text(); assert.ok(me.includes("Check octo@realmail.org"));
  // finish your page: masthead missing; upload one (EXIF stripped), it renders like a vault profile's cover
  assert.match(me, /id="finish"/); assert.match(me, /<b>Masthead<\/b>/); assert.match(me, /data-upload="banner"/);
  const ex = Buffer.from("Exif\0\0GPS-SECRET"), jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, ex.length + 2]), ex, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 0xff, 0xd9])]);
  const up = (body, o = "http://hub.test") => fetch(b + "/me/upload", { method: "POST", headers: { cookie, origin: o, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await up({ kind: "banner", data: Buffer.from("not an image").toString("base64") })).status, 400);
  assert.equal((await up({ kind: "banner", data: jpg.toString("base64") }, "http://evil.test")).status, 403);
  assert.equal((await fetch(b + "/me/upload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await up({ kind: "banner", data: jpg.toString("base64") })).status, 200);
  const page = await (await fetch(b + "/@octo/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.match(page, /<div class="banner"><img class="cover" src="img\/banner\.jpg"/);
  const stored = await (await fetch(b + "/@octo/img/banner.jpg")).arrayBuffer(); assert.ok(!Buffer.from(stored).includes("GPS-SECRET"));
  me = await (await fetch(b + "/me", { headers: { cookie } })).text(); assert.doesNotMatch(me, /<b>Masthead<\/b> <span/); assert.match(me, /Remove masthead/);
  // the daily email nudges the next unfinished step (octo still has no group)
  assert.equal(h.mail ? typeof h.mail.runDigest : "function", "function");
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("email text part keeps its line breaks", async () => {
  const m = hub.mail.compose({ handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, requests: [], friends: [], gravity: [], links: 0, invited: [], credits: 0, suggestions: [], you: YOU() }, "http://hub.test/u", false);
  assert.ok(m.text.split("\n").length > 3 && m.text.startsWith("YOUR WEEK\n"));
});

test("every digest section links back to the page it's about (HTML and plain text)", async () => {
  const p = (h) => ({ handle: h, name: h.toUpperCase() });
  const d = { handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, viewsAll: 40, links: 2, credits: 0, stale: 0,
    you: YOU(),
    messages: { unread: 1, from: [{ ...p("ma"), count: 1, preview: "hi", request: false }], url: "x" },
    kudos: [{ ...p("ku"), emoji: "*" }], postKudos: [{ ...p("pk"), emoji: "*", url: "http://hub.test/feed/p1" }],
    requests: [{ ...p("rq"), note: "" }], intros: [{ ...p("in"), tag: "ai" }],
    postWaiting: [{ ...p("pw"), text: "t", kind: "help", url: "http://hub.test/feed/p2" }], suggestions: [{ ...p("su"), why: "w" }],
    lookingFor: [{ ...p("lf"), sentence: "s", why: "w", url: "http://hub.test/feed/p3" }], recommends: [{ ...p("rc"), sentence: "s", why: "w", link: "", url: "http://hub.test/feed/p4" }],
    friends: [{ ...p("fr"), kind: "repo", why: "x/y" }, { ...p("fj"), joined: true }], invited: [{ handle: "iv" }], gravity: [{ handle: "gr", reason: "helped" }] };
  const m = hub.mail.compose(d, "http://hub.test/u", false);
  const sections = m.html.split(/<h2[^>]*>/).slice(1);
  assert.ok(sections.length >= 5, "all sections rendered: " + sections.length);   // inbox, notifications, picked for you, people to meet, your page
  for (const h of ["ma", "ku", "pk", "rq", "in", "su", "fr", "fj", "iv", "gr"]) assert.match(m.html, new RegExp(`href="http://hub\\.test/@${h}/"`), "links to @" + h);
  for (const s of sections) assert.match(s, /href="https?:\/\//, "HTML section without a link: " + s.slice(0, 60));
  for (const s of m.text.split("\n\n").filter(x => /^[A-Z][A-Z ]+(:|\n)/.test(x))) assert.match(s, /https?:\/\//, "text section without a link: " + s.slice(0, 60));
  // the stale-page note links to the page too, not only to obsidian://
  const st = hub.mail.compose({ ...d, stale: 5 }, "http://hub.test/u", false);
  assert.match(st.html, /Open Obsidian<\/a> &middot; <a href="[^"]*\/@mike\/"/);
});

test("email links back to the hub carry src=<email kind>; one-time links and other sites don't", async () => {
  const { tagLinks } = await import("../dist/server.js"), H = "https://hub.test";
  const html = `<a href="${H}/@ana/">a</a> <a href="${H}/?invite=mike">i</a> <a href="${H}/settings#update">s</a> <a href="${H}/v1/email/unsub?t=x">u</a> <a href="${H}/signin/link?c=1">l</a> <a href="${H}/privacy">p</a> <a href="https://hub.test.evil.com/x">e</a> <a href="https://github.com/x">g</a> <a href="obsidian://caldera">o</a>`;
  const t = tagLinks(html, H, "email-digest", true);
  assert.match(t, /href="https:\/\/hub\.test\/@ana\/\?src=email-digest"/);
  assert.match(t, /href="https:\/\/hub\.test\/\?invite=mike&amp;src=email-digest"/);
  assert.match(t, /href="https:\/\/hub\.test\/settings\?src=email-digest#update"/);
  for (const keep of ["/v1/email/unsub?t=x\"", "/signin/link?c=1\"", "/privacy\"", "https://hub.test.evil.com/x\"", "https://github.com/x\"", "obsidian://caldera\""]) assert.ok(t.includes(keep), keep);
  assert.equal(tagLinks(`@iv (${H}/@iv/), see ${H}/people?sort=new.`, H, "email-x", false), `@iv (${H}/@iv/?src=email-x), see ${H}/people?sort=new&src=email-x.`);
  assert.equal(tagLinks(`${H}/@a/?src=other`, H, "email-x", false), `${H}/@a/?src=other`);
  // compose marks the kind; send() tags every hub link with it
  const d = { handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, requests: [{ handle: "rq", name: "RQ", note: "" }], friends: [], gravity: [], links: 0, invited: [], credits: 0, suggestions: [] };
  const m = hub.mail.compose(d, "http://hub.test/v1/email/unsub?t=z", false);
  assert.equal(m.src, "email-digest");
});

// the reader's own numbers, as digestFor builds them (Obsidian member with code)
const YOU = (o = {}) => ({
  caldera: { views: { day: 9, week: 57, all: 1234 }, visitors: { day: 7, week: 42, all: 900 }, cityViews: { day: 2, week: 11, all: 140 }, kudos: { day: 1, week: 3, all: 20 },
    followers: { week: 2, all: 30 }, connections: { week: 1, all: 25 }, gravity: { week: 0 }, messages: { week: 4 }, checkins: { week: 6, all: 40, today: true }, updated: new Date().toISOString() },
  vault: { notes: { day: 28, week: 190 }, journal: { day: 1, week: 5 }, sessions: { day: 10, week: 350 }, meetings: 2, emails: 200, docs: 30, totals: { notes: 8904, words: 2561881, links: 28446, activeDays: 140 } },
  code: { commits: { day: 3, week: 31 }, activeRepos: 4, repos: 36, top: { name: "caldera", url: "https://github.com/x/caldera", week: 20 }, languages: ["TypeScript", "Python"], ...o.code }, ...o.you });
// anything that would reveal how big Caldera is or how fast it grows
const NETWORK_SIZE = [/\bjoined\b/i, /new members?/i, /\bmembers\b/i, /sign-?ups?/i, /\bcities\b/i, /new tools?/i, /tools this week/i, /See all \d+/i, /people\?sort=new/, /New cities/, /Walk it/];

test("Caldera Daily is about the reader: their stats in the tiles and Your week, never network size or growth", async () => {
  const d = { handle: "mike", name: "Mike", hosted: false, views24: 9, visitors24: 7, views7: 57, visitors7: 42, viewsAll: 900, requests: [], friends: [], gravity: [], links: 0, invited: [], credits: 0, suggestions: [{ handle: "su", name: "Su", why: "Also into AI", joined: true }], personal: false,
    you: YOU({ code: { lines: { added: 1520, removed: 340, dayAdded: 120, dayRemoved: 15 } } }),
    // an older network object (with growth numbers) must not leak into the email even if a caller still passes one
    network: { joinedNew: 2, joinedWeek: 9, members: [{ handle: "nu", name: "New One", headline: "Agents at a fintech" }], cities: 31, citiesNew: 1, newCities: [{ handle: "nu", url: "http://hub.test/@nu/city.html" }],
      tools: [{ name: "Dictate", pitch: "Local push-to-talk", platforms: ["macOS"], url: "http://hub.test/tools#t-1", by: "mike" }], toolsNew: 1,
      boards: [{ group: "ai-model-discussion", groupName: "AI model discussion", by: "bo", text: "Which local model for tool calls?", replies: 3, url: "http://hub.test/messages/groups/ai-model-discussion/p1" }],
      posts: [{ by: "cy", text: "@cy is looking for a co-founder.", tags: ["ai agents"], comments: 2, url: "http://hub.test/feed/p/x1" }] },
    news: [{ src: "HN", title: "An agent story", url: "https://example.com/a", meta: "400 points" }, { src: "Paper", title: "A paper", url: "https://huggingface.co/papers/1", meta: "9 upvotes" }] };
  const m = hub.mail.compose(d, "http://hub.test/u", false);
  // the subject: the reader's own numbers
  assert.equal(m.subject, "Caldera Daily: 42 people viewed your page, 31 commits this week");
  // the four tiles are theirs
  const tiles = [...m.html.matchAll(/class="cd-tile"[^>]*><div[^>]*>([^<]+)<\/div><div[^>]*>([^<]+)</g)].map(x => [x[1], x[2]]);
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map(t => t[0]), ["42", "31", "+1,520", "190"]);
  assert.match(tiles[0][1], /people viewed your page/); assert.match(tiles[1][1], /commits this week/); assert.match(tiles[2][1], /lines of code &middot; -340/); assert.match(tiles[3][1], /notes edited/);
  // Your week: right under the notifications, one row per stat
  assert.ok(m.html.includes(">Your week</h2>"));
  for (const s of ["Page views", "1,234", "City views", "Kudos received", "Followers", "+2", "Connections", "Messages received", "Check-ins (days on Caldera)", "6 of 7", "Notes edited", "Journal entries", "AI sessions", "Notes in your vault", "8,904", "Words written", "2,561,881",
    "Commits", "Lines of code", "+1,520 / -340", "+120 / -15", "Repos (active / all)", "Most active repo", "https://github.com/x/caldera", "TypeScript, Python"]) assert.ok(m.html.includes(s), s);
  assert.match(m.text, /YOUR WEEK\n/); assert.match(m.text, /Lines of code: \+120 \/ -15 in 24h, \+1,520 \/ -340 in 7 days/); assert.match(m.text, /Page views: 9 in 24h, 57 in 7 days, 1,234 all time/);
  // still there: boards, feed, people to meet (no counts), AI news
  for (const s of ["Bulletin boards", "#ai-model-discussion", "Picked for you", "co-founder", "People to meet", "@su", "AI &amp; agents today", "An agent story"]) assert.ok(m.html.includes(s), s);
  // gone: anything about how many people joined, cities on the map, tools, network totals
  for (const re of NETWORK_SIZE) for (const [k, v] of [["html", m.html], ["text", m.text], ["subject", m.subject]]) assert.doesNotMatch(v, re, `${k} reveals network size: ${re}`);
  assert.doesNotMatch(m.html, /New One|Dictate/);
  assert.ok(/^[\x00-\x7e]*$/.test(m.text), "ascii text part"); assert.ok(/^[\x00-\x7e]*$/.test(m.subject), "ascii subject");
  // lines of code: the row only when we know it (never a made-up 0)
  const noLoc = hub.mail.compose({ ...d, you: YOU() }, "http://hub.test/u", false);
  assert.doesNotMatch(noLoc.html, /Lines of code|lines of code/); assert.doesNotMatch(noLoc.text, /Lines of code/);
  // a quiet day with nothing of theirs: the subject is the top AI story, never the network
  const quiet = hub.mail.compose({ ...d, views7: 0, visitors7: 0, you: { caldera: { ...YOU().caldera, visitors: { day: 0, week: 0, all: 0 }, kudos: { day: 0, week: 0, all: 0 } } } }, "http://hub.test/u", true);
  assert.equal(quiet.subject, "Caldera Daily: An agent story");
  const none = hub.mail.compose({ ...d, news: [], views7: 0, visitors7: 0, you: { caldera: { ...YOU().caldera, visitors: { day: 0, week: 0, all: 0 }, kudos: { day: 0, week: 0, all: 0 } } } }, "http://hub.test/u", true);
  assert.equal(none.subject, "Caldera Daily: your week in numbers");
});

test("digest data: the reader's numbers from page views, check-ins, the manifest and the city; lines of code only when known", async () => {
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const vee = C.newIdentity();
  const daily = [6, 3, 1, 0].map(n => ({ date: day(n), score: 5, headline: n === 1 ? "A good day" : "", counts: { notes: 4, prompts: 10, commits: 5, emails: 2, ...(n <= 1 ? { linesAdded: 100, linesRemoved: 20 } : {}) } }));
  const city = { districts: [{ name: "Tools", notes: 0, repos: [
    { name: "secret-thing", project: "Tools", public: false, priv: true, language: "Go", commits: 90, weeks: [], week: 40, today: 2 },
    { name: "open-tool", project: "Tools", public: true, language: "TypeScript", commits: 50, weeks: [], week: 12, today: 1, url: "https://github.com/vee/open-tool" },
    { name: "old", project: "Tools", public: true, language: "Rust", commits: 5, weeks: [], week: 0, today: 0 }] }], private: false };
  const files = { "index.html": Buffer.from("<html><body>vee</body></html>").toString("base64"), "city.html": Buffer.from(`<html><script type="application/json" id="city-data">${JSON.stringify(city)}</script></html>`).toString("base64") };
  const r = await post(`/v1/profiles/${vee.id}/bundle`, { manifest: C.sign(vee, "profile.manifest", { name: "Vee", handle: "vee", boxKey: vee.boxPublic, daily, stats: { notes: 120, words: 5000, links: 300, activeDays: 12 }, languages: ["Go", "TypeScript"] }), files });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 3; i++) await get("/@vee/");
  await get("/@vee/city.html");
  const y = hub.digestFor(vee.id, new Date(Date.now() - 86_400_000).toISOString()).you;
  assert.ok(y.caldera.views.all >= 3 && y.caldera.views.week >= 3, JSON.stringify(y.caldera.views));
  assert.ok(y.caldera.cityViews && y.caldera.cityViews.all >= 1);
  assert.equal(y.vault.notes.week, 16); assert.equal(y.vault.journal.week, 1); assert.equal(y.vault.sessions.week, 40); assert.equal(y.vault.totals.words, 5000);
  assert.equal(y.code.commits.week, 20); assert.equal(y.code.activeRepos, 2); assert.equal(y.code.repos, 3);
  assert.deepEqual(y.code.lines, { added: 200, removed: 40, dayAdded: 200, dayRemoved: 40 });
  // the busiest repo is private: counted, never named
  assert.equal(y.code.top, undefined); assert.ok(!JSON.stringify(y).includes("secret-thing"));
  const m = hub.mail.compose(hub.digestFor(vee.id, new Date(Date.now() - 86_400_000).toISOString()), "http://hub.test/u", false);
  assert.ok(!m.html.includes("secret-thing") && !m.text.includes("secret-thing"));
  assert.match(m.html, /Lines of code/);
  // no lines in the manifest: no lines of code at all (not 0)
  const daily2 = daily.map(x => ({ ...x, counts: { notes: 1, commits: 2 } }));
  await post(`/v1/profiles/${vee.id}/bundle`, { manifest: C.sign(vee, "profile.manifest", { name: "Vee", handle: "vee", boxKey: vee.boxPublic, daily: daily2, ts2: 1 }), files });
  const y2 = hub.digestFor(vee.id, new Date(Date.now() - 86_400_000).toISOString()).you;
  assert.equal(y2.code.lines, undefined);
  assert.doesNotMatch(hub.mail.compose(hub.digestFor(vee.id, new Date(Date.now() - 86_400_000).toISOString()), "http://hub.test/u", false).html, /Lines of code/);
  // the busiest public repo is named when it leads
  const city2 = { ...city, districts: [{ ...city.districts[0], repos: city.districts[0].repos.filter(x => x.public) }] };
  await post(`/v1/profiles/${vee.id}/bundle`, { manifest: C.sign(vee, "profile.manifest", { name: "Vee", handle: "vee", boxKey: vee.boxPublic, daily: daily2, ts2: 2 }), files: { ...files, "city.html": Buffer.from(`<html><script type="application/json" id="city-data">${JSON.stringify(city2)}</script></html>`).toString("base64") } });
  assert.equal(hub.digestFor(vee.id, new Date(Date.now() - 86_400_000).toISOString()).you.code.top.name, "open-tool");
  assert.equal("newMembers" in hub.digestFor(vee.id, new Date().toISOString()), false);
});
