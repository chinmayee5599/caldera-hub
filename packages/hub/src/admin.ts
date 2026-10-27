/**
 * Hub operator tool. Run on the server next to the hub (same data dir):
 *   CALDERA_DATA=/opt/caldera-hub/data node dist/admin.js list
 *   ... hide <handle> "reason"     take a profile down (page 410, out of search/directory); owner cannot republish
 *   ... unhide <handle>            undo hide/block
 *   ... remove <handle> "reason"   erase the profile and everything tied to it, and keep the handle off-limits
 *   ... block <handle> "reason"    reserve a handle so nobody can claim it (impersonation, trademarks)
 *   ... merge <from> <into> "reason"  one person, two profiles: move <from>'s friends, credit, messages, posts, GitHub and
 *                                  email sign-in and website keys into <into>, erase <from>, and redirect /@from/ to /@into/
 *   ... merges | aliases           past merges / merged-away handles that redirect
 *   ... gh-remove | gh-restore <login>  take a non-member's caldera.social/gh/<login> preview down (removal request) or back
 * Alerts, the GitHub circle job and other operator commands live in caldera.social's private tools.
 */
import fs from "node:fs";
import path from "node:path";
import { createHub } from "./server.js";

const argv = process.argv.slice(2), cmd = argv[0] || "";
// removal requests for caldera.social/gh/<login> previews of people who are not members (no hub needed)
if (cmd === "gh-remove" || cmd === "gh-restore") {
  const login = String(argv[1] || "").toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9-]{1,39}$/.test(login)) { console.log("usage: admin.js gh-remove|gh-restore <github-login>"); process.exit(1); }
  const dir = path.join(process.env.CALDERA_DATA || "./data", "gh-preview"), f = path.join(dir, "removed.txt");
  fs.mkdirSync(dir, { recursive: true });
  const set = new Set((fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "").split(/\r?\n/).map(x => x.trim().toLowerCase()).filter(Boolean));
  if (cmd === "gh-remove") { set.add(login); for (const ext of [".json", ".png"]) fs.rmSync(path.join(dir, login + ext), { force: true }); } else set.delete(login);
  fs.writeFileSync(f, [...set].sort().join("\n") + "\n");
  console.log(JSON.stringify({ ok: true, [cmd === "gh-remove" ? "removed" : "restored"]: login, total: set.size }));
  process.exit(0);
}
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const usage = () => { console.log("usage: admin.js list | merges | aliases | hide|unhide|remove|block <handle> [reason] | merge <from-handle> <into-handle> [reason]"); process.exit(1); };
const clean = (h: string) => h.toLowerCase().replace(/^@/, "");

const hub = createHub({ dataDir: process.env.CALDERA_DATA || "./data" });
const a = hub.admin as any;
try {
  if (cmd === "merge") {
    const [, from, into, ...why] = argv;
    if (!from || !into) usage();
    out(a.merge(clean(from!), clean(into!), why.join(" ")));
  } else {
    const [, handle, ...why] = argv;
    if (!["list", "merges", "aliases", "hide", "unhide", "remove", "block"].includes(cmd) || (!["list", "merges", "aliases"].includes(cmd) && !handle)) usage();
    out(["list", "merges", "aliases"].includes(cmd) ? a[cmd]() : a[cmd](clean(handle!), why.join(" ")));
  }
} finally { hub.db.close(); }
