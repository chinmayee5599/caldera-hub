import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

test("garden tombstones: a linked note taken private shows a 'made private' page, linkers mark it, republish clears it, unlinked notes just 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-tomb-"));
  const h = createHub({ dataDir: dir, publicUrl: "https://hub.test", garden: true }); const base = "http://127.0.0.1:" + await h.listen(0);
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.status);
  const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.text() }));
  const a = C.newIdentity(), b = C.newIdentity();
  const note = (slug, title, extra = {}) => ({ slug, title, stage: "budding", license: "cc-by", updated: new Date().toISOString(), sha256: "a".repeat(64), words: 50, excerpt: "secret body text " + title, xlinks: [], ...extra });
  const page = (s) => Buffer.from(`<html><body><article>${s}<!--caldera:xlinks--></article></body></html>`).toString("base64");
  const pubA = (garden, files) => post(`/v1/profiles/${a.id}/bundle`, { manifest: C.sign(a, "profile.manifest", { name: "Ada", handle: "ada", boxKey: a.boxPublic, garden }), files: { "index.html": page("a"), ...files } });
  assert.equal(await pubA([note("linked", "Linked idea"), note("lonely", "Lonely idea")], { "n/linked.html": page("L"), "n/lonely.html": page("O") }), 200);
  const xl = `<a class="xlink" href="https://hub.test/@ada/n/linked.html">Linked idea<span class="xl-who">@ada</span></a>`;
  assert.equal(await post(`/v1/profiles/${b.id}/bundle`, { manifest: C.sign(b, "profile.manifest", { name: "Bo", handle: "bo", boxKey: b.boxPublic, garden: [note("reply", "Bo's reply", { xlinks: ["ada/linked"] })] }), files: { "index.html": page("b"), "n/reply.html": page(xl) } }), 200);
  assert.ok(!(await get("/@bo/n/reply.html")).body.includes("(made private)"), "nothing marked while the note is public");

  // Ada takes both notes private
  assert.equal(await pubA([], {}), 200);
  const t = await get("/@ada/n/linked.html");
  assert.equal(t.status, 410);
  assert.ok(t.body.includes("Linked idea") && t.body.includes("taken private by") && t.body.includes("/@bo/n/reply.html"), "tombstone page: title, who, linking note");
  assert.ok(!t.body.includes("secret body text"), "no content kept");
  assert.equal((await get("/@ada/n/lonely.html")).status, 404, "a note nobody linked to just goes away");
  assert.ok((await get("/@bo/n/reply.html")).body.includes("(made private)"), "linking side marks the link");

  // republishing the slug drops the tombstone
  assert.equal(await pubA([note("linked", "Linked idea")], { "n/linked.html": page("back") }), 200);
  const back = await get("/@ada/n/linked.html");
  assert.equal(back.status, 200); assert.ok(back.body.includes("back"));
  assert.ok(!(await get("/@bo/n/reply.html")).body.includes("(made private)"));

  // deleting the profile erases its tombstones too
  assert.equal(await pubA([], {}), 200);
  assert.equal((await get("/@ada/n/linked.html")).status, 410);
  await post("/v1/envelopes", C.sign(a, "profile.delete", {}));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM garden_tombstones").get().n, 0);
  h.server.close(); fs.rmSync(dir, { recursive: true, force: true });
});
