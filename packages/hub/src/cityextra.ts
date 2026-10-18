/**
 * City extras served by the hub: the viewer's local weather (for the sky over every city), the day's traffic shape
 * (who came today, who just left) and the owner-only "turn on live visitors" setup.
 *
 * Weather: the viewer's approximate location comes from their request IP via a keyless GeoIP service, then current
 * conditions from Open-Meteo. Nothing is stored: IPs are reduced to a salted hash of their /24 (IPv4) or /48 (IPv6)
 * network, kept only in memory to cache the lookup; conditions are cached per 0.1 degree cell. The answer goes back to
 * the requester only.
 */
import crypto from "node:crypto";

export type WxKind = "clear" | "partly" | "overcast" | "fog" | "drizzle" | "rain" | "storm" | "snow";
export interface Weather { c: WxKind; cloud: number; precip: number; wind: number; dir: number; day: 0 | 1; sunrise: number; sunset: number; place?: string; at: string }

/** WMO weather code (Open-Meteo) -> the handful of skies the city can draw. */
export function wmoKind(code: number, cloud = 0): WxKind {
  if (code === 0) return cloud > 35 ? "partly" : "clear";
  if (code === 1) return cloud > 60 ? "partly" : "clear";
  if (code === 2) return "partly";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 61 || code === 63 || code === 66 || code === 80 || code === 81) return "rain";
  if (code === 65 || code === 67 || code === 82) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return cloud > 70 ? "overcast" : cloud > 25 ? "partly" : "clear";
}

