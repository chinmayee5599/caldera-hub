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
