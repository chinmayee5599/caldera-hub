/**
 * Free tools: software members made and give away (apps, CLIs, Obsidian plugins, sites), listed on their profile, as a
 * Workshop in their city, in a Market plaza on the World map, and on /tools. Caldera never hosts the files: every
 * listing links to the maker's own release page or site, with trust signals (source repo, stars, maker's history) and a
 * report button. A member's first listing waits for the founder's approval; later ones go live at once. GitHub-verified
 * members only. "Get it" from a signed-in member counts once and gives the maker gravity.
 */
import type http from "node:http";
import crypto from "node:crypto";

export interface ToolsCtx {
  q: (sql: string) => any; now: () => string; hub: string;
  profile: (id: string) => any; byHandle: (h: string) => any; body: (pr: any) => any; modOf: (h: string | null, id?: string) => any;
  memberOf: (req: http.IncomingMessage) => string | null; sameOrigin: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<any>; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  navify: (html: string, current?: string) => string; tooMany: (key: string, max: number, windowMs?: number) => boolean;
  /** the founder's profile id: approves first listings, removes anything */
  founder: () => string | null;
  /** GitHub-verified (signed up with GitHub, or linked a GitHub account) */
  verified: (id: string) => boolean;
  notify?: (to: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void;
  /** goodwill from a member who got the tool to its maker */
  gravity?: (from: string, to: string, reason: string) => void;
  fetch?: typeof fetch;
  /** something public changed (a listing went live or was removed): drop caches that show tools */
  changed?: () => void;
}

export const PLATFORMS: Record<string, string> = { mac: "Mac", windows: "Windows", linux: "Linux", web: "Web", ios: "iPhone", android: "Android", cli: "Command line", obsidian: "Obsidian plugin", chrome: "Chrome extension" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/;
const TID = /^[0-9a-f]{12}$/;

export interface Tool { id: string; owner: string; name: string; pitch: string; platforms: string; license: string; url: string; repo: string | null;
  status: string; created: string; updated: string; gets: number; stars: number | null; stars_at: string | null }

/** Check a listing from the form. https only; the download link may not point at Caldera itself. */
export function validateTool(b: any, hubHost: string): { ok: true; t: { name: string; pitch: string; platforms: string[]; license: string; url: string; repo: string | null } } | { ok: false; error: string } {
  const name = clean(b?.name, 60), pitch = clean(b?.pitch, 160), license = clean(b?.license, 40) || "Free";
  if (name.length < 2) return { ok: false, error: "Give it a name." };
  if (pitch.length < 10) return { ok: false, error: "Add a one-line pitch: what it does, for whom." };
  const plats = (Array.isArray(b?.platforms) ? b.platforms : String(b?.platforms || "").split(",")).map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => PLATFORMS[x]);
  if (!plats.length) return { ok: false, error: "Pick at least one platform." };
  let url: URL; try { url = new URL(String(b?.url || "").trim()); } catch { return { ok: false, error: "Add the download or release link (https)." }; }
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, error: "The link must start with https://" };
  if (url.hostname === hubHost || url.hostname.endsWith("." + hubHost)) return { ok: false, error: "Link to your own release page or site; Caldera doesn't host downloads." };
  const repoIn = String(b?.repo || "").trim(), repo = repoIn ? (REPO.test(repoIn) ? repoIn.replace(/\/$/, "") : null) : null;
  if (repoIn && !repo) return { ok: false, error: "The source link should be a GitHub repo, like https://github.com/you/tool" };
  return { ok: true, t: { name, pitch, platforms: [...new Set(plats)].slice(0, 4) as string[], license, url: url.toString().slice(0, 300), repo } };
}

