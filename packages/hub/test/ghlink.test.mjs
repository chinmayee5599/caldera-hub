import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const USERS = { octo: { id: 7, login: "Octo" }, newbie: { id: 8, login: "newbie" } };
function hubWith(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-ghlink-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  let who = "octo";
  const fake = async (u, init = {}) => { u = String(u);
    if (u.endsWith("/access_token")) { const code = JSON.parse(init.body || "{}").code; who = code; return J({ access_token: "tok-" + code, expires_in: 28800 }); }
    if (u.endsWith("/user")) { const x = USERS[who]; return J({ ...x, name: x.login, created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/" + x.login, avatar_url: "https://avatars.githubusercontent.com/u/1" }); }
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 }, ...extra });
  return { h, d };
}
async function start(h) {
  const base = "http://127.0.0.1:" + await h.listen(0);
  const publish = (id, body) => fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { boxKey: id.boxPublic, ...body }), files: { "index.html": Buffer.from("<html><head></head><body>hi</body></html>").toString("base64") } }) });
  const signIn = async (code, hParam = "") => {
    const a = await fetch(base + "/auth/github" + (hParam ? "?h=" + hParam : ""), { redirect: "manual" });
    const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    const cb = await fetch(base + `/auth/github/callback?code=${code}&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
    const set = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]);
    return { cb, own: set.find(c => /^cal_own=[0-9a-f]{64}$/.test(c)), sess: set.find(c => c.startsWith("cal_s=")), body: cb.status === 302 ? "" : await cb.text() };
  };
  return { base, publish, signIn };
}
const count = (h, sql) => h.db.prepare(sql).get().n;

test("GitHub sign-in finds the Obsidian profile that lists the login: owner cookie, no new profile; unclaimed logins still sign up; revoke; page binding", async () => {
  const { h, d } = hubWith(); const { base, publish, signIn } = await start(h);
  const mk = C.newIdentity(), other = C.newIdentity();
  await publish(mk, { name: "Mike", handle: "mike", links: [["GitHub / octo", "https://github.com/octo"], ["Site", "https://x.test"]] });
  await publish(other, { name: "Other", handle: "other", links: [] });
  const before = count(h, "SELECT COUNT(*) n FROM profiles");
  const r = await signIn("octo");
  assert.equal(r.cb.status, 302); assert.equal(r.cb.headers.get("location"), "/@mike/"); assert.ok(r.own, "owner cookie set");
  assert.equal(count(h, "SELECT COUNT(*) n FROM profiles"), before, "no hosted profile made");
  assert.equal(count(h, "SELECT COUNT(*) n FROM gh_accounts"), 0);
  assert.equal(count(h, "SELECT COUNT(*) n FROM gh_links"), 1);
  assert.match(await (await fetch(base + "/@mike/", { headers: { cookie: r.own, "user-agent": "Mozilla/5.0" } })).text(), /viewing your public page/);
  assert.equal((await fetch(base + "/me", { headers: { cookie: r.own }, redirect: "manual" })).headers.get("location"), "/settings", "/me moved to /settings");
  const ls = await fetch(base + "/settings", { headers: { cookie: r.own }, redirect: "manual" }); assert.equal(ls.status, 200, "a linked Obsidian owner gets their settings");
  const lt = await ls.text(); assert.match(lt, /published from Obsidian/); assert.match(lt, /Connected as <b>@/, "GitHub light is green for a linked owner");
  // signing in for a page that isn't theirs: refused, no cookie
  const wrong = await signIn("octo", "other");
  assert.equal(wrong.cb.status, 403); assert.match(wrong.body, /That GitHub account isn&#39;t the one on this page|That GitHub account isn't the one on this page/); assert.equal(wrong.own, undefined);
  // for their own page: fine
  assert.equal((await signIn("octo", "mike")).cb.headers.get("location"), "/@mike/");
  // a login nobody claims still gets a hosted profile
  const nb = await signIn("newbie");
  assert.equal(nb.cb.headers.get("location"), "/me?welcome=1"); assert.ok(nb.sess);
  assert.equal(count(h, "SELECT COUNT(*) n FROM gh_accounts"), 1);
  // the owner takes GitHub off their page: the link goes
  await new Promise(r => setTimeout(r, 5));
  await publish(mk, { name: "Mike", handle: "mike", links: [["Site", "https://x.test"]] });
  const again = await signIn("octo", "mike");
  assert.equal(again.cb.status, 403); assert.equal(again.own, undefined); assert.equal(count(h, "SELECT COUNT(*) n FROM gh_links"), 0);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("/signin: GitHub first for pages that list a GitHub account; none for pages without; a general /signin", async () => {
  const { h, d } = hubWith(); const { base, publish } = await start(h);
  const mk = C.newIdentity(), other = C.newIdentity();
  await publish(mk, { name: "Mike", handle: "mike", links: [["GitHub", "https://github.com/Octo/"]] });
  await publish(other, { name: "Other", handle: "other", links: [["GitHub repo", "https://github.com/octo/caldera"]] });
  const si = await (await fetch(base + "/signin?h=mike")).text();
  assert.match(si, /href="\/auth\/github\?h=mike"/); assert.match(si, /<b>octo<\/b>/);
  assert.ok(si.indexOf("Sign in with GitHub") < si.indexOf("Email me a sign-in link"), "GitHub is first");
  assert.doesNotMatch(await (await fetch(base + "/signin?h=other")).text(), /auth\/github/, "a repo link isn't an account link");
  const g = await (await fetch(base + "/signin")).text(); assert.match(g, /Sign in to Caldera/); assert.match(g, /href="\/auth\/github"/);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("founder: every new profile (Obsidian or GitHub) starts as the founder's friend; not the founder itself; off without the setting", async () => {
  const { h, d } = hubWith({ founder: "mike" }); const { base, publish, signIn } = await start(h);
  const mk = C.newIdentity(), a = C.newIdentity();
  await publish(mk, { name: "Mike", handle: "mike" });
  assert.equal(count(h, "SELECT COUNT(*) n FROM friends"), 0, "no self-friend");
  await publish(a, { name: "Ana", handle: "ana" });
  const fr = await (await fetch(`${base}/v1/friends/${a.id}`)).json(); assert.deepEqual(fr.friends.map(f => f.handle), ["mike"]);
  await publish(a, { name: "Ana B", handle: "ana" });   // an update doesn't re-add after a removal
  await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(a, "friend.remove", { to: mk.id })) });
  await publish(a, { name: "Ana C", handle: "ana" });
  assert.equal((await (await fetch(`${base}/v1/friends/${a.id}`)).json()).friends.length, 0, "removable, and stays removed");
  await signIn("newbie");
  const nb = await (await fetch(base + "/v1/profiles/newbie")).json();
  assert.deepEqual((await (await fetch(`${base}/v1/friends/${nb.id}`)).json()).friends.map(f => f.handle), ["mike"]);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
  const off = hubWith(); const s2 = await start(off.h); const x = C.newIdentity(), y = C.newIdentity();
  await s2.publish(x, { name: "M", handle: "mike" }); await s2.publish(y, { name: "Y", handle: "yan" });
  assert.equal(count(off.h, "SELECT COUNT(*) n FROM friends"), 0);
  off.h.server.close(); fs.rmSync(off.d, { recursive: true, force: true });
});
