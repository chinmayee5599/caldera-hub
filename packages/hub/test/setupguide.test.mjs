import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
import { guideSteps, welcomeText } from "../dist/server.js";

// The setup guide: a DM from the founder with what's still missing; welcome once, two follow-ups at most
test("setup guide: welcomes new members by DM with only what's missing, follows up twice, backfills old members", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-guide-"));
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", founder: "ana", limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const ids = { ana: C.newIdentity(), old: C.newIdentity(), bo: C.newIdentity() };
    for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h === "bo" ? "Bo Park" : h, handle: h, boxKey: id.boxPublic, headline: h === "bo" ? "Builds things" : undefined }), files: { "index.html": Buffer.from("<html><body>x</body></html>").toString("base64") } });
    const db = hub.db, hour = 3600_000;
    db.prepare("UPDATE profiles SET created=? WHERE handle IN ('ana','old')").run("2026-01-01T00:00:00.000Z");
    db.prepare("UPDATE profiles SET created=? WHERE handle='bo'").run(new Date(Date.now() - hour).toISOString());
    db.prepare("INSERT OR REPLACE INTO hub_meta VALUES ('setup_guide_since', ?)").run("2026-06-01T00:00:00.000Z");
    const msgs = h => db.prepare("SELECT m.* FROM msg_messages m JOIN msg_threads t ON t.id=m.thread JOIN profiles p ON (p.id=t.a OR p.id=t.b) WHERE p.handle=? ORDER BY m.ts").all(h);

    let r = hub.guide.tick();
    assert.deepEqual(r, { welcomed: 1, nudged: 0 }, "only the new member (joined after the guide went live) is welcomed");
    assert.equal(msgs("old").length, 0);
    const m1 = msgs("bo"); assert.equal(m1.length, 1); assert.equal(m1[0].sender, ids.ana.id, "from the founder");
    assert.equal(db.prepare("SELECT status FROM msg_threads").get().status, "open", "no request to accept");
    assert.equal(hub.messages.unreadFor(ids.bo.id), 1, "it badges like any DM");
    assert.deepEqual(hub.guide.tick(), { welcomed: 0, nudged: 0 }, "never twice");

    // follow-ups: day 3 and day 8, one step each, then done
    const now = Date.now();
    assert.equal(hub.guide.tick(now + 2 * 86400_000).nudged, 0);
    assert.equal(hub.guide.tick(now + 3.1 * 86400_000).nudged, 1);
    assert.equal(hub.guide.tick(now + 8.2 * 86400_000).nudged, 1);
    assert.equal(hub.guide.tick(now + 30 * 86400_000).nudged, 0, "two follow-ups at most");
    assert.equal(msgs("bo").length, 3);

    // backfill (founder only) reaches members who joined before the guide
    const dry = hub.guide.backfill(true); assert.deepEqual(dry.map(x => x.handle), ["old"]); assert.equal(msgs("old").length, 0, "dry run sends nothing");
    assert.deepEqual(hub.guide.backfill().map(x => [x.handle, x.sent]), [["old", true]]);
    assert.equal(msgs("old").length, 1); assert.deepEqual(hub.guide.backfill(), []);
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("setup guide copy: GitHub-only members are pointed at Obsidian first; finished pages get no list", () => {
  const hub = "https://caldera.social";
  const gh = { hosted: true, missingBasics: ["photo"], richer: false, agents: false, live: false, email: false, grouped: false };
  assert.deepEqual(guideSteps(gh, hub).map(s => s.id), ["obsidian", "basics", "power", "email"]);
  const vault = { ...gh, hosted: false, missingBasics: [] };
  assert.deepEqual(guideSteps(vault, hub).map(s => s.id), ["richer", "power", "email"]);
  const w = welcomeText("Bo", gh, hub);
  assert.match(w, /^Hey Bo, Mike here/); assert.match(w, /1\. Connect Obsidian/); assert.match(w, /feedback-on-caldera/);
  assert.ok(w.length < 2000, "fits one message"); assert.ok(/^[\x00-\x7f]*$/.test(w), "plain ASCII");
  const done = welcomeText("Bo", { hosted: false, missingBasics: [], richer: true, agents: true, live: true, email: true, grouped: true }, hub);
  assert.match(done, /in great shape/); assert.doesNotMatch(done, /feedback-on-caldera/);
});
