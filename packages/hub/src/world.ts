/**
 * The World (caldera.social/world): every listed member's city as one neighborhood of a single map, drawn by the same
 * renderer as a member's own city (same buildings, cars and people, the viewer's time of day and weather).
 *
 * Built only from what is already public: each member's PUBLIC city (the data on their hosted city.html), re-cleaned
 * here so a private or locked building can never carry a name, link or history. Unlisted and moderated profiles never
 * appear. Live activity is the same coarse public projection a member's own public city gets, folded per member.
 */
import { mapPanel } from "./mapprompt";
import { CITY_CSS, CITY_JS, type CityData, type CityRepo } from "../../../../caldera/packages/plugin/src/city";

export interface WorldMemberIn {
  handle: string; name: string; headline: string; created: string; groups: string[]; friends: number;
  city: CityData | null; notes: number; busy: number;
  /** their top "what they're building" problem space (public GitHub signals), for Color by topic */
  tag?: string;
}
export interface WorldMember { handle: string; name: string; headline: string; isNew: boolean; groups: string[]; friends: number; city: string; page: string; tag?: string }
/** A ray: [@a, @b, kind (0 request/invite, 1 founder welcome, 2 shared repo, 3 GitHub follow, 4 same stack: not a
 *  friendship, their public repos share uncommon packages), why (repo, the follow, or the shared packages)]. */
export type WorldLink = [string, string, number, string?];
export interface World { at: string; members: WorldMember[]; city: CityData; links: WorldLink[]; start: string | null; topics?: { t: string; c: string; n: number }[] }
/** Color by topic: the most common problem spaces get a hue each (readable on the night map, distinct for color-blind
 *  viewers in the order used), everything else is "Other". The legend always names them, so color is never the only cue. */
const TOPIC_HUES = ["#A78BFA", "#2DD4BF", "#FBBF24", "#FB7185", "#38BDF8", "#A3E635", "#FB923C", "#E879F9", "#34D399"];

const MAX_PER_MEMBER = 30, MAX_BUILDINGS = 900, MAX_LINKS = 300, NEW_MS = 48 * 3600_000;
const str = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

/** One building, re-cleaned: public repos keep name/link/history; anything else becomes a nameless padlocked block. */
export function cleanRepo(r: CityRepo, project: string): CityRepo {
  const url = typeof r.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(r.url) ? r.url : undefined;
  if (r.locked || r.public !== true || !r.name) {
    return { name: "", project, public: false, locked: true, language: "Private", commits: Math.max(0, Math.round(Number(r.commits) || 0)), weeks: [], week: (Number(r.week) || 0) > 0 ? 1 : 0, today: 0 };
  }
  return { name: str(r.name, 100), project, public: true, language: str(r.language || "Other", 30), commits: Math.max(0, Math.round(Number(r.commits) || 0)),
    weeks: (Array.isArray(r.weeks) ? r.weeks : []).slice(-12).map(w => Math.max(0, Math.round(Number(w) || 0))), week: Math.max(0, Math.round(Number(r.week) || 0)), today: 0,
    pushed: typeof r.pushed === "string" && Date.parse(r.pushed) ? new Date(r.pushed).toISOString() : undefined, url, description: r.description ? str(r.description, 200) : undefined };
}

