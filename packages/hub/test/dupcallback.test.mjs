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
  let who = "octo"; const used = new Set();
  const fake = async (u, init = {}) => { u = String(u);
    if (u.endsWith("/access_token")) { const code = JSON.parse(init.body || "{}").code; if (used.has(code)) return J({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }); used.add(code); await new Promise(r => setTimeout(r, 150)); who = code; return J({ access_token: "tok-" + code, expires_in: 28800 }); }
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

test("a duplicated GitHub callback (same code twice, concurrently and right after) signs in instead of failing", async () => {
  const { h } = hubWith(); const { base } = await start(h);
  const a = await fetch(base + "/auth/github", { redirect: "manual" });
  const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
  const state = new URL(a.headers.get("location")).searchParams.get("state");
  const hit = () => fetch(base + `/auth/github/callback?code=newbie&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
  const [r1, r2] = await Promise.all([hit(), hit()]);
  const r3 = await hit();
  for (const r of [r1, r2, r3]) {
    assert.equal(r.status, 302, "every copy redirects, none shows the error page");
    assert.match(r.headers.get("location"), /^\/me/);
    assert.ok((r.headers.getSetCookie?.() || []).some(c => c.startsWith("cal_s=") && !c.startsWith("cal_s=;")), "every copy gets the session cookie");
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM gh_accounts").get().n, 1, "one account, not two");
  // someone who only saw the callback URL (logs, a shared screen) and doesn't have this browser's cookie gets no session
  const stolen = await fetch(base + `/auth/github/callback?code=newbie&state=${state}`, { redirect: "manual" });
  assert.ok(!(stolen.headers.getSetCookie?.() || []).some(c => c.startsWith("cal_s=") && !c.startsWith("cal_s=;")), "no session for a copied URL");
  const other = await fetch(base + `/auth/github/callback?code=newbie&state=wrong`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
  assert.notEqual(other.headers.get("location") || "", "/me?welcome=1", "a replay with a different state never signs in");
  assert.equal(other.headers.get("location"), "/auth/github", "it starts a fresh sign-in instead (GitHub remembers the approval)");
  const again = await fetch(base + `/auth/github/callback?code=newbie&state=wrong`, { headers: { cookie: [...jar, "cal_retry=1"].join("; ") }, redirect: "manual" });
  assert.equal(again.status, 400, "a second failure in a row shows the page");
  h.server.close();
});
