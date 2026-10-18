// Every link that leaves caldera.social opens in a new window: rewrite off-site <a href> in the built site pages.
import fs from "node:fs";
import path from "node:path";
import { externalLinksNewWindow } from "@caldera/core";
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../packages/site");
let n = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".html")) continue;
  const p = path.join(dir, f), s = fs.readFileSync(p, "utf8"), out = externalLinksNewWindow(s, ["caldera.social"]);
  if (out !== s) { fs.writeFileSync(p, out); n++; }
}
console.log(`new-window links: ${n} page(s) updated`);
