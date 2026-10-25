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
 * Alerts, the GitHub circle job and other operator commands live in caldera.social's private tools.
 */
import { createHub } from "./server.js";

const argv = process.argv.slice(2), cmd = argv[0] || "";
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
