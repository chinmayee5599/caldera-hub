import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const id = C.newIdentity();
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.status);
const publish = (name) => post(`/v1/profiles/${id.id}/bundle`, { manifest: C.sign(id, "profile.manifest", { name, handle: "cody", boxKey: id.boxPublic, headline: "builder" }),
  files: { "index.html": Buffer.from(`<html><head><title>${name}</title></head><body><div class="tab">${name}.md</div><h1 class="title">${name}</h1><p class="lede">builder</p></body></html>`).toString("base64") } });
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-untitled-")); hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } }); base = "http://127.0.0.1:" + await hub.listen(0); });
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("nobody is called Untitled: the real name is kept, the page shows it, a nameless first page shows the handle", async () => {
  assert.equal(await publish("Untitled"), 200);
  assert.equal(hub.db.prepare("SELECT name FROM profiles WHERE handle='cody'").get().name, "cody", "no name yet: the handle");
  assert.equal(await publish("Cody"), 200);
  assert.equal(await publish("Untitled"), 200, "an older plugin republishes with the placeholder");
  assert.equal(hub.db.prepare("SELECT name FROM profiles WHERE handle='cody'").get().name, "Cody", "the real name is kept");
  const page = await (await fetch(base + "/@cody/", { headers: { "user-agent": "Mozilla/5.0" } })).text();
  assert.doesNotMatch(page, /Untitled/); assert.match(page, /<h1 class="title">Cody/); assert.match(page, /<title>Cody/); assert.match(page, /Cody\.md/);
});
