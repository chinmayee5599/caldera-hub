/**
 * Sign up with email, and let your AI write it: for people who use ChatGPT or Claude but not GitHub or Obsidian.
 *
 * 1. /start: copy a prompt into any AI, paste back the profile it writes, give an email address.
 * 2. We email a one-time link; opening it publishes the page and signs them in (the hub holds their key, as it does for
 *    GitHub sign-ups).
 * 3. Updates: Settings has a "What's new?" prompt; the answer pasted back updates the page and grows the city. A weekly
 *    email nudge (opt-out) brings the prompt back when they haven't updated in 7 days.
 *
 * The city: each project is a building; every update that mentions it adds to it (taller over time); projects mentioned
 * this week have lit windows, today a crane. The website snippet (live visitors) works for these pages too.
 * New email pages stay out of People and the world map for 3 days, or until someone follows them (spam).
 */
import type http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "@caldera/core";
import { renderProfile, type ProfileData } from "../../../../caldera/packages/plugin/src/render";
import { cityData, type CityRepo } from "../../../../caldera/packages/plugin/src/city";

const DAY = 86_400_000;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const clean = (v: unknown, n: number) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const okEmail = (e: string) => /^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i.test(e) && e.length <= 200;
const okUrl = (u: string) => /^https?:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 300;

/** What a profile block can say. Every field is optional; an update block replaces what it contains and adds to the log. */
export interface Profile {
  name?: string; headline?: string; about?: string; location?: string; role?: string;
  links?: [string, string][]; now?: string[]; topics?: string[];
  projects?: { name: string; status: string; url: string; about: string }[];
  timeline?: [string, string][];
  /** an update's "this week" lines: [project, what happened] */
  worked?: [string, string][];
}
const LIST_KEYS = ["links", "now", "projects", "timeline", "topics", "worked_on", "worked on"];

