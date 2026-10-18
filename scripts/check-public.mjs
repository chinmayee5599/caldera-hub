#!/usr/bin/env node
/**
 * Open-core guard: this repository is public. caldera.social's ranking, matching and anti-abuse logic lives in the
 * private caldera-private repo and is loaded at runtime (packages/hub/src/ext.ts). This check fails if that logic, or
 * a file meant for the private repo, shows up in the public tree. Run by the hub's `npm test`.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
// files that belong in caldera-private (by name, anywhere under packages/)
const PRIVATE_FILES = [/(^|\/)src\/private\//, /(^|\/)repoconnect\.ts$/, /(^|\/)tags\.ts$/, /(^|\/)digest-rank\.ts$/, /(^|\/)feedmatch\.ts$/, /(^|\/)gate\.ts$/, /(^|\/)suggest\.ts$/];
// fingerprints of the private implementations (none of these belong in public code)
const PRIVATE_SIGNS = [
  /export function repoConnector\b/, /\bfollowWhy\b/, /function suggestScore[\s\S]{0,400}3 \* shared\.length/, /Also mentions /,
  /age >= 3 \* 86_400_000/, /openrouter\.ai\/api/, /\bTAG_VOCAB\b|\bVOCABULARY\b/, /\brankSetup\b|\bsubjectFor\b/, /\bmatchPost\b\s*\(/,
  /\bSTACK_DEPS\b/, /\b(ruleTags|llmTags|mergeTags|stackOfDep)\b/, /\["AI agents", \/\\b/, /\bROLE_WORDS\b|\bHIRER\b/, /export const matcher\b/, /const isActive = \(d: DigestData\)/,
];
const SKIP = new Set(["node_modules", ".git", "dist", "site"]);
const bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name), rel = path.relative(root, p);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|mts|js|mjs|cjs)$/.test(e.name) || rel === "scripts/check-public.mjs") continue;
    if (PRIVATE_FILES.some(r => r.test(rel))) bad.push(`${rel}: belongs in caldera-private`);
    const src = fs.readFileSync(p, "utf8");
    for (const r of PRIVATE_SIGNS) if (r.test(src) && !(rel.endsWith("src/ext.ts") && /matchPost/.test(String(r)))) bad.push(`${rel}: contains private logic (${r})`);
  }
})(path.join(root, "packages"));
if (bad.length) { console.error("check-public: private code in the public repo:\n  " + bad.join("\n  ")); process.exit(1); }
console.log("check-public: ok (no private logic in the public tree)");