export function tools(c: ToolsCtx) {
  const q = c.q, hub = c.hub.replace(/\/$/, ""), hubHost = new URL(hub).hostname;
  q(`CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, owner TEXT, name TEXT, pitch TEXT, platforms TEXT, license TEXT, url TEXT, repo TEXT,
      status TEXT, created TEXT, updated TEXT, gets INTEGER DEFAULT 0, stars INTEGER, stars_at TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS tool_gets (tool TEXT, member TEXT, ts TEXT, PRIMARY KEY (tool, member))`).run();
  q(`CREATE TABLE IF NOT EXISTS tool_reports (tool TEXT, reporter TEXT, reason TEXT, ts TEXT, PRIMARY KEY (tool, reporter))`).run();

  const isFounder = (me: string | null) => !!me && me === c.founder();
  const visible = (pr: any) => !!pr?.handle && !c.modOf(pr.handle, pr.id);
  const toolOf = (id: string) => q("SELECT * FROM tools WHERE id=?").get(id) as Tool | undefined;
  /** live tools, newest first; by one maker, or everyone's (most gotten first) */
  function live(owner?: string): (Tool & { handle: string; makerName: string; since: string })[] {
    const rows = (owner ? q("SELECT * FROM tools WHERE status='live' AND owner=? ORDER BY created DESC").all(owner)
      : q("SELECT * FROM tools WHERE status='live' ORDER BY gets DESC, created DESC LIMIT 200").all()) as Tool[];
    return rows.map(t => { const pr = c.profile(t.owner); return visible(pr) ? { ...t, handle: pr.handle as string, makerName: String(pr.name || pr.handle), since: String(pr.created || "").slice(0, 7) } : null; })
      .filter(Boolean) as any;
  }
  const mine = (me: string) => q("SELECT * FROM tools WHERE owner=? AND status IN ('live','pending') ORDER BY created DESC").all(me) as Tool[];
  const approvedBefore = (me: string) => !!q("SELECT 1 FROM tools WHERE owner=? AND status='live' LIMIT 1").get(me);

  /** GitHub stars for listings with a source repo, refreshed at most daily in the background */
  function freshenStars(t: Tool) {
    if (!t.repo || !c.fetch || (t.stars_at && Date.parse(t.stars_at) > Date.now() - 86_400_000)) return;
    const m = t.repo.match(REPO); if (!m) return;
    q("UPDATE tools SET stars_at=? WHERE id=?").run(c.now(), t.id);
    c.fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { accept: "application/vnd.github+json", "user-agent": "caldera-hub" } })
      .then(r => r.ok ? r.json() : null).then((j: any) => { if (j && typeof j.stargazers_count === "number") q("UPDATE tools SET stars=? WHERE id=?").run(j.stargazers_count, t.id); }).catch(() => {});
  }

  // ---------------------------------------------------------------- writes
  function create(me: string, b: any): { status: number; body: any } {
    const pr = c.profile(me); if (!visible(pr)) return { status: 403, body: { error: "Sign in to list a tool." } };
    if (!c.verified(me) && !isFounder(me)) return { status: 403, body: { error: "Listing tools needs a GitHub-verified account: sign in with GitHub, or link GitHub in Settings." } };
    if (mine(me).length >= 12) return { status: 409, body: { error: "You have 12 tools listed. Remove one to add another." } };
    const v = validateTool(b, hubHost); if (!v.ok) return { status: 400, body: { error: v.error } };
    if (c.tooMany("toolnew:" + me, 5, 86_400_000)) return { status: 429, body: { error: "That's 5 new listings today. Try again tomorrow." } };
    const ts = c.now(), id = crypto.randomBytes(6).toString("hex"), status = isFounder(me) || approvedBefore(me) ? "live" : "pending";
    q("INSERT INTO tools (id,owner,name,pitch,platforms,license,url,repo,status,created,updated,gets) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)")
      .run(id, me, v.t.name, v.t.pitch, v.t.platforms.join(","), v.t.license, v.t.url, v.t.repo, status, ts, ts);
    if (status === "pending") { const f = c.founder(); if (f) c.notify?.(f, { title: `New free tool to review: ${v.t.name}`, body: `@${pr.handle}'s first listing: ${v.t.pitch}\n${v.t.url}`, ctaLabel: "Review", ctaUrl: "/tools#review", key: "toolreview:" + id }); }
    const t = toolOf(id)!; freshenStars(t); if (status === "live") c.changed?.();
    return { status: 200, body: { ok: true, id, status } };
  }
  function decide(me: string, id: string, action: string): { status: number; body: any } {
    const t = toolOf(id); if (!t) return { status: 404, body: { error: "not found" } };
    const owner = t.owner === me, f = isFounder(me);
    if (action === "delete" && (owner || f)) { q("UPDATE tools SET status='removed', updated=? WHERE id=?").run(c.now(), id); c.changed?.(); return { status: 200, body: { ok: true, status: "removed" } }; }
    if (!f || !["approve", "reject"].includes(action)) return { status: 403, body: { error: "not allowed" } };
    const status = action === "approve" ? "live" : "rejected";
    q("UPDATE tools SET status=?, updated=? WHERE id=?").run(status, c.now(), id); c.changed?.();
    c.notify?.(t.owner, status === "live"
      ? { title: `${t.name} is live on Caldera`, body: "Your free tool is on your profile, in your city's Workshop and in the World map's market. New listings go live right away from now on.", ctaLabel: "See it", ctaUrl: "/tools", key: "toollive:" + id }
      : { title: `${t.name} wasn't listed`, body: "Your free tool listing wasn't approved. Reply to the founder in Messages if you think that's a mistake.", key: "toolno:" + id });
    return { status: 200, body: { ok: true, status } };
  }
  function report(me: string, id: string, reason: string): { status: number; body: any } {
    const t = toolOf(id); if (!t || t.status !== "live") return { status: 404, body: { error: "not found" } };
    if (c.tooMany("toolrep:" + me, 10, 86_400_000)) return { status: 429, body: { error: "Too many reports today." } };
    q("INSERT OR IGNORE INTO tool_reports VALUES (?,?,?,?)").run(id, me, clean(reason, 300), c.now());
    const f = c.founder(); const pr = c.profile(me);
    if (f) c.notify?.(f, { title: `Free tool reported: ${t.name}`, body: `Reported by @${pr?.handle || "someone"}: ${clean(reason, 300) || "no reason given"}\n${t.url}`, ctaLabel: "Review", ctaUrl: "/tools#t-" + id, key: "toolrep:" + id });
    return { status: 200, body: { ok: true } };
  }
  /** a signed-in member getting a tool: counts once per member, and gives the maker gravity */
  function got(me: string | null, t: Tool) {
    if (!me || me === t.owner) return;
    try {
      const r = q("INSERT OR IGNORE INTO tool_gets VALUES (?,?,?)").run(t.id, me, c.now());
      if (r.changes) { q("UPDATE tools SET gets=gets+1 WHERE id=?").run(t.id); c.gravity?.(me, t.owner, `got ${t.name}`.slice(0, 140)); }
    } catch { /* counting never blocks the download */ }
  }
  function erase(id: string) { q("UPDATE tools SET status='removed' WHERE owner=?").run(id); q("DELETE FROM tool_gets WHERE member=?").run(id); }

  // ---------------------------------------------------------------- html
  const tile = (name: string) => { const h = parseInt(crypto.createHash("md5").update(name).digest("hex").slice(0, 6), 16), hue = h % 360;
    return `<span class="tl-tile" style="background:hsl(${hue} 55% 42%)" aria-hidden="true">${esc(name.trim().charAt(0).toUpperCase())}</span>`; };
  function card(t: Tool & { handle?: string; makerName?: string; since?: string }, o: { maker?: boolean; viewer?: string | null; review?: boolean } = {}) {
    const plats = t.platforms.split(",").filter(Boolean).map(p => `<span class="tl-chip">${esc(PLATFORMS[p] || p)}</span>`).join("");
    const trust = [t.repo ? `<a href="${esc(t.repo)}" target="_blank" rel="noopener nofollow">Open source${t.stars ? ` &middot; &#9733; ${t.stars.toLocaleString("en-US")}` : ""}</a>` : `<span>Closed source</span>`,
      esc(t.license), t.gets ? `${t.gets} ${t.gets === 1 ? "member got it" : "members got it"}` : ""].filter(Boolean).join(" &middot; ");
    const own = o.viewer && o.viewer === t.owner, f = isFounder(o.viewer || null);
    const acts = [`<a class="tl-get" href="${hub}/tools/go/${t.id}" target="_blank" rel="noopener nofollow">Get it &#8599;</a>`,
      o.review ? `<button type="button" class="tl-btn" data-act="approve" data-id="${t.id}">Approve</button><button type="button" class="tl-btn ghost" data-act="reject" data-id="${t.id}">Reject</button>` : "",
      own || f ? `<button type="button" class="tl-btn ghost" data-act="delete" data-id="${t.id}">Remove</button>` : o.viewer ? `<button type="button" class="tl-link" data-act="report" data-id="${t.id}">Report</button>` : ""].join("");
    return `<article class="tl-card" id="t-${t.id}">${tile(t.name)}<div class="tl-m"><div class="tl-top"><b>${esc(t.name)}</b>${t.status === "pending" ? `<span class="tl-chip warn">Waiting for review</span>` : ""}</div>`
      + `<p>${esc(t.pitch)}</p><div class="tl-chips">${plats}</div><div class="tl-trust">${trust}</div>`
      + (o.maker && t.handle ? `<div class="tl-trust">by <a href="${hub}/@${esc(t.handle)}/">${esc(t.makerName || "@" + t.handle)}</a> &middot; on Caldera since ${esc(t.since || "")}</div>` : "")
      + `<div class="tl-acts">${acts}</div></div></article>`;
  }
  const CSS = `.tl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin:16px 0}
.tl-card{display:flex;gap:14px;padding:16px;border:1px solid var(--line,#2a2a2e);border-radius:14px;background:var(--bg-raised,#1d1d21)}
.tl-tile{flex:none;width:48px;height:48px;border-radius:12px;display:grid;place-items:center;color:#fff;font:700 22px var(--font-body,'IBM Plex Sans',Arial,sans-serif)}
.tl-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}.tl-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tl-top b{color:var(--text-strong,#f2f2f5);font-size:16px}
.tl-m p{margin:0;font-size:14px;color:var(--text,#dadadf)}.tl-chips{display:flex;flex-wrap:wrap;gap:6px}
.tl-chip{font:500 11.5px var(--font-mono,'IBM Plex Mono',monospace);padding:2px 8px;border-radius:999px;background:var(--accent-soft,rgba(139,108,246,.12));color:var(--accent-text,#b39dfa)}.tl-chip.warn{background:rgba(232,197,71,.15);color:#E8C547}
.tl-trust{font-size:12.5px;color:var(--text-muted,#8a8a93)}.tl-trust a{color:inherit}
.tl-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}
.tl-get{display:inline-flex;align-items:center;min-height:36px;padding:0 16px;border-radius:999px;background:#7a58f0;color:#fff;font-weight:600;font-size:14px;text-decoration:none}.tl-get:hover{filter:brightness(1.08);text-decoration:none}
.tl-btn{min-height:32px;padding:0 12px;border-radius:999px;border:0;background:#7a58f0;color:#fff;font:600 13px var(--font-body,'IBM Plex Sans',Arial,sans-serif);cursor:pointer}.tl-btn.ghost{background:transparent;border:1px solid var(--line-strong,#3a3a40);color:var(--text,#dadadf)}
.tl-link{all:unset;cursor:pointer;font-size:12.5px;color:var(--text-muted,#8a8a93);padding:6px 4px}.tl-link:hover{text-decoration:underline}
.tl-filters{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}.tl-filters a{padding:6px 12px;border-radius:999px;border:1px solid var(--line,#2a2a2e);font-size:13px;color:var(--text,#dadadf);text-decoration:none}.tl-filters a.on{background:var(--accent-soft,rgba(139,108,246,.14));border-color:#7a58f0;color:var(--text-strong,#fff)}
.tl-form{display:grid;gap:12px;padding:18px;border:1px solid var(--line,#2a2a2e);border-radius:14px;margin:12px 0 24px;background:var(--bg-raised,#1d1d21)}
.tl-form label{display:grid;gap:5px;font-size:13px;font-weight:600;color:var(--text-strong,#f2f2f5)}.tl-form label span{font-weight:400;color:var(--text-muted,#8a8a93)}
.tl-form input{height:40px;padding:0 12px;border-radius:9px;border:1px solid var(--line-strong,#3a3a40);background:var(--bg,#1c1c1f);color:var(--text-strong,#f2f2f5);font:15px var(--font-body,'IBM Plex Sans',Arial,sans-serif)}
.tl-plats{display:flex;flex-wrap:wrap;gap:8px}.tl-plats label{display:inline-flex;flex-direction:row;align-items:center;gap:6px;font-weight:500;padding:6px 10px;border:1px solid var(--line,#2a2a2e);border-radius:999px;cursor:pointer}
.tl-msg{margin:0;font-size:14px}.tl-msg.err{color:#f0716a}.tl-msg.ok{color:#4FB89A}
.tl-note{font-size:13px;color:var(--text-muted,#8a8a93);max-width:70ch}
.tl-sec{margin:26px 0}.tl-sec h2{font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#8a8a93);margin:0 0 6px}`;
  const JS = `(function(){function post(u,o){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(o||{})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})}
document.addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('[data-act]');if(!b)return;var id=b.getAttribute('data-id'),a=b.getAttribute('data-act'),why='';
if(a==='report'){b.textContent='Reported';b.disabled=true;post('/v1/tools/'+id+'/report',{reason:'reported from the tools page'});return}
if(a==='delete'&&!b.dataset.sure){b.dataset.sure='1';b.textContent='Remove? Tap again';return}
b.disabled=true;post('/v1/tools/'+id+'/'+a,{}).then(function(x){if(x.ok)location.reload();else{b.disabled=false;b.textContent=x.j.error||'Try again'}})});
var f=document.getElementById('tl-form');if(f)f.addEventListener('submit',function(ev){ev.preventDefault();var m=document.getElementById('tl-msg'),d={name:f.name.value,pitch:f.pitch.value,url:f.url.value,repo:f.repo.value,license:f.license.value,platforms:[].map.call(f.querySelectorAll('input[name=plat]:checked'),function(x){return x.value})};
var s=f.querySelector('button[type=submit]');s.disabled=true;post('/v1/tools',d).then(function(x){s.disabled=false;if(!x.ok){m.className='tl-msg err';m.textContent=x.j.error||'Could not save that.';return}
m.className='tl-msg ok';m.textContent=x.j.status==='pending'?'Saved. Your first listing goes live once it is reviewed (usually within a day).':'Listed. It is live now.';setTimeout(function(){location.reload()},1400)},function(){s.disabled=false;m.className='tl-msg err';m.textContent='Could not reach Caldera.'})})})();`;

  function form(me: string) {
    if (!c.verified(me) && !isFounder(me)) return `<p class="tl-note">Listing tools needs a GitHub-verified account. <a href="${hub}/settings#connections">Link GitHub in Settings</a>.</p>`;
    const plats = Object.entries(PLATFORMS).map(([k, v]) => `<label><input type="checkbox" name="plat" value="${k}">${esc(v)}</label>`).join("");
    return `<form class="tl-form" id="tl-form" novalidate><label>Name<input name="name" maxlength="60" required placeholder="Dictate"></label>
<label>One-line pitch<span>What it does and who it's for</span><input name="pitch" maxlength="160" required placeholder="Push-to-talk dictation for Mac that runs fully on your computer"></label>
<div><div style="font-size:13px;font-weight:600;margin-bottom:6px">Platforms</div><div class="tl-plats">${plats}</div></div>
<label>Download or release page<span>Your GitHub release or your own site. Caldera links to it; it never hosts files.</span><input name="url" type="url" required placeholder="https://github.com/you/tool/releases"></label>
<label>Source code <span>optional: a public GitHub repo shows people they can check what they run</span><input name="repo" type="url" placeholder="https://github.com/you/tool"></label>
<label>License <span>optional, e.g. MIT, free to use</span><input name="license" maxlength="40" placeholder="Free"></label>
<button type="submit" class="tl-btn" style="justify-self:start;min-height:40px;padding:0 20px">List it</button><p class="tl-msg" id="tl-msg" role="status"></p></form>`;
  }

  function page(me: string | null, platform: string) {
    const all = live(), list = platform && PLATFORMS[platform] ? all.filter(t => t.platforms.split(",").includes(platform)) : all;
    all.slice(0, 40).forEach(freshenStars);
    const filters = `<nav class="tl-filters" aria-label="Platform"><a href="/tools"${!platform ? ' class="on"' : ""}>All (${all.length})</a>${Object.entries(PLATFORMS)
      .filter(([k]) => all.some(t => t.platforms.split(",").includes(k))).map(([k, v]) => `<a href="/tools?platform=${k}"${platform === k ? ' class="on"' : ""}>${esc(v)}</a>`).join("")}</nav>`;
    const review = isFounder(me) ? (q("SELECT * FROM tools WHERE status='pending' ORDER BY created").all() as Tool[]).map(t => { const pr = c.profile(t.owner); return pr ? card({ ...t, handle: pr.handle, makerName: pr.name, since: String(pr.created || "").slice(0, 7) }, { maker: true, viewer: me, review: true }) : ""; }).join("") : "";
    const own = me ? mine(me).filter(t => t.status === "pending").map(t => card(t, { viewer: me })).join("") : "";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Free tools - Caldera</title>
<meta name="description" content="Free software made by Caldera members: apps, command-line tools, Obsidian plugins and more. Every download links to the maker's own release."><style>${CSS}</style></head>
<body><main class="wrap" style="max-width:1080px;margin:0 auto;padding:28px 20px 60px"><h1 style="margin:0">Free tools</h1>
<p class="lede" style="max-width:68ch">Software Caldera members made and give away. Each listing links to the maker's own release, so you download from the source. Look for the open-source badge to see the code first.</p>
${review ? `<section class="tl-sec" id="review"><h2>Waiting for your review</h2><div class="tl-grid">${review}</div></section>` : ""}
${filters}<div class="tl-grid">${list.map(t => card(t, { maker: true, viewer: me })).join("") || `<p class="tl-note">No tools here yet.</p>`}</div>
<section class="tl-sec" id="list"><h2>List your tool</h2>${me ? (own ? `<div class="tl-grid">${own}</div>` : "") + form(me) : `<p class="tl-note">Made something free? <a href="/signin?back=%2Ftools">Sign in</a> to list it on your profile, in your city's Workshop and in the World market.</p>`}
<p class="tl-note">Free tools only. Caldera doesn't host or check downloads: they come from the maker's link. A member's first listing is reviewed before it goes live. See something wrong? Use Report.</p></section>
</main><script>${JS}</script></body></html>`;
    return c.navify(html, "/tools");
  }

  /** the "Free tools" section on a profile page (index.html), inserted by the hub */
  function profileBlock(ownerId: string): string {
    const ts = live(ownerId); if (!ts.length) return "";
    return `<!--caldera:tools--><section class="section" id="free-tools"><style>${CSS}</style><h2>Free tools</h2><div class="tl-grid">${ts.map(t => card(t)).join("")}</div>`
      + `<p class="tl-note"><a href="${hub}/tools">More free tools from Caldera members &rarr;</a></p></section>`;
  }
  /** data for the map renderer: a maker's city (their tools) or the World market (everyone's, most gotten first) */
  function mapData(ownerId?: string) {
    return (ownerId ? live(ownerId) : live().slice(0, 24)).map(t => ({ id: t.id, name: t.name, pitch: t.pitch, handle: t.handle,
      platform: t.platforms.split(",").map(p => PLATFORMS[p] || p).join(", "), repo: !!t.repo }));
  }

  // ---------------------------------------------------------------- routes
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    const me = c.memberOf(req);
    if (req.method === "GET" && (p === "/tools" || p === "/tools/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Cookie" });
      res.end(page(me, String(url.searchParams.get("platform") || "").toLowerCase())); return true;
    }
    let m = p.match(/^\/tools\/go\/([0-9a-f]{12})$/);
    if (req.method === "GET" && m) {
      const t = toolOf(m[1]), pr = t ? c.profile(t.owner) : null;
      if (!t || t.status !== "live" || !visible(pr)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("That tool isn't listed any more."); return true; }
      got(me, t);
      res.writeHead(302, { location: t.url, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(); return true;
    }
    if (req.method === "GET" && p === "/v1/tools") {
      res.setHeader("cache-control", "public, max-age=60");
      const owner = String(url.searchParams.get("owner") || "").toLowerCase().replace(/^@/, ""), pr = owner ? c.byHandle(owner) : null;
      c.json(res, 200, { tools: (owner ? (pr ? live(pr.id) : []) : live()).map(t => ({ id: t.id, name: t.name, pitch: t.pitch, platforms: t.platforms.split(","), license: t.license,
        url: `${hub}/tools/go/${t.id}`, repo: t.repo, stars: t.stars, gets: t.gets, maker: t.handle, created: t.created })) }); return true;
    }
    if (req.method === "POST" && /^\/v1\/tools(\/|$)/.test(p)) {
      if (!me) { c.json(res, 401, { error: "Sign in first." }); return true; }
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const b = await c.readBody(req).catch(() => ({}));
      if (p === "/v1/tools") { const r = create(me, b || {}); c.json(res, r.status, r.body); return true; }
      m = p.match(/^\/v1\/tools\/([0-9a-f]{12})\/(approve|reject|delete|report)$/);
      if (m && TID.test(m[1])) { const r = m[2] === "report" ? report(me, m[1], String(b?.reason || "")) : decide(me, m[1], m[2]); c.json(res, r.status, r.body); return true; }
      c.json(res, 404, { error: "not found" }); return true;
    }
    return false;
  }

  /** feed items: new free tools */
  function feedItems() {
    return (q("SELECT * FROM tools WHERE status='live' ORDER BY created DESC LIMIT 50").all() as Tool[]).map(t => ({ owner: t.owner, ts: t.created, name: t.name, id: t.id }));
  }
  return { route, profileBlock, mapData, feedItems, erase, live, create, decide };
}
