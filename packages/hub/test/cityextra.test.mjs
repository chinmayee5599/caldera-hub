import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// a fake GeoIP + Open-Meteo: counts lookups so caching can be checked, never touches the network
function fakeWeather(code = 61, cloud = 90) {
  const calls = { geo: 0, wx: 0, urls: [] };
  const f = async (u) => {
    calls.urls.push(String(u));
    if (String(u).includes("ipwho.is")) { calls.geo++; return new Response(JSON.stringify({ success: true, city: "Brooklyn", region: "New York", latitude: 40.6782, longitude: -73.9442 })); }
    if (String(u).includes("open-meteo")) { calls.wx++; return new Response(JSON.stringify({ current: { weather_code: code, cloud_cover: cloud, precipitation: 1.2, wind_speed_10m: 18, wind_direction_10m: 270, is_day: 1 }, daily: { sunrise: [1792236000], sunset: [1792276000] } })); }
    return new Response("{}", { status: 404 });
  };
  return { f, calls };
}

test("weather: the viewer's own conditions, mapped to the sky the city draws; lookups cached; no IP kept anywhere", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-wx-"));
  const { f, calls } = fakeWeather(61, 90);
  const h = createHub({ dataDir: d, trustProxy: true, weatherFetch: f, publicUrl: "https://caldera.test" });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const get = (ip) => fetch(base + "/v1/weather", { headers: { "x-real-ip": ip } }).then(r => r.json());
  const w1 = await get("203.0.113.7");
  assert.equal(w1.c, "rain"); assert.equal(w1.place, "Brooklyn, New York"); assert.equal(w1.cloud, 90); assert.ok(w1.sunrise > 0 && w1.sunset > w1.sunrise);
  assert.equal(JSON.stringify(w1).includes("203.0.113"), false, "the answer never echoes the address");
  await get("203.0.113.99");   // same /24: no new GeoIP lookup, same 0.1 degree cell: no new weather lookup
  assert.equal(calls.geo, 1); assert.equal(calls.wx, 1);
  // private and local addresses get nothing (and no lookup)
  assert.equal((await get("192.168.1.5")).c, null); assert.equal((await get("100.101.1.2")).c, null); assert.equal(calls.geo, 1);
  // nothing about the visitor lands on disk
  const db = fs.readFileSync(path.join(d, "hub.sqlite")); let wal = Buffer.alloc(0); try { wal = fs.readFileSync(path.join(d, "hub.sqlite-wal")); } catch { /* none */ }
  for (const buf of [db, wal]) { assert.equal(buf.includes("203.0.113"), false); assert.equal(buf.includes("Brooklyn"), false); }
  h.server.close();
});

test("weather: WMO codes map to the city's skies", async () => {
  const { wmoKind, networkOf } = await import("../dist/cityextra.js");
  const cases = [[0, 10, "clear"], [0, 50, "partly"], [2, 50, "partly"], [3, 100, "overcast"], [45, 100, "fog"], [53, 90, "drizzle"], [63, 90, "rain"], [65, 100, "storm"], [95, 100, "storm"], [73, 90, "snow"], [86, 90, "snow"]];
  for (const [code, cloud, want] of cases) assert.equal(wmoKind(code, cloud), want, `code ${code}`);
  assert.equal(networkOf("8.8.8.8"), "8.8.8"); assert.equal(networkOf("10.0.0.1"), null); assert.equal(networkOf("::1"), null); assert.equal(networkOf("2001:db8:1:2::5"), "2001:db8:1");
});

