/**
 * Hub operator tool. Run on the server next to the hub (same data dir):
 *   CALDERA_DATA=/opt/caldera-hub/data node dist/admin.js list
 *   ... hide <handle> "reason"     take a profile down (page 410, out of search/directory); owner cannot republish
 *   ... unhide <handle>            undo hide/block
 *   ... remove <handle> "reason"   erase the profile and everything tied to it, and keep the handle off-limits
 *   ... block <handle> "reason"    reserve a handle so nobody can claim it (impersonation, trademarks)
 * Alerts (the bell in every signed-in bar; operator-only):
 *   ... alert-post --title "..." --body-file body.md [--pin] [--cta-label "Open Settings" --cta-url /settings]
 *                  [--copy-file prompt.txt --copy-label "Copy the prompt"] [--audience all|github|obsidian]
 *   ... alert-pin <id> | alert-unpin <id> | alert-delete <id> | alert-list
 *   ... alert-release <version> --releases /opt/caldera-hub/site/releases.json   (one alert per version, deduped)
 */
import fs from "node:fs";
import { createHub } from "./server.js";

const argv = process.argv.slice(2), cmd = argv[0] || "";
const flag = (name: string) => { const i = argv.indexOf("--" + name); return i > 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes("--" + name);
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const usage = () => { console.log("usage: admin.js list | hide|unhide|remove|block <handle> [reason] | alert-post --title T --body-file F [--pin] [--cta-label L --cta-url U] [--copy-file F --copy-label L] [--audience all|github|obsidian] | alert-pin|alert-unpin|alert-delete <id> | alert-list | alert-release <version> --releases <releases.json>"); process.exit(1); };

const hub = createHub({ dataDir: process.env.CALDERA_DATA || "./data" });
const a = hub.admin as any;
try {
  if (cmd === "alert-post") {
    const title = flag("title"), bodyFile = flag("body-file");
    if (!title || !bodyFile) usage();
    out(a.alertPost({ title, body: fs.readFileSync(bodyFile!, "utf8"), pinned: has("pin"), ctaLabel: flag("cta-label"), ctaUrl: flag("cta-url"),
      copyText: flag("copy-file") ? fs.readFileSync(flag("copy-file")!, "utf8") : undefined, copyLabel: flag("copy-label"), audience: flag("audience") as any, by: "operator" }));
  } else if (cmd === "alert-pin" || cmd === "alert-unpin") { if (!argv[1]) usage(); out(a.alertPin(argv[1], cmd === "alert-pin")); }
  else if (cmd === "alert-delete") { if (!argv[1]) usage(); out(a.alertDelete(argv[1])); }
  else if (cmd === "alert-list") out(a.alertList());
  else if (cmd === "alert-release") {
    const v = argv[1], file = flag("releases"); if (!v || !file) usage();
    const rel = (JSON.parse(fs.readFileSync(file!, "utf8")).releases || []).find((r: any) => r.version === v);
    if (!rel) { console.error(`no release ${v} in ${file}`); process.exit(2); }
    const items = (rel.items || []).map((x: string) => `- ${x}`).join("\n");
    const body = [items, rel.howto ? String(rel.howto) : "", "Update Caldera in Obsidian: Settings -> Community plugins -> Check for updates. GitHub sign-ups get new features automatically."].filter(Boolean).join("\n\n");
    out(a.alertPost({ title: `New in Caldera ${v}: ${rel.title || "what's new"}`, body, version: v, ctaLabel: "All release notes", ctaUrl: "/changelog", by: "release" }));
  } else {
    const [, handle, ...why] = argv;
    if (!cmd || !(cmd in a) || cmd.startsWith("alert") || (cmd !== "list" && !handle)) usage();
    out(cmd === "list" ? a.list() : a[cmd](handle!.toLowerCase().replace(/^@/, ""), why.join(" ")));
  }
} finally { hub.db.close(); }
