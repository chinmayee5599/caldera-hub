/**
 * Sign up with GitHub: a Caldera profile for people without Obsidian.
 *
 * - One GitHub App does both jobs: sign-in (user token, no extra permissions) and, optionally, private repos as
 *   padlocked buildings (the user installs the app on the repos they choose; read-only metadata).
 * - The app is created with GitHub's manifest flow from the operator's private address: the hub receives its
 *   credentials directly (data/github-app.json, 600); nobody copies a secret.
 * - Hosted accounts: the hub holds the profile's key (sealed at rest) until the person connects a vault and claims it,
 *   at which point the plugin takes the key and the hub deletes its copy.
 * - The page is rendered with the plugin's own renderer, so it looks like every other Caldera profile.
 */
import type http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "@caldera/core";
import { renderProfile, type ProfileData, type DailyEntry } from "../../../../caldera/packages/plugin/src/render";
import { cityData, publicCity, type CityRepo } from "../../../../caldera/packages/plugin/src/city";

export interface GhCtx {
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string;
  accept: (e: C.Envelope) => { status: number; body: any }; erase: (id: string) => void;
  dataDir: string; publicUrl: string; privateUrl?: string;
  json: (res: http.ServerResponse, status: number, body: unknown) => void; readBody: (req: http.IncomingMessage) => Promise<any>;
  allowNewProfile: (req: http.IncomingMessage) => boolean; byHandle: (h: string) => any; reserved: Set<string>;
  /** growth helpers from the hub: suggestions, open requests, referrals */
  social?: { suggest: (id: string, n?: number) => any[]; openRequests: (id: string) => { incoming: any[]; outgoing: any[] }; invitedCount: (id: string) => number;
    recordReferral: (invitee: string, inviterHandle: unknown, via: string) => string | null; email?: EmailHooks };
  /** test hook: replaces fetch for GitHub calls */
  fetch?: typeof fetch;
}
/** Daily summary email hooks for the /me page (implemented in the hub's email module). */
export interface EmailHooks { status: (owner: string) => { email: string; confirmed: boolean } | null; subscribe: (owner: string, email: string) => Promise<string>; unsubscribe: (owner: string) => void }
const GROUP = /^[a-z0-9][a-z0-9-]{1,29}$/;
const groupsFrom = (s: unknown) => [...new Set(String(s || "").toLowerCase().split(/[\s,]+/).map(g => g.replace(/^#/, "")).filter(g => GROUP.test(g)))].slice(0, 8);
type App = { id: number; slug: string; client_id: string; client_secret: string; pem: string; html_url?: string; owner?: { login: string } };
const DAY = 86_400_000;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function github(ctx: GhCtx) {
  const { q } = ctx, F = ctx.fetch || fetch;
  q(`CREATE TABLE IF NOT EXISTS gh_accounts (gh_id INTEGER PRIMARY KEY, login TEXT, profile_id TEXT, handle TEXT, key_sealed TEXT, token_sealed TEXT,
      installation TEXT, edits TEXT, cache TEXT, created TEXT, refreshed TEXT, claimed TEXT, claim_code TEXT, claim_expires INTEGER)`).run();
  q("CREATE TABLE IF NOT EXISTS gh_sessions (token TEXT PRIMARY KEY, gh_id INTEGER, expires INTEGER)").run();
  const appFile = path.join(ctx.dataDir, "github-app.json");
  const app = (): App | null => { try { return JSON.parse(fs.readFileSync(appFile, "utf8")); } catch { return null; } };
  const pub = ctx.publicUrl.replace(/\/$/, "") || "https://caldera.social";
  const secure = pub.startsWith("https:");
  const hashTok = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

  // ------------------------------------------------------------------ cookies + sessions
  const cookies = (req: http.IncomingMessage) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  const setCookie = (res: http.ServerResponse, name: string, val: string, maxAge: number) => {
    const prev = res.getHeader("set-cookie"); const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
    res.setHeader("set-cookie", [...list, `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`]);
  };
  const account = (req: http.IncomingMessage) => {
    const t = cookies(req).cal_s; if (!t) return null;
    const s = q("SELECT gh_id FROM gh_sessions WHERE token=? AND expires > ?").get(hashTok(t), Date.now()) as any;
    return s ? q("SELECT * FROM gh_accounts WHERE gh_id=?").get(s.gh_id) as any : null;
  };
  const startSession = (res: http.ServerResponse, ghId: number) => {
    const t = crypto.randomBytes(24).toString("hex");
    q("INSERT INTO gh_sessions VALUES (?,?,?)").run(hashTok(t), ghId, Date.now() + 30 * DAY);
    setCookie(res, "cal_s", t, 30 * 86400);
  };
  const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); };
  const page = (res: http.ServerResponse, status: number, title: string, body: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline' 'self'; form-action 'self' https://github.com; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Caldera</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
.me{max-width:760px;margin:0 auto;padding:28px 16px 64px}.me h1{font-family:'Source Serif 4',Georgia,serif;font-size:2rem;margin:.2em 0}.me .card{background:var(--bg-raised,#16131F);border:1px solid var(--line,#2A2440);border-radius:12px;padding:16px 18px;margin:14px 0}
.me label{display:block;font-weight:500;margin:10px 0 4px}.me input[type=text],.me textarea{width:100%;box-sizing:border-box;background:var(--bg,#0E0B16);color:inherit;border:1px solid var(--line,#2A2440);border-radius:8px;padding:8px 10px;font:inherit}
.me textarea{min-height:84px}.me .mut{color:var(--text-muted,#9A9AA6);font-size:.92em}.me code,.me pre{font-family:'IBM Plex Mono',monospace;font-size:12px}.me pre{white-space:pre-wrap;word-break:break-all;background:var(--bg,#0E0B16);border:1px solid var(--line,#2A2440);border-radius:8px;padding:10px;max-height:220px;overflow:auto}
.me .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.me .who{display:flex;gap:14px;align-items:center}.me .who img{width:64px;height:64px;border-radius:50%}.me .danger{color:#F0716A}
.me button.btn{cursor:pointer}</style></head><body><header class="nav"><a class="brand" href="/">Caldera</a><nav><a href="/people">People</a><a href="/gardens">Gardens</a><a href="/guide">Guide</a></nav></header><main class="me">${body}</main>
<script>document.querySelectorAll('[data-copy-text]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy-text')).textContent;navigator.clipboard.writeText(t).then(function(){b.textContent='Copied'},function(){})})})</script></body></html>`);
  };

  // ------------------------------------------------------------------ GitHub API
  const gh = async (token: string, p: string, init: RequestInit = {}) => {
    const r = await F(p.startsWith("http") ? p : "https://api.github.com" + p, { ...init, headers: { accept: "application/vnd.github+json", authorization: "Bearer " + token, "user-agent": "caldera-hub", ...(init.headers || {}) } });
    if (r.status === 202) return { pending: true };
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${p}`);
    return r.status === 204 ? null : r.json();
  };
  async function exchange(params: Record<string, string>) {
    const a = app()!; const r = await F("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "caldera-hub" },
      body: JSON.stringify({ client_id: a.client_id, client_secret: a.client_secret, ...params }) });
    const j = await r.json() as any; if (!j.access_token) throw new Error(j.error_description || j.error || "GitHub sign-in failed");
    return { access: j.access_token as string, refresh: j.refresh_token as string | undefined, expires: j.expires_in ? Date.now() + j.expires_in * 1000 : 0 };
  }
  async function tokenFor(acct: any): Promise<string> {
    const t = JSON.parse(ctx.unseal(acct.token_sealed));
    if (!t.expires || t.expires > Date.now() + 120_000) return t.access;
    if (!t.refresh) throw new Error("GitHub sign-in expired");
    const n = await exchange({ grant_type: "refresh_token", refresh_token: t.refresh });
    q("UPDATE gh_accounts SET token_sealed=? WHERE gh_id=?").run(ctx.seal(JSON.stringify(n)), acct.gh_id);
    return n.access;
  }
  // app-level JWT (for listing an installation's repos)
  const appJwt = () => { const a = app()!, now = Math.floor(Date.now() / 1000), b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "RS256", typ: "JWT" }), body = b64({ iat: now - 60, exp: now + 540, iss: a.id });
    return `${head}.${body}.${crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(a.pem, "base64url")}`; };
  async function installationRepos(inst: string): Promise<any[]> {
    const t = await F(`https://api.github.com/app/installations/${inst}/access_tokens`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: "Bearer " + appJwt(), "user-agent": "caldera-hub" } });
    const tok = (await t.json() as any).token; if (!tok) return [];
    const out: any[] = []; for (let pg = 1; pg <= 3; pg++) { const r = await gh(tok, `/installation/repositories?per_page=100&page=${pg}`) as any; out.push(...(r.repositories || [])); if ((r.repositories || []).length < 100) break; }
    return out.map(r => ({ ...r, _token: tok }));
  }

  // ------------------------------------------------------------------ building the hosted profile
  const handleFor = (login: string) => {
    let h = login.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "gh";
    if (h.length < 2) h += "-gh";
    const free = (x: string) => !ctx.reserved.has(x) && !ctx.byHandle(x) && !q("SELECT 1 FROM gh_accounts WHERE handle=?").get(x);
    if (free(h)) return h;
    for (let i = 2; i < 100; i++) if (free(`${h}-${i}`)) return `${h}-${i}`;
    return h + "-" + crypto.randomBytes(2).toString("hex");
  };

  async function build(acct: any): Promise<string> {
    const token = await tokenFor(acct), me = await gh(token, "/user") as any, edits = JSON.parse(acct.edits || "{}"), cache = JSON.parse(acct.cache || "{}");
    const own: any[] = [];
    for (let pg = 1; pg <= 3; pg++) { const r = await gh(token, `/users/${encodeURIComponent(me.login)}/repos?type=owner&sort=pushed&per_page=100&page=${pg}`) as any[]; own.push(...r); if (r.length < 100) break; }
    let priv: any[] = [];
    if (acct.installation) try { priv = (await installationRepos(acct.installation)).filter(r => r.private); } catch { /* uninstalled: public repos only */ }
    const repos = [...own.filter(r => !r.fork && !r.private), ...priv].slice(0, 120);
    const stats: Record<string, { weeks: number[]; commits: number; week: number }> = cache.stats || {};
    for (const r of repos.slice(0, 40)) {   // commit activity for the 40 most recently pushed (GitHub computes it lazily: keep the last good numbers)
      try {
        const w = await gh(r._token || token, `/repos/${r.full_name}/stats/commit_activity`) as any;
        if (Array.isArray(w) && w.length) { const t52 = w.slice(-52).map((x: any) => x.total); stats[r.full_name] = { weeks: t52.slice(-12), commits: t52.reduce((a: number, b: number) => a + b, 0), week: w[w.length - 1].total }; }
      } catch { /* keep cached */ }
    }
    const cityRepos: CityRepo[] = repos.map(r => { const s = stats[r.full_name] || { weeks: [], commits: 0, week: 0 };
      return { name: r.name, project: r.language || "Other", public: !r.private, language: r.language || "Other", commits: s.commits || (r.size ? 1 : 0), weeks: s.weeks, week: s.week, today: 0,
        pushed: r.pushed_at, created: r.created_at, size: r.size, url: r.private ? undefined : r.html_url, description: r.private ? undefined : (r.description || "").slice(0, 200) }; });
    // daily activity from public events (pushes, PRs, issues, reviews), last 30 days
    const days: Record<string, number> = {};
    try { for (let pg = 1; pg <= 3; pg++) { const ev = await gh(token, `/users/${encodeURIComponent(me.login)}/events?per_page=100&page=${pg}`) as any[];
      for (const e of ev) { const d = String(e.created_at).slice(0, 10); days[d] = (days[d] || 0) + (e.type === "PushEvent" ? Math.max(1, Number(e.payload?.size) || 1) : 1); } if (ev.length < 100) break; } } catch { /* no events */ }
    const daily: DailyEntry[] = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); daily.push({ date: d, counts: { meetings: 0, emails: 0, prompts: 0, commits: days[d] || 0, notes: 0, docs: 0 } as any }); }
    const city = cityData(cityRepos, () => ({ n: 0, paths: [] }), new Date().toISOString());
    const pubCity = publicCity(city, city.districts.map(d => d.name));
    const total = cityRepos.reduce((a, r) => a + r.commits, 0), langs = [...new Set(cityRepos.map(r => r.language).filter(l => l !== "Other"))].slice(0, 6);
    const weekly = Array.from({ length: 12 }, (_, i) => cityRepos.reduce((a, r) => a + (r.weeks[i] || 0), 0));
    const handle = acct.handle as string, name = String(edits.name || me.name || me.login).slice(0, 80);
    const links: [string, string][] = [["GitHub", me.html_url]];
    if (me.blog) links.push(["Website", /^https?:\/\//.test(me.blog) ? me.blog : "https://" + me.blog]);
    if (me.twitter_username) links.push(["X", "https://x.com/" + me.twitter_username]);
    for (const l of String(edits.links || "").split("\n")) { const [a, b] = l.split("|").map(x => x.trim()); if (a && /^https:\/\//.test(b || "")) links.push([a.slice(0, 40), b.slice(0, 300)]); }
    const files: Record<string, Buffer | string> = {};
    let avatar: string | undefined;
    try { const r = await F(me.avatar_url + (me.avatar_url.includes("?") ? "&" : "?") + "s=240"); if (r.ok) { files["img/avatar.png"] = Buffer.from(await r.arrayBuffer()); avatar = "img/avatar.png"; } } catch { /* initials */ }
    const p: ProfileData = {
      name, handle, headline: String(edits.headline || me.bio || `${me.login} on GitHub`).slice(0, 160), theme: "dark", avatar, icon: avatar, links,
      properties: [["Location", me.location || ""], ["Company", me.company || ""], ["On GitHub since", String(me.created_at || "").slice(0, 4)]].filter(x => x[1]) as [string, string][],
      sections: { journal: false, scoreboard: true, properties: true, numbers: false, topics: false, notes: false, asks: false, social: true, links: true, sidebar: true, rail: false, city: true },
      stats: { notes: 0, words: 0, links: 0, activeDays: daily.filter(d => (d.counts as any).commits).length }, topics: [], daily, publicNotes: [], asks: [], offers: [],
      updated: new Date().toISOString(), hub: pub, summary: edits.summary ? String(edits.summary).slice(0, 1200) : undefined,
      code: { commits: total, repos: cityRepos.length, languages: langs, weekly, url: me.html_url },
      projects: cityRepos.filter(r => r.public).sort((a, b) => b.commits - a.commits).slice(0, 6).map(r => ({ name: r.name, status: r.description || r.language, url: r.url || me.html_url, commits: r.commits })),
      city: pubCity, source: "GitHub",
    } as ProfileData;
    for (const [k, v] of Object.entries(renderProfile(p))) files[k] = v;
    const id = JSON.parse(ctx.unseal(acct.key_sealed)) as C.Identity;
    const manifest = C.sign(id, "profile.manifest", { name, handle, boxKey: id.boxPublic, headline: p.headline, photos: { avatar }, links, sections: Object.keys(p.sections).filter(k => p.sections[k]),
      stats: p.stats, daily: daily.map(d => ({ date: d.date, score: C.activityScore(d.counts), headline: "", counts: d.counts })), topics: [], asks: [], offers: [], listed: edits.listed !== false, page: "index.html", updated: p.updated, hosted: "github", groups: groupsFrom((edits.groups || []).join(",")), languages: langs });
    const r = ctx.accept(manifest); if (r.status !== 200) throw new Error(r.body?.error || "couldn't publish");
    const dir = path.join(ctx.dataDir, "profiles", handle);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "img"), { recursive: true }); fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (const [k, v] of Object.entries(files)) { const f = path.join(dir, path.normalize(k)); if (!f.startsWith(dir)) continue; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
    fs.writeFileSync(path.join(dir, "caldera.json"), JSON.stringify(manifest));
    // live traffic + agents: one site key per district, the agent key with a hashed repo -> district map
    const have = new Map((q("SELECT key, project FROM traffic_sites WHERE owner=?").all(id.id) as any[]).map(x => [x.project, x.key]));
    for (const d of city.districts) if (!have.has(d.name)) q("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run(crypto.randomBytes(8).toString("hex"), id.id, d.name, 1, crypto.randomBytes(18).toString("hex"), new Date().toISOString());
    const rmap = Object.fromEntries(cityRepos.map(r => [crypto.createHash("sha256").update(r.name.toLowerCase()).digest("hex").slice(0, 16), r.project]));
    if (q("SELECT 1 FROM agent_keys WHERE owner=?").get(id.id)) q("UPDATE agent_keys SET repos=? WHERE owner=?").run(JSON.stringify(rmap), id.id);
    else q("INSERT INTO agent_keys VALUES (?,?,?,?,?)").run(crypto.randomBytes(9).toString("hex"), id.id, crypto.randomBytes(18).toString("hex"), JSON.stringify(rmap), new Date().toISOString());
    q("UPDATE gh_accounts SET cache=?, refreshed=?, login=? WHERE gh_id=?").run(JSON.stringify({ stats }), new Date().toISOString(), me.login, acct.gh_id);
    return `${pub}/@${handle}/`;
  }

  // refresh every hosted (unclaimed) profile every 6 hours, spread out
  const timer = setInterval(async () => {
    if (!app()) return;
    const due = q("SELECT * FROM gh_accounts WHERE claimed IS NULL AND (refreshed IS NULL OR refreshed < ?) LIMIT 5").all(new Date(Date.now() - 6 * 3600_000).toISOString()) as any[];
    for (const a of due) { try { await build(a); } catch (e: any) { q("UPDATE gh_accounts SET refreshed=? WHERE gh_id=?").run(new Date().toISOString(), a.gh_id); console.error("github refresh", a.login, e.message); } }
  }, 10 * 60_000); timer.unref?.();

  // ------------------------------------------------------------------ the /me page
  function mePage(res: http.ServerResponse, a: any, note = "") {
    const pr = q("SELECT * FROM profiles WHERE id=?").get(a.profile_id) as any, edits = JSON.parse(a.edits || "{}");
    const url = `${pub}/@${a.handle}/`, ak = q("SELECT key, secret FROM agent_keys WHERE owner=?").get(a.profile_id) as any;
    const sites = q("SELECT key, project FROM traffic_sites WHERE owner=? ORDER BY project").all(a.profile_id) as any[];
    const ap = app();
    const agentPrompt = ak ? `Set up the Caldera agent hook on this computer, so my Caldera city shows what my AI agents are working on.

1. Download ${pub}/agent-hook.mjs to ~/.caldera/agent-hook.mjs (create the folder). Read it first: it reads the hook event from stdin, works out the repo (git remote name) and a short task title, and posts only that to my Caldera hub, with a 1.5 second timeout.
2. Write ~/.caldera/agent.json (chmod 600): {"hub": "${pub}", "key": "${ak.key}", "secret": "${ak.secret}", "machine": "<a short name for this computer>"}
3. In ~/.claude/settings.json, add hooks (keep existing ones) that run \`node ~/.caldera/agent-hook.mjs\` for UserPromptSubmit, PostToolUse, Stop, Notification and SessionEnd.
4. Test: echo '{"hook_event_name":"UserPromptSubmit","session_id":"caldera-test-1","cwd":"'$PWD'","prompt":"Testing the Caldera agent hook"}' | node ~/.caldera/agent-hook.mjs, then send SessionEnd for the same session.` : "";
    const claim = a.claim_code && a.claim_expires > Date.now() ? a.claim_code : "";
    const growth = growthCards(a, edits);
    page(res, 200, "Your Caldera", `${note ? `<div class="card">${note}</div>` : ""}
<div class="who"><img src="${esc(url)}img/avatar.png" alt=""><div><h1>${esc(pr?.name || a.login)}</h1><div class="mut">@${esc(a.handle)} &middot; signed in with GitHub as ${esc(a.login)}</div></div></div>
<div class="card"><b>Your page:</b> <a href="${esc(url)}">${esc(url)}</a><br><span class="mut">Built from your GitHub and refreshed every 6 hours${a.refreshed ? `; last ${esc(new Date(a.refreshed).toUTCString().slice(5, 22))} UTC` : ""}. Your repos are a city at <a href="${esc(url)}city.html">city.html</a>.</span>
<form method="post" class="row" style="margin-top:10px"><input type="hidden" name="do" value="refresh"><button class="btn small" type="submit">Refresh from GitHub now</button></form></div>
${growth}
<form method="post" class="card"><input type="hidden" name="do" value="save"><b>Edit your page</b>
<label for="n">Name</label><input type="text" id="n" name="name" maxlength="80" value="${esc(edits.name || pr?.name || "")}">
<label for="h">Headline</label><input type="text" id="h" name="headline" maxlength="160" value="${esc(edits.headline || pr?.headline || "")}">
<label for="s">About you</label><textarea id="s" name="summary" maxlength="1200">${esc(edits.summary || "")}</textarea>
<label for="l">Extra links <span class="mut">(one per line: Label | https://...)</span></label><textarea id="l" name="links">${esc(edits.links || "")}</textarea>
<label for="g">Groups <span class="mut">(comma separated, like <code>producthunt</code>; each one is a town at caldera.social/g/name)</span></label><input type="text" id="g" name="groups" maxlength="200" value="${esc((edits.groups || []).join(", "))}">
<label><input type="checkbox" name="listed" ${edits.listed === false ? "" : "checked"}> Show me in the <a href="/people">People</a> directory</label>
<div class="row" style="margin-top:12px"><button class="btn small" type="submit">Save and republish</button></div></form>
<div class="card"><b>Private repos</b><p class="mut">Your city shows public repos. To add private ones as padlocked buildings (size and activity only, never names or code), install the Caldera GitHub app on the repos you choose. It can only read repository metadata.</p>
${ap ? `<a class="btn small" href="https://github.com/apps/${esc(ap.slug)}/installations/new">${a.installation ? "Change which repos" : "Add private repos"}</a>` : ""}</div>
<div class="card"><b>Live traffic on your city</b><p class="mut">Paste a district's snippet into a site's pages and every visit rides through your city live. Call <code>caldera('signup')</code> or <code>caldera('buy')</code> to mark conversions.</p>
${sites.map(s => `<div style="margin:8px 0"><span>${esc(s.project)}</span><pre id="sn-${esc(s.key)}">&lt;script async src="${esc(pub)}/t.js" data-site="${esc(s.key)}"&gt;&lt;/script&gt;</pre></div>`).join("") || '<p class="mut">Refresh once to get your snippets.</p>'}</div>
${ak ? `<div class="card"><b>Your AI agents in the city</b><p class="mut">Paste this into Claude Code on each computer you use. Each agent becomes a drone over the repo it's working in.</p><pre id="agent-prompt">${esc(agentPrompt)}</pre><button class="btn small" type="button" data-copy-text="agent-prompt">Copy setup prompt</button></div>` : ""}
<div class="card"><b>Use Obsidian? Move this profile into your vault</b><p class="mut">Your vault adds the rest: a journal, your notes as a garden, the Underground under your city, and end-to-end encrypted sharing with friends. Install Caldera in Obsidian, then in its settings choose <i>Import a GitHub sign-up</i> and paste the code below. Your vault takes over the profile's key and the hub deletes its copy.</p>
${claim ? `<pre id="claim">${esc(claim)}</pre><span class="mut">Valid for 30 minutes.</span>` : `<form method="post"><input type="hidden" name="do" value="claim"><button class="btn small" type="submit">Get a code</button></form>`}</div>
<div class="row"><form method="post"><input type="hidden" name="do" value="logout"><button class="btn small ghost" type="submit">Sign out</button></form>
<form method="post" onsubmit="return this.querySelector('[name=sure]').checked"><input type="hidden" name="do" value="delete"><label class="mut"><input type="checkbox" name="sure"> I'm sure</label> <button class="btn small ghost danger" type="submit">Delete my Caldera profile</button></form></div>`);
  }

  /** Growth cards on /me: this week's visitors, share + invite, friends (requests, current, suggestions), daily email. */
  function growthCards(a: any, edits: any): string {
    const soc = ctx.social, me = a.profile_id as string, url = `${pub}/@${a.handle}/`, invite = `${pub}/?invite=${encodeURIComponent(a.handle)}`;
    const wk = new Date(Date.now() - 7 * DAY).toISOString();
    const v = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(a.handle, wk) as any;
    const brought = soc?.invitedCount(me) || 0, rq = soc ? soc.openRequests(me) : { incoming: [], outgoing: [] };
    const friends = q("SELECT p.id, p.handle, p.name FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=? ORDER BY f.ts DESC").all(me) as any[];
    const sug = soc ? soc.suggest(me, 3) : [];
    const who = (h: string, n: string) => `<a href="${esc(pub)}/@${esc(h)}/">${esc(n || "@" + h)}</a> <span class="mut">@${esc(h)}</span>`;
    const btn = (doit: string, label: string, hidden: Record<string, string>) => `<form method="post" style="display:inline"><input type="hidden" name="do" value="${doit}">${Object.entries(hidden).map(([k, x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("")}<button class="btn small" type="submit">${label}</button></form>`;
    const text = encodeURIComponent(`My page on Caldera: a living profile, with my code as a city. ${url}`);
    const em = soc?.email?.status(me);
    return `<div class="card"><b>This week</b><p style="margin:.4em 0 0">${v.u ? `<b>${v.u}</b> ${v.u === 1 ? "person" : "people"} visited your page (${v.n} views).` : "No visitors yet this week. Share your page to get the first ones."}${brought ? ` You've brought in <b>${brought}</b> ${brought === 1 ? "person" : "people"}.` : ""}</p></div>
<div class="card"><b>Share your page</b><p class="mut">This is the picture people see when you post your link.</p><img src="${esc(url)}card.png" alt="Your link preview" style="width:100%;max-width:600px;border-radius:10px;border:1px solid var(--line,#2A2440);display:block;margin:6px 0 10px">
<div class="row"><a class="btn small" href="https://x.com/intent/post?text=${text}" target="_blank" rel="noopener">Post on X</a><a class="btn small" href="https://bsky.app/intent/compose?text=${text}" target="_blank" rel="noopener">Bluesky</a><a class="btn small" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener">LinkedIn</a></div>
<p style="margin:12px 0 4px"><b>Invite a friend</b> <span class="mut">(you get ${25} help credits when they join)</span></p><pre id="inv">${esc(invite)}</pre><button class="btn small" type="button" data-copy-text="inv">Copy invite link</button></div>
<div class="card"><b>Friends</b>
${rq.incoming.length ? `<p style="margin:.5em 0 .3em">Waiting for you:</p>${rq.incoming.map(r => `<div class="row" style="margin:6px 0">${who(r.handle, r.name)}${r.note ? ` <span class="mut">"${esc(r.note)}"</span>` : ""} ${btn("accept", "Accept", { req: r.request, to: r.id })}</div>`).join("")}` : ""}
${friends.length ? `<p style="margin:.6em 0 .3em">Your friends:</p><div class="row">${friends.map(f => who(f.handle, f.name)).join(" &middot; ")}</div>` : `<p class="mut">No friends yet.</p>`}
${rq.outgoing.length ? `<p class="mut" style="margin:.6em 0 0">Sent, waiting: ${rq.outgoing.map(r => "@" + esc(r.handle)).join(", ")}</p>` : ""}
${sug.length ? `<p style="margin:.8em 0 .3em">People you might know:</p>${sug.map(s => `<div class="row" style="margin:6px 0">${who(s.handle, s.name)} <span class="mut">${esc(s.why)}</span> ${btn("add", "Add friend", { to: s.id })}</div>`).join("")}` : ""}</div>
${soc?.email ? `<div class="card"><b>Daily summary email</b><p class="mut">One short email on days something happens: who visited, friend requests, links into your garden. Never shown on your page. Unsubscribe in one click.</p>
${em?.confirmed ? `<p>Sending to <b>${esc(em.email)}</b>.</p>${btn("email-off", "Turn off", {})}` : `${em ? `<p class="mut">Check ${esc(em.email)} for a confirmation link.</p>` : ""}<form method="post" class="row"><input type="hidden" name="do" value="email"><input type="text" name="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(em?.email || edits.ghEmail || "")}" style="flex:1 1 220px"><button class="btn small" type="submit">Email me a daily summary</button></form>`}</div>` : ""}`;
  }

  // ------------------------------------------------------------------ routes
  /** Public hub routes. Returns true when handled. */
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (req.method === "GET" && p === "/auth/github") {
      const a = app(); if (!a) { page(res, 503, "Coming soon", `<h1>Sign up with GitHub is almost ready</h1><p>Install the <a href="/#install">Obsidian plugin</a> in the meantime.</p>`); return true; }
      const inv = (url.searchParams.get("invite") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31), grp = groupsFrom(url.searchParams.get("group"))[0];
      const signed = account(req);
      if (signed) {
        if (grp && !signed.claimed) {   // already here: join the group and republish
          const ed = JSON.parse(signed.edits || "{}"); ed.groups = [...new Set([...(ed.groups || []), grp])];
          q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify(ed), signed.gh_id);
          try { await build(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(signed.gh_id)); } catch { /* next refresh */ }
          redirect(res, `/me?joined=${grp}`); return true;
        }
        redirect(res, "/me"); return true;
      }
      if (inv) setCookie(res, "cal_inv", inv, 30 * 86400);
      if (grp) setCookie(res, "cal_grp", grp, 30 * 86400);
      const state = crypto.randomBytes(16).toString("hex"); setCookie(res, "cal_oauth", state, 600);
      redirect(res, `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(a.client_id)}&redirect_uri=${encodeURIComponent(pub + "/auth/github/callback")}&state=${state}`); return true;
    }
    if (req.method === "GET" && p === "/auth/github/callback") {
      const a = app(); if (!a) { redirect(res, "/"); return true; }
      if (!url.searchParams.get("state") || url.searchParams.get("state") !== cookies(req).cal_oauth) { page(res, 400, "Try again", `<h1>That sign-in link expired</h1><p><a class="btn" href="/auth/github">Sign in with GitHub</a></p>`); return true; }
      setCookie(res, "cal_oauth", "", 0);
      try {
        const tok = await exchange({ code: url.searchParams.get("code") || "", redirect_uri: pub + "/auth/github/callback" });
        const me = await gh(tok.access, "/user") as any;
        let acct = q("SELECT * FROM gh_accounts WHERE gh_id=?").get(me.id) as any;
        if (acct) {
          q("UPDATE gh_accounts SET token_sealed=?, login=? WHERE gh_id=?").run(ctx.seal(JSON.stringify(tok)), me.login, me.id);
          startSession(res, me.id); redirect(res, "/me"); return true;
        }
        // new account: a little history keeps bots out
        if (Date.now() - Date.parse(me.created_at) < 30 * DAY || (Number(me.public_repos) || 0) + (Number(me.followers) || 0) < 1) {
          page(res, 403, "Not yet", `<h1>We can't create a profile for this GitHub account yet</h1><p>To keep bots out, GitHub sign-up needs an account that's at least 30 days old with at least one public repo or follower. You can still <a href="/#install">use Caldera with Obsidian</a>.</p>`); return true;
        }
        if (!ctx.allowNewProfile(req)) { page(res, 429, "Slow down", "<h1>Too many new profiles from this network today</h1><p>Try again tomorrow.</p>"); return true; }
        const id = C.newIdentity(), handle = handleFor(me.login), ck = cookies(req), grp0 = groupsFrom(ck.cal_grp);
        const edits0: any = grp0.length ? { groups: grp0 } : {};
        if (typeof me.email === "string" && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(me.email)) edits0.ghEmail = me.email.slice(0, 200);   // public GitHub email: only a suggestion for the summary-email field
        q(`INSERT INTO gh_accounts (gh_id, login, profile_id, handle, key_sealed, token_sealed, edits, cache, created) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(me.id, me.login, id.id, handle, ctx.seal(JSON.stringify(id)), ctx.seal(JSON.stringify(tok)), JSON.stringify(edits0), "{}", new Date().toISOString());
        acct = q("SELECT * FROM gh_accounts WHERE gh_id=?").get(me.id);
        startSession(res, me.id);
        if (ck.cal_inv) setCookie(res, "cal_inv", "", 0);
        if (ck.cal_grp) setCookie(res, "cal_grp", "", 0);
        try { await build(acct); } catch (e: any) { console.error("github first build", e.message); }
        // joined from a friend's invite: thank the inviter, and send them a friend request from the new member
        const inviter = ck.cal_inv ? ctx.social?.recordReferral(id.id, ck.cal_inv, "github") : null;
        if (inviter) try { ctx.accept(C.sign(id, "friend.request", { to: inviter, note: "I joined Caldera from your invite." })); } catch { /* best effort */ }
        redirect(res, "/me?welcome=1"); return true;
      } catch (e: any) { page(res, 502, "GitHub", `<h1>GitHub sign-in didn't work</h1><p class="mut">${esc(e.message)}</p><p><a class="btn" href="/auth/github">Try again</a></p>`); return true; }
    }
    if (req.method === "GET" && p === "/auth/github/installed") {   // after installing the app on private repos
      const acct = account(req); if (!acct) { redirect(res, "/auth/github"); return true; }
      const inst = url.searchParams.get("installation_id");
      if (inst && /^\d+$/.test(inst)) {
        try { const tok = await tokenFor(acct), r = await gh(tok, "/user/installations") as any;   // only an installation this user can see
          if ((r.installations || []).some((i: any) => String(i.id) === inst)) q("UPDATE gh_accounts SET installation=? WHERE gh_id=?").run(inst, acct.gh_id); } catch { /* ignore */ }
        try { await build(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id)); } catch { /* next refresh */ }
      }
      redirect(res, "/me"); return true;
    }
    if (p === "/me") {
      const acct = account(req);
      if (!acct) { redirect(res, "/auth/github"); return true; }
      if (acct.claimed) { page(res, 200, "Moved to Obsidian", `<h1>This profile now lives in your vault</h1><p>Edit it from Caldera in Obsidian. <a href="${esc(pub)}/@${esc(acct.handle)}/">Your page</a></p>`); return true; }
      if (req.method === "GET") { const j = groupsFrom(url.searchParams.get("joined"))[0];
        mePage(res, acct, url.searchParams.get("welcome") ? `<b>Welcome to Caldera.</b> Your page is live. Share it below, add a few friends, or move it into Obsidian later.` : j ? `You joined <a href="/g/${esc(j)}">${esc(j)}</a>.` : ""); return true; }
      if (req.method === "POST") {
        const origin = String(req.headers.origin || ""); if (origin && origin !== pub) { page(res, 403, "No", "<h1>Wrong origin</h1>"); return true; }
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const f = new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 20_000));
        const act = f.get("do");
        if (act === "logout") { const t = cookies(req).cal_s; if (t) q("DELETE FROM gh_sessions WHERE token=?").run(hashTok(t)); setCookie(res, "cal_s", "", 0); redirect(res, "/"); return true; }
        if (act === "delete" && f.get("sure")) {
          const a = app(); try { if (a) { const t = JSON.parse(ctx.unseal(acct.token_sealed)).access; await F(`https://api.github.com/applications/${a.client_id}/grant`, { method: "DELETE", headers: { authorization: "Basic " + Buffer.from(a.client_id + ":" + a.client_secret).toString("base64"), accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "caldera-hub" }, body: JSON.stringify({ access_token: t }) }); } } catch { /* revoke is best effort */ }
          ctx.erase(acct.profile_id); q("DELETE FROM gh_sessions WHERE gh_id=?").run(acct.gh_id); q("DELETE FROM gh_accounts WHERE gh_id=?").run(acct.gh_id);
          setCookie(res, "cal_s", "", 0); page(res, 200, "Deleted", "<h1>Your Caldera profile is deleted</h1><p>Your page, city and data are gone, and Caldera's access to your GitHub account is revoked.</p>"); return true;
        }
        if (act === "save") {
          const prev = JSON.parse(acct.edits || "{}");
          const edits = { ...prev, name: (f.get("name") || "").slice(0, 80), headline: (f.get("headline") || "").slice(0, 160), summary: (f.get("summary") || "").slice(0, 1200), links: (f.get("links") || "").slice(0, 2000), listed: f.get("listed") === "on", groups: groupsFrom(f.get("groups")) };
          q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify(edits), acct.gh_id);
        }
        if (act === "claim") { const code = "CAL-" + crypto.randomBytes(9).toString("base64url"); q("UPDATE gh_accounts SET claim_code=?, claim_expires=? WHERE gh_id=?").run(code, Date.now() + 30 * 60_000, acct.gh_id); }
        let pre = "";
        if (act === "accept" || act === "add") {   // friends, signed with the hosted profile's key
          const id = JSON.parse(ctx.unseal(acct.key_sealed)) as C.Identity, to = String(f.get("to") || "");
          const r = act === "accept" ? ctx.accept(C.sign(id, "friend.accept", { request: String(f.get("req") || ""), to }))
            : /^cal:[1-9A-HJ-NP-Za-km-z]+$/.test(to) && q("SELECT 1 FROM profiles WHERE id=?").get(to) ? ctx.accept(C.sign(id, "friend.request", { to, note: "" })) : { status: 404, body: { error: "unknown profile" } };
          const h = (q("SELECT handle FROM profiles WHERE id=?").get(to) as any)?.handle;
          pre = r.status === 200 ? (act === "accept" ? `You and @${esc(h)} are now friends.` : `Friend request sent to @${esc(h)}.`) : `Couldn't do that: ${esc(r.body?.error || "error")}`;
        }
        if (act === "email" && ctx.social?.email) { const em = (f.get("email") || "").trim().slice(0, 200); try { pre = esc(await ctx.social.email.subscribe(acct.profile_id, em)); } catch (e: any) { pre = esc(e.message); } }
        if (act === "email-off" && ctx.social?.email) { ctx.social.email.unsubscribe(acct.profile_id); pre = "Daily summary emails are off."; }
        let note = pre || (act === "claim" ? "Here's your code. Paste it into Caldera in Obsidian (Settings &gt; Import a GitHub sign-up)." : "");
        if (act === "save" || act === "refresh") { try { await build(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id)); note = "Republished."; } catch (e: any) { note = "Couldn't republish: " + esc(e.message); } }
        mePage(res, q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id), note); return true;
      }
    }
    // Obsidian claims a hosted profile: one-time code -> the profile's key, once; the hub deletes its copy
    if (req.method === "POST" && p === "/v1/github/claim") {
      const { code } = await ctx.readBody(req) as { code?: string };
      const acct = typeof code === "string" && code.startsWith("CAL-") ? q("SELECT * FROM gh_accounts WHERE claim_code=? AND claim_expires > ? AND claimed IS NULL").get(code.trim(), Date.now()) as any : null;
      if (!acct) { ctx.json(res, 404, { error: "unknown or expired code" }); return true; }
      const identity = JSON.parse(ctx.unseal(acct.key_sealed)), edits = JSON.parse(acct.edits || "{}");
      q("UPDATE gh_accounts SET claimed=?, key_sealed='', claim_code=NULL, token_sealed='' WHERE gh_id=?").run(new Date().toISOString(), acct.gh_id);
      ctx.json(res, 200, { identity, handle: acct.handle, name: edits.name || "", headline: edits.headline || "", github: acct.login }); return true;
    }
    return false;
  }

  /** Operator-only routes on the private (Tailscale) address: create the GitHub App with GitHub's manifest flow. */
  async function privateRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/setup/github" && req.method === "GET") {
      const a = app();
      if (a) { page(res, 200, "GitHub app", `<h1>GitHub sign-up is set up</h1><p>App: <a href="${esc(a.html_url || "")}">${esc(a.slug)}</a>. <a class="btn" href="${esc(pub)}/auth/github">Try signing in</a></p>`); return true; }
      const base = (ctx.privateUrl || "").replace(/\/$/, ""), state = crypto.randomBytes(12).toString("hex");
      fs.writeFileSync(path.join(ctx.dataDir, "github-app.state"), state, { mode: 0o600 });
      const manifest = { name: "Caldera Social", url: pub, description: "Sign up for Caldera with GitHub: your repos become a little city on your Caldera profile.",
        redirect_url: base + "/setup/github/done", callback_urls: [pub + "/auth/github/callback"], setup_url: pub + "/auth/github/installed", setup_on_update: true,
        public: true, default_permissions: { metadata: "read" }, default_events: [], request_oauth_on_install: false, hook_attributes: { url: pub + "/v1/github/hook", active: false } };
      page(res, 200, "Create the GitHub app", `<h1>Create Caldera's GitHub app</h1><p>One click on GitHub creates the app that powers "Sign up with GitHub". It asks for nothing beyond reading public profiles and, if a user chooses, their repos' metadata. GitHub sends the app's keys straight to this hub; you never see or copy them.</p>
<form action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button class="btn" type="submit">Create the app on GitHub</button></form>
<p class="mut">If GitHub says the name is taken, change it on the next screen (e.g. "Caldera Social Hub").</p>`); return true;
    }
    if (url.pathname === "/setup/github/done" && req.method === "GET") {
      let want = ""; try { want = fs.readFileSync(path.join(ctx.dataDir, "github-app.state"), "utf8"); } catch { /* none */ }
      const code = url.searchParams.get("code") || "";
      if (!want || url.searchParams.get("state") !== want || !/^[\w-]+$/.test(code)) { page(res, 400, "GitHub app", "<h1>That setup link doesn't match. Start again from /setup/github.</h1>"); return true; }
      const r = await F(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "caldera-hub" } });
      const j = await r.json() as any;
      if (!j.client_id || !j.pem) { page(res, 502, "GitHub app", `<h1>GitHub didn't return the app's keys</h1><p class="mut">${esc(j.message || r.status)}</p>`); return true; }
      fs.writeFileSync(appFile, JSON.stringify({ id: j.id, slug: j.slug, client_id: j.client_id, client_secret: j.client_secret, pem: j.pem, webhook_secret: j.webhook_secret, html_url: j.html_url, owner: { login: j.owner?.login } }), { mode: 0o600 });
      fs.rmSync(path.join(ctx.dataDir, "github-app.state"), { force: true });
      page(res, 200, "Done", `<h1>GitHub sign-up is live</h1><p>App <a href="${esc(j.html_url)}">${esc(j.slug)}</a> created. <a class="btn" href="${esc(pub)}/auth/github">Try it: sign in with GitHub</a></p>`); return true;
    }
    return false;
  }
  return { route, privateRoute, build, account, configured: () => !!app() };
}
