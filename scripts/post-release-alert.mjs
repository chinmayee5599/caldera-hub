#!/usr/bin/env node
// Post a release's notes (from the deployed releases.json) as a Caldera alert, once per version.
// Usage: node scripts/post-release-alert.mjs 0.20.0   (run after the site with that releases.json entry is deployed)
import { execFileSync } from "node:child_process";
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) { console.error("usage: post-release-alert.mjs <version>"); process.exit(1); }
const host = process.env.CALDERA_HOST || "DIRECTOR";
const cmd = `cd /opt/caldera-hub && sudo -u ubuntu CALDERA_DATA=/opt/caldera-hub/data node dist/admin.js alert-release ${v} --releases /opt/caldera-hub/site/releases.json`;
process.stdout.write(execFileSync("ssh", [host, cmd], { encoding: "utf8" }));
