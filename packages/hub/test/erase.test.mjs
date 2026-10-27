import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// Privacy Policy, "How long we keep data": deleting an account erases everything tied to it, not just the page.
test("profile.delete erases intros, tags, tag edits, active days, read marks, preferences and GitHub sign-in rows", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-erase-"));
  const hub = createHub({ dataDir: d });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const me = C.newIdentity(), other = C.newIdentity();
    const files = { "index.html": Buffer.from("<html><body>hi</body></html>").toString("base64") };
    for (const [h, id] of [["gone", me], ["stays", other]])
      assert.equal((await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h, handle: h, boxKey: id.boxPublic }), files })).status, 200);
    const db = hub.db, ts = new Date().toISOString();
    // tables some features create lazily: make sure they exist with the hub's columns
    db.exec(`CREATE TABLE IF NOT EXISTS intros (a TEXT, b TEXT, tag TEXT, status TEXT, ts TEXT, decided TEXT);
      CREATE TABLE IF NOT EXISTS member_tags (member TEXT PRIMARY KEY, tags TEXT, source TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS tag_edits (member TEXT PRIMARY KEY, added TEXT, hidden TEXT, auto TEXT, ts TEXT);
      CREATE TABLE IF NOT EXISTS member_days (owner TEXT, day TEXT, via TEXT, PRIMARY KEY (owner, day));
      CREATE TABLE IF NOT EXISTS alert_reads (owner TEXT, alert_id TEXT, ts TEXT);
      CREATE TABLE IF NOT EXISTS feed_seen (member TEXT PRIMARY KEY, ts TEXT);
      CREATE TABLE IF NOT EXISTS search_prefs (owner TEXT PRIMARY KEY, on_ INTEGER, ts TEXT);
      CREATE TABLE IF NOT EXISTS gh_accounts (gh_id INTEGER PRIMARY KEY, login TEXT, profile_id TEXT, handle TEXT, key_sealed TEXT, token_sealed TEXT, installation TEXT, edits TEXT, cache TEXT, created TEXT, refreshed TEXT, claimed TEXT, claim_code TEXT, claim_expires TEXT);
      CREATE TABLE IF NOT EXISTS gh_sessions (token TEXT PRIMARY KEY, gh_id INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS gh_links (gh_id INTEGER PRIMARY KEY, login TEXT, profile_id TEXT, ts TEXT);`);
    for (const who of [me.id, other.id]) {
      db.prepare("INSERT INTO member_tags (member, tags, source, updated) VALUES (?,?,?,?)").run(who, "[]", "rules", ts);
      db.prepare("INSERT INTO tag_edits (member, added, hidden, auto, ts) VALUES (?,?,?,?,?)").run(who, "[]", "[]", "1", ts);
      db.prepare("INSERT INTO member_days VALUES (?,?,?)").run(who, "2026-10-26", "site");
      db.prepare("INSERT INTO alert_reads VALUES (?,?,?)").run(who, "a1", ts);
      db.prepare("INSERT INTO feed_seen (member, ts) VALUES (?,?)").run(who, ts);
      db.prepare("INSERT INTO search_prefs (owner, on_, ts) VALUES (?,?,?)").run(who, 1, ts);
    }
    db.prepare("INSERT INTO intros (a, b, tag, status, ts) VALUES (?,?,?,?,?)").run(me.id, other.id, "AI", "open", ts);
    db.prepare("INSERT INTO gh_accounts (gh_id, login, profile_id, handle, key_sealed, token_sealed, edits, cache, created, claimed) VALUES (?,?,?,?,?,?,?,?,?,?)").run(9001, "gone", me.id, "gone", "", "", "{}", "{}", ts, ts);
    db.prepare("INSERT INTO gh_sessions VALUES (?,?,?)").run("t1", 9001, Date.now() + 1e6);
    db.prepare("INSERT INTO gh_links VALUES (?,?,?,?)").run(9001, "gone", me.id, ts);

    assert.equal((await post("/v1/envelopes", C.sign(me, "profile.delete", {}))).body.deleted, me.id);

    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    for (const [t, col] of [["member_tags", "member"], ["tag_edits", "member"], ["member_days", "owner"], ["alert_reads", "owner"], ["feed_seen", "member"], ["search_prefs", "owner"], ["gh_accounts", "profile_id"], ["gh_links", "profile_id"]]) {
      assert.equal(n(`SELECT COUNT(*) n FROM ${t} WHERE ${col}=?`, me.id), 0, `${t} erased`);
      if (!t.startsWith("gh_")) assert.equal(n(`SELECT COUNT(*) n FROM ${t} WHERE ${col}=?`, other.id), 1, `${t}: other members untouched`);
    }
    assert.equal(n("SELECT COUNT(*) n FROM intros WHERE a=? OR b=?", me.id, me.id), 0, "intros erased");
    assert.equal(n("SELECT COUNT(*) n FROM gh_sessions WHERE gh_id=9001"), 0, "GitHub sessions erased");
    assert.equal(n("SELECT COUNT(*) n FROM profiles WHERE id=?", me.id), 0);
    assert.equal(n("SELECT COUNT(*) n FROM profiles WHERE id=?", other.id), 1);
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("retention: sign-up steps older than 90 days and active days older than 12 months are deleted at start", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-retain-"));
  try {
    let hub = createHub({ dataDir: d }); await hub.listen(0);
    const db = hub.db, day = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    for (const [n, v] of [[200, "old"], [10, "new"]]) db.prepare("INSERT INTO funnel_events VALUES (?,?,?,?,?)").run(day(n), v, "view", "", new Date().toISOString());
    for (const [n, o] of [[400, "old"], [100, "new"]]) db.prepare("INSERT INTO member_days VALUES (?,?,?)").run(o, day(n), "site");
    hub.server.close(); hub.db.close();
    hub = createHub({ dataDir: d }); await hub.listen(0);
    assert.deepEqual(hub.db.prepare("SELECT vid FROM funnel_events").all().map(r => r.vid), ["new"]);
    assert.deepEqual(hub.db.prepare("SELECT owner FROM member_days").all().map(r => r.owner), ["new"]);
    hub.server.close(); hub.db.close();
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("gh preview removal: a listed login gets 410 noindex, no badge and GitHub is never asked", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-ghrm-"));
  let asked = 0;
  const fake = async (u) => { asked++; return new Response(JSON.stringify({}), { status: 404 }); };
  const hub = createHub({ dataDir: d, githubFetch: fake });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  try {
    fs.mkdirSync(path.join(d, "gh-preview"), { recursive: true }); fs.writeFileSync(path.join(d, "gh-preview", "removed.txt"), "Gone-Person\n");
    const r = await fetch(base + "/gh/gone-person");
    assert.equal(r.status, 410); const html = await r.text();
    assert.match(html, /noindex/); assert.match(html, /removed at its owner's request/);
    assert.equal((await fetch(base + "/gh/gone-person/badge.svg")).status, 404);
    assert.equal(asked, 0, "GitHub never asked about a removed login");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
