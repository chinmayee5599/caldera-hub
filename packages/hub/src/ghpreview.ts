/**
 * caldera.social/gh/<login>: anyone's PUBLIC GitHub drawn as a Caldera city, before they join. Built only from public
 * GitHub data (profile, owned non-fork public repos, commit activity), cached on disk for a day, never storing emails.
 * Members' logins go straight to their real city. Also the README badge (/gh/<login>/badge.svg and /@<handle>/badge.svg).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { cityData, renderCity, citySnapshot, type CityRepo, type CityData } from "../../../../caldera/packages/plugin/src/city";
import THEME_CSS from "../../../../caldera/packages/plugin/src/assets/theme.css";
import { PROFILE_CSS } from "../../../../caldera/packages/plugin/src/profile.css";
import { cityArt, cardSvg, toPng, ogTags } from "./cards";

export interface GhPreviewCtx {
  dataDir: string; hub: () => string; fetch: typeof fetch; token: () => Promise<string | null>;
  header: string; tooMany: (key: string, max: number, windowMs?: number) => boolean; ipOf: (req: http.IncomingMessage) => string;
  /** the member handle that owns this GitHub login, if any */
  memberOf: (login: string) => string | null;
  /** a member's public city (already projected by their private-repos setting) */
  memberCity: (handle: string) => CityData | null;
  pause?: number;
}
interface Preview { login: string; name: string; bio: string; html_url: string; fetched: string; city: CityData; repos: number; commits: number }
type Got = { ok: true; p: Preview } | { ok: false; status: 404 | 422 | 429 | 502; why: string };

export const LOGIN_RX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DAY = 86_400_000;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fmt = (n: number) => n.toLocaleString("en-US");
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** stats a badge shows: public repos and commits in the last year (public repos only) */
export function cityStats(city: CityData): { repos: number; commits: number } {
  const pub = city.districts.flatMap(d => d.repos).filter(r => !r.locked && r.public !== false);
  return { repos: pub.length, commits: pub.reduce((a, r) => a + (r.commits || 0), 0) };
}

