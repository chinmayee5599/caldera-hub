import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createHub } from "../dist/server.js";

// Every way to sign up, followed to a live, signed-in account: GitHub (fake GitHub), email + an AI (/start), and the
// emailed sign-up link. Email sign-up was off the sign-up pages Oct 20-27, 2026 and sign-ups fell ~75%; this keeps it on.
const ORIGIN = "http://hub.test";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const USERS = { newgh: { id: 81, login: "newgh" }, msggh: { id: 82, login: "msggh" } };
let hub, base, dir; const mails = [];
const jar = r => (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
const form = (p, body, cookie = "") => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
const linkIn = m => m.text.match(/https?:\/\/\S+/g).map(u => u.replace(ORIGIN, base));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-signup-paths-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(dir, "github-app.json"), JSON.stringify({ id: 1, slug: "t", client_id: "cid", client_secret: "csec", pem: privateKey.export({ type: "pkcs1", format: "pem" }) }));
  let who = "newgh";
  const fake = async (u, init = {}) => { u = String(u);
    if (u.endsWith("/access_token")) { who = JSON.parse(init.body || "{}").code; return J({ access_token: "tok-" + who, token_type: "bearer", scope: "user:email" }); }
    if (u.endsWith("/user")) { const x = USERS[who]; return J({ ...x, name: x.login, created_at: "2019-01-01T00:00:00Z", public_repos: 1, followers: 1, html_url: "https://github.com/" + x.login, avatar_url: "https://avatars.githubusercontent.com/u/1" }); }
    if (u.endsWith("/user/emails")) return J([{ email: who + "@example.com", primary: true, verified: true }]);
    if (u.includes("avatars.githubusercontent.com")) return new Response(Buffer.from("png"));
    if (u.includes("/repos?") || u.includes("/events")) return J([]);
    return J({}, 404); };
  hub = createHub({ dataDir: dir, publicUrl: ORIGIN, githubFetch: fake, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  // someone to message: a member made with email
  await form("/start", { text: "name: Host Person\nheadline: Runs the meetup", email: "host@example.com" });
  const t = new URL(linkIn(mails.at(-1)).find(u => u.includes("/start/confirm"))).searchParams.get("t");
  assert.equal((await form("/start/confirm", { t })).status, 302);
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("every sign-up surface offers GitHub, email and Obsidian", async () => {
  const msg = await (await fetch(base + "/signin?back=%2Fmessages%2F%40host-person")).text();
  const gen = await (await fetch(base + "/signin")).text();
  for (const [name, html] of [["Message sign-up page", msg], ["general sign-in page", gen]]) {
    assert.match(html, /Sign up with GitHub/, name); assert.match(html, /href="\/start[^"]*">Sign up with email</, name); assert.match(html, /Sign up with Obsidian/, name);
  }
  // the signed-out join panel (profile Follow/Message/Kudos, feed actions) has an email button, not just a small link
  const page = await (await fetch(base + "/@host-person/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.match(page, /cg-em/); assert.match(page, /'Sign up with email'/);
  const home = await (await fetch(base + "/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  if (/id="install"/.test(home)) { assert.match(home, /href="\/auth\/github"/); assert.match(home, /href="\/start"/); }
});

test("GitHub sign-up from a Message button: GitHub -> back -> new account, signed in, welcome then the conversation", async () => {
  const a = await fetch(base + "/auth/github?back=%2Fmessages%2F%40host-person&invite=host-person&digest=1", { redirect: "manual" });
  assert.equal(a.status, 302);
  const to = new URL(a.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("redirect_uri"), ORIGIN + "/auth/github/callback");
  const cb = await fetch(base + `/auth/github/callback?code=msggh&state=${to.searchParams.get("state")}`, { headers: { cookie: jar(a).join("; ") }, redirect: "manual" });
  assert.equal(cb.status, 302, await cb.clone().text().catch(() => ""));
  assert.match(cb.headers.get("location"), /^\/me\?welcome=1&back=%2Fmessages%2F%40host-person$/);
  const cookie = jar(cb).join("; "); assert.match(cookie, /cal_s=[0-9a-f]+/, "signed in (GitHub session)");
  const me = await fetch(base + "/me?welcome=1", { headers: { cookie }, redirect: "manual" });
  assert.ok([200, 302].includes(me.status)); assert.doesNotMatch(me.headers.get("location") || "", /signin/);
  const conv = await fetch(base + "/messages/@host-person", { headers: { cookie }, redirect: "manual" });
  assert.equal(conv.status, 200, "lands in the conversation, not back at sign-in");
  assert.equal((await fetch(base + "/@msggh/")).status, 200, "their page is live");
});

test("GitHub sign-up from the homepage button: a brand-new account with the welcome", async () => {
  const a = await fetch(base + "/auth/github", { redirect: "manual" });
  const state = new URL(a.headers.get("location")).searchParams.get("state");
  const cb = await fetch(base + `/auth/github/callback?code=newgh&state=${state}`, { headers: { cookie: jar(a).join("; ") }, redirect: "manual" });
  assert.equal(cb.status, 302); assert.match(cb.headers.get("location"), /^\/me\?welcome=1/);
  assert.equal((await fetch(base + "/@newgh/")).status, 200);
});

test("email sign-up from a Message button: sign-up page -> /start -> email -> confirm -> signed in, in the conversation", async () => {
  const si = await (await fetch(base + "/signin?back=%2Fmessages%2F%40host-person")).text();
  const href = si.match(/href="(\/start[^"]*)">Sign up with email</)[1].replace(/&amp;/g, "&");
  const st = await (await fetch(base + href)).text();
  assert.match(st, /name="back" value="\/messages\/@host-person"/); assert.match(st, /name="invite" value="host-person"/);
  const n = mails.length;
  const r = await form("/start", { text: "name: Email Joiner\nheadline: Came from a message", email: "joiner@example.com", back: "/messages/@host-person", invite: "host-person" });
  assert.match(await r.text(), /Check your email/); assert.equal(mails.length, n + 1); assert.equal(mails.at(-1).to, "joiner@example.com");
  const link = linkIn(mails.at(-1)).find(u => u.includes("/start/confirm"));
  assert.match(await (await fetch(link)).text(), /One click to finish/);
  const c = await form("/start/confirm", { t: new URL(link).searchParams.get("t"), back: "/messages/@host-person", invite: "host-person" });
  assert.equal(c.status, 302); assert.equal(c.headers.get("location"), "/messages/@host-person");
  const cookie = jar(c).join("; ");
  assert.equal((await fetch(base + "/messages/@host-person", { headers: { cookie }, redirect: "manual" })).status, 200, "in the conversation, signed in");
  assert.equal((await fetch(base + "/@email-joiner/")).status, 200, "their page is live");
});

test("email sign-up from the homepage (/start, no invite): confirm -> their new page with the welcome", async () => {
  await form("/start", { text: "name: Plain Starter\nheadline: Builds things", email: "plain@example.com" });
  const link = linkIn(mails.at(-1)).find(u => u.includes("/start/confirm"));
  const c = await form("/start/confirm", { t: new URL(link).searchParams.get("t") });
  assert.equal(c.status, 302); assert.match(c.headers.get("location"), /^\/@plain-starter\/(city\.html)?\?welcome=1$/);
  assert.match(jar(c).join("; "), /cal_own=/);
});

test("emailed sign-up link (not signed in to GitHub on this device): email arrives and its links work", async () => {
  const n = mails.length;
  const r = await form("/signin/signup-email", { email: "later@example.com", back: "/messages/@host-person", invite: "host-person" });
  assert.ok(r.status < 400, "accepted"); assert.equal(mails.length, n + 1); assert.equal(mails.at(-1).to, "later@example.com");
  const links = linkIn(mails.at(-1));
  const gh = links.find(u => u.includes("/auth/github")); assert.ok(gh, "a Continue with GitHub link");
  const a = await fetch(gh, { redirect: "manual" }); assert.equal(a.status, 302); assert.match(a.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const alt = links.find(u => u.includes("/start")); assert.ok(alt, "a no-GitHub way");
  assert.equal((await fetch(alt)).status, 200);
});

test("left GitHub unfinished: /auth/github leaves a readable cal_ghtry marker, the callback clears it, the email offer opens /start", async () => {
  const a = await fetch(base + "/auth/github?back=%2Fmessages%2F%40host-person&invite=host-person", { redirect: "manual" });
  const mark = (a.headers.getSetCookie?.() || []).find(c => c.startsWith("cal_ghtry="));
  assert.ok(mark && mark.startsWith("cal_ghtry=1;"), "marker set"); assert.doesNotMatch(mark, /HttpOnly/i, "site.js must be able to read it");
  const cb = await fetch(base + "/auth/github/callback?error=access_denied", { redirect: "manual" });
  assert.ok((cb.headers.getSetCookie?.() || []).some(c => /^cal_ghtry=;.*Max-Age=0/.test(c)), "cleared when GitHub sends them back");
  const st = await fetch(base + "/start?via=gh-return&back=%2Fmessages%2F%40host-person&invite=host-person");
  assert.equal(st.status, 200); const html = await st.text();
  assert.match(html, /name="back" value="\/messages\/@host-person"/); assert.match(html, /name="invite" value="host-person"/);
});
