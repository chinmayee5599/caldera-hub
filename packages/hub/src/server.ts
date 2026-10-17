/**
 * Caldera Hub - reference hub for the Caldera protocol (spec/PROTOCOL.md).
 * Stores and indexes signed envelopes, hosts profile pages, delivers encrypted cards,
 * enforces the gravity and credit rules, and serves discovery and leaderboards.
 * Zero framework: node:http + node:sqlite (Node 22+).
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { github } from "./github";
import { cityArt, cardSvg, toPng, groupPage, ogTags } from "./cards";
import { emailer, type Mail } from "./email";

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export interface HubOptions { dataDir: string; port?: number; publicUrl?: string; siteDir?: string; trustProxy?: boolean;
  /** Private owner address (e.g. behind `tailscale serve`): a second listener on 127.0.0.1:privatePort that serves the
   *  owner's private view only when the proxy-set Tailscale-User-Login header maps to that profile's handle. */
  privatePort?: number; privateUrl?: string; tailnetOwners?: Record<string, string>; githubFetch?: typeof fetch; onEvent?: (e: { type: "signup" | "delete"; handle?: string; name?: string; total: number }) => void; limits?: { perMinute?: number; writesPerMinute?: number; newProfilesPerDay?: number };
  /** daily summary emails: Resend key (production) or a send hook (tests); schedule starts the daily job */
  email?: { resendKey?: string; send?: (m: Mail) => Promise<void>; schedule?: boolean }; }

const MAX_BODY = 12 * 1024 * 1024;
const RESERVED = new Set(["admin", "api", "www", "caldera", "help", "support", "root", "hub", "v1", "about", "login", "settings", "official", "team", "security", "obsidian", "me", "auth", "setup"]);
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY" };
// User-uploaded profile pages run in a sandbox: unique origin, no access to the hub's origin, no forms, no top navigation.
const PROFILE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// The city page may also poll the hub for live traffic on the owner's sites (same hub only).
const cityCsp = (...origins: string[]) => PROFILE_CSP + `; connect-src 'self' ${origins.filter(Boolean).join(" ")}`.trimEnd();
const originOf = (u?: string) => { try { return u ? new URL(u).origin : ""; } catch { return ""; } };
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// Live-traffic snippet for the owner's own sites: <script async src="https://caldera.social/t.js" data-site="KEY"></script>
// Counts page views (and single-page navigations); caldera("signup") / caldera("buy") mark conversions. No cookies.
const TRACK_JS = `(function(){var s=document.currentScript;if(!s)return;var k=s.getAttribute('data-site');if(!k)return;var base=s.src.replace(/\\/t\\.js.*$/,'');
function send(kind){var u=base+'/v1/t/'+encodeURIComponent(k)+'.gif?k='+(kind||'view')+'&r='+Math.random().toString(36).slice(2);try{if(navigator.sendBeacon&&navigator.sendBeacon(u))return}catch(e){}var i=new Image();i.src=u}
window.caldera=function(kind){send(kind==='signup'||kind==='buy'?kind:'view')};send('view');var last=location.pathname;
function nav(){if(location.pathname!==last){last=location.pathname;send('view')}}var ps=history.pushState;history.pushState=function(){var r=ps.apply(this,arguments);nav();return r};addEventListener('popstate',nav)})();`;
const DAY = 86_400_000;

/** Platform bar injected at the top of every hosted profile: logo back to the hub + a sign-up call to action.
 *  Inline styles/SVG only (the profile CSP allows inline styles and blocks external resources). */
function calderaBar(hub: string, handle: string): string {
  const base = hub.replace(/\/$/, ""), join = `${base}/?invite=${encodeURIComponent(handle)}`;
  const logo = `<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" style="display:block"><path d="M3 26 L11 10 L14 15 L17 8 L29 26 Z" fill="#8B6CF6"/><path d="M11 10 L14 15 L17 8" fill="none" stroke="#F2F2F5" stroke-width="1.2"/><circle cx="16" cy="21" r="2.4" fill="#4FB89A"/></svg>`;
  return `<div id="caldera-bar" style="position:relative;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px;background:#111113;border-bottom:1px solid #2A2A2E;font:500 13.5px/1.2 'IBM Plex Sans','Helvetica Neue',Arial,sans-serif">`
    + `<a href="${join}" style="display:inline-flex;align-items:center;gap:8px;color:#F2F2F5;text-decoration:none;font:600 15px 'Source Serif 4',Georgia,serif">${logo}Caldera<span style="font:400 12.5px 'IBM Plex Sans',Arial,sans-serif;color:#8A8A93;margin-left:4px" class="cb-tag">the social layer for Obsidian</span></a>`
    + `<a href="${join}#install" style="display:inline-flex;align-items:center;min-height:30px;padding:0 14px;border-radius:999px;background:#8B6CF6;color:#fff;text-decoration:none;font-weight:600;white-space:nowrap">Get your own page</a>`
    + `</div><style>@media (max-width:520px){#caldera-bar .cb-tag{display:none}}</style>`;
}

/** Heatmap fix for profiles built before plugin 0.5.1 (their profile.css is frozen in the bundle): cells fill the column,
 *  room for the hover zoom, no stray scrollbar. Same rules as profile.css "Heatmap sizing (2026-10-12)". */
const HEAT_FIX = `<style>/* Heatmap sizing (2026-10-12) */.heat-box{container-type:inline-size}.heat-frame{--gap:3px;--cell:clamp(8px,calc((100cqw - 46px - 25 * var(--gap)) / 26),18px)}@container (max-width:460px){.heat-frame{--gap:2px}}.heat,.heat-days{gap:var(--gap,3px)}.heat-days{grid-template-rows:repeat(7,var(--cell,12px));line-height:var(--cell,12px)}.heat-wrap{overflow-x:auto;overflow-y:hidden;padding:4px;margin:-4px;scrollbar-width:none}.heat-wrap::-webkit-scrollbar{display:none}.heat{grid-template-rows:repeat(7,var(--cell,12px));grid-auto-columns:var(--cell,12px)}.heat i{width:var(--cell,12px);height:var(--cell,12px);border-radius:3px}.heat i[data-d]:hover,.heat i.is-sel{transform:scale(1.18)}</style>`;

