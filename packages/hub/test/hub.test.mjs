import { test, before, after } from "node:test";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub, publicExt } from "../dist/server.js";

let hub, base, dir;
const mike = C.newIdentity(), ana = C.newIdentity(), eve = C.newIdentity();
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const get = (p, token) => fetch(base + p, { headers: token ? { authorization: "Bearer " + token } : {} }).then(async r => ({ status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }));
const today = new Date().toISOString().slice(0, 10), daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const manifest = (id, handle, name, score) => C.sign(id, "profile.manifest", { name, handle, boxKey: id.boxPublic, headline: name + "'s vault", daily: [{ date: daysAgo(8), score: 1000 }, { date: daysAgo(1), score }, { date: today, score: 5 }] });

async function login(id) {
  const { body } = await post("/v1/auth/challenge", { id: id.id });
  return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  hub = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: dir, publicUrl: "" });
  base = "http://127.0.0.1:" + await hub.listen(0);
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("profiles: publish manifest + static page; handles are unique", async () => {
  const files = { "index.html": Buffer.from("<h1>Mike</h1>").toString("base64"), "assets/theme.css": Buffer.from(":root{}").toString("base64"), "../../escape.html": Buffer.from("x").toString("base64") };
  const up = await post(`/v1/profiles/${mike.id}/bundle`, { manifest: manifest(mike, "mike", "Mike Jones", 370), files });
  assert.equal(up.status, 200); assert.equal(up.body.url, "/@mike/");
  const page = (await get("/@mike/")).body; assert.ok(page.endsWith("<h1>Mike</h1>") && page.includes('id="caldera-bar"'));
  assert.equal((await get("/@mike/caldera.json")).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, "escape.html")), "path traversal blocked");
  assert.equal((await post("/v1/envelopes", manifest(eve, "mike", "Impostor", 1))).status, 409);
  assert.equal((await post("/v1/envelopes", manifest(ana, "ana", "Ana", 250))).status, 200);
  assert.equal((await get("/v1/profiles?q=mike")).body.profiles.length, 1);
});

test("signatures: forged or tampered envelopes are rejected; unknown types ignored", async () => {
  const forged = { ...C.sign(eve, "gravity", { to: mike.id }), from: ana.id };
  assert.equal((await post("/v1/envelopes", forged)).status, 400);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "future.thing", { x: 1 }))).body.ignored, "future.thing");
});

test("friends: request + accept creates a mutual friendship", async () => {
  const req = await post("/v1/envelopes", C.sign(mike, "friend.request", { to: ana.id, note: "hi" }));
  assert.equal(req.status, 200);
  assert.equal((await post("/v1/envelopes", C.sign(eve, "friend.accept", { request: req.body.request, to: mike.id }))).status, 403);
  assert.equal((await post("/v1/envelopes", C.sign(ana, "friend.accept", { request: req.body.request, to: mike.id }))).status, 200);
  assert.equal((await get(`/v1/friends/${mike.id}`)).body.friends[0].handle, "ana");
});

test("cards: encrypted, friends only, delivered to an authenticated inbox", async () => {
  const sealed = C.seal("# Operator shortlist\nprivate", ana.boxPublic, mike);
  const card = C.sign(mike, "card", { id: C.newId("card"), title: "Operator shortlist", to: [ana.id], payload: { [ana.id]: sealed }, version: 1 });
  assert.equal((await post("/v1/envelopes", card)).status, 200);
  assert.equal((await post("/v1/envelopes", C.sign(eve, "card", { id: "card_x", title: "spam", to: [ana.id], payload: {} }))).status, 403);
  assert.equal((await get(`/v1/inbox/${ana.id}`)).status, 401);
  const inbox = await get(`/v1/inbox/${ana.id}`, await login(ana));
  const got = inbox.body.envelopes.find(e => e.type === "card");
  assert.equal(C.open(got.body.payload[ana.id], mike.boxPublic, ana), "# Operator shortlist\nprivate");
});

test("asks + credits: bounty escrow, award to helper, balances add up", async () => {
  const askId = C.newId("ask");
  assert.equal((await post("/v1/envelopes", C.sign(mike, "ask", { id: askId, title: "Need a DTC operator", bounty: 40, tags: ["ops"] }))).status, 200);
  assert.equal((await get(`/v1/credits/${mike.id}`)).body.balance, 60);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "ask", { id: C.newId("ask"), title: "too big", bounty: 1000 }))).status, 402);
  assert.equal((await get("/v1/asks?tag=ops")).body.asks.length, 1);
  assert.equal((await post("/v1/envelopes", C.sign(ana, "credit.award", { ask: askId, to: ana.id }))).status, 403);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "credit.award", { ask: askId, to: ana.id, amount: 30 }))).body.awarded, 30);
  assert.equal((await get(`/v1/credits/${ana.id}`)).body.balance, 130);
  assert.equal((await get(`/v1/credits/${mike.id}`)).body.balance, 70);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "credit.award", { ask: askId, to: ana.id }))).status, 409);
});

