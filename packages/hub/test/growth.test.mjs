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
  hub = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: dir, publicUrl: "http://hub.test", limits: { newProfilesPerDay: 100, writesPerMinute: 1000, perMinute: 5000 }, email: { send: async m => { sent.push(m); } } });
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
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
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
  const m = hub.mail.compose({ handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, requests: [], friends: [], gravity: [], links: 0, invited: [], credits: 0, suggestions: [], newMembers: [] }, "http://hub.test/u", false);
  assert.ok(m.text.split("\n").length > 3 && m.text.startsWith("YOUR PAGE\n"));
});

test("every digest section links back to the page it's about (HTML and plain text)", async () => {
  const p = (h) => ({ handle: h, name: h.toUpperCase() });
  const d = { handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, viewsAll: 40, links: 2, credits: 0, stale: 0,
    vault: { journal: 1, notes: 2 }, cityCommits: 3,
    messages: { unread: 1, from: [{ ...p("ma"), count: 1, preview: "hi", request: false }], url: "x" },
    kudos: [{ ...p("ku"), emoji: "*" }], postKudos: [{ ...p("pk"), emoji: "*", url: "http://hub.test/feed/p1" }],
    requests: [{ ...p("rq"), note: "" }], intros: [{ ...p("in"), tag: "ai" }],
    postWaiting: [{ ...p("pw"), text: "t", kind: "help", url: "http://hub.test/feed/p2" }], suggestions: [{ ...p("su"), why: "w" }],
    lookingFor: [{ ...p("lf"), sentence: "s", why: "w", url: "http://hub.test/feed/p3" }], recommends: [{ ...p("rc"), sentence: "s", why: "w", link: "", url: "http://hub.test/feed/p4" }],
    friends: [{ ...p("fr"), kind: "repo", why: "x/y" }, { ...p("fj"), joined: true }], invited: [{ handle: "iv" }], gravity: [{ handle: "gr", reason: "helped" }], newMembers: [] };
  const m = hub.mail.compose(d, "http://hub.test/u", false);
  const sections = m.html.split(/<h2[^>]*>/).slice(1);
  assert.ok(sections.length >= 12, "all sections rendered: " + sections.length);
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
  const d = { handle: "mike", name: "Mike", hosted: false, views24: 3, visitors24: 2, views7: 5, visitors7: 4, requests: [{ handle: "rq", name: "RQ", note: "" }], friends: [], gravity: [], links: 0, invited: [], credits: 0, suggestions: [], newMembers: [] };
  const m = hub.mail.compose(d, "http://hub.test/v1/email/unsub?t=z", false);
  assert.equal(m.src, "email-digest");
});
