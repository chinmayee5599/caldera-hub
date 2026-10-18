/**
 * Shared-repo friendships: two members who both contributed to the same PUBLIC GitHub repo become friends (kind "repo",
 * why = owner/repo). A fork counts for its parent: if member B forked member A's repo and committed to it, they both
 * work on A's repo. Private repos are never read. Members can opt out (manifest autoConnectRepos: false), and a
 * removed repo friendship leaves a tombstone so the pair is never connected again.
 */
export interface RepoMember { id: string; handle: string; logins: string[]; optOut: boolean }
export interface RepoPair { a: string; b: string; ah: string; bh: string; repo: string; action: "connect" | "already" | "tombstone" | "opted-out" }
export interface RepoDeps {
  members(): RepoMember[];
  token(): Promise<string | null>;
  fetch: typeof fetch;
  kindOf(a: string, b: string): string | null;     // the existing friendship's kind, or null when not friends
  tombstoned(a: string, b: string): boolean;
  connect(a: string, b: string, repo: string): void;
  pause?: number;                                  // ms between GitHub calls (rate-limit friendly)
  log?: (...a: unknown[]) => void;
}

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
    if (r.status === 204 || r.status === 404 || r.status === 409 || r.status === 451) return [];   // empty, gone, or blocked repo
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
    const body = await r.json(), et = r.headers.get("etag");
    if (et) etags.set(path, { etag: et, body });
    return body;
  }

  async function run(o: { dry?: boolean; maxRepos?: number } = {}): Promise<RepoPair[]> {
    if (running) return [];
    running = true;
    try {
      const ms = d.members().filter(m => m.logins.length), byLogin = new Map<string, RepoMember>();
      for (const m of ms) for (const l of m.logins) if (!byLogin.has(l.toLowerCase())) byLogin.set(l.toLowerCase(), m);
      if (ms.length < 2) return [];
      const tok = await d.token().catch(() => null);
      const repoMembers = new Map<string, Set<string>>(), seenRepo = new Set<string>();
      for (const m of ms) {
        for (const login of m.logins.slice(0, 2)) {
          let repos: any[] = [];
          try { repos = await gh(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=100`, tok); } catch (e: any) { d.log?.("repo-connect repos", login, e.message); continue; }
          for (const r of (Array.isArray(repos) ? repos : []).filter(r => !r.private && !r.archived).slice(0, o.maxRepos ?? 30)) {
            const full = String(r.full_name || ""); if (!full || seenRepo.has(full.toLowerCase())) continue; seenRepo.add(full.toLowerCase());
            let credit = full;
            if (r.fork) { try { const det = await gh(`/repos/${full}`, tok); if (det?.parent?.full_name && !det.parent.private) credit = det.parent.full_name; } catch { /* keep the fork's name */ } }
            let contributors: any[] = [];
            try { contributors = await gh(`/repos/${full}/contributors?per_page=100`, tok); } catch (e: any) { d.log?.("repo-connect contributors", full, e.message); continue; }
            const here = new Set<string>();
            for (const c of Array.isArray(contributors) ? contributors : []) { const mm = byLogin.get(String(c?.login || "").toLowerCase()); if (mm) here.add(mm.id); }
            if (here.size < 2) continue;
            const set = repoMembers.get(credit) || new Set<string>(); here.forEach(x => set.add(x)); repoMembers.set(credit, set);
          }
        }
      }
      const byId = new Map(ms.map(m => [m.id, m])), pairs = new Map<string, RepoPair>();
      for (const [repo, ids] of repoMembers) {
        const list = [...ids].sort();
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!, b = list[j]!, k = a + "|" + b; if (pairs.has(k)) continue;
          const A = byId.get(a)!, B = byId.get(b)!, kind = d.kindOf(a, b);
          const action: RepoPair["action"] = A.optOut || B.optOut ? "opted-out" : d.tombstoned(a, b) ? "tombstone"
            : kind && kind !== "founder" ? "already" : "connect";   // a welcome (founder) link upgrades to the shared repo
          pairs.set(k, { a, b, ah: A.handle, bh: B.handle, repo, action });
        }
      }
      const out = [...pairs.values()];
      if (!o.dry) for (const p of out) if (p.action === "connect") d.connect(p.a, p.b, p.repo);
      return out;
    } finally { running = false; }
  }
  return { run, rateRemaining: () => remaining };
}
