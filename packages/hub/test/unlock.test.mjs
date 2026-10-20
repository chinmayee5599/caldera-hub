import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const id = C.newIdentity();
const post = (p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function login() { const { body } = await post("/v1/auth/challenge", { id: id.id }); return (await post("/v1/auth/verify", C.sign(id, "message", { nonce: body.nonce }))).body.token; }
const activity = async () => (await (await fetch(`${base}/v1/owner/${id.id}/activity?since=2000-01-01`, { headers: { authorization: "Bearer " + await login() } })).json());

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-unlock-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  const m = C.sign(id, "profile.manifest", { name: "Una", handle: "una", boxKey: id.boxPublic });
  await post(`/v1/profiles/${id.id}/bundle`, { manifest: m, files: { "index.html": Buffer.from("<html><head></head><body>hi</body></html>").toString("base64") } });
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("unlock: the owner's activity reports live visitors, agents and the private layer, turning on as data arrives", async () => {
  let u = (await activity()).unlock;
  assert.deepEqual(u, { live: false, agents: false, private: false });
  const now = new Date().toISOString();
  hub.db.prepare("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run("k1aaaaaaaaaaaa", id.id, "Site", 1, "s", now);
  hub.db.prepare("INSERT INTO traffic (key, ts, kind, visitor) VALUES (?,?,?,?)").run("k1aaaaaaaaaaaa", now, "view", "v");
  hub.db.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?)").run(id.id, "a1", "", "", "", "working", "", "", 0, now);
  hub.db.prepare("INSERT INTO owner_private VALUES (?,?,?,?)").run(id.id, "x", now, now);
  u = (await activity()).unlock;
  assert.deepEqual(u, { live: true, agents: true, private: true });
  const old = new Date(Date.now() - 9 * 86400_000).toISOString();
  hub.db.prepare("UPDATE traffic SET ts=?").run(old); hub.db.prepare("UPDATE agents SET ts=?").run(old);
  u = (await activity()).unlock;
  assert.equal(u.live, false, "only the last 7 days count"); assert.equal(u.agents, false);
});
