import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
// tag extraction, vocabulary and ranking are open-core hooks (caldera-private has their tests); these run on the public fallbacks

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const RAW = (s) => new Response(s, { status: 200, headers: { "content-type": "text/plain" } });
const USERS = { octo: { id: 7, login: "octo" }, newbie: { id: 8, login: "newbie" }, third: { id: 9, login: "third" } };
const repo = (owner, name, x = {}) => ({ name, full_name: `${owner}/${name}`, private: false, fork: false, archived: false, size: 10, pushed_at: "2026-10-01T00:00:00Z", language: "TypeScript", description: "", topics: [], ...x });
const REPOS = {
  octo: [repo("octo", "caldera-social", { description: "The social network for GitHub and Obsidian", topics: ["social", "obsidian"] }),
    repo("octo", "secret-plan", { private: true, description: "trading bot secret" }),
    repo("octo", "forked-lib", { fork: true, description: "a fork of a trading library" }),
    repo("octo", "old-thing", { archived: true, description: "e-commerce shop" })],
  newbie: [repo("newbie", "trade-bot", { description: "Kraken trading bot", language: "Python" })],
  third: [],
};
const FILES = {
  "octo/caldera-social": { readme: "# Caldera\nA social layer for Obsidian with AI agents in your city.\n", root: ["package.json", "README.md"], "package.json": JSON.stringify({ dependencies: { next: "15", "@anthropic-ai/sdk": "1" } }) },
  "newbie/trade-bot": { readme: "# Trade bot\nBacktests and live trading on Kraken.", root: ["requirements.txt"], "requirements.txt": "ccxt==4\npandas>=2\n" },
};
function hubWith(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-tags-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  let who = "octo"; const seen = [];
  const fake = async (u, init = {}) => { u = String(u); seen.push(u);
    if (u.endsWith("/access_token")) { const code = JSON.parse(init.body || "{}").code; who = code; return J({ access_token: "tok-" + code, expires_in: 28800 }); }
    if (u.endsWith("/user")) { const x = USERS[who]; return J({ ...x, name: x.login, created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/" + x.login, avatar_url: "https://avatars.githubusercontent.com/u/1" }); }
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    let m = u.match(/\/users\/([^/]+)\/repos\?/); if (m) return J(REPOS[m[1]] || []);
    m = u.match(/\/repos\/([^/]+\/[^/]+)\/readme$/); if (m) return FILES[m[1]] ? RAW(FILES[m[1]].readme) : J({}, 404);
    m = u.match(/\/repos\/([^/]+\/[^/]+)\/contents\/$/); if (m) return J((FILES[m[1]]?.root || []).map(n => ({ type: "file", name: n })));
    m = u.match(/\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/); if (m) return FILES[m[1]]?.[m[2]] ? RAW(FILES[m[1]][m[2]]) : J({}, 404);
    if (u.includes("/events") || u.includes("/repos?")) return J([]);
    return J({}, 404); };
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 }, ...extra });
  return { h, d, seen };
}
async function start(h) {
  const base = "http://127.0.0.1:" + await h.listen(0);
  const publish = (id, body) => fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { boxKey: id.boxPublic, ...body }), files: { "index.html": Buffer.from(`<html><head></head><body><h1 class="title">${body.name}</h1><p class="lede">${body.headline || "hi"}</p></body></html>`).toString("base64") } }) });
  const signIn = async (code) => {
    const a = await fetch(base + "/auth/github", { redirect: "manual" });
    const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    const cb = await fetch(base + `/auth/github/callback?code=${code}&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
    const set = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]);
    return set.find(c => /^cal_own=[0-9a-f]{64}$/.test(c)) || set.find(c => c.startsWith("cal_s="));
  };
  return { base, publish, signIn };
}
const post = (base, p, cookie, body, origin = "http://hub.test") => fetch(base + p, { method: "POST", redirect: "manual", headers: { cookie: cookie || "", origin, "content-type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body || {}) });
const tagsOf = (h, handle) => JSON.parse(h.db.prepare("SELECT t.tags FROM member_tags t JOIN profiles p ON p.id=t.member WHERE p.handle=?").get(handle)?.tags || "[]");

test("intros: members only, double opt-in, accept makes friends (kind intro), not now closes quietly, 1 per pair per 30 days, 5 a day", async () => {
  const { h } = hubWith(); const { base, publish, signIn } = await start(h);
  const mk = C.newIdentity(), th = C.newIdentity();
  await publish(mk, { name: "Mike", handle: "mike", links: [["GitHub", "https://github.com/octo"]] });
  await publish(th, { name: "Third", handle: "third", links: [["GitHub", "https://github.com/third"]] });
  const own = await signIn("octo"), nb = await signIn("newbie"), thc = await signIn("third");
  assert.equal((await post(base, "/v1/intro/newbie", "", {})).status, 401, "anonymous can't ask");
  assert.equal((await post(base, "/v1/intro/newbie", own, {}, "https://evil.test")).status, 403, "cross-site refused");
  const r1 = await post(base, "/v1/intro/newbie", own, {});
  assert.equal(r1.status, 200); assert.equal((await r1.json()).state, "sent");
  assert.equal((await post(base, "/v1/intro/newbie", own, {})).status, 409, "one per pair per 30 days");
  const pend = await (await fetch(base + "/me/building", { headers: { cookie: nb } })).text();
  assert.match(pend, /@mike/); assert.match(pend, /Accept/);
  const st = await (await fetch(base + "/v1/me/intro-state?h=newbie,third", { headers: { cookie: own } })).json();
  assert.deepEqual(st.state, { newbie: "sent", third: "none" });
  // accept: friends, kind intro
  await post(base, "/me/building", nb, "do=accept&from=mike");
  const ids = Object.fromEntries(h.db.prepare("SELECT handle, id FROM profiles").all().map(r => [r.handle, r.id]));
  assert.equal(h.db.prepare("SELECT kind FROM friends WHERE a=? AND b=?").get(ids.mike, ids.newbie)?.kind, "intro");
  // not now: closed, no friendship, the asker still just sees "sent"
  await post(base, "/v1/intro/third", own, {});
  await post(base, "/me/building", thc, "do=decline&from=mike");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM friends WHERE a=? AND b=?").get(ids.mike, ids.third).n, 0);
  assert.equal((await (await fetch(base + "/v1/me/intro-state?h=third", { headers: { cookie: own } })).json()).state.third, "sent");
  // they asked you first: asking back is a yes both ways
  await post(base, "/v1/intro/mike", thc, {});
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM friends WHERE a=? AND b=?").get(ids.mike, ids.third).n, 0, "a declined intro stays closed for 30 days");
  // 5 a day
  const extra = [];
  for (let i = 0; i < 5; i++) { const id = C.newIdentity(); extra.push(id); await publish(id, { name: "P" + i, handle: "p" + i, links: [] }); }
  const codes = [];
  for (const p of ["p0", "p1", "p2", "p3", "p4"]) codes.push((await post(base, "/v1/intro/" + p, own, {})).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429], "mike already asked 2 today, so 3 more then the limit");
  h.server.close();
});

