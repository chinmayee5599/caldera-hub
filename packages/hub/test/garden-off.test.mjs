import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// a page published while the garden was on: garden pages on disk, a Garden section, nav link, side-menu group, stylesheet
const OLD = `<!doctype html><html><head><link rel="stylesheet" href="assets/profile.css"><link rel="stylesheet" href="assets/garden.css"></head><body>
<nav class="sidebar tree"><div class="toc pages"><a class="tree-row toc-row page-row is-active" href="#top" aria-current="page">Olga</a><a class="tree-row toc-row page-row" href="garden.html">Garden home</a></div>
<div class="toc"><a class="tree-row toc-row" href="#timeline">Timeline</a><a class="tree-row toc-row" href="#garden">Garden</a></div>
<details class="tree-group" open><summary class="tree-row group"><span class="caret"></span>Companies</summary><a class="tree-row child" href="https://a.example">A</a></details>
<details class="tree-group" open><summary class="tree-row group"><span class="caret"></span><a class="g-name g-link" href="garden.html">Garden</a></summary><a class="tree-row child is-link" href="n/idea.html"><span>Idea</span></a></details></nav>
<main class="note"><h2 id="timeline">Timeline</h2><p>t</p>
<h2 id="garden">Garden</h2><p class="small">1 note grown in public</p><div class="g-list"><a class="g-card" href="n/idea.html">Idea</a></div>
<h2 id="help-exchange">Help exchange</h2><p>h</p></main></body></html>`;

test("garden paused: garden pages 404 (files kept), old pages lose every garden trace, the stream and API are gone, manifests don't touch the index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-goff-"));
  const h = createHub({ dataDir: dir, publicUrl: "https://hub.test" }); const base = "http://127.0.0.1:" + await h.listen(0);
  assert.equal(C.gardenEnabled(), false);
  const id = C.newIdentity(), b64 = (s) => Buffer.from(s).toString("base64");
  const r = await fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    manifest: C.sign(id, "profile.manifest", { name: "Olga", handle: "olga", boxKey: id.boxPublic, garden: [{ slug: "idea", title: "Idea", stage: "seedling", updated: new Date().toISOString(), xlinks: [] }] }),
    files: { "index.html": b64(OLD), "garden.html": b64("<html>garden home</html>"), "n/idea.html": b64("<html>idea</html>") } }) });
  assert.equal(r.status, 200);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM garden_notes").get().n, 0, "manifest garden not indexed while paused");
  const ua = { "user-agent": "Mozilla/5.0 test" };
  for (const p of ["/@olga/garden.html", "/@olga/n/idea.html"]) assert.equal((await fetch(base + p, { headers: ua })).status, 404, p);
  assert.ok(fs.existsSync(path.join(dir, "profiles", "olga", "garden.html")), "files stay on disk");
  const html = await (await fetch(base + "/@olga/", { headers: ua })).text();
  for (const bad of ["garden.css", "Garden home", 'href="#garden"', 'href="garden.html"', 'id="garden"', "grown in public", "n/idea.html"]) assert.ok(!html.includes(bad), `stripped: ${bad}`);
  for (const good of ['id="timeline"', 'id="help-exchange"', "Companies", "https://a.example"]) assert.ok(html.includes(good), `kept: ${good}`);
  assert.equal((await fetch(base + "/v1/gardens/recent")).status, 404);
  const g = await fetch(base + "/gardens", { redirect: "manual" }); assert.equal(g.status, 301); assert.equal(g.headers.get("location"), "/");
  h.server.close();
});

test("garden on (CALDERA_GARDEN=1): the old behaviour is back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-gon-"));
  const h = createHub({ dataDir: dir, publicUrl: "https://hub.test", garden: true }); const base = "http://127.0.0.1:" + await h.listen(0);
  const id = C.newIdentity(), b64 = (s) => Buffer.from(s).toString("base64");
  await fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    manifest: C.sign(id, "profile.manifest", { name: "Olga", handle: "olga", boxKey: id.boxPublic, garden: [{ slug: "idea", title: "Idea", stage: "seedling", updated: new Date().toISOString(), xlinks: [] }] }),
    files: { "index.html": b64(OLD), "garden.html": b64("<html><body>garden home</body></html>"), "n/idea.html": b64("<html><body>idea</body></html>") } }) });
  const ua = { "user-agent": "Mozilla/5.0 test" };
  assert.equal((await fetch(base + "/@olga/n/idea.html", { headers: ua })).status, 200);
  assert.ok((await (await fetch(base + "/@olga/", { headers: ua })).text()).includes('id="garden"'));
  assert.equal((await fetch(base + "/v1/gardens/recent")).status, 200);
  h.server.close(); C.FLAGS.garden = false;
});
