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
import { hookCheck, hookTasksNote, trackTag } from "./hookpin.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "@caldera/core";
import { renderProfile, type ProfileData, type DailyEntry } from "../../../../caldera/packages/plugin/src/render";
import { cityData, publicCity, cleanSites, type CityRepo } from "../../../../caldera/packages/plugin/src/city";
import { listingLine, parseListingLine, cleanLabel, MAX_LABEL, toListing, withListingsPublic, MAX_LISTINGS, type ListingKind, type ListingMeta, type ListingRef } from "../../../../caldera/packages/plugin/src/listings";
import { cleanImage } from "./images";
import { connectionsPanel, settingsNav, sectionHead, SETTINGS_CSS, type Conn } from "./settings";
import { alertItem, ALERT_CSS, ALERT_JS, type AlertRow } from "./alerts";

export interface GhPerson { login: string; avatar: string; url: string; relation: string; invited: boolean; canEmail: boolean }
export interface GhCtx {
  /** apps and websites members list (details looked up and cached by the hub) */
  listings?: () => { resolve: (refs: ListingRef[], mayFetch?: boolean) => Promise<ListingMeta[]>; refsOf: (lines: unknown, kind: ListingKind) => ListingRef[] } | null;
  /** how often a page view may check GitHub for new repos, per member (default 10 minutes; tests use 0) */
  freshenMs?: number;
  /** sign-up gate for new GitHub accounts (an open-core hook) */
  accountOk?: (me: { created_at?: string; public_repos?: number; followers?: number }) => boolean;
  /** sign-up funnel counting (click, back from GitHub, created / signed in, failures) */
  track?: (req: http.IncomingMessage, step: "click" | "back" | "created" | "signin" | "fail", detail?: string) => void;
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string;
  accept: (e: C.Envelope) => { status: number; body: any }; erase: (id: string) => void;
  dataDir: string; publicUrl: string; privateUrl?: string;
  /** the site header for pages shown without the owner bar */
  siteNav?: () => string;
  json: (res: http.ServerResponse, status: number, body: unknown) => void; readBody: (req: http.IncomingMessage) => Promise<any>;
  allowNewProfile: (req: http.IncomingMessage) => boolean; byHandle: (h: string) => any; reserved: Set<string>;
  /** growth helpers from the hub: suggestions, open requests, referrals */
  social?: { suggest: (id: string, n?: number) => any[]; openRequests: (id: string) => { incoming: any[]; outgoing: any[] }; invitedCount: (id: string) => number;
    recordReferral: (invitee: string, inviterHandle: unknown, via: string) => string | null; email?: EmailHooks; pageState?: (id: string) => C.PageState | null; unlockState?: (id: string) => C.UnlockState | null;
    connections?: (id: string) => Conn | null; friendAct?: (me: string, to: string) => { status: number; body: any };
    alerts?: { forOwner: (id: string) => AlertRow[]; markRead: (id: string, ids: string[]) => void };
    circle?: { people: (id: string) => Promise<GhPerson[]>; invite: (id: string, login: string) => Promise<string>; signedIn: (id: string) => void };
    /** what they're building: their tags and how many introductions wait for an answer */
    building?: (id: string) => { tags: { t: string; kind: string }[]; intros: number } };
  /** owner sign-in: start an owner session (returns the Set-Cookie value), read the signed-in owner, check a profile isn't taken down */
  owner?: { start: (profileId: string) => string; of: (req: http.IncomingMessage) => string | null; usable: (pr: any) => boolean; bar?: (profileId: string) => string };
  /** how private repos show on a member's public city (privatemode.ts) */
  /** search engines: may this member's page be indexed (listed members, after the notice period), and their choice */
  searchPref?: { on: (pr: any) => boolean; set: (owner: string, on: boolean) => void };
  privateMode?: { modeFor: (pr: any) => "show" | "anonymous" | "hidden" | "named"; chosen: (pr: any) => string | undefined; set: (owner: string, mode: unknown) => boolean; since: string };
  /** one person, one profile: fold a GitHub sign-up page into the profile its GitHub account was just linked to */
  merge?: (fromId: string, intoId: string, reason: string) => unknown;
  /** a live member who owns this (verified) address: a new GitHub sign-up with it signs in to that page instead */
  memberByEmail?: (email: string) => { id: string; handle: string } | null;
  /** test hook: replaces fetch for GitHub calls */
  fetch?: typeof fetch;
}
/** Daily summary email hooks for the /me page (implemented in the hub's email module). */
export interface EmailHooks { status: (owner: string) => { email: string; confirmed: boolean } | null; subscribe: (owner: string, email: string) => Promise<string>; unsubscribe: (owner: string) => void;
  suggest?: (owner: string, email: string, verified: boolean, source: string) => void; promptFor?: (owner: string) => { suggestion: { email: string; verified: boolean } | null } | null; dismissPrompt?: (owner: string) => void }
