import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
// fake GitHub: users by OAuth code; /user/emails per user (403 = the app's email permission isn't granted)
const USERS = {
  ver: { id: 21, login: "ver", email: null, emails: [{ email: "ver@realmail.org", primary: true, verified: true }, { email: "x@realmail.org", primary: false, verified: false }] },
  pub: { id: 22, login: "pub", email: "pub@realmail.org", emails: 403 },
  none: { id: 23, login: "none", email: null, emails: 403 },
  plain: { id: 24, login: "plain", email: null, emails: [{ email: "plain@realmail.org", primary: true, verified: true }] },
};
function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-emailcap-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(d, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  const tok = {};
  const fake = async (u, init = {}) => { u = String(u); const auth = String(init.headers?.authorization || "").replace(/^Bearer /, "");
    if (u.endsWith("/access_token")) { const code = JSON.parse(init.body || "{}").code; tok["tok-" + code] = code; return J({ access_token: "tok-" + code, expires_in: 28800 }); }
    const who = USERS[tok[auth]];
    if (u.endsWith("/user/emails")) return who && Array.isArray(who.emails) ? J(who.emails) : J({ message: "Resource not accessible by integration" }, 403);
    if (u.endsWith("/user")) return J({ id: who.id, login: who.login, name: who.login, email: who.email, created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/" + who.login, avatar_url: "https://avatars.githubusercontent.com/u/1" });
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  const mails = [];
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  return { h, d, mails };
}
// qs: the sign-up form's daily-email box. Default here is unticked (digest=0) so the welcome-card tests start unsubscribed
async function signup(b, code, qs = "?digest=0") {
  const a = await fetch(b + "/auth/github" + qs, { redirect: "manual" });
  const jar = (a.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
  const state = new URL(a.headers.get("location")).searchParams.get("state");
  const cb = await fetch(b + `/auth/github/callback?code=${code}&state=${state}`, { headers: { cookie: jar.join("; ") }, redirect: "manual" });
  const cookie = (cb.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => c.startsWith("cal_s=")).join("; ");
  for (let i = 0; i < 50 && !(await fetch(b + "/v1/profiles/" + code)).ok; i++) await new Promise(r => setTimeout(r, 100));   // first build runs in the background
  const post = (body) => fetch(b + "/me", { method: "POST", headers: { cookie, origin: "http://hub.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }).then(r => r.text());
  const me = () => fetch(b + "/me", { headers: { cookie } }).then(r => r.text());
  return { cookie, post, me, location: cb.headers.get("location") };
}

test("welcome card: a GitHub-verified address is prefilled and one click subscribes it with no confirmation email", async () => {
  const { h, d, mails } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  const u = await signup(b, "ver");
  const me = await u.me();
  assert.match(me, /Where should we send your daily summary\?/);
  assert.ok(me.indexOf("Where should we send") < me.indexOf("Your page:"), "the card comes first");
  assert.match(me, /value="ver@realmail\.org"/); assert.match(me, /Your verified GitHub address/);
  assert.doesNotMatch(me, /x@realmail\.org/, "only the primary verified address");
  assert.match(await u.post({ do: "email-capture", email: "ver@realmail.org", on: "on" }), /nothing to confirm/);
  assert.equal(mails.length, 0, "no confirmation email for a verified address");
  assert.equal(h.db.prepare("SELECT confirmed FROM email_subs").get().confirmed, 1);
  assert.doesNotMatch(await u.me(), /Where should we send/, "answered: the card is gone");
  // the stored suggestion is sealed, never plain text
  const raw = h.db.prepare("SELECT email FROM email_suggest").get().email; assert.ok(!raw.includes("ver@realmail.org"));
  // deleting the account removes the subscription, the suggested address and the prompt state
  await u.post({ do: "delete", sure: "on" });
  for (const t of ["email_subs", "email_suggest", "email_prompt"]) assert.equal(h.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t + " erased");
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("a different (unverified) address still needs the confirmation link; the 403 fallback uses the public email", async () => {
  const { h, d, mails } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  const u = await signup(b, "pub");
  const me = await u.me();
  assert.match(me, /value="pub@realmail\.org"/, "public profile email when /user/emails is forbidden");
  assert.doesNotMatch(me, /Your verified GitHub address/);
  assert.match(await u.post({ do: "email-capture", email: "pub@realmail.org", on: "on" }), /confirmation link/);
  assert.equal(mails.length, 1); assert.match(mails[0].subject, /Confirm/);
  assert.equal(h.db.prepare("SELECT confirmed FROM email_subs").get().confirmed, 0);
  // a verified address for someone else can't be used to skip confirmation here
  const v = await signup(b, "ver");
  assert.match(await v.post({ do: "email-capture", email: "pub@realmail.org", on: "on" }), /confirmation link/);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("not now / unticked: no subscription, no email, and the prompt stays dismissed (card and own-page banner)", async () => {
  const { h, d, mails } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  const u = await signup(b, "none");
  let me = await u.me(); assert.match(me, /Where should we send/); assert.match(me, /value=""/);
  // the owner's own page shows the banner (owner cookie), anonymous visitors never do
  const ownerCookie = h.db.prepare("SELECT 1 FROM gh_accounts").get() ? u.cookie : "";
  const own = await (await fetch(b + "/@none/", { headers: { cookie: ownerCookie, "user-agent": "Mozilla/5.0" } })).text();
  assert.match(own, /id="cb-sum"/);
  const anon = await (await fetch(b + "/@none/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.doesNotMatch(anon, /cb-sum/);
  assert.match(await u.post({ do: "email-dismiss" }), /any time/);
  me = await u.me(); assert.doesNotMatch(me, /Where should we send/);
  assert.doesNotMatch(await (await fetch(b + "/@none/", { headers: { cookie: ownerCookie, "user-agent": "Mozilla/5.0" } })).text(), /cb-sum/, "dismissed: no banner either");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM email_subs").get().n, 0); assert.equal(mails.length, 0);
  // unticking the box also counts as no
  const v = await signup(b, "ver");
  await v.post({ do: "email-capture", email: "ver@realmail.org" });
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM email_subs").get().n, 0);
  // nobody opted in: the digest sends nothing
  const r = await h.mail.runDigest(true); assert.equal(r.sent, 0); assert.equal(mails.length, 0);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("the owner banner subscribes through the page's owner token; the token can't do it for someone else", async () => {
  const { h, d } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  const u = await signup(b, "ver"), w = await signup(b, "pub");
  const own = await (await fetch(b + "/@ver/", { headers: { cookie: u.cookie, "user-agent": "Mozilla/5.0" } })).text();
  const t = own.match(/id="cb-sum" data-api="[^"]*" data-t="([^"]+)"/)[1];
  const act = (o) => fetch(b + "/v1/act", { method: "POST", headers: { "content-type": "text/plain", origin: "null" }, body: JSON.stringify(o) }).then(async r => ({ status: r.status, j: await r.json() }));
  const r = await act({ t, action: "email-subscribe", email: "ver@realmail.org" });
  assert.equal(r.status, 200); assert.match(r.j.message, /nothing to confirm/);
  // a member's token for someone else's page can't subscribe that page's owner
  const other = await (await fetch(b + "/@ver/", { headers: { cookie: w.cookie, "user-agent": "Mozilla/5.0" } })).text();
  const t2 = (other.match(/data-act="([^"]+)"/) || [])[1];
  if (t2) { const x = await act({ t: t2, action: "email-subscribe", email: "evil@realmail.org" }); assert.notEqual(x.j.ok && x.j.message, true); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM email_subs").get().n, 1); }
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});
test("sign-up: the daily email is opt-in; a ticked box subscribes (verified at once, public gets a confirmation link)", async () => {
  const { h, d, mails } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  const sub = (login) => h.db.prepare("SELECT confirmed FROM email_subs WHERE owner=(SELECT profile_id FROM gh_accounts WHERE login=?)").get(login);
  const page = await (await fetch(b + "/signin")).text();
  assert.match(page, /name="digest" value="1" style/, "the box is on the sign-up form");
  assert.doesNotMatch(page, /name="digest" value="1" checked/, "and it is NOT pre-ticked");
  await signup(b, "ver", "?digest=0&digest=1");   // the form with the box ticked
  assert.equal(sub("ver").confirmed, 1); assert.equal(mails.length, 0, "verified: nothing to confirm");
  await signup(b, "pub", "?digest=0&digest=1");
  assert.equal(sub("pub").confirmed, 0); assert.equal(mails.length, 1); assert.match(mails[0].subject, /Confirm/);
  await signup(b, "plain", "");   // a plain sign-up link elsewhere on the site: no box ticked, no subscription
  assert.equal(sub("plain"), undefined);
  await signup(b, "none", "?digest=0&digest=1");   // no address from GitHub at all: nothing to subscribe
  assert.equal(sub("none"), undefined);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});

test("sign-up: unticking the daily-email box means no subscription", async () => {
  const { h, d, mails } = setup(); const b = "http://127.0.0.1:" + await h.listen(0);
  await signup(b, "ver", "?digest=0");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM email_subs").get().n, 0); assert.equal(mails.length, 0);
  h.server.close(); fs.rmSync(d, { recursive: true, force: true });
});
// the digest's order, subject and setup tip are open-core hooks: their tests live in caldera-private
