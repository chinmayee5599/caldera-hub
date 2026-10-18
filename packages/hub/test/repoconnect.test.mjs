import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// fake GitHub: who owns which public repos, who contributed, which repos are forks of what
const J = (o, s = 200, h = {}) => new Response(s === 304 ? null : JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000", ...h } });
const REPOS = {
  ana: [{ full_name: "ana/engine", fork: false }, { full_name: "ana/old", fork: false, archived: true }, { full_name: "ana/secret", fork: false, private: true }],
  bo: [{ full_name: "bo/site", fork: false }, { full_name: "bo/engine", fork: true }],
  cy: [{ full_name: "cy/tool", fork: false }],
  di: [{ full_name: "di/notes", fork: false }],
};
const CONTRIB = { "ana/engine": ["ana", "cy"], "ana/old": ["ana", "di"], "ana/secret": ["ana", "di"], "bo/site": ["bo"], "bo/engine": ["ana", "bo"], "cy/tool": ["cy"], "di/notes": ["di"] };
let calls = [];
const fake = async (u, init = {}) => { u = String(u); calls.push({ u, etag: init.headers?.["if-none-match"] });
  let m = u.match(/\/users\/([^/]+)\/repos/); if (m) return J(REPOS[m[1]] || [], 200, { etag: `"r-${m[1]}"` });
  m = u.match(/\/repos\/([^/]+\/[^/?]+)\/contributors/); if (m) return J((CONTRIB[m[1]] || []).map(login => ({ login })), 200, { etag: `"c-${m[1]}"` });
  m = u.match(/\/repos\/([^/]+\/[^/?]+)$/); if (m) return J(m[1] === "bo/engine" ? { full_name: "bo/engine", parent: { full_name: "ana/engine" } } : { full_name: m[1] }, 200, { etag: `"d-${m[1]}"` });
  return J({}, 404); };

async function setup(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-repo-"));
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test", githubFetch: fake, founder: "mike", limits: { newProfilesPerDay: 100 }, ...extra });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const ids = {};
  const publish = async (handle, body = {}) => { const id = ids[handle] ||= C.newIdentity();
    const r = await fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { handle, name: handle, boxKey: id.boxPublic, ...body }), files: { "index.html": Buffer.from("<html><head></head><body>x</body></html>").toString("base64") } }) });
    assert.equal(r.status, 200, await r.text()); return id; };
  const gh = login => ({ links: [["GitHub", `https://github.com/${login}`]] });
  return { h, base, ids, publish, gh };
}
const kind = (h, a, b) => h.db.prepare("SELECT kind, why FROM friends WHERE a=? AND b=?").get(a.id, b.id);

test("shared public repo -> repo friendship with the repo as the reason; forks count for the parent; private/archived never", async () => {
  const { h, publish, gh } = await setup();
  const mike = await publish("mike"); const ana = await publish("ana", gh("ana")), bo = await publish("bo", gh("bo")), cy = await publish("cy", gh("cy")), di = await publish("di", gh("di"));
  assert.equal(kind(h, ana, mike).kind, "founder", "signups start with the founder's welcome link");
  calls = [];
  const dry = await h.admin.repoConnect({ dry: true });
  const got = dry.map(p => [[p.ah, p.bh].sort().join("+"), p.repo, p.action]).sort();
  assert.deepEqual(got, [["ana+bo", "ana/engine", "connect"], ["ana+cy", "ana/engine", "connect"], ["bo+cy", "ana/engine", "connect"]].sort(), "fork bo/engine is credited to ana/engine; di only shares private/archived repos");
  assert.ok(!calls.some(c => /ana\/secret|ana\/old/.test(c.u)), "private and archived repos are never read");
  assert.equal(kind(h, ana, cy), undefined, "dry run changes nothing");
  await h.admin.repoConnect();
  assert.deepEqual({ ...kind(h, ana, cy) }, { kind: "repo", why: "ana/engine" });
  assert.deepEqual({ ...kind(h, cy, ana) }, { kind: "repo", why: "ana/engine" }, "both directions");
  assert.equal(kind(h, ana, di), undefined);
  // ETags: the second run revalidates
  calls = []; await h.admin.repoConnect({ dry: true });
  assert.ok(calls.length && calls.every(c => c.etag), "every call sends If-None-Match the second time");
  // the friend list and world carry the reason
  const fr = await (await fetch(`http://127.0.0.1:${h.server.address().port}/v1/friends/${ana.id}`)).json();
  assert.ok(fr.friends.some(f => f.handle === "cy" && f.kind === "repo" && f.why === "ana/engine"));
  const w = await (await fetch(`http://127.0.0.1:${h.server.address().port}/v1/world`)).json();
  assert.ok(w.links.some(l => l.includes("@ana") && l.includes("@cy") && l[2] === 2 && l[3] === "ana/engine"), "world ray kind 2 with the repo");
  assert.ok(w.links.some(l => l.includes("@ana") && l.includes("@mike") && l[2] === 1), "founder link stays faint");
  h.server.close();
});

