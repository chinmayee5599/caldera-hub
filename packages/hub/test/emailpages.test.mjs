import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../dist/server.js";

let hub, base, dir; const mails = [];
const ORIGIN = "http://hub.test";
const form = (p, body, cookie = "") => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-emailpages-"));
  hub = createHub({ dataDir: dir, publicUrl: ORIGIN, limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  base = "http://127.0.0.1:" + await hub.listen(0);
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const AI_ANSWER = "Sure! Here's your profile:\n```\n**name:** Dana Lee\nheadline: I build AI tools for small restaurants\nabout: I spent ten years running kitchens.\nNow I make software for them.\nlocation: Austin\nnow:\n- Shipping a menu planner\nprojects:\n- MenuMind | live | https://menumind.example | AI menu planning for small kitchens\n- Prep Pal | building | | Prep lists from sales\ntimeline:\n- 2015 | Opened my first restaurant | 40 seats\nlinks:\n- Website | https://dana.example\ntopics: restaurants, AI tools, operations\n```\nHope that helps!";

test("sign up with email + an AI: paste, confirm, page and city live, update grows the city, sign back in", async () => {
  const start = await (await fetch(base + "/start")).text();
  assert.match(start, /Copy the prompt/); assert.match(start, /name: &lt;my name&gt;/);
  // nothing readable: a clear error, no email sent
  assert.match(await (await form("/start", { text: "hello", email: "dana@example.com" })).text(), /couldn(&#39;|')t read that/);
  const r = await form("/start", { text: AI_ANSWER, email: "Dana@Example.com" });
  assert.match(await r.text(), /Check your email/); assert.equal(mails.length, 1);
  const link = mails[0].text.match(/https?:\/\/\S+start\/confirm\?t=\S+/)[0].replace(ORIGIN, base);
  const tok = new URL(link).searchParams.get("t");
  assert.match(await (await fetch(link)).text(), /One click to finish/, "opening the link (or a mail scanner) only shows a button");
  const c = await form("/start/confirm", { t: tok });
  assert.equal(c.status, 302); assert.equal(c.headers.get("location"), "/@dana-lee/city.html?welcome=1");
  const cookie = (c.headers.getSetCookie?.() || [c.headers.get("set-cookie")]).map(x => x.split(";")[0]).join("; ");
  assert.equal((await form("/start/confirm", { t: tok })).status, 400, "the link works once");
  const page = await (await fetch(base + "/@dana-lee/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.match(page, /<h1 class="title">Dana Lee/); assert.match(page, /I build AI tools for small restaurants/); assert.match(page, /In their words/);
  assert.match(page, /MenuMind/); assert.match(page, /Opened my first restaurant/); assert.doesNotMatch(page, /Untitled|Obsidian vault|FROM "Projects"|\$\{/);
  const city0 = await (await fetch(base + "/@dana-lee/city.html")).text(); assert.match(city0, /MenuMind/); assert.match(city0, /Prep Pal/);
  assert.ok(!(await (await fetch(base + "/v1/directory")).json()).profiles.some(p => p.handle === "dana-lee"), "new email pages stay out of People for 3 days");
  // settings: the update prompt; an update logs work on a project and grows its building
  const set = await (await fetch(base + "/settings", { headers: { cookie } })).text();
  assert.match(set, /What(&#39;|')s new\?/); assert.match(set, /t\/1\.js(&quot;|")\s+integrity=(&quot;|")sha384-/, "the website snippet is right there, pinned");
  const u = await (await form("/settings/page", { do: "update", text: "now:\n- Launching MenuMind in 3 new cities\nworked_on:\n- MenuMind | Signed 4 new restaurants\n- Prep Pal | First prototype" }, cookie)).text();
  assert.match(u, /2 project updates added to your city/);
  const city1 = await (await fetch(base + "/@dana-lee/city.html")).text();
  const data = JSON.parse(city1.match(/<script type="application\/json" id="city-data">([\s\S]*?)<\/script>/)[1]);
  const mm = data.districts.flatMap(d => d.repos).find(r => r.name === "MenuMind");
  assert.ok(mm.commits > 4 && mm.week > 0 && mm.today > 0, "the building grew, lit this week, crane today");
  { const p2 = await (await fetch(base + "/@dana-lee/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
    assert.match(p2, /Launching MenuMind in 3 new cities/); assert.match(p2, /<th class="num">updates<\/th>/); assert.doesNotMatch(p2, /\$\{/); }
  // coming back: just the email, no text -> a sign-in link
  assert.match(await (await form("/start", { text: "", email: "dana@example.com" })).text(), /Check your email/);
  assert.match(mails[mails.length - 1].subject, /sign-in link/);
  // delete: everything goes, the email is forgotten
  assert.match(await (await form("/settings/page", { do: "delete", sure: "on" }, cookie)).text(), /Your page is deleted/);
  assert.equal((await fetch(base + "/@dana-lee/")).status >= 400, true);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM email_accounts").get().n, 0);
  // someone else's settings path isn't hijacked: a non-member gets the usual sign-in redirect
  assert.equal((await fetch(base + "/settings/page", { redirect: "manual" })).status, 302);
});

test("signed out, tapping Message: sign-up page says why, GitHub first (no email sign-up), the inviter is credited and it lands in the conversation", async () => {
  const join = async (text, email) => { await form("/start", { text, email }); const l = mails[mails.length - 1].text.match(/start\/confirm\?t=(\S+)/)[1];
    const c = await form("/start/confirm", { t: new URL(base + "/start/confirm?t=" + l).searchParams.get("t") }); return c; };
  await join("name: Mike Host\nheadline: Speaker", "host@example.com");
  // the Message button on a page, signed out: sent to sign in, remembering the conversation
  const m = await fetch(base + "/messages/@mike-host", { redirect: "manual" });
  assert.equal(m.status, 302); assert.equal(m.headers.get("location"), "/signin?back=%2Fmessages%2F%40mike-host");
  const si = await (await fetch(base + m.headers.get("location"))).text();
  assert.match(si, /Sign up to message Mike Host/); assert.match(si, /land right in your conversation with @mike-host/);
  assert.doesNotMatch(si, /Sign up with email/, "no email sign-up offered: GitHub first, Obsidian second");
  assert.ok(si.indexOf("Sign up with GitHub") < si.indexOf("Sign up with Obsidian"), "GitHub is the primary sign-up");
  assert.match(si, /community\.obsidian\.md\/plugins\/caldera/, "Obsidian sign-up goes to the plugin");
  assert.match(si, /\/auth\/github\?back=%2Fmessages%2F%40mike-host&(amp;)?invite=mike-host/, "GitHub sign-up too");
  assert.match(si, /Already on Caldera\?/);
  // an unknown handle gets the ordinary sign-in page
  assert.match(await (await fetch(base + "/signin?back=%2Fmessages%2F%40nobody-here")).text(), /Sign in to Caldera/);
  // the email path carries both through the form, the email link and the confirm button
  const st = await (await fetch(base + "/start?back=%2Fmessages%2F%40mike-host&invite=mike-host")).text();
  assert.match(st, /straight to your conversation with <b>@mike-host<\/b>/); assert.match(st, /name="back" value="\/messages\/@mike-host"/); assert.match(st, /name="invite" value="mike-host"/);
  assert.equal((await fetch(base + "/start?back=https%3A%2F%2Fevil.example")).status, 200);
  assert.doesNotMatch(await (await fetch(base + "/start?back=https%3A%2F%2Fevil.example")).text(), /evil\.example/, "only on-site paths come back");
  await form("/start", { text: "name: Ava Guest\nheadline: Came to the talk", email: "ava@example.com", back: "/messages/@mike-host", invite: "mike-host" });
  const link = mails[mails.length - 1].text.match(/https?:\/\/\S+start\/confirm\?\S+/)[0].replace(ORIGIN, base);
  assert.match(link, /back=%2Fmessages%2F%40mike-host/); assert.match(link, /invite=mike-host/);
  const btn = await (await fetch(link)).text(); assert.match(btn, /name="back" value="\/messages\/@mike-host"/);
  const c = await form("/start/confirm", { t: new URL(link).searchParams.get("t"), back: "/messages/@mike-host", invite: "mike-host" });
  assert.equal(c.status, 302); assert.equal(c.headers.get("location"), "/messages/@mike-host", "straight into the conversation");
  const cookie = (c.headers.getSetCookie?.() || [c.headers.get("set-cookie")]).map(x => x.split(";")[0]).join("; ");
  const dm = await fetch(base + "/messages/@mike-host", { headers: { cookie }, redirect: "manual" });
  assert.equal(dm.status, 200, "signed in as the new member, the conversation opens"); assert.match(await dm.text(), /Conversation with @mike-host/);
  const host = hub.db.prepare("SELECT id FROM profiles WHERE handle='mike-host'").get(), ava = hub.db.prepare("SELECT id FROM profiles WHERE handle='ava-guest'").get();
  assert.equal(hub.db.prepare("SELECT inviter FROM referrals WHERE invitee=?").get(ava.id)?.inviter, host.id, "the invite is credited to the page they came from");
  // a forged back on confirm can't send them off-site
  await form("/start", { text: "name: Bo Test\nheadline: x", email: "bo@example.com" });
  const t3 = new URL(mails[mails.length - 1].text.match(/https?:\/\/\S+start\/confirm\?\S+/)[0]).searchParams.get("t");
  assert.equal((await form("/start/confirm", { t: t3, back: "//evil.example" })).headers.get("location"), "/@bo-test/city.html?welcome=1");
});
