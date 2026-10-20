import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// Free tools: GitHub-verified members list free software (links only), first listing reviewed by the founder,
// shown on the profile, in the city (Workshop data), on the World map (Market data), in /tools and the feed.
const UA = { "user-agent": "Mozilla/5.0" };
test("free tools: verified-only listing, founder review, profile + city + world + feed, counted downloads with gravity", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-tools-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", founder: "ana", limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const ids = { ana: C.newIdentity(), bo: C.newIdentity(), cy: C.newIdentity() };
    const page = h => `<html><head></head><body><main class="note"><h1 class="title">${h}</h1><h2 id="projects">Projects</h2></main></body></html>`;
    for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h.toUpperCase(), handle: h, boxKey: id.boxPublic }),
      files: { "index.html": Buffer.from(page(h)).toString("base64"), "city.html": Buffer.from(`<html><head><title>city</title></head><body>city</body></html>`).toString("base64") } });
    hub.db.prepare("UPDATE profiles SET created=?").run("2026-01-01T00:00:00.000Z");
    hub.db.prepare("INSERT INTO gh_links VALUES (?,?,?,?)").run(1, "bo-gh", ids.bo.id, "2026-01-01");
    const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
    const cookieOf = async (id) => { const { body } = await post(`/v1/owner/${id.id}/link`, {}, { authorization: "Bearer " + await login(id) });
      const r = await fetch(body.url.replace("http://hub.test", base), { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; };
    const ck = {}; for (const h of Object.keys(ids)) ck[h] = await cookieOf(ids[h]);
    const as = h => ({ cookie: ck[h], origin: "http://hub.test" });
    const get = (h, p) => fetch(base + p, { headers: { ...UA, ...(h ? { cookie: ck[h] } : {}) }, redirect: "manual" });
    const dictate = { name: "Dictate", pitch: "Push-to-talk dictation for Mac that runs on your computer", platforms: ["mac"], url: "https://example.com/dictate/releases", repo: "https://github.com/bo/dictate" };

    assert.equal((await post("/v1/tools", dictate, as("cy"))).status, 403, "GitHub-verified members only");
    assert.equal((await post("/v1/tools", { ...dictate, url: "http://example.com/x" }, as("bo"))).status, 400, "https only");
    assert.equal((await post("/v1/tools", { ...dictate, url: "https://hub.test/file.zip" }, as("bo"))).status, 400, "Caldera never hosts downloads");
    assert.equal((await post("/v1/tools", { ...dictate, repo: "https://evil.example/x" }, as("bo"))).status, 400, "source must be a GitHub repo");
    assert.equal((await post("/v1/tools", { ...dictate, platforms: ["toaster"] }, as("bo"))).status, 400, "known platforms only");

    const first = await post("/v1/tools", dictate, as("bo"));
    assert.equal(first.status, 200); assert.equal(first.body.status, "pending", "a member's first listing waits for review");
    assert.equal((await (await get(null, "/v1/tools")).json()).tools.length, 0, "pending listings aren't public");
    assert.ok(hub.db.prepare("SELECT 1 FROM alerts WHERE target=? AND title LIKE 'New free tool to review%'").get(ids.ana.id), "the founder is asked to review");
    const rv = await (await get("ana", "/tools")).text();
    assert.match(rv, /Waiting for your review/); assert.match(rv, /data-act="approve" data-id="[0-9a-f]{12}"/);
    assert.equal((await post(`/v1/tools/${first.body.id}/approve`, {}, as("bo"))).status, 403, "only the founder approves");
    assert.equal((await post(`/v1/tools/${first.body.id}/approve`, {}, as("ana"))).body.status, "live");
    const second = await post("/v1/tools", { ...dictate, name: "Clipper", pitch: "Save any web page to your Obsidian vault in one click", platforms: ["chrome", "obsidian"], repo: "" }, as("bo"));
    assert.equal(second.body.status, "live", "after the first approval, new listings go live at once: " + JSON.stringify(second));

    const list = (await (await get(null, "/v1/tools")).json()).tools;
    assert.deepEqual(list.map(t => t.name).sort(), ["Clipper", "Dictate"]); assert.ok(list.every(t => t.url.startsWith("http://hub.test/tools/go/")));
    const pg = await (await get(null, "/tools?platform=mac")).text();
    assert.match(pg, /Dictate/); assert.doesNotMatch(pg, /Clipper/, "platform filter"); assert.match(pg, /Open source/);
    // profile section, city Workshop data, World market data, feed
    const prof = await (await get(null, "/@bo/")).text();
    assert.match(prof, /<h2>Free tools<\/h2>[\s\S]*Dictate[\s\S]*<h2 id="projects"/, "Free tools sits before Projects on the profile");
    const city = await (await get(null, "/@bo/city.html")).text();
    assert.match(city, /window\.CALDERA_TOOLS=\[[^\]]*"name":"Dictate"/, "the city gets its Workshop data before the renderer");
    assert.doesNotMatch(await (await get(null, "/@cy/city.html")).text(), /CALDERA_TOOLS=/, "no tools, no Workshop");
    assert.match(await (await get(null, "/world")).text(), /window\.CALDERA_TOOLS=\[[^\]]*"handle":"bo"/, "the World market lists everyone's tools");
    assert.match(await (await get("cy", "/feed")).text(), /shared a free tool: <a href="\/tools#t-[0-9a-f]{12}"><b>(Dictate|Clipper)<\/b>/);

    // Get it: redirects to the maker's link; a signed-in member counts once and gives gravity; the maker doesn't count
    const go = await get("cy", `/tools/go/${first.body.id}`);
    assert.equal(go.status, 302); assert.equal(go.headers.get("location"), "https://example.com/dictate/releases");
    await get("cy", `/tools/go/${first.body.id}`); await get("bo", `/tools/go/${first.body.id}`); await get(null, `/tools/go/${first.body.id}`);
    assert.equal(hub.db.prepare("SELECT gets FROM tools WHERE id=?").get(first.body.id).gets, 1);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM gravity WHERE sender=? AND recipient=?").get(ids.cy.id, ids.bo.id).n, 1);

    // Downloads: Caldera's own installs plus members' free tools, and a Downloads item in the nav
    const dl = await (await get(null, "/downloads")).text();
    assert.match(dl, /Caldera for Obsidian/); assert.match(dl, /AI agents on your map/); assert.match(dl, /Dictate/);
    assert.match(dl, /href="[^"]*\/downloads"[^>]*aria-current="page"/, "the Downloads nav item is current");
    assert.match(await (await get(null, "/feed")).text(), /<span>Downloads<\/span>/, "Downloads is in the top nav");
    assert.equal((await post(`/v1/tools/${second.body.id}/report`, { reason: "broken link" }, as("cy"))).status, 200);
    assert.ok(hub.db.prepare("SELECT 1 FROM alerts WHERE target=? AND title LIKE 'Free tool reported%'").get(ids.ana.id));
    assert.equal((await post(`/v1/tools/${second.body.id}/delete`, {}, as("cy"))).status, 403, "only the maker or founder removes");
    assert.equal((await post(`/v1/tools/${second.body.id}/delete`, {}, as("bo"))).body.status, "removed");
    assert.equal((await get(null, `/tools/go/${second.body.id}`)).status, 404, "removed tools stop redirecting");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("window glow: recent visitors light a district, and it fades over 30 minutes after they leave", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-glow-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  try {
    const id = C.newIdentity();
    await fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { name: "Gil", handle: "gil", boxKey: id.boxPublic }), files: { "index.html": Buffer.from("<html><body>x</body></html>").toString("base64") } }) });
    hub.db.prepare("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run("k1", id.id, "Shop", 1, "s", new Date().toISOString());
    const at = minAgo => new Date(Date.now() - minAgo * 60_000).toISOString();
    const add = (n, minAgo) => { for (let i = 0; i < n; i++) hub.db.prepare("INSERT INTO traffic VALUES (?,?,?,?)").run("k1", at(minAgo), "view", `v${minAgo}-${i}`); };
    const glow = async () => ((await (await fetch(base + "/v1/live/gil")).json()).districts.Shop || {}).glow || 0;
    add(20, 1);
    const busy = await glow(); assert.ok(busy > 0.85, `20 people just now light most windows (${busy})`);
    hub.db.prepare("DELETE FROM traffic").run(); add(20, 20);
    const fading = await glow(); assert.ok(fading > 0.2 && fading < busy, `20 minutes later it is dimmer (${fading})`);
    hub.db.prepare("DELETE FROM traffic").run(); add(20, 31);
    assert.equal(await glow(), 0, "after 30 minutes the windows are dark");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
