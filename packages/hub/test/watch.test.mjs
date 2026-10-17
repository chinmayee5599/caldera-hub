import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

let hub, base, dir;
const ids = { mike: C.newIdentity(), ana: C.newIdentity() };
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const b64 = s => Buffer.from(s).toString("base64");

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-watch-"));
  hub = createHub({ dataDir: dir, publicUrl: "https://hub.test", limits: { newProfilesPerDay: 100 } });
  base = "http://127.0.0.1:" + await hub.listen(0);
  const files = { mike: { "index.html": b64("<html><body>hi</body></html>"), "city.html": b64("<html><body>city</body></html>") }, ana: { "index.html": b64("<html><body>hi</body></html>") } };
  for (const who of ["mike", "ana"]) await post(`/v1/profiles/${ids[who].id}/bundle`, { manifest: C.sign(ids[who], "profile.manifest", { name: who === "mike" ? "Mike <J>" : who, handle: who, boxKey: ids[who].boxPublic }), files: files[who] });
});
after(() => { hub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("/watch/@handle frames the city in mini mode under a strict, hub-only policy", async () => {
  const r = await fetch(`${base}/watch/@mike?view=public`);
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /frame-src 'self'/); assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  const html = await r.text();
  assert.match(html, /<iframe id="c" src="\/@mike\/city\.html\?view=public#mini"/);
  assert.match(html, /documentPictureInPicture/);
  assert.match(html, /Mike &lt;J&gt;'s city/, "the name is escaped");
});

test("/watch 404s for a profile without a city, an unknown handle, or a bad path", async () => {
  assert.equal((await fetch(`${base}/watch/@ana`)).status, 404);
  assert.equal((await fetch(`${base}/watch/@nobody`)).status, 404);
  assert.notEqual((await fetch(`${base}/watch/@mike/../../etc`)).status, 200);
});
