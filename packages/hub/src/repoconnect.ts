/**
 * GitHub circle friendships.
 *
 * - Shared repos: two members who both contributed to the same PUBLIC repo become friends (kind "repo", why = owner/repo).
 *   A fork counts for its parent. Private and archived repos are never read.
 * - Follows: a member who follows (or is followed by) another member on GitHub becomes their friend (kind "github",
 *   why = "you follow each other on GitHub" / "@a follows @b on GitHub").
 * - Waiting connections: circle logins that aren't on Caldera yet are kept (login + relation + repo only, never an email)
 *   so that when they join, they start out connected to everyone who has them in their circle. Pruned after 90 days unseen.
 * - Both members must have the setting on (autoConnectGithub / autoConnectRepos, default on). A removed repo or GitHub
 *   friendship leaves a tombstone and never comes back.
 */
export interface RepoMember { id: string; handle: string; logins: string[]; optOut: boolean }
export interface RepoPair { a: string; b: string; ah: string; bh: string; repo: string; kind: "repo" | "github"; why: string; action: "connect" | "already" | "tombstone" | "opted-out" }
export interface CircleEdge { login: string; relation: "following" | "follower" | "repo"; repo?: string }
export interface RepoDeps {
  members(): RepoMember[];
  token(): Promise<string | null>;
  fetch: typeof fetch;
  kindOf(a: string, b: string): string | null;     // the existing friendship's kind, or null when not friends
  tombstoned(a: string, b: string): boolean;
  connect(a: string, b: string, kind: "repo" | "github", why: string): void;
  /** store a member's whole circle (replaces what was there for the relations scanned) */
  storeCircle?(member: string, edges: CircleEdge[]): void;
  pause?: number;                                  // ms between GitHub calls (rate-limit friendly)
  log?: (...a: unknown[]) => void;
}
/** connect rank: a shared repo beats a follow, which beats the founder's welcome link */
const RANK: Record<string, number> = { founder: 0, github: 1, repo: 2, request: 3, invite: 3 };
export const followWhy = (aFollowsB: boolean, bFollowsA: boolean, ah: string, bh: string) =>
  aFollowsB && bFollowsA ? "you follow each other on GitHub" : aFollowsB ? `@${ah} follows @${bh} on GitHub` : `@${bh} follows @${ah} on GitHub`;