/** Read the block an AI wrote (forgiving: code fences, bullets, bold keys, extra chatter around it). */
export function parseProfile(raw: string): Profile {
  const text = String(raw || "").slice(0, 20_000).replace(/```[a-z]*\n?/gi, "").replace(/\r/g, "");
  const p: Profile = {}; let cur = "";
  const lists: Record<string, string[]> = {};
  for (let line of text.split("\n")) {
    line = line.replace(/\*\*/g, "").trimEnd(); if (!line.trim()) continue;
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item && cur) { (lists[cur] = lists[cur] || []).push(item[1].trim()); continue; }
    const kv = line.match(/^\s*([A-Za-z][A-Za-z _]{1,20}):\s*(.*)$/);
    if (!kv) { if (cur === "about" && p.about) p.about = clean(p.about + " " + line, 1200); continue; }
    const key = kv[1].trim().toLowerCase(), val = kv[2].trim();
    cur = key === "summary" || key === "bio" ? "about" : key === "worked on" ? "worked_on" : key;
    if (LIST_KEYS.includes(key) || key === "worked_on") { if (val && key === "topics") lists.topics = val.split(/[,;]/); continue; }
    if (key === "name") p.name = clean(val, 80);
    else if (key === "headline" || key === "tagline") p.headline = clean(val, 160);
    else if (key === "about" || key === "summary" || key === "bio") p.about = clean(val, 1200);
    else if (key === "location" || key === "based") p.location = clean(val, 60);
    else if (key === "role" || key === "title") p.role = clean(val, 80);
  }
  const split = (s: string) => s.split("|").map(x => clean(x, 300));
  if (lists.links) p.links = lists.links.map(split).map(([a, b]) => okUrl(b || "") ? [a.slice(0, 40), b] as [string, string] : okUrl(a || "") ? [a.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40), a] as [string, string] : null).filter(Boolean).slice(0, 12) as [string, string][];
  if (lists.now) p.now = lists.now.map(x => clean(x, 200)).filter(Boolean).slice(0, 6);
  if (lists.topics) p.topics = lists.topics.map(x => clean(x, 32)).filter(Boolean).slice(0, 12);
  if (lists.projects) p.projects = lists.projects.map(split).map(([name, status = "", url = "", about = ""]) => {
    if (okUrl(status) && !okUrl(url)) [status, url, about] = ["", status, url];   // "Name | https://... | about"
    return { name: clean(name, 60), status: clean(status, 60), url: okUrl(url) ? url : "", about: clean(about, 200) }; }).filter(x => x.name).slice(0, 12);
  if (lists.timeline) p.timeline = lists.timeline.map(x => { const [y, ...r] = x.split("|"); return [clean(y, 12), clean(r.join("|"), 300)] as [string, string]; }).filter(([y, t]) => y && t).slice(0, 30);
  if (lists.worked_on) p.worked = lists.worked_on.map(x => { const [a, ...r] = x.split("|"); return [clean(a, 60), clean(r.join("|"), 200)] as [string, string]; }).filter(([a]) => a).slice(0, 12);
  return p;
}

export const START_PROMPT = `Help me make my profile page on Caldera (caldera.social), a social network for people who build things. Use what you already know about me from our conversations; ask me up to 5 short questions only for what you can't fill in. Then reply with ONLY this block, filled in, nothing before or after it. Leave out any line you have nothing true for. Don't invent anything, and keep private things private (no addresses, phone numbers, salaries or anything about other people).

name: <my name>
headline: <one line: what I do or build>
about: <two or three sentences about me, in the first person>
location: <city, optional>
now:
- <something I'm working on right now>
- <another>
projects:
- <Project name> | <status: idea, building, live> | <https://link if there is one> | <one line about it>
timeline:
- <year> | <a milestone> | <one line of detail>
links:
- <Label> | <https://...>
topics: <5 to 8 topics, comma separated>`;

export const UPDATE_PROMPT = `Help me update my Caldera profile (caldera.social) with what's new. Ask me what I worked on this week if you don't already know, then reply with ONLY this block, filled in, nothing before or after it. Leave out any line you have nothing true for, and don't invent anything.

now:
- <what I'm working on right now>
worked_on:
- <Project name> | <what I did on it this week>
projects:
- <Project name> | <status> | <https://link> | <one line about it>   (only new projects or changes)
headline: <only if it changed>`;

export interface EmailCtx {
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string;
  accept: (e: C.Envelope) => { status: number; body: any };
  dataDir: string; publicUrl: string; reserved: Set<string>;
  byHandle: (h: string) => any; profile: (id: string) => any;
  startOwner: (id: string) => string; memberOf: (req: http.IncomingMessage) => string | null;
  sameOrigin: (req: http.IncomingMessage) => boolean; allowNewProfile: (req: http.IncomingMessage) => boolean;
  tooMany: (key: string, max: number, windowMs?: number) => boolean;
  note: (m: { to: string; subject: string; title: string; html: string; text: string; headers?: Record<string, string> }) => Promise<boolean>;
  page: (res: http.ServerResponse, status: number, title: string, body: string) => void;
  hasFollower: (id: string) => boolean;
  /** remember the confirmed address so message alerts and the daily summary can reach them */
  rememberEmail: (owner: string, email: string) => void;
  /** delete the member and everything tied to them (the hub's own erase) */
  eraseProfile: (id: string) => void;
  onPublished?: (id: string, created: boolean) => void;
}

export function emailPages(c: EmailCtx) {
  const { q } = c, pub = c.publicUrl.replace(/\/$/, "");
  q(`CREATE TABLE IF NOT EXISTS email_accounts (profile_id TEXT PRIMARY KEY, handle TEXT, email_hash TEXT UNIQUE, email_sealed TEXT, key_sealed TEXT,
      content TEXT, log TEXT, created TEXT, updated TEXT, nudged TEXT, nudge_off INTEGER DEFAULT 0)`).run();
  q(`CREATE TABLE IF NOT EXISTS email_pending (token_hash TEXT PRIMARY KEY, email_sealed TEXT, content TEXT, expires INTEGER, ts TEXT)`).run();
  const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const acctOf = (id: string | null) => id ? q("SELECT * FROM email_accounts WHERE profile_id=?").get(id) as any : null;

  const handleFor = (name: string, email: string) => {
    let h = (name || email.split("@")[0]).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26) || "member";
    if (h.length < 2) h += "-x";
    const free = (x: string) => !c.reserved.has(x) && !c.byHandle(x) && !q("SELECT 1 FROM email_accounts WHERE handle=?").get(x) && !q("SELECT 1 FROM gh_accounts WHERE handle=?").get(x);
    if (free(h)) return h;
    for (let i = 2; i < 100; i++) if (free(`${h}-${i}`)) return `${h}-${i}`;
    return h + "-" + crypto.randomBytes(2).toString("hex");
  };

  /** merge an update into the stored profile: fields it has replace, projects merge by name, "worked on" goes to the log */
  function merge(old: Profile, up: Profile): Profile {
    const out: Profile = { ...old };
    for (const k of ["name", "headline", "about", "location", "role", "links", "now", "topics", "timeline"] as const) if (up[k] !== undefined && (Array.isArray(up[k]) ? (up[k] as any[]).length : up[k])) (out as any)[k] = up[k];
    if (up.projects?.length) { const byName = new Map((old.projects || []).map(p => [p.name.toLowerCase(), p]));
      for (const p of up.projects) byName.set(p.name.toLowerCase(), { ...(byName.get(p.name.toLowerCase()) || {}), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) } as any);
      out.projects = [...byName.values()].slice(0, 16); }
    return out;
  }

  /** build and publish the page and city from what they've told us */
  function publish(acct: any): string {
    const pr: Profile = JSON.parse(acct.content || "{}"), log: { ts: string; project: string; what: string }[] = JSON.parse(acct.log || "[]");
    const id = JSON.parse(c.unseal(acct.key_sealed)) as C.Identity, handle = acct.handle as string, name = pr.name || handle, now = Date.now();
    // the city: one building per project; every logged mention adds to it
    const projects = [...(pr.projects || [])];
    for (const l of log) if (!projects.some(p => p.name.toLowerCase() === l.project.toLowerCase())) projects.push({ name: l.project, status: "", url: "", about: "" });
    const weekIx = (ts: string) => 11 - Math.floor((now - Date.parse(ts)) / (7 * DAY));
    const repos: CityRepo[] = projects.slice(0, 24).map(p => {
      const mine = log.filter(l => l.project.toLowerCase() === p.name.toLowerCase()), weeks = Array(12).fill(0);
      for (const l of mine) { const w = weekIx(l.ts); if (w >= 0 && w < 12) weeks[w] += 3; }
      const last = mine.map(l => l.ts).sort().pop();
      return { name: p.name, project: p.name, public: true, language: p.status || "Project", commits: 4 + mine.length * 6, weeks, week: weeks[11],
        today: mine.filter(l => now - Date.parse(l.ts) < DAY).length, pushed: last || acct.created, created: acct.created, size: 1, url: p.url || undefined, description: p.about || undefined };
    });
    const city = repos.length ? cityData(repos, () => ({ n: 0, paths: [] }), new Date().toISOString()) : undefined;
    const props: [string, string][] = ([["Based", pr.location || ""], ["Role", pr.role || ""], ["On Caldera since", String(acct.created).slice(0, 10)]] as [string, string][]).filter(x => x[1]);
    const updates = log.slice(-60);
    const daily = Array.from({ length: 30 }, (_, i) => { const d = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
      return { date: d, counts: { meetings: 0, emails: 0, prompts: 0, commits: 0, notes: updates.filter(u => u.ts.slice(0, 10) === d).length, docs: 0 } as any }; });
    const p: ProfileData = {
      name, handle, headline: pr.headline || "", theme: "dark", links: pr.links || [], properties: props,
      sections: { journal: false, scoreboard: false, properties: props.length > 0, numbers: false, topics: !!pr.topics?.length, notes: false, asks: false, social: true, links: !!pr.links?.length, sidebar: true, rail: false, city: !!city, timeline: !!pr.timeline?.length },
      stats: { notes: 0, words: 0, links: 0, activeDays: new Set(updates.map(u => u.ts.slice(0, 10))).size }, topics: (pr.topics || []).map(t => [t, 1] as [string, number]), daily, publicNotes: [], asks: [], offers: [],
      updated: acct.updated || new Date().toISOString(), hub: pub, summary: pr.about || undefined, now: pr.now?.length ? pr.now : undefined,
      timeline: pr.timeline?.length ? pr.timeline : undefined,
      projects: (pr.projects || []).map(x => ({ name: x.name, status: x.status || x.about, url: x.url || "", commits: log.filter(l => l.project.toLowerCase() === x.name.toLowerCase()).length || undefined })),
      city, source: "Caldera",
    } as ProfileData;
    const files = renderProfile(p);
    const listed = Date.parse(acct.created) < now - 3 * DAY || c.hasFollower(acct.profile_id);
    const manifest = C.sign(id, "profile.manifest", { name, handle, boxKey: id.boxPublic, headline: p.headline, links: p.links, sections: Object.keys(p.sections).filter(k => (p.sections as any)[k]),
      stats: p.stats, topics: (pr.topics || []).map(t => [t, 1]), asks: [], offers: [], listed, page: "index.html", updated: p.updated, hosted: "email" });
    const r = c.accept(manifest); if (r.status !== 200) throw new Error(r.body?.error || "couldn't publish");
    const dir = path.join(c.dataDir, "profiles", handle);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (const [k, v] of Object.entries(files)) { const f = path.join(dir, path.normalize(k)); if (!f.startsWith(dir)) continue; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
    fs.writeFileSync(path.join(dir, "caldera.json"), JSON.stringify(manifest));
    // live visitors: one site key per project, so the website snippet works for these cities too
    const have = new Set((q("SELECT project FROM traffic_sites WHERE owner=?").all(id.id) as any[]).map(x => x.project));
    for (const d of city?.districts || []) if (!have.has(d.name)) q("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run(crypto.randomBytes(8).toString("hex"), id.id, d.name, 1, crypto.randomBytes(18).toString("hex"), new Date().toISOString());
    return `${pub}/@${handle}/`;
  }

  // ------------------------------------------------------------------ pages
  const STYLE = `<style>.ep{max-width:720px;margin:0 auto;padding:28px 16px 64px}.ep h1{font-family:'Source Serif 4',Georgia,serif;font-size:clamp(1.6rem,3vw,2.2rem);margin:0 0 6px}.ep .lede{color:var(--text-muted);margin:0 0 20px}
.ep .card{background:var(--bg-raised);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}.ep .n{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:13px;margin-right:8px}
.ep h2{font-size:1.05rem;margin:0 0 8px;display:flex;align-items:center}.ep pre{white-space:pre-wrap;font:12.5px/1.5 'IBM Plex Mono',monospace;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:180px;overflow:auto;margin:8px 0}
.ep textarea,.ep input[type=email]{width:100%;box-sizing:border-box;font:14px/1.5 'IBM Plex Mono',monospace;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px}.ep textarea{min-height:200px}
.ep input[type=email]{font-family:inherit;font-size:15px}.ep .mut{color:var(--text-muted);font-size:13.5px}.ep .err{color:#E5484D}.ep .ok{color:#3FB97F}.ep .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px}
.ep button.btn{cursor:pointer}</style>`;
  const copyJs = `<script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy')).textContent;var done=function(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1600)};try{navigator.clipboard.writeText(t).then(done,function(){prompt('Copy this',t)})}catch(e){prompt('Copy this',t)}})})</script>`;

  function startPage(res: http.ServerResponse, msg = "", text = "", email = "") {
    c.page(res, msg.startsWith("ok:") ? 200 : 200, "Sign up with email", `${STYLE}<main class="ep"><h1>Make your page with ChatGPT or Claude</h1>
<p class="lede">No GitHub or Obsidian needed. Your AI writes your profile; you paste it here and confirm your email. Change anything later the same way.</p>
${msg ? `<p class="${msg.startsWith("ok:") ? "ok" : "err"}" role="status">${esc(msg.replace(/^ok:/, ""))}</p>` : ""}
<section class="card"><h2><span class="n">1</span>Copy this prompt into ChatGPT, Claude or any AI</h2><pre id="p-start">${esc(START_PROMPT)}</pre><div class="row"><button type="button" class="btn small" data-copy="p-start">Copy the prompt</button><span class="mut">It works best in a chat that already knows you.</span></div></section>
<form method="post" action="/start" class="card"><h2><span class="n">2</span>Paste what it writes back</h2>
<label class="mut" for="pt">The block that starts with "name:"</label><textarea id="pt" name="text" maxlength="20000" placeholder="name: ...">${esc(text)}</textarea>
<h2 style="margin-top:16px"><span class="n">3</span>Your email</h2><input type="email" name="email" autocomplete="email" required placeholder="you@example.com" value="${esc(email)}">
<p class="mut">We send one link to confirm. Open it and your page goes live. No password.</p>
<div class="row"><button class="btn" type="submit">Make my page</button><span class="mut">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span></div></form>
<p class="mut">Already made your page this way? Enter just your email above (leave the box empty) and we send a sign-in link. Use GitHub? <a href="/auth/github">Sign up with GitHub</a> instead: your repos become your city.</p></main>${copyJs}`);
  }

  function settingsPage(res: http.ServerResponse, acct: any, msg = "") {
    const pr: Profile = JSON.parse(acct.content || "{}"), log: any[] = JSON.parse(acct.log || "[]"), last = log.length ? log[log.length - 1].ts : acct.updated;
    c.page(res, 200, "Your page", `${STYLE}<main class="ep"><h1>Your page</h1>
<p class="lede"><a href="/@${esc(acct.handle)}/">caldera.social/@${esc(acct.handle)}</a> &middot; <a href="/@${esc(acct.handle)}/city.html">your city</a> &middot; last updated ${esc(String(last || "").slice(0, 10))}</p>
${msg ? `<p class="${msg.startsWith("ok:") ? "ok" : "err"}" role="status">${esc(msg.replace(/^ok:/, ""))}</p>` : ""}
<section class="card" id="update"><h2>What's new? Update your page in a minute</h2><p class="mut">Copy this into ChatGPT or Claude, then paste its answer below. Every project you mention grows its building in your city; this week's get lit windows.</p>
<pre id="p-up">${esc(UPDATE_PROMPT)}</pre><button type="button" class="btn small" data-copy="p-up">Copy the update prompt</button>
<form method="post" action="/settings/page" style="margin-top:12px"><input type="hidden" name="do" value="update"><textarea name="text" maxlength="20000" required placeholder="now:&#10;- ...&#10;worked_on:&#10;- Project | what I did"></textarea>
<div class="row"><button class="btn" type="submit">Update my page</button></div></form></section>
<section class="card"><h2>Rewrite the whole page</h2><p class="mut">Run the first prompt again and paste the full block: it replaces your name, headline, About, projects, timeline and links. Your city keeps its history.</p>
<pre id="p-start">${esc(START_PROMPT)}</pre><button type="button" class="btn small" data-copy="p-start">Copy the full prompt</button>
<form method="post" action="/settings/page" style="margin-top:12px"><input type="hidden" name="do" value="replace"><textarea name="text" maxlength="20000" required placeholder="name: ..."></textarea><div class="row"><button class="btn small" type="submit">Replace my page</button></div></form></section>
<section class="card"><h2>Weekly reminder</h2><form method="post" action="/settings/page"><input type="hidden" name="do" value="nudge"><label><input type="checkbox" name="on" ${acct.nudge_off ? "" : "checked"} onchange="this.form.submit()"> Email me the update prompt when I haven't updated in a week</label></form></section>
<section class="card"><h2>Make your city live</h2><p class="mut">Got a website? Put its line in your site's shared layout (or ask your AI to) and real visitors walk into that project's building as they arrive. Call <code>caldera('signup')</code> when someone signs up and the building lights up.</p>
${(q("SELECT key, project FROM traffic_sites WHERE owner=? ORDER BY project").all(acct.profile_id) as any[]).map(x => `<p class="mut" style="margin:10px 0 2px"><b>${esc(x.project)}</b></p><pre id="s-${esc(x.key)}">&lt;script async src="${esc(pub)}/t.js" data-site="${esc(x.key)}"&gt;&lt;/script&gt;</pre><button type="button" class="btn small ghost" data-copy="s-${esc(x.key)}">Copy</button>`).join("") || `<p class="mut">Add a project in an update and its snippet appears here.</p>`}
<p class="mut" style="margin-top:12px">Use GitHub or Obsidian? Connecting them later fills your city from your real work.</p></section>
<section class="card"><h2>Delete my page</h2><form method="post" action="/settings/page" onsubmit="return this.querySelector('[name=sure]').checked"><input type="hidden" name="do" value="delete"><label class="mut"><input type="checkbox" name="sure"> I'm sure: delete my page, city, posts and messages, and forget my email</label> <button class="btn small ghost" type="submit">Delete</button></form></section>
<p class="mut"><b>Showing as:</b> ${esc(pr.name || acct.handle)}${pr.headline ? ` &middot; ${esc(pr.headline)}` : ""}. <a href="/signout">Sign out</a></p></main>${copyJs}`);
  }

  const form = async (req: http.IncomingMessage) => { const ch: Buffer[] = []; for await (const x of req) ch.push(x as Buffer); return new URLSearchParams(Buffer.concat(ch).toString("utf8").slice(0, 60_000)); };
  const ipKey = (req: http.IncomingMessage) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "?");

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    if (p === "/start" && req.method === "GET") { startPage(res); return true; }
    if (p === "/start" && req.method === "POST") {
      if (!c.sameOrigin(req)) { startPage(res, "Wrong origin. Please try again."); return true; }
      const f = await form(req), text = String(f.get("text") || ""), email = String(f.get("email") || "").trim().toLowerCase();
      if (!okEmail(email)) { startPage(res, "That email doesn't look right.", text, email); return true; }
      const pr = parseProfile(text), ex = q("SELECT handle FROM email_accounts WHERE email_hash=?").get(hash(email)) as any;
      // a returning member can leave the box empty: that's a sign-in link
      if (!ex && !pr.name && !pr.headline && !pr.about) { startPage(res, text.trim() ? "We couldn't read that. Paste the whole block your AI wrote, starting with \"name:\"." : "Paste the profile your AI wrote first (step 2).", text, email); return true; }
      if (c.tooMany("emailsignup:" + ipKey(req), 8) || c.tooMany("emailsignup:" + hash(email), 3)) { startPage(res, "Too many tries. Wait an hour, then try again.", text, email); return true; }
      const tok = crypto.randomBytes(24).toString("base64url");
      q("INSERT INTO email_pending VALUES (?,?,?,?,?)").run(hash(tok), c.seal(email), JSON.stringify(pr), Date.now() + 2 * DAY, new Date().toISOString());
      q("DELETE FROM email_pending WHERE expires < ?").run(Date.now());
      const link = `${pub}/start/confirm?t=${tok}`;
      try {
        await c.note({ to: email, subject: ex ? "Your Caldera sign-in link" : "Confirm your email to publish your Caldera page", title: ex ? "Sign in to Caldera" : "One click and your page is live",
          html: `<p>${ex ? `Open this link to sign in as <b>@${esc(ex.handle)}</b> and update your page with what you pasted.` : `Open this link to confirm your email. Your page${pr.name ? ` for <b>${esc(pr.name)}</b>` : ""} goes live right away.`}</p><p><a href="${esc(link)}" style="display:inline-block;padding:11px 18px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">${ex ? "Sign in" : "Publish my page"}</a></p><p style="color:#777;font-size:13px">The link works once, for 48 hours. If you didn't ask for this, ignore this email.</p>`,
          text: `${ex ? "Sign in to Caldera" : "Confirm your email and your Caldera page goes live"}: ${link}\n\nThe link works once, for 48 hours. If you didn't ask for this, ignore this email.` });
      } catch (e: any) { startPage(res, "We couldn't send the email: " + e.message, text, email); return true; }
      c.page(res, 200, "Check your email", `${STYLE}<main class="ep"><h1>Check your email</h1><p class="lede">We sent a link to <b>${esc(email)}</b>. Open it and your page goes live.</p><p class="mut">Nothing there in a minute? Check spam, or <a href="/start">try again</a>.</p></main>`);
      return true;
    }
    // opening the link only shows a button (mail scanners open links; they never press buttons); the button does the work
    if (p === "/start/confirm" && req.method === "GET") {
      const t = String(url.searchParams.get("t") || ""), row0 = t ? q("SELECT expires FROM email_pending WHERE token_hash=?").get(hash(t)) as any : null;
      if (!row0 || row0.expires < Date.now()) { c.page(res, 400, "Link expired", `${STYLE}<main class="ep"><h1>That link expired or was already used</h1><p><a class="btn" href="/start">Start again</a> &middot; <a href="/signin">Sign in</a></p></main>`); return true; }
      c.page(res, 200, "Confirm", `${STYLE}<main class="ep"><h1>One click to finish</h1><form method="post" action="/start/confirm"><input type="hidden" name="t" value="${esc(t)}"><button class="btn" type="submit">Publish my page and sign in</button></form></main>`); return true;
    }
    if (p === "/start/confirm" && req.method === "POST") {
      if (!c.sameOrigin(req)) { c.page(res, 403, "No", `${STYLE}<main class="ep"><h1>Wrong origin</h1></main>`); return true; }
      const t = String((await form(req)).get("t") || ""), row = t ? q("SELECT * FROM email_pending WHERE token_hash=?").get(hash(t)) as any : null;
      if (!row || row.expires < Date.now()) { c.page(res, 400, "Link expired", `${STYLE}<main class="ep"><h1>That link expired or was already used</h1><p><a class="btn" href="/start">Start again</a> &middot; <a href="/signin">Sign in</a></p></main>`); return true; }
      q("DELETE FROM email_pending WHERE token_hash=?").run(hash(t));
      const email = c.unseal(row.email_sealed), pr = JSON.parse(row.content || "{}") as Profile;
      let acct = q("SELECT * FROM email_accounts WHERE email_hash=?").get(hash(email)) as any, created = false;
      if (!acct) {
        if (!c.allowNewProfile(req)) { c.page(res, 429, "One moment", `${STYLE}<main class="ep"><h1>Lots of people are joining right now</h1><p>Open the link again in a minute.</p></main>`); return true; }
        const id = C.newIdentity(), handle = handleFor(pr.name || "", email), now = new Date().toISOString();
        q("INSERT INTO email_accounts (profile_id, handle, email_hash, email_sealed, key_sealed, content, log, created, updated) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(id.id, handle, hash(email), c.seal(email), c.seal(JSON.stringify(id)), JSON.stringify(pr), "[]", now, now);
        acct = q("SELECT * FROM email_accounts WHERE profile_id=?").get(id.id); created = true;
      } else if (Object.keys(pr).length) {
        const merged = merge(JSON.parse(acct.content || "{}"), pr);
        q("UPDATE email_accounts SET content=?, updated=? WHERE profile_id=?").run(JSON.stringify(merged), new Date().toISOString(), acct.profile_id);
        acct = q("SELECT * FROM email_accounts WHERE profile_id=?").get(acct.profile_id);
      }
      c.rememberEmail(acct.profile_id, email);
      try { publish(acct); } catch (e: any) { c.page(res, 500, "Not yet", `${STYLE}<main class="ep"><h1>We couldn't publish your page</h1><p class="mut">${esc(e.message)}</p><p><a class="btn" href="/start">Try again</a></p></main>`); return true; }
      c.onPublished?.(acct.profile_id, created);
      res.writeHead(302, { location: `/@${acct.handle}/city.html?welcome=1`, "set-cookie": c.startOwner(acct.profile_id), "cache-control": "no-store" }); res.end(); return true;
    }
    if (p === "/settings/page" || ((p === "/settings" || p === "/me") && req.method === "GET")) {
      const acct = acctOf(c.memberOf(req));
      if (!acct) { if (p === "/settings/page") { res.writeHead(302, { location: "/signin" }); res.end(); return true; } return false; }   // not an email page: the usual settings
      if (req.method === "GET") { settingsPage(res, acct); return true; }
      if (!c.sameOrigin(req)) { settingsPage(res, acct, "Wrong origin."); return true; }
      const f = await form(req), act = f.get("do");
      if (act === "delete") {
        if (!f.get("sure")) { settingsPage(res, acct, "Tick \"I'm sure\" to delete."); return true; }
        c.eraseProfile(acct.profile_id); q("DELETE FROM email_accounts WHERE profile_id=?").run(acct.profile_id);
        c.page(res, 200, "Deleted", `${STYLE}<main class="ep"><h1>Your page is deleted</h1><p class="lede">Your page, city and data are gone, and we've forgotten your email.</p></main>`); return true; }
      if (act === "nudge") { q("UPDATE email_accounts SET nudge_off=? WHERE profile_id=?").run(f.get("on") ? 0 : 1, acct.profile_id); settingsPage(res, q("SELECT * FROM email_accounts WHERE profile_id=?").get(acct.profile_id), f.get("on") ? "ok:Weekly reminder is on." : "ok:Weekly reminder is off."); return true; }
      if (c.tooMany("emailupdate:" + acct.profile_id, 30)) { settingsPage(res, acct, "That's a lot of updates for one hour."); return true; }
      const up = parseProfile(String(f.get("text") || ""));
      if (!Object.keys(up).length) { settingsPage(res, acct, "We couldn't read that. Paste the whole block your AI wrote."); return true; }
      const old: Profile = JSON.parse(acct.content || "{}"), next = act === "replace" ? { ...up, projects: up.projects?.length ? up.projects : old.projects } : merge(old, up);
      const log: any[] = JSON.parse(acct.log || "[]"), ts = new Date().toISOString();
      for (const [project, what] of up.worked || []) log.push({ ts, project, what });
      for (const n of up.now || []) { const pj = (next.projects || []).find(x => n.toLowerCase().includes(x.name.toLowerCase())); if (pj && !(up.worked || []).some(w => w[0].toLowerCase() === pj.name.toLowerCase())) log.push({ ts, project: pj.name, what: n }); }
      q("UPDATE email_accounts SET content=?, log=?, updated=? WHERE profile_id=?").run(JSON.stringify(next), JSON.stringify(log.slice(-500)), ts, acct.profile_id);
      try { publish(q("SELECT * FROM email_accounts WHERE profile_id=?").get(acct.profile_id)); } catch (e: any) { settingsPage(res, acct, "Saved, but publishing failed: " + e.message); return true; }
      settingsPage(res, q("SELECT * FROM email_accounts WHERE profile_id=?").get(acct.profile_id), `ok:Updated. ${(up.worked || []).length ? `${up.worked!.length} project update${up.worked!.length === 1 ? "" : "s"} added to your city.` : "Your page is republished."}`);
      return true;
    }
    return false;
  }

  /** daily: republish (so new pages get listed after 3 days and windows dim) and send the weekly nudge to quiet pages */
  async function daily() {
    for (const a of q("SELECT * FROM email_accounts").all() as any[]) {
      try { if (c.profile(a.profile_id)) publish(a); } catch (e: any) { console.error("email page republish", a.handle, e.message); }
      const quiet = Date.now() - Date.parse(a.updated) > 7 * DAY, nudged = a.nudged ? Date.now() - Date.parse(a.nudged) < 7 * DAY : false;
      if (a.nudge_off || !quiet || nudged) continue;
      q("UPDATE email_accounts SET nudged=? WHERE profile_id=?").run(new Date().toISOString(), a.profile_id);
      try { const to = c.unseal(a.email_sealed), link = `${pub}/settings#update`;
        await c.note({ to, subject: "What's new this week? Update your Caldera page in a minute", title: "What's new this week?",
          html: `<p>Paste this into ChatGPT or Claude, then paste its answer on <a href="${esc(link)}">your page settings</a>. Every project you mention grows its building in your city.</p><pre style="white-space:pre-wrap;background:#F7F5FC;padding:12px;border-radius:8px;font-size:12.5px">${esc(UPDATE_PROMPT)}</pre><p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">Update my page</a></p><p style="color:#777;font-size:12.5px">At most once a week. Turn it off on your page settings.</p>`,
          text: `Paste this into ChatGPT or Claude, then paste its answer at ${link}:\n\n${UPDATE_PROMPT}\n\nAt most once a week. Turn it off on your page settings.` });
      } catch (e: any) { console.error("email nudge", a.handle, e.message); }
    }
  }
  function schedule() { const t0 = setTimeout(function tick() { void daily(); const t = setTimeout(tick, DAY); t.unref?.(); }, 10 * 60_000); t0.unref?.(); }
  function erase(id: string) { q("DELETE FROM email_accounts WHERE profile_id=?").run(id); }
  return { route, publish, daily, schedule, erase, isEmailPage: (id: string) => !!acctOf(id) };
}
