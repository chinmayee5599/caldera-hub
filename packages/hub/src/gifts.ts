/**
 * Light-ups: every member gets one gift a day (the founder two) to celebrate someone's city, or one of its public repos,
 * on the world map. A gift lights the city up for 24 hours (a searchlight from the gifted building; more gifts, more
 * beams) and stacks with everyone else's, so friends rally to light each other up. The feed and the recipient's bell
 * say who lit up whom.
 *
 * Rules: listed members only, never yourself, one gift per city per giver per day; a repo must be a public building in
 * the recipient's public city (padlocked buildings have no names, so they can only be lit as part of the city).
 */
import type http from "node:http";

const H24 = 24 * 3600_000;
export interface GiftsCtx {
  q: (sql: string) => any; now: () => string;
  profile: (id: string) => any; byHandle: (h: string) => any; listed: (pr: any) => boolean; modOf: (h: string | null, id?: string) => any;
  memberOf: (req: http.IncomingMessage) => string | null; sameOrigin: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<any>; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  tooMany: (key: string, max: number, windowMs?: number) => boolean;
  founder: string | null;
  /** the public (named) repos in a member's public city */
  publicRepos: (handle: string) => string[];
  notify?: (to: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void;
  onChange?: () => void;
}
/** the gift day: Los Angeles calendar day, so the allowance resets at midnight Pacific */
export const giftDay = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export function gifts(c: GiftsCtx) {
  const { q } = c;
  q(`CREATE TABLE IF NOT EXISTS gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, giver TEXT, recipient TEXT, repo TEXT, day TEXT, ts TEXT, UNIQUE (giver, recipient, day))`).run();
  q(`CREATE INDEX IF NOT EXISTS gifts_ts ON gifts(ts)`).run();
  const visible = (pr: any) => !!pr?.handle && c.listed(pr) && !c.modOf(pr.handle, pr.id);
  const maxFor = (pr: any) => c.founder && pr?.handle === c.founder ? 2 : 1;
  const usedToday = (id: string) => (q("SELECT COUNT(*) n FROM gifts WHERE giver=? AND day=?").get(id, giftDay()) as any).n as number;

  /** who's lit up right now (last 24 hours): "@handle" -> how many gifts, who gave them (newest first), which repos */
  function litNow(): Record<string, { n: number; by: string[]; repos: Record<string, number> }> {
    const out: Record<string, { n: number; by: string[]; repos: Record<string, number> }> = {};
    for (const g of q("SELECT giver, recipient, repo FROM gifts WHERE ts > ? ORDER BY ts DESC").all(new Date(Date.now() - H24).toISOString()) as any[]) {
      const to = c.profile(g.recipient), from = c.profile(g.giver); if (!visible(to) || !visible(from)) continue;
      const k = "@" + to.handle, x = out[k] || (out[k] = { n: 0, by: [], repos: {} });
      x.n++; if (x.by.length < 8) x.by.push(from.handle); if (g.repo) x.repos[g.repo] = (x.repos[g.repo] || 0) + 1;
    }
    return out;
  }
  function meState(id: string | null) {
    const pr = id ? c.profile(id) : null; if (!visible(pr)) return { member: !!pr, listed: false, left: 0, max: 0, today: [] as string[] };
    const today = (q("SELECT recipient FROM gifts WHERE giver=? AND day=?").all(id, giftDay()) as any[]).map(r => c.profile(r.recipient)?.handle).filter(Boolean);
    return { member: true, listed: true, handle: pr.handle, left: Math.max(0, maxFor(pr) - today.length), max: maxFor(pr), today };
  }
  function give(meId: string, toHandle: string, repoIn: string): { status: number; body: any } {
    const me = c.profile(meId); if (!visible(me)) return { status: 403, body: { error: "List your page in People to light up cities (Settings)." } };
    const to = c.byHandle(String(toHandle || "").toLowerCase().replace(/^@/, "")); if (!visible(to)) return { status: 404, body: { error: "That city isn't on the map." } };
    if (to.id === meId) return { status: 400, body: { error: "That's your own city. Light up someone else's." } };
    let repo = String(repoIn || "").slice(0, 100);
    if (repo) { const named = c.publicRepos(to.handle).find(r => r.toLowerCase() === repo.toLowerCase()); if (!named) return { status: 400, body: { error: "Pick one of their public buildings, or the whole city." } }; repo = named; }
    if (c.tooMany("gift:" + meId, 20)) return { status: 429, body: { error: "Slow down a little." } };
    const day = giftDay();
    if (q("SELECT 1 FROM gifts WHERE giver=? AND recipient=? AND day=?").get(meId, to.id, day)) return { status: 409, body: { error: `You already lit up @${to.handle}'s city today.` } };
    if (usedToday(meId) >= maxFor(me)) return { status: 429, body: { error: maxFor(me) > 1 ? "You've given both of today's gifts. New ones at midnight Pacific." : "You've given today's gift. A new one at midnight Pacific." } };
    q("INSERT INTO gifts (giver, recipient, repo, day, ts) VALUES (?,?,?,?,?)").run(meId, to.id, repo || null, day, c.now());
    const lit = litNow()["@" + to.handle];
    try { c.notify?.(to.id, { title: lit && lit.n > 1 ? `${lit.n} people lit up your city today` : `@${me.handle} lit up your city${repo ? ` for ${repo}` : ""}`,
      body: lit && lit.n > 1 ? `Latest: @${me.handle}${repo ? ` (for ${repo})` : ""}. Your city glows on the world map for 24 hours.` : "Your city glows on the world map for the next 24 hours.",
      ctaLabel: "See it on the map", ctaUrl: "/world", key: `gift:${to.id}:${day}` }); } catch { /* the gift stands */ }
    c.onChange?.();
    return { status: 200, body: { ok: true, to: to.handle, repo: repo || null, lit: lit || { n: 1, by: [me.handle], repos: repo ? { [repo]: 1 } : {} }, ...meState(meId) } };
  }
  /** feed items: every gift in the last two weeks */
  const recent = () => (q("SELECT giver, recipient, repo, ts FROM gifts WHERE ts > ? ORDER BY ts DESC LIMIT 200").all(new Date(Date.now() - 14 * H24).toISOString()) as any[]);
  function erase(id: string) { q("DELETE FROM gifts WHERE giver=? OR recipient=?").run(id, id); }

  async function route(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
    if (req.method === "GET" && p === "/v1/gifts/me") { res.setHeader("cache-control", "no-store"); c.json(res, 200, meState(c.memberOf(req))); return true; }
    if (req.method === "GET" && p === "/v1/gifts/lit") { res.setHeader("cache-control", "no-store"); c.json(res, 200, { lit: litNow() }); return true; }
    if (req.method === "POST" && p === "/v1/gifts") {
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const me = c.memberOf(req); if (!me) { c.json(res, 401, { error: "Sign in to light up cities." }); return true; }
      const b = await c.readBody(req).catch(() => ({}));
      const r = give(me, String(b.to || ""), String(b.repo || "")); c.json(res, r.status, r.body); return true;
    }
    return false;
  }
  return { route, litNow, meState, give, recent, erase };
}