test("day stats: today's shape and departures; public gets coarse counts only, never visitor ids", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-day-"));
  const h = createHub({ dataDir: d, weatherFetch: fakeWeather().f });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const login = async id => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const sam = C.newIdentity(), page = Buffer.from("<html><head></head><body>c</body></html>").toString("base64");
  await post(`/v1/profiles/${sam.id}/bundle`, { manifest: C.sign(sam, "profile.manifest", { name: "sam", handle: "sam", boxKey: sam.boxPublic }), files: { "index.html": page, "city.html": page } });
  const reg = await post(`/v1/owner/${sam.id}/sites`, { sites: [{ key: "cccccccccccc11", project: "Shop", public: true }, { key: "dddddddddddd22", project: "Secret Lab", public: false }] }, await login(sam));
  const sec = k => reg.body.sites.find(s => s.key === k).secret, ago = m => new Date(Date.now() - m * 60_000).toISOString();
  // gone: last seen 12 and 20 min ago; still here: seen 1 min ago; a private-site visitor who left 15 min ago
  await post("/v1/t/cccccccccccc11/events", { events: [{ k: "view", ts: ago(30), v: "a" }, { k: "view", ts: ago(12), v: "a" }, { k: "view", ts: ago(20), v: "b" }, { k: "view", ts: ago(1), v: "c" }] }, sec("cccccccccccc11"));
  await post("/v1/t/dddddddddddd22/events", { events: [{ k: "view", ts: ago(15), v: "z" }] }, sec("dddddddddddd22"));
  const priv = await (await fetch(`${base}/v1/owner/${sam.id}/live`, { headers: { authorization: "Bearer " + await login(sam) } })).json();
  assert.equal(priv.today.Shop.v, 3); assert.equal(priv.today.Shop.q.length, 96); assert.equal(priv.today.Shop.q.reduce((s, n) => s + n, 0) >= 3, true);
  assert.equal(priv.departures.filter(x => x.d === "Shop").length, 2, "a and b left, c is still here");
  assert.ok(priv.departures.some(x => x.d === "Secret Lab"));
  assert.ok(priv.departures.every(x => !["a", "b", "c", "z"].includes(x.v) && /^[0-9a-f]{10}$/.test(x.v)), "departures carry an opaque per-owner id, not the stored visitor hash");
  const pub = await (await fetch(`${base}/v1/live/sam`)).json();
  assert.equal(pub.left.Shop, 2); assert.equal(pub.left.Private, 1); assert.equal("Secret Lab" in pub.left, false); assert.equal("Secret Lab" in pub.today, false);
  assert.equal("departures" in pub, false); assert.equal(JSON.stringify(pub).includes('"v":"'), false);
  // a later public poll only reports departures since it
  const later = await (await fetch(`${base}/v1/live/sam?since=${encodeURIComponent(new Date().toISOString())}`)).json();
  assert.equal(Object.values(later.left || {}).reduce((s, n) => s + n, 0), 0);
  h.server.close();
});

test("owner setup: the 'turn on live visitors' row and its keys reach the owner only", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-setup-"));
  const h = createHub({ dataDir: d, weatherFetch: fakeWeather().f, publicUrl: "https://caldera.test" });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (p, b, tk) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  const login = async id => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const kim = C.newIdentity(), page = Buffer.from("<html><head></head><body>c</body></html>").toString("base64");
  await post(`/v1/profiles/${kim.id}/bundle`, { manifest: C.sign(kim, "profile.manifest", { name: "kim", handle: "kim", boxKey: kim.boxPublic }), files: { "index.html": page, "city.html": page } });
  const tk = await login(kim), reg = await post(`/v1/owner/${kim.id}/sites`, { sites: [{ key: "eeeeeeeeeeee11", project: "Shop", public: true }] }, tk);
  const anon = await (await fetch(`${base}/@kim/city.html`, { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.ok(anon.includes("CALDERA_EXTRAS") && anon.includes("/v1/weather"), "every viewer gets the weather endpoint");
  assert.equal(anon.includes("eeeeeeeeeeee11"), false, "no site keys for visitors"); assert.equal(anon.includes('"owner"'), false);
  // owner cookie (one-time link from the plugin) -> the setup row with the keys and the agent prompt
  const link = await post(`/v1/owner/${kim.id}/link`, {}, tk);
  const r = await fetch(base + new URL(link.body.url).pathname + new URL(link.body.url).search, { redirect: "manual" });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const mine = await (await fetch(`${base}/@kim/city.html`, { headers: { cookie, "user-agent": "Mozilla/5.0" } })).text();
  assert.ok(mine.includes("eeeeeeeeeeee11") && mine.includes('"liveOff":true') && mine.includes('"agentsOff":true') && mine.includes("agent-hook.mjs"));
  // once traffic arrives, the row goes (and its keys with it)
  await post("/v1/t/eeeeeeeeeeee11/events", { events: [{ k: "view", ts: new Date().toISOString(), v: "x" }] }, reg.body.sites[0].secret);
  const after = await (await fetch(`${base}/@kim/city.html`, { headers: { cookie, "user-agent": "Mozilla/5.0" } })).text();
  assert.ok(after.includes('"liveOff":false')); assert.equal(after.includes("eeeeeeeeeeee11"), false);
  h.server.close();
});
