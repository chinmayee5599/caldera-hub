import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// caldera.social/gh/<login>: anyone's public GitHub as a city, README badges, member redirects, limits
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const UA = { "user-agent": "Mozilla/5.0" };
let calls = 0;
const fake = async (u) => { u = String(u); calls++;
  if (/\/users\/octo$/.test(u)) return J({ login: "Octo", type: "User", name: "Octo Cat", bio: "I build agents", html_url: "https://github.com/Octo", email: "secret@example.com" });
  if (/\/users\/acme$/.test(u)) return J({ login: "acme", type: "Organization", html_url: "https://github.com/acme" });
  if (/\/orgs\/acme\/repos\?/.test(u)) return J([{ name: "api", full_name: "acme/api", language: "Go", size: 500, fork: false, private: false, html_url: "https://github.com/acme/api", pushed_at: "2026-10-01T00:00:00Z" }]);
  if (/\/users\/bot1$/.test(u)) return J({ login: "bot1", type: "Bot", html_url: "https://github.com/bot1" });
  if (/\/users\/Octo\/repos\?/.test(u)) return J([
    { name: "agentkit", full_name: "Octo/agentkit", language: "TypeScript", size: 900, fork: false, private: false, html_url: "https://github.com/Octo/agentkit", description: "Agents <b>", pushed_at: "2026-10-01T00:00:00Z" },
    { name: "notes", full_name: "Octo/notes", language: "Python", size: 10, fork: false, private: false, html_url: "https://github.com/Octo/notes", pushed_at: "2026-09-01T00:00:00Z" },
    { name: "forked", full_name: "Octo/forked", language: "Go", size: 10, fork: true, private: false, html_url: "https://github.com/Octo/forked" }]);
  if (/\/repos\/Octo\/agentkit\/stats\/commit_activity/.test(u)) return J(Array.from({ length: 52 }, (_, i) => ({ total: i === 51 ? 4 : 2 })));
  if (/\/repos\/Octo\/notes\/stats\/commit_activity/.test(u)) return new Response("", { status: 202 });
  return J({ message: "Not Found" }, 404); };

async function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-ghp-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  const get = (p, h = {}) => fetch(base + p, { headers: { ...UA, ...h }, redirect: "manual" });
  return { hub, d, base, post, get };
}

test("/gh/<login>: a preview city from public data, cached, never the email; badges; org and unknown users", async () => {
  const S = await setup();
  try {
    const land = await S.get("/gh"); assert.equal(land.status, 200); assert.match(await land.text(), /See any GitHub as a city/);
    assert.equal((await S.get("/gh?u=https://github.com/octo")).headers.get("location"), "/gh/octo");
    const r0 = await S.get("/gh/octo"); assert.equal(r0.status, 301); assert.equal(r0.headers.get("location"), "/gh/Octo", "canonical case");
    const r = await S.get("/gh/Octo"); assert.equal(r.status, 200);
    const h = await r.text();
    assert.match(h, /@Octo's public GitHub as a city/); assert.match(h, /Claim it with GitHub/); assert.match(h, /og:image/);
    assert.match(h, /"name":"agentkit"/); assert.doesNotMatch(h, /forked/, "forks are left out");
    assert.match(h, /\/gh\/Octo\/badge\.svg\?style=card/); assert.match(h, /privacy@caldera\.social/);
    assert.doesNotMatch(h, /secret@example\.com/);
    const stored = fs.readFileSync(path.join(S.d, "gh-preview", "octo.json"), "utf8"); assert.doesNotMatch(stored, /secret@/, "never stores the email");
    assert.match(JSON.parse(stored).commits.toString(), /^107$/, "52 weeks of commits + the 202 repo counted as 1");
    const n = calls; await S.get("/gh/Octo"); assert.equal(calls, n, "served from cache");
    const b = await S.get("/gh/Octo/badge.svg"); assert.equal(b.status, 200); assert.match(b.headers.get("content-type"), /image\/svg\+xml/);
    const svg = await b.text(); assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/); assert.match(svg, /2 repos · 107 commits\/yr/);
   const stats = await S.get("/gh/Octo/badge.svg?style=stats");
   assert.equal(stats.status, 200);
   const statsSvg = await stats.text();
   assert.match(statsSvg, /height="20"/);
   assert.match(statsSvg, /caldera city/);
   assert.match(statsSvg, /2 repos · 107 commits\/yr/);
   const card = await (await S.get("/gh/Octo/badge.svg?style=card")).text(); assert.match(card, /width="420" height="92"/); assert.match(card, /GitHub city on Caldera/);
    // organizations get a company city (no claim button); other account types are refused
   const org = await S.get("/gh/acme"); assert.equal(org.status, 200); const oh = await org.text();
    assert.match(oh, /acme\/api|>api</); assert.doesNotMatch(oh, /Claim it with GitHub/); assert.match(oh, /careers page/);
    assert.equal((await S.get("/gh/bot1")).status, 422);
    assert.equal((await S.get("/gh/nobody-here")).status, 404);
    assert.equal((await S.get("/gh/bad_login!")).status, 404);
  } finally { S.hub.server.close(); }
});

test("/gh/<login> of a member goes to their real city; member badges; fresh builds are limited per visitor", async () => {
  const S = await setup();
  try {
    const id = C.newIdentity();
    await S.post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: "Ann", handle: "ann", boxKey: id.boxPublic, links: [["GitHub", "https://github.com/ann-gh"]] }),
      files: { "index.html": Buffer.from("<html><head></head><body>ann</body></html>").toString("base64"),
        "city.html": Buffer.from(`<html><body><script type="application/json" id="city-data">${JSON.stringify({ private: false, districts: [{ name: "Web", notes: 0, repos: [{ name: "site", project: "Web", public: true, language: "HTML", commits: 30, weeks: [], week: 1, today: 0 }] }] })}</script></body></html>`).toString("base64") } });
    S.hub.db.prepare("INSERT INTO gh_links VALUES (?,?,?,?)").run(77, "ann-gh", id.id, new Date().toISOString());   // a verified link (a bare listing doesn't count)
    const r = await S.get("/gh/ann-gh"); assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/@ann/city.html");
    const mb = await S.get("/@ann/badge.svg"); assert.equal(mb.status, 200); assert.match(await mb.text(), /1 repo · 30 commits\/yr/);
    assert.match(await (await S.get("/gh/ann-gh/badge.svg")).text(), /@ann/, "a member's login badge shows their real city");
    let last = 0; for (let i = 0; i < 21; i++) last = (await S.get(`/gh/ghost-${i}`)).status;
    assert.equal(last, 429, "21st fresh build in an hour from one visitor waits");
  } finally { S.hub.server.close(); }
});