test("gravity: positive only, one per person per day, not to yourself", async () => {
  const g = await post("/v1/envelopes", C.sign(mike, "gravity", { to: ana.id, reason: "found me an operator" }));
  assert.equal(g.status, 200); assert.equal(g.body.gravity, 1);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "gravity", { to: ana.id }))).status, 429);
  assert.equal((await post("/v1/envelopes", C.sign(mike, "gravity", { to: mike.id }))).status, 400);
  assert.equal((await get(`/v1/gravity/${ana.id}`)).body.recent[0].reason, "found me an operator");
});

test("leaderboard: friends scope ranks you against your friends by weekly score", async () => {
  const lb = (await get(`/v1/leaderboard?scope=friends&of=${encodeURIComponent(mike.id)}`)).body.rows;
  assert.deepEqual(lb.map(r => r.handle), ["mike", "ana"]);
  assert.equal(lb[0].week, 370, "this week = the 7 full days before today: today's partial and 8 days ago don't count");
});

test("security: reserved handles, sandboxed profile pages, rate limits", async () => {
  const x = C.newIdentity();
  assert.equal((await post("/v1/envelopes", C.sign(x, "profile.manifest", { name: "x", handle: "admin", boxKey: x.boxPublic }))).status, 400);
  const r = await fetch(base + "/@mike/");
  assert.match(r.headers.get("content-security-policy") || "", /sandbox allow-scripts/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("security: new-profile cap per address", async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub2-"));
  const h2 = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: dir2, limits: { newProfilesPerDay: 2 } }); const b2 = "http://127.0.0.1:" + await h2.listen(0);
  const codes = [];
  for (let i = 0; i < 3; i++) { const id = C.newIdentity(); codes.push((await fetch(b2 + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(id, "profile.manifest", { name: "n" + i, handle: "user" + i, boxKey: id.boxPublic })) })).status); }
  assert.deepEqual(codes, [200, 200, 429]);
  h2.server.close(); fs.rmSync(dir2, { recursive: true, force: true });
});

test("privacy: owner can erase their profile and everything tied to it", async () => {
  const z = C.newIdentity();
  await post(`/v1/profiles/${z.id}/bundle`, { manifest: C.sign(z, "profile.manifest", { name: "Zed", handle: "zed", boxKey: z.boxPublic }), files: { "index.html": Buffer.from("<p>z</p>").toString("base64") } });
  assert.equal((await get("/@zed/")).status, 200);
  assert.equal((await post("/v1/envelopes", C.sign(eve, "profile.delete", {}))).body.deleted, eve.id);
  assert.equal((await get("/v1/profiles/zed")).status, 200, "someone else cannot delete it");
  assert.equal((await post("/v1/envelopes", C.sign(z, "profile.delete", {}))).status, 200);
  assert.equal((await get("/v1/profiles/zed")).status, 404);
  assert.equal((await get("/@zed/")).status, 404);
  assert.equal((await get(`/v1/credits/${z.id}`)).body.balance, 0);
});

test("routes accept percent-encoded ids (raw-URI proxies)", async () => {
  const files = { "index.html": Buffer.from("<h1>Mike again</h1>").toString("base64") };
  const up = await post(`/v1/profiles/${encodeURIComponent(mike.id)}/bundle`, { manifest: manifest(mike, "mike", "Mike Jones", 371), files });
  assert.equal(up.status, 200);
  assert.equal((await get(`/v1/credits/${encodeURIComponent(mike.id)}`)).status, 200);
  assert.equal((await get(`/v1/profiles/${encodeURIComponent(mike.id)}`)).status, 200);
});

test("directory: lists listed profiles, honours listed:false, hides moderated, admin tools", async () => {
  const d1 = await get("/v1/directory");
  assert.equal(d1.status, 200);
  const handles = d1.body.profiles.map(p => p.handle);
  assert.ok(handles.includes("mike") && handles.includes("ana"));
  const mikeRow = d1.body.profiles.find(p => p.handle === "mike");
  assert.ok("week" in mikeRow && !("manifest" in mikeRow) && !("id" in mikeRow), "directory exposes only card fields");
  // opt out
  const unl = C.sign(ana, "profile.manifest", { name: "Ana", handle: "ana", boxKey: ana.boxPublic, listed: false, daily: [] });
  assert.equal((await post("/v1/envelopes", unl)).status, 200);
  assert.ok(!(await get("/v1/directory")).body.profiles.some(p => p.handle === "ana"), "unlisted not in directory");
  assert.equal((await get("/v1/profiles/ana")).status, 200, "unlisted still reachable directly");
  // operator takedown
  hub.admin.hide("mike", "test");
  assert.equal((await get("/@mike/")).status, 410);
  assert.equal((await get("/v1/profiles/mike")).status, 404);
  assert.ok(!(await get("/v1/directory")).body.profiles.some(p => p.handle === "mike"));
  assert.equal((await post("/v1/envelopes", manifest(mike, "mike", "Mike Jones", 1))).status, 403, "owner cannot republish while hidden");
  hub.admin.unhide("mike");
  assert.equal((await get("/@mike/")).status, 200);
  hub.admin.block("impostor");
  assert.equal((await post("/v1/envelopes", manifest(ana, "impostor", "Fake", 1))).status, 403, "blocked handle cannot be claimed");
});