const GROUP = /^[a-z0-9][a-z0-9-]{1,29}$/;
/** Settings > Privacy: how private repos show on the public city (one form, both kinds of member). */
function searchForm(on: boolean): string {
  return `<form method="post" class="card" id="search-engines"><input type="hidden" name="do" value="search"><b>Search engines and AI assistants</b>
<p class="mut" style="margin:4px 0 10px">Let Google, Bing, ChatGPT, Claude and Perplexity find and cite your public page and city (only while you're listed in People). Your private view and anything not already public are never indexed.</p>
<label><input type="checkbox" name="on" ${on ? "checked" : ""}> Show my page in search engines and AI answers</label>
<div class="row" style="margin-top:12px"><button class="btn small" type="submit">Save</button></div></form>`;
}
function privateReposForm(mode: string, chosen: boolean): string {
  const opt = (v: string, t: string, d: string) => `<label class="pr-opt"><input type="radio" name="mode" value="${v}"${mode === v ? " checked" : ""}> <b>${t}</b><span class="mut">${d}</span></label>`;
  return `<form method="post" class="card" id="private-repos"><input type="hidden" name="do" value="private-repos"><b>Private repos on my city</b>
<p class="mut" style="margin:4px 0 10px">Your public city, the World and your share card. Your private view always shows everything.${chosen ? "" : " <b>You haven't chosen yet</b>, so Caldera's default applies."}</p>
<style>.pr-opt{display:block;margin:8px 0}.pr-opt span{display:block;margin-left:24px;font-size:13px}</style>
${opt("named", "Show with names", "Your city looks like your private view: repo names, language colours and activity in their real projects. Nobody can open the code, links or descriptions. (Made your page in Obsidian? Choose this in Caldera settings there too.)")}
${opt("show", "Show as padlocked", "Nameless locked buildings in place. Visitors can still tell roughly how big and how busy private work is, and which project it sits beside.")}
${opt("anonymous", "Anonymous", "One separate padlocked district with no sizes, activity or projects. Visitors only learn that you have private work.")}
${opt("hidden", "Hidden", "No trace of private repos anywhere public, including totals.")}
<button class="btn small" type="submit">Save</button></form>`;
}
const groupsFrom = (s: unknown) => [...new Set(String(s || "").toLowerCase().split(/[\s,]+/).map(g => g.replace(/^#/, "")).filter(g => GROUP.test(g)))].slice(0, 8);
type App = { id: number; slug: string; client_id: string; client_secret: string; pem: string; html_url?: string; owner?: { login: string } };
const DAY = 86_400_000;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function github(ctx: GhCtx) {
  const { q } = ctx, F = ctx.fetch || fetch;
  q(`CREATE TABLE IF NOT EXISTS gh_accounts (gh_id INTEGER PRIMARY KEY, login TEXT, profile_id TEXT, handle TEXT, key_sealed TEXT, token_sealed TEXT,
      installation TEXT, edits TEXT, cache TEXT, created TEXT, refreshed TEXT, claimed TEXT, claim_code TEXT, claim_expires INTEGER)`).run();
  q("CREATE TABLE IF NOT EXISTS gh_sessions (token TEXT PRIMARY KEY, gh_id INTEGER, expires INTEGER)").run();
  // GitHub sign-in for profiles that already exist (made in Obsidian): a GitHub login is linked to the profile whose signed
  // manifest lists https://github.com/<login>. No hosted profile is made for these; the link only grants the owner cookie.
  q("CREATE TABLE IF NOT EXISTS gh_links (gh_id INTEGER PRIMARY KEY, login TEXT, profile_id TEXT, ts TEXT)").run();
  const appFile = path.join(ctx.dataDir, "github-app.json");
  const app = (): App | null => { try { return JSON.parse(fs.readFileSync(appFile, "utf8")); } catch { return null; } };
  /** Sign-in can use a plain OAuth app (github-oauth.json: {client_id, client_secret}) instead of the GitHub App: GitHub's
   *  approval screen then asks only for public profile and email, not "Act on your behalf". The GitHub App stays for the
   *  optional private-repos install. */
  const oauthFile = path.join(ctx.dataDir, "github-oauth.json");
  const signin = (): { client_id: string; client_secret: string; scope: string } | null => {
    try { const o = JSON.parse(fs.readFileSync(oauthFile, "utf8")); if (o.client_id && o.client_secret) return { client_id: o.client_id, client_secret: o.client_secret, scope: "user:email" }; } catch { /* none */ }
    const a = app(); return a ? { client_id: a.client_id, client_secret: a.client_secret, scope: "" } : null; };
  const pub = ctx.publicUrl.replace(/\/$/, "") || "https://caldera.social";
  const secure = pub.startsWith("https:");
  const hashTok = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  /** GitHub logins a profile's signed manifest links to (lowercase). */
  const ghLoginsOf = (pr: any): string[] => { try { const links = JSON.parse(pr.manifest).body?.links;
    return (Array.isArray(links) ? links : []).map((l: any) => String(Array.isArray(l) ? l[1] : "").match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/?$/)?.[1]?.toLowerCase()).filter(Boolean) as string[]; } catch { return []; } };
  /** Existing (non-hosted) profiles whose page lists this GitHub login. A listing alone proves nothing (anyone can type
   *  any link), so these are only candidates: linking needs proof (see `provenOwner`). */
  const claimants = (login: string): any[] => (q("SELECT id, handle, manifest, updated FROM profiles WHERE handle IS NOT NULL ORDER BY updated DESC").all() as any[])
    .filter(pr => !q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(pr.id) && (ctx.owner?.usable(pr) ?? true) && ghLoginsOf(pr).includes(login.toLowerCase()));
  /** Proof that the GitHub account and the Caldera page belong to the same person: this browser already owns the page
   *  (signed in from Obsidian), or the GitHub profile itself links back to the page (website or bio). */
  const provenOwner = (req: http.IncomingMessage, pr: any, me: any): boolean => {
    if (ctx.owner?.of?.(req) === pr.id) return true;
    const back = `caldera.social/@${String(pr.handle).toLowerCase()}`;
    return [me?.blog, me?.bio].some((v: unknown) => String(v || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").includes(back));
  };
  const addCookie = (res: http.ServerResponse, raw: string) => { const prev = res.getHeader("set-cookie"); const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : []; res.setHeader("set-cookie", [...list, raw]); };
  const linkedProfile = (ghId: number, login: string): any => {
    const ln = q("SELECT * FROM gh_links WHERE gh_id=?").get(ghId) as any; if (!ln) return null;
    const pr = q("SELECT id, handle, manifest, updated FROM profiles WHERE id=?").get(ln.profile_id) as any;
    if (pr && (ctx.owner?.usable(pr) ?? true) && ghLoginsOf(pr).includes(login.toLowerCase())) return pr;
    q("DELETE FROM gh_links WHERE gh_id=?").run(ghId); return null;   // the owner took the GitHub link off their page: the link goes
  };

  // ------------------------------------------------------------------ cookies + sessions
  const cookies = (req: http.IncomingMessage) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  // where to land after signing in: a page on this hub only (a profile, city, note, the world, people or a group)
  const safeBack = (v: unknown): string => { const s0 = String(v || ""); return s0.length < 200 && /^\/(@[a-z0-9-]+\/[A-Za-z0-9._\/-]*|world|people|feed|feed\/p\/[0-9a-f]{12}|g\/[a-z0-9-]+|messages|messages\/@[a-z0-9-]+|messages\/groups(?:\/[a-z0-9-]+(?:\/[0-9a-f]{16})?)?|me\/building|settings|alerts)$/.test(s0) && !s0.includes("..") ? s0 : ""; };
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
  const page = (res: http.ServerResponse, status: number, title: string, body: string, bar = "") => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline' 'self'; form-action 'self' https://github.com; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Caldera</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
.me{max-width:760px;margin:0 auto;padding:28px 16px 64px}.me h1{font-family:'Source Serif 4',Georgia,serif;font-size:2rem;margin:.2em 0}.me .card{background:var(--bg-raised,#232327);border:1px solid var(--line,#2A2A2E);border-radius:12px;padding:16px 18px;margin:14px 0}
.me label{display:block;font-weight:500;margin:10px 0 4px}.me input[type=text],.me input[type=email],.me textarea{width:100%;box-sizing:border-box;background:var(--bg,#1C1C1F);color:inherit;border:1px solid var(--line,#2A2A2E);border-radius:8px;padding:8px 10px;font:inherit}
.me textarea{min-height:84px}.me .mut{color:var(--text-muted,#9A9AA6);font-size:.92em}.me code,.me pre{font-family:'IBM Plex Mono',monospace;font-size:12px}.me pre{white-space:pre-wrap;word-break:break-all;background:var(--bg,#1C1C1F);border:1px solid var(--line,#2A2A2E);border-radius:8px;padding:10px;max-height:220px;overflow:auto}
.me .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.me .who{display:flex;gap:14px;align-items:center}.me .who img{width:64px;height:64px;border-radius:50%}.me .danger{color:#F0716A}
.me button.btn{cursor:pointer}</style></head><body>${bar || (ctx.siteNav ? ctx.siteNav() : `<header class="nav"><a class="brand" href="/">Caldera</a><nav><a href="/people">People</a><a href="/world">World</a><a href="/guide">Guide</a><a href="/signin">Sign in</a></nav></header>`)}<main class="me">${body}</main><footer class="footer"><span>&copy; 2026 mjonesone, LLC</span><span><a href="/guide">Guide</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></span></footer><script src="/assets/site.js" defer></script>
<script>document.querySelectorAll('[data-copy-text]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy-text')).textContent;navigator.clipboard.writeText(t).then(function(){b.textContent='Copied'},function(){})})})</script></body></html>`);
  };

  // ------------------------------------------------------------------ GitHub API
  const gh = async (token: string, p: string, init: RequestInit = {}) => {
    const r = await F(p.startsWith("http") ? p : "https://api.github.com" + p, { ...init, headers: { accept: "application/vnd.github+json", authorization: "Bearer " + token, "user-agent": "caldera-hub", ...(init.headers || {}) } });
    if (r.status === 202) return { pending: true };
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${p}`);
    return r.status === 204 ? null : r.json();
  };
  async function exchange(params: Record<string, string>, who: { client_id: string; client_secret: string } = app()!) {
    const a = who; const r = await F("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "caldera-hub" },
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
  /** Private repos this member can see through the Caldera app, on every installation that covers them: their own
   *  account, and each organization that installed it where GitHub confirms the member has access to the repo (an
   *  organization's other private repos never land on their city). Found with the app's own credentials on every
   *  refresh, so an install counts even when GitHub never sent the member back to Caldera, and whatever token the
   *  member signed in with. Records the installation ids it used. Memoized for 2 minutes per member. */
  let instList: { at: number; list: any[] } | null = null;
  const privMemo = new Map<number, { at: number; repos: any[] }>();
  async function appInstallations(): Promise<any[]> {
    if (ctx.freshenMs !== 0 && instList && instList.at > Date.now() - 5 * 60_000) return instList.list;
    const list: any[] = [];
    for (let pg = 1; pg <= 10; pg++) {
      const r = await F(`https://api.github.com/app/installations?per_page=100&page=${pg}`, { headers: { accept: "application/vnd.github+json", authorization: "Bearer " + appJwt(), "user-agent": "caldera-hub" } });
      if (!r.ok) throw new Error(`GitHub ${r.status} listing installations`);
      const page = await r.json() as any[]; list.push(...page); if (page.length < 100) break;
    }
    instList = { at: Date.now(), list }; return list;
  }
  async function memberPrivateRepos(acct: any, _token?: string): Promise<any[]> {
    const memo = privMemo.get(acct.gh_id); if (ctx.freshenMs !== 0 && memo && memo.at > Date.now() - 2 * 60_000) return memo.repos;
    const insts: string[] = [], out: any[] = [], login = String(acct.login || "");
    for (const inst of await appInstallations()) {
      const owner = inst.account || {};
      if (inst.suspended_at) continue;
      if (Number(owner.id) === Number(acct.gh_id)) {   // the member's own account
        const repos = (await installationRepos(String(inst.id))).filter(r => r.private);
        if (repos.length) insts.push(String(inst.id)); out.push(...repos); continue;
      }
      if (owner.type !== "Organization") continue;
      const repos = (await installationRepos(String(inst.id))).filter(r => r.private).slice(0, 150);
      let any = false;
      for (let k = 0; k < repos.length; k += 10) await Promise.all(repos.slice(k, k + 10).map(async r => {
        try {   // only repos GitHub says this member can access
          const p = await gh(r._token, `/repos/${r.full_name}/collaborators/${encodeURIComponent(login)}/permission`) as any;
          if (p && p.permission && p.permission !== "none") { out.push(r); any = true; }
        } catch { /* not a collaborator, or GitHub won't say: leave it off */ }
      }));
      if (any) insts.push(String(inst.id));
    }
    const ids = insts.join(",") || null;
    if ((acct.installation || null) !== ids) { q("UPDATE gh_accounts SET installation=? WHERE gh_id=?").run(ids, acct.gh_id); acct.installation = ids; }
    const seen = new Set<string>(), repos = out.filter(x => !seen.has(x.full_name) && seen.add(x.full_name));
    privMemo.set(acct.gh_id, { at: Date.now(), repos }); if (privMemo.size > 5000) privMemo.clear();
    return repos;
  }
  /** Every private repo the app can read, across all installations, each with its installation token (for the circle
   *  job's private-project matching; the names stay server-side). Capped per installation and overall. */
  async function appPrivateRepos(): Promise<{ full: string; token: string }[]> {
    if (!app()) return [];
    const out: { full: string; token: string }[] = [];
    for (const inst of await appInstallations()) {
      if (inst.suspended_at) continue;
      try { for (const r of (await installationRepos(String(inst.id))).filter(r => r.private && !r.archived).slice(0, 150)) out.push({ full: r.full_name, token: r._token }); }
      catch (e: any) { console.error("app private repos", inst.id, e.message); }
      if (out.length >= 600) break;
    }
    return out.slice(0, 600);
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

  // uploaded photo / masthead for a hosted profile: kept outside the page folder so every rebuild picks them up
  const upDir = (ghId: number) => path.join(ctx.dataDir, "uploads", String(ghId));
  const uploaded = (ghId: number, kind: "photo" | "banner"): { file: string; ext: string } | null => {
    for (const ext of ["jpg", "png", "webp"]) { const f = path.join(upDir(ghId), `${kind}.${ext}`); if (fs.existsSync(f)) return { file: f, ext }; }
    return null;
  };

  /** A complete page from public GitHub alone, so a new member lands on a filled-in profile, not an empty form: a headline,
   *  an About paragraph, facts, what they're working on now (repos pushed in the last two weeks), topics (repo topics and
   *  languages) and a timeline (joined GitHub, then their most-starred repos by year). Public repos only: private ones
   *  are never named. Anything the member writes on their account page wins. */
  function autofill(me: any, pub: any[], stats: Record<string, { commits: number; week: number }>, langs: string[], name: string) {
    const link = (r: any) => `[[${r.name}|${r.html_url}]]`, plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
    const since = String(me.created_at || "").slice(0, 4), stars = pub.reduce((a, r) => a + (Number(r.stargazers_count) || 0), 0);
    const recent = pub.filter(r => Date.parse(r.pushed_at) > Date.now() - 14 * DAY).sort((a, b) => (stats[b.full_name]?.week || 0) - (stats[a.full_name]?.week || 0) || Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
    const starred = pub.filter(r => r.stargazers_count > 0).sort((a, b) => b.stargazers_count - a.stargazers_count);
    const busiest = pub.slice().sort((a, b) => (stats[b.full_name]?.commits || 0) - (stats[a.full_name]?.commits || 0)).filter(r => stats[r.full_name]?.commits);
    const lj = (xs: string[]) => xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : xs[0] || "";
    const headline = `${langs.length ? lj(langs.slice(0, 2)) + " developer" : "Developer"}${me.location ? ` in ${String(me.location).slice(0, 40)}` : ""}`;
    const first = String(name).split(/\s+/)[0] || me.login;
    const parts = [`${first} has been on GitHub since ${since || "a while"}, with ${plural(pub.length, "public repo")}${stars ? ` and ${plural(stars, "star")} across them` : ""}.`];
    const show = (recent.length ? recent : busiest).slice(0, 2);
    if (show.length) parts.push(`${recent.length ? "Lately busiest on" : "Busiest on"} ${show.map(r => link(r) + (r.description ? ` (${String(r.description).replace(/[|\[\]]/g, " ").trim().slice(0, 70)})` : "")).join(" and ")}.`);
    if (starred[0] && !show.includes(starred[0])) parts.push(`Best known for ${link(starred[0])}, with ${plural(starred[0].stargazers_count, "star")}.`);
    if (langs.length) parts.push(`Writes mostly ${lj(langs.slice(0, 3))}.`);
    const properties = ([["Location", me.location || ""], ["Company", me.company || ""], ["On GitHub since", since], ["Public repos", pub.length ? String(pub.length) : ""],
      ["Stars earned", stars ? stars.toLocaleString("en-US") : ""], ["Followers", me.followers ? Number(me.followers).toLocaleString("en-US") : ""], ["Top languages", langs.slice(0, 3).join(", ")]] as [string, string][]).filter(x => x[1]);
    const now = recent.slice(0, 3).map(r => `Working on ${link(r)}${r.description ? `: ${String(r.description).replace(/[|\[\]]/g, " ").trim().slice(0, 110)}` : ""}`);
    const tc = new Map<string, number>();
    for (const r of pub) for (const t of (Array.isArray(r.topics) ? r.topics : [])) tc.set(String(t), (tc.get(String(t)) || 0) + 1);
    for (const r of pub) if (r.language) tc.set(String(r.language), (tc.get(String(r.language)) || 0) + 1);
    const topics = [...tc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18) as [string, number][];
    const timeline: [string, string][] = since ? [[since, "Joined GitHub"]] : [];
    const firstRepo = pub.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    const picks = [...new Set([firstRepo, ...starred.slice(0, 5), ...busiest.slice(0, 2)].filter(Boolean))].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const r of picks) timeline.push([String(r.created_at).slice(0, 4), `${r === firstRepo ? "First public repo: " : "Started "}${link(r)}${r.description || r.stargazers_count ? ` | ${String(r.description || "").replace(/[|\[\]]/g, " ").trim().slice(0, 120)}${r.stargazers_count ? `${r.description ? " " : ""}(${plural(r.stargazers_count, "star")})` : ""}` : ""}`]);
    return { headline, summary: parts.join(" "), properties, now, topics, timeline };
  }

  /** Lines of code this week (for the member's daily email): GitHub's weekly additions/deletions (code_frequency) for the
   *  repos with commits this week, the busiest LOC_REPOS of them, 4 at a time. Stored as one aggregate with the account
   *  (private repos only ever as part of the total; per-repo numbers stay server-side, keyed like the commit stats, so a
   *  repo GitHub is still computing keeps last time's numbers). The week is GitHub's: since Sunday 00:00 UTC. */
  const LOC_REPOS = 8;
  async function linesThisWeek(repos: any[], stats: Record<string, { week: number }>, token: string, prev: any) {
    const now = new Date(), wk = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay()) / 1000);
    const busy = repos.filter(r => (stats[r.full_name]?.week || 0) > 0).sort((a, b) => (stats[b.full_name]?.week || 0) - (stats[a.full_name]?.week || 0)).slice(0, LOC_REPOS);
    if (!busy.length) return { week: wk, added: 0, removed: 0, repos: 0, at: now.toISOString(), per: {} };
    const old: Record<string, { w: number; a: number; d: number }> = prev && prev.per && typeof prev.per === "object" ? prev.per : {}, per: Record<string, { w: number; a: number; d: number }> = {};
    for (let i = 0; i < busy.length; i += 4) await Promise.all(busy.slice(i, i + 4).map(async r => {
      try {
        const f = await gh(r._token || token, `/repos/${r.full_name}/stats/code_frequency`) as any;
        const row = Array.isArray(f) ? f.find((x: any) => Array.isArray(x) && Number(x[0]) === wk) : undefined;
        if (row) per[r.full_name] = { w: wk, a: Math.abs(Number(row[1]) || 0), d: Math.abs(Number(row[2]) || 0) };
        else if (Array.isArray(f)) per[r.full_name] = { w: wk, a: 0, d: 0 };
        else if (old[r.full_name]?.w === wk) per[r.full_name] = old[r.full_name]!;   // GitHub is still computing (202): keep this week's last numbers
      } catch { if (old[r.full_name]?.w === wk) per[r.full_name] = old[r.full_name]!; }   // too many commits (422) or an error: last good numbers
    }));
    const xs = Object.values(per);
    if (!xs.length) return prev && prev.week === wk ? prev : undefined;   // nothing known yet: the email leaves the row out
    return { week: wk, added: xs.reduce((s0, x) => s0 + x.a, 0), removed: xs.reduce((s0, x) => s0 + x.d, 0), repos: xs.length, at: now.toISOString(), per };
  }

  async function build(acct: any): Promise<string> {
    const token = await tokenFor(acct), me = await gh(token, "/user") as any, edits = JSON.parse(acct.edits || "{}"), cache = JSON.parse(acct.cache || "{}");
    // no email on file yet (signed up before we asked GitHub for it): try again on every refresh until we have one
    if (ctx.social?.email && !q("SELECT 1 FROM email_suggest WHERE owner=? AND verified=1").get(acct.profile_id) && !q("SELECT 1 FROM email_subs WHERE owner=? AND confirmed IS NOT NULL").get(acct.profile_id)) {
      try { await captureEmail(acct.profile_id, token, me); } catch (e: any) { console.error("email backfill", acct.login, e.message); } }
    if (edits.heldNew && (ctx.accountOk ? ctx.accountOk(me) : true)) {   // a brand-new account that now has something public: list it
      delete edits.heldNew; delete edits.listed; q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify(edits), acct.gh_id); }
    const own: any[] = [];
    for (let pg = 1; pg <= 3; pg++) { const r = await gh(token, `/users/${encodeURIComponent(me.login)}/repos?type=owner&sort=pushed&per_page=100&page=${pg}`) as any[]; own.push(...r); if (r.length < 100) break; }
    let priv: any[] = [];
    try { priv = await memberPrivateRepos(acct, token); } catch (e: any) { console.error("private repos", acct.login, e.message); }   // none installed: public repos only
    const repos = [...own.filter(r => !r.fork && !r.private), ...priv].slice(0, 120);
    const stats: Record<string, { weeks: number[]; commits: number; week: number }> = cache.stats || {};
    // commit activity for the 40 most recently pushed, 8 at a time so a first sign-up waits seconds, not a minute (GitHub
    // computes it lazily: keep the last good numbers)
    const top = repos.slice(0, 40);
    for (let i = 0; i < top.length; i += 8) await Promise.all(top.slice(i, i + 8).map(async r => {
      try {
        const w = await gh(r._token || token, `/repos/${r.full_name}/stats/commit_activity`) as any;
        if (Array.isArray(w) && w.length) { const t52 = w.slice(-52).map((x: any) => x.total); stats[r.full_name] = { weeks: t52.slice(-12), commits: t52.reduce((a: number, b: number) => a + b, 0), week: w[w.length - 1].total }; }
      } catch { /* keep cached */ }
    }));
    const loc = await linesThisWeek(repos, stats, token, cache.loc);
    const cityRepos: CityRepo[] = repos.map(r => { const s = stats[r.full_name] || { weeks: [], commits: 0, week: 0 };
      return { name: r.name, project: r.language || "Other", public: !r.private, language: r.language || "Other", commits: s.commits || (r.size ? 1 : 0), weeks: s.weeks, week: s.week, today: 0,
        pushed: r.pushed_at, created: r.created_at, size: r.size, url: r.private ? undefined : r.html_url, description: r.private ? undefined : (r.description || "").slice(0, 200), sites: cleanSites(r.homepage) }; });
    // daily activity from public events (pushes, PRs, issues, reviews), last 30 days
    const days: Record<string, number> = {};
    try { for (let pg = 1; pg <= 3; pg++) { const ev = await gh(token, `/users/${encodeURIComponent(me.login)}/events?per_page=100&page=${pg}`) as any[];
      for (const e of ev) { const d = String(e.created_at).slice(0, 10); days[d] = (days[d] || 0) + (e.type === "PushEvent" ? Math.max(1, Number(e.payload?.size) || 1) : 1); } if (ev.length < 100) break; } } catch { /* no events */ }
    const daily: DailyEntry[] = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); daily.push({ date: d, counts: { meetings: 0, emails: 0, prompts: 0, commits: days[d] || 0, notes: 0, docs: 0 } as any }); }
    const city = cityData(cityRepos, () => ({ n: 0, paths: [] }), new Date().toISOString());
    // private repos: the member's setting decides what their public city and code numbers say about them
    const prRow = q("SELECT * FROM profiles WHERE id=?").get(acct.profile_id) || { id: acct.profile_id, created: new Date().toISOString() };
    const pmode = ctx.privateMode?.modeFor(prRow) || "show", counted = pmode === "show" || pmode === "named" ? cityRepos : cityRepos.filter(r => r.public);
    const pubBase = publicCity(city, city.districts.map(d => d.name), pmode);
    // apps and websites they listed in settings: cards on the page, storefronts in the city
    const LS = ctx.listings?.(), lrefs = LS ? [...LS.refsOf(edits.apps, "app"), ...LS.refsOf(edits.websites, "site")] : [];
    const lmeta = LS && lrefs.length ? await LS.resolve(lrefs).catch(() => [] as ListingMeta[]) : [];
    const listed = lrefs.map(r => toListing(r, lmeta.find(m => m.key === r.key), pub));
    const hideSf: string[] = Array.isArray(edits.hideStorefronts) ? edits.hideStorefronts : [];
    const pubCity = withListingsPublic(pubBase, city, listed, pmode, [], hideSf) || pubBase;
    const total = counted.reduce((a, r) => a + r.commits, 0), langs = [...new Set(counted.map(r => r.language).filter(l => l !== "Other"))].slice(0, 6);
    const weekly = Array.from({ length: 12 }, (_, i) => counted.reduce((a, r) => a + (r.weeks[i] || 0), 0));
    const handle = acct.handle as string, name = String(edits.name || me.name || me.login).slice(0, 80);
    const auto = autofill(me, own.filter(r => !r.fork && !r.private && !r.archived), stats, langs, name);
    const links: [string, string][] = [["GitHub", me.html_url]];
    if (me.blog) links.push(["Website", /^https?:\/\//.test(me.blog) ? me.blog : "https://" + me.blog]);
    if (me.twitter_username) links.push(["X", "https://x.com/" + me.twitter_username]);
    for (const l of String(edits.links || "").split("\n")) { const [a, b] = l.split("|").map(x => x.trim()); if (a && /^https:\/\//.test(b || "")) links.push([a.slice(0, 40), b.slice(0, 300)]); }
    const files: Record<string, Buffer | string> = {};
    let avatar: string | undefined;
    const upPhoto = uploaded(acct.gh_id, "photo"), upBanner = uploaded(acct.gh_id, "banner");
    if (upPhoto) { files[`img/photo.${upPhoto.ext}`] = fs.readFileSync(upPhoto.file); avatar = `img/photo.${upPhoto.ext}`; }
    else try { const r = await F(me.avatar_url + (me.avatar_url.includes("?") ? "&" : "?") + "s=240"); if (r.ok) { files["img/avatar.png"] = Buffer.from(await r.arrayBuffer()); avatar = "img/avatar.png"; } } catch { /* initials */ }
    let banner: string | undefined;
    if (upBanner) { files[`img/banner.${upBanner.ext}`] = fs.readFileSync(upBanner.file); banner = `img/banner.${upBanner.ext}`; }
    const p: ProfileData = {
      name, handle, headline: String(edits.headline || me.bio || auto.headline).slice(0, 160), theme: "dark", avatar, banner, icon: avatar, links,
      properties: auto.properties,
      sections: { journal: false, scoreboard: true, properties: true, numbers: false, topics: auto.topics.length > 0, notes: false, asks: false, social: true, links: true, sidebar: true, rail: false, city: true, timeline: auto.timeline.length > 1 },
      stats: { notes: 0, words: 0, links: 0, activeDays: daily.filter(d => (d.counts as any).commits).length }, topics: auto.topics, daily, publicNotes: [], asks: [], offers: [],
      updated: new Date().toISOString(), hub: pub, summary: edits.summary ? String(edits.summary).slice(0, 1200) : auto.summary,
      now: auto.now.length ? auto.now : undefined, timeline: auto.timeline.length > 1 ? auto.timeline : undefined,
      code: { commits: total, repos: counted.length, languages: langs, weekly, url: me.html_url },
      projects: cityRepos.filter(r => r.public).sort((a, b) => b.commits - a.commits).slice(0, 6).map(r => ({ name: r.name, status: r.description || r.language, url: r.url || me.html_url, commits: r.commits })),
      city: pubCity, source: "GitHub",
      ...(listed.some(l => l.kind === "app") ? { apps: listed.filter(l => l.kind === "app") } : {}), ...(listed.some(l => l.kind === "site") ? { websites: listed.filter(l => l.kind === "site") } : {}),
    } as ProfileData;
    for (const [k, v] of Object.entries(renderProfile(p))) files[k] = v;
    const id = JSON.parse(ctx.unseal(acct.key_sealed)) as C.Identity;
    const manifest = C.sign(id, "profile.manifest", { name, handle, boxKey: id.boxPublic, headline: p.headline, photos: { avatar, banner }, links, sections: Object.keys(p.sections).filter(k => p.sections[k]),
      stats: p.stats, daily: daily.map(d => ({ date: d.date, score: C.activityScore(d.counts), headline: "", counts: d.counts })), topics: auto.topics.slice(0, 12), asks: [], offers: [], listed: edits.listed !== false, page: "index.html", updated: p.updated, hosted: "github", groups: groupsFrom((edits.groups || []).join(",")), languages: langs, ...(edits.autoConnectRepos === false ? { autoConnectRepos: false } : {}) });
    const r = ctx.accept(manifest); if (r.status !== 200) throw new Error(r.body?.error || "couldn't publish");
    const dir = path.join(ctx.dataDir, "profiles", handle);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "img"), { recursive: true }); fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (const [k, v] of Object.entries(files)) { const f = path.join(dir, path.normalize(k)); if (!f.startsWith(dir)) continue; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
    fs.writeFileSync(path.join(dir, "caldera.json"), JSON.stringify(manifest));
    // live traffic + agents: one site key per district, the agent key with a hashed repo -> district map
    const have = new Map((q("SELECT key, project FROM traffic_sites WHERE owner=?").all(id.id) as any[]).map(x => [x.project, x.key]));
    for (const d of [...city.districts, ...pubCity.districts.filter(x => x.name === "Apps & sites")]) if (!have.has(d.name)) q("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run(crypto.randomBytes(8).toString("hex"), id.id, d.name, 1, crypto.randomBytes(18).toString("hex"), new Date().toISOString());
    const rmap = Object.fromEntries(cityRepos.map(r => [crypto.createHash("sha256").update(r.name.toLowerCase()).digest("hex").slice(0, 16), r.project]));
    if (q("SELECT 1 FROM agent_keys WHERE owner=?").get(id.id)) q("UPDATE agent_keys SET repos=? WHERE owner=?").run(JSON.stringify(rmap), id.id);
    else q("INSERT INTO agent_keys VALUES (?,?,?,?,?)").run(crypto.randomBytes(9).toString("hex"), id.id, crypto.randomBytes(18).toString("hex"), JSON.stringify(rmap), new Date().toISOString());
    q("UPDATE gh_accounts SET cache=?, refreshed=?, login=? WHERE gh_id=?").run(JSON.stringify({ stats, sig: cache.sig, ...(loc ? { loc } : {}) }), new Date().toISOString(), me.login, acct.gh_id);
    return `${pub}/@${handle}/`;
  }

  // every build reads a whole GitHub account (dozens of API calls + rendering): a launch can bring many at once, so
  // builds run at most BUILD_CONCURRENCY at a time and the rest wait their turn (first builds and refreshes alike)
  const BUILD_CONCURRENCY = 2; let buildsRunning = 0; const buildWaiters: (() => void)[] = [];
  async function queuedBuild(acct: any): Promise<string> {
    if (buildsRunning >= BUILD_CONCURRENCY) await new Promise<void>(r => buildWaiters.push(r));
    buildsRunning++;
    try { return await build(acct); } finally { buildsRunning--; buildWaiters.shift()?.(); }
  }

  // refresh every hosted (unclaimed) profile every 6 hours, spread out; a first build cut short by a restart has
  // refreshed IS NULL and is picked up here (first pass 30 s after start)
  const refreshDue = async () => {
    if (!app()) return;
    const due = q("SELECT * FROM gh_accounts WHERE claimed IS NULL AND (refreshed IS NULL OR refreshed < ?) LIMIT 5").all(new Date(Date.now() - 6 * 3600_000).toISOString()) as any[];
    for (const a of due) { try { await queuedBuild(a); } catch (e: any) { q("UPDATE gh_accounts SET refreshed=? WHERE gh_id=?").run(new Date().toISOString(), a.gh_id); console.error("github refresh", a.login, e.message); } }
  };
  const timer = setInterval(refreshDue, 10 * 60_000); timer.unref?.();

  // a page view checks GitHub for new or removed repos (2 cheap calls, at most every 10 minutes per member) and rebuilds
  // in the background when they changed: a repo created a minute ago is on the map by the next load, not in 6 hours
  const lastCheck = new Map<number, number>();
  async function freshen(profileId: string): Promise<boolean> {
    if (!app()) return false;
    const acct = q("SELECT * FROM gh_accounts WHERE profile_id=? AND claimed IS NULL AND token_sealed<>''").get(profileId) as any; if (!acct) return false;
    const now = Date.now(), every = ctx.freshenMs ?? 10 * 60_000; if (every && (lastCheck.get(acct.gh_id) || 0) > now - every) return false;
    lastCheck.set(acct.gh_id, now); if (lastCheck.size > 20_000) lastCheck.clear();
    try {
      const token = await tokenFor(acct), login = encodeURIComponent(acct.login);
      const [u, newest] = await Promise.all([gh(token, `/users/${login}`) as Promise<any>, gh(token, `/users/${login}/repos?type=owner&sort=created&direction=desc&per_page=1`) as Promise<any[]>]);
      let sig = `${u?.public_repos ?? "?"}|${Array.isArray(newest) ? newest[0]?.full_name || "" : ""}`;
      try { const pr = await memberPrivateRepos(acct, token); sig += `|${pr.length}|${pr.map(r => r.id).sort().join(".").slice(-60)}`; } catch (e: any) { console.error("private repos check", acct.login, e.message); }
      const cache = JSON.parse(acct.cache || "{}"), first = cache.sig === undefined, changed = !first && cache.sig !== sig;
      if (cache.sig !== sig) { cache.sig = sig; q("UPDATE gh_accounts SET cache=? WHERE gh_id=?").run(JSON.stringify(cache), acct.gh_id); }
      // first check: only rebuild if the last build is older than 30 minutes (it may predate a new repo)
      if (changed || (first && (!acct.refreshed || Date.parse(acct.refreshed) < now - 30 * 60_000))) {
        void queuedBuild({ ...acct, cache: JSON.stringify(cache) }).catch((e: any) => console.error("github freshen", acct.login, e.message));
        return true;
      }
    } catch (e: any) { console.error("github freshen check", acct.login, e.message); }
    return false;
  }
  const firstPass = setTimeout(refreshDue, 30_000); firstPass.unref?.();

  // ------------------------------------------------------------------ the /me page
  const peopleOf = async (a: any): Promise<GhPerson[]> => { try { return (await ctx.social?.circle?.people(a.profile_id)) || []; } catch { return []; } };
  /** GitHub's primary verified address (needs the app's "Email addresses: read" permission, which users accept on their next
   *  sign-in) else the public profile email: stored sealed, only to prefill the daily-summary opt-in. Never blocks sign-in. */
  /** the account's verified addresses (needs the "Email addresses" permission; none without it) */
  async function verifiedEmails(access: string): Promise<string[]> {
    try {
      const list = await Promise.race([gh(access, "/user/emails"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]) as any[];
      return Array.isArray(list) ? list.filter(x => x?.verified && typeof x.email === "string" && !/noreply\.github\.com$/i.test(x.email)).map(x => String(x.email).toLowerCase()) : [];
    } catch { return []; }
  }
  async function captureEmail(owner: string, access: string, me: any): Promise<string | null> {
    const em = ctx.social?.email; if (!em?.suggest) return null;
    try {
      const list = await Promise.race([gh(access, "/user/emails"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]) as any[];
      const pick = Array.isArray(list) ? (list.find(x => x.primary && x.verified) || list.find(x => x.verified)) : null;
      if (pick?.email && !/noreply\.github\.com$/i.test(pick.email)) { em.suggest(owner, String(pick.email), true, "github-verified"); return String(pick.email); }
    } catch { /* 403/404: the permission isn't granted (yet) - fall back to the public address */ }
    if (typeof me?.email === "string" && me.email) { em.suggest(owner, me.email, false, "github-public"); return me.email; }
    return null;
  }
  /** The first thing a member sees until they've answered it: where to send the daily summary (prefilled, one click). */
  function emailCaptureCard(owner: string): string {
    const em = ctx.social?.email, pr = em?.promptFor?.(owner); if (!pr) return "";
    const sug = pr.suggestion;
    return `<form method="post" class="card" id="email" style="border:1px solid var(--accent,#8B6CF6);box-shadow:0 0 0 3px var(--accent-soft,rgba(139,108,246,.15))"><input type="hidden" name="do" value="email-capture">
<h2 style="margin:0 0 4px;font-family:'Source Serif 4',Georgia,serif;font-size:1.3rem">Where should we send your daily summary?</h2>
<p class="mut" style="margin:0 0 10px">Who visited your page, new friends and kudos, people to meet, and a nudge when your page needs attention. Only on days something happens, one-click unsubscribe.</p>
<input type="email" name="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" value="${esc(sug?.email || "")}" style="width:100%">
${sug?.verified ? `<p class="mut" style="margin:6px 0 0;font-size:.85em">Your verified GitHub address. Change it if you like.</p>` : ""}
<label style="margin:10px 0"><input type="checkbox" name="on"> Email me a daily summary</label>
<div class="row"><button class="btn" type="submit">Continue</button><button class="btn ghost small" type="submit" name="do" value="email-dismiss" formnovalidate>Not now</button></div></form>`;
  }
  function mePage(res: http.ServerResponse, a: any, note = "", people: GhPerson[] = [], next = "") {
    const pr = q("SELECT * FROM profiles WHERE id=?").get(a.profile_id) as any, edits = JSON.parse(a.edits || "{}");
    const url = `${pub}/@${a.handle}/`, ak = q("SELECT key, secret FROM agent_keys WHERE owner=?").get(a.profile_id) as any;
    const sites = q("SELECT key, project FROM traffic_sites WHERE owner=? ORDER BY project").all(a.profile_id) as any[];
    const ap = app();
    const agentPrompt = ak ? `Set up the Caldera agent hook on this computer, so my Caldera city shows what my AI agents are working on.

1. Download ${pub}/agent-hook.mjs to ~/.caldera/agent-hook.mjs (create the folder). Read it first: it reads the hook event from stdin, works out the repo (git remote name) and a short task title, and posts only that to my Caldera hub, with a 1.5 second timeout.
${hookCheck}
2. Write ~/.caldera/agent.json (chmod 600): {"hub": "${pub}", "key": "${ak.key}", "secret": "${ak.secret}", "machine": "<a short name for this computer>"}
3. In ~/.claude/settings.json, add hooks (keep existing ones) that run \`node ~/.caldera/agent-hook.mjs\` for UserPromptSubmit, PostToolUse, Stop, Notification and SessionEnd.
4. Test: echo '{"hook_event_name":"UserPromptSubmit","session_id":"caldera-test-1","cwd":"'$PWD'","prompt":"Testing the Caldera agent hook"}' | node ~/.caldera/agent-hook.mjs, then send SessionEnd for the same session.${hookTasksNote}` : "";
    const claim = a.claim_code && a.claim_expires > Date.now() ? a.claim_code : "";
    const invite = `${pub}/?invite=${encodeURIComponent(a.handle)}`, msg = `I'm on Caldera, a social network for GitHub and Obsidian (my repos are a little city). Join me: ${invite}`;
    const ghp = people.length ? `<div class="card" id="github-people"><b>Your GitHub people</b><p class="mut">People you follow, who follow you, or who work on your repos, who aren't on Caldera yet. When they join, you'll start out connected.</p>
<pre id="gh-msg" style="white-space:pre-wrap">${esc(msg)}</pre><button class="btn small" type="button" data-copy-text="gh-msg">Copy invite message</button>
<div style="margin-top:10px">${people.slice(0, 30).map(x => `<div class="row" style="justify-content:space-between;margin:6px 0"><span class="row"><img src="${esc(x.avatar)}" alt="" width="28" height="28" style="border-radius:50%"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">@${esc(x.login)}</a> <span class="mut">${esc(x.relation)}</span></span>`
      + (x.invited ? `<span class="mut">invited</span>` : x.canEmail ? `<form method="post" style="display:inline"><input type="hidden" name="do" value="gh-invite"><input type="hidden" name="login" value="${esc(x.login)}"><button class="btn small ghost" type="submit">Email invite</button></form>` : `<span class="mut">no public email: send the message</span>`) + `</div>`).join("")}</div></div>` : "";
    const growth = growthCards(a, edits) + ghp;
    if (!pr) {   // first build still running (or queued behind other sign-ups): show progress, refresh until it lands
      page(res, 200, "Building your city", `<meta http-equiv="refresh" content="2"><div class="card"><h1 style="margin-top:0">Building your city&hellip;</h1><p>Caldera is reading your public GitHub repos and turning them into your page and city. This usually takes under a minute${buildWaiters.length ? `; ${buildWaiters.length} other new member${buildWaiters.length === 1 ? " is" : "s are"} ahead of you` : ""}. It opens by itself when it is ready${/^\/messages\/@[a-z0-9-]+$/.test(next) ? `, then takes you straight to your conversation with ${esc(next.slice(10))}` : ""}.</p><p class="mut">Your page will be at <a href="${esc(url)}">${esc(url)}</a></p></div>`);
      return;
    }
    const em = ctx.social?.email?.status(a.profile_id);
    const conn: Conn = ctx.social?.connections?.(a.profile_id) || { hosted: true, github: { on: true, login: a.login }, obsidian: { on: false }, live: false, agents: false, email: !!em?.confirmed };
    const snippets = sites.map(x => `- ${x.project}: ${trackTag(pub, x.key)}`).join("\n");
    const panel = connectionsPanel({ pub, handle: a.handle, conn, sites, app: ap ? { slug: ap.slug } : null, installation: !!a.installation, email: em?.email,
      livePrompt: C.featurePrompt("live", { hubUrl: pub, handle: a.handle, hosted: true }) + (snippets ? `\n\nMy snippets, one per district (public site keys, fine in page HTML):\n${snippets}` : ""),
      agentPrompt: agentPrompt || C.featurePrompt("agents", { hubUrl: pub, handle: a.handle, hosted: true }) });
    page(res, 200, "Settings", `${SETTINGS_CSS}${note ? `<div class="card">${note}</div>` : ""}${emailCaptureCard(a.profile_id)}
<div class="who"><img src="${esc(url)}${esc(photoPath(pr))}" alt=""><div><h1>${esc(pr?.name || a.login)}</h1><div class="mut">@${esc(a.handle)} &middot; signed in with GitHub as ${esc(a.login)} &middot; <a href="${esc(url)}">your page</a></div></div></div>
${settingsNav([["connections", "Connections"], ["alerts", "Alerts"], ["page", "Your page"], ["people", "People"], ["/me/building", "What you're building"], ["notifications", "Notifications"], ["privacy", "Privacy"], ["account", "Account"]])}
${sectionHead("connections", "Connections", "Green means it's working. Tap anything grey to set it up right here.")}${panel}
${sectionHead("alerts", "Alerts")}${alertsList(a.profile_id, "set")}
${sectionHead("page", "Your page")}<div class="card"><b>Your page:</b> <a href="${esc(url)}">${esc(url)}</a><br><span class="mut">Built from your GitHub and refreshed every 6 hours${a.refreshed ? `; last ${esc(new Date(a.refreshed).toUTCString().slice(5, 22))} UTC` : ""}. Your repos are a city at <a href="${esc(url)}city.html">city.html</a>.</span></div>
${finishCard(a)}
<form method="post" class="card" id="edit"><input type="hidden" name="do" value="save"><b>Change anything</b> <span class="mut">(optional: everything below is already filled in from GitHub)</span>
<label for="n">Name</label><input type="text" id="n" name="name" maxlength="80" value="${esc(edits.name || pr?.name || "")}">
<label for="h">Headline</label><input type="text" id="h" name="headline" maxlength="160" value="${esc(edits.headline || "")}" placeholder="${esc(pr?.headline || "")} (from GitHub: type to replace)">
<label for="s">About you</label><textarea id="s" name="summary" maxlength="1200" placeholder="Written from your GitHub automatically. Type your own to replace it.">${esc(edits.summary || "")}</textarea>
<label for="l">Extra links <span class="mut">(one per line: Label | https://...)</span></label><textarea id="l" name="links">${esc(edits.links || "")}</textarea>
<label for="g">Groups <span class="mut">(comma separated, like <code>producthunt</code>; each one is a town at caldera.social/g/name)</span></label><input type="text" id="g" name="groups" maxlength="200" value="${esc((edits.groups || []).join(", "))}">
<div class="row" style="margin-top:12px"><button class="btn small" type="submit">Save and republish</button></div></form>
${listingsForm(edits)}
${sectionHead("people", "People")}${growth}
${sectionHead("notifications", "Notifications")}${emailCard(a, edits)}
${sectionHead("privacy", "Privacy")}<div class="card"><b>&#128274; What Caldera can see on GitHub</b><p class="mut" style="margin:6px 0 0">Your public profile, your email address and your public repos: read-only. Not your code, not your private repos (unless you install the app for chosen repos, and then only names, sizes and commit counts). GitHub enforces this. <a href="/security">Details</a> &middot; Revoke any time at <a href="https://github.com/settings/applications" target="_blank" rel="noopener">github.com/settings/applications</a>, or delete your page below.</p></div><form method="post" class="card" id="privacy-form"><input type="hidden" name="do" value="privacy">
<label><input type="checkbox" name="listed" ${edits.listed === false ? "" : "checked"}> Show me in the <a href="/people">People</a> directory and on the World map</label>
<label><input type="checkbox" name="autoConnectRepos" ${edits.autoConnectRepos === false ? "" : "checked"}> Connect me automatically with people I know from GitHub (shared repos, mutual follows)</label>
<div class="row" style="margin-top:12px"><button class="btn small" type="submit">Save</button></div></form>
${ctx.privateMode && pr ? privateReposForm(ctx.privateMode.modeFor(pr), !!ctx.privateMode.chosen(pr)) : ""}${ctx.searchPref && pr ? searchForm(ctx.searchPref.on(pr)) : ""}
${sectionHead("account", "Account")}<div class="card danger-zone"><div class="row" style="justify-content:space-between"><form method="post"><input type="hidden" name="do" value="logout"><button class="btn small ghost" type="submit">Sign out</button></form>
<form method="post" onsubmit="return this.querySelector('[name=sure]').checked"><input type="hidden" name="do" value="delete"><label class="mut" style="display:inline"><input type="checkbox" name="sure"> I'm sure</label> <button class="btn small ghost danger" type="submit">Delete my Caldera profile</button></form></div>
<p class="mut" style="margin-top:8px">Deleting removes your page, city and data, and revokes Caldera's access to your GitHub.</p></div>`, ctx.owner?.bar?.(a.profile_id) || "");
  }

  /** /settings for a page published from Obsidian: the vault is the source of truth, so page fields are read-only here;
   *  connections, people, notifications and sign-out work on the web. */
  function vaultPage(res: http.ServerResponse, pr: any, note = "") {
    const owner = pr.id as string, handle = pr.handle as string, url = `${pub}/@${handle}/`;
    let b: any = {}; try { b = JSON.parse(pr.manifest).body || {}; } catch { /* empty */ }
    const em = ctx.social?.email?.status(owner);
    const conn: Conn = ctx.social?.connections?.(owner) || { hosted: false, github: { on: false }, obsidian: { on: true, updated: pr.updated }, live: false, agents: false, email: !!em?.confirmed };
    const sites = q("SELECT key, project FROM traffic_sites WHERE owner=? ORDER BY project").all(owner) as any[];
    const snippets = sites.map(x => `- ${x.project}: ${trackTag(pub, x.key)}`).join("\n");
    const panel = connectionsPanel({ pub, handle, conn, sites, email: em?.email,
      livePrompt: C.featurePrompt("live", { hubUrl: pub, handle }) + (snippets ? `\n\nMy snippets, one per district (public site keys, fine in page HTML):\n${snippets}` : ""),
      agentPrompt: C.featurePrompt("agents", { hubUrl: pub, handle }), privatePrompt: C.featurePrompt("private", { hubUrl: pub, handle }) });
    const links: [string, string][] = Array.isArray(b.links) ? b.links.filter((l: any) => Array.isArray(l)).slice(0, 20) : [];
    const ro = (label: string, val: string) => `<div style="margin:8px 0"><span class="mut" style="display:block;font-size:13px">${esc(label)}</span>${val || `<span class="mut">Not set</span>`}</div>`;
    const yes = (on: boolean, t: string) => `<div style="margin:6px 0"><span class="conn-dot${on ? " on" : ""}" style="display:inline-block;margin-right:8px;vertical-align:middle"></span>${t}</div>`;
    page(res, 200, "Settings", `${SETTINGS_CSS}${note ? `<div class="card">${note}</div>` : ""}${emailCaptureCard(owner)}
<div class="who">${b.photos?.avatar ? `<img src="${esc(url)}${esc(String(b.photos.avatar).replace(/^\.?\//, ""))}" alt="">` : ""}<div><h1>${esc(pr.name || handle)}</h1><div class="mut">@${esc(handle)} &middot; published from Obsidian &middot; <a href="${esc(url)}">your page</a></div></div></div>
${settingsNav([["connections", "Connections"], ["alerts", "Alerts"], ["page", "Your page"], ["people", "People"], ["/me/building", "What you're building"], ["notifications", "Notifications"], ["privacy", "Privacy"], ["account", "Account"]])}
${sectionHead("connections", "Connections", "Green means it's working. Tap anything grey to set it up right here.")}${panel}
${sectionHead("alerts", "Alerts")}${alertsList(owner, "set")}
${sectionHead("page", "Your page", "Edited from Obsidian (<code>Caldera/profile.md</code>). Change it there, or have your AI do it; the page republishes about a minute after you save.")}
<div class="card">${ro("Name", esc(pr.name || ""))}${ro("Headline", esc(pr.headline || ""))}${ro("Links", links.map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join(" &middot; "))}${ro("Groups", esc((Array.isArray(b.groups) ? b.groups : []).join(", ")))}
${(() => { const t = C.editPrompt({ hubUrl: pub, handle }); return `<pre id="pr-edit" style="max-height:120px">${esc(t)}</pre><button class="btn small" type="button" data-copy-text="pr-edit">Copy prompt for my AI</button>`; })()}</div>
${sectionHead("people", "People")}${growthCards({ profile_id: owner, handle }, {})}
${sectionHead("notifications", "Notifications")}${emailCard({ profile_id: owner, handle }, {})}
${sectionHead("privacy", "Privacy", "Set in Obsidian: Settings &rarr; Caldera, or in <code>Caldera/profile.md</code>.")}<div class="card">${yes(b.listed !== false, "Listed in People and on the World map")}${yes(b.showViews !== false, "View count shown on your page")}${yes(b.autoConnectGithub !== false && b.autoConnectRepos !== false, "Connect automatically with people you know from GitHub")}</div>${ctx.privateMode ? privateReposForm(ctx.privateMode.modeFor(pr), !!ctx.privateMode.chosen(pr)) : ""}${ctx.searchPref ? searchForm(ctx.searchPref.on(pr)) : ""}
${sectionHead("account", "Account")}<div class="card danger-zone"><a class="btn small ghost" href="/signout?h=${encodeURIComponent(handle)}">Sign out of this browser</a>
<p class="mut" style="margin-top:10px">To delete your Caldera profile, run <b>Caldera: Delete my profile from the hub</b> in Obsidian. Your vault is never touched.</p></div>`, ctx.owner?.bar?.(owner) || "");
  }

  /** The Alerts list (Settings section and /alerts). Showing them marks them read. */
  function alertsList(owner: string, idp: string): string {
    const rows = ctx.social?.alerts?.forOwner(owner) || [];
    const html = rows.length ? rows.map(a => alertItem(a, pub, idp)).join("") : `<p class="mut">Nothing yet. News from Caldera shows up here.</p>`;
    const unread = rows.filter(a => !a.read).map(a => a.id); if (unread.length) ctx.social?.alerts?.markRead(owner, unread);
    return `<style>${ALERT_CSS}.me .al-item{padding:14px 0}.me .al-body{font-size:15px}</style><div class="card">${html}</div><script>${ALERT_JS}</script>`;
  }

  const photoPath = (pr: any) => { try { return String(JSON.parse(pr.manifest).body.photos?.avatar || "img/avatar.png").replace(/^\.?\//, ""); } catch { return "img/avatar.png"; } };

  /** "Finish your page" on /me: the shared checklist, with uploads for the photo and masthead. */
  function finishCard(a: any): string {
    const st = ctx.social?.pageState?.(a.profile_id); if (!st) return "";
    // the headline, About, links and facts are written from GitHub automatically: only the truly optional extras are listed
    const items = C.pageChecklist(st).filter(i => !["headline", "summary", "links", "group"].includes(i.id)), left = items.filter(i => !i.done);
    if (!left.length) return "";
    const up = (kind: "photo" | "banner", label: string, ghost = false) => `<label class="btn small${ghost ? " ghost" : ""}" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center">${label}<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${kind}" style="display:none"></label>`;
    const action: Record<string, string> = {
      photo: up("photo", "Upload a photo"), banner: `${up("banner", "Upload a masthead")} <span class="mut">Wide, about 3:1 (1800x600), up to 3 MB.</span>`,
      headline: `<a href="#edit">Edit your headline</a>`, summary: `<a href="#edit">Write two sentences</a>`, links: `<a href="#edit">Add links</a>`,
      friend: `<a href="#friends">Add a friend</a>`, group: `<a href="#edit">Join a group</a> <span class="mut">(try <code>producthunt</code>)</span>`, email: `<a href="#email">Turn it on</a>`,
    };
    const removable = uploaded(a.gh_id, "banner") ? `<form method="post" style="display:inline"><input type="hidden" name="do" value="remove-banner"><button class="btn small ghost" type="submit">Remove masthead</button></form>` : "";
    return `<div class="card" id="finish"><b>Your page is filled in from GitHub.</b> <span class="mut">Nothing else is needed. A few optional extras:</span>
${left.length ? left.map(i => `<div style="margin:10px 0"><b>${esc(i.label)}</b> <span class="mut">${esc(i.why)}</span><div class="row" style="margin-top:6px">${action[i.id] || ""}</div></div>`).join("") : `<p class="mut">Your page is complete. Nice.</p>`}
<p class="mut" style="margin-top:10px">Done: ${items.filter(i => i.done).map(i => esc(i.label)).join(" &middot; ") || "nothing yet"}. Replace your photo or masthead any time.</p><div class="row">${up("photo", "New photo", true)} ${up("banner", "New masthead", true)} ${removable}</div>
<p class="mut" id="up-status" role="status"></p></div>
<script>document.querySelectorAll('[data-upload]').forEach(function(inp){inp.addEventListener('change',function(){var f=inp.files&&inp.files[0];if(!f)return;var st=document.getElementById('up-status');
if(f.size>3*1024*1024){st.textContent='That image is over 3 MB. Try a smaller one.';return}st.textContent='Uploading and republishing...';var r=new FileReader();r.onload=function(){
fetch('/me/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:inp.getAttribute('data-upload'),data:String(r.result).split(',')[1]})}).then(function(x){return x.json()}).then(function(j){
if(j.ok){location.href='/me?uploaded='+inp.getAttribute('data-upload')+'#finish'}else st.textContent=j.error||'Upload failed.'}).catch(function(){st.textContent='Upload failed.'})};r.readAsDataURL(f)})})</script>`;
  }

  /** "Unlock more" on /me: once the basics are done, the features that make a page come alive (live visitors, agents on
   *  the map), each with a ready-to-paste prompt for the owner's AI that already carries their own snippets. */
  function unlockCard(a: any, sites: any[], agentText: string): string {
    const st = ctx.social?.pageState?.(a.profile_id), us = ctx.social?.unlockState?.(a.profile_id);
    if (!st || !us || C.pageChecklist(st).some(i => !i.done)) return "";
    const items = C.unlockChecklist(us), left = items.filter(i => !i.done); if (!left.length) return "";
    const snippets = sites.map(x => `- ${x.project}: ${trackTag(pub, x.key)}`).join("\n");
    const prompts: Record<string, string> = {
      live: C.featurePrompt("live", { hubUrl: pub, handle: a.handle, hosted: true }) + (snippets ? `\n\nMy snippets, one per district (public site keys, fine in page HTML):\n${snippets}` : ""),
      agents: agentText || C.featurePrompt("agents", { hubUrl: pub, handle: a.handle, hosted: true }),
    };
    return `<div class="card" id="unlock"><b>Unlock more</b> <span class="mut">${items.length - left.length} of ${items.length} on</span>
<p class="mut">Your basics are done. These make your city come alive. Copy a prompt and paste it into Claude Code, Codex or Cursor.</p>
${left.map(i => `<div style="margin:12px 0"><b>${esc(i.label)}</b> <span class="mut">${esc(i.why)}</span>${prompts[i.id] ? `<pre id="unlock-${i.id}" style="max-height:140px">${esc(prompts[i.id])}</pre><button class="btn small" type="button" data-copy-text="unlock-${i.id}">Copy prompt for my AI</button>` : ""}</div>`).join("")}</div>`;
  }

  /** Growth cards on /me: this week's visitors, share + invite, friends (requests, current, suggestions), daily email. */
  /** Daily summary email card (Notifications). */
  /** Apps and websites: one row each (repo it's built from, Storefront on/off, remove), then add one, then repos without storefronts. */
  function listingsForm(edits: any): string {
    const rows = (kind: ListingKind) => { const v = kind === "app" ? edits.apps : edits.websites; return (Array.isArray(v) ? v : []).map((l: string) => parseListingLine(l, kind)).filter(Boolean).slice(0, MAX_LISTINGS) as ListingRef[]; };
    const row = (r: ListingRef, kind: string, i: number) => `<div class="row ls-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0"><input type="hidden" name="${kind}_${i}_url" value="${esc(r.url)}"><span style="flex:1 1 220px;overflow-wrap:anywhere">${esc(r.kind === "site" ? r.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : r.store === "play" ? "Google Play: " + r.id : "App Store: id" + r.id)}</span><input type="text" name="${kind}_${i}_repo" value="${esc(r.repo || "")}" placeholder="repo (optional)" maxlength="100" style="width:150px" aria-label="Repo it's built from"><input type="text" name="${kind}_${i}_name" value="${esc(r.label || "")}" placeholder="short name (optional)" maxlength="${MAX_LABEL}" style="width:170px" aria-label="Short name shown on your page and storefront"><label style="display:inline"><input type="checkbox" name="${kind}_${i}_sf" ${r.storefront === false ? "" : "checked"}> Storefront</label><label class="mut" style="display:inline"><input type="checkbox" name="${kind}_${i}_rm"> Remove</label></div>`;
    const apps = rows("app"), sites = rows("site");
    return `<form method="post" class="card" id="listings"><input type="hidden" name="do" value="listings"><b>Apps and websites</b> <span class="mut">Each one gets a card on your page. With Storefront on it also stands as a storefront in your city (a website's live visitors walk into it). Repo: the repo it's built from, so it stands beside that repo. Short name: what your page and storefront call it, instead of the store's or site's title (up to ${MAX_LABEL} characters). Up to ${MAX_LISTINGS} of each.</span>
<div style="margin-top:8px"><b class="small">Apps</b>${apps.map((r, i) => row(r, "app", i)).join("") || '<div class="mut small">None yet.</div>'}<label for="ls-app">Add an app <span class="mut">(App Store or Google Play link)</span></label><input type="text" id="ls-app" name="app_new" placeholder="https://apps.apple.com/us/app/name/id123456789" maxlength="300"></div>
<div style="margin-top:8px"><b class="small">Websites</b>${sites.map((r, i) => row(r, "site", i)).join("") || '<div class="mut small">None yet.</div>'}<label for="ls-site">Add a website <span class="mut">(a whole site, or one page like example.com/tool)</span></label><input type="text" id="ls-site" name="site_new" placeholder="https://example.com" maxlength="300"></div>
<label for="ls-hide">Repos without storefronts <span class="mut">(comma separated; their apps and websites get no storefront, and their own websites are left off your city)</span></label><input type="text" id="ls-hide" name="hide_sf" maxlength="2000" value="${esc((Array.isArray(edits.hideStorefronts) ? edits.hideStorefronts : []).join(", "))}">
<div class="row" style="margin-top:12px"><button class="btn small" type="submit">Save and republish</button></div></form>`;
  }
  /** The listings form -> edits.apps / edits.websites ("link | repo | no-storefront" lines) and edits.hideStorefronts */
  function listingsFromForm(f: URLSearchParams): { apps: string[]; websites: string[]; hideStorefronts: string[]; bad: string[] } {
    const bad: string[] = [];
    const read = (kind: ListingKind) => {
      const out: ListingRef[] = [];
      for (let i = 0; i < MAX_LISTINGS; i++) {
        const u = f.get(`${kind}_${i}_url`); if (!u || f.get(`${kind}_${i}_rm`)) continue;
        const r = parseListingLine(u, kind); if (!r || out.some(x => x.key === r.key)) continue;
        const repo = (f.get(`${kind}_${i}_repo`) || "").trim(); if (/^[A-Za-z0-9._-]{1,100}$/.test(repo)) r.repo = repo;
        if (!f.get(`${kind}_${i}_sf`)) r.storefront = false;
        const name = cleanLabel(f.get(`${kind}_${i}_name`) || ""); if (name) r.label = name; else delete r.label;
        out.push(r);
      }
      const add = (f.get(`${kind}_new`) || "").trim();
      if (add) { const r = parseListingLine(add, kind); if (!r) bad.push(add); else if (!out.some(x => x.key === r.key) && out.length < MAX_LISTINGS) out.push(r); }
      return out.map(listingLine);
    };
    const hideStorefronts = (f.get("hide_sf") || "").split(",").map(x => x.trim()).filter(x => /^[A-Za-z0-9._-]{1,100}$/.test(x)).slice(0, 300);
    return { apps: read("app"), websites: read("site"), hideStorefronts, bad };
  }
  function emailCard(a: any, edits: any): string {
    const soc = ctx.social, me = a.profile_id as string, em = soc?.email?.status(me);
    const btn = (doit: string, label: string, hidden: Record<string, string>) => `<form method="post" style="display:inline"><input type="hidden" name="do" value="${doit}">${Object.entries(hidden).map(([k, x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("")}<button class="btn small" type="submit">${label}</button></form>`;
    return `${soc?.email ? `<div class="card" id="email"><b>Daily summary email</b><p class="mut">One short email on days something happens: who visited, new followers and kudos. Never shown on your page. Unsubscribe in one click.</p>
${em?.confirmed ? `<p>Sending to <b>${esc(em.email)}</b>.</p>${btn("email-off", "Turn off", {})}` : `${em ? `<p class="mut">Check ${esc(em.email)} for a confirmation link.</p>` : ""}<form method="post" class="row"><input type="hidden" name="do" value="email"><input type="text" name="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(em?.email || edits.ghEmail || "")}" style="flex:1 1 220px"><button class="btn small" type="submit">Email me a daily summary</button></form>`}</div>` : ""}`;
  }
  function growthCards(a: any, edits: any): string {
    const soc = ctx.social, me = a.profile_id as string, url = `${pub}/@${a.handle}/`, invite = `${pub}/?invite=${encodeURIComponent(a.handle)}`;
    const wk = new Date(Date.now() - 7 * DAY).toISOString();
    const v = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(a.handle, wk) as any;
    const brought = soc?.invitedCount(me) || 0, rq = soc ? soc.openRequests(me) : { incoming: [], outgoing: [] };
    const friends = q("SELECT p.id, p.handle, p.name, COALESCE(f.kind,'request') AS kind, f.why FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=? ORDER BY f.ts DESC").all(me) as any[];
    const sug = soc ? soc.suggest(me, 3) : [];
    const who = (h: string, n: string) => `<a href="${esc(pub)}/@${esc(h)}/">${esc(n || "@" + h)}</a> <span class="mut">@${esc(h)}</span>`;
    const btn = (doit: string, label: string, hidden: Record<string, string>) => `<form method="post" style="display:inline"><input type="hidden" name="do" value="${doit}">${Object.entries(hidden).map(([k, x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("")}<button class="btn small" type="submit">${label}</button></form>`;
    const text = encodeURIComponent(`My page on Caldera: a living profile, with my code as a city. ${url}`);
    return `<div class="card"><b>This week</b><p style="margin:.4em 0 0">${v.u ? `<b>${v.u}</b> ${v.u === 1 ? "person" : "people"} visited your page (${v.n} views).` : "No visitors yet this week. Share your page to get the first ones."}${brought ? ` You've brought in <b>${brought}</b> ${brought === 1 ? "person" : "people"}.` : ""}</p></div>
<div class="card"><b>Share your page</b><p class="mut">This is the picture people see when you post your link.</p><img src="${esc(url)}card.png" alt="Your link preview" style="width:100%;max-width:600px;border-radius:10px;border:1px solid var(--line,#2A2A2E);display:block;margin:6px 0 10px">
<div class="row"><a class="btn small" href="https://x.com/intent/post?text=${text}" target="_blank" rel="noopener">Post on X</a><a class="btn small" href="https://bsky.app/intent/compose?text=${text}" target="_blank" rel="noopener">Bluesky</a><a class="btn small" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener">LinkedIn</a></div>
<p style="margin:12px 0 4px"><b>Invite a friend</b></p><pre id="inv">${esc(invite)}</pre><button class="btn small" type="button" data-copy-text="inv">Copy invite link</button></div>
${(() => { const bd = ctx.social?.building?.(a.profile_id); if (!bd) return "";
  return `<div class="card" id="building"><b>What you're building</b>${bd.intros ? ` <span class="mut">&middot; ${bd.intros} introduction${bd.intros === 1 ? "" : "s"} waiting</span>` : ""}
<p class="mut">Tags from your public repos help people building the same things find you. Private repos only ever add a language.</p>
${bd.tags.length ? `<div class="row" style="gap:6px">${bd.tags.slice(0, 10).map(t => `<a href="/people?tag=${encodeURIComponent(t.t)}" style="display:inline-flex;align-items:center;min-height:28px;padding:0 11px;border-radius:999px;font-size:13px;text-decoration:none;${t.kind === "stack" ? "border:1px solid var(--line,#2A2A2E);color:var(--text,#E6E6EA)" : "background:var(--accent-soft,rgba(139,108,246,.10));color:var(--accent-text,#C9B8FF)"}">${esc(t.t)}</a>`).join("")}</div>` : `<p class="mut">No tags yet. They're worked out from your public GitHub within a few minutes.</p>`}
<div class="row" style="margin-top:10px"><a class="btn small" href="/me/building">${bd.intros ? "Answer introductions" : "Edit tags"}</a></div></div>`; })()}
<div class="card" id="friends"><b>Friends and followers</b> <span class="mut">&middot; follow each other and you're friends</span>
${rq.incoming.length ? `<p style="margin:.5em 0 .3em">Following you:</p>${rq.incoming.map(r => `<div class="row" style="margin:6px 0">${who(r.handle, r.name)}${r.note ? ` <span class="mut">"${esc(r.note)}"</span>` : ""} ${btn("accept", "Follow back", { req: r.request, to: r.id })}</div>`).join("")}` : ""}
${friends.length ? `<p style="margin:.6em 0 .3em">Your friends:</p><div class="row">${friends.map(f => who(f.handle, f.name) + (f.why && (f.kind === "repo" || f.kind === "github") ? ` <span class="mut">(${f.kind === "repo" ? "both work on " : ""}${esc(f.why)})</span>` : "")).join(" &middot; ")}</div>` : `<p class="mut">No friends yet.</p>`}
${rq.outgoing.length ? `<p class="mut" style="margin:.6em 0 0">You follow: ${rq.outgoing.map(r => "@" + esc(r.handle)).join(", ")}</p>` : ""}
${sug.length ? `<p style="margin:.8em 0 .3em">People you might know:</p>${sug.map(s => `<div class="row" style="margin:6px 0">${who(s.handle, s.name)} <span class="mut">${esc(s.why)}</span> ${btn("add", "Follow", { to: s.id })}</div>`).join("")}` : ""}</div>
`;
  }

  // ------------------------------------------------------------------ routes
  /** Public hub routes. Returns true when handled. */
  const cbResults = new Map<string, { state: string; at: number; p: Promise<{ cookies: string[]; loc: string } | null> }>();
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (req.method === "GET" && p === "/auth/github") {
      const a = app(); if (!a) { page(res, 503, "Coming soon", `<h1>Sign up with GitHub is almost ready</h1><p>Install the <a href="/#install">Obsidian plugin</a> in the meantime.</p>`); return true; }
      const inv = (url.searchParams.get("invite") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31), grp = groupsFrom(url.searchParams.get("group"))[0];
      const forH = (url.searchParams.get("h") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);
      const signed = forH ? null : account(req), back = safeBack(url.searchParams.get("back"));
      if (signed) {
        if (grp && !signed.claimed) {   // already here: join the group and republish
          const ed = JSON.parse(signed.edits || "{}"); ed.groups = [...new Set([...(ed.groups || []), grp])];
          q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify(ed), signed.gh_id);
          try { await queuedBuild(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(signed.gh_id)); } catch { /* next refresh */ }
          redirect(res, `/me?joined=${grp}`); return true;
        }
        redirect(res, back || "/me"); return true;
      }
      if (inv) setCookie(res, "cal_inv", inv, 30 * 86400);
      if (grp) setCookie(res, "cal_grp", grp, 30 * 86400);
      // a double-click or a second tab reuses the pending state, so whichever GitHub tab finishes still matches
      const prevState = String(cookies(req).cal_oauth || ""), state = /^[0-9a-f]{32}$/.test(prevState) ? prevState : crypto.randomBytes(16).toString("hex"); setCookie(res, "cal_oauth", state, 600);
      setCookie(res, "cal_h", forH, forH ? 600 : 0);   // signing in for a particular page: only that page's owner gets in
      setCookie(res, "cal_back", back, back ? 600 : 0);   // came from someone's page (e.g. to send kudos): go back there after
      // the daily email is opt-in (consent must be a positive act): only a ticked box on the sign-up form (digest=1) subscribes
      const dg = url.searchParams.getAll("digest"); setCookie(res, "cal_dig", dg.includes("1") ? "1" : "0", 600);
      const si = signin() || a; ctx.track?.(req, "click", back ? "from " + back.split("/").slice(0, 2).join("/") : "");
      redirect(res, `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(si.client_id)}&redirect_uri=${encodeURIComponent(pub + "/auth/github/callback")}&state=${state}${(si as any).scope ? `&scope=${encodeURIComponent((si as any).scope)}` : ""}`); return true;
    }
    if (req.method === "GET" && p === "/auth/github/callback") {
      const a = app(); if (!a) { redirect(res, "/"); return true; }
      ctx.track?.(req, "back", url.searchParams.get("error") ? "denied: " + String(url.searchParams.get("error")).slice(0, 40) : "");
      if (url.searchParams.get("error")) {   // they pressed Cancel on GitHub's screen: no retry loop, just back to the start
        ctx.track?.(req, "fail", "cancelled at GitHub"); setCookie(res, "cal_oauth", "", 0); redirect(res, "/#install"); return true; }
      // browsers sometimes send the callback twice (a retried navigation): GitHub's code works once, so the second
      // request replays the first one's outcome (same cookies, same redirect) instead of failing with "code expired"
      const code = url.searchParams.get("code") || "", st = url.searchParams.get("state") || "";
      const prior = cbResults.get(code);
      // only the same browser (its pending-sign-in cookie matches) gets the replay: a copied callback URL gets nothing
      if (code && prior && prior.state === st && Date.now() - prior.at < 120_000 && String(cookies(req).cal_oauth || "") === st) {
        const r = await prior.p;
        if (r) { if (r.cookies.length) res.setHeader("set-cookie", r.cookies); redirect(res, r.loc); return true; }
      }
      let settle: (v: { cookies: string[]; loc: string } | null) => void = () => {};
      if (code) { const pr = new Promise<{ cookies: string[]; loc: string } | null>(r => { settle = r; }); cbResults.set(code, { state: st, at: Date.now(), p: pr }); for (const [k, v] of cbResults) if (Date.now() - v.at > 120_000) cbResults.delete(k); }
      const done = (loc: string) => { const c = res.getHeader("set-cookie"); settle({ cookies: Array.isArray(c) ? c.map(String) : c ? [String(c)] : [], loc }); redirect(res, loc); };
      try {
      // a stale or reused sign-in (slow, second tab, reload): start again by itself. GitHub remembers the approval, so
      // this is invisible; only a second failure in a row shows a page
      const retry = () => { ctx.track?.(req, "fail", "stale or reused sign-in (auto-retried)"); if (cookies(req).cal_retry) return false; setCookie(res, "cal_retry", "1", 120); settle(null); redirect(res, "/auth/github"); return true; };
      if ((!url.searchParams.get("state") || url.searchParams.get("state") !== cookies(req).cal_oauth) && retry()) return true;
      if (!url.searchParams.get("state") || url.searchParams.get("state") !== cookies(req).cal_oauth) { page(res, 400, "One more click", `<h1>That sign-in took a little too long</h1><p>For your safety, a GitHub sign-in has to finish within 10 minutes in the same browser. Start again and it takes a few seconds.</p><p><a rel="nofollow" class="btn" href="/auth/github">Continue with GitHub</a></p>`); return true; }
      setCookie(res, "cal_oauth", "", 0);
      try {
        const tok = await exchange({ code: url.searchParams.get("code") || "", redirect_uri: pub + "/auth/github/callback" }, signin() || a);
        const me = await gh(tok.access, "/user") as any;
        let acct = q("SELECT * FROM gh_accounts WHERE gh_id=?").get(me.id) as any;
        const wantH = String(cookies(req).cal_h || "").toLowerCase(); setCookie(res, "cal_h", "", 0);
        const backTo = safeBack(cookies(req).cal_back); if (backTo) setCookie(res, "cal_back", "", 0);
        // an existing profile that lists this GitHub account (made in Obsidian): sign in as its owner, never make another
        // a GitHub sign-up page whose GitHub account is also linked to an Obsidian page: the same person, so it folds into it
        const linkedElsewhere = !!acct && !acct.claimed && !wantH && !!linkedProfile(me.id, me.login);
        if (!acct || acct.claimed || (wantH && wantH !== acct.handle) || linkedElsewhere) {
          // an existing link, or a first link with proof; never on a bare claim (anyone can put your GitHub on their page)
          let pr = linkedProfile(me.id, me.login);
          if (!pr) { const cands = claimants(me.login).filter(x => !wantH || x.handle === wantH), proven = cands.filter(x => provenOwner(req, x, me));
            if (proven.length === 1) pr = proven[0];
            else if (cands.length) { ctx.track?.(req, "fail", "GitHub link needs proof");
              page(res, 403, "Link your GitHub", `<h1>One step to link your GitHub</h1><p>To keep GitHub accounts safe, Caldera links a GitHub account to a page only with proof that both are yours. Either:</p><ul><li>Open your page as its owner first: in Obsidian run <b>Caldera: Open my public page (as owner)</b>, then sign in with GitHub again, or</li><li>Put your Caldera page (<code>caldera.social/@your-handle</code>) in your GitHub profile's website or bio, then sign in with GitHub again.</li></ul><p><a rel="nofollow" class="btn" href="/auth/github">Sign in with GitHub</a></p>`); return true; } }
          if (pr && ctx.owner && (!wantH || wantH === pr.handle)) {
            q("INSERT OR REPLACE INTO gh_links VALUES (?,?,?,?)").run(me.id, me.login, pr.id, new Date().toISOString());
            // this GitHub account also has its own page here (signed up with GitHub before the vault): one person, one
            // profile. The GitHub page merges into the proven one; its handle redirects there, GitHub signs in there
            if (acct && !acct.claimed && acct.profile_id !== pr.id && ctx.merge) {
              try { ctx.merge(acct.profile_id, pr.id, `GitHub @${me.login} (${me.id}) linked to @${pr.handle}`); ctx.track?.(req, "signin", "merged GitHub page"); }
              catch (e: any) { console.error("github merge", me.login, "->", pr.handle, e?.message); }
            }
            ctx.track?.(req, "signin", "linked page"); addCookie(res, ctx.owner.start(pr.id)); ctx.social?.circle?.signedIn(pr.id); await captureEmail(pr.id, tok.access, me); done(backTo || `/@${pr.handle}/`); return true;
          }
          if (wantH) { page(res, 403, "Not this page", `<h1>That GitHub account isn't the one on this page</h1><p class="mut">You signed in as <b>${esc(me.login)}</b>, but @${esc(wantH)} doesn't list that GitHub account. Add <code>GitHub | https://github.com/${esc(me.login)}</code> to the page's links (in Obsidian: Caldera/profile.md), or sign in another way.</p><p><a class="btn" href="/signin?h=${encodeURIComponent(wantH)}">Other ways to sign in</a></p>`); return true; }
        }
        if (acct && acct.claimed) { page(res, 200, "Moved to Obsidian", `<h1>This profile now lives in your vault</h1><p>Edit it from Caldera in Obsidian. <a href="${esc(pub)}/@${esc(acct.handle)}/">Your page</a></p>`); return true; }
        if (acct) {
          q("UPDATE gh_accounts SET token_sealed=?, login=? WHERE gh_id=?").run(ctx.seal(JSON.stringify(tok)), me.login, me.id);
          ctx.track?.(req, "signin"); startSession(res, me.id); ctx.social?.circle?.signedIn(acct.profile_id); await captureEmail(acct.profile_id, tok.access, me); done(backTo || "/me"); return true;
        }
        // new account: only a brand-new, completely empty GitHub account is held back (bots); new developers are welcome
        // a brand-new, completely empty GitHub account (how bots look) still gets its page, just not listed in People or
        // the world until it has a public repo, a follower or a few days behind it (the refresh lists it then)
        // one person, one profile: a GitHub account whose verified address already belongs to a member (their email page,
        // or an Obsidian page with that confirmed address) signs in to that page instead of making a second one
        if (ctx.memberByEmail && ctx.owner) {
          const mine = (await verifiedEmails(tok.access)).map(x => ctx.memberByEmail!(x)).find(Boolean);
          if (mine) {
            ctx.track?.(req, "signin", "matched verified email"); addCookie(res, ctx.owner.start(mine.id)); await captureEmail(mine.id, tok.access, me);
            done(backTo || `/@${mine.handle}/`); return true;
          }
        }
        const held = !(ctx.accountOk ? ctx.accountOk(me) : true);
        if (!ctx.allowNewProfile(req)) { ctx.track?.(req, "fail", "rate limited (many sign-ups from one network)"); page(res, 429, "One moment", `<h1>Lots of people are joining from your network right now</h1><p>Give it a minute, then <a rel="nofollow" class="btn" href="/auth/github">try again</a>.</p>`); return true; }
        const id = C.newIdentity(), handle = handleFor(me.login), ck = cookies(req), grp0 = groupsFrom(ck.cal_grp);
        const edits0: any = grp0.length ? { groups: grp0 } : {};
        if (held) { edits0.listed = false; edits0.heldNew = true; }
        if (typeof me.email === "string" && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(me.email)) edits0.ghEmail = me.email.slice(0, 200);   // public GitHub email: only a suggestion for the summary-email field
        q(`INSERT INTO gh_accounts (gh_id, login, profile_id, handle, key_sealed, token_sealed, edits, cache, created) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(me.id, me.login, id.id, handle, ctx.seal(JSON.stringify(id)), ctx.seal(JSON.stringify(tok)), JSON.stringify(edits0), "{}", new Date().toISOString());
        acct = q("SELECT * FROM gh_accounts WHERE gh_id=?").get(me.id);
        startSession(res, me.id); const signupEmail = await captureEmail(id.id, tok.access, me);
        // daily email only when the box was ticked: a GitHub-verified address is on at once, a public one gets a confirmation link
        if (signupEmail && ck.cal_dig === "1" && ctx.social?.email?.subscribe) try { await ctx.social.email.subscribe(id.id, signupEmail); } catch (e: any) { console.error("signup digest", e.message); }
        setCookie(res, "cal_dig", "", 0);
        if (ck.cal_inv) setCookie(res, "cal_inv", "", 0);
        if (ck.cal_grp) setCookie(res, "cal_grp", "", 0);
        // the first build reads the whole GitHub account (slow): send them to /me now, build in the background
        const acct0 = acct, inv = ck.cal_inv;
        void queuedBuild(acct0).catch((e: any) => console.error("github first build", e.message)).finally(() => {
          // joined from a friend's invite: thank the inviter, and the new member follows them
          const inviter = inv ? ctx.social?.recordReferral(id.id, inv, "github") : null;
          if (inviter) try { ctx.accept(C.sign(id, "friend.request", { to: inviter, note: "I joined Caldera from your invite." })); } catch { /* best effort */ }
        });
        ctx.track?.(req, "created", held ? "held (brand-new GitHub)" : ""); done("/me?welcome=1" + (backTo ? "&back=" + encodeURIComponent(backTo) : "")); return true;
      } catch (e: any) {
        settle(null);
        // a used or expired one-time code (a reload, a retried request, a restart mid-sign-in): one more click fixes it,
        // and if the account was already created the retry simply signs them in
        if (/incorrect or expired|bad_verification_code/i.test(String(e.message)) && retry()) return true;
        if (/incorrect or expired|bad_verification_code/i.test(String(e.message))) { page(res, 400, "One more click", `<h1>That GitHub sign-in link was already used</h1><p>No problem: this happens when a page reloads mid-sign-in. Continue and you'll land on your page.</p><p><a rel="nofollow" class="btn" href="/auth/github">Continue with GitHub</a></p>`); return true; }
        console.error("github callback", String(e?.message || e)); ctx.track?.(req, "fail", "error: " + String(e?.message || e).slice(0, 60));
        page(res, 502, "GitHub", `<h1>GitHub sign-in didn't work</h1><p class="mut">${esc(e.message)}</p><p><a rel="nofollow" class="btn" href="/auth/github">Try again</a></p>`); return true;
      }
      } finally { settle(null); }   // every other outcome (errors, refusals) settles too, so a duplicate never waits
    }
    if (req.method === "GET" && p === "/auth/github/installed") {   // after installing the app on private repos
      const acct = account(req); if (!acct) { redirect(res, "/auth/github"); return true; }
      const inst = url.searchParams.get("installation_id");
      if (inst && /^\d+$/.test(inst)) {
        try { const tok = await tokenFor(acct), r = await gh(tok, "/user/installations") as any;   // only an installation this user can see
          if ((r.installations || []).some((i: any) => String(i.id) === inst)) q("UPDATE gh_accounts SET installation=? WHERE gh_id=?").run(inst, acct.gh_id); } catch { /* ignore */ }
        try { await queuedBuild(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id)); } catch { /* next refresh */ }
      }
      redirect(res, "/me"); return true;
    }
    if (req.method === "POST" && p === "/me/upload") {
      const ownU = ctx.owner?.of(req), acct = account(req) || (ownU ? q("SELECT * FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(ownU) as any : null);
      if (!acct || acct.claimed) { ctx.json(res, 401, { error: "Sign in first." }); return true; }
      const origin = String(req.headers.origin || ""); if (origin && origin !== pub && !(origin === "null" && req.headers["sec-fetch-site"] === "same-origin")) { ctx.json(res, 403, { error: "wrong origin" }); return true; }
      const b = await ctx.readBody(req).catch(() => null) as any, kind = b?.kind === "banner" ? "banner" : b?.kind === "photo" ? "photo" : null;
      if (!kind || typeof b.data !== "string") { ctx.json(res, 400, { error: "Choose an image." }); return true; }
      const img = cleanImage(Buffer.from(b.data, "base64")); if (!img.ok) { ctx.json(res, 400, { error: img.error }); return true; }
      const dir = upDir(acct.gh_id); fs.mkdirSync(dir, { recursive: true });
      for (const ext of ["jpg", "png", "webp"]) fs.rmSync(path.join(dir, `${kind}.${ext}`), { force: true });
      fs.writeFileSync(path.join(dir, `${kind}.${img.ext}`), img.data);
      try { await queuedBuild(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id)); } catch (e: any) { ctx.json(res, 502, { error: "Saved, but republishing failed: " + e.message }); return true; }
      ctx.json(res, 200, { ok: true }); return true;
    }
    if (p === "/me" && req.method === "GET") { redirect(res, "/settings" + url.search); return true; }   // the account page moved to /settings
    // who is this? a GitHub sign-up (session or owner cookie) -> hosted; anyone else signed in as an owner -> their vault page
    const settingsOwner = (): { acct?: any; vault?: any } | null => {
      const ownId = ctx.owner?.of(req), ga = account(req);
      const acct = (ga && !ga.claimed ? ga : null) || (ownId ? q("SELECT * FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(ownId) as any : null);
      if (acct) return { acct };
      const vOwner = ownId || (ga?.claimed ? ga.profile_id : null);   // a GitHub sign-up that moved into Obsidian keeps its way in
      const vault = vOwner ? q("SELECT * FROM profiles WHERE id=?").get(vOwner) as any : null;
      return vault?.handle ? { vault } : null;
    };
    const sameOrigin = () => { const o = String(req.headers.origin || ""); return !o || o === pub || (o === "null" && req.headers["sec-fetch-site"] === "same-origin"); };
    if (p === "/settings/status" && req.method === "GET") {   // the Connections panel polls this while you connect Obsidian
      const who = settingsOwner(); if (!who) { ctx.json(res, 401, { error: "sign in" }); return true; }
      const id = who.acct ? who.acct.profile_id : who.vault.id;
      ctx.json(res, 200, { conn: ctx.social?.connections?.(id) || null }); return true;
    }
    if (p === "/settings/claim" && req.method === "POST") {   // Connect Obsidian: a one-time code, right in the page
      const who = settingsOwner(); if (!who?.acct) { ctx.json(res, 400, { error: "Only GitHub sign-ups move into Obsidian with a code." }); return true; }
      if (!sameOrigin()) { ctx.json(res, 403, { error: "wrong origin" }); return true; }
      const code = "CAL-" + crypto.randomBytes(9).toString("base64url"), expires = Date.now() + 30 * 60_000;
      q("UPDATE gh_accounts SET claim_code=?, claim_expires=? WHERE gh_id=?").run(code, expires, who.acct.gh_id);
      ctx.json(res, 200, { code, expires }); return true;
    }
    if (p === "/alerts" && req.method === "GET") {
      const who = settingsOwner(); if (!who) { redirect(res, "/signin?back=%2Falerts"); return true; }
      const id = who.acct ? who.acct.profile_id : who.vault.id;
      page(res, 200, "Alerts", `<h1>Alerts</h1><p class="mut">News and tips from Caldera. <a href="/settings">Settings</a></p>${alertsList(id, "pg")}`, ctx.owner?.bar?.(id) || ""); return true;
    }
    if (p === "/me" || p === "/settings") {
      const who = settingsOwner();
      if (!who) { redirect(res, p === "/settings" ? "/signin?back=%2Fsettings" : "/signin"); return true; }
      if (who.vault) {
        const vpr = who.vault, me = vpr.id as string;
        if (req.method === "GET") { vaultPage(res, vpr, url.searchParams.get("connected") === "obsidian" ? "<b>Obsidian is connected.</b> Your vault publishes this page now." : ""); return true; }
        if (req.method !== "POST") { redirect(res, "/settings"); return true; }
        if (!sameOrigin()) { page(res, 403, "No", "<h1>Wrong origin</h1>"); return true; }
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const f = new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 20_000)), act = f.get("do");
        if (act === "logout") { redirect(res, "/signout"); return true; }
        let pre = "";
        if ((act === "accept" || act === "add") && ctx.social?.friendAct) {   // Obsidian keys never leave the vault: queued, sent on the next sync
          const to = String(f.get("to") || ""), h = (q("SELECT handle FROM profiles WHERE id=?").get(to) as any)?.handle;
          const r = ctx.social.friendAct(me, to);
          pre = r.status === 200 ? (r.body.state === "queued" ? `Queued. Your request to @${esc(h)} sends from Obsidian the next time it's open.` : `Done: @${esc(h)}.`) : `Couldn't do that: ${esc(r.body?.error || "error")}`;
        }
        if (act === "email" && ctx.social?.email) { const em = (f.get("email") || "").trim().slice(0, 200); try { pre = esc(await ctx.social.email.subscribe(me, em)); } catch (e: any) { pre = esc(e.message); } }
        if (act === "email-off" && ctx.social?.email) { ctx.social.email.unsubscribe(me); pre = "Daily summary emails are off."; }
        if (act === "email-capture" && ctx.social?.email) {
          const em = (f.get("email") || "").trim().slice(0, 200);
          if (f.get("on")) { try { pre = esc(await ctx.social.email.subscribe(me, em)); } catch (e: any) { pre = esc(e.message); } }
          else { ctx.social.email.dismissPrompt?.(me); pre = "No daily summary. You can turn it on any time under Notifications."; }
        }
        if (act === "email-dismiss" && ctx.social?.email) { ctx.social.email.dismissPrompt?.(me); pre = "No problem. You can turn on the daily summary any time under Notifications."; }
        if (act === "private-repos" && ctx.privateMode) pre = ctx.privateMode.set(me, f.get("mode")) ? "Saved. Your public city follows it right away (your private view still shows everything)." : "Pick one of the three options.";
        if (act === "search" && ctx.searchPref) { ctx.searchPref.set(me, !!f.get("on")); pre = f.get("on") ? "Saved. Search engines and AI assistants can find your page." : "Saved. Your page asks search engines not to index it."; }
        vaultPage(res, q("SELECT * FROM profiles WHERE id=?").get(me), pre); return true;
      }
      const acct = who.acct;
      // just claimed: the city is the "aha", not a long settings page. Land there (or back where they came from) once it's built.
      if (req.method === "GET" && url.searchParams.get("welcome") && q("SELECT 1 FROM profiles WHERE id=?").get(acct.profile_id)) {
        const back = safeBack(url.searchParams.get("back")); // no public repos yet means no city: land on their page instead of a 404
        const hasCity = fs.existsSync(path.join(ctx.dataDir, "profiles", acct.handle, "city.html"));
        redirect(res, back || `/@${acct.handle}/${hasCity ? "city.html" : ""}?welcome=1`); return true; }
      if (req.method === "GET") { const j = groupsFrom(url.searchParams.get("joined"))[0];
        mePage(res, acct, url.searchParams.get("uploaded") ? `Your ${url.searchParams.get("uploaded") === "banner" ? "masthead" : "photo"} is up and your page is republished.` : url.searchParams.get("welcome") ? `<b>Welcome to Caldera.</b> Your page is live. Share it below, add a few friends, or move it into Obsidian later. Private repos you connect show by name on your city (never the code); change that under Private repos.${safeBack(url.searchParams.get("back")) ? ` <a href="${esc(safeBack(url.searchParams.get("back")))}">Continue where you were &rarr;</a>` : ""} <span class="mut" style="font-size:12.5px">By using Caldera you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span>` : j ? `You joined <a href="/g/${esc(j)}">${esc(j)}</a>.` : "", await peopleOf(acct), url.searchParams.get("welcome") ? safeBack(url.searchParams.get("back")) : ""); return true; }
      if (req.method === "POST") {
        const origin = String(req.headers.origin || ""); if (origin && origin !== pub && !(origin === "null" && req.headers["sec-fetch-site"] === "same-origin")) { page(res, 403, "No", "<h1>Wrong origin</h1>"); return true; }
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const f = new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 20_000));
        const act = f.get("do");
        if (act === "logout") { redirect(res, "/signout"); return true; }
        if (act === "delete" && f.get("sure")) {
          // revoke Caldera's access on GitHub, with whichever app issued their sign-in (the sign-in app, or the older GitHub App)
          try { const t = JSON.parse(ctx.unseal(acct.token_sealed)).access; for (const who of [signin(), app()]) { if (!who || !t) continue;
            const r = await F(`https://api.github.com/applications/${who.client_id}/grant`, { method: "DELETE", headers: { authorization: "Basic " + Buffer.from(who.client_id + ":" + who.client_secret).toString("base64"), accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "caldera-hub" }, body: JSON.stringify({ access_token: t }) });
            if (r.status === 204) break; } } catch { /* revoke is best effort */ }
          ctx.erase(acct.profile_id); fs.rmSync(upDir(acct.gh_id), { recursive: true, force: true }); q("DELETE FROM gh_sessions WHERE gh_id=?").run(acct.gh_id); q("DELETE FROM gh_accounts WHERE gh_id=?").run(acct.gh_id);
          setCookie(res, "cal_s", "", 0); page(res, 200, "Deleted", "<h1>Your Caldera profile is deleted</h1><p>Your page, city and data are gone, and Caldera's access to your GitHub account is revoked.</p>"); return true;
        }
        if (act === "save") {
          const prev = JSON.parse(acct.edits || "{}");
          const edits = { ...prev, name: (f.get("name") || "").slice(0, 80), headline: (f.get("headline") || "").slice(0, 160), summary: (f.get("summary") || "").slice(0, 1200), links: (f.get("links") || "").slice(0, 2000), groups: groupsFrom(f.get("groups")) };
          q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify(edits), acct.gh_id);
        }
        let listingNote = "";
        if (act === "listings") {
          const prev = JSON.parse(acct.edits || "{}"), l = listingsFromForm(f as any);
          q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify({ ...prev, apps: l.apps, websites: l.websites, hideStorefronts: l.hideStorefronts }), acct.gh_id);
          if (l.bad.length) listingNote = ` Not added (not an App Store, Google Play or website link): ${esc(l.bad[0].slice(0, 80))}`;
        }
        if (act === "private-repos" && ctx.privateMode) ctx.privateMode.set(acct.profile_id, f.get("mode"));
        if (act === "search" && ctx.searchPref) ctx.searchPref.set(acct.profile_id, !!f.get("on"));
        if (act === "privacy") { const prev = JSON.parse(acct.edits || "{}"); q("UPDATE gh_accounts SET edits=? WHERE gh_id=?").run(JSON.stringify({ ...prev, listed: f.get("listed") === "on", autoConnectRepos: f.get("autoConnectRepos") === "on" }), acct.gh_id); }
        if (act === "remove-banner") { for (const ext of ["jpg", "png", "webp"]) fs.rmSync(path.join(upDir(acct.gh_id), `banner.${ext}`), { force: true }); }
        let claimCode = "";
        if (act === "claim") { claimCode = "CAL-" + crypto.randomBytes(9).toString("base64url"); q("UPDATE gh_accounts SET claim_code=?, claim_expires=? WHERE gh_id=?").run(claimCode, Date.now() + 30 * 60_000, acct.gh_id); }
        let pre = "";
        if (act === "accept" || act === "add") {   // friends, signed with the hosted profile's key
          const id = JSON.parse(ctx.unseal(acct.key_sealed)) as C.Identity, to = String(f.get("to") || "");
          const r = act === "accept" ? ctx.accept(C.sign(id, "friend.accept", { request: String(f.get("req") || ""), to }))
            : /^cal:[1-9A-HJ-NP-Za-km-z]+$/.test(to) && q("SELECT 1 FROM profiles WHERE id=?").get(to) ? ctx.accept(C.sign(id, "friend.request", { to, note: "" })) : { status: 404, body: { error: "unknown profile" } };
          const h = (q("SELECT handle FROM profiles WHERE id=?").get(to) as any)?.handle;
          pre = r.status === 200 ? (act === "accept" ? `You and @${esc(h)} follow each other: you're friends now.` : `You follow @${esc(h)}. If they follow you back, you're friends.`) : `Couldn't do that: ${esc(r.body?.error || "error")}`;
        }
        if (act === "email" && ctx.social?.email) { const em = (f.get("email") || "").trim().slice(0, 200); try { pre = esc(await ctx.social.email.subscribe(acct.profile_id, em)); } catch (e: any) { pre = esc(e.message); } }
        if (act === "gh-invite" && ctx.social?.circle) { try { pre = esc(await ctx.social.circle.invite(acct.profile_id, String(f.get("login") || ""))); } catch (e: any) { pre = esc(e.message); } }
        if (act === "email-off" && ctx.social?.email) { ctx.social.email.unsubscribe(acct.profile_id); pre = "Daily summary emails are off."; }
        if (act === "email-capture" && ctx.social?.email) {   // the welcome card: ticked = subscribe (a GitHub-verified address needs no confirmation)
          const em = (f.get("email") || "").trim().slice(0, 200);
          if (f.get("on")) { try { pre = esc(await ctx.social.email.subscribe(acct.profile_id, em)); } catch (e: any) { pre = esc(e.message); } }
          else { ctx.social.email.dismissPrompt?.(acct.profile_id); pre = "No daily summary. You can turn it on any time under Notifications."; }
        }
        if (act === "email-dismiss" && ctx.social?.email) { ctx.social.email.dismissPrompt?.(acct.profile_id); pre = "No problem. You can turn on the daily summary any time under Notifications."; }
        let note = pre || (act === "claim" ? `Here's your code: <code>${esc(claimCode)}</code>. Paste it into Caldera in Obsidian (Settings &gt; Import a GitHub sign-up). It works once, for 30 minutes.` : "");
        if (act === "save" || act === "refresh" || act === "remove-banner" || act === "privacy" || act === "private-repos" || act === "listings") { try { await queuedBuild(q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id)); note = "Republished." + listingNote; } catch (e: any) { note = "Couldn't republish: " + esc(e.message); } }
        mePage(res, q("SELECT * FROM gh_accounts WHERE gh_id=?").get(acct.gh_id), note, await peopleOf(acct)); return true;
      }
    }
    // Obsidian claims a hosted profile: one-time code -> the profile's key, once; the hub deletes its copy
    if (req.method === "POST" && p === "/v1/github/claim") {
      const { code } = await ctx.readBody(req) as { code?: string };
      const acct = typeof code === "string" && code.startsWith("CAL-") ? q("SELECT * FROM gh_accounts WHERE claim_code=? AND claim_expires > ? AND claimed IS NULL").get(code.trim(), Date.now()) as any : null;
      if (!acct) { ctx.json(res, 404, { error: "unknown or expired code" }); return true; }
      const identity = JSON.parse(ctx.unseal(acct.key_sealed)), edits = JSON.parse(acct.edits || "{}");
      q("UPDATE gh_accounts SET claimed=?, key_sealed='', claim_code=NULL, token_sealed='' WHERE gh_id=?").run(new Date().toISOString(), acct.gh_id);
      // the name and headline the page shows now (GitHub's, or what they typed), so the vault starts from the same page
      const live = q("SELECT name, headline FROM profiles WHERE id=?").get(acct.profile_id) as any;
      ctx.json(res, 200, { identity, handle: acct.handle, name: edits.name || live?.name || acct.login, headline: edits.headline || live?.headline || "", github: acct.login }); return true;
    }
    return false;
  }

  /** Operator-only routes on the private (Tailscale) address: create the GitHub App with GitHub's manifest flow. */
  async function privateRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/setup/github" && req.method === "GET") {
      const a = app();
      if (a) { page(res, 200, "GitHub app", `<h1>GitHub sign-up is set up</h1><p>App: <a href="${esc(a.html_url || "")}">${esc(a.slug)}</a>. <a rel="nofollow" class="btn" href="${esc(pub)}/auth/github">Try signing in</a></p>`); return true; }
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
      page(res, 200, "Done", `<h1>GitHub sign-up is live</h1><p>App <a href="${esc(j.html_url)}">${esc(j.slug)}</a> created. <a rel="nofollow" class="btn" href="${esc(pub)}/auth/github">Try it: sign in with GitHub</a></p>`); return true;
    }
    return false;
  }
  /** Sign this browser out of its GitHub session (used by /signout). */
  const signOut = (req: http.IncomingMessage, res: http.ServerResponse) => { const t = cookies(req).cal_s; if (t) q("DELETE FROM gh_sessions WHERE token=?").run(hashTok(t)); setCookie(res, "cal_s", "", 0); };
  /** Any hosted member's GitHub token, for reading PUBLIC repo data (contributors) in background jobs; null if none works. */
  async function anyToken(): Promise<string | null> {
    if (!app()) return null;
    for (const acct of q("SELECT * FROM gh_accounts WHERE claimed IS NULL AND token_sealed<>'' ORDER BY refreshed DESC LIMIT 5").all() as any[]) {
      try { return await tokenFor(acct); } catch { /* expired: try the next one */ }
    }
    return null;
  }
  /** a hosted member's own GitHub token (their own rate budget), or null for profiles whose key we don't hold */
  async function tokenOf(profileId: string): Promise<string | null> {
    const acct = q("SELECT * FROM gh_accounts WHERE profile_id=? AND claimed IS NULL AND token_sealed<>''").get(profileId) as any;
    if (!acct) return null; try { return await tokenFor(acct); } catch { return null; }
  }
  return { route, privateRoute, build, freshen, account, ghLoginsOf, signOut, anyToken, tokenOf, appPrivateRepos, configured: () => !!app() };
}
