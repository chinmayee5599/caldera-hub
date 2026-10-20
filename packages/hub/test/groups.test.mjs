import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// Groups under Messages: founder-made topics, posts with threaded replies, unread badges, no email
const UA = { "user-agent": "Mozilla/5.0" };
async function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-groups-")), mails = [];
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", founder: "ana", limits: { newProfilesPerDay: 100 }, email: { send: async m => { mails.push(m); } } });
  const base = "http://127.0.0.1:" + await hub.listen(0);
  const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const ids = { ana: C.newIdentity(), bo: C.newIdentity(), cy: C.newIdentity() };
  for (const [h, id] of Object.entries(ids)) await post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name: h.toUpperCase(), handle: h, boxKey: id.boxPublic }), files: { "index.html": Buffer.from(`<html><head></head><body><h1>${h}</h1></body></html>`).toString("base64") } });
  hub.db.prepare("UPDATE profiles SET created=?").run("2026-01-01T00:00:00.000Z");
  const login = async (id) => { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; };
  const cookieOf = async (id) => { const { body } = await post(`/v1/owner/${id.id}/link`, {}, { authorization: "Bearer " + await login(id) });
    const r = await fetch(body.url.replace("http://hub.test", base), { redirect: "manual" }); return (r.headers.get("set-cookie") || "").split(";")[0]; };
  const ck = {}; for (const h of Object.keys(ids)) ck[h] = await cookieOf(ids[h]);
  const as = (h) => ({ cookie: ck[h], origin: "http://hub.test" });
  const get = (h, p) => fetch(base + p, { headers: { ...UA, ...(h ? { cookie: ck[h] } : {}) }, redirect: "manual" });
  const groupsOf = async (h) => (await (await get(h, "/v1/groups")).json());
  const badges = async (h) => (await (await get(h, "/v1/me/badges")).json());
  return { hub, d, base, post, as, get, groupsOf, badges, mails, ids };
}