test("onEvent: signup fires once per new profile, not on updates; delete fires", async () => {
  const fs2 = await import("node:fs"), os2 = await import("node:os"), path2 = await import("node:path");
  const dir2 = fs2.mkdtempSync(path2.join(os2.tmpdir(), "caldera-ev-")), events = [];
  const h2 = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: dir2, onEvent: e => events.push(e) });
  const b2 = "http://127.0.0.1:" + await h2.listen(0);
  const p2 = (body) => fetch(b2 + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.status);
  const z = C.newIdentity();
  assert.equal(await p2(manifest(z, "zed", "Zed", 1)), 200);
  assert.equal(await p2(manifest(z, "zed", "Zed again", 2)), 200);
  assert.equal(await p2(C.sign(z, "profile.delete", {})), 200);
  assert.deepEqual(events.map(e => e.type + ":" + e.handle + ":" + e.total), ["signup:zed:1", "delete:zed:0"]);
  h2.server.close(); fs2.rmSync(dir2, { recursive: true, force: true });
});

test("every hosted profile page gets the Caldera bar linking home with the owner's invite", async () => {
  const html = (await get("/@mike/")).body;
  assert.ok(html.includes('id="caldera-bar"') && html.includes("/?invite=mike") && html.includes("Get started"));
  assert.ok(html.indexOf('id="caldera-bar"') < html.indexOf("Mike again") || !html.includes("Mike again"));
  const css = await fetch(base + "/@mike/caldera.json").then(r => r.text());
  assert.ok(!css.includes("caldera-bar"), "only HTML pages are touched");
});

test("gardens: signed garden index, cross-garden backlinks injected into note pages, recent feed", async () => {
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-garden-"));
  const gh = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: gdir, publicUrl: "", garden: true }); const gbase = "http://127.0.0.1:" + await gh.listen(0);
  const post = (p, body) => fetch(gbase + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(gbase + p).then(async r => ({ status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }));
  const g1 = C.newIdentity(), g2 = C.newIdentity();
  const note = (slug, title, extra = {}) => ({ slug, title, stage: "budding", license: "cc-by", created: new Date().toISOString(), updated: new Date().toISOString(), sha256: "a".repeat(64), words: 120, excerpt: title + " excerpt", xlinks: [], ...extra });
  const page = (s) => Buffer.from(`<html><body><article>${s}<!--caldera:xlinks--></article></body></html>`).toString("base64");
  const m1 = C.sign(g1, "profile.manifest", { name: "Gardener One", handle: "gone", boxKey: g1.boxPublic, garden: [note("tools-for-thought", "Tools for thought"), note("bad slug!", "x")] });
  assert.equal((await post(`/v1/profiles/${g1.id}/bundle`, { manifest: m1, files: { "index.html": page("one"), "n/tools-for-thought.html": page("tft") } })).status, 200);
  const m2 = C.sign(g2, "profile.manifest", { name: "Gardener Two", handle: "gtwo", boxKey: g2.boxPublic, garden: [note("reply", "My reply <b>", { xlinks: ["gone/tools-for-thought", "gtwo/self", "../evil"] })] });
  assert.equal((await post(`/v1/profiles/${g2.id}/bundle`, { manifest: m2, files: { "index.html": page("two"), "n/reply.html": page("r") } })).status, 200);
  const html = (await get("/@gone/n/tools-for-thought.html")).body;
  assert.ok(html.includes("Linked from other gardens") && html.includes("/@gtwo/n/reply.html") && html.includes("My reply &lt;b&gt;"), "backlink from another garden, escaped");
  assert.ok(html.includes('id="caldera-bar"'), "bar on note pages too");
  const feed = (await get("/v1/gardens/recent")).body.notes;
  assert.ok(feed.some(n => n.handle === "gone" && n.slug === "tools-for-thought") && !feed.some(n => n.slug === "bad slug!"));
  assert.ok((await get("/gardens")).body.includes("Tools for thought"));
  // republishing without the link removes the backlink; deleting the profile removes its garden
  await post(`/v1/profiles/${g2.id}/bundle`, { manifest: C.sign(g2, "profile.manifest", { name: "Gardener Two", handle: "gtwo", boxKey: g2.boxPublic, garden: [note("reply", "My reply")] }), files: { "index.html": page("two") } });
  assert.ok(!(await get("/@gone/n/tools-for-thought.html")).body.includes("Linked from other gardens"));
  await post("/v1/envelopes", C.sign(g1, "profile.delete", {}));
  assert.ok(!(await get("/v1/gardens/recent")).body.notes.some(n => n.handle === "gone"));
  gh.server.close(); fs.rmSync(gdir, { recursive: true, force: true });
});

