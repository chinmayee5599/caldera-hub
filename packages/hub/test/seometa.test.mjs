import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub, profileMeta } from "../dist/server.js";

// search titles and descriptions on member pages: short, unique (the handle), cut at a word, only what the page shows
test("profile titles stay within 60 characters and keep the handle; descriptions within 160, cut at a word", () => {
  const long = "Full-stack developer passionate about building scalable web applications with React, Node.js and cloud-native technologies. Open to collaboration.";
  const cases = [
    { handle: "galitsky94", name: "galitsky94", headline: "JavaScript and TypeScript developer", repos: 12 },
    { handle: "radrebelsam", name: "Dexin Yang", headline: "JavaScript and HTML developer", tags: ["web apps", "JavaScript", "HTML"], repos: 30 },
    { handle: "abineshabee", name: "Abinesh", headline: long, tags: ["React", "Node.js", "AWS", "Docker", "MongoDB", "TypeScript"], repos: 41 },
    { handle: "averyveryverylonghandle-123456789", name: "Someone With A Really Quite Long Display Name", headline: "Engineer" },
    { handle: "x", name: "", headline: "word ".repeat(80) },
  ];
  for (const c of cases) for (const city of [false, true]) {
    const { title, desc } = profileMeta({ ...c, city });
    assert.ok(title.length <= 60, `title ${title.length}: ${title}`);
    assert.ok(title.endsWith(" | Caldera"), title);
    assert.ok(title.includes("@" + c.handle.slice(0, 20)), `handle in ${title}`);
    assert.ok(desc.length <= 160 && desc.length >= 70, `desc ${desc.length}: ${desc}`);
    assert.doesNotMatch(desc, /\s(and|of|with|the)…$/, desc);
  }
  assert.equal(profileMeta({ handle: "galitsky94", name: "galitsky94", headline: "JavaScript and TypeScript developer" }).title, "@galitsky94 - JavaScript and TypeScript developer | Caldera");
  assert.equal(profileMeta({ handle: "radrebelsam", name: "Dexin Yang", headline: "JavaScript and HTML developer" }).title, "Dexin Yang (@radrebelsam) - JavaScript and HTML | Caldera");
  assert.equal(profileMeta({ handle: "pli477", name: "pli477", city: true }).title, "@pli477's GitHub city | Caldera");
  // the long headline: its first sentence, whole, rather than a cut mid-phrase
  assert.equal(profileMeta({ handle: "abineshabee", name: "Abinesh", headline: long }).desc.split(". ")[0], "Abinesh (@abineshabee): Full-stack developer passionate about building scalable web applications with React, Node.js and cloud-native technologies.");
  // two members with the same one-word headline get different descriptions
  const a = profileMeta({ handle: "airshipcapital", name: "AirshipCapital", headline: "Developer" }).desc, b = profileMeta({ handle: "cyb3rg0blin", name: "cyb3rg0blin", headline: "Developer" }).desc;
  assert.notEqual(a, b); assert.ok(a.length >= 70 && b.length >= 70, a + " / " + b);
});

test("indexable profile pages get the short title and description; HSTS only on an https hub", async () => {
  for (const publicUrl of ["https://hub.test", "http://hub.test"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-seometa-"));
    const hub = createHub({ dataDir: dir, publicUrl, limits: { newProfilesPerDay: 100 } }), base = "http://127.0.0.1:" + await hub.listen(0);
    try {
      const id = C.newIdentity();
      const r = await fetch(`${base}/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        manifest: C.sign(id, "profile.manifest", { name: "Dexin Yang", handle: "radrebelsam", boxKey: id.boxPublic, headline: "JavaScript and HTML developer" }),
        files: { "index.html": Buffer.from(`<html><head><title>Dexin Yang (@radrebelsam) - JavaScript and HTML developer</title><meta name="description" content="x"></head><body><h1 class="title">Dexin Yang</h1><p class="lede">JavaScript and HTML developer</p></body></html>`).toString("base64") } }) });
      assert.equal(r.status, 200);
      const res = await fetch(base + "/@radrebelsam/", { headers: { "user-agent": "Mozilla/5.0" } }), html = await res.text();
      assert.equal(res.headers.get("x-robots-tag"), "index, follow, max-image-preview:large");
      assert.match(html, /<title>Dexin Yang \(@radrebelsam\) - JavaScript and HTML \| Caldera<\/title>/);
      const d = html.match(/<meta name="description" content="([^"]*)">/g); assert.equal(d.length, 1, "one description");
      assert.match(d[0], /Dexin Yang \(@radrebelsam\): JavaScript and HTML developer\./);
      const hsts = (await fetch(base + "/robots.txt")).headers.get("strict-transport-security");
      if (publicUrl.startsWith("https")) assert.equal(hsts, "max-age=31536000"); else assert.equal(hsts, null);
    } finally { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
