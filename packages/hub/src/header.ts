/**
 * THE Caldera header: one component for every page (site pages, hub pages, hosted profiles and cities, the private
 * address), signed out or signed in. Pages carry a marker (or an old header block); the hub swaps in this header at
 * response time for the viewer of that request, so every page shows the same bar whatever version built it.
 *
 * Signed out: logo · Feed · People · World · Guide | Sign in · Get started
 * Signed in:  logo · Feed · People · World | [Public | Private on your own profile] · items · bell · avatar menu
 *
 * Self-contained: inline styles scoped to .ch, line icons drawn inline, menus are <details> (work in sandboxed pages).
 */

export interface HeaderViewer {
  handle: string;
  name: string;
  avatar?: string;            // absolute or root-relative image url
  conn?: { github: boolean; obsidian: boolean };
  unread: number;
  alerts: { title: string; when: string; read: boolean; pinned?: boolean; href?: string }[];
  seenUrl?: string;           // image beacon that marks the shown alerts read
}

export interface HeaderOwnView {
  view: "public" | "private";
  publicHref: string;
  privateHref?: string;       // none: this member has no private view (the Private segment is not shown)
  privateExternal?: boolean;  // opens outside the browser (Obsidian)
  stale?: number;             // days since the page last updated
}

export interface HeaderOpts {
  hub: string;
  current?: "feed" | "people" | "world" | "guide" | "settings" | "alerts" | "profile" | "";
  viewer?: HeaderViewer | null;
  own?: HeaderOwnView | null;
  signinHref?: string;        // signed out: where Sign in goes (a profile's owner sign-in, or /signin)
  joinHref?: string;          // signed out: where Get started goes (carries ?invite= on a profile)
  items?: string[];           // extra signed-in controls before the bell (e.g. Messages); trusted hub markup
}

/** Extra signed-in header controls, registered by other hub modules (e.g. Messages). Each returns trusted markup. */
export type HeaderItem = (viewerId: string) => string;

export const HEADER_MARK = "<!--caldera:header-->";