test("groups: only the founder makes them; members post, reply in threads, and unread counts pull them in (no email)", async () => {
  const S = await setup();
  try {
    assert.equal((await S.post("/v1/groups", { name: "Sneaky" }, S.as("bo"))).status, 403, "only the founder makes groups");
    const g1 = await S.post("/v1/groups", { name: "Feedback on Caldera", about: "What to fix, what to build next" }, S.as("ana"));
    assert.equal(g1.status, 200); assert.equal(g1.body.id, "feedback-on-caldera");
    const g2 = await S.post("/v1/groups", { name: "AI model discussion", about: "Models, prompts, evals" }, S.as("ana"));
    assert.equal(g2.body.id, "ai-model-discussion");
    assert.deepEqual((await S.groupsOf("cy")).groups.map(g => g.id), ["feedback-on-caldera", "ai-model-discussion"]);

    // signed out: sign up to join, and land back in the group
    const so = await S.get(null, "/messages/groups/feedback-on-caldera");
    assert.equal(so.status, 302); assert.equal(so.headers.get("location"), "/signin?back=%2Fmessages%2Fgroups%2Ffeedback-on-caldera");
    const si = await (await S.get(null, so.headers.get("location"))).text();
    assert.match(si, /Sign up to join Feedback on Caldera/); assert.match(si, /\/auth\/github\?back=%2Fmessages%2Fgroups%2Ffeedback-on-caldera/);

    // bo posts; cy sees it as unread everywhere: per group, total, the Groups tab and the Messages badge (violet: no DMs)
    const p1 = await S.post("/v1/groups/feedback-on-caldera/post", { text: "The world map labels are much better <script>x</script>" }, S.as("bo"));
    assert.equal(p1.status, 200); assert.doesNotMatch(p1.body.html, /<script>/, "text only");
    let gc = await S.groupsOf("cy"); assert.equal(gc.unread, 1); assert.equal(gc.groups[0].unread, 1);
    assert.equal((await S.groupsOf("bo")).unread, 0, "your own posts aren't unread");
    assert.equal((await S.badges("cy")).groups, 1);
    const feed = await (await S.get("cy", "/feed")).text();
    assert.match(feed, /class="ch-icon ch-msgs" href="[^"]*\/messages\/groups" aria-label="Messages, 1 unread"[\s\S]*?<span class="ch-badge ch-new">1<\/span>/, "Messages badge counts groups, violet, and opens Groups");
    const dm = await (await S.get("cy", "/messages")).text();
    assert.match(dm, /<a href="\/messages\/groups">Groups <i class="new">1<\/i><\/a>/, "the Groups tab carries its count");

    // cy opens the group: sees the post, it's read now
    const gp = await (await S.get("cy", "/messages/groups/feedback-on-caldera")).text();
    assert.match(gp, /The world map labels are much better/); assert.match(gp, /&lt;script&gt;/);
    assert.match(gp, /class="ms-row cg-row is-on"/, "the open group shows as read in the list");
    assert.match(gp, /<a href="\/messages\/groups" aria-current="page">Groups<\/a>/, "and the tab agrees with the header (nothing else unread)");
    assert.equal((await S.groupsOf("cy")).unread, 0, "opening the group reads it");

    // a thread: cy replies under bo's post; the reply counts for bo and the post shows "1 reply"
    const r1 = await S.post("/v1/groups/feedback-on-caldera/post", { text: "Agreed, and the bottom nav too", parent: p1.body.id }, S.as("cy"));
    assert.equal(r1.status, 200);
    assert.equal((await S.groupsOf("bo")).unread, 1);
    const g = await (await S.get("bo", "/messages/groups/feedback-on-caldera")).text();
    assert.match(g, /1 reply &middot;/);
    const th = await (await S.get("bo", `/messages/groups/feedback-on-caldera/${p1.body.id}`)).text();
    assert.match(th, /Agreed, and the bottom nav too/); assert.match(th, /data-root="[0-9a-f]{16}"/);
    assert.equal((await S.post("/v1/groups/feedback-on-caldera/post", { text: "x", parent: r1.body.id }, S.as("bo"))).status, 404, "threads are one level deep");
    assert.equal((await S.post("/v1/groups/ai-model-discussion/post", { text: "x", parent: p1.body.id }, S.as("bo"))).status, 404, "a thread stays in its group");

    // polling picks up new posts
    const after = (await (await S.get("cy", `/v1/groups/feedback-on-caldera?after=${encodeURIComponent(p1.body.ts)}`)).json());
    assert.deepEqual(after.posts, []); assert.ok(after.replies[p1.body.id], "updated reply count for the post");

    // delete: your own, or the founder; report: goes to the founder's bell
    assert.equal((await S.post(`/v1/groups/post/${p1.body.id}/delete`, {}, S.as("cy"))).status, 403);
    assert.equal((await S.post(`/v1/groups/post/${r1.body.id}/report`, {}, S.as("bo"))).status, 200);
    assert.ok(S.hub.db.prepare("SELECT 1 FROM alerts WHERE target=? AND title LIKE 'Report in%'").get(S.ids.ana.id), "the founder hears about it");
    assert.equal((await S.post(`/v1/groups/post/${r1.body.id}/delete`, {}, S.as("cy"))).status, 200);
    assert.equal((await S.post(`/v1/groups/post/${p1.body.id}/delete`, {}, S.as("ana"))).status, 200, "the founder can remove anything");

    // archive: gone from the list, the founder can still open it
    assert.equal((await S.post("/v1/groups", { id: "ai-model-discussion", archive: true }, S.as("ana"))).status, 200);
    assert.deepEqual((await S.groupsOf("cy")).groups.map(g => g.id), ["feedback-on-caldera"]);
    assert.equal((await S.get("cy", "/messages/groups/ai-model-discussion")).status, 404);
    assert.equal((await S.get("ana", "/messages/groups/ai-model-discussion")).status, 200);

    assert.equal(S.mails.length, 0, "groups never email");
  } finally { S.hub.server.close(); fs.rmSync(S.d, { recursive: true, force: true }); }
});
