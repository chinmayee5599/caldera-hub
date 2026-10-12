// End to end with the real plugin renderer (from ../caldera): publish a rendered profile to a real hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "@caldera/core";
import { createHub } from "../dist/server.js";
import { renderProfile } from "../../../../caldera/packages/plugin/test/render.build.mjs";

const day = (i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
const sample = () => ({
  name: "Ana <script>alert(1)</script>", handle: "ana", headline: "Builder", theme: "dark",
  links: [["Site", "https://example.com"]], properties: [["based", "Venice"]],
  sections: { journal: true, scoreboard: true, properties: true, numbers: true, topics: true, notes: true, asks: true, social: true, links: true },
  stats: { notes: 1200, words: 340000, links: 5100, activeDays: 90 },
  topics: [["AI", 12], ["Design", 4]],
  daily: [5, 4, 3, 2, 1, 0].map((i, k) => ({ date: day(i), counts: { notes: 3 + k, meetings: k, emails: 2 * k }, headline: k === 4 ? "Shipped the beta" : undefined, focus: k === 4 ? ["Beta"] : [] })),
  publicNotes: [{ title: "Why local-first", excerpt: "Because your notes are yours.", updated: new Date().toISOString() }],
  asks: [{ title: "Need a designer", bounty: 20 }], offers: [{ title: "Happy to review decks" }],
  social: { friends: 3, gravity: 2.5, credits: 120 }, updated: new Date().toISOString(),
});

test("end to end: plugin-style publish to a real hub, page is served", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-e2e-"));
  const hub = createHub({ dataDir: dir }); const base = "http://127.0.0.1:" + await hub.listen(0);
  const me = C.newIdentity(); const p = sample();
  const files = {}; for (const [k, v] of Object.entries(renderProfile(p))) files[k] = Buffer.from(v).toString("base64");
  const manifest = C.sign(me, "profile.manifest", { name: p.name, handle: "ana", boxKey: me.boxPublic, daily: p.daily.map(d => ({ date: d.date, score: C.activityScore(d.counts) })) });
  const r = await fetch(`${base}/v1/profiles/${me.id}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest, files }) }).then(r => r.json());
  assert.equal(r.url, "/@ana/");
  const page = await fetch(base + "/@ana/").then(r => r.text());
  assert.ok(page.includes("Shipped the beta"));
  const css = await fetch(base + "/@ana/assets/theme.css"); assert.equal(css.headers.get("content-type"), "text/css");
  hub.server.close(); fs.rmSync(dir, { recursive: true, force: true });
});
