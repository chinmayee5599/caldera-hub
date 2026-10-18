import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub, makeAlertBatcher } from "../dist/server.js";
import { githubAccountOk } from "../dist/server.js";

const DAY = 86_400_000;
test("GitHub sign-up gate: only brand-new AND empty accounts wait", () => {
  const now = Date.parse("2026-10-18T00:00:00Z"), ago = d => new Date(now - d * DAY).toISOString();
  assert.equal(githubAccountOk({ created_at: ago(0.5), public_repos: 0, followers: 0 }, now), false, "hours-old empty account waits");
  assert.equal(githubAccountOk({ created_at: ago(2.9), public_repos: 0, followers: 0 }, now), false);
  assert.equal(githubAccountOk({ created_at: ago(3.1), public_repos: 0, followers: 0 }, now), true, "3+ days old is fine even when empty");
  assert.equal(githubAccountOk({ created_at: ago(0.1), public_repos: 1, followers: 0 }, now), true, "a brand-new account with a repo is fine");
  assert.equal(githubAccountOk({ created_at: ago(0.1), public_repos: 0, followers: 2 }, now), true, "or with a follower");
  assert.equal(githubAccountOk({ created_at: ago(20), public_repos: 0, followers: 0 }, now), true, "the old 30-day rule is gone");
});

test("signup alerts: first 10 a day one by one, then one hourly digest", () => {
  const sent = []; let t = Date.parse("2026-10-18T10:00:00Z");
  const a = makeAlertBatcher((s, x) => sent.push([s, x]), "https://hub.test", 10, () => t);
  for (let i = 1; i <= 25; i++) a.event({ type: "signup", handle: "u" + i, name: "", total: 100 + i });
  assert.equal(sent.length, 10, "10 individual emails");
  assert.match(sent[9][1], /arrive as one email an hour/);
  assert.equal(a.pending(), 15);
  a.flush();
  assert.equal(sent.length, 11); assert.match(sent[10][0], /^15 new Caldera profiles in the last hour \(125 total\)/); assert.match(sent[10][1], /@u11.*@u25/s);
  a.flush(); assert.equal(sent.length, 11, "nothing queued, nothing sent");
  t += DAY; a.event({ type: "signup", handle: "next", total: 126 }); assert.equal(sent.length, 12, "a new day sends individually again");
});

test("new profiles from one address: a room can sign up together; a burst over 20/min waits", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-launch-"));
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = async (i) => { const id = C.newIdentity(); const env = C.sign(id, "profile.manifest", { handle: "room" + i, name: "R" + i, boxKey: id.boxPublic });
    return (await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) })).status; };
  const codes = []; for (let i = 0; i < 22; i++) codes.push(await post(i));
  assert.equal(codes.slice(0, 20).every(c => c === 200), true, "20 people from the same Wi-Fi in a minute all get in (old limit: 5 a day)");
  assert.equal(codes[20], 429, "the 21st within the minute waits");
  const r = await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  h.server.close();
});

test("sign-out and sign-in forms work from pages that send Origin: null (no-referrer), but not from other sites", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-signout-"));
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (headers) => fetch(base + "/signout", { method: "POST", headers, redirect: "manual" }).then(r => r.status);
  assert.equal(await post({ origin: "null", "sec-fetch-site": "same-origin" }), 303, "the sign-out button on our own page works");
  assert.equal(await post({ origin: "http://hub.test" }), 303);
  assert.equal(await post({ origin: "null", "sec-fetch-site": "cross-site" }), 403, "a sandboxed or cross-site page can't sign people out");
  assert.equal(await post({ origin: "https://evil.example" }), 403);
  h.server.close();
});

test("several sign-ins from the same vault at once all succeed (each uses its own challenge)", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-auth-"));
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await h.listen(0), id = C.newIdentity();
  const one = async () => { const { nonce } = await (await fetch(base + "/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id.id }) })).json(); return nonce; };
  const nonces = await Promise.all([one(), one(), one(), one()]);
  const codes = await Promise.all(nonces.map(n => fetch(base + "/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(id, "message", { nonce: n })) }).then(r => r.status)));
  assert.deepEqual(codes, [200, 200, 200, 200]);
  const again = await fetch(base + "/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(id, "message", { nonce: nonces[0] })) });
  assert.equal(again.status, 401, "a used challenge can't be replayed");
  h.server.close();
});

test("deleting a profile removes its email subscription and referral rows", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-erase-"));
  const h = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  const base = "http://127.0.0.1:" + await h.listen(0), id = C.newIdentity();
  await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(id, "profile.manifest", { handle: "goner", name: "G", boxKey: id.boxPublic })) });
  h.db.prepare("INSERT INTO email_subs (owner, email, hash, confirmed, token, created) VALUES (?,?,?,?,?,?)").run(id.id, "sealed", "h", 1, "t", new Date().toISOString());
  h.db.prepare("INSERT INTO referrals VALUES (?,?,?,?)").run(id.id, "cal:someone", new Date().toISOString(), "github");
  const r = await fetch(base + "/v1/envelopes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(C.sign(id, "profile.delete", {})) });
  assert.equal(r.status, 200);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM email_subs WHERE owner=?").get(id.id).n, 0, "no more emails to a deleted member");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM referrals WHERE invitee=?").get(id.id).n, 0);
  h.server.close();
});