test("owner activity: counts real visits (not bots, not the owner's own view), owner-only, erased with the profile", async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-")); const h3 = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d3, garden: true }); const base = "http://127.0.0.1:" + await h3.listen(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p, tk) => fetch(base + p, { headers: tk ? { authorization: "Bearer " + tk } : {} }).then(async r => ({ status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }));
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const o = C.newIdentity();
  await post(`/v1/profiles/${o.id}/bundle`, { manifest: C.sign(o, "profile.manifest", { name: "Olga", handle: "olga", boxKey: o.boxPublic }), files: { "index.html": Buffer.from("<p>o</p>").toString("base64"), "garden.html": Buffer.from("<p>g</p>").toString("base64") } });
  const ua = (s) => ({ headers: { "user-agent": s } });
  await fetch(base + "/@olga/", ua("Mozilla/5.0 Safari"));
  await fetch(base + "/@olga/garden.html", ua("Mozilla/5.0 Safari"));
  await fetch(base + "/@olga/", ua("Googlebot/2.1"));
  await fetch(base + "/@olga/?caldera=owner", ua("Mozilla/5.0 Safari"));
  assert.equal((await get(`/v1/owner/${o.id}/activity`)).status, 401);
  assert.equal((await get(`/v1/owner/${o.id}/activity`, await login(eve))).status, 401, "someone else cannot read it");
  const a = (await get(`/v1/owner/${o.id}/activity?since=2000-01-01`, await login(o))).body;
  assert.equal(a.views, 2); assert.equal(a.visitors, 1); assert.equal(a.totalViews, 2);
  assert.deepEqual(a.pages.map(p => p[0]).sort(), ["garden.html", "index.html"]);
  await post("/v1/envelopes", C.sign(o, "profile.delete", {}));
  await post(`/v1/profiles/${o.id}/bundle`, { manifest: C.sign(o, "profile.manifest", { name: "Olga", handle: "olga", boxKey: o.boxPublic }), files: { "index.html": Buffer.from("<p>o</p>").toString("base64") } });
  assert.equal((await get(`/v1/owner/${o.id}/activity?since=2000-01-01`, await login(o))).body.totalViews, 0, "views erased");
  h3.server.close(); fs.rmSync(d3, { recursive: true, force: true });
});

