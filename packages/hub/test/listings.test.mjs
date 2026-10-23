import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../dist/server.js";
import { blockedIp, safeGet, parseSiteHtml, parsePlayHtml, imageType, plain } from "../dist/listings.js";

// Apps and websites members list: the hub looks up their public details (SSRF-guarded), caches them a day and serves
// the images itself.

test("SSRF guard: only public addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "2001:db8::1", "not-an-ip"])
    assert.equal(blockedIp(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888"]) assert.equal(blockedIp(ip), false, ip);
});

test("SSRF guard: safeGet refuses private answers, bad ports and schemes, and re-checks every redirect", async () => {
  const dnsMap = { "ok.test": "93.184.216.34", "inside.test": "10.0.0.5", "mixed.test": ["93.184.216.34", "127.0.0.1"] };
  const lookup = async h => { const v = dnsMap[h]; if (!v) throw new Error("nxdomain"); return [].concat(v).map(a => ({ address: a, family: a.includes(":") ? 6 : 4 })); };
  const seen = [];
  const hops = { "/one": "/two", "/two": "/three", "/three": "/four", "/four": "/five", "/meta": "http://169.254.169.254/latest/meta-data", "/in": "https://inside.test/", "/ftp": "ftp://ok.test/x" };
  const transport = async (u, pin) => { seen.push(u.toString() + "@" + pin.address); const to = hops[u.pathname]; return to ? { status: 302, type: "", body: Buffer.alloc(0), location: to } : { status: 200, type: "text/html", body: Buffer.from("<title>ok</title>") }; };
  const g = (u, x = {}) => safeGet(u, { maxBytes: 1000, lookup, transport, ...x });
  const r = await g("https://ok.test/");
  assert.equal(r.status, 200); assert.equal(seen.pop(), "https://ok.test/@93.184.216.34", "the connection is pinned to the checked address");
  for (const [u, why] of [["https://inside.test/", /blocked/], ["https://mixed.test/", /blocked/], ["http://127.0.0.1/", /blocked/], ["http://[::1]/", /blocked/], ["http://0x7f000001/", /blocked/],
    ["http://169.254.169.254/", /blocked/], ["https://ok.test:8443/", /port/], ["file:///etc/passwd", /scheme/], ["https://u:p@ok.test/", /credentials/], ["http://localhost/", /host/],
    ["https://ok.test/meta", /blocked/], ["https://ok.test/in", /blocked/], ["https://ok.test/ftp", /scheme/], ["https://ok.test/one", /too many redirects/]])
    await assert.rejects(g(u), why, u);
  assert.ok(!seen.some(s => /169\.254|10\.0\.0\.5|127\.0\.0\.1/.test(s)), "nothing private was ever contacted");
  assert.equal((await g("https://ok.test/two")).status, 200, "3 redirects are fine");
  await assert.rejects(safeGet("https://ok.test/", { maxBytes: 5, lookup, transport }), /too large/);
});

test("parsers: site details, Play listing, image bytes, plain text", () => {
  const s = parseSiteHtml(`<html><head><title>Kitse &amp; co</title><meta name="description" content="Home chefs <b>near</b> you"><link rel="icon" href="/fav.png"><link rel="apple-touch-icon" href="https://cdn.kitse.co/t.png"><link rel="icon" href="/x.svg" type="image/svg+xml"><meta property="og:image" content="/og.jpg"></head></html>`, "https://kitse.co/a/b");
  assert.equal(s.name, "Kitse & co"); assert.equal(s.desc, "Home chefs near you");
  assert.deepEqual(s.icons, ["https://cdn.kitse.co/t.png", "https://kitse.co/fav.png", "https://kitse.co/og.jpg", "https://kitse.co/favicon.ico"]);
  const p = parsePlayHtml(`<meta property="og:title" content="Notes - Apps on Google Play"><meta property="og:image" content="https://play-lh.googleusercontent.com/abc"><span itemprop="genre">Productivity</span> "ratingValue":"4.5" "ratingCount":"1234"`);
  assert.deepEqual([p.name, p.icon, p.genre, p.rating, p.ratings], ["Notes", "https://play-lh.googleusercontent.com/abc", "Productivity", 4.5, 1234]);
  assert.equal(imageType(Buffer.from("89504e470d0a1a0a0000000d", "hex")), "image/png");
  assert.equal(imageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), null, "never SVG");
  assert.equal(plain("<script>x</script>a\u0000b &lt;c&gt;", 50), "x a b c");
});

