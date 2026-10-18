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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-settings-"));
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
const waitFor = async (fn, ms = 4000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

test("/settings: GitHub sign-up sees lights + in-page Obsidian connect; vault owner sees read-only page; anonymous goes to sign in", async () => {
  const { h } = hubWith(); const { base, publish, signIn } = await start(h);
  assert.equal((await fetch(base + "/me", { redirect: "manual" })).headers.get("location"), "/settings");
  assert.equal((await fetch(base + "/settings", { redirect: "manual" })).headers.get("location"), "/signin", "anonymous: sign in first");
  assert.equal((await fetch(base + "/settings/status")).status, 401);
  // a GitHub sign-up (newbie has no Obsidian page that lists them)
  const s = await signIn("newbie"); assert.ok(s.sess);
  await waitFor(() => !!h.db.prepare("SELECT 1 FROM profiles WHERE handle='newbie'").get());
  const html = await (await fetch(base + "/settings", { headers: { cookie: s.sess } })).text();
  assert.match(html, /Connected as <b>@newbie<\/b>/, "GitHub light on");
  assert.match(html, /id="conn-obsidian"[\s\S]*?conn-dot"/, "Obsidian light off");
  assert.match(html, /Import a GitHub sign-up/, "in-page Obsidian steps");
  assert.match(html, /class="ch-conn"/, "account menu shows connection dots");
  assert.match(html, /href="http:\/\/hub\.test\/settings"[^>]*>(<svg[\s\S]*?<\/svg>)?Settings<\/a>/, "account menu has Settings");
  for (const sec of ["connections", "alerts", "page", "people", "notifications", "privacy", "account"]) assert.match(html, new RegExp(`id="${sec}"`), sec);
  let st = await (await fetch(base + "/settings/status", { headers: { cookie: s.sess } })).json();
  assert.equal(st.conn.github.on, true); assert.equal(st.conn.obsidian.on, false); assert.equal(st.conn.hosted, true);
  // claim code in-page; cross-site refused
  assert.equal((await fetch(base + "/settings/claim", { method: "POST", headers: { cookie: s.sess, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  const cl = await (await fetch(base + "/settings/claim", { method: "POST", headers: { cookie: s.sess, origin: "http://hub.test", "content-type": "application/json" }, body: "{}" })).json();
  assert.match(cl.code, /^CAL-/); assert.ok(cl.expires > Date.now());
  const claimed = await (await fetch(base + "/v1/github/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: cl.code }) })).json();
  assert.equal(claimed.handle, "newbie");
  st = await (await fetch(base + "/settings/status", { headers: { cookie: s.sess } })).json();
  assert.equal(st.conn.obsidian.on, true, "turns green once Obsidian claims it");
  assert.match(await (await fetch(base + "/settings", { headers: { cookie: s.sess } })).text(), /published from Obsidian/);
  // privacy form keeps page fields; save keeps privacy
  // a vault owner (owner cookie) whose page lists a GitHub login they haven't linked yet
  const mk = C.newIdentity(); await publish(mk, { name: "Vault Person", handle: "vaultp", links: [["GitHub", "https://github.com/vp-login"]] });
  const t = crypto.randomBytes(32).toString("hex");
  h.db.prepare("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(crypto.createHash("sha256").update(t).digest("hex"), mk.id, new Date().toISOString(), Date.now() + 86_400_000);
  const vh = await (await fetch(base + "/settings", { headers: { cookie: "cal_own=" + t } })).text();
  assert.match(vh, /published from Obsidian/); assert.match(vh, /Listed on your page, not linked yet/); assert.match(vh, /github\.com\/vp-login/);
  assert.match(vh, /Edited from Obsidian/, "page fields are read-only for vault pages");
  assert.match(vh, /id="conn-private"/, "vault owners get the private view row");
  // another person's cookie can't see this owner's settings: settings is always "mine"
  assert.doesNotMatch(await (await fetch(base + "/settings", { headers: { cookie: s.sess } })).text(), /<h1>Vault Person<\/h1>/);
  h.server.close();
});

test("alerts: pinned first, audience, unread badge on the owner's bar, seen beacon, /alerts marks read, release dedupe", async () => {
  const { h } = hubWith(); const { base, publish } = await start(h);
  const mk = C.newIdentity(); await publish(mk, { name: "Mike", handle: "mike", links: [] });
  const t = crypto.randomBytes(32).toString("hex");
  h.db.prepare("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(crypto.createHash("sha256").update(t).digest("hex"), mk.id, new Date().toISOString(), Date.now() + 86_400_000);
  const ck = { cookie: "cal_own=" + t, "user-agent": "Mozilla/5.0" };
  const nw = C.newIdentity(); await publish(nw, { name: "New", handle: "newbie", links: [] });
  h.db.prepare("UPDATE profiles SET created=? WHERE id=?").run("2020-01-01T00:00:00.000Z", mk.id);   // Mike joined long before the news below
  const old = h.admin.alertPost({ title: "Older news", body: "Hello **there** and [the guide](/guide)\n\n- one\n- two", ts: new Date(Date.now() - 60_000).toISOString() }).posted;
  const pin = h.admin.alertPost({ title: "Welcome to Caldera - from Mike", body: "Hi.", pinned: true, copyText: "THE PROMPT", copyLabel: "Copy the setup prompt", ctaLabel: "Read the guide", ctaUrl: "/guide", ts: new Date(Date.now() - 120_000).toISOString() }).posted;
  h.admin.alertPost({ title: "GitHub people only", body: "x", audience: "github" });
  const list = h.admin.alertList(); assert.equal(list[0].id, pin, "pinned on top");
  // the owner's public page carries the bell with an unread badge of 2 (the github-only one is not for a vault page)
  let page = await (await fetch(base + "/@mike/", { headers: ck })).text();
  assert.match(page, /class="ch-bell"/); assert.match(page, /<span class="ch-badge">2<\/span>/);
  assert.match(page, /Welcome to Caldera - from Mike/); assert.doesNotMatch(page, /GitHub people only/);
  assert.match(page, /Older news/, "the bell lists titles; bodies are on /alerts");
  assert.ok(page.indexOf("Welcome to Caldera") < page.indexOf("Older news"), "pinned listed first");
  // a member who joined after that news starts at zero unread, except the pinned welcome
  { const t2 = crypto.randomBytes(32).toString("hex");
    h.db.prepare("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(crypto.createHash("sha256").update(t2).digest("hex"), nw.id, new Date().toISOString(), Date.now() + 86_400_000);
    assert.match(await (await fetch(base + "/@newbie/", { headers: { cookie: "cal_own=" + t2, "user-agent": "Mozilla/5.0" } })).text(), /<span class="ch-badge">1<\/span>/, "only the pinned welcome is unread"); }
  // anonymous visitors see no bell
  assert.doesNotMatch(await (await fetch(base + "/@mike/", { headers: { "user-agent": "Mozilla/5.0" } })).text(), /ch-bell/);
  // the seen beacon (signed token) clears the badge; a forged token does nothing
  assert.equal((await fetch(base + "/v1/alerts/seen?t=forged.sig")).status, 200);
  const seen = page.match(/data-seen="([^"]+)"/)[1].replace(/&amp;/g, "&").replace("http://hub.test", base);
  assert.equal((await fetch(seen)).status, 200);
  page = await (await fetch(base + "/@mike/", { headers: ck })).text();
  assert.doesNotMatch(page, /<span class="ch-badge">/, "all read");
  // a new alert shows up unread; /alerts lists and marks it read
  h.admin.alertPost({ title: "Fresh", body: "new" });
  assert.match(await (await fetch(base + "/@mike/", { headers: ck })).text(), /<span class="ch-badge">1<\/span>/);
  const al = await (await fetch(base + "/alerts", { headers: ck })).text(); assert.match(al, /Fresh/); assert.match(al, /THE PROMPT/, "copy text is in the page for the copy button");
  assert.doesNotMatch(await (await fetch(base + "/@mike/", { headers: ck })).text(), /<span class="ch-badge">/, "/alerts marked it read");
  assert.equal((await fetch(base + "/alerts", { redirect: "manual" })).headers.get("location"), "/signin");
  // releases post once per version
  const a1 = h.admin.alertPost({ title: "New in Caldera 9.9.9: x", body: "- y", version: "9.9.9" }).posted, a2 = h.admin.alertPost({ title: "again", body: "z", version: "9.9.9" }).posted;
  assert.equal(a1, a2);
  assert.ok(h.admin.alertDelete(old).deleted); assert.equal(h.admin.alertPin(pin, false).ok, true);
  h.server.close();
});
