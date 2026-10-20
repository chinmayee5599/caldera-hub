import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";

// THE header: every page shows the same bar for the same viewer, whatever built the page (static site, hub page,
// hosted profile or city of any plugin version). Only the current-page highlight differs between pages.
test("one header: same markup for the same viewer on site pages, hub pages, profiles and cities", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-header-")), site = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-header-site-"));
  const oldNav = `<header class="nav"><a class="brand" href="./">Caldera</a><nav><a href="/people">People</a><a href="/signin">Sign in</a></nav><a class="btn small" href="./#install">Get started</a></header>`;
  for (const f of ["people.html", "guide.html", "index.html"]) fs.writeFileSync(path.join(site, f), `<!doctype html><html><head><title>${f}</title></head><body>${oldNav}<main>${f}</main></body></html>`);
  const h = createHub({ dataDir: d, siteDir: site, publicUrl: "http://hub.test", limits: { newProfilesPerDay: 100 } });
  const base = "http://127.0.0.1:" + await h.listen(0);
  const page = (name, title) => `<!doctype html><html><head><title>${name}</title></head><body><h1 class="title">${title}</h1><p class="lede">Hi</p><h1 class="c-title">${title}'s city</h1></body></html>`;
  const publish = async (id, handle) => {
    const manifest = C.sign(id, "profile.manifest", { name: handle.toUpperCase(), handle, boxKey: id.boxPublic, headline: "Hi", daily: [] });
    const files = { "index.html": Buffer.from(page("p", handle)).toString("base64"), "city.html": Buffer.from(page("c", handle)).toString("base64") };
    const r = await fetch(base + `/v1/profiles/${id.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest, files }) });
    assert.equal(r.status, 200);
  };
  const mike = C.newIdentity(), ana = C.newIdentity();
  await publish(mike, "mike"); await publish(ana, "ana");
  const t = crypto.randomBytes(32).toString("hex");
  h.db.prepare("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(crypto.createHash("sha256").update(t).digest("hex"), mike.id, new Date().toISOString(), Date.now() + 86_400_000);
  const asMike = { cookie: "cal_own=" + t, "user-agent": "Mozilla/5.0" }, anon = { "user-agent": "Mozilla/5.0" };
  const grab = async (p, headers) => { const r = await fetch(base + p, { headers }); const html = await r.text();
    const m = html.match(/<header class="ch"[\s\S]*?<\/header>/); assert.ok(m, `header on ${p}`);
    assert.equal((html.match(/<header class="ch"/g) || []).length, 1, `exactly one header on ${p}`);
    assert.ok(!html.includes('<header class="nav"') && !html.includes("<!--caldera:header-->"), `old header gone on ${p}`);
    return { r, hd: m[0].replace(/ aria-current="page"/g, "") }; };

  // signed in, someone else's pages and every site page: identical
  const signedIn = ["/people", "/guide", "/", "/@ana/", "/@ana/city.html"];
  const first = await grab(signedIn[0], asMike);
  assert.match(first.hd, /data-state="in"/); assert.match(first.hd, /@mike</); assert.match(first.hd, /class="ch-bell"/);
  assert.match(first.r.headers.get("cache-control") || "", /no-store/, "signed-in pages are never cached");
  for (const p of signedIn.slice(1)) assert.equal((await grab(p, asMike)).hd, first.hd, `same signed-in header on ${p}`);
  // own profile and own city: identical to each other, with Public | Private
  const own = await grab("/@mike/", asMike), ownCity = await grab("/@mike/city.html", asMike);
  assert.match(own.hd, /data-state="own"/); assert.match(own.hd, /class="ch-seg"/);
  assert.equal(own.hd.replace(/city\.html/g, ""), ownCity.hd.replace(/city\.html/g, ""), "own profile and own city share the header");
  // signed out: identical everywhere except where Sign in / Get started point (a profile's owner sign-in + invite)
  const norm = (s) => s.replace(/signin\?h=[a-z0-9-]+/g, "signin").replace(/\/\?invite=[a-z0-9-]+#install/g, "/#install");
  const out = await grab("/people", anon);
  assert.match(out.hd, /data-state="out"/); assert.match(out.hd, /Get started/); assert.doesNotMatch(out.hd, /ch-bell|@mike/);
  for (const p of ["/guide", "/", "/@mike/", "/@ana/city.html"]) assert.equal(norm((await grab(p, anon)).hd), norm(out.hd), `same signed-out header on ${p}`);
  assert.match((await grab("/@ana/", anon)).hd, /\/\?invite=ana#install/, "profiles invite to their owner");
  h.server.close();
});

test("Home Screen app: every page with the header links one site-wide manifest, so saved links stay full screen", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { createHub } = await import("../dist/server.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-app-")), hub = createHub({ dataDir: d, publicUrl: "http://hub.test" });
  try {
    const base = "http://127.0.0.1:" + await hub.listen(0);
    const m = await fetch(base + "/manifest.webmanifest");
    assert.equal(m.status, 200); assert.match(m.headers.get("content-type"), /manifest\+json/);
    const j = await m.json(); assert.equal(j.scope, "/"); assert.equal(j.display, "standalone"); assert.ok(j.start_url.startsWith("/"));
    assert.ok(j.icons.some(i => i.sizes === "512x512"));
    const feed = await (await fetch(base + "/feed")).text();
    assert.match(feed, /<link rel="manifest" href="\/manifest\.webmanifest">[\s\S]*<\/head>/, "in the head");
    assert.match(feed, /apple-mobile-web-app-capable" content="yes"/);
    assert.match(feed, /<meta name="viewport" content="[^"]*viewport-fit=cover"/);
    assert.equal((feed.match(/rel="manifest"/g) || []).length, 1, "once");
  } finally { hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