/** Lay out the world: members ordered so groups cluster together and the newest sit at the edge. */
export function buildWorld(members: WorldMemberIn[], friendships: ([string, string] | [string, string, string?, string?])[], founder: string | null, hub: string, now = Date.now()): World {
  const base = hub.replace(/\/$/, "");
  const isNew = (m: WorldMemberIn) => now - Date.parse(m.created) < NEW_MS;
  const order = [...members].sort((a, b) => Number(isNew(a)) - Number(isNew(b))
    || (a.groups[0] || "￿").localeCompare(b.groups[0] || "￿")
    || b.busy - a.busy || a.handle.localeCompare(b.handle));
  // each member keeps their own districts (the same public projects their own city shows; private ones are already
  // merged into one "Private" district there), so the world can label them. Buildings are capped per member.
  let left = MAX_BUILDINGS;
  const districts: { name: string; label: string; nb: string; notes: number; repos: CityRepo[] }[] = [];
  for (const m of order) {
    const key = "@" + m.handle, src = m.city?.districts || [];
    const ranked = src.flatMap((d, di) => (d.repos || []).map(r => ({ di, r: cleanRepo(r, key) })));
    ranked.sort((a, b) => (b.r.week * 20 + b.r.commits) - (a.r.week * 20 + a.r.commits));
    const keep = ranked.slice(0, Math.max(0, Math.min(MAX_PER_MEMBER, left))); left -= keep.length;
    const notesLeft = { n: Math.min(16, Math.max(0, m.notes)) };
    src.forEach((d, di) => {
      const repos = keep.filter(k => k.di === di).map(k => k.r);
      if (!repos.length) return;
      const label = str(d.name, 60) || "Private";   // the member's own public city already names only public projects
      const k = key + "/" + label;
      const prev = districts.find(x => x.name === k);
      for (const r of repos) r.project = k;
      if (prev) { prev.repos.push(...repos); return; }
      const notes = Math.min(notesLeft.n, Math.max(0, Number((d as any).notes) || 0)); notesLeft.n -= notes;
      districts.push({ name: k, label, nb: key, notes, repos });
    });
    if (!src.length || !keep.length) districts.push({ name: key + "/Notes", label: "Notes", nb: key, notes: Math.min(16, Math.max(0, m.notes)) || 4, repos: [] });
  }
  const listed = new Set(members.map(m => m.handle)), seen = new Set<string>(), links: WorldLink[] = [];
  for (const [a, b, kind, why] of friendships as [string, string, string?, string?][]) {
    if (!listed.has(a) || !listed.has(b) || a === b) continue;
    const k = a < b ? a + "|" + b : b + "|" + a; if (seen.has(k)) continue; seen.add(k);
    // kind from the friends table; without it (older callers) a link touching the founder counts as a welcome link
    const n = kind === "stack" ? 4 : kind === "repo" ? 2 : kind === "github" ? 3 : kind === "founder" ? 1 : kind ? 0 : founder && (a === founder || b === founder) ? 1 : 0;
    links.push((n === 2 || n === 3 || n === 4) && why ? ["@" + a, "@" + b, n, String(why).slice(0, 140)] : ["@" + a, "@" + b, n]);
  }
  links.sort((x, y) => (x[2] === 1 ? 1 : 0) - (y[2] === 1 ? 1 : 0));   // real and shared-repo friendships first, the founder's welcome links after (and fainter)
  const all = districts.flatMap(d => d.repos);
  const busiest = [...members].sort((a, b) => b.busy - a.busy)[0];
  return {
    at: new Date(now).toISOString(),
    members: order.map(m => ({ handle: m.handle, name: str(m.name, 80), headline: str(m.headline, 160), isNew: isNew(m), groups: m.groups.slice(0, 8), friends: m.friends, ...(m.tag ? { tag: str(m.tag, 32) } : {}),
      city: m.city ? `${base}/@${m.handle}/city.html` : `${base}/@${m.handle}/`, page: `${base}/@${m.handle}/` })),
    city: { generated: new Date(now).toISOString(), districts, private: false, totals: { commits: all.reduce((s, r) => s + r.commits, 0), active: all.filter(r => r.week > 0).length } },
    links: links.slice(0, MAX_LINKS),
    topics: (() => { const n = new Map<string, number>(); for (const m of members) if (m.tag) n.set(m.tag, (n.get(m.tag) || 0) + 1);
      return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOPIC_HUES.length).map(([t, k], i) => ({ t: str(t, 32), c: TOPIC_HUES[i]!, n: k })); })(),
    start: busiest && busiest.busy > 0 ? "@" + busiest.handle : order.length ? "@" + order[0].handle : null,
  };
}