/** caldera.social/gardens: the stream that serves the gardens - notes recently planted or tended, across every listed profile. */
function gardensPage(notes: { handle: string; name: string; slug: string; title: string; stage: string; updated: string; excerpt: string; words: number }[], hub: string): string {
  const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const icon: Record<string, string> = { seedling: "&#127793;", budding: "&#127807;", evergreen: "&#127795;" };
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const gardens = new Set(notes.map(n => n.handle)).size;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recently tended - Caldera gardens</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>:root{--bg:#111113;--raised:#18181B;--line:#2A2A2F;--text:#E6E6EA;--muted:#8A8A93;--strong:#F7F7FA;--accent:#8B6CF6;--accent-text:#B9A6FF}
@media (prefers-color-scheme: light){:root{--bg:#FAFAF7;--raised:#FFF;--line:#E4E4DF;--text:#26262B;--muted:#6B6B73;--strong:#111;--accent:#6E4FE0;--accent-text:#5A3CD0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 'IBM Plex Sans',system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}a{color:var(--accent-text);text-decoration:none}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px}.top a.home{color:var(--strong);font:600 17px 'Source Serif 4',Georgia,serif}
h1{font:600 2rem/1.15 'Source Serif 4',Georgia,serif;color:var(--strong);margin:0 0 8px}p.lede{color:var(--muted);margin:0 0 24px}
.card{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--raised);margin-bottom:10px;color:var(--text)}
.card:hover{border-color:var(--accent)}.t{font:600 1.08rem 'Source Serif 4',Georgia,serif;color:var(--strong)}.x{color:var(--muted);font-size:14px;margin:4px 0 6px}
.m{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--muted)}.who{color:var(--accent-text)}.st{text-transform:capitalize}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:24px;text-align:center}</style></head><body><main>
<div class="top"><a class="home" href="${e(hub)}/">Caldera</a><a href="${e(hub)}/people">People</a></div>
<h1>Recently tended</h1>
<p class="lede">Notes planted or updated in public gardens on Caldera${notes.length ? ` - ${notes.length} notes from ${gardens} garden${gardens === 1 ? "" : "s"}` : ""}. A garden is a set of notes grown in the open: seedlings are rough, evergreens are worked through.</p>
${notes.length ? notes.map(n => `<a class="card" href="/@${e(n.handle)}/n/${e(n.slug)}.html"><div class="t">${e(n.title)}</div>${n.excerpt ? `<div class="x">${e(n.excerpt)}</div>` : ""}<div class="m"><span class="who">@${e(n.handle)}</span><span class="st">${icon[n.stage] || ""} ${e(n.stage)}</span><span>Tended ${day(n.updated)}</span><span>${Number(n.words).toLocaleString("en-US")} words</span></div></a>`).join("\n")
    : `<div class="empty">No public gardens yet. Plant a note: put it in your vault's Garden folder.</div>`}
</main></body></html>`;
}

export function createHub(opts: HubOptions) {
  fs.mkdirSync(path.join(opts.dataDir, "profiles"), { recursive: true });
  const db = new DatabaseSync(path.join(opts.dataDir, "hub.sqlite"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS envelopes (hash TEXT PRIMARY KEY, type TEXT, sender TEXT, recipient TEXT, ts TEXT, json TEXT);
    CREATE INDEX IF NOT EXISTS env_to ON envelopes(recipient, ts);
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, handle TEXT UNIQUE, box_key TEXT, name TEXT, headline TEXT,
      manifest TEXT, updated TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS friends (a TEXT, b TEXT, ts TEXT, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS gravity (sender TEXT, recipient TEXT, ts TEXT, reason TEXT, ask TEXT);
    CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, author TEXT, title TEXT, detail TEXT, bounty INTEGER, tags TEXT,
      visibility TEXT, status TEXT, ts TEXT, awarded_to TEXT);
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, author TEXT, title TEXT, detail TEXT, tags TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS ledger (who TEXT, delta INTEGER, reason TEXT, ref TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT, nonce TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, id TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS moderation (handle TEXT PRIMARY KEY, id TEXT, action TEXT, reason TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS garden_notes (owner TEXT, handle TEXT, slug TEXT, title TEXT, stage TEXT, license TEXT, updated TEXT, excerpt TEXT,
      words INTEGER, sha256 TEXT, PRIMARY KEY (owner, slug));
    CREATE INDEX IF NOT EXISTS garden_recent ON garden_notes(updated);
    CREATE TABLE IF NOT EXISTS garden_links (owner TEXT, src_handle TEXT, src_slug TEXT, src_title TEXT, dst_handle TEXT, dst_slug TEXT);
    CREATE INDEX IF NOT EXISTS garden_dst ON garden_links(dst_handle, dst_slug);
    CREATE TABLE IF NOT EXISTS page_views (handle TEXT, path TEXT, ts TEXT, visitor TEXT);
    CREATE TABLE IF NOT EXISTS owner_private (owner TEXT PRIMARY KEY, blob TEXT, built TEXT, ts TEXT);
    CREATE INDEX IF NOT EXISTS views_by_handle ON page_views(handle, ts);
    CREATE TABLE IF NOT EXISTS traffic_sites (key TEXT PRIMARY KEY, owner TEXT, project TEXT, public INTEGER, secret TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS traffic (key TEXT, ts TEXT, kind TEXT, visitor TEXT);
    CREATE INDEX IF NOT EXISTS traffic_by_key ON traffic(key, ts);
    CREATE TABLE IF NOT EXISTS client_versions (owner TEXT, kind TEXT, v TEXT, PRIMARY KEY (owner, kind));
    CREATE TABLE IF NOT EXISTS agent_keys (key TEXT PRIMARY KEY, owner TEXT UNIQUE, secret TEXT, repos TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS agents (owner TEXT, id TEXT, label TEXT, machine TEXT, repo TEXT, state TEXT, task TEXT, did TEXT, tokens INTEGER, ts TEXT, PRIMARY KEY (owner, id));
    CREATE TABLE IF NOT EXISTS referrals (invitee TEXT PRIMARY KEY, inviter TEXT, ts TEXT, via TEXT);
    CREATE INDEX IF NOT EXISTS referrals_by_inviter ON referrals(inviter);
  `);
  // Page views for the owner's private "Since you last looked": no IPs or user agents are stored, only a salted hash
  // that rotates daily (counts unique visitors per day, cannot be reversed or joined across days).
  const VIEW_SALT = crypto.randomBytes(16).toString("hex");
  // Private owner layer at rest: AES-256-GCM with a key file that never leaves this server.
  const keyFile = path.join(opts.dataDir, "private.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const PRIV_KEY = fs.readFileSync(keyFile);
  const seal = (s: string) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", PRIV_KEY, iv);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); };
  const unseal = (b: string) => { const buf = Buffer.from(b, "base64"), d = crypto.createDecipheriv("aes-256-gcm", PRIV_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"); };
  const owners = opts.tailnetOwners || {};
  const privateFor = (handle: string) => opts.privateUrl && Object.values(owners).includes(handle) ? `${opts.privateUrl.replace(/\/$/, "")}/@${handle}/` : undefined;
  const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|node|headless|monitor|lighthouse|facebookexternalhit|embedly|discord|slack|telegram|whatsapp/i;
  const q = (sql: string) => db.prepare(sql);
  const now = () => new Date().toISOString();

  // ---------------------------------------------------------------- helpers
  const profile = (id: string) => q("SELECT * FROM profiles WHERE id=?").get(id) as any;
  const byHandle = (h: string) => q("SELECT * FROM profiles WHERE handle=?").get(h) as any;
  // operator moderation (Terms s.3): hidden = taken down, owner cannot republish; blocked = handle can never be claimed
  const modOf = (handle: string | null, id?: string) => q("SELECT * FROM moderation WHERE handle=? OR (id IS NOT NULL AND id=?)").get(handle || "", id || "") as any;
  const body = (pr: any) => { try { return JSON.parse(pr.manifest).body || {}; } catch { return {}; } };
  const listed = (pr: any) => body(pr).listed !== false && !modOf(pr.handle, pr.id);
  const areFriends = (a: string, b: string) => !!q("SELECT 1 FROM friends WHERE a=? AND b=?").get(a, b);
  const balance = (id: string) => (q("SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE who=?").get(id) as any).s as number;

  // ---------------------------------------------------------------- growth: referrals, open requests, suggestions
  const INVITE_REWARD = 25;
  const invitedCount = (id: string) => (q("SELECT COUNT(*) n FROM referrals WHERE inviter=?").get(id) as any).n as number;
  /** Someone joined from an invite link: remember who brought them (once), and thank the inviter with help credits. */
  function recordReferral(invitee: string, inviterHandle: unknown, via: string): string | null {
    const h = String(inviterHandle || "").toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(h)) return null;
    const inv = byHandle(h); if (!inv || inv.id === invitee || modOf(inv.handle, inv.id)) return null;
    if (q("SELECT 1 FROM referrals WHERE invitee=?").get(invitee)) return null;
    q("INSERT INTO referrals VALUES (?,?,?,?)").run(invitee, inv.id, now(), via.slice(0, 20));
    const who = profile(invitee)?.handle;
    q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(inv.id, INVITE_REWARD, `invited ${who ? "@" + who : "a friend"}`, invitee, now());
    return inv.id as string;
  }
  /** Open friend requests both ways (one row per person, newest wins), skipping people who are already friends. */
  function openRequests(id: string) {
    const open = (rows: any[], other: (e: C.Envelope) => string) => {
      const by = new Map<string, any>();
      for (const r of rows) { const e = JSON.parse(r.json) as C.Envelope<any>, o = other(e); if (areFriends(id, o)) continue;
        const pr = profile(o) as any; by.set(o, { request: r.hash, id: o, handle: pr?.handle || null, name: pr?.name || null, note: String(e.body?.note || "").slice(0, 200), ts: e.ts }); }
      return [...by.values()].reverse();
    };
    const inc = q("SELECT hash, json FROM envelopes WHERE type='friend.request' AND recipient=? ORDER BY ts").all(id) as any[];
    const out = q("SELECT hash, json FROM envelopes WHERE type='friend.request' AND sender=? ORDER BY ts").all(id) as any[];
    return { incoming: open(inc, e => e.from), outgoing: open(out, e => e.body.to) };
  }
  const STOP = new Set("the and for with that this from your you are was have has into about what when where who how all can will just more than then them they their our out not but get got use using also over under each make made like into onto very much many some any its it's i'm on in of to a an at by as is be or my me we us on github vault notes obsidian building builder".split(" "));
  const words = (s: unknown) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9+#.]+/).map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w.length > 2 && !STOP.has(w)));
  const interests = (pr: any) => { const b = body(pr);
    return { topics: new Set<string>([...(b.topics || []).map((t: any) => String(Array.isArray(t) ? t[0] : t).toLowerCase()), ...(b.languages || []).map((l: any) => String(l).toLowerCase())]),
      words: words(`${pr.headline || ""} ${b.summary || ""}`), groups: new Set<string>((b.groups || []).map((g: any) => String(g))) }; };
  /** People worth meeting: shared topics, languages and groups first, then shared words in the headline, with a nudge for
   *  people who just joined (they have nobody yet) and people active this week. Never friends or pending requests. */
  function suggestFor(id: string, n = 3) {
    const me = profile(id); if (!me) return [];
    const skip = new Set<string>([id, ...(q("SELECT b FROM friends WHERE a=?").all(id) as any[]).map(r => r.b)]);
    const rq = openRequests(id); for (const r of [...rq.incoming, ...rq.outgoing]) skip.add(r.id);
    const mine = interests(me), wk = Date.now() - 7 * DAY;
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(p => !skip.has(p.id) && listed(p)).map(p => {
      const it = interests(p), shared = [...it.topics].filter(t => mine.topics.has(t)), grp = [...it.groups].filter(g => mine.groups.has(g)), sw = [...it.words].filter(w => mine.words.has(w));
      const isNew = Date.parse(p.created) > wk, week = weekScore(p.manifest);
      const score = 3 * shared.length + 4 * grp.length + Math.min(3, sw.length) + (isNew ? 1.5 : 0) + Math.min(2, week / 150) + gravityOf(p.id) / 10;
      const nice = (t: string) => t.length <= 3 ? t.toUpperCase() : t;
      const why = grp.length ? `Also in ${grp[0]}` : shared.length ? `Also into ${shared.slice(0, 2).map(nice).join(", ")}` : sw.length ? `Also mentions ${sw.slice(0, 2).join(", ")}` : isNew ? "New this week" : week ? "Active this week" : "On Caldera";
      const b = body(p), avatar = b.photos?.avatar ? `/@${p.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
      return { id: p.id, handle: p.handle, name: p.name, headline: p.headline, avatar, why, score };
    }).sort((a, b) => b.score - a.score).slice(0, n);
  }

  function storeEnvelope(e: C.Envelope, recipient: string | null) {
    const hash = C.envelopeHash(e);
    q("INSERT OR IGNORE INTO envelopes VALUES (?,?,?,?,?,?)").run(hash, e.type, e.from, recipient, e.ts, JSON.stringify(e));
    return hash;
  }

  function settleExpiredAsks() {
    const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
    for (const a of q("SELECT * FROM asks WHERE status='open' AND ts < ?").all(cutoff) as any[]) {
      q("UPDATE asks SET status='expired' WHERE id=?").run(a.id);
      if (a.bounty > 0) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(a.author, a.bounty, "bounty returned", a.id, now());
    }
  }

  function gravityOf(id: string, depth = 0): number {
    const rows = q("SELECT sender, ts FROM gravity WHERE recipient=?").all(id) as any[];
    return C.gravityScore(rows.map(r => ({ ts: r.ts, giverWeight: depth < 1 ? C.giverWeight(gravityOf(r.sender, depth + 1)) : 1 })));
  }

  // ---------------------------------------------------------------- envelope rules
  function accept(e: C.Envelope): { status: number; body: any } {
    if (!C.verify(e)) return { status: 400, body: { error: "bad signature" } };
    const age = Date.now() - Date.parse(e.ts);
    if (!(age > -5 * 60_000 && age < 30 * DAY)) return { status: 400, body: { error: "stale or future timestamp" } };
    const b = e.body || {};
    switch (e.type) {
      case "profile.manifest": {
        const handle = String(b.handle || "").toLowerCase();
        if (handle && !/^[a-z0-9][a-z0-9-]{1,30}$/.test(handle)) return { status: 400, body: { error: "bad handle" } };
        if (RESERVED.has(handle)) return { status: 400, body: { error: "that handle is reserved" } };
        if (modOf(handle, e.from)) return { status: 403, body: { error: "this profile or handle is not available" } };
        const owner = handle ? byHandle(handle) : null;
        if (owner && owner.id !== e.from) return { status: 409, body: { error: "handle taken" } };
        const existing = profile(e.from);
        if (!existing) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, C.STARTING_CREDITS, "welcome", "", now());
        q(`INSERT INTO profiles (id, handle, box_key, name, headline, manifest, updated, created) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, box_key=excluded.box_key, name=excluded.name,
           headline=excluded.headline, manifest=excluded.manifest, updated=excluded.updated`)
          .run(e.from, handle || null, b.boxKey || "", b.name || "", b.headline || "", JSON.stringify(e), e.ts, existing?.created || now());
        storeEnvelope(e, null);
        indexGarden(e.from, handle, b.garden);
        if (!existing && b.invitedBy) recordReferral(e.from, b.invitedBy, "obsidian");
        if (!existing) emit({ type: "signup", handle, name: b.name || "", total: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
        return { status: 200, body: { ok: true, id: e.from, handle } };
      }
      case "profile.delete": {
        // Owner-signed erasure: profile, page files, friendships, asks, offers, gravity, ledger and stored envelopes.
        const gone = profile(e.from);
        erase(e.from);
        if (gone) emit({ type: "delete", handle: gone.handle, name: gone.name, total: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
        return { status: 200, body: { ok: true, deleted: e.from } };
      }
      case "friend.request": {
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "bad recipient" } };
        const hash = storeEnvelope(e, b.to);
        return { status: 200, body: { ok: true, request: hash } };
      }
      case "friend.accept": {
        const req = q("SELECT json FROM envelopes WHERE hash=? AND type='friend.request'").get(b.request) as any;
        if (!req) return { status: 404, body: { error: "unknown request" } };
        const r = JSON.parse(req.json) as C.Envelope;
        if (r.body.to !== e.from || r.from !== b.to) return { status: 403, body: { error: "request was not to you" } };
        q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(e.from, r.from, e.ts);
        q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(r.from, e.from, e.ts);
        storeEnvelope(e, r.from);
        return { status: 200, body: { ok: true } };
      }
      case "friend.remove": {
        q("DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)").run(e.from, b.to, b.to, e.from);
        return { status: 200, body: { ok: true } };
      }
      case "card":
      case "message": {
        const to: string[] = Array.isArray(b.to) ? b.to : [b.to];
        for (const t of to) if (!areFriends(e.from, t)) return { status: 403, body: { error: `not friends with ${t}` } };
        for (const t of to) storeEnvelope({ ...e }, t);
        return { status: 200, body: { ok: true, delivered: to.length } };
      }
      case "ask": {
        settleExpiredAsks();
        const bounty = Math.max(0, Math.floor(Number(b.bounty) || 0));
        if (!b.id || !b.title) return { status: 400, body: { error: "ask needs id and title" } };
        if (q("SELECT 1 FROM asks WHERE id=?").get(b.id)) return { status: 409, body: { error: "ask exists" } };
        if (bounty > balance(e.from)) return { status: 402, body: { error: "not enough credits", balance: balance(e.from) } };
        q("INSERT INTO asks VALUES (?,?,?,?,?,?,?,?,?,?)").run(b.id, e.from, String(b.title).slice(0, 140), String(b.detail || "").slice(0, 2000),
          bounty, JSON.stringify(b.tags || []), b.visibility === "friends" ? "friends" : "public", "open", e.ts, null);
        if (bounty) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, -bounty, "bounty escrow", b.id, now());
        storeEnvelope(e, null);
        return { status: 200, body: { ok: true, balance: balance(e.from) } };
      }
      case "offer": {
        if (!b.id || !b.title) return { status: 400, body: { error: "offer needs id and title" } };
        q("INSERT OR REPLACE INTO offers VALUES (?,?,?,?,?,?)").run(b.id, e.from, String(b.title).slice(0, 140), String(b.detail || "").slice(0, 2000), JSON.stringify(b.tags || []), e.ts);
        storeEnvelope(e, null);
        return { status: 200, body: { ok: true } };
      }
      case "gravity": {
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "gravity goes to someone else" } };
        if (!profile(b.to)) return { status: 404, body: { error: "unknown profile" } };
        const since = new Date(Date.now() - DAY).toISOString();
        if (q("SELECT 1 FROM gravity WHERE sender=? AND recipient=? AND ts > ?").get(e.from, b.to, since))
          return { status: 429, body: { error: "one gravity per person per day" } };
        q("INSERT INTO gravity VALUES (?,?,?,?,?)").run(e.from, b.to, e.ts, String(b.reason || "").slice(0, 140), b.ask || null);
        storeEnvelope(e, b.to);
        return { status: 200, body: { ok: true, gravity: gravityOf(b.to) } };
      }
      case "credit.award": {
        const a = q("SELECT * FROM asks WHERE id=?").get(b.ask) as any;
        if (!a) return { status: 404, body: { error: "unknown ask" } };
        if (a.author !== e.from) return { status: 403, body: { error: "only the asker can award" } };
        if (a.status !== "open") return { status: 409, body: { error: `ask is ${a.status}` } };
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "award goes to a helper" } };
        const amount = Math.max(0, Math.min(a.bounty, Math.floor(Number(b.amount) || a.bounty)));
        q("UPDATE asks SET status='awarded', awarded_to=? WHERE id=?").run(b.to, a.id);
        q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(b.to, amount, "helped", a.id, now());
        if (a.bounty - amount > 0) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, a.bounty - amount, "bounty change", a.id, now());
        storeEnvelope(e, b.to);
        return { status: 200, body: { ok: true, awarded: amount } };
      }
      default:
        return { status: 200, body: { ok: true, ignored: e.type } };   // unknown types are ignored, not rejected
    }
  }

  /** The garden listed in a signed manifest: note index (for the feed) + links into other gardens (for their backlinks). */
  function indexGarden(owner: string, handle: string, garden: unknown) {
    q("DELETE FROM garden_notes WHERE owner=?").run(owner); q("DELETE FROM garden_links WHERE owner=?").run(owner);
    if (!handle || !Array.isArray(garden)) return;
    const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
    for (const g of garden.slice(0, 2000)) {
      const sl = str(g?.slug, 120); if (!/^[a-z0-9][a-z0-9-]*$/.test(sl)) continue;
      const stage = ["seedling", "budding", "evergreen"].includes(g.stage) ? g.stage : "seedling";
      const upd = Date.parse(g.updated) ? new Date(g.updated).toISOString() : now();
      q("INSERT OR REPLACE INTO garden_notes VALUES (?,?,?,?,?,?,?,?,?,?)").run(owner, handle, sl, str(g.title, 200), stage, str(g.license, 20), upd, str(g.excerpt, 240), Number(g.words) || 0, str(g.sha256, 64));
      for (const x of Array.isArray(g.xlinks) ? g.xlinks.slice(0, 100) : []) {
        const m = String(x).match(/^([a-z0-9][a-z0-9-]{1,30})\/([a-z0-9][a-z0-9-]*)$/);
        if (m && m[1] !== handle) q("INSERT INTO garden_links VALUES (?,?,?,?,?,?)").run(owner, handle, sl, str(g.title, 200), m[1], m[2]);
      }
    }
  }

  /** "Linked from other gardens" block injected into a hosted note page (static pages can't query the hub themselves). */
  function xlinksBlock(handle: string, slug: string): string {
    const rows = (q(`SELECT l.src_handle, l.src_slug, l.src_title, p.name, p.id, p.manifest FROM garden_links l JOIN profiles p ON p.id=l.owner
      WHERE l.dst_handle=? AND l.dst_slug=? LIMIT 50`).all(handle, slug) as any[]).filter(r => !modOf(r.src_handle, r.id));
    if (!rows.length) return "";
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    return `<section class="g-xlinks"><h2>Linked from other gardens</h2>${rows.map(r => `<a class="g-card" href="../../@${e(r.src_handle)}/n/${e(r.src_slug)}.html"><span class="g-card-t">${e(r.src_title)}</span><span class="g-card-m"><span class="g-who">@${e(r.src_handle)}</span>${r.name ? `<span>${e(r.name)}</span>` : ""}</span></a>`).join("")}</section>`;
  }

  /** "How this garden works" block injected into a hosted garden.html: everything the garden system tracks for this person,
   * read live (gravity, credits, asks/offers, links from other gardens, friends, rank) plus plain-English explainers. */
  function gardenHomeBlock(handle: string): string {
    const prof = q("SELECT id, name FROM profiles WHERE handle=?").get(handle) as any;
    if (!prof) return "";
    const id = prof.id;
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    settleExpiredAsks();
    const notes = (q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(id) as any).n;
    const links = q("SELECT COUNT(*) n, COUNT(DISTINCT src_handle) w FROM garden_links WHERE dst_handle=?").get(handle) as any;
    const grav = gravityOf(id);
    const givers = q(`SELECT g.reason, g.ts, p.handle FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? ORDER BY g.ts DESC LIMIT 5`).all(id) as any[];
    const bal = balance(id);
    const asks = q("SELECT title, bounty FROM asks WHERE author=? AND status='open' AND visibility='public' ORDER BY ts DESC LIMIT 5").all(id) as any[];
    const held = asks.reduce((s, a) => s + (a.bounty || 0), 0);
    const offers = q("SELECT title FROM offers WHERE author=? ORDER BY ts DESC LIMIT 5").all(id) as any[];
    const friends = (q("SELECT COUNT(*) n FROM friends WHERE a=? OR b=?").get(id, id) as any).n;
    const board = leaderboard(null) as any[];
    const rank = board.findIndex(r => r.id === id) + 1;
    const tile = (n: string, l: string, x: string) => `<div class="gh-tile"><b>${e(n)}</b><span>${e(l)}</span><small>${e(x)}</small></div>`;
    const hub = (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
    return `<section class="gh" aria-label="How this garden works">
<style>.gh{margin:22px 0 26px;padding:18px 18px 8px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg-raised)}
.gh h2{margin:0 0 4px;font-family:var(--font-display);font-size:1.15rem;color:var(--text-strong)}.gh>p{margin:0 0 14px;color:var(--text-muted);font-size:var(--text-sm)}
.gh-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.gh-tile{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--radius-md);background:var(--bg-sunken)}
.gh-tile b{font-size:1.4rem;color:var(--accent-text);font-variant-numeric:tabular-nums}.gh-tile span{font-weight:600;color:var(--text)}.gh-tile small{color:var(--text-muted);font-size:var(--text-xs);line-height:1.35}
.gh-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.gh-cols h3{margin:16px 0 6px;font-size:var(--text-sm);color:var(--text-strong);text-transform:uppercase;letter-spacing:.04em}
.gh-cols>div>h3:first-child{margin-top:4px}.gh-cols p,.gh-cols li{font-size:var(--text-sm);color:var(--text);line-height:1.5}.gh-cols ul{margin:0;padding-left:18px}.gh-cols .mut{color:var(--text-muted)}
.gh-cta{margin:14px 0 10px;padding:12px 14px;border-radius:var(--radius-md);background:var(--accent-soft);font-size:var(--text-sm);color:var(--text);display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.gh-cta span{flex:1 1 260px}.gh-btn{display:inline-block;padding:7px 14px;border-radius:var(--radius-round,999px);background:var(--accent);color:var(--bg,#fff);font-weight:600;text-decoration:none;white-space:nowrap}.gh-btn:hover{filter:brightness(1.08);text-decoration:none}</style>
<h2>How this garden works</h2>
<p>A garden is more than notes. It is a small economy of help between Obsidian vaults: notes link across gardens, friends give gravity, and asks pay out help credits.</p>
<div class="gh-tiles">${tile(String(notes), "notes planted", "Public notes, each signed and dated")}${tile(String(links.n || 0), "links in", `From ${links.w || 0} other garden${links.w === 1 ? "" : "s"}`)}${tile(grav.toFixed(1), "gravity", "Goodwill from friends")}${tile(String(bal), "help credits", held ? `${held} held in open bounties` : "Spendable on bounties")}${tile(String(friends), "friends", "Vaults connected")}${tile(rank ? `#${rank}` : "-", "this week", "Activity leaderboard")}${tile(String(invitedCount(id)), "brought in", "People who joined from their invite")}</div>
<div class="gh-cols">
<div><h3>Gravity (goodwill)</h3><p>Friends give gravity to say "you helped". It is positive only, fades with a 30-day half-life so it reflects recent help, and a gift from someone with more gravity counts a little more (1x to 2x, capped).</p>${givers.length ? `<ul>${givers.map(g => `<li>@${e(g.handle || "friend")}${g.reason ? `: ${e(g.reason)}` : ""}</li>`).join("")}</ul>` : `<p class="mut">No gravity yet. Be the first.</p>`}</div>
<div><h3>Help credits and asks</h3><p>Everyone starts with 100 credits. An ask can carry a bounty; the credits are held until the asker awards them to whoever helped, and come back after 30 days if nobody does. Credits have no cash value.</p>${asks.length ? `<ul>${asks.map(a => `<li>${e(a.title)}${a.bounty ? ` <span class="mut">(${a.bounty} credits)</span>` : ""}</li>`).join("")}</ul>` : `<p class="mut">No open asks right now.</p>`}</div>
<div><h3>Offers</h3><p>What this person is happy to help with.</p>${offers.length ? `<ul>${offers.map(o => `<li>${e(o.title)}</li>`).join("")}</ul>` : `<p class="mut">No offers posted yet.</p>`}<h3>Reuse and links</h3><p>Each note shows its license. Link to any note from your own garden with <code>[[@${e(handle)}/note-slug]]</code> and it appears on that note under "Linked from other gardens".</p></div>
</div>
<div class="gh-cta"><a class="gh-btn" href="obsidian://caldera?friend=${encodeURIComponent(handle)}" target="_blank" rel="noopener">+ Add @${e(handle)} as a friend</a> <span>Opens Obsidian and sends the request (needs the Caldera plugin). Then give gravity, answer an ask, or link a note. New to Caldera? <a href="${e(hub)}/?invite=${encodeURIComponent(handle)}#install">Get it here</a> and you'll be walked back to add @${e(handle)}.</span></div>
</section>`;
  }

  function recentGardenNotes(limit = 60) {
    return (q(`SELECT g.handle, g.slug, g.title, g.stage, g.license, g.updated, g.excerpt, g.words, p.name, p.id, p.manifest FROM garden_notes g
      JOIN profiles p ON p.id=g.owner WHERE p.handle IS NOT NULL ORDER BY g.updated DESC LIMIT ?`).all(Math.min(200, limit * 3)) as any[])
      .filter(r => listed(r) || false).slice(0, limit)
      .map(r => ({ handle: r.handle, name: r.name, slug: r.slug, title: r.title, stage: r.stage, license: r.license, updated: r.updated, excerpt: r.excerpt, words: r.words }));
  }

  // ---------------------------------------------------------------- link previews + group towns
  const hubUrl = () => (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
  const cityOf = (handle: string) => { try { return cityArt(fs.readFileSync(path.join(opts.dataDir, "profiles", handle, "index.html"), "utf8")); } catch { return null; } };
  const cardDir = path.join(opts.dataDir, "cards");
  /** PNG card for link previews, cached until the profile is published again. */
  async function profileCard(pr: any): Promise<Buffer> {
    const f = path.join(cardDir, pr.handle + ".png"), idx = path.join(opts.dataDir, "profiles", pr.handle, "index.html");
    const fresh = Math.max(Date.parse(pr.updated) || 0, fs.existsSync(idx) ? fs.statSync(idx).mtimeMs : 0);
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs >= fresh) return fs.readFileSync(f);
    const png = await toPng(cardSvg({ handle: pr.handle, name: pr.name, headline: pr.headline, host: hubUrl().replace(/^https?:\/\//, ""), city: cityOf(pr.handle) }));
    fs.mkdirSync(cardDir, { recursive: true }); fs.writeFileSync(f, png);
    return png;
  }
  function previewTags(handle: string, rel: string): string {
    const pr = byHandle(handle); if (!pr) return "";
    const v = String(Date.parse(pr.updated) || 0).slice(-8), base = `${hubUrl()}/@${handle}/`;
    const city = rel === "city.html";
    return ogTags({ url: base + (city ? "city.html" : ""), image: `${base}card.png?v=${v}`,
      title: city ? `${pr.name || "@" + handle}'s city on Caldera` : `${pr.name || "@" + handle} on Caldera`,
      description: pr.headline || "A living profile built from an Obsidian vault and code, on Caldera." });
  }
  function groupMembers(slug: string) {
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL ORDER BY created").all() as any[])
      .filter(p => listed(p) && Array.isArray(body(p).groups) && body(p).groups.includes(slug))
      .map(p => ({ handle: p.handle as string, name: p.name as string, headline: p.headline as string, city: cityOf(p.handle) }));
  }

  const emit = (ev: Parameters<NonNullable<HubOptions["onEvent"]>>[0]) => { try { opts.onEvent?.(ev); } catch { /* never let a notifier break a request */ } };

  function erase(id: string) {
    const pr = profile(id);
    if (pr?.handle) { fs.rmSync(path.join(opts.dataDir, "profiles", pr.handle), { recursive: true, force: true }); fs.rmSync(path.join(opts.dataDir, "cards", pr.handle + ".png"), { force: true }); q("DELETE FROM page_views WHERE handle=?").run(pr.handle); }
    for (const r of q("SELECT key FROM traffic_sites WHERE owner=?").all(id) as any[]) q("DELETE FROM traffic WHERE key=?").run(r.key);
    q("DELETE FROM traffic_sites WHERE owner=?").run(id); q("DELETE FROM client_versions WHERE owner=?").run(id); q("DELETE FROM agent_keys WHERE owner=?").run(id); q("DELETE FROM agents WHERE owner=?").run(id);
    q("DELETE FROM owner_private WHERE owner=?").run(id);
    for (const sql of ["DELETE FROM profiles WHERE id=?", "DELETE FROM friends WHERE a=? OR b=?", "DELETE FROM asks WHERE author=?", "DELETE FROM offers WHERE author=?",
      "DELETE FROM gravity WHERE sender=? OR recipient=?", "DELETE FROM ledger WHERE who=?", "DELETE FROM envelopes WHERE sender=? OR recipient=?", "DELETE FROM tokens WHERE id=?", "DELETE FROM garden_notes WHERE owner=?", "DELETE FROM garden_links WHERE owner=?"]) {
      const n = (sql.match(/\?/g) || []).length; q(sql).run(...Array(n).fill(id));
    }
  }

  // ---------------------------------------------------------------- operator tools (run on the server: node dist/admin.js)
  const admin = {
    list: () => q("SELECT * FROM moderation ORDER BY at DESC").all(),
    hide(handle: string, reason = "") { const pr = byHandle(handle); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "hidden", reason, now()); return { hidden: handle, id: pr?.id || null }; },
    unhide(handle: string) { q("DELETE FROM moderation WHERE handle=?").run(handle); return { restored: handle }; },
    remove(handle: string, reason = "") { const pr = byHandle(handle); if (pr) erase(pr.id); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "removed", reason, now()); return { removed: handle, id: pr?.id || null }; },
    block(handle: string, reason = "") { q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, null, "blocked", reason, now()); return { blocked: handle }; },
  };

  // ---------------------------------------------------------------- scores for leaderboards
  function weekScore(manifestJson: string): number {
    try {
      const m = JSON.parse(manifestJson).body;
      const cutoff = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
      return (m.daily || []).filter((d: any) => d.date >= cutoff).reduce((s: number, d: any) => s + (Number(d.score) || 0), 0);
    } catch { return 0; }
  }

  function leaderboard(ofId: string | null) {
    const rows = (ofId
      ? q("SELECT p.* FROM profiles p WHERE p.id=? OR p.id IN (SELECT b FROM friends WHERE a=?)").all(ofId, ofId)
      : (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed)) as any[];
    return rows.map(p => ({ id: p.id, handle: p.handle, name: p.name, week: weekScore(p.manifest), gravity: gravityOf(p.id) }))
      .sort((a, b) => b.week - a.week || b.gravity - a.gravity)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  /** Hub-side live blocks on hosted pages: links from other gardens, the garden home, layout fixes for old builds. */
  function liveBlocks(handle: string, rel: string, html: string): string {
    const note = rel.match(/^n\/([a-z0-9-]+)\.html$/);
    if (note) html = html.replace("<!--caldera:xlinks-->", xlinksBlock(handle, note[1]));
    if (rel === "garden.html") {   // garden home: live gravity/credits/asks/links block (marker from 0.6.0; older builds: before the stage filter)
      const gh = gardenHomeBlock(handle);
      html = html.includes("<!--caldera:gardenhome-->") ? html.replace("<!--caldera:gardenhome-->", gh) : html.replace('<div class="g-filter"', gh + '<div class="g-filter"');
    }
    if (!html.includes("Heatmap sizing (2026-10-12)") && html.includes('class="heat-box"')) html = html.replace(/<\/head>/i, HEAT_FIX + "</head>");   // pages built before 0.5.1
    return html;
  }

  // ---------------------------------------------------------------- live traffic on the owner's own sites
  // Sites are registered by the owner (one key per city district). Visits arrive from the t.js pixel or, for server-side
  // events, from the owner's own feed with the site's secret. Visitors are a salted daily hash, like profile views.
  const sitesOf = (owner: string) => q("SELECT key, project, public FROM traffic_sites WHERE owner=?").all(owner) as { key: string; project: string; public: number }[];
  const keyBuckets = new Map<string, { n: number; reset: number }>();
  function record(key: string, kind: string, visitor: string, ts = now()) {
    const t = Date.now(); let b = keyBuckets.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + 60_000 }; keyBuckets.set(key, b); }
    if (++b.n > 1200) return false;   // a flood on one site can't fill the database
    q("INSERT INTO traffic VALUES (?,?,?,?)").run(key, ts, kind, visitor);
    if (Math.random() < 0.002) q("DELETE FROM traffic WHERE ts < ?").run(new Date(Date.now() - 35 * DAY).toISOString());
    return true;
  }
  /** Per-district live numbers. full=false is the public projection: coarse activity levels only, unlisted projects merged. */
  /** Agents working for the owner right now (reported in the last 15 minutes). Public: district + state only. */
  const AGENT_TTL = 15 * 60_000;
  const repoHash = (r: string) => crypto.createHash("sha256").update(String(r).toLowerCase()).digest("hex").slice(0, 16);
  function agentsOf(owner: string, full: boolean, pubProjects: Set<string>) {
    const k = q("SELECT repos FROM agent_keys WHERE owner=?").get(owner) as any; let map: Record<string, string> = {};
    try { map = JSON.parse(k?.repos || "{}"); } catch { /* none */ }
    const rows = q("SELECT * FROM agents WHERE owner=? AND ts > ? ORDER BY ts DESC LIMIT 80").all(owner, new Date(Date.now() - AGENT_TTL).toISOString()) as any[];
    return rows.map(r => {
      const project = r.repo ? map[r.repo] || "" : "", ago = Math.round((Date.now() - Date.parse(r.ts)) / 1000);
      const state = ago > 300 && (r.state === "working" || r.state === "thinking") ? "idle" : r.state;   // went quiet without saying so
      if (!full) return { id: crypto.createHash("sha256").update(owner + r.id).digest("hex").slice(0, 10), d: pubProjects.has(project) ? project : project ? "Private" : "", state };
      let x: any = {}; try { x = JSON.parse(unseal(r.task)); } catch { /* unreadable */ }
      return { id: r.id, d: project, repo: x.repo || "", label: x.label || "", machine: x.machine || "", state, task: x.task || "", did: x.did || "", tokens: r.tokens, ago };
    });
  }
  function liveStats(owner: string, full: boolean) {
    const sites = sitesOf(owner), pubSet = new Set(sites.filter(s => s.public).map(s => s.project));
    const agents = agentsOf(owner, full, pubSet);
    if (!sites.length) return agents.length ? (full ? { at: now(), private: true, districts: {}, events: [], agents } : { at: now(), districts: {}, agents }) : null;
    const t5 = new Date(Date.now() - 5 * 60_000).toISOString(), t24 = new Date(Date.now() - DAY).toISOString(), t3 = new Date(Date.now() - 3 * 60_000).toISOString();
    const by = new Map(sites.map(s => [s.key, s]));
    const name = (k: string) => { const s = by.get(k)!; return full || s.public ? s.project : "Private"; };
    const ds: Record<string, { now: number; views: number; visitors: number; signups: number; buys: number }> = {};
    const d = (k: string) => ds[name(k)] ||= { now: 0, views: 0, visitors: 0, signups: 0, buys: 0 };
    const keys = sites.map(s => s.key), qs = keys.map(() => "?").join(",");
    for (const r of q(`SELECT key, COUNT(DISTINCT visitor) n FROM traffic WHERE key IN (${qs}) AND ts > ? AND kind='view' GROUP BY key`).all(...keys, t5) as any[]) d(r.key).now += r.n;
    for (const r of q(`SELECT key, kind, COUNT(*) n, COUNT(DISTINCT visitor) u FROM traffic WHERE key IN (${qs}) AND ts > ? GROUP BY key, kind`).all(...keys, t24) as any[]) {
      const x = d(r.key); if (r.kind === "view") { x.views += r.n; x.visitors += r.u; } else if (r.kind === "signup") x.signups += r.n; else if (r.kind === "buy") x.buys += r.n;
    }
    const level = (n: number) => n <= 0 ? 0 : n < 3 ? 1 : n < 10 ? 2 : n < 30 ? 3 : 4;
    if (!full) return { at: now(), districts: Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, { level: level(v.now) }])), agents };
    const events = (q(`SELECT key, ts, kind FROM traffic WHERE key IN (${qs}) AND ts > ? ORDER BY ts DESC LIMIT 300`).all(...keys, t3) as any[]).map(r => ({ d: name(r.key), k: r.kind, ts: r.ts }));
    return { at: now(), private: true, districts: Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, { ...v, level: level(v.now) }])), events, agents };
  }
  const hasLive = (owner: string) => { const wk = new Date(Date.now() - 7 * DAY).toISOString();
    return !!q(`SELECT 1 FROM traffic t JOIN traffic_sites s ON s.key=t.key WHERE s.owner=? AND t.ts > ? LIMIT 1`).get(owner, wk) || !!q("SELECT 1 FROM agents WHERE owner=? AND ts > ? LIMIT 1").get(owner, wk); };
  /** An older Caldera (say, a stale copy still running on another device) must not overwrite what a newer one published. */
  const semver = (v: unknown) => String(v || "0.0.0").split(".").map(x => parseInt(x, 10) || 0);
  function staleClient(owner: string, kind: string, v: unknown): string | null {
    const row = q("SELECT v FROM client_versions WHERE owner=? AND kind=?").get(owner, kind) as any, a = semver(v), b = semver(row?.v);
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) break; if ((a[i] || 0) < (b[i] || 0)) return row.v; }
    q("INSERT OR REPLACE INTO client_versions VALUES (?,?,?)").run(owner, kind, String(v || "0.0.0").slice(0, 20));
    return null;
  }
  const liveScript = (cfg: object) => `<script>window.CALDERA_LIVE=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>`;
  const injectLive = (html: string, cfg: object) => /<\/head>/i.test(html) ? html.replace(/<\/head>/i, liveScript(cfg) + "</head>") : liveScript(cfg) + html;
  const liveToken = (handle: string, day = new Date().toISOString().slice(0, 10)) => crypto.createHmac("sha256", PRIV_KEY).update("live:" + handle + ":" + day).digest("hex").slice(0, 24);

  // ---------------------------------------------------------------- auth (signed nonce, no passwords)
  function authed(req: http.IncomingMessage): string | null {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const row = q("SELECT id FROM tokens WHERE token=? AND expires > ?").get(hashToken(t), Date.now()) as any;
    return row?.id || null;
  }

  // ---------------------------------------------------------------- http
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error("too large"); chunks.push(c as Buffer); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" , ".md": "text/plain; charset=utf-8", ".zip": "application/zip", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", };

  const buckets = new Map<string, { n: number; w: number; reset: number }>();
  const newProfiles = new Map<string, { n: number; day: string }>();
  const L = { perMinute: 240, writesPerMinute: 40, newProfilesPerDay: 5, ...(opts.limits || {}) };
  // Behind nginx, X-Real-IP is set by the proxy from the TCP peer (clients cannot spoof it); X-Forwarded-For is not trusted.
  const ipOf = (req: http.IncomingMessage) => (opts.trustProxy ? String(req.headers["x-real-ip"] || "").trim() : "") || req.socket.remoteAddress || "?";
  function limited(req: http.IncomingMessage): boolean {
    const ip = ipOf(req), t = Date.now(); let b = buckets.get(ip);
    if (!b || b.reset < t) { b = { n: 0, w: 0, reset: t + 60_000 }; buckets.set(ip, b); }
    b.n++; if (req.method === "POST") b.w++;
    if (buckets.size > 50_000) buckets.clear();
    return b.n > L.perMinute || b.w > L.writesPerMinute;
  }
  function allowNewProfile(req: http.IncomingMessage): boolean {
    const ip = ipOf(req), day = new Date().toISOString().slice(0, 10); const r = newProfiles.get(ip);
    if (!r || r.day !== day) { newProfiles.set(ip, { n: 1, day }); return true; }
    r.n++; return r.n <= L.newProfilesPerDay;
  }

  /** What happened to one person since `since`, for their daily summary email. */
  function digestFor(owner: string, since: string) {
    const pr = profile(owner); if (!pr?.handle) return null;
    const h = pr.handle as string, d1 = new Date(Date.now() - DAY).toISOString(), d7 = new Date(Date.now() - 7 * DAY).toISOString();
    const v1 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor) u FROM page_views WHERE handle=? AND ts > ?").get(h, since > d1 ? since : d1) as any;   // since the last email, at most a day
    const v7 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(h, d7) as any;
    const hosted = !!q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner);
    return { handle: h, name: pr.name, hosted, views24: v1.n, visitors24: v1.u, views7: v7.n, visitors7: v7.u,
      requests: openRequests(owner).incoming.filter(r => r.ts > since).map(r => ({ handle: r.handle || "someone", name: r.name || "", note: r.note })),
      friends: q("SELECT p.handle, p.name FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=? AND f.ts > ?").all(owner, since) as any[],
      gravity: (q("SELECT p.handle, g.reason FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? AND g.ts > ?").all(owner, since) as any[]).map(g => ({ handle: g.handle || "friend", reason: g.reason || "" })),
      links: (q("SELECT COUNT(*) n FROM garden_links WHERE dst_handle=? AND src_handle<>?").get(h, h) as any).n,
      invited: q("SELECT p.handle FROM referrals r JOIN profiles p ON p.id=r.invitee WHERE r.inviter=? AND r.ts > ?").all(owner, since) as any[],
      credits: (q("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE who=? AND reason LIKE 'invited%' AND ts > ?").get(owner, since) as any).s,
      suggestions: suggestFor(owner, 3).map(x => ({ handle: x.handle, name: x.name, why: x.why })),
      newMembers: (q("SELECT * FROM profiles WHERE handle IS NOT NULL AND created > ? AND id<>? ORDER BY created DESC").all(d7, owner) as any[]).filter(listed).map(p => ({ handle: p.handle, name: p.name })) };
  }
  const mail = emailer({ q, seal, unseal, hub: opts.publicUrl || "https://caldera.social", pepper: PRIV_KEY, send: opts.email?.send, resendKey: opts.email?.resendKey, digest: digestFor });
  if (opts.email?.schedule) mail.schedule();

  const GH = github({ q, seal, unseal, accept, erase, dataDir: opts.dataDir, publicUrl: opts.publicUrl || "https://caldera.social", privateUrl: opts.privateUrl,
    json, readBody, allowNewProfile, byHandle, reserved: RESERVED, fetch: opts.githubFetch,
    social: { suggest: suggestFor, openRequests, invitedCount, recordReferral, email: { status: mail.status, subscribe: mail.subscribe, unsubscribe: mail.unsubscribe } } });

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (req.method === "HEAD") {   // link checkers (e.g. the Obsidian directory) probe with HEAD: answer like GET, without a body
        req.method = "GET"; const end = res.end.bind(res);
        (res as any).write = () => true; (res as any).end = (..._a: unknown[]) => end();
      }
      if (limited(req)) return json(res, 429, { error: "slow down" });
      const url = new URL(req.url || "/", "http://hub");
      // ids arrive percent-encoded ("cal%3A...") when a proxy passes the raw URI through; API routes match the decoded form
      const p = url.pathname.startsWith("/v1/") ? url.pathname.replace(/%3A/gi, ":") : url.pathname;
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (/^\/(auth\/github|me$|v1\/github\/)/.test(p) && await GH.route(req, res, url)) return;

      if (req.method === "GET" && p === "/v1/info") return json(res, 200, { name: "Caldera Hub", protocol: C.PROTOCOL_VERSION, profiles: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
      if (req.method === "GET" && p === "/v1/gardens/recent") return json(res, 200, { notes: recentGardenNotes(Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 60))) });
      if (req.method === "GET" && (p === "/gardens" || p === "/gardens/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
        return res.end(gardensPage(recentGardenNotes(80), opts.publicUrl || "https://caldera.social"));
      }
      { const g = p.match(/^\/g\/([a-z0-9][a-z0-9-]{1,29})\/?$/);
        if (req.method === "GET" && g) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
          return res.end(groupPage({ slug: g[1], hub: opts.publicUrl || "https://caldera.social", members: groupMembers(g[1]) }));
        } }
      if (req.method === "GET" && p === "/t.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
        return res.end(TRACK_JS);
      }
      if (req.method === "GET" && opts.siteDir && !p.startsWith("/v1/") && !p.startsWith("/@")) {
        let rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
        if (rel.endsWith("/")) rel += "index.html";
        const root = path.resolve(opts.siteDir);
        let file = path.resolve(root, path.normalize(rel));
        // clean URLs: /obsidian-public-profile serves obsidian-public-profile.html; /x.html 301s to /x so each page has one URL
        if (/\.html$/.test(rel) && rel !== "index.html" && !rel.endsWith("/index.html") && !/^google[0-9a-f]+\.html$/.test(rel) && fs.existsSync(file)) { res.writeHead(301, { location: "/" + rel.replace(/\.html$/, "") }); return res.end(); }
        if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
        if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, { "content-type": MIME[ext] || (ext === ".zip" ? "application/zip" : "application/octet-stream"), "cache-control": "public, max-age=600" });
          return fs.createReadStream(file).pipe(res);
        }
      }
      if (req.method === "GET" && p === "/") return json(res, 200, { name: "Caldera Hub", protocol: C.PROTOCOL_VERSION });

      if (req.method === "POST" && p === "/v1/envelopes") {
        const env = await readBody(req);
        if (env?.type === "profile.manifest" && !profile(env.from) && !allowNewProfile(req)) return json(res, 429, { error: "too many new profiles from this address today" });
        const r = accept(env); return json(res, r.status, r.body);
      }

      // upload a static profile bundle: { manifest: <signed profile.manifest>, files: { "index.html": "<base64>", ... } }
      let m = p.match(/^\/v1\/profiles\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/bundle$/);
      if (req.method === "POST" && m) {
        const body = await readBody(req);
        if (body.manifest?.from !== m[1]) return json(res, 403, { error: "manifest must be signed by the profile" });
        { const newer = staleClient(m[1], "bundle", body.v); if (newer) return json(res, 409, { error: `Caldera ${newer} already published this profile; update Caldera on this device (you have ${body.v || "an older version"})` }); }
        if (!profile(m[1]) && !allowNewProfile(req)) return json(res, 429, { error: "too many new profiles from this address today" });
        const r = accept(body.manifest); if (r.status !== 200) return json(res, r.status, r.body);
        const handle = r.body.handle; if (!handle) return json(res, 400, { error: "a handle is required to host a page" });
        const dir = path.join(opts.dataDir, "profiles", handle);
        fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
        for (const [rel, b64data] of Object.entries(body.files || {})) {
          const clean = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
          if (clean.includes("..") || path.isAbsolute(clean) || !MIME[path.extname(clean).toLowerCase()]) continue;
          fs.mkdirSync(path.dirname(path.join(dir, clean)), { recursive: true });
          fs.writeFileSync(path.join(dir, clean), Buffer.from(String(b64data), "base64"));
        }
        fs.writeFileSync(path.join(dir, "caldera.json"), JSON.stringify(body.manifest));
        return json(res, 200, { ok: true, url: `${opts.publicUrl || ""}/@${handle}/` });
      }

      // /@mike (no slash, any case) 301s to /@mike/ so the page's relative img/ and assets/ paths resolve
      m = p.match(/^\/@([A-Za-z0-9-]+)$/);
      if (req.method === "GET" && m) { res.writeHead(301, { location: `/@${m[1].toLowerCase()}/${url.search}` }); return res.end(); }
      m = p.match(/^\/@([a-z0-9-]+)(\/.*)?$/);
      if (req.method === "GET" && m) {
        if (modOf(m[1])) { res.writeHead(410, { "content-type": "text/plain" }); return res.end("This profile is not available."); }
        const dir = path.join(opts.dataDir, "profiles", m[1]);
        if (m[2] === "/card.png") {   // the link-preview picture: the city (or initials), name, headline
          const pr = byHandle(m[1]); if (!pr) { res.writeHead(404); return res.end("not found"); }
          try { const png = await profileCard(pr); res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }); return res.end(png); }
          catch (e: any) { console.error("card", m[1], e?.message); res.writeHead(302, { location: "/og.jpg" }); return res.end(); }
        }
        let rel = (m[2] || "/").slice(1) || "index.html";
        if (rel.endsWith("/")) rel += "index.html";
        const file = path.join(dir, path.normalize(rel));
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
        res.removeHeader("x-frame-options");
        const headers = { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "x-robots-tag": "noindex", "content-security-policy": PROFILE_CSP, "cache-control": "no-cache" };
        if (path.extname(file).toLowerCase() === ".html") {   // every hosted page gets the Caldera bar, whatever plugin version built it
          const ua = String(req.headers["user-agent"] || "");
          if (ua && !BOT_UA.test(ua) && url.searchParams.get("caldera") !== "owner" && req.method === "GET") {   // the owner's own Public view passes caldera=owner
            const day = new Date().toISOString().slice(0, 10);
            const visitor = crypto.createHash("sha256").update(VIEW_SALT + day + ipOf(req) + ua).digest("hex").slice(0, 16);
            try { q("INSERT INTO page_views VALUES (?,?,?,?)").run(m[1], rel, now(), visitor); } catch { /* counting never breaks a page */ }
          }
          let html = fs.readFileSync(file, "utf8"); const bar = calderaBar(opts.publicUrl || "https://caldera.social", m[1]);
          html = liveBlocks(m[1], rel, html);
          if ((rel === "index.html" || rel === "city.html") && !html.includes('property="og:image"')) html = html.replace(/<\/head>/i, previewTags(m[1], rel) + "</head>");
          if (rel === "city.html") { const pr = byHandle(m[1]); if (pr && hasLive(pr.id)) { html = injectLive(html, { url: `/v1/live/${m[1]}`, mode: "public" }); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.publicUrl)); } }
          const out = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar) : bar + html;
          res.writeHead(200, headers); return res.end(out);
        }
        res.writeHead(200, headers);
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === "POST" && p === "/v1/auth/challenge") {
        const { id } = await readBody(req); const nonce = crypto.randomBytes(24).toString("base64");
        q("INSERT INTO challenges VALUES (?,?,?)").run(id, nonce, Date.now() + 5 * 60_000);
        return json(res, 200, { nonce });
      }
      if (req.method === "POST" && p === "/v1/auth/verify") {
        const env = await readBody(req) as C.Envelope;   // a "message" envelope whose body is { nonce }
        if (!C.verify(env)) return json(res, 401, { error: "bad signature" });
        const ch = q("SELECT * FROM challenges WHERE id=? AND nonce=? AND expires > ?").get(env.from, env.body?.nonce, Date.now());
        if (!ch) return json(res, 401, { error: "unknown or expired challenge" });
        q("DELETE FROM challenges WHERE id=?").run(env.from);
        const token = crypto.randomBytes(24).toString("hex");
        q("INSERT INTO tokens VALUES (?,?,?)").run(hashToken(token), env.from, Date.now() + 3600_000);  // only the hash is stored
        return json(res, 200, { token, expires_in: 3600 });
      }

      // daily summary email: owner subscribes (double opt-in), confirm + one-click unsubscribe links from the emails
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/email$/);
      if (m && (req.method === "GET" || req.method === "POST")) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        if (req.method === "GET") return json(res, 200, mail.status(m[1]) || { email: null, confirmed: false });
        const { email } = await readBody(req) as { email?: string | null };
        if (!email) { mail.unsubscribe(m[1]); return json(res, 200, { ok: true, off: true }); }
        try { return json(res, 200, { ok: true, message: await mail.subscribe(m[1], String(email)) }); } catch (e: any) { return json(res, 400, { error: e.message }); }
      }
      // links in emails get prefetched by mail scanners: GET only shows a button, the POST does the work
      if ((p === "/v1/email/confirm" || p === "/v1/email/unsub") && (req.method === "GET" || req.method === "POST")) {
        const t = (url.searchParams.get("t") || "").replace(/[^\w-]/g, ""), conf = p.endsWith("confirm");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        if (req.method === "GET") return res.end(mail.page(conf ? "Confirm your daily summary" : "Unsubscribe", `<form method="post" action="${p}?t=${t}"><p>${conf ? "Send me a short Caldera summary on days something happens." : "Stop sending Caldera summary emails to this address."}</p><button class="btn" type="submit">${conf ? "Yes, subscribe me" : "Unsubscribe"}</button></form>`));
        if (conf) { const ok = mail.confirm(t); return res.end(mail.page(ok ? "You're subscribed" : "Link expired", ok ? "<p>Your daily Caldera summary starts with the next one. It only comes on days something happens, and every email has a one-click unsubscribe.</p>" : "<p>This confirmation link isn't valid any more. Ask for a new one from Caldera.</p>")); }
        mail.unsubToken(t);   // idempotent; also the RFC 8058 one-click POST from the List-Unsubscribe header
        return res.end(mail.page("You're unsubscribed", "<p>No more Caldera summary emails will go to this address. You can turn them back on any time from Caldera.</p>"));
      }

      // Owner-only activity for the private view inside Obsidian: who looked, what they read, gravity, new friends, links in.
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/activity$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle) return json(res, 404, { error: "publish your profile first" });
        const since = url.searchParams.get("since") || new Date(Date.now() - 86400_000).toISOString();
        const h = pr.handle as string;
        const v = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(h, since) as any;
        const pages = (q("SELECT path, COUNT(*) n FROM page_views WHERE handle=? AND ts > ? GROUP BY path ORDER BY n DESC LIMIT 8").all(h, since) as any[]).map(r => [r.path, r.n]);
        const d14 = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
        const days = (q("SELECT substr(ts,1,10) d, COUNT(*) n, COUNT(DISTINCT visitor) u FROM page_views WHERE handle=? AND ts >= ? GROUP BY d ORDER BY d").all(h, d14) as any[]).map(r => [r.d, r.n, r.u]);
        const total = (q("SELECT COUNT(*) n FROM page_views WHERE handle=?").get(h) as any).n;
        const hn = (id: string) => (profile(id)?.handle as string) || null;
        const gravity = (q("SELECT sender, reason, ts FROM gravity WHERE recipient=? AND ts > ? ORDER BY ts DESC LIMIT 20").all(m[1], since) as any[]).map(r => ({ from: hn(r.sender), reason: r.reason || "", ts: r.ts }));
        const friends = (q("SELECT a, b, ts FROM friends WHERE (a=? OR b=?) AND ts > ? ORDER BY ts DESC LIMIT 20").all(m[1], m[1], since) as any[]).map(r => ({ handle: hn(r.a === m![1] ? r.b : r.a), ts: r.ts }));
        const links = (q("SELECT src_handle, src_slug, src_title, dst_slug FROM garden_links WHERE dst_handle=? AND src_handle<>? LIMIT 20").all(h, h) as any[]);
        const asks = (q("SELECT title, status, ts FROM asks WHERE author=? ORDER BY ts DESC LIMIT 10").all(m[1]) as any[]);
        const pv = q("SELECT ts FROM owner_private WHERE owner=?").get(m[1]) as any;
        return json(res, 200, { since, handle: h, views: v.n, visitors: v.u, pages, days, totalViews: total, gravity, friends, links, asks, privateUrl: privateFor(h), privatePushed: pv?.ts });
      }
      // The owner's private layer, pushed from Obsidian for their private (Tailscale-only) address. Encrypted at rest.
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/private$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle || !privateFor(pr.handle)) return json(res, 403, { error: "no private address is set up for this profile on this hub" });
        const { html, built, pages, v } = await readBody(req) as { html?: string; built?: string; pages?: Record<string, unknown>; v?: string };
        const newer = staleClient(m[1], "private", v); if (newer) return json(res, 409, { error: `Caldera ${newer} already pushed this; update Caldera here (you have ${v || "an older version"})` });
        if (typeof html !== "string" || html.length > 3_000_000) return json(res, 400, { error: "bad private layer" });
        const priv: Record<string, string> = {};   // private versions of whole pages (only the city, for now)
        for (const [k, v] of Object.entries(pages || {})) if (k === "city.html" && typeof v === "string" && v.length < 4_000_000) priv[k] = v;
        q("INSERT OR REPLACE INTO owner_private VALUES (?,?,?,?)").run(m[1], seal(JSON.stringify({ layer: html, pages: priv })), String(built || now()).slice(0, 40), now());
        return json(res, 200, { ok: true, url: privateFor(pr.handle) });
      }

      // live traffic: the owner registers their sites (one key per district); the hub hands back each site's server secret
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/sites$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const { sites, repos } = await readBody(req) as { sites?: { key?: string; project?: string; public?: boolean }[]; repos?: Record<string, string> };
        if (!Array.isArray(sites) || sites.length > 60) return json(res, 400, { error: "send up to 60 sites" });
        const keep = new Set<string>();
        for (const s of sites) {
          const key = String(s.key || ""), project = String(s.project || "").trim().slice(0, 80);
          if (!/^[a-z0-9]{12,32}$/.test(key) || !project) continue;
          const row = q("SELECT owner FROM traffic_sites WHERE key=?").get(key) as any;
          if (row && row.owner !== m[1]) continue;   // someone else's key
          if (row) q("UPDATE traffic_sites SET project=?, public=? WHERE key=?").run(project, s.public ? 1 : 0, key);
          else q("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run(key, m[1], project, s.public ? 1 : 0, crypto.randomBytes(18).toString("hex"), now());
          keep.add(key);
        }
        for (const r of sitesOf(m[1])) if (!keep.has(r.key)) { q("DELETE FROM traffic_sites WHERE key=?").run(r.key); q("DELETE FROM traffic WHERE key=?").run(r.key); }
        // agents: one key per owner; the repo -> district map arrives hashed (the hub never needs private repo names to place a drone)
        const rmap: Record<string, string> = {};
        for (const [h, pj] of Object.entries(repos && typeof repos === "object" ? repos : {}).slice(0, 2000)) if (/^[0-9a-f]{16}$/.test(h)) rmap[h] = String(pj).slice(0, 80);
        let ak = q("SELECT key, secret FROM agent_keys WHERE owner=?").get(m[1]) as any;
        if (!ak) { ak = { key: crypto.randomBytes(9).toString("hex"), secret: crypto.randomBytes(18).toString("hex") }; q("INSERT INTO agent_keys VALUES (?,?,?,?,?)").run(ak.key, m[1], ak.secret, JSON.stringify(rmap), now()); }
        else if (repos) q("UPDATE agent_keys SET repos=? WHERE owner=?").run(JSON.stringify(rmap), m[1]);
        return json(res, 200, { sites: q("SELECT key, project, public, secret FROM traffic_sites WHERE owner=?").all(m[1]), agent: { key: ak.key, secret: ak.secret } });
      }
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/live$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        return json(res, 200, liveStats(m[1], true) || { at: now(), private: true, districts: {}, events: [] });
      }
      m = p.match(/^\/v1\/live\/([a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = byHandle(m[1]); if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, liveStats(pr.id, false) || { at: now(), districts: {} });
      }
      // the pixel: GET /v1/t/KEY.gif?k=view|signup|buy (also POST, for sendBeacon)
      m = p.match(/^\/v1\/t\/([a-z0-9]{12,32})(?:\.gif)?$/);
      if ((req.method === "GET" || req.method === "POST") && m) {
        const ua = String(req.headers["user-agent"] || ""), kind = ["signup", "buy"].includes(url.searchParams.get("k") || "") ? url.searchParams.get("k")! : "view";
        if (ua && !BOT_UA.test(ua) && q("SELECT 1 FROM traffic_sites WHERE key=?").get(m[1])) {
          const day = new Date().toISOString().slice(0, 10);
          try { record(m[1], kind, crypto.createHash("sha256").update(VIEW_SALT + day + ipOf(req) + ua).digest("hex").slice(0, 16)); } catch { /* never break the site */ }
        }
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
        return res.end(PIXEL);
      }
      // agents report what they're doing: POST /v1/agents/KEY  { agents: [{ id, label, machine, repo, state, task, did, tokens }] }
      m = p.match(/^\/v1\/agents\/([0-9a-f]{18})$/);
      if (req.method === "POST" && m) {
        const ak = q("SELECT owner, secret FROM agent_keys WHERE key=?").get(m[1]) as any;
        const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, "")), want = Buffer.from(String(ak?.secret || "x"));
        if (!ak || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 401, { error: "bad agent key or secret" });
        const { agents } = await readBody(req) as { agents?: any[] };
        if (!Array.isArray(agents) || agents.length > 50) return json(res, 400, { error: "send up to 50 agents" });
        const STATES = ["working", "thinking", "waiting", "idle", "done"], cut = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);
        let n = 0;
        for (const a of agents) {
          const id = cut(a?.id, 40); if (!/^[\w.:-]{4,40}$/.test(id)) continue;
          if (a.state === "gone") { q("DELETE FROM agents WHERE owner=? AND id=?").run(ak.owner, id); continue; }
          // details (label, machine, repo, task, last step) are sealed at rest; only the repo's hash stays readable, to place the drone
          const detail = seal(JSON.stringify({ label: cut(a.label, 60), machine: cut(a.machine, 40), repo: cut(a.repo, 80), task: cut(a.task, 90), did: cut(a.did, 90) }));
          q("INSERT OR REPLACE INTO agents VALUES (?,?,?,?,?,?,?,?,?,?)").run(ak.owner, id, "", "", a.repo ? repoHash(cut(a.repo, 80)) : "", STATES.includes(a.state) ? a.state : "working",
            detail, "", Math.max(0, Math.min(1e12, Number(a.tokens) || 0)), now()); n++;
        }
        q("DELETE FROM agents WHERE ts < ?").run(new Date(Date.now() - DAY).toISOString());
        return json(res, 200, { ok: true, recorded: n });
      }
      // server-side events from the owner's own feed: POST /v1/t/KEY/events  { events: [{ k, ts, v }] }  with the site secret
      m = p.match(/^\/v1\/t\/([a-z0-9]{12,32})\/events$/);
      if (req.method === "POST" && m) {
        const site = q("SELECT secret FROM traffic_sites WHERE key=?").get(m[1]) as any;
        const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, "")), want = Buffer.from(String(site?.secret || "x"));
        if (!site || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 401, { error: "bad site key or secret" });
        const { events } = await readBody(req) as { events?: { k?: string; ts?: string; v?: string }[] };
        if (!Array.isArray(events) || events.length > 1000) return json(res, 400, { error: "send up to 1000 events" });
        const lo = Date.now() - DAY, hi = Date.now() + 60_000, day = new Date().toISOString().slice(0, 10); let n = 0;
        for (const e of events) {
          const t = Date.parse(String(e.ts || "")); if (!(t > lo && t < hi)) continue;
          const kind = ["view", "signup", "buy"].includes(String(e.k)) ? String(e.k) : "view";
          if (record(m[1], kind, crypto.createHash("sha256").update(VIEW_SALT + day + String(e.v || "")).digest("hex").slice(0, 16), new Date(t).toISOString())) n++;
        }
        return json(res, 200, { ok: true, recorded: n });
      }

      // open friend requests, both ways: the source of truth for the plugin's "Friend requests" list (a request
      // never depends on the client having kept it); one row per person, newest request wins
      m = p.match(/^\/v1\/requests\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        return json(res, 200, openRequests(m[1]));
      }

      m = p.match(/^\/v1\/inbox\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const since = url.searchParams.get("since") || "1970-01-01";
        const rows = q("SELECT json FROM envelopes WHERE recipient=? AND ts > ? ORDER BY ts LIMIT 500").all(m[1], since) as any[];
        return json(res, 200, { envelopes: rows.map(r => JSON.parse(r.json)) });
      }

      if (req.method === "GET" && p === "/v1/profiles") {
        const term = "%" + (url.searchParams.get("q") || "").toLowerCase() + "%";
        const rows = q(`SELECT id, handle, name, headline, box_key FROM profiles WHERE handle IS NOT NULL AND
          (lower(name) LIKE ? OR lower(handle) LIKE ? OR lower(headline) LIKE ? OR lower(manifest) LIKE ?) ORDER BY updated DESC LIMIT 50`).all(term, term, term, term);
        return json(res, 200, { profiles: (rows as any[]).filter(r => !modOf(r.handle, r.id)) });
      }
      if (req.method === "GET" && p === "/v1/directory") {
        const term = (url.searchParams.get("q") || "").toLowerCase().trim(), sort = url.searchParams.get("sort") || "active";
        const rows = (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed).map(pr => {
          const b = body(pr), avatar = b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
          return { handle: pr.handle, name: pr.name, headline: pr.headline, avatar, topics: (b.topics || []).slice(0, 3).map((t: any) => t[0]),
            week: weekScore(pr.manifest), gravity: gravityOf(pr.id), invited: invitedCount(pr.id), created: pr.created, updated: pr.updated };
        }).filter(r => !term || [r.handle, r.name, r.headline, ...r.topics].join(" ").toLowerCase().includes(term));
        rows.sort(sort === "new" ? (a, b) => String(b.created).localeCompare(String(a.created)) : (a, b) => b.week - a.week || b.gravity - a.gravity);
        return json(res, 200, { total: rows.length, profiles: rows.slice(0, 120) });
      }
      m = p.match(/^\/v1\/profiles\/(cal:[1-9A-HJ-NP-Za-km-z]+|[a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = m[1].startsWith("cal:") ? profile(m[1]) : byHandle(m[1]);
        if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, { id: pr.id, handle: pr.handle, name: pr.name, headline: pr.headline, boxKey: pr.box_key, manifest: JSON.parse(pr.manifest) });
      }

      m = p.match(/^\/v1\/suggest\/(cal:[1-9A-HJ-NP-Za-km-z]+|[a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = m[1].startsWith("cal:") ? profile(m[1]) : byHandle(m[1]);
        if (!pr) return json(res, 404, { error: "not found" });
        return json(res, 200, { suggestions: suggestFor(pr.id, Math.max(1, Math.min(12, Number(url.searchParams.get("n")) || 3))).map(({ score, ...r }) => r) });
      }
      if (req.method === "GET" && p === "/v1/leaderboard") {
        const of = url.searchParams.get("scope") === "friends" ? url.searchParams.get("of") : null;
        return json(res, 200, { scope: of ? "friends" : "global", rows: leaderboard(of) });
      }
      if (req.method === "GET" && p === "/v1/asks") {
        settleExpiredAsks();
        const tag = url.searchParams.get("tag");
        const rows = (q("SELECT a.*, p.handle, p.name FROM asks a LEFT JOIN profiles p ON p.id=a.author WHERE a.status='open' AND a.visibility='public' ORDER BY a.ts DESC LIMIT 100").all() as any[])
          .map(a => ({ ...a, tags: JSON.parse(a.tags) })).filter(a => !tag || a.tags.includes(tag));
        return json(res, 200, { asks: rows });
      }
      if (req.method === "GET" && p === "/v1/offers") {
        const rows = (q("SELECT o.*, p.handle, p.name FROM offers o LEFT JOIN profiles p ON p.id=o.author ORDER BY o.ts DESC LIMIT 100").all() as any[]).map(o => ({ ...o, tags: JSON.parse(o.tags) }));
        return json(res, 200, { offers: rows });
      }
      m = p.match(/^\/v1\/gravity\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        const recent = q("SELECT g.sender, g.ts, g.reason, p.handle, p.name FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? ORDER BY g.ts DESC LIMIT 20").all(m[1]);
        return json(res, 200, { id: m[1], gravity: gravityOf(m[1]), recent });
      }
      m = p.match(/^\/v1\/credits\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        settleExpiredAsks();
        return json(res, 200, { id: m[1], balance: balance(m[1]), ledger: q("SELECT * FROM ledger WHERE who=? ORDER BY ts DESC LIMIT 50").all(m[1]) });
      }
      m = p.match(/^\/v1\/friends\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        const rows = q("SELECT f.b AS id, p.handle, p.name, p.box_key FROM friends f LEFT JOIN profiles p ON p.id=f.b WHERE f.a=?").all(m[1]);
        return json(res, 200, { friends: rows });
      }
      json(res, 404, { error: "not found" });
    } catch (err: any) {
      json(res, err?.message === "too large" ? 413 : 400, { error: String(err?.message || err) });
    }
  });

  // ---------------------------------------------------------------- private owner address
  // Listens on 127.0.0.1 only; meant to sit behind `tailscale serve`, which sets Tailscale-User-Login for the
  // connecting tailnet user (clients can't reach this port directly, so they can't forge the header).
  const privateServer = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("cache-control", "no-store"); res.setHeader("x-robots-tag", "noindex, nofollow");
    try {
      const url = new URL(req.url || "/", "http://private");
      const login = String(req.headers["tailscale-user-login"] || "").toLowerCase();
      const mine = owners[login];
      if (!mine) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Private Caldera address: only the profile owner's Tailscale account can open it."); }
      if (url.pathname.startsWith("/setup/github") && await GH.privateRoute(req, res, url)) return;
      const m = url.pathname.match(/^\/@([a-z0-9-]+)(\/.*)?$/);
      if (!m) { res.writeHead(302, { location: `/@${mine}/` }); return res.end(); }
      if (m[1] !== mine) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("This private address only shows your own profile."); }
      if (!m[2]) { res.writeHead(301, { location: `/@${mine}/${url.search}` }); return res.end(); }
      if (m[2] === "/live.json") {   // the private city polls this; the token in the page stops other sites reading it through your browser
        const t = url.searchParams.get("t") || "", y = new Date(Date.now() - DAY).toISOString().slice(0, 10), pr0 = byHandle(mine);
        if (!pr0 || (t !== liveToken(mine) && t !== liveToken(mine, y))) { res.writeHead(403, { "content-type": "application/json" }); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify(liveStats(pr0.id, url.searchParams.get("view") !== "public") || { at: now(), districts: {} }));
      }
      const dir = path.join(opts.dataDir, "profiles", mine);
      let rel = m[2].slice(1) || "index.html"; if (rel.endsWith("/")) rel += "index.html";
      const file = path.join(dir, path.normalize(rel));
      const pr = byHandle(mine), row = pr ? q("SELECT blob, built FROM owner_private WHERE owner=?").get(pr.id) as any : null;
      const pub = url.searchParams.get("view") === "public";
      let priv: { layer: string; pages: Record<string, string> } = { layer: "", pages: {} };
      if (row) { try { const s = unseal(row.blob); priv = s.startsWith('{"layer"') ? JSON.parse(s) : { layer: s, pages: {} }; } catch { priv = { layer: "<p>Couldn't read the private layer. Push again from Obsidian.</p>", pages: {} }; } }
      const own = !pub && priv.pages[rel];
      if (!own && (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory())) { res.writeHead(404); return res.end("not found"); }
      res.removeHeader("x-frame-options");
      const headers = { "content-type": own ? "text/html; charset=utf-8" : MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-security-policy": PROFILE_CSP };
      if (!own && path.extname(file).toLowerCase() !== ".html") { res.writeHead(200, headers); return fs.createReadStream(file).pipe(res); }
      let html = own || liveBlocks(mine, rel, fs.readFileSync(file, "utf8"));
      const ago = (iso: string) => { const mn = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return mn < 60 ? `${mn} min ago` : mn < 2880 ? `${Math.floor(mn / 60)} h ago` : `${Math.floor(mn / 1440)} days ago`; };
      const tab = (on: boolean, label: string, href: string) => `<a href="${href}" style="padding:5px 12px;border-radius:7px;text-decoration:none;${on ? "background:#8B6CF6;color:#fff" : "color:#B8B8C2"}">${label}</a>`;
      const bar = `<div style="position:sticky;top:0;z-index:60;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 16px;background:#16131F;border-bottom:1px solid #3A2F5C;font:500 13px/1.3 'IBM Plex Sans',Arial,sans-serif;color:#B8B8C2">`
        + `<span style="color:#8B6CF6;font-weight:600">&#128274; Private address</span><span style="display:inline-flex;background:#221D33;border-radius:9px;padding:2px">${tab(!pub, "My view", "?view=mine")}${tab(pub, "Public view", "?view=public")}</span>`
        + `<span>${row ? `Private sections pushed from Obsidian ${ago(row.built)}.` : "No private sections yet: turn on the private address in Caldera settings in Obsidian."} Only your Tailscale account can open this.</span></div>`;
      if (rel === "index.html" && !pub && row) html = html.replace("<!--caldera:owner-->", priv.layer);
      if (rel === "city.html" && pr && (sitesOf(pr.id).length || q("SELECT 1 FROM agent_keys WHERE owner=?").get(pr.id))) { html = injectLive(html, { url: `live.json?t=${liveToken(mine)}${pub ? "&view=public" : ""}`, mode: pub ? "public" : "private" }); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.privateUrl)); }
      html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar) : bar + html;
      res.writeHead(200, headers); return res.end(html);
    } catch (err: any) { res.writeHead(500, { "content-type": "text/plain" }); res.end("error"); }
  });

  return { server, privateServer, db, admin, mail,
    listen: (port = opts.port || 8787, host = process.env.CALDERA_HOST || "127.0.0.1") => new Promise<number>(r => server.listen(port, host, () => r((server.address() as any).port))),
    listenPrivate: (port = opts.privatePort || 0) => new Promise<number>(r => privateServer.listen(port, "127.0.0.1", () => r((privateServer.address() as any).port))) };
}

