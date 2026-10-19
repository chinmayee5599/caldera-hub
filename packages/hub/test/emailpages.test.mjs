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
  assert.match(set, /What(&#39;|')s new\?/); assert.match(set, /t\.js/, "the website snippet is right there");
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