const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** 1.8px line icons, 24-unit grid, currentColor. */
export const ICON: Record<string, string> = {
  feed: `<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>`,
  people: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  world: `<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`,
  guide: `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  eye: `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  lock: `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  out: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
  menu: `<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`,
  chevron: `<path d="m6 9 6 6 6-6"/>`,
  ext: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
  pin: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
};
export const icon = (name: string, size = 18) => `<svg class="ch-i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`;

const LOGO = `<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 26 L11 10 L14 15 L17 8 L29 26 Z" fill="#8B6CF6"/><path d="M11 10 L14 15 L17 8" fill="none" stroke="#F2F2F5" stroke-width="1.2"/><circle cx="16" cy="21" r="2.4" fill="#4FB89A"/></svg>`;

/** Header tokens: one ground, one height, brand at the same x on every page. Dark-only for now (the site is dark-first). */
export const HEADER_CSS = `<style id="ch-css">
.ch{--ch-bg:#141416;--ch-line:#2A2A2E;--ch-raised:#1C1C1F;--ch-pop:#18171D;--ch-pop-line:#2E2A40;--ch-text:#DADADF;--ch-strong:#F2F2F5;--ch-muted:#8A8A93;--ch-dim:#B8B8C2;
--ch-accent:#8B6CF6;--ch-accent-btn:#6D4AE8;--ch-accent-soft:#2A2440;--ch-accent-text:#B9A6FF;--ch-ok:#3FB97F;--ch-off:#5A5A66;--ch-danger:#E5484D;--ch-h:56px;
position:relative;z-index:60;box-sizing:border-box;height:var(--ch-h);display:flex;align-items:center;gap:20px;padding:0 24px;background:var(--ch-bg);border-bottom:1px solid var(--ch-line);
font:500 15px/1.2 'IBM Plex Sans','Helvetica Neue',Arial,sans-serif;color:var(--ch-text);-webkit-font-smoothing:antialiased;text-align:left}
.ch *{box-sizing:border-box}.ch a{color:inherit;text-decoration:none}.ch .ch-i{display:block;flex:none}
.ch-brand{display:inline-flex;align-items:center;gap:9px;flex:none;color:var(--ch-strong)!important;font:600 19px/1 'Source Serif 4',Georgia,serif;letter-spacing:-.01em}
.ch-nav{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.ch-nav a{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 11px;border-radius:8px;color:var(--ch-dim);white-space:nowrap}
.ch-nav a:hover{color:var(--ch-strong);background:var(--ch-raised)}
.ch-nav a[aria-current="page"]{color:var(--ch-strong);background:var(--ch-accent-soft)}
.ch-right{display:flex;align-items:center;gap:10px;flex:none}
.ch-text{color:var(--ch-text);padding:0 4px;white-space:nowrap}.ch-text:hover{color:var(--ch-strong)}
.ch-cta{display:inline-flex;align-items:center;height:38px;padding:0 16px;border-radius:999px;background:var(--ch-accent-btn);color:#fff!important;font-weight:600;white-space:nowrap}.ch-cta:hover{filter:brightness(1.1)}
.ch-seg{display:flex;padding:3px;border-radius:10px;background:#1F1C2B;border:1px solid var(--ch-pop-line)}
.ch-seg a{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:7px;color:var(--ch-dim);font-size:14px;white-space:nowrap}
.ch-seg a[aria-current="page"]{background:var(--ch-accent-btn);color:#fff;font-weight:600}.ch-seg a:not([aria-current]):hover{color:var(--ch-strong)}
.ch-stale{color:#F2C46D;font-size:12.5px;white-space:nowrap}
.ch details{position:relative}.ch summary{list-style:none;cursor:pointer}.ch summary::-webkit-details-marker{display:none}
.ch-icon{position:relative;display:grid;place-items:center;width:38px;height:38px;border-radius:10px;border:1px solid var(--ch-line);background:var(--ch-raised);color:var(--ch-text)}
.ch-icon:hover,.ch details[open]>.ch-icon{color:var(--ch-strong);border-color:var(--ch-pop-line)}
.ch-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--ch-danger);color:#fff;font:600 11px/18px 'IBM Plex Sans',Arial,sans-serif;text-align:center}
.ch-acct{display:flex;align-items:center;gap:8px;height:38px;padding:0 10px 0 3px;border-radius:999px;border:1px solid var(--ch-line);background:var(--ch-raised);color:var(--ch-strong);font-size:14px}
.ch details[open]>.ch-acct{border-color:var(--ch-accent)}
.ch-av{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;overflow:hidden;flex:none;background:#3A2F5C;color:#D6CBFF;font-weight:600;font-size:14px}.ch-av img{width:100%;height:100%;object-fit:cover}
.ch-pop{position:absolute;right:0;top:calc(100% + 8px);z-index:90;min-width:260px;background:var(--ch-pop);border:1px solid var(--ch-pop-line);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.5);padding:6px;display:flex;flex-direction:column;gap:1px}
.ch-pop a.ch-mi{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 10px;border-radius:8px;color:var(--ch-text);font-size:14px}.ch-pop a.ch-mi:hover{background:#26232F;color:var(--ch-strong)}
.ch-pop .ch-sep{height:1px;margin:4px 6px;background:var(--ch-line)}
.ch-who{display:flex;align-items:center;gap:10px;padding:10px}.ch-who .ch-av{width:40px;height:40px}.ch-who b{display:block;color:var(--ch-strong)}.ch-who span{color:var(--ch-muted);font:500 12px 'IBM Plex Mono',ui-monospace,monospace}
.ch-conn{display:flex;gap:14px;padding:0 10px 8px;color:var(--ch-muted);font-size:12.5px}.ch-conn i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
.ch-note{padding:2px 10px 8px;color:var(--ch-muted);font-size:12px;line-height:1.4}
.ch-al{width:min(380px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;padding:6px 8px 8px}
.ch-al-h{display:flex;justify-content:space-between;align-items:center;padding:8px 6px;color:var(--ch-strong);font-weight:600;font-size:14px}.ch-al-h a{color:var(--ch-accent-text);font-weight:500;font-size:13px}
.ch-al-i{display:flex;gap:10px;padding:10px 8px;border-radius:10px;color:var(--ch-text)}.ch-al-i:hover{background:#221D33}.ch-al-i.pin{background:#1F1A2E}
.ch-al-i .dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:transparent}.ch-al-i.unread .dot{background:var(--ch-accent)}
.ch-al-i b{display:block;font-size:14px;color:var(--ch-strong);font-weight:600;line-height:1.35}.ch-al-i small{display:block;margin-top:3px;color:var(--ch-muted);font-size:12.5px}
.ch-al-empty{padding:12px 8px;color:var(--ch-muted);font-size:13.5px}
.ch-menu{display:none}
.ch a:focus-visible,.ch summary:focus-visible{outline:2px solid var(--ch-accent);outline-offset:2px}
@media (max-width:760px){.ch{--ch-h:52px;gap:8px;padding:0 12px}.ch-nav{display:none}.ch-menu{display:block}.ch-brand span{display:none}
.ch-seg a span{display:none}.ch-seg a{padding:0 9px}.ch-acct{padding:0 3px}.ch-acct .ch-hd,.ch-acct .ch-i{display:none}.ch-text{font-size:14px}.ch-cta{height:34px;padding:0 13px;font-size:14px}.ch-stale{display:none}
.ch-right{gap:6px;margin-left:auto}.ch-pop{position:fixed;left:12px;right:12px;top:58px;min-width:0}.ch-al{width:auto}}
</style>`;

/** The header for one request's viewer. Same markup and CSS everywhere: the regression test compares these. */
export function appHeader(o: HeaderOpts): string {
  const hub = o.hub.replace(/\/$/, ""), v = o.viewer || null, cur = o.current || "";
  const link = (key: string, label: string, href: string) => `<a href="${e(href)}"${cur === key ? ' aria-current="page"' : ""}>${icon(key)}<span>${label}</span></a>`;
  const navLinks = [link("feed", "Feed", `${hub}/feed`), link("people", "People", `${hub}/people`), link("world", "World", `${hub}/world`)].concat(v ? [] : [link("guide", "Guide", `${hub}/guide`)]);
  const brand = `<a class="ch-brand" href="${e(hub)}/" aria-label="Caldera home">${LOGO}<span>Caldera</span></a>`;
  const mobile = `<details class="ch-menu"><summary class="ch-icon" aria-label="Menu">${icon("menu")}</summary><div class="ch-pop" style="left:0;right:auto">`
    + [["feed", "Feed", "/feed"], ["people", "People", "/people"], ["world", "World", "/world"], ["guide", "Guide", "/guide"]].map(([k, l, h]) => `<a class="ch-mi" href="${e(hub + h)}"${cur === k ? ' aria-current="page"' : ""}>${icon(k)}${l}</a>`).join("")
    + `</div></details>`;
  if (!v) {
    const signin = o.signinHref || `${hub}/signin`, join = o.joinHref || `${hub}/#install`;
    return `${HEADER_CSS}<header class="ch" id="caldera-bar" data-state="out">${mobile}${brand}<nav class="ch-nav" aria-label="Main">${navLinks.join("")}</nav>`
      + `<div class="ch-right"><a class="ch-text" href="${e(signin)}" rel="nofollow">Sign in</a><a class="ch-cta" href="${e(join)}">Get started</a></div></header>`;
  }
  const own = o.own || null;
  const seg = own ? `<div class="ch-seg" role="group" aria-label="View your profile as">`
    + `<a href="${e(own.publicHref)}"${own.view === "public" ? ' aria-current="page"' : ""} title="Your profile as everyone sees it">${icon("eye", 15)}<span>Public</span></a>`
    + (own.privateHref ? `<a href="${e(own.privateHref)}"${own.view === "private" ? ' aria-current="page"' : ""}${own.privateExternal ? ' title="Opens your private view in Obsidian"' : ' title="Your profile with the private sections only you see"'}>${icon("lock", 15)}<span>Private</span></a>` : "")
    + `</div>` : "";
  const stale = own && own.stale && own.view === "public" ? `<span class="ch-stale" title="Your page updates while Obsidian is open">Updated ${own.stale}d ago</span>` : "";
  const av = (size = "") => `<span class="ch-av"${size}>${v.avatar ? `<img src="${e(v.avatar)}" alt="">` : e((v.name || v.handle).charAt(0).toUpperCase())}</span>`;
  const shown = v.alerts.slice(0, 8);
  const bell = `<details class="ch-bell"${v.seenUrl ? ` data-seen="${e(v.seenUrl)}"` : ""}><summary class="ch-icon" aria-label="Alerts${v.unread ? `, ${v.unread} unread` : ""}">${icon("bell", 19)}${v.unread ? `<span class="ch-badge">${v.unread > 9 ? "9+" : v.unread}</span>` : ""}</summary>`
    + `<div class="ch-pop ch-al" role="dialog" aria-label="Alerts"><div class="ch-al-h"><span>Alerts</span><a href="${e(hub)}/alerts">See all</a></div>`
    + (shown.length ? shown.map(a => `<a class="ch-al-i${a.pinned ? " pin" : ""}${a.read ? "" : " unread"}" href="${e(a.href || hub + "/alerts")}">${a.pinned ? `<span style="color:var(--ch-accent-text);flex:none;margin-top:2px">${icon("pin", 15)}</span>` : `<span class="dot"></span>`}<span><b>${e(a.title)}</b><small>${a.pinned ? "Pinned · " : ""}${e(a.when)}</small></span></a>`).join("") : `<div class="ch-al-empty">Nothing yet. New friends, kudos and replies show up here.</div>`)
    + `</div></details>`;
  const conn = v.conn ? `<div class="ch-conn"><span><i style="background:${v.conn.github ? "var(--ch-ok)" : "var(--ch-off)"}"></i>GitHub</span><span><i style="background:${v.conn.obsidian ? "var(--ch-ok)" : "var(--ch-off)"}"></i>Obsidian</span></div>` : "";
  const mi = (ic: string, label: string, href: string, extra = "") => `<a class="ch-mi" href="${e(href)}"${extra}>${icon(ic, 17)}${label}</a>`;
  const acct = `<details class="ch-acctm"><summary class="ch-acct" aria-label="Account menu for @${e(v.handle)}">${av()}<span class="ch-hd">@${e(v.handle)}</span>${icon("chevron", 14)}</summary>`
    + `<div class="ch-pop" role="menu"><div class="ch-who">${av()}<div><b>${e(v.name || "@" + v.handle)}</b><span>caldera.social/@${e(v.handle)}</span></div></div>${conn}`
    + mi("user", "My profile", `${hub}/@${v.handle}/`)
    + mi("settings", "Settings", `${hub}/settings`)
    + mi("bell", "Alerts", `${hub}/alerts`)
    + `<div class="ch-sep"></div>` + mi("out", "Sign out", `${hub}/signout?h=${encodeURIComponent(v.handle)}`, ' style="color:var(--ch-muted)"')
    + `</div></details>`;
  const items = (o.items || []).join("");
  const js = `<script>(function(){var h=document.getElementById('caldera-bar');if(!h||h.dataset.wired)return;h.dataset.wired='1';var ds=h.querySelectorAll('details');
ds.forEach(function(d){d.addEventListener('toggle',function(){if(!d.open)return;ds.forEach(function(x){if(x!==d)x.open=false});
if(d.classList.contains('ch-bell')&&!d.dataset.done){d.dataset.done='1';var u=d.getAttribute('data-seen');if(u){var i=new Image();i.src=u}var b=d.querySelector('.ch-badge');if(b)b.remove()}})});
document.addEventListener('click',function(ev){ds.forEach(function(d){if(d.open&&!d.contains(ev.target))d.open=false})});
document.addEventListener('keydown',function(ev){if(ev.key==='Escape')ds.forEach(function(d){d.open=false})})})()</script>`;
  return `${HEADER_CSS}<header class="ch" id="caldera-bar" data-state="${own ? "own" : "in"}">${mobile}${brand}<nav class="ch-nav" aria-label="Main">${navLinks.join("")}</nav>`
    + `<div class="ch-right">${stale}${seg}${items}${bell}${acct}</div></header>${js}`;
}

/** Which nav item a path belongs to. */
export function currentFor(pathname: string): HeaderOpts["current"] {
  if (/^\/feed(\/|$)/.test(pathname)) return "feed";
  if (/^\/people(\/|$)/.test(pathname)) return "people";
  if (/^\/(world|g\/)/.test(pathname)) return "world";
  if (/^\/(guide|learn|changelog)/.test(pathname)) return "guide";
  if (/^\/(settings|me)(\/|$)/.test(pathname)) return "settings";
  if (/^\/alerts(\/|$)/.test(pathname)) return "alerts";
  if (/^\/@/.test(pathname)) return "profile";
  return "";
}

/** Swap whatever header a page carries (marker, the old static site header, or the old hub bar) for `header`. */
export function swapHeader(html: string, header: string): string | null {
  if (html.includes(HEADER_MARK)) { const i = html.indexOf(HEADER_MARK); return html.slice(0, i) + header + html.slice(i + HEADER_MARK.length).split(HEADER_MARK).join(""); }
  if (/<header class="nav"[\s\S]*?<\/header>/.test(html)) return html.replace(/<header class="nav"[\s\S]*?<\/header>/, header);
  return null;
}