export function repoConnector(d: RepoDeps) {
  const etags = new Map<string, { etag: string; body: unknown }>();
  let remaining = 5000, running = false;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function gh(path: string, tok: string | null): Promise<any> {
    if (remaining < 60) throw new Error("GitHub rate limit low; trying again next run");
    const c = etags.get(path), headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "caldera-hub" };
    if (tok) headers.authorization = "Bearer " + tok;
    if (c) headers["if-none-match"] = c.etag;
    const r = await d.fetch("https://api.github.com" + path, { headers });
    const rem = Number(r.headers.get("x-ratelimit-remaining")); if (Number.isFinite(rem)) remaining = rem;
    if (d.pause) await sleep(d.pause);
    if (r.status === 304 && c) return c.body;
    if (r.status === 204 || r.status === 404 || r.status === 409 || r.status === 451) return [];   // empty, gone, or blocked
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
    const body = await r.json(), et = r.headers.get("etag");
    if (et) etags.set(path, { etag: et, body });
    return body;
  }
  async function pages(path: string, tok: string | null, max: number): Promise<any[]> {
    const out: any[] = [];
    for (let p = 1; out.length < max && p <= Math.ceil(max / 100); p++) {
      const b = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`, tok); if (!Array.isArray(b) || !b.length) break;
      out.push(...b); if (b.length < 100) break;
    }
    return out.slice(0, max);
  }

  /** Scan circles and connect members. `only`: scan just that member's circle (pairs still against everyone). */
  async function run(o: { dry?: boolean; maxRepos?: number; maxFollow?: number; only?: string } = {}): Promise<RepoPair[]> {
    if (running) return [];
    running = true;
    try {
      const all = d.members().filter(m => m.logins.length), byLogin = new Map<string, RepoMember>();
      for (const m of all) for (const l of m.logins) if (!byLogin.has(l.toLowerCase())) byLogin.set(l.toLowerCase(), m);
      const scan = o.only ? all.filter(m => m.id === o.only) : all;
      if (!scan.length) return [];
      const tok = await d.token().catch(() => null);
      const repoMembers = new Map<string, Set<string>>(), seenRepo = new Set<string>(), follows = new Set<string>();   // "a>b": member a follows member b
      for (const m of scan) {
        const edges: CircleEdge[] = [], own = new Set(m.logins.map(l => l.toLowerCase()));
        for (const login of m.logins.slice(0, 2)) {
          // follows, both directions
          for (const [rel, path] of [["following", `/users/${encodeURIComponent(login)}/following`], ["follower", `/users/${encodeURIComponent(login)}/followers`]] as const) {
            let list: any[] = [];
            try { list = await pages(path, tok, o.maxFollow ?? 500); } catch (e: any) { d.log?.("circle", rel, login, e.message); continue; }
            for (const u of list) {
              const l = String(u?.login || "").toLowerCase(); if (!l || own.has(l)) continue;
              edges.push({ login: l, relation: rel });
              const other = byLogin.get(l); if (other && other.id !== m.id) follows.add(rel === "following" ? `${m.id}>${other.id}` : `${other.id}>${m.id}`);
            }
          }
          // shared repos (and co-contributors who aren't members yet)
          let repos: any[] = [];
          try { repos = await gh(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=100`, tok); } catch (e: any) { d.log?.("circle repos", login, e.message); continue; }
          for (const r of (Array.isArray(repos) ? repos : []).filter(r => !r.private && !r.archived).slice(0, o.maxRepos ?? 30)) {
            const full = String(r.full_name || ""); if (!full || seenRepo.has(full.toLowerCase())) continue; seenRepo.add(full.toLowerCase());
            let credit = full;
            if (r.fork) { try { const det = await gh(`/repos/${full}`, tok); if (det?.parent?.full_name && !det.parent.private) credit = det.parent.full_name; } catch { /* keep the fork's name */ } }
            let contributors: any[] = [];
            try { contributors = await gh(`/repos/${full}/contributors?per_page=100`, tok); } catch (e: any) { d.log?.("circle contributors", full, e.message); continue; }
            const here = new Set<string>(), list = Array.isArray(contributors) ? contributors : [];
            // people to invite later come only from the member's own (non-fork) repos with a small team: a fork of a big
            // project lists thousands of upstream contributors who aren't this member's circle
            const invitable = !r.fork && list.length <= 50;
            for (const c of list) {
              const l = String(c?.login || "").toLowerCase(); if (!l || l.endsWith("[bot]")) continue;
              const mm = byLogin.get(l); if (mm) here.add(mm.id);
              if (!own.has(l) && invitable) edges.push({ login: l, relation: "repo", repo: credit });
            }
            if (here.size < 2 || !here.has(m.id)) continue;
            const set = repoMembers.get(credit) || new Set<string>(); here.forEach(x => set.add(x)); repoMembers.set(credit, set);
          }
        }
        if (!o.dry) d.storeCircle?.(m.id, edges);
      }
      // pairs: shared repo first, then follows
      const byId = new Map(all.map(m => [m.id, m])), pairs = new Map<string, RepoPair>();
      const add = (a: string, b: string, kind: "repo" | "github", why: string, repo = "") => {
        const [x, y] = [a, b].sort() as [string, string], k = x + "|" + y, prev = pairs.get(k);
        if (prev && (prev.kind === "repo" || kind === "github")) return;   // a repo reason wins over a follow
        const A = byId.get(x)!, B = byId.get(y)!, cur = d.kindOf(x, y);
        const action: RepoPair["action"] = A.optOut || B.optOut ? "opted-out" : d.tombstoned(x, y) ? "tombstone"
          : cur && (RANK[cur] ?? 3) >= RANK[kind]! ? "already" : "connect";
        pairs.set(k, { a: x, b: y, ah: A.handle, bh: B.handle, repo, kind, why, action });
      };
      for (const [repo, ids] of repoMembers) {
        const list = [...ids].sort();
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i]!, list[j]!, "repo", repo, repo);
      }
      for (const f of follows) {
        const [a, b] = f.split(">") as [string, string]; if (!byId.has(a) || !byId.has(b)) continue;
        const A = byId.get(a)!, B = byId.get(b)!;
        add(a, b, "github", followWhy(true, follows.has(`${b}>${a}`), A.handle, B.handle));
      }
      const out = [...pairs.values()];
      if (!o.dry) for (const p of out) if (p.action === "connect") d.connect(p.a, p.b, p.kind, p.why);
      return out;
    } finally { running = false; }
  }
  /** A GitHub user's PUBLIC profile email (what they chose to show on github.com), or null. Never stored. */
  async function publicEmail(login: string): Promise<string | null> {
    try { const tok = await d.token().catch(() => null), u = await gh(`/users/${encodeURIComponent(login)}`, tok);
      return typeof u?.email === "string" && u.email.includes("@") ? u.email : null; } catch { return null; }
  }
  return { run, publicEmail, rateRemaining: () => remaining, busy: () => running };
}