const PRIVATE_IP = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
/** The network an address belongs to, never the address itself: IPv4 /24, IPv6 /48. */
export function networkOf(ip: string): string | null {
  const a = String(ip || "").trim().replace(/^::ffff:/i, "");
  if (!a || PRIVATE_IP.test(a)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return a.split(".").slice(0, 3).join(".");
  if (a.includes(":")) return a.toLowerCase().split(":").slice(0, 3).join(":");
  return null;
}

export function weatherService(o: { fetch?: typeof fetch; now?: () => number; max?: number } = {}) {
  const F = o.fetch || fetch, NOW = o.now || Date.now, MAX = o.max || 5000;
  const SALT = crypto.randomBytes(16).toString("hex");   // per process: the in-memory keys can't be matched to anything later
  const geo = new Map<string, { lat: number; lon: number; place: string; exp: number } | { none: true; exp: number }>();
  const wx = new Map<string, { w: Weather; exp: number }>();
  const inflight = new Map<string, Promise<Weather | null>>();
  const trim = (m: Map<string, unknown>) => { if (m.size > MAX) for (const k of [...m.keys()].slice(0, Math.ceil(MAX / 4))) m.delete(k); };
  const getJson = async (u: string) => { const r = await F(u, { headers: { "user-agent": "caldera-hub" }, signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<any>; };

  async function locate(ip: string, net: string) {
    const key = crypto.createHash("sha256").update(SALT + net).digest("hex").slice(0, 24), hit = geo.get(key);
    if (hit && hit.exp > NOW()) return "none" in hit ? null : hit;
    let out: { lat: number; lon: number; place: string } | null = null;
    try {
      const j = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country_code,latitude,longitude`);
      if (j?.success && Number.isFinite(j.latitude) && Number.isFinite(j.longitude)) out = { lat: j.latitude, lon: j.longitude, place: [j.city, j.region].filter(Boolean).join(", ") };
    } catch { /* try the second service */ }
    if (!out) try {
      const j = await getJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
      if (Number.isFinite(j?.latitude) && Number.isFinite(j?.longitude)) out = { lat: j.latitude, lon: j.longitude, place: [j.city, j.region].filter(Boolean).join(", ") };
    } catch { /* no location: the city falls back to the clock */ }
    geo.set(key, out ? { ...out, exp: NOW() + 6 * 3600_000 } : { none: true, exp: NOW() + 30 * 60_000 }); trim(geo);
    return out;
  }

  async function conditions(lat: number, lon: number, place: string): Promise<Weather | null> {
    const cell = `${lat.toFixed(1)},${lon.toFixed(1)}`, hit = wx.get(cell);
    if (hit && hit.exp > NOW()) return { ...hit.w, place };
    try {
      const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=weather_code,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,is_day&daily=sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=1`);
      const c = j?.current; if (!c) return null;
      const w: Weather = { c: wmoKind(Number(c.weather_code), Number(c.cloud_cover) || 0), cloud: Math.round(Number(c.cloud_cover) || 0), precip: Math.max(0, Number(c.precipitation) || 0),
        wind: Math.round(Number(c.wind_speed_10m) || 0), dir: Math.round(Number(c.wind_direction_10m) || 0), day: c.is_day ? 1 : 0,
        sunrise: (Number(j.daily?.sunrise?.[0]) || 0) * 1000, sunset: (Number(j.daily?.sunset?.[0]) || 0) * 1000, at: new Date(NOW()).toISOString() };
      wx.set(cell, { w, exp: NOW() + 15 * 60_000 }); trim(wx);
      return { ...w, place };
    } catch { return null; }
  }

  /** Current weather at the requester's approximate location, or null (local/private address, lookup failed). */
  async function forIp(ip: string): Promise<Weather | null> {
    const net = networkOf(ip); if (!net) return null;
    const k = crypto.createHash("sha256").update(SALT + net).digest("hex");
    if (inflight.has(k)) return inflight.get(k)!;
    const p = (async () => { const g = await locate(ip.replace(/^::ffff:/i, ""), net); return g ? conditions(g.lat, g.lon, g.place) : null; })().finally(() => inflight.delete(k));
    inflight.set(k, p); return p;
  }
  return { forIp, _sizes: () => ({ geo: geo.size, wx: wx.size }), _keys: () => [...geo.keys(), ...wx.keys()] };
}

type Q = (sql: string) => { all: (...a: any[]) => unknown[]; get: (...a: any[]) => unknown };

/**
 * The day around a city, for its live feed (rolling 24 hours):
 *  - today[district] = { v: unique visitors, q: 96 quarter-hour buckets of unique visitors (oldest first), t0: start of bucket 0 }
 *  - departures: visitors whose last view was 5+ minutes ago (they've left), within the last 30 minutes, timed at
 *    last view + 5 min. Private feed: { d, v (an opaque per-owner id), ts }; public feed: counts per district only.
 * Public feeds merge private districts into "Private" through `name` and never carry visitor ids.
 */
export function dayStats(q: Q, keys: string[], name: (key: string) => string, full: boolean, ownerSalt: string, since?: string | null, nowMs = Date.now()) {
  if (!keys.length) return {};
  const qs = keys.map(() => "?").join(","), Q15 = 15 * 60_000;
  const t0 = Math.floor((nowMs - 24 * 3600_000) / Q15) * Q15 + Q15, from = new Date(t0).toISOString();
  const today: Record<string, { v: number; q: number[]; t0: string }> = {}, seen: Record<string, Set<string>> = {}, bseen: Record<string, Set<string>[]> = {};
  for (const r of q(`SELECT key, ts, visitor FROM traffic WHERE key IN (${qs}) AND ts >= ? AND kind='view' LIMIT 60000`).all(...keys, from) as any[]) {
    const d = name(r.key), ix = Math.floor((Date.parse(r.ts) - t0) / Q15); if (ix < 0 || ix > 95) continue;
    const x = today[d] ||= { v: 0, q: Array(96).fill(0), t0: from };
    (seen[d] ||= new Set()).add(r.visitor);
    const bs = (bseen[d] ||= []); const set = bs[ix] ||= new Set(); if (!set.has(r.visitor)) { set.add(r.visitor); x.q[ix]++; }
  }
  for (const d of Object.keys(today)) today[d].v = seen[d].size;
  // departures: the last view per visitor and site, between 35 and 5 minutes ago (a session ends 5 minutes after its last view)
  const GONE = 5 * 60_000, lo = nowMs - 35 * 60_000, hi = nowMs - GONE;
  const rows = q(`SELECT key, visitor, MAX(ts) last FROM traffic WHERE key IN (${qs}) AND ts > ? AND kind='view' GROUP BY key, visitor`).all(...keys, new Date(lo).toISOString()) as any[];
  const dep = rows.map(r => ({ d: name(r.key), v: r.visitor as string, ts: Date.parse(r.last) + GONE })).filter(x => x.ts - GONE <= hi && x.ts > lo + GONE);
  const coarse = (n: number) => n < 20 ? n : Math.round(n / 5) * 5;
  if (full) {
    const departures = dep.sort((a, b) => a.ts - b.ts).slice(-120).map(x => ({ d: x.d, v: crypto.createHash("sha256").update(ownerSalt + x.v).digest("hex").slice(0, 10), ts: new Date(x.ts).toISOString() }));
    return { today, departures };
  }
  const after = Date.parse(String(since || "")) || 0, left: Record<string, number> = {};
  for (const x of dep) if (x.ts > after && x.ts <= nowMs) left[x.d] = (left[x.d] || 0) + 1;
  const pubToday: typeof today = {};
  for (const [d, x] of Object.entries(today)) pubToday[d] = { v: coarse(x.v), q: x.q.map(coarse), t0: x.t0 };
  return { today: pubToday, left };
}

/** What the owner sees under their city when live visitors or agent drones aren't set up yet. Owner-only: carries keys. */
export function ownerSetup(q: Q, owner: string, hub: string) {
  const wk = new Date(Date.now() - 7 * 86400_000).toISOString();
  const sites = q("SELECT key, project FROM traffic_sites WHERE owner=? ORDER BY project").all(owner) as { key: string; project: string }[];
  const liveOn = !!q("SELECT 1 FROM traffic t JOIN traffic_sites s ON s.key=t.key WHERE s.owner=? AND t.ts > ? LIMIT 1").get(owner, wk);
  const agentsOn = !!q("SELECT 1 FROM agents WHERE owner=? AND ts > ? LIMIT 1").get(owner, wk);
  const ak = q("SELECT key, secret FROM agent_keys WHERE owner=?").get(owner) as { key: string; secret: string } | undefined;
  const base = hub.replace(/\/$/, "");
  const agentPrompt = ak ? `Set up the Caldera agent hook on this computer, so my Caldera city shows what my AI agents are working on.

1. Download ${base}/agent-hook.mjs to ~/.caldera/agent-hook.mjs (create the folder). Read it first: it reads the hook event from stdin, works out the repo (git remote name) and a short task title, and posts only that to my Caldera hub, with a 1.5 second timeout.
2. Write ~/.caldera/agent.json (chmod 600): {"hub": "${base}", "key": "${ak.key}", "secret": "${ak.secret}", "machine": "<a short name for this computer>"}
3. In ~/.claude/settings.json, add hooks (keep existing ones) that run \`node ~/.caldera/agent-hook.mjs\` for UserPromptSubmit, PostToolUse, Stop, Notification and SessionEnd.
4. Test: echo '{"hook_event_name":"UserPromptSubmit","session_id":"caldera-test-1","cwd":"'$PWD'","prompt":"Testing the Caldera agent hook"}' | node ~/.caldera/agent-hook.mjs, then send SessionEnd for the same session.` : "";
  return { liveOff: !liveOn, agentsOff: !agentsOn, hub: base, sites: liveOn ? [] : sites.map(s => ({ key: s.key, project: s.project })), agentPrompt: agentsOn ? "" : agentPrompt };
}

/** Script tag carrying the extras into a city page (weather endpoint + owner setup), safe to inline. */
export function extrasScript(cfg: object): string {
  return `<script>window.CALDERA_EXTRAS=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>`;
}