test("private owner address: tailnet login gates it, layer encrypted at rest, public hub never serves it", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, privateUrl: "https://box.tailnet.ts.net:8443", tailnetOwners: { "me@example.com": "pia" } });
  const base = "http://127.0.0.1:" + await h.listen(0), pbase = "http://127.0.0.1:" + await h.listenPrivate(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const pia = C.newIdentity(), quin = C.newIdentity();
  const page = Buffer.from("<html><body><h1>Pia</h1><!--caldera:owner--></body></html>").toString("base64");
  await post(`/v1/profiles/${pia.id}/bundle`, { manifest: C.sign(pia, "profile.manifest", { name: "Pia", handle: "pia", boxKey: pia.boxPublic }), files: { "index.html": page } });
  await post(`/v1/profiles/${quin.id}/bundle`, { manifest: C.sign(quin, "profile.manifest", { name: "Quin", handle: "quin", boxKey: quin.boxPublic }), files: { "index.html": page } });
  const SECRET = "<div id=owner>SECRET-LAYER</div>";
  assert.equal((await post(`/v1/owner/${pia.id}/private`, { html: SECRET })).status, 401);
  assert.equal((await post(`/v1/owner/${quin.id}/private`, { html: SECRET }, await login(quin))).status, 403, "no private address for unmapped profiles");
  const ok = await post(`/v1/owner/${pia.id}/private`, { html: SECRET, built: new Date().toISOString() }, await login(pia));
  assert.equal(ok.status, 200); assert.equal(ok.body.url, "https://box.tailnet.ts.net:8443/@pia/");
  for (const f of fs.readdirSync(d).filter(f => f.startsWith("hub.sqlite"))) assert.ok(!fs.readFileSync(path.join(d, f)).includes("SECRET-LAYER"), "encrypted at rest: " + f);
  assert.ok(!(await (await fetch(base + "/@pia/")).text()).includes("SECRET-LAYER"), "public hub never shows it");
  const pget = (p, who) => fetch(pbase + p, { headers: who ? { "tailscale-user-login": who } : {}, redirect: "manual" });
  assert.equal((await pget("/@pia/")).status, 403, "no tailnet identity");
  assert.equal((await pget("/@pia/", "stranger@example.com")).status, 403);
  assert.equal((await pget("/@quin/", "me@example.com")).status, 403, "only your own profile");
  const mine = await (await pget("/@pia/", "ME@example.com")).text();
  assert.ok(mine.includes("SECRET-LAYER") && /aria-current="page"[^>]*title="Your profile with the private sections only you see"/.test(mine), "Private is the selected view");
  assert.ok(!(await (await pget("/@pia/?view=public", "me@example.com")).text()).includes("SECRET-LAYER"));
  assert.equal((await pget("/", "me@example.com")).headers.get("location"), "/@pia/");
  await post(`/v1/owner/${pia.id}/private`, { html: SECRET, pages: { "city.html": "<html><body>PRIVATE-CITY</body></html>", "../evil.html": "x" } }, await login(pia));
  assert.ok((await (await pget("/@pia/city.html", "me@example.com")).text()).includes("PRIVATE-CITY"));
  assert.equal((await pget("/@pia/evil.html", "me@example.com")).status, 404);
  assert.equal((await fetch(base + "/@pia/city.html")).status, 404, "public hub has no private city");
  assert.ok((await (await pget("/@pia/", "me@example.com")).text()).includes("SECRET-LAYER"), "layer still served alongside pages");
  h.server.close(); h.privateServer.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("live traffic: owner registers sites, pixel + secret-signed events count, public sees levels only, private sees numbers", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, privateUrl: "https://box.tailnet.ts.net:8443", tailnetOwners: { "me@example.com": "rae" } });
  const base = "http://127.0.0.1:" + await h.listen(0), pbase = "http://127.0.0.1:" + await h.listenPrivate(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const rae = C.newIdentity(), sly = C.newIdentity();
  const city = Buffer.from("<html><head></head><body>CITY</body></html>").toString("base64");
  for (const [id, hd] of [[rae, "rae"], [sly, "sly"]]) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: hd, handle: hd, boxKey: id.boxPublic }), files: { "index.html": city, "city.html": city } });
  const K1 = "aaaaaaaaaaaa11", K2 = "bbbbbbbbbbbb22";
  assert.equal((await post(`/v1/owner/${rae.id}/sites`, { sites: [{ key: K1, project: "Shop", public: true }] })).status, 401);
  const reg = await post(`/v1/owner/${rae.id}/sites`, { sites: [{ key: K1, project: "Shop", public: true }, { key: K2, project: "Secret Lab", public: false }, { key: "bad", project: "x" }] }, await login(rae));
  assert.equal(reg.status, 200); assert.equal(reg.body.sites.length, 2);
  const secret2 = reg.body.sites.find(s => s.key === K2).secret;
  assert.equal((await post(`/v1/owner/${sly.id}/sites`, { sites: [{ key: K1, project: "Stolen" }] }, await login(sly))).body.sites.length, 0, "can't take another owner's key");
  assert.ok(!(await (await fetch(base + "/@rae/city.html")).text()).includes("CALDERA_LIVE"), "no live layer until traffic arrives");
  const ua = { "user-agent": "Mozilla/5.0 (Macintosh) Safari" };
  for (let i = 0; i < 3; i++) { const r = await fetch(base + `/v1/t/${K1}.gif`, { headers: ua }); assert.equal(r.headers.get("content-type"), "image/gif"); }
  await fetch(base + `/v1/t/${K1}.gif`, { headers: { "user-agent": "Googlebot/2.1" } });
  await fetch(base + `/v1/t/${K1}.gif?k=signup`, { headers: ua });
  assert.equal((await post(`/v1/t/${K2}/events`, { events: [{ k: "view", ts: new Date().toISOString(), v: "x" }] }, "wrong")).status, 401);
  const ev = await post(`/v1/t/${K2}/events`, { events: [{ k: "view", ts: new Date().toISOString(), v: "a" }, { k: "view", ts: new Date().toISOString(), v: "b" }, { k: "buy", ts: new Date().toISOString(), v: "a" }, { k: "view", ts: "2001-01-01T00:00:00Z", v: "c" }] }, secret2);
  assert.equal(ev.body.recorded, 3);
  const pub = await (await fetch(base + "/v1/live/rae")).json();
  assert.deepEqual(Object.keys(pub.districts).sort(), ["Private", "Shop"]); assert.equal(pub.districts.Shop.level, 1);
  assert.ok(!JSON.stringify(pub).includes("Secret Lab") && pub.events === undefined && pub.districts.Shop.views === undefined, "public: levels only, unlisted merged");
  const page = await fetch(base + "/@rae/city.html");
  assert.ok((await page.text()).includes('window.CALDERA_LIVE={"url":"/v1/live/rae"'));
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal((await fetch(base + "/v1/owner/" + rae.id + "/live")).status, 401);
  const priv = await (await fetch(base + `/v1/owner/${rae.id}/live`, { headers: { authorization: "Bearer " + await login(rae) } })).json();
  assert.equal(priv.districts.Shop.views, 3); assert.equal(priv.districts.Shop.signups, 1); assert.equal(priv.districts["Secret Lab"].buys, 1); assert.equal(priv.districts["Secret Lab"].now, 2);
  assert.ok(priv.events.length === 7 && priv.events.some(e => e.d === "Secret Lab" && e.k === "buy"));
  // private address: the city carries a tokenised live.json; without the token it's refused
  await post(`/v1/owner/${rae.id}/private`, { html: "x", pages: { "city.html": "<html><head></head><body>PCITY</body></html>" } }, await login(rae));
  const pget = (p) => fetch(pbase + p, { headers: { "tailscale-user-login": "me@example.com" } });
  const ptext = await (await pget("/@rae/city.html")).text(), url = ptext.match(/"url":"(live\.json\?t=[0-9a-f]+)"/)[1];
  assert.ok(ptext.includes("PCITY") && ptext.includes('"mode":"private"'));
  assert.equal((await pget("/@rae/live.json")).status, 403);
  assert.equal((await (await pget("/@rae/" + url)).json()).districts["Secret Lab"].buys, 1);
  assert.equal((await (await pget("/@rae/" + url + "&view=public")).json()).districts["Secret Lab"], undefined);
  assert.ok((await (await fetch(base + "/t.js")).text()).includes("data-site"));
  h.server.close(); h.privateServer.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("agents: owner key from site sync, secret-signed reports, public sees district + state only", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const tia = C.newIdentity(), hash = r => crypto.createHash("sha256").update(r.toLowerCase()).digest("hex").slice(0, 16);
  const page = Buffer.from("<html><head></head><body>CITY</body></html>").toString("base64");
  await post(`/v1/profiles/${tia.id}/bundle`, { manifest: C.sign(tia, "profile.manifest", { name: "Tia", handle: "tia", boxKey: tia.boxPublic }), files: { "index.html": page, "city.html": page } });
  const reg = await post(`/v1/owner/${tia.id}/sites`, { sites: [{ key: "cccccccccccc33", project: "Shop", public: true }, { key: "dddddddddddd44", project: "Vault", public: false }], repos: { [hash("shop-web")]: "Shop", [hash("secret-bot")]: "Vault" } }, await login(tia));
  const { key, secret } = reg.body.agent; assert.match(key, /^[0-9a-f]{18}$/);
  assert.equal((await post(`/v1/agents/${key}`, { agents: [{ id: "s1", state: "working" }] }, "nope")).status, 401);
  const r = await post(`/v1/agents/${key}`, { agents: [
    { id: "sess-1", label: "Claude · laptop", machine: "laptop", repo: "shop-web", state: "working", task: "Fix checkout", did: "Edit cart.ts", tokens: 1200 },
    { id: "sess-2", label: "Claude · box", machine: "box", repo: "secret-bot", state: "thinking", task: "Tune the SECRET strategy" },
    { id: "sess-3", repo: "unknown-thing", state: "waiting" }, { id: "x", state: "working" }] }, secret);
  assert.equal(r.body.recorded, 3);
  const pub = await (await fetch(base + "/v1/live/tia")).json();
  assert.deepEqual(pub.agents.map(a => a.d).sort(), ["", "Private", "Shop"]);
  const ps = JSON.stringify(pub); for (const w of ["secret-bot", "SECRET", "Vault", "laptop", "Fix checkout", "sess-1"]) assert.ok(!ps.includes(w), "public leaks " + w);
  const priv = await (await fetch(base + `/v1/owner/${tia.id}/live`, { headers: { authorization: "Bearer " + await login(tia) } })).json();
  for (const f of fs.readdirSync(d).filter(f => f.startsWith("hub.sqlite"))) assert.ok(!fs.readFileSync(path.join(d, f)).includes("SECRET strategy"), "agent tasks sealed at rest");
  const a1 = priv.agents.find(a => a.id === "sess-1"); assert.equal(a1.d, "Shop"); assert.equal(a1.repo, "shop-web"); assert.equal(a1.task, "Fix checkout"); assert.equal(priv.agents.find(a => a.id === "sess-2").d, "Vault");
  assert.ok((await (await fetch(base + "/@tia/city.html", { headers: { "user-agent": "Mozilla/5.0" } })).text()).includes("CALDERA_LIVE"), "agents alone light up the city");
  await post(`/v1/agents/${key}`, { agents: [{ id: "sess-3", state: "gone" }] }, secret);
  assert.equal((await (await fetch(base + "/v1/live/tia")).json()).agents.length, 2);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("sign up with GitHub: hosted profile + city, edit, claim into a vault, delete", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "caldera-test", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const now = new Date().toISOString(), weeks = Array.from({ length: 52 }, (_, i) => ({ total: i % 3, days: [0, 0, 0, 0, 0, 0, 0] }));
  const users = { tok42: { id: 42, login: "octo-cat", name: "Octo Cat", bio: "I build things", created_at: "2019-01-01T00:00:00Z", public_repos: 2, followers: 3, html_url: "https://github.com/octo-cat", avatar_url: "https://avatars.githubusercontent.com/u/42?v=4" },
    tok43: { id: 43, login: "newbie", created_at: now, public_repos: 0, followers: 0, html_url: "https://github.com/newbie", avatar_url: "https://avatars.githubusercontent.com/u/43" },
    tok44: { id: 44, login: "Mike", name: "Taken Handle", created_at: "2018-01-01T00:00:00Z", public_repos: 1, followers: 0, html_url: "https://github.com/Mike", avatar_url: "https://avatars.githubusercontent.com/u/44" } };
  const repos = [{ name: "web", full_name: "octo-cat/web", language: "TypeScript", private: false, fork: false, html_url: "https://github.com/octo-cat/web", pushed_at: now, created_at: now, size: 10, description: "My site" },
    { name: "tool", full_name: "octo-cat/tool", language: "Go", private: false, fork: false, html_url: "https://github.com/octo-cat/tool", pushed_at: now, created_at: now, size: 5, description: "" },
    { name: "forked", full_name: "octo-cat/forked", language: "C", private: false, fork: true, html_url: "x", pushed_at: now, size: 1 }];
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const fake = async (u, init = {}) => {
    u = String(u); const tok = String(init.headers?.authorization || "").replace("Bearer ", "");
    if (u === "https://github.com/login/oauth/access_token") { const b = JSON.parse(init.body); return J({ access_token: "tok" + b.code, expires_in: 28800, refresh_token: "r" }); }
    if (u.endsWith("/user")) return J(users[tok]);
    if (u.includes("/repos?type=owner")) return J(users[tok].id === 42 ? repos : []);
    if (u.includes("/stats/commit_activity")) return J(weeks);
    if (u.includes("/events")) return J([{ type: "PushEvent", created_at: now, payload: { size: 3 } }]);
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"), { status: 200 });
    if (u.includes("/applications/cid/grant")) return new Response(null, { status: 204 });
    return J({ message: "not mocked " + u }, 404);
  };
  // the sign-up gate is an open-core hook: this test plugs in its own (empty accounts wait)
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, ext: { ...publicExt, githubAccountOk: me => (Number(me.public_repos) || 0) + (Number(me.followers) || 0) > 0 } });
  const base = "http://127.0.0.1:" + await h.listen(0);
  // someone already owns @mike
  const mk = C.newIdentity(); await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(mk, "profile.manifest", { name: "M", handle: "mike", boxKey: mk.boxPublic })) });
  const signIn = async (code) => {
    const a = await fetch(base + "/auth/github", { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (" + code + ")" } });
    assert.match(a.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=cid/);
    const state = new URL(a.headers.get("location")).searchParams.get("state"), oauth = a.headers.get("set-cookie").split(";")[0];
    const cb = await fetch(base + `/auth/github/callback?code=${code}&state=${state}`, { headers: { cookie: oauth, "user-agent": "Mozilla/5.0 (" + code + ")" }, redirect: "manual" });
    return { cb, cookie: (cb.headers.getSetCookie?.() || [cb.headers.get("set-cookie")]).map(c => c.split(";")[0]).filter(c => c.startsWith("cal_s=")).join("; ") };
  };
  { const f = await fetch(base + "/auth/github/callback?code=42&state=forged", { redirect: "manual" });
    assert.equal(f.headers.get("location"), "/auth/github", "state must match the cookie: a mismatch starts a fresh sign-in, never uses the code");
    assert.equal((await fetch(base + "/auth/github/callback?code=42&state=forged", { headers: { cookie: "cal_retry=1" }, redirect: "manual" })).status, 400, "only once"); }
  const { cb, cookie } = await signIn("42");
  assert.equal(cb.status, 302); assert.equal(cb.headers.get("location"), "/me?welcome=1"); assert.ok(cookie);
  // the sign-up funnel counted it: clicked, came back from GitHub, account created
  { const today = h.admin["funnel-report"](1).pop().counts; assert.equal(today.click, 1); assert.equal(today.back, 1); assert.equal(today.created, 1); }
  // pressing Cancel on GitHub goes back to the start, never into a retry loop
  { const c = await fetch(base + "/auth/github/callback?error=access_denied&state=x", { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (cancel)" } });
    assert.equal(c.headers.get("location"), "/#install"); }
  const pageHtml = await (await fetch(base + "/@octo-cat/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.ok(pageHtml.includes("Octo Cat") && pageHtml.includes("synced from GitHub"), "profile rendered by the plugin's renderer");
  // auto-filled from public GitHub: an About paragraph, facts and topics, with nothing typed in
  assert.match(pageHtml, /has been on GitHub since/); assert.match(pageHtml, /At a glance/); assert.match(pageHtml, /Public repos/);
  assert.doesNotMatch(pageHtml, /octo-cat\/forked/, "forked repos never named");
  const city = await (await fetch(base + "/@octo-cat/city.html")).text();
  assert.ok(city.includes('"name":"web"') && city.includes("TypeScript") && !city.includes("forked"), "city from public, non-fork repos");
  // just claimed: straight to the city (the "aha"), with one short welcome line; settings stay one tap away
  const wel = await fetch(base + "/settings?welcome=1", { headers: { cookie }, redirect: "manual" });
  assert.equal(wel.headers.get("location"), "/@octo-cat/city.html?welcome=1");
  const welCity = await (await fetch(base + "/@octo-cat/city.html?welcome=1", { headers: { cookie } })).text();
  assert.match(welCity, /This is your city\./); assert.doesNotMatch(await (await fetch(base + "/@octo-cat/city.html?welcome=1")).text(), /This is your city\./, "only the owner sees it");
  const me = await (await fetch(base + "/settings", { headers: { cookie } })).text();
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM member_days d JOIN gh_accounts g ON g.profile_id=d.owner WHERE g.login='octo-cat'").get().n, 1, "a signed-in visit marks the member as seen today (once)");
  assert.match(me, /t\/1\.js(&quot;|")\s+integrity=(&quot;|")sha384-/); assert.ok(me.includes("agent-hook.mjs") && me.includes("SHA-256 is "));
  assert.equal((await fetch(base + "/me", { redirect: "manual" })).headers.get("location"), "/settings", "/me moved");
  assert.equal((await fetch(base + "/settings", { redirect: "manual" })).headers.get("location"), "/signin", "/settings needs a sign-in");
  const post = (body, c = cookie, origin = "http://hub.test") => fetch(base + "/me", { method: "POST", headers: { cookie: c, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }).then(r => r.text());
  assert.ok((await post({ do: "save", name: "Octo", headline: "I ship", summary: "", links: "", listed: "on" }, cookie, "https://evil.example")).includes("Wrong origin"));
  assert.ok((await post({ do: "save", name: "Octo", headline: "I ship small tools", summary: "Hello", links: "Blog | https://octo.dev", listed: "on" })).includes("Republished"));
  assert.ok((await (await fetch(base + "/@octo-cat/", { headers: { "user-agent": "Mozilla/5.0" } })).text()).includes("I ship small tools"));
  // brand-new accounts with nothing on them still get a page (no dead end), but stay out of People and the world
  assert.equal((await signIn("43")).cb.status, 302);
  assert.ok(!(await (await fetch(base + "/v1/directory")).json()).profiles.some(p => p.handle === "newbie"), "unlisted until it has something public");
  await signIn("44"); assert.equal((await fetch(base + "/@mike-2/")).status, 200, "taken handle -> mike-2");
  // claim into a vault: one-time code returns the key once, then the hub forgets it
  const code = (await post({ do: "claim" })).match(/CAL-[\w-]+/)[0];
  const claimed = await (await fetch(base + "/v1/github/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json();
  const prof = await (await fetch(base + "/v1/profiles/octo-cat")).json();
  assert.equal(claimed.identity.id, prof.id); assert.equal(claimed.handle, "octo-cat");
  assert.equal((await fetch(base + "/v1/github/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).status, 404, "single use");
  assert.ok((await (await fetch(base + "/settings", { headers: { cookie } })).text()).includes("published from Obsidian"), "after the claim, settings shows the vault page");
  for (const f of fs.readdirSync(d).filter(f => f.startsWith("hub.sqlite"))) assert.ok(!fs.readFileSync(path.join(d, f)).includes(claimed.identity.secret || "no-secret-field"), "key not stored in clear");
  // delete (the @mike-2 account)
  const s44 = (await signIn("44")).cookie;
  assert.ok((await post({ do: "delete", sure: "on" }, s44)).includes("is deleted"));
  assert.equal((await fetch(base + "/@mike-2/")).status, 404);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("an older Caldera can't overwrite what a newer one published (bundle and private layer)", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-hub-"));
  const h = createHub({ privateModeSince: "2999-01-01T00:00:00Z", dataDir: d, privateUrl: "https://box.ts.net:8443", tailnetOwners: { "me@x.com": "vee" } });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const vee = C.newIdentity(), man = () => C.sign(vee, "profile.manifest", { name: "Vee", handle: "vee", boxKey: vee.boxPublic });
  const files = { "index.html": Buffer.from("<p>x</p>").toString("base64") };
  assert.equal((await post(`/v1/profiles/${vee.id}/bundle`, { manifest: man(), files, v: "0.12.3" })).status, 200);
  assert.equal((await post(`/v1/profiles/${vee.id}/bundle`, { manifest: man(), files, v: "0.10.1" })).status, 409, "older plugin refused");
  assert.equal((await post(`/v1/profiles/${vee.id}/bundle`, { manifest: man(), files })).status, 409, "unversioned (pre-0.12.3) refused once a versioned one published");
  assert.equal((await post(`/v1/profiles/${vee.id}/bundle`, { manifest: man(), files, v: "0.12.10" })).status, 200, "numeric compare, not string");
  const { body: ch } = await post("/v1/auth/challenge", { id: vee.id }); const tk = (await post("/v1/auth/verify", C.sign(vee, "message", { nonce: ch.nonce }))).body.token;
  assert.equal((await post(`/v1/owner/${vee.id}/private`, { html: "a", v: "0.12.3" }, tk)).status, 200);
  assert.equal((await post(`/v1/owner/${vee.id}/private`, { html: "old" }, tk)).status, 409);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("friend requests: the hub lists open requests both ways until accepted", async () => {
  const bo = ana;   // reuses a test profile: the hub caps new profiles per address per day
  assert.equal((await get(`/v1/requests/${bo.id}`)).status, 401);
  const r1 = await post("/v1/envelopes", C.sign(eve, "friend.request", { to: bo.id, note: "first" }));
  const r2 = await post("/v1/envelopes", C.sign(eve, "friend.request", { to: bo.id, note: "again" }));
  const tb = await login(bo), te = await login(eve);
  let inc = (await get(`/v1/requests/${bo.id}`, tb)).body.incoming;
  assert.equal(inc.length, 1, "one row per sender"); assert.equal(inc[0].note, "again"); assert.equal(inc[0].request, r2.body.request);
  assert.equal((await get(`/v1/requests/${eve.id}`, te)).body.outgoing[0].handle, "ana");
  // a client that lost its local copy still sees it; accepting the older request works too
  assert.equal((await post("/v1/envelopes", C.sign(bo, "friend.accept", { request: r1.body.request, to: eve.id }))).status, 200);
  assert.equal((await get(`/v1/requests/${bo.id}`, tb)).body.incoming.length, 0);
  assert.equal((await get(`/v1/requests/${eve.id}`, te)).body.outgoing.length, 0);
  assert.equal((await get(`/v1/friends/${eve.id}`)).body.friends[0].handle, "ana");
});
