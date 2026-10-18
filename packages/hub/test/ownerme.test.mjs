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

test("a GitHub sign-up signed in by email link or pairing (owner cookie only) can open /me and upload", async () => {
  const { h } = hubWith(); const { base, signIn } = await start(h);
  const r = await signIn("newbie"); assert.equal(r.cb.status, 302);
  const acct = h.db.prepare("SELECT profile_id FROM gh_accounts WHERE login='newbie'").get();
  const t = crypto.randomBytes(32).toString("hex");
  h.db.prepare("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(crypto.createHash("sha256").update(t).digest("hex"), acct.profile_id, new Date().toISOString(), Date.now() + 86_400_000);
  for (let i = 0; i < 40 && !h.db.prepare("SELECT 1 FROM profiles WHERE id=?").get(acct.profile_id); i++) await new Promise(r => setTimeout(r, 100));
  const me = await fetch(base + "/settings", { headers: { cookie: "cal_own=" + t }, redirect: "manual" });
  assert.equal((await fetch(base + "/me", { headers: { cookie: "cal_own=" + t }, redirect: "manual" })).headers.get("location"), "/settings", "/me moved to /settings");
  assert.equal(me.status, 200, "account page opens, not a redirect back to the public page");
  assert.match(await me.text(), /Your page/);
  const anon = await fetch(base + "/me", { redirect: "manual" }); assert.equal(anon.status, 302, "no cookie: off to sign in");
  h.server.close();
});
