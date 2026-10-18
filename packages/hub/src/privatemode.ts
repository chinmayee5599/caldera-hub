/**
 * How a member's private repos show on their PUBLIC city, the World, their share card and live feeds (their own private
 * view always shows everything): "show" (padlocked buildings in place), "anonymous" (one separate district of identical
 * padlocks, no sizes, activity or projects) or "hidden" (no trace).
 *
 * The setting is enforced here, on the hub, when pages and feeds are served - so it holds for every plugin version and
 * for GitHub-hosted pages alike. Where it comes from, latest first: the web setting (/settings, any owner), the signed
 * manifest's privateRepos (Obsidian: Caldera settings or Caldera/profile.md). Unset: "show" for everyone
 * (building sizes and activity are visible, names never are); members who want less choose anonymous or hidden.
 */
import { privateModeOf, type PrivateMode } from "../../../../caldera/packages/plugin/src/city";

type Q = (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown };

export function privateModes(q: Q, nowIso = () => new Date().toISOString(), sinceOverride?: string) {
  q("CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v TEXT)").run();
  q("CREATE TABLE IF NOT EXISTS private_modes (owner TEXT PRIMARY KEY, mode TEXT, ts TEXT)").run();
  q("CREATE TABLE IF NOT EXISTS private_mode_prompted (owner TEXT PRIMARY KEY, ts TEXT)").run();
  let since = (q("SELECT v FROM hub_meta WHERE k='private_mode_since'").get() as any)?.v as string | undefined;
  if (sinceOverride) since = sinceOverride;   // tests: treat everyone as joined before (or after) the setting existed
  else if (!since) { since = nowIso(); q("INSERT OR REPLACE INTO hub_meta VALUES ('private_mode_since', ?)").run(since); }
  const bodyOf = (pr: any) => { try { return JSON.parse(pr.manifest).body || {}; } catch { return {}; } };

  /** the member's explicit choice, if they made one (web or manifest, whichever is newer) */
  function chosen(pr: any): PrivateMode | undefined {
    if (!pr?.id) return undefined;
    const web = q("SELECT mode, ts FROM private_modes WHERE owner=?").get(pr.id) as any, b = bodyOf(pr);
    const man = privateModeOf(b.privateRepos), mt = String(b.updated || pr.updated || "");
    if (web && privateModeOf(web.mode) && (!man || String(web.ts) >= mt)) return web.mode;
    return man;
  }
  return {
    since,
    chosen,
    /** what visitors get: the choice, else "show" */
    modeFor(pr: any): PrivateMode { return chosen(pr) || "show"; },
    set(owner: string, mode: unknown) { const m = privateModeOf(mode); if (!m) return false; q("INSERT OR REPLACE INTO private_modes VALUES (?,?,?)").run(owner, m, nowIso()); return true; },
    /** the one-time "choose how your private repos show" prompt: true the first time only */
    promptOnce(owner: string) { if (q("SELECT 1 FROM private_mode_prompted WHERE owner=?").get(owner)) return false; q("INSERT INTO private_mode_prompted VALUES (?,?)").run(owner, nowIso()); return true; },
    erase(owner: string) { q("DELETE FROM private_modes WHERE owner=?").run(owner); q("DELETE FROM private_mode_prompted WHERE owner=?").run(owner); },
  };
}

/** Live feeds for visitors: with private work anonymous or hidden, nothing in them may point at it - no "Private"
 *  district counts, arrivals, footprints, departures, or drones over private repos (or unmapped ones). */
export function scrubPrivateLive<T>(o: T, mode: PrivateMode): T {
  if (!o || mode === "show") return o;
  const priv = (k: unknown) => k === "Private" || k === "Vault" || k === "";
  const out: any = { ...(o as any) };
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) out[k] = v.filter((x: any) => !(x && typeof x === "object" && "d" in x && priv(x.d)));
    else if (v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as any).filter(([kk]) => !priv(kk)));
  }
  return out;
}