test("resolve endpoint + image route: lookups by id/link only, cached, images served by the hub", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-listings-"));
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 1)]);
  const calls = [];
  const get = async (url) => { calls.push(url);
    if (url.startsWith("https://itunes.apple.com/lookup?id=1234567&")) return { status: 200, type: "application/json", url, body: Buffer.from(JSON.stringify({ results: [{ trackName: "Notes <b>Pro</b>", artworkUrl512: "https://is1-ssl.mzstatic.com/a.png", primaryGenreName: "Productivity", averageUserRating: 4.66, userRatingCount: 321, sellerName: "Acme" }] })) };
    if (url === "https://is1-ssl.mzstatic.com/a.png") return { status: 200, type: "image/png", url, body: png };
    if (url === "https://kitse.co/") return { status: 200, type: "text/html", url, body: Buffer.from(`<title>Kitse</title><meta name="description" content="Home chefs"><link rel="icon" href="/i.svg">`) };
    if (url === "https://kitse.co/favicon.ico") return { status: 200, type: "image/svg+xml", url, body: Buffer.from("<svg></svg>") };
    throw new Error("unexpected " + url); };
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", listingsGet: get });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const resolve = items => fetch(base + "/v1/listings/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }).then(r => r.json());
  try {
    const r = await resolve([{ kind: "app", url: "https://apps.apple.com/us/app/notes/id1234567" }, { kind: "site", url: "https://kitse.co" }, { kind: "app", url: "https://evil.example/app" }, { kind: "site", url: "http://10.0.0.1/" }]);
    assert.equal(r.items.length, 2, "invalid links are dropped before any fetch");
    const app = r.items.find(x => x.key === "apple-1234567"), site = r.items.find(x => x.key.startsWith("site-"));
    assert.deepEqual([app.name, app.genre, app.rating, app.ratings, app.seller], ["Notes Pro", "Productivity", 4.66, 321, "Acme"]);
    assert.match(app.img, /^apple-1234567\.[0-9a-f]{10}$/);
    assert.equal(site.name, "Kitse"); assert.equal(site.desc, "Home chefs"); assert.equal(site.img, undefined, "an SVG favicon is never stored");
    const img = await fetch(base + "/v1/listings/img/" + app.img);
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png"); assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(base + "/v1/listings/img/apple-1234567.0000000000")).status, 404);
    assert.equal((await fetch(base + "/v1/listings/img/..%2f..%2fetc")).status, 404);
    const n = calls.length; await resolve([{ kind: "app", url: "https://apps.apple.com/app/id1234567" }]);
    assert.equal(calls.length, n, "cached for a day: no second lookup");
    assert.ok(calls.every(u => !/caldera|hub\.test|member/i.test(u)), "only the app id or site link is ever sent");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("GitHub sign-ups: caldera.social/settings adds apps and websites, toggles storefronts, ties repos; the page and city follow", async () => {
  const crypto = await import("node:crypto"), C = await import("@caldera/core");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-lsgh-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const gh = async (u, init = {}) => { u = String(u);
    if (u.endsWith("/access_token")) return J({ access_token: "tok", expires_in: 28800 });
    if (u.endsWith("/user/emails")) return J([]);
    if (u.endsWith("/user")) return J({ id: 31, login: "ana", name: "Ana", created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/ana", avatar_url: "https://avatars.githubusercontent.com/u/31" });
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?")) return J([{ name: "notes-app", full_name: "ana/notes-app", private: false, fork: false, archived: false, language: "Swift", html_url: "https://github.com/ana/notes-app", pushed_at: new Date().toISOString(), created_at: "2024-01-01T00:00:00Z", size: 10, owner: { login: "ana" } }]);
    if (u.includes("/events")) return J([]);
    return J({}, 404); };
  const meta = async (url) => { if (url.startsWith("https://itunes.apple.com/lookup?id=1234567&")) return { status: 200, type: "application/json", url, body: Buffer.from(JSON.stringify({ results: [{ trackName: "Ana Notes", primaryGenreName: "Productivity" }] })) };
    if (url === "https://ana.dev/") return { status: 200, type: "text/html", url, body: Buffer.from("<title>Ana's site</title>") }; throw new Error("no"); };
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: gh, listingsGet: meta, limits: { newProfilesPerDay: 100 } });
  const b = "http://127.0.0.1:" + await h.listen(0);
  try {
    const a = await fetch(b + "/auth/github?digest=0", { redirect: "manual" });
    const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    const cb = await fetch(b + `/auth/github/callback?code=x&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
    const cookie = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => c.startsWith("cal_s=")).join("; ");
    const acct = () => h.db.prepare("SELECT * FROM gh_accounts WHERE gh_id=31").get();
    for (let i = 0; i < 50 && !acct()?.refreshed; i++) await new Promise(r => setTimeout(r, 100));
    const post = body => fetch(b + "/me", { method: "POST", headers: { cookie, origin: "http://hub.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }).then(r => r.text());
    let page = await post({ do: "listings", app_new: "https://apps.apple.com/us/app/ana-notes/id1234567", site_new: "https://evil.example/x\"><script>" , hide_sf: "" });
    assert.match(page, /Not added/); assert.doesNotMatch(page, /<script>"/);
    page = await post({ do: "listings", app_0_url: "https://apps.apple.com/app/id1234567", app_0_repo: "notes-app", app_0_sf: "on", site_new: "https://ana.dev" });
    let ed = JSON.parse(acct().edits);
    assert.deepEqual(ed.apps, ["https://apps.apple.com/app/id1234567 | notes-app"]); assert.deepEqual(ed.websites, ["https://ana.dev/"]);
    assert.match(page, /name="app_0_repo" value="notes-app"/); assert.match(page, /name="site_0_sf" checked/);
    const dir = path.join(d, "profiles", acct().handle);
    let idx = fs.readFileSync(path.join(dir, "index.html"), "utf8"), city = fs.readFileSync(path.join(dir, "city.html"), "utf8");
    assert.match(idx, /Ana Notes/); assert.match(idx, /id="websites"/);
    assert.match(city, /"kind":"app"/); assert.match(city, /"kind":"site"/);
    // storefronts off (the site), the cards stay
    await post({ do: "listings", app_0_url: "https://apps.apple.com/app/id1234567", app_0_repo: "notes-app", app_0_sf: "on", site_0_url: "https://ana.dev/", site_0_repo: "" });
    ed = JSON.parse(acct().edits); assert.deepEqual(ed.websites, ["https://ana.dev/ |  | no-storefront"]);
    idx = fs.readFileSync(path.join(dir, "index.html"), "utf8"); city = fs.readFileSync(path.join(dir, "city.html"), "utf8");
    assert.match(idx, /ana\.dev/); assert.doesNotMatch(city, /"kind":"site"/);
    // a short name: saved on the line, shown on the card and the storefront instead of the store's title, cleaned
    page = await post({ do: "listings", app_0_url: "https://apps.apple.com/app/id1234567", app_0_repo: "notes-app", app_0_sf: "on", app_0_name: "Notes <b>Pro</b>", site_0_url: "https://ana.dev/", site_0_repo: "" });
    ed = JSON.parse(acct().edits); assert.deepEqual(ed.apps, ["https://apps.apple.com/app/id1234567 | notes-app | name: Notes b Pro /b"]);
    assert.match(page, /name="app_0_name" value="Notes b Pro \/b"/);
    idx = fs.readFileSync(path.join(dir, "index.html"), "utf8"); city = fs.readFileSync(path.join(dir, "city.html"), "utf8");
    assert.match(idx, /Notes b Pro \/b/); assert.doesNotMatch(idx, /Ana Notes/); assert.match(city, /"name":"Notes b Pro \/b"/);
    await post({ do: "listings", app_0_url: "https://apps.apple.com/app/id1234567", app_0_repo: "notes-app", app_0_sf: "on", app_0_name: "", site_0_url: "https://ana.dev/", site_0_repo: "" });
    assert.deepEqual(JSON.parse(acct().edits).apps, ["https://apps.apple.com/app/id1234567 | notes-app"], "clearing the name drops it");
    // a repo without storefronts, and removing one
    await post({ do: "listings", app_0_url: "https://apps.apple.com/app/id1234567", app_0_repo: "notes-app", app_0_sf: "on", site_0_url: "https://ana.dev/", site_0_rm: "on", hide_sf: "notes-app, bad name!" });
    ed = JSON.parse(acct().edits); assert.deepEqual(ed.hideStorefronts, ["notes-app"]); assert.deepEqual(ed.websites, []);
    city = fs.readFileSync(path.join(dir, "city.html"), "utf8"); assert.doesNotMatch(city, /"kind":"app"/);
    assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /Ana Notes/, "the card still shows");
  } finally { h.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