test("a removed repo friendship is tombstoned and never re-added; opting out is respected; a real friendship isn't downgraded", async () => {
  const { h, publish, gh } = await setup();
  await publish("mike"); const ana = await publish("ana", gh("ana")), bo = await publish("bo", gh("bo")), cy = await publish("cy", { ...gh("cy"), autoConnectRepos: false });
  await h.admin.repoConnect();
  assert.equal(kind(h, ana, bo).kind, "repo");
  assert.equal(kind(h, ana, cy), undefined, "cy opted out");
  const res = h.admin.repoConnect({ dry: true }).then(p => p.find(x => [x.ah, x.bh].sort().join() === "ana,cy")?.action);
  assert.equal(await res, "opted-out");
  // ana removes bo
  const port = h.server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/v1/envelopes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(ana, "friend.remove", { to: bo.id })) });
  assert.equal(r.status, 200);
  assert.equal(kind(h, ana, bo), undefined);
  await h.admin.repoConnect();
  assert.equal(kind(h, ana, bo), undefined, "tombstone: never re-added");
  h.server.close();
});

test("kinds: a real accepted request upgrades a founder or repo link; the founder link of a signup is kind founder; backfill marks old rows", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-kinds-"));
  let h = createHub({ dataDir: d, publicUrl: "http://hub.test", founder: "mike", limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const pub = async (id, handle) => fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: C.sign(id, "profile.manifest", { handle, name: handle, boxKey: id.boxPublic }), files: { "index.html": Buffer.from("<html><body>x</body></html>").toString("base64") } }) });
  const mike = C.newIdentity(), nick = C.newIdentity(), zed = C.newIdentity();
  await pub(mike, "mike"); await pub(nick, "nick"); await pub(zed, "zed");
  assert.equal(h.db.prepare("SELECT kind FROM friends WHERE a=? AND b=?").get(nick.id, mike.id).kind, "founder");
  // nick sends mike a real request, mike accepts: upgrades to request
  const post = env => fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) }).then(r => r.json());
  const rq = await post(C.sign(nick, "friend.request", { to: mike.id }));
  await post(C.sign(mike, "friend.accept", { request: rq.request, to: nick.id }));
  assert.equal(h.db.prepare("SELECT kind FROM friends WHERE a=? AND b=?").get(mike.id, nick.id).kind, "request");
  // simulate rows from before kinds existed: wipe kinds and the backfill marker, reopen the hub
  h.db.prepare("UPDATE friends SET kind=NULL").run(); h.db.prepare("DELETE FROM friend_meta").run(); h.server.close();
  h = createHub({ dataDir: d, publicUrl: "http://hub.test", founder: "mike" });
  const k = (a, b) => h.db.prepare("SELECT kind FROM friends WHERE a=? AND b=?").get(a.id, b.id).kind;
  assert.equal(k(mike, nick), "request", "an accepted request stays a request");
  assert.equal(k(zed, mike), "founder", "a welcome link without an accept is founder");
});
