/**
 * Hub operator tool. Run on the server next to the hub (same data dir):
 *   CALDERA_DATA=/opt/caldera-hub/data node dist/admin.js list
 *   ... hide <handle> "reason"     take a profile down (page 410, out of search/directory); owner cannot republish
 *   ... unhide <handle>            undo hide/block
 *   ... remove <handle> "reason"   erase the profile and everything tied to it, and keep the handle off-limits
 *   ... block <handle> "reason"    reserve a handle so nobody can claim it (impersonation, trademarks)
 * Alerts, the GitHub circle job and other operator commands live in caldera.social's private tools.
 */
import { createHub } from "./server.js";

const argv = process.argv.slice(2), cmd = argv[0] || "";
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const usage = () => { console.log("usage: admin.js list | hide|unhide|remove|block <handle> [reason]"); process.exit(1); };

const hub = createHub({ dataDir: process.env.CALDERA_DATA || "./data" });
const a = hub.admin as any;
try {
  {
    const [, handle, ...why] = argv;
    if (!["list", "hide", "unhide", "remove", "block"].includes(cmd) || (cmd !== "list" && !handle)) usage();
    out(cmd === "list" ? a.list() : a[cmd](handle!.toLowerCase().replace(/^@/, ""), why.join(" ")));
  }
} finally { hub.db.close(); }