/** The README badge. flat: a 28px shields-style pill; card: a 420x92 mini skyline with the numbers. */
export function badgeSvg(o: { who: string; repos: number; commits: number; city?: CityData | null; style?: string }): string {
  const sans = `-apple-system,'Segoe UI',Helvetica,Arial,'DejaVu Sans',sans-serif`;
  const nums = `${fmt(o.repos)} repo${o.repos === 1 ? "" : "s"} · ${fmt(o.commits)} commit${o.commits === 1 ? "" : "s"}/yr`;
  const logo = (x: number, y: number, s: number) => `<g transform="translate(${x} ${y}) scale(${s / 32})"><path d="M3 26 L11 10 L14 15 L17 8 L29 26 Z" fill="#A58BFA"/><circle cx="16" cy="21" r="2.4" fill="#4FB89A"/></g>`;
  if (o.style !== "card") {
    const left = "GitHub city", lw = Math.round(left.length * 6.6 + 34), rw = Math.round(nums.length * 6.3 + 20), W = lw + rw;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="28" viewBox="0 0 ${W} 28" role="img" aria-label="${esc(left)}: ${esc(nums)}"><title>${esc(o.who)}'s GitHub city on Caldera: ${esc(nums)}</title>
<clipPath id="r"><rect width="${W}" height="28" rx="6"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="28" fill="#1C1730"/><rect x="${lw}" width="${rw}" height="28" fill="#6D4AE8"/></g>
${logo(8, 5, 18)}<g font-family="${sans}" font-size="12" font-weight="600"><text x="30" y="18.5" fill="#F2F2F5">${esc(left)}</text><text x="${lw + 10}" y="18.5" fill="#FFFFFF">${esc(nums)}</text></g></svg>`;
  }
  // card: the tallest buildings as a little skyline (heights by commits, windows lit for this week's work)
  const repos = (o.city?.districts.flatMap(d => d.repos) || []).filter(r => !r.locked && r.public !== false).sort((a, b) => b.commits - a.commits).slice(0, 14);
  const max = Math.max(1, ...repos.map(r => r.commits)), W = 420, H = 92, base = 78, colors = ["#3178C6", "#E8C547", "#4FB89A", "#E07A4F", "#8B6CF6", "#F05138", "#8A8A93"];
  const lang = (l: string) => colors[["TypeScript", "JavaScript", "Python", "HTML", "Rust", "Swift"].indexOf(l)] ?? colors[6];
  const order: CityRepo[] = []; repos.forEach((r, i) => i % 2 ? order.push(r) : order.unshift(r));   // tallest in the middle
  let x = 14; const bw = 9, gap = 3; const bars: string[] = [];
  for (const r of order) {
    const h = Math.max(8, Math.round(Math.sqrt(r.commits / max) * 56)), y = base - h;
    let win = ""; for (let wy = y + 4; wy < base - 4; wy += 6) win += `<rect x="${x + 2}" y="${wy}" width="2" height="2" fill="${r.week > 0 ? "#FFD98A" : "#0A101E"}" fill-opacity="${r.week > 0 ? 0.95 : 0.5}"/><rect x="${x + 5}" y="${wy}" width="2" height="2" fill="${r.week > 0 ? "#FFD98A" : "#0A101E"}" fill-opacity="${r.week > 0 ? 0.8 : 0.5}"/>`;
    bars.push(`<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="1" fill="${lang(r.language)}"/>${win}`); x += bw + gap;
  }
  if (!bars.length) bars.push(`<text x="20" y="60" font-family="${sans}" font-size="11" fill="#8A8A93">no public repos yet</text>`);
  const tx = Math.max(x + 14, 150);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.who)}'s GitHub city: ${esc(nums)}"><title>${esc(o.who)}'s GitHub city on Caldera</title>
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151227"/><stop offset="1" stop-color="#231C3D"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="12" fill="url(#sky)"/><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11.5" fill="none" stroke="#3A2F5C"/>
<rect x="10" y="${base}" width="${Math.max(40, x - 6)}" height="2" rx="1" fill="#3A2F5C"/>${bars.join("")}
<g font-family="${sans}"><text x="${tx}" y="34" font-size="15" font-weight="700" fill="#F2F2F5">${esc(o.who.length > 22 ? o.who.slice(0, 21) + "…" : o.who)}</text>
<text x="${tx}" y="54" font-size="12.5" fill="#C9C2E8">${esc(nums)}</text>
<text x="${tx + 16}" y="75" font-size="11" fill="#9D8CE0">GitHub city on Caldera</text></g>${logo(tx - 2, 63, 15)}</svg>`;
}

export function ghPreview(c: GhPreviewCtx) {
  const dir = path.join(c.dataDir, "gh-preview");
  const file = (login: string, ext: string) => path.join(dir, login.toLowerCase() + ext);
  const inflight = new Map<string, Promise<Got>>(); let running = 0; const waiters: (() => void)[] = [];

  async function gh(token: string | null, p: string): Promise<{ status: number; body: any }> {
    const r = await c.fetch("https://api.github.com" + p, { headers: { accept: "application/vnd.github+json", "user-agent": "caldera-hub", ...(token ? { authorization: "Bearer " + token } : {}) } });
    let body: any = null; try { body = await r.json(); } catch { /* 202 / empty */ }
    return { status: r.status, body };
  }
  function cached(login: string, maxAge = DAY): Preview | { missing: string } | null {
    try { const j = JSON.parse(fs.readFileSync(file(login, ".json"), "utf8")); if (Date.now() - Date.parse(j.fetched) > (j.missing ? 6 * 3600_000 : maxAge)) return null; return j; } catch { return null; }
  }
  async function build(login: string): Promise<Got> {
    const token = await c.token().catch(() => null);
    const u = await gh(token, `/users/${encodeURIComponent(login)}`);
    if (u.status === 404) return { ok: false, status: 404, why: "missing" };
    if (u.status !== 200 || !u.body?.login) return { ok: false, status: 502, why: "github" };
    if (u.body.type !== "User") return { ok: false, status: 422, why: "org" };
    const me = u.body, repos: any[] = [];
    for (let pg = 1; pg <= 1; pg++) { const r = await gh(token, `/users/${encodeURIComponent(me.login)}/repos?type=owner&sort=pushed&per_page=100&page=${pg}`); if (r.status !== 200 || !Array.isArray(r.body)) break; repos.push(...r.body); }
    const own = repos.filter(r => !r.fork && !r.private && !r.archived).slice(0, 100);
    const stats: Record<string, { weeks: number[]; commits: number; week: number }> = {};
    for (const r of own.slice(0, 20)) {
      try { const w = await gh(token, `/repos/${r.full_name}/stats/commit_activity`);
        if (w.status === 200 && Array.isArray(w.body) && w.body.length) { const t52 = w.body.slice(-52).map((x: any) => Number(x.total) || 0); stats[r.full_name] = { weeks: t52.slice(-12), commits: t52.reduce((a: number, b: number) => a + b, 0), week: Number(w.body[w.body.length - 1].total) || 0 }; } } catch { /* fall back */ }
      if (c.pause) await new Promise(r => setTimeout(r, c.pause));
    }
    const cityRepos: CityRepo[] = own.map(r => { const s = stats[r.full_name];
      return { name: r.name, project: r.language || "Other", public: true, language: r.language || "Other", commits: s ? s.commits : (r.size ? 1 : 0), weeks: s?.weeks || [], week: s?.week || 0, today: 0,
        pushed: r.pushed_at, created: r.created_at, size: r.size, url: r.html_url, description: String(r.description || "").slice(0, 200) }; });
    const city = cityData(cityRepos, () => ({ n: 0, paths: [] }), new Date().toISOString());
    city.private = false;   // public data only: no "private view" wording
    const st = cityStats(city);
    // only public profile fields we show; never the email
    const p: Preview = { login: me.login, name: String(me.name || me.login).slice(0, 80), bio: String(me.bio || "").slice(0, 200), html_url: me.html_url, fetched: new Date().toISOString(), city, repos: st.repos, commits: st.commits };
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(login, ".json"), JSON.stringify(p)); fs.rmSync(file(login, ".png"), { force: true });
    return { ok: true, p };
  }
  /** cached preview, or a fresh build (2 at a time; per-IP and global limits on fresh builds) */
  async function get(login: string, req: http.IncomingMessage | null): Promise<Got> {
    const hit = cached(login);
    if (hit && "missing" in hit) return { ok: false, status: hit.missing === "org" ? 422 : 404, why: hit.missing };
    if (hit) return { ok: true, p: hit };
    const key = login.toLowerCase(), live = inflight.get(key); if (live) return live;
    if (req && (c.tooMany("ghprev:" + c.ipOf(req), 20) || c.tooMany("ghprev:all", 400))) return { ok: false, status: 429, why: "busy" };
    const job = (async (): Promise<Got> => {
      if (running >= 2) await new Promise<void>(r => waiters.push(r));
      running++;
      try {
        const g = await build(login);
        if (!g.ok && (g.why === "missing" || g.why === "org")) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(login, ".json"), JSON.stringify({ missing: g.why, fetched: new Date().toISOString() })); }
        return g;
      } catch (e: any) { console.error("gh preview", login, e?.message); return { ok: false, status: 502, why: "github" }; }
      finally { running--; waiters.shift()?.(); inflight.delete(key); }
    })();
    inflight.set(key, job); return job;
  }

  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer, cache = "no-cache", extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, "cache-control": cache, ...extra }); res.end(body);
  };
  const sitePage = (title: string, inner: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${head}<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>${PAGE_CSS}</style></head><body>${c.header}<main class="ghp-land">${inner}</main><script src="/assets/site.js" defer></script></body></html>`;
  const seeForm = (val = "", big = false) => `<form class="ghp-form${big ? " big" : ""}" method="get" action="/gh" role="search"><label class="vh" for="ghp-u">GitHub username</label><span class="ghp-at">github.com/</span><input id="ghp-u" name="u" value="${esc(val)}" placeholder="username" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="39" pattern="[A-Za-z0-9-]{1,39}" required><button type="submit">See the city</button></form>`;

  function landing(): string {
    const ex = ["torvalds", "sindresorhus", "karpathy", "simonw", "antirez", "tj"];
    return sitePage("See any GitHub as a city - Caldera", `<h1>See any GitHub as a city</h1>
<p class="lede">Type a GitHub username. Every public repo becomes a building: taller means more commits this year, lit windows mean work this week. Built from public data only.</p>
${seeForm("", true)}<p class="ghp-ex">Try: ${ex.map(l => `<a href="/gh/${l}">@${l}</a>`).join(" &middot; ")}</p>
<p class="ghp-small">Want yours to come alive, with live visitors, your AI agents flying over the repos they're working in, and people who build the same things? <a href="/auth/github?back=/me">Sign up with GitHub</a>.</p>`,
      ogTags({ url: `${c.hub()}/gh`, image: `${c.hub()}/world/preview.png`, title: "See any GitHub as a city", description: "Type a GitHub username and walk their public repos as a living city. Caldera, the social network for GitHub and Obsidian." }));
  }
  function notFound(login: string, why: string): string {
    const msg = why === "org" ? `@${esc(login)} is an organization. Org cities aren't supported yet: try a person's username.`
      : why === "busy" ? "Lots of cities are being drawn right now. Try again in a few minutes."
      : why === "github" ? "GitHub didn't answer just now. Try again in a minute."
      : `There's no GitHub user called @${esc(login)}.`;
    return sitePage("GitHub city - Caldera", `<h1>${why === "busy" ? "Busy" : "No city here"}</h1><p class="lede">${msg}</p>${seeForm(why === "missing" ? "" : login, true)}`, `<meta name="robots" content="noindex">`);
  }
  function snippet(target: string, img: string, label: string): string {
    return `[![${label}](${img})](${target})`;
  }
  function previewPage(p: Preview, back: string): string {
    const hub = c.hub(), url = `${hub}/gh/${p.login}`, who = p.name && p.name !== p.login ? `${p.name} (@${p.login})` : `@${p.login}`;
    let html = renderCity({ name: p.name || p.login, github: p.html_url, theme: "dark" }, p.city);
    const md = snippet(url, `${url}/badge.svg?style=card`, "My GitHub city on Caldera"), share = `${who}'s public GitHub as a living city`;
    const banner = `<section class="ghp-banner" aria-label="About this preview"><div class="ghp-b-top"><span class="ghp-pill">Preview</span><b>@${esc(p.login)}'s public GitHub as a city.</b> <span class="ghp-mut">A preview from public data. Not on Caldera yet.</span></div>
<div class="ghp-b-actions"><a class="ghp-btn" href="/auth/github?back=${encodeURIComponent(back)}">Is this you? Claim it with GitHub</a>
<span class="ghp-share"><a class="ghp-btn ghost" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(share)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Post on X</a><a class="ghp-btn ghost" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener">LinkedIn</a><button class="ghp-btn ghost" type="button" data-copy="${esc(url)}">Copy link</button></span></div>
<div class="ghp-b-see">${seeForm()}</div>
<details class="ghp-badge"><summary>Put this city in a README</summary><img src="/gh/${esc(p.login)}/badge.svg?style=card" alt="GitHub city badge" width="420" height="92"><pre id="ghp-md">${esc(md)}</pre><button class="ghp-btn ghost" type="button" data-copy-el="ghp-md">Copy Markdown</button><p class="ghp-mut">A smaller one: <code>/badge.svg</code> without <code>?style=card</code>.</p></details>
<p class="ghp-fine">Built from public GitHub data only (${fmt(p.repos)} public repos, ${fmt(p.commits)} commits in the last year across the 20 most recently pushed), refreshed daily. Want it removed? Email hello@caldera.social.</p></section>`;
    html = html.replace('<meta name="robots" content="noindex, nofollow">', "")
      .replace(/<title>[^<]*<\/title>/, `<title>@${esc(p.login)}'s GitHub city - Caldera</title>` + ogTags({ url, image: `${url}/card.png?v=${Date.parse(p.fetched) % 1e8}`, title: `@${p.login}'s GitHub city`, description: `${p.bio ? p.bio + " " : ""}${fmt(p.repos)} public repos as a living city on Caldera.` }))
      .replace('<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
      .replace('href="assets/theme.css"', 'href="/gh/assets/theme.css"').replace('href="assets/profile.css"', 'href="/gh/assets/profile.css"')
      .replace(/href="index\.html"/g, `href="${esc(p.html_url)}" target="_blank" rel="noopener"`)
      .replace("</head>", `<style>${PAGE_CSS}</style></head>`)
      .replace(/<body([^>]*)>/, (_m, a) => `<body${a}>${c.header}`)
      .replace('<main class="note"><div class="c-main">', `<main class="note"><div class="c-main">${banner}`)
      .replace(" The houses around each district are the Obsidian notes about that project.", " Here, districts are languages.")
      .replace("<div><b>0</b><span>notes in town</span></div>", `<div><b>${new Set(p.city.districts.flatMap(d => d.repos.map(r => r.language))).size}</b><span>languages</span></div>`)
      .replace("</body>", `<script>${COPY_JS}</script><script src="/assets/site.js" defer></script></body>`);
    return html;
  }

  async function memberBadge(res: http.ServerResponse, handle: string, style: string): Promise<void> {
    const city = c.memberCity(handle);
    if (!city) return send(res, 404, "image/svg+xml; charset=utf-8", badgeSvg({ who: "@" + handle, repos: 0, commits: 0, style }), "public, max-age=600");
    const st = cityStats(city);
    send(res, 200, "image/svg+xml; charset=utf-8", badgeSvg({ who: "@" + handle, repos: st.repos, commits: st.commits, city, style }), "public, max-age=3600", { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (p === "/gh/assets/theme.css") { send(res, 200, "text/css; charset=utf-8", THEME_CSS as unknown as string, "public, max-age=3600"); return true; }
    if (p === "/gh/assets/profile.css") { send(res, 200, "text/css; charset=utf-8", PROFILE_CSS, "public, max-age=3600"); return true; }
    if (p === "/gh" || p === "/gh/") {
      const u = String(url.searchParams.get("u") || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/.*$/, "");
      if (u) { res.writeHead(302, { location: LOGIN_RX.test(u) ? `/gh/${u}` : "/gh" }); res.end(); return true; }
      send(res, 200, "text/html; charset=utf-8", landing(), "public, max-age=300", { "content-security-policy": CSP }); return true;
    }
    const m = p.match(/^\/gh\/([^/]+)(\/badge\.svg|\/card\.png|\/)?$/); if (!m) return false;
    const login = decodeURIComponent(m[1]); if (!LOGIN_RX.test(login)) { send(res, 404, "text/html; charset=utf-8", notFound(login.slice(0, 39), "missing"), "no-cache", { "content-security-policy": CSP }); return true; }
    const style = url.searchParams.get("style") === "card" ? "card" : "flat";
    const member = c.memberOf(login.toLowerCase());
    if (member) {
      if (m[2] === "/badge.svg") { await memberBadge(res, member, style); return true; }
      if (m[2] === "/card.png") { res.writeHead(302, { location: `/@${member}/card.png` }); res.end(); return true; }
      res.writeHead(302, { location: `/@${member}/city.html` }); res.end(); return true;
    }
    if (m[2] === "/") { res.writeHead(301, { location: `/gh/${login}` }); res.end(); return true; }
    const g = await get(login, req);
    if (m[2] === "/badge.svg") {
      if (!g.ok) { send(res, g.status === 429 || g.status === 502 ? 503 : 404, "image/svg+xml; charset=utf-8", badgeSvg({ who: "@" + login, repos: 0, commits: 0, style }), "public, max-age=300"); return true; }
      send(res, 200, "image/svg+xml; charset=utf-8", badgeSvg({ who: "@" + g.p.login, repos: g.p.repos, commits: g.p.commits, city: g.p.city, style }), "public, max-age=3600", { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
      return true;
    }
    if (m[2] === "/card.png") {
      if (!g.ok) { res.writeHead(302, { location: "/world/preview.png" }); res.end(); return true; }
      const f = file(login, ".png");
      try { if (!fs.existsSync(f)) { const png = await toPng(cardSvg({ handle: g.p.login, name: g.p.name, headline: `GitHub city: ${fmt(g.p.repos)} public repos, ${fmt(g.p.commits)} commits this year`, host: c.hub().replace(/^https?:\/\//, ""), path: `/gh/${g.p.login}`, city: cityArt(citySnapshot(g.p.city, { name: g.p.name })) })); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, png); }
        send(res, 200, "image/png", fs.readFileSync(f), "public, max-age=86400"); }
      catch (e: any) { console.error("gh card", e?.message); res.writeHead(302, { location: "/world/preview.png" }); res.end(); }
      return true;
    }
    if (!g.ok) { send(res, g.status, "text/html; charset=utf-8", notFound(login, g.why), "no-cache", { "content-security-policy": CSP }); return true; }
    if (g.p.login !== login) { res.writeHead(301, { location: `/gh/${g.p.login}` }); res.end(); return true; }   // canonical case
    send(res, 200, "text/html; charset=utf-8", previewPage(g.p, `/gh/${g.p.login}`), "public, max-age=600", { "content-security-policy": CSP }); return true;
  }
  return { route, memberBadge, get, badgeSnippet: (handle: string) => snippet(`${c.hub()}/@${handle}/city.html`, `${c.hub()}/@${handle}/badge.svg?style=card`, "My GitHub city on Caldera") };
}

const COPY_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy],[data-copy-el]');if(!b)return;var t=b.getAttribute('data-copy')||((document.getElementById(b.getAttribute('data-copy-el'))||{}).textContent||'');
var done=function(){var l=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=l},1600)};if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,function(){});});`;

const PAGE_CSS = `.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.ghp-land{max-width:720px;margin:0 auto;padding:56px 16px 80px;text-align:center}.ghp-land h1{font-family:'Source Serif 4',Georgia,serif;font-size:clamp(2rem,6vw,2.8rem);margin:0 0 12px;color:var(--text-strong,#F2F2F5)}
.ghp-land .lede{color:var(--text-muted,#B8B8C2);font-size:1.05rem;max-width:56ch;margin:0 auto 26px}.ghp-ex{margin:16px 0 0;color:var(--text-muted,#9A9AA6)}.ghp-ex a{color:var(--accent-text,#B9A6FF)}
.ghp-small{margin:34px auto 0;max-width:52ch;color:var(--text-muted,#9A9AA6);font-size:.95rem}.ghp-small a{color:var(--accent-text,#B9A6FF)}
.ghp-form{display:flex;align-items:center;gap:0;max-width:440px;margin:0 auto;border:1px solid var(--line-strong,#3A3A44);border-radius:999px;background:var(--bg-raised,#1C1C21);padding:4px 4px 4px 14px}
.ghp-form .ghp-at{color:var(--text-muted,#8A8A93);font:500 13.5px 'IBM Plex Mono',monospace;white-space:nowrap}.ghp-form input{flex:1;min-width:0;background:none;border:0;outline:0;color:var(--text-strong,#F2F2F5);font:500 14px 'IBM Plex Mono',monospace;padding:8px 4px}
.ghp-form button{flex:none;border:0;border-radius:999px;background:#6D4AE8;color:#fff;font:600 13.5px 'IBM Plex Sans',Arial,sans-serif;padding:9px 16px;cursor:pointer}.ghp-form button:hover{filter:brightness(1.08)}
.ghp-form.big{max-width:520px;padding:6px 6px 6px 18px}.ghp-form.big input,.ghp-form.big .ghp-at{font-size:15px}.ghp-form:focus-within{border-color:#8B6CF6}
.ghp-banner{margin:0 0 22px;padding:16px 18px;border:1px solid #3A2F5C;border-radius:14px;background:linear-gradient(180deg,#1C1730,#18161F);display:flex;flex-direction:column;gap:12px}
.ghp-b-top{color:var(--text,#D6D6DC);line-height:1.5}.ghp-b-top b{color:var(--text-strong,#F2F2F5)}.ghp-pill{display:inline-block;margin-right:8px;padding:1px 8px;border-radius:999px;background:#2A2440;color:#B9A6FF;font:600 11px 'IBM Plex Sans',Arial,sans-serif;text-transform:uppercase;letter-spacing:.06em;vertical-align:2px}
.ghp-mut{color:var(--text-muted,#9A9AA6)}.ghp-b-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.ghp-share{display:inline-flex;flex-wrap:wrap;gap:8px}
.ghp-btn{display:inline-flex;align-items:center;min-height:34px;padding:0 14px;border-radius:999px;background:#6D4AE8;color:#fff!important;border:1px solid #6D4AE8;font:600 13px 'IBM Plex Sans',Arial,sans-serif;text-decoration:none!important;cursor:pointer;white-space:nowrap}
.ghp-btn.ghost{background:transparent;border-color:var(--line-strong,#3A3A44);color:var(--text,#E6E6EA)!important}.ghp-btn:hover{filter:brightness(1.1)}.ghp-b-see .ghp-form{margin:0;max-width:420px}
.ghp-badge summary{cursor:pointer;color:var(--accent-text,#B9A6FF);font-weight:600}.ghp-badge img{display:block;max-width:100%;height:auto;margin:10px 0}.ghp-badge pre{white-space:pre-wrap;word-break:break-all;background:var(--bg,#141416);border:1px solid var(--line,#2A2A2E);border-radius:8px;padding:10px;font:12px 'IBM Plex Mono',monospace;margin:0 0 8px}
.ghp-fine{margin:0;color:var(--text-muted,#8A8A93);font-size:12.5px}
@media (max-width:620px){.ghp-banner{padding:14px}.ghp-form .ghp-at{display:none}.ghp-b-actions .ghp-btn{min-height:32px;padding:0 12px}}`;
