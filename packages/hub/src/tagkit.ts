/**
 * "What people are building": the public parts. Tag types, reading public repo files (README signal, dependency
 * manifests), how a member's own tags combine with extracted ones, and a basic extraction job (GitHub topics and
 * languages only). caldera.social's vocabulary, rules and AI normalisation are a private extension (src/ext.ts).
 *
 * Only PUBLIC GitHub signals are ever read: public, non-fork, non-archived repos. Private repos contribute their
 * language only (from the padlocked buildings already on the public city).
 */
import type { TagVocab } from "./ext";

export type TagKind = "problem" | "stack" | "custom";
export interface Tag { t: string; kind: TagKind; w: number; repo?: string }
export interface RepoSignals { repo: string; desc: string; topics: string[]; lang: string; readme: string; deps: string[] }

/** a tag as it should be shown: a known name keeps its spelling; anything else is trimmed and capped */
export function canonical(t: string, v: TagVocab): { t: string; kind: TagKind } | null {
  const s = String(t || "").replace(/[^\p{L}\p{N} +.#&/'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 32); if (s.length < 2) return null;
  const low = s.toLowerCase();
  const p = v.problems.find(n => n.toLowerCase() === low); if (p) return { t: p, kind: "problem" };
  const st = v.stack.find(n => n.toLowerCase() === low); if (st) return { t: st, kind: "stack" };
  return { t: s, kind: "custom" };
}

/** README: headings + the first real paragraph, badges/HTML/links stripped, capped at ~600 chars of signal. */
export function readmeSignal(md: string): string {
  const txt = String(md || "").slice(0, 2048).replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const lines = txt.split(/\r?\n/), heads = lines.filter(l => /^#{1,3}\s/.test(l)).map(l => l.replace(/^#+\s*/, "").trim()).slice(0, 8);
  const para = lines.filter(l => l.trim() && !/^#/.test(l) && !/^[-=*_`|>]{2,}/.test(l.trim())).slice(0, 3).join(" ");
  return [...heads, para].join(" · ").replace(/\s+/g, " ").slice(0, 600);
}
export function depsOf(file: string, text: string): string[] {
  const out = new Set<string>(), t = String(text || "").slice(0, 60_000);
  try {
    if (file === "package.json") { const j = JSON.parse(t); for (const k of ["dependencies", "devDependencies", "peerDependencies"]) for (const n of Object.keys(j?.[k] || {})) out.add(n); }
    else if (file === "composer.json") { const j = JSON.parse(t); for (const n of Object.keys(j?.require || {})) out.add(n); }
    else if (file === "requirements.txt") for (const l of t.split(/\r?\n/)) { const m = l.trim().match(/^([A-Za-z0-9_.-]+)/); if (m && !l.trim().startsWith("#") && !l.trim().startsWith("-")) out.add(m[1]!.toLowerCase()); }
    else if (file === "pyproject.toml") for (const m of t.matchAll(/^\s*"([A-Za-z0-9_.-]+)\s*[<>=~!\[;"]/gm)) out.add(m[1]!.toLowerCase());
    else if (file === "go.mod") for (const m of t.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gim)) out.add(m[1]!.toLowerCase());
    else if (file === "Cargo.toml") { const sec = t.split(/^\[/m).find(s => s.startsWith("dependencies]")) || ""; for (const m of sec.matchAll(/^([a-z0-9_-]+)\s*=/gim)) out.add(m[1]!.toLowerCase()); }
    else if (file === "Gemfile") for (const m of t.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) out.add(m[1]!.toLowerCase());
  } catch { /* unparseable manifest: no deps */ }
  return [...out].slice(0, 200);
}
export const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json"];

/** What a member shows: owner-added tags first, then extracted ones (unless hidden or auto tags are off). */
export function effectiveTags(o: { extracted: Tag[]; auto: boolean; added: string[]; hidden: string[] }, v: TagVocab): Tag[] {
  const hid = new Set(o.hidden.map(h => h.toLowerCase())), out: Tag[] = [], seen = new Set<string>();
  for (const a of o.added) { const c = canonical(a, v); if (!c || seen.has(c.t.toLowerCase()) || hid.has(c.t.toLowerCase())) continue; seen.add(c.t.toLowerCase()); out.push({ t: c.t, kind: c.kind, w: 1 }); }
  if (o.auto) for (const t of o.extracted) { const k = t.t.toLowerCase(); if (seen.has(k) || hid.has(k)) continue; seen.add(k); out.push(t); }
  const rank = (t: Tag) => (t.kind === "stack" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.w - a.w).slice(0, 14);
}

// ---------------------------------------------------------------- the extraction job (contract + a basic public one)
export interface TagMember { id: string; handle: string; logins: string[]; topics: string[]; privateLangs: string[] }
export interface TagDeps {
  members(): TagMember[];
  /** the shared token (any hosted member's); used only for members whose own token we don't hold */
  token(): Promise<string | null>;
  /** a member's own token, so reading their repos spends their own GitHub budget, not the shared one */
  tokenFor?(member: string): Promise<string | null>;
  /** stop using a token below this many remaining calls (sign-ins and builds always keep headroom) */
  floor?: number;
  fetch: typeof fetch;
  llmKey?: string; model?: string;
  cacheGet(repo: string): { pushed: string; signals: RepoSignals } | null;
  cacheSet(repo: string, pushed: string, s: RepoSignals): void;
  store(member: string, tags: Tag[], source: string): void;
  pause?: number; log?: (...a: unknown[]) => void;
}
export interface TagJob {
  run(o?: { dry?: boolean; only?: string; maxRepos?: number }): Promise<{ handle: string; tags: Tag[]; source: string; repos: string[] }[]>;
  rateRemaining(): number; busy(): boolean;
}

/** Public extraction: each member's public repos' GitHub topics and languages (no READMEs, no files, no AI). */
export function basicTagExtractor(d: TagDeps): TagJob {
  let running = false, left = 5000;
  async function repos(login: string, tok: string | null): Promise<any[]> {
    if (left < (d.floor ?? 500)) throw new Error("GitHub rate limit low; trying again next run");
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "caldera-hub" }; if (tok) headers.authorization = "Bearer " + tok;
    const r = await d.fetch(`https://api.github.com/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&per_page=100`, { headers });
    const rh = r.headers.get("x-ratelimit-remaining"); if (rh != null && Number.isFinite(Number(rh))) left = Number(rh);
    if (!r.ok) return [];
    const list = await r.json(); return (Array.isArray(list) ? list : []).filter((x: any) => x && !x.private && !x.fork && !x.archived);
  }
  async function run(o: { dry?: boolean; only?: string } = {}) {
    if (running) return []; running = true;
    try {
      const shared = await d.token().catch(() => null), out: { handle: string; tags: Tag[]; source: string; repos: string[] }[] = [];
      for (const m of d.members().filter(x => (!o.only || x.id === o.only) && (x.logins.length || x.topics.length))) {
        const tok = (m.logins.length && d.tokenFor ? await d.tokenFor(m.id).catch(() => null) : null) || shared;
        const n = new Map<string, Tag>(), names: string[] = [];
        for (const login of m.logins.slice(0, 2)) for (const r of await repos(login, tok).catch(() => [])) {
          names.push(String(r.name));
          for (const t of (Array.isArray(r.topics) ? r.topics : []).slice(0, 10)) { const k = String(t).toLowerCase(); if (!n.has(k)) n.set(k, { t: String(t), kind: "custom", w: 0.5, repo: String(r.name) }); }
          if (r.language) { const k = String(r.language).toLowerCase(); if (!n.has(k)) n.set(k, { t: String(r.language), kind: "stack", w: 0.5, repo: String(r.name) }); }
        }
        for (const t of m.topics) { const k = t.toLowerCase(); if (!n.has(k)) n.set(k, { t, kind: "custom", w: 0.5, repo: "topics" }); }
        const tags = [...n.values()].slice(0, 12); out.push({ handle: m.handle, tags, source: names.length ? "github" : "topics", repos: names });
        if (!o.dry) d.store(m.id, tags, names.length ? "github" : "topics");
      }
      return out;
    } finally { running = false; }
  }
  return { run, rateRemaining: () => left, busy: () => running };
}