/** Public live activity folded per member: activity level, coarse arrivals, today's coarse counts, agents (no ids). */
export function foldLive(per: { handle: string; live: any }[], at: string) {
  const out: any = { at, districts: {}, agents: [], arrivals: {}, today: {}, left: {} };
  let anyArr = false;
  for (const { handle, live } of per) {
    if (!live) continue; const k = "@" + handle;
    const lv = Object.values(live.districts || {}).reduce((m: number, d: any) => Math.max(m, Number(d?.level) || 0), 0);
    out.districts[k] = { level: lv };
    for (const a of Array.isArray(live.agents) ? live.agents.slice(0, 20) : []) out.agents.push({ id: String(a.id || "").slice(0, 10) + handle.slice(0, 4), d: k, state: a.state });
    if (live.arrivals) { anyArr = true; const x = out.arrivals[k] = { v: 0, s: 0, b: 0 }; for (const v of Object.values(live.arrivals) as any[]) { x.v += +v.v || 0; x.s += +v.s || 0; x.b += +v.b || 0; } }
    for (const t of Object.values(live.today || {}) as any[]) {
      const y = out.today[k] ||= { v: 0, q: Array(96).fill(0), t0: t.t0 };
      y.v += +t.v || 0; (t.q || []).forEach((n: number, i: number) => { if (i < 96) y.q[i] += +n || 0; });
    }
    const lf = Object.values(live.left || {}).reduce((s: number, n: any) => s + (+n || 0), 0); if (lf) out.left[k] = lf;
  }
  if (!anyArr) delete out.arrivals;
  return out;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The world page: the city renderer in world mode, with the site's own look around it. */
export function worldPage(w: World, o: { hub: string; nav: string; tools?: unknown[] }): string {
  const hub = o.hub.replace(/\/$/, ""), n = w.members.length, b = w.city.districts.reduce((s, d) => s + d.repos.length, 0);
  const data = { ...w.city, openBase: "", world: { m: Object.fromEntries(w.members.map(m => ["@" + m.handle, m])), links: w.links, start: w.start, topics: w.topics || [] } };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Caldera world: every member's city on one map</title>
<meta name="description" content="Every Caldera member's GitHub and Obsidian city on one live map: ${n} neighborhoods, ${b} buildings, friendships as highways.">
<meta property="og:title" content="The Caldera world"><meta property="og:description" content="Every member's city on one live map."><meta property="og:image" content="${esc(hub)}/og.jpg"><meta property="og:url" content="${esc(hub)}/world">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="canonical" href="${esc(hub)}/world">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>${CITY_CSS}
.w-main{max-width:none;margin:0;padding:10px 20px 32px}.w-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:flex-start;gap:2px 14px;margin:2px 0 10px}@media (max-width:600px){.w-main{padding:8px 16px 28px}.w-main .w-head{flex-direction:column;align-items:flex-start;gap:2px}.w-main .w-head p{flex:none;font-size:13px}}
.w-head h1{font-family:'Source Serif 4',Georgia,serif;font-size:clamp(1.3rem,2.2vw,1.7rem);margin:0;color:var(--text-strong,#F7F7FA)}.w-head p{margin:0;color:var(--text-muted,#8A8A93);font-size:14px;flex:1 1 30ch;min-width:0}
@media (max-width:600px){.w-main .c-tools{flex-wrap:wrap;justify-content:flex-end;left:8px;right:8px;gap:4px}.w-main .c-tools button{padding:5px 8px}}.w-main .c-stage{height:calc(100vh - 150px);height:calc(100svh - 150px);min-height:460px}@media (max-width:600px){.w-main .c-stage{height:calc(100svh - 190px);min-height:400px}}
.w-foot{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:13px;color:var(--text-muted,#8A8A93)}.w-foot a{color:var(--accent-text,#B9A6FF)}
.w-legend i{display:inline-block;width:18px;height:4px;border-radius:2px;background:linear-gradient(90deg,#B98CFF,#FFC46B,#B98CFF);vertical-align:middle;margin-right:6px;box-shadow:0 0 6px rgba(200,160,255,.8)}.w-legend-stack i{background:repeating-linear-gradient(90deg,#FF7A96 0 4px,transparent 4px 7px);box-shadow:none}</style></head><body>
${o.nav}
<main class="w-main">
<div class="w-head"><h1>The world</h1><p>${n} neighborhood${n === 1 ? "" : "s"} &middot; ${b.toLocaleString("en-US")} building${b === 1 ? "" : "s"} &middot; rays of light are friendships, dashed coral lines are similar stacks &middot; click a name to fly there, again to walk in &middot; &#10022; light up a city you like (one gift a day)</p></div>
<div class="c-stage" id="stage"><canvas id="city" aria-label="Isometric world map of ${n} member cities"></canvas>
<div class="c-tools"><button id="t-labels" aria-pressed="true">Labels</button><button id="t-fr" aria-pressed="true" aria-label="Friendships" title="Friendships between neighborhoods, drawn as rays of light">&#x2727;<span class="t-txt"> Friendships</span></button><button id="t-topics" aria-pressed="false" aria-label="Color by topic" title="Tint each neighborhood by what they're building"><span class="t-sw" aria-hidden="true"></span><span class="t-txt"> Topics</span></button><button id="t-sky">Auto</button><button id="t-wx" title="Weather">Weather</button><button id="t-snd" aria-pressed="false" title="Sound for arrivals (off)">&#x1F507;</button><button id="t-reset">Reset</button><button id="t-full" aria-label="Full screen">&#x26F6;<span class="t-txt"> Full screen</span></button></div>
<div class="c-toasts" aria-live="polite"></div><div class="c-mininame" aria-hidden="true"><i></i>Caldera world</div>
<div class="c-card" id="card" hidden></div><div class="c-hint">Drag to move &middot; scroll or pinch to zoom &middot; click a name to fly there</div></div>
<div class="w-foot"><span class="w-legend"><i></i>Friendships are rays of light</span><span class="w-legend w-legend-stack"><i></i>Dashed coral: builds with a similar stack</span><span>&#128274; Padlocked buildings are private repos: size only, never names.</span><span>Only people listed in <a href="/people">People</a> appear.</span><a href="/#start">Add your city &rarr;</a></div>
${mapPanel(hub)}
</main><footer class="footer"><span>&copy; 2026 mjonesone, LLC</span><span><a href="/guide">Guide</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></span></footer>
<script>window.CALDERA_TOOLS=${safeJson(o.tools || [])};window.CALDERA_TOOLS_HUB=${safeJson(hub)};window.CALDERA_LIVE=${safeJson({ url: "/v1/world/live", mode: "public" })};window.CALDERA_EXTRAS=${safeJson({ weather: `${hub}/v1/weather` })};window.CALDERA_GIFTS=${safeJson({ url: "/v1/gifts" })}</script>
<script type="application/json" id="city-data">${safeJson(data)}</script>
<script>${CITY_JS}</script></body></html>`;
}