// CLI: node dist/server.js  (env: CALDERA_DATA, PORT, CALDERA_PUBLIC_URL)
if (import.meta.url === `file://${process.argv[1]}` && /server\.js$/.test(process.argv[1] || "")) {
  // Owner alerts on signups/deletions: Telegram and/or email (Resend). Both optional, fire-and-forget.
  const tg = process.env.CALDERA_TELEGRAM_TOKEN, chat = process.env.CALDERA_TELEGRAM_CHAT, site = process.env.CALDERA_PUBLIC_URL || "https://caldera.social";
  const resend = process.env.CALDERA_RESEND_KEY, mailTo = process.env.CALDERA_NOTIFY_EMAIL, mailFrom = process.env.CALDERA_NOTIFY_FROM || "Caldera <inbox@caldera.social>";
  const onEvent: HubOptions["onEvent"] = (tg && chat) || (resend && mailTo) ? (ev) => {
    const who = ev.handle ? `@${ev.handle}` : "(no handle)";
    const subject = ev.type === "signup" ? `New Caldera profile: ${who} (${ev.total} total)` : `Caldera profile deleted: ${who} (${ev.total} total)`;
    const text = ev.type === "signup" ? `New Caldera profile: ${who}${ev.name ? ` (${ev.name})` : ""}\nTotal profiles: ${ev.total}\n${site}/@${ev.handle || ""}/\n\nAll profiles: ${site}/people.html`
      : `Caldera profile deleted: ${who}. Total profiles: ${ev.total}`;
    const warn = (what: string) => (r: Response) => { if (!r.ok) console.error(what + " notify failed", r.status); };
    if (tg && chat) fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) })
      .then(warn("telegram")).catch(err => console.error("telegram notify error", String(err)));
    if (resend && mailTo) fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + resend, "content-type": "application/json" }, body: JSON.stringify({ from: mailFrom, to: [mailTo], subject, text }) })
      .then(warn("email")).catch(err => console.error("email notify error", String(err)));
  } : undefined;
  const hub = createHub({ dataDir: process.env.CALDERA_DATA || "./data", port: Number(process.env.PORT || 8787), publicUrl: process.env.CALDERA_PUBLIC_URL || "",
    siteDir: process.env.CALDERA_SITE || undefined, trustProxy: process.env.CALDERA_TRUST_PROXY === "1", onEvent,
    email: resend ? { resendKey: resend, schedule: true } : undefined,
    // CALDERA_TAILNET_OWNERS="you@example.com:handle,..."  (Tailscale login -> Caldera handle)
    privatePort: Number(process.env.CALDERA_PRIVATE_PORT) || undefined, privateUrl: process.env.CALDERA_PRIVATE_URL || undefined,
    tailnetOwners: Object.fromEntries((process.env.CALDERA_TAILNET_OWNERS || "").split(",").map(s => s.trim().split(":")).filter(x => x.length === 2 && x[0] && x[1]).map(([l, h]) => [l.toLowerCase(), h.toLowerCase()])) });
  hub.listen().then(p => console.log(`Caldera Hub listening on :${p}`));
  if (process.env.CALDERA_PRIVATE_PORT) hub.listenPrivate().then(p => console.log(`Caldera private owner address on 127.0.0.1:${p}`));
}
