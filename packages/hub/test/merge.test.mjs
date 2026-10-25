// One person, one profile: duplicate profiles merge (admin and automatically when GitHub links to a vault page), and the
// sign-up paths never make a second profile for an address or GitHub account that already has one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

const ORIGIN = "http://hub.test";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const USERS = { kyle: { id: 218021945, login: "kyle-gh", emails: [{ email: "kyle@realmail.org", primary: true, verified: true }] },
  dana: { id: 99, login: "dana-gh", emails: [{ email: "dana@realmail.org", primary: true, verified: true }] } };

function hubWith() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-merge-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const byTok = new Map();
  const fake = async (u, init = {}) => { u = String(u);
    const who = byTok.get(String(init.headers?.authorization || init.headers?.Authorization || "").replace(/^(token|Bearer)\s+/i, ""));
    if (u.endsWith("/access_token")) { const code = JSON.parse(init.body || "{}").code; byTok.set("tok-" + code, USERS[code]); return J({ access_token: "tok-" + code, expires_in: 28800 }); }
    if (u.endsWith("/user/emails")) return who ? J(who.emails) : J({}, 403);
    if (u.endsWith("/user")) { const x = who || {}; return J({ id: x.id, login: x.login, name: x.login, blog: x.blog || "", created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/" + x.login, avatar_url: "https://avatars.githubusercontent.com/u/1" }); }
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  const mails = [];
  const h = createHub({ dataDir: d, publicUrl: ORIGIN, githubFetch: fake, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  return { h, d, mails };
}
async function start(h) {
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const publish = (id, body) => fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { boxKey: id.boxPublic, ...body }), files: { "index.html": Buffer.from("<html><head></head><body>hi</body></html>").toString("base64") } }) });
  const form = (p, body, cookie = "") => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const signIn = async (code, hParam = "", cookie = "") => {
    const a = await fetch(base + "/auth/github" + (hParam ? "?h=" + hParam : ""), { redirect: "manual", headers: cookie ? { cookie } : {} });
    const jar = [...(a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("=")), ...(cookie ? [cookie] : [])];
    const state = new URL(a.headers.get("location")).searchParams.get("state");
    const cb = await fetch(base + `/auth/github/callback?code=${code}&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
    const set = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]);
    return { cb, loc: cb.headers.get("location"), own: set.find(c => /^cal_own=[0-9a-f]{64}$/.test(c)), sess: set.find(c => c.startsWith("cal_s=")), body: cb.status === 302 ? "" : await cb.text() };
  };
  return { base, post, publish, form, signIn };
}
const n = (h, sql, ...a) => h.db.prepare(sql).get(...a).n;
const idOf = (h, handle) => h.db.prepare("SELECT id FROM profiles WHERE handle=?").get(handle)?.id;
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test("email sign-up (/start) with the address of an existing GitHub member: no new profile, the mail signs in to THAT page", async () => {
  const { h, d, mails } = hubWith(); const { base, form, signIn } = await start(h);
  const gh = await signIn("kyle");   // a GitHub sign-up: its verified address is on file
  assert.equal(gh.loc, "/me?welcome=1");
  const kyle = h.db.prepare("SELECT profile_id, handle FROM gh_accounts WHERE gh_id=?").get(USERS.kyle.id);
  await until(() => !!idOf(h, kyle.handle));
  const profiles = n(h, "SELECT COUNT(*) n FROM profiles");
  mails.length = 0;
  const r = await form("/start", { text: "name: Kyle B\nheadline: I build things", email: "Kyle@RealMail.org" });
  assert.equal(r.status, 200); assert.match(await r.text(), /Check your email/);
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /already have a Caldera page/); assert.match(mails[0].text, new RegExp("@" + kyle.handle));
  assert.equal(n(h, "SELECT COUNT(*) n FROM email_pending"), 0, "no sign-up link was issued");
  // an empty box with that address: the same way back, never "paste your profile first"
  assert.match(await (await form("/start", { text: "", email: "kyle@realmail.org" })).text(), /Check your email/);
  assert.equal(n(h, "SELECT COUNT(*) n FROM profiles"), profiles, "no second profile");
  assert.equal(n(h, "SELECT COUNT(*) n FROM email_accounts"), 0);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("a /start link confirmed after the address became a member's signs in to that member; a GitHub sign-up with an email page's address makes no second page", async () => {
  const { h, d, mails } = hubWith(); const { base, form, signIn } = await start(h);
  // the email link goes out while nobody owns the address...
  await form("/start", { text: "name: Kyle B\nheadline: I build things", email: "kyle@realmail.org" });
  const link = mails.at(-1).text.match(/https?:\/\/\S+start\/confirm\?t=(\S+)/)[1];
  // ...then they sign up with GitHub (verified address kyle@realmail.org) before opening it
  const gh = await signIn("kyle"); assert.equal(gh.loc, "/me?welcome=1");
  const kyle = h.db.prepare("SELECT profile_id, handle FROM gh_accounts WHERE gh_id=?").get(USERS.kyle.id);
  await until(() => !!idOf(h, kyle.handle));
  const before = n(h, "SELECT COUNT(*) n FROM profiles");
  const c = await form("/start/confirm", { t: link });
  assert.equal(c.status, 302); assert.equal(c.headers.get("location"), `/@${kyle.handle}/`);
  assert.ok((c.headers.getSetCookie?.() || []).some(x => x.startsWith("cal_own=")), "signed in as the GitHub member");
  assert.equal(n(h, "SELECT COUNT(*) n FROM profiles"), before); assert.equal(n(h, "SELECT COUNT(*) n FROM email_accounts"), 0);
  // the other way round: an email page first, then GitHub with the same verified address -> signs in to the email page
  await form("/start", { text: "name: Dana Lee\nheadline: Restaurants", email: "dana@realmail.org" });
  const t2 = mails.at(-1).text.match(/https?:\/\/\S+start\/confirm\?t=(\S+)/)[1];
  const c2 = await form("/start/confirm", { t: t2 }); assert.equal(c2.status, 302);
  const dana = h.db.prepare("SELECT profile_id, handle FROM email_accounts").get();
  const p2 = n(h, "SELECT COUNT(*) n FROM profiles");
  const g2 = await signIn("dana");
  assert.equal(g2.loc, `/@${dana.handle}/`); assert.ok(g2.own, "owner cookie for the email page");
  assert.equal(n(h, "SELECT COUNT(*) n FROM profiles"), p2, "no GitHub page made"); assert.equal(n(h, "SELECT COUNT(*) n FROM gh_accounts WHERE gh_id=?", USERS.dana.id), 0);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("GitHub linked to a vault page while the same GitHub account has its own page: the GitHub page merges into the vault page", async () => {
  const { h, d } = hubWith(); const { base, post, publish, signIn } = await start(h);
  const ana = C.newIdentity(), bo = C.newIdentity(), vault = C.newIdentity();
  await publish(ana, { name: "Ana", handle: "ana", links: [] }); await publish(bo, { name: "Bo", handle: "bo", links: [] });
  // 1. Kyle signs up with GitHub: a hosted page; Ana and he become friends, he follows Bo, Ana gives kudos
  const gh = await signIn("kyle"); assert.equal(gh.loc, "/me?welcome=1");
  const acct = h.db.prepare("SELECT * FROM gh_accounts WHERE gh_id=?").get(USERS.kyle.id), oldId = acct.profile_id, oldHandle = acct.handle;
  assert.ok(await until(() => !!idOf(h, oldHandle)), "hosted page built");
  h.db.prepare("INSERT INTO friends (a, b, ts, kind) VALUES (?,?,?,?), (?,?,?,?)").run(ana.id, oldId, "2026-10-01T00:00:00Z", "request", oldId, ana.id, "2026-10-01T00:00:00Z", "request");
  const sess = gh.sess; const fol = await fetch(base + "/v1/friend/bo", { method: "POST", headers: { "content-type": "application/json", cookie: sess, origin: ORIGIN }, body: "{}" });
  assert.equal(fol.status, 200, "he follows Bo (signed by the hub with his hosted key)");
  h.db.prepare("INSERT INTO kudos VALUES (?,?,?,?,?,?)").run(ana.id, oldId, "fire", new Date().toISOString(), "2026-10-19", "");
  h.db.prepare("INSERT INTO ledger VALUES (?,?,?,?,?)").run(oldId, 25, "invited @someone", "x", new Date().toISOString());
  const site = h.db.prepare("SELECT key FROM traffic_sites WHERE owner=?").get(oldId)?.key;
  // 2. He installs Obsidian: a vault profile listing his GitHub, and proves it (GitHub bio links to the page)
  await publish(vault, { name: "Bartlett Labs", handle: "bartlett-labs", links: [["GitHub", "https://github.com/kyle-gh"]] });
  USERS.kyle.blog = "https://caldera.social/@bartlett-labs";
  const r = await signIn("kyle", "bartlett-labs");
  assert.equal(r.loc, "/@bartlett-labs/"); assert.ok(r.own, "owner cookie for the vault page");
  // one profile left, the graph carried over
  assert.equal(idOf(h, oldHandle), undefined, "the GitHub page is gone");
  assert.equal(n(h, "SELECT COUNT(*) n FROM profiles WHERE id IN (?,?)", oldId, vault.id), 1);
  assert.equal(n(h, "SELECT COUNT(*) n FROM friends WHERE a=? AND b=?", vault.id, ana.id), 1, "friends carried (both ways)");
  assert.equal(n(h, "SELECT COUNT(*) n FROM friends WHERE a=? AND b=?", ana.id, vault.id), 1);
  assert.equal(n(h, "SELECT COUNT(*) n FROM friends WHERE a=? OR b=?", oldId, oldId), 0);
  assert.equal(n(h, "SELECT COUNT(*) n FROM friend_intents WHERE owner=? AND target=?", vault.id, bo.id), 1, "his follow of Bo carried");
  assert.equal(n(h, "SELECT COUNT(*) n FROM kudos WHERE recipient=?", vault.id), 1);
  assert.equal(n(h, "SELECT COUNT(*) n FROM ledger WHERE who=? AND reason='welcome'", vault.id), 1, "no second welcome bonus");
  assert.equal(n(h, "SELECT COUNT(*) n FROM ledger WHERE who=? AND delta=25", vault.id), 1, "earned credit carried");
  if (site) assert.equal(h.db.prepare("SELECT owner FROM traffic_sites WHERE key=?").get(site).owner, vault.id, "website snippet keys keep working");
  // GitHub now lands on the vault page; the old handle redirects; nobody else can take it
  const g = h.db.prepare("SELECT * FROM gh_accounts WHERE gh_id=?").get(USERS.kyle.id);
  assert.equal(g.profile_id, vault.id); assert.ok(g.claimed); assert.equal(g.key_sealed, "");
  assert.equal(h.db.prepare("SELECT profile_id FROM gh_links WHERE gh_id=?").get(USERS.kyle.id).profile_id, vault.id);
  const again = await signIn("kyle"); assert.equal(again.loc, "/@bartlett-labs/"); assert.ok(again.own);
  for (const sub of ["/", "/city.html", "/n/x.html"]) {
    const rr = await fetch(base + `/@${oldHandle}${sub}`, { redirect: "manual" });
    assert.equal(rr.status, 302, sub); assert.equal(rr.headers.get("location"), `/@bartlett-labs${sub}`);
  }
  const squat = C.newIdentity();
  assert.equal((await post("/v1/envelopes", C.sign(squat, "profile.manifest", { handle: oldHandle, name: "Not Kyle", boxKey: squat.boxPublic }))).status, 403, "the old handle stays his");
  assert.equal(n(h, "SELECT COUNT(*) n FROM profile_merges"), 1);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("admin merge: friends, kudos, messages and credit move, welcome bonus doesn't, the old handle redirects and is kept for the survivor", async () => {
  const { h, d } = hubWith(); const { base, post, publish } = await start(h);
  const a = C.newIdentity(), b = C.newIdentity(), ana = C.newIdentity(), bo = C.newIdentity(), cy = C.newIdentity();
  await publish(a, { name: "Kyle", handle: "kyle-old", links: [] }); await publish(b, { name: "Kyle", handle: "kyle-new", links: [] });
  await publish(ana, { name: "Ana", handle: "ana", links: [] }); await publish(bo, { name: "Bo", handle: "bo", links: [] }); await publish(cy, { name: "Cy", handle: "cy", links: [] });
  // a and ana are friends (both follow), a and b are friends with each other, b and bo are friends; a follows cy
  for (const [x, y] of [[a, ana], [ana, a], [a, b], [b, a], [b, bo], [bo, b]]) assert.equal((await post("/v1/envelopes", C.sign(x, "friend.request", { to: y.id }))).status, 200);
  await post("/v1/envelopes", C.sign(a, "friend.request", { to: cy.id }));
  h.db.prepare("INSERT INTO kudos VALUES (?,?,?,?,?,?)").run(ana.id, a.id, "fire", new Date().toISOString(), "2026-10-19", "");
  h.db.prepare("INSERT INTO msg_threads VALUES (?,?,?,?,?,?,?,?)").run("t1", ...[a.id, ana.id].sort(), "open", null, "2026-10-01", "2026-10-02", null);
  h.db.prepare("INSERT INTO msg_messages VALUES (?,?,?,?,?,?)").run("m1", "t1", ana.id, "hi kyle", "2026-10-02", null);
  h.db.prepare("INSERT INTO msg_threads VALUES (?,?,?,?,?,?,?,?)").run("t2", ...[b.id, ana.id].sort(), "open", null, "2026-10-03", "2026-10-03", null);
  h.db.prepare("INSERT INTO msg_messages VALUES (?,?,?,?,?,?)").run("m2", "t2", b.id, "hi ana", "2026-10-03", null);
  const out = h.admin.merge("@kyle-old", "kyle-new", "same person");
  assert.equal(out.merged, "kyle-old"); assert.equal(out.into, "kyle-new");
  assert.equal(idOf(h, "kyle-old"), undefined);
  const friendsOf = id => h.db.prepare("SELECT b FROM friends WHERE a=? ORDER BY b").all(id).map(r => r.b);
  assert.deepEqual(friendsOf(b.id), [ana.id, bo.id].sort(), "union of both friend lists, no self-friendship");
  assert.equal(out.friends, 2);
  assert.equal(n(h, "SELECT COUNT(*) n FROM friend_intents WHERE owner=? AND target=?", b.id, cy.id), 1, "the old key's follow of Cy is queued for the survivor");
  assert.equal(n(h, "SELECT COUNT(*) n FROM kudos WHERE recipient=?", b.id), 1);
  assert.equal(n(h, "SELECT COUNT(*) n FROM msg_threads WHERE a=? OR b=?", b.id, b.id), 1, "the two conversations with Ana are one");
  assert.equal(n(h, "SELECT COUNT(*) n FROM msg_messages WHERE thread='t2'"), 2);
  assert.equal(n(h, "SELECT COALESCE(SUM(delta),0) n FROM ledger WHERE who=?", b.id), C.STARTING_CREDITS, "one welcome bonus");
  const rr = await fetch(base + "/@kyle-old/", { redirect: "manual" }); assert.equal(rr.status, 302); assert.equal(rr.headers.get("location"), "/@kyle-new/");
  assert.equal((await fetch(base + "/@Kyle-Old", { redirect: "follow" })).url, base + "/@kyle-new/");
  // another key can't take the old handle; the survivor can take it back as their own
  const squat = C.newIdentity();
  assert.equal((await post("/v1/envelopes", C.sign(squat, "profile.manifest", { handle: "kyle-old", name: "X", boxKey: squat.boxPublic }))).status, 403);
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await publish(b, { name: "Kyle", handle: "kyle-old", links: [] })).status, 200);
  assert.equal(idOf(h, "kyle-old"), b.id); assert.equal(n(h, "SELECT COUNT(*) n FROM handle_aliases"), 0);
  assert.throws(() => h.admin.merge("kyle-old", "kyle-old"), /same profile/);
  assert.throws(() => h.admin.merge("nobody", "kyle-old"), /no profile/);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("a GitHub page whose GitHub account is already linked to a vault page folds into it on the next GitHub sign-in", async () => {
  const { h, d } = hubWith(); const { publish, signIn } = await start(h);
  USERS.dana.emails = [];   // no verified address to match on: the link alone decides
  const gh = await signIn("dana"); assert.equal(gh.loc, "/me?welcome=1");
  const acct = h.db.prepare("SELECT * FROM gh_accounts WHERE gh_id=?").get(USERS.dana.id);
  assert.ok(await until(() => !!idOf(h, acct.handle)));
  const vault = C.newIdentity();
  await publish(vault, { name: "Dana", handle: "dana-vault", links: [["GitHub", "https://github.com/dana-gh"]] });
  h.db.prepare("INSERT INTO gh_links VALUES (?,?,?,?)").run(USERS.dana.id, "dana-gh", vault.id, new Date().toISOString());
  const r = await signIn("dana");
  assert.equal(r.loc, "/@dana-vault/"); assert.ok(r.own);
  assert.equal(idOf(h, acct.handle), undefined, "the GitHub page merged away");
  assert.equal(h.db.prepare("SELECT profile_id FROM gh_accounts WHERE gh_id=?").get(USERS.dana.id).profile_id, vault.id);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});
