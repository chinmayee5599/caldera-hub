/**
 * Caldera open core: extension hooks.
 *
 * The public hub calls these hooks for the parts of Caldera that rank, match and police: who to suggest, which GitHub
 * accounts may sign up, and the GitHub circle jobs. The public versions below are deliberately simple and complete
 * enough to run a hub. caldera.social loads its own implementations at startup from CALDERA_PRIVATE_DIR (a CommonJS
 * bundle whose `ext` export overrides any of these); without it, the fallbacks run.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Tag, TagDeps, TagJob } from "./tagkit";
import { basicTagExtractor } from "./tagkit";
import type { DigestData } from "./email";
import { publicMatcher, type FeedMatcher } from "./feed";

/** A member's public interests, as the hub reads them from their signed manifest. */
export interface Interests { topics: string[]; groups: string[]; words: string[] }
/** Someone who could be suggested to a member (never self, friends, pending requests or unlisted: the hub filters). */
export interface SuggestCand { id: string; handle: string; isNew: boolean; week: number; gravity: number; interests: Interests; /** problem tags both members have (from the tags hooks) */ building?: { t: string; w: number }[] }
export interface Suggestion { score: number; why: string }

/** The GitHub account fields the sign-up gate sees. */
export interface GhAccount { created_at?: string; public_repos?: number; followers?: number }

// GitHub circle jobs (shared repos, follows, waiting connections)
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
  storeCircle?(member: string, edges: CircleEdge[]): void;
  pause?: number;
  log?: (...a: unknown[]) => void;
}
export interface RepoJob {
  run(o?: { dry?: boolean; only?: string }): Promise<RepoPair[]>;
  /** a GitHub user's PUBLIC profile email, or null; never stored */
  publicEmail(login: string): Promise<string | null>;
  rateRemaining(): number;
  busy(): boolean;
}

/** What the daily email's setup tip can see about a member. */
export interface SetupState { hosted: boolean; hasCity: boolean; hasSites: boolean; live: boolean; agents: boolean; account: string }
export type SetupStep = { label: string; why: string; how: string; url: string } | undefined;
/** The tag vocabulary: problem spaces and stack names a tag can be normalised to. */
export interface TagVocab { problems: string[]; stack: string[] }

export interface Ext {
  /** names of the hooks a private bundle replaced (for the startup log) */
  loaded: string[];
  suggestScore(me: Interests, cand: SuggestCand): Suggestion;
  githubAccountOk(me: GhAccount, now?: number): boolean;
  repoConnector(d: RepoDeps): RepoJob;
  /** "What people are building": the vocabulary, the extraction job, how two members' tags overlap, search relevance */
  tagVocab(): TagVocab;
  tagExtractor(d: TagDeps): TagJob;
  tagShared(a: Tag[], b: Tag[]): { t: string; w: number }[];
  tagRelevance(tags: Tag[], text: string, tag: string, term: string): number;
  /** the daily email: is today worth an email, its subject, the one setup tip */
  digestActive(d: DigestData): boolean;
  digestSubject(d: DigestData): string;
  digestSetup(s: SetupState): SetupStep;
  /** the feed: who fits a post, link and posting policy */
  feedMatcher(): FeedMatcher;
}

/** Public suggestions: people in your groups first, then new members, then whoever was active this week. */
function suggestScore(me: Interests, c: SuggestCand): Suggestion {
  const grp = c.interests.groups.filter(g => me.groups.includes(g));
  const score = 4 * grp.length + (c.isNew ? 2 : 0) + Math.min(1, c.week / 300);
  return { score, why: grp.length ? `Also in ${grp[0]}` : c.isNew ? "New this week" : c.week ? "Active this week" : "On Caldera" };
}

/** Public sign-up gate: any GitHub account may sign up (self-hosters add their own rules). */
const githubAccountOk = (_me: GhAccount, _now?: number) => true;

/** Public GitHub circle job: off (no scanning); public emails are still looked up for user-initiated invites. */
function repoConnector(d: RepoDeps): RepoJob {
  return {
    run: async () => [],
    async publicEmail(login: string) {
      try {
        const tok = await d.token().catch(() => null), headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "caldera-hub" };
        if (tok) headers.authorization = "Bearer " + tok;
        const r = await d.fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers });
        const u = r.ok ? await r.json() as any : null;
        return typeof u?.email === "string" && u.email.includes("@") ? u.email : null;
      } catch { return null; }
    },
    rateRemaining: () => 5000,
    busy: () => false,
  };
}

/** Public tags: languages are the only stack names; no problem-space vocabulary (members' own tags still show). */
const LANGS = ["TypeScript", "JavaScript", "Python", "Go", "Rust", "Swift", "Kotlin", "Java", "C#", "C++", "C", "Ruby", "PHP", "Elixir", "Dart", "Scala", "Shell", "HTML", "CSS"];
const tagVocab = (): TagVocab => ({ problems: [], stack: LANGS });
/** Public overlap: the problem tags both members have, alphabetically, weight 1. */
function tagShared(a: Tag[], b: Tag[]) {
  const A = new Set(a.filter(t => t.kind !== "stack").map(t => t.t.toLowerCase()));
  return b.filter(t => t.kind !== "stack" && A.has(t.t.toLowerCase())).map(t => ({ t: t.t, w: 1 })).sort((x, y) => x.t.localeCompare(y.t));
}
/** Public search: a tag must match exactly; a term matches tags, names or the headline. -1 = not a match. */
function tagRelevance(tags: Tag[], text: string, tag: string, term: string) {
  if (tag && !tags.some(t => t.t.toLowerCase() === tag)) return -1;
  if (term && !tags.some(t => t.t.toLowerCase().includes(term)) && !text.toLowerCase().includes(term)) return -1;
  return 1;
}
/** Public digest: send when anything happened; subject = the first section with something in it; tips in a fixed order. */
const digestActive = (d: DigestData) => !!(d.messages?.unread || d.visitors24 || d.kudos?.length || d.postKudos?.length || d.postWaiting?.length || d.requests.length || d.intros?.length || d.friends.length || d.invited.length || d.gravity.length || d.links || d.alerts?.length);
function digestSubject(d: DigestData) {
  if (d.messages?.unread) return d.messages.from.length === 1 ? `Caldera: ${d.messages.unread === 1 ? "a message" : d.messages.unread + " messages"} from @${d.messages.from[0]!.handle}` : `Caldera: ${d.messages.unread} unread messages`;
  return "Caldera: " + (d.kudos?.length ? "you got kudos" : d.requests.length ? "friend requests waiting" : d.intros?.length ? "introductions waiting"
    : d.friends.length ? "new connections" : d.visitors24 ? "people viewed your page" : "your daily summary");
}
function digestSetup(s: SetupState): SetupStep {
  const url = `${s.account}#connections`;
  if (!s.hasCity) return { label: "connect GitHub", why: "Your public repos become a city on your page.", how: "Connect GitHub", url };
  if (!s.agents) return { label: "add your AI agents", why: "Show your coding agents on your city.", how: "Set up agents", url };
  return undefined;
}

export const fallbacks: Ext = { loaded: [], suggestScore, githubAccountOk, repoConnector, tagVocab, tagExtractor: basicTagExtractor, tagShared, tagRelevance,
  digestActive, digestSubject, digestSetup, feedMatcher: () => publicMatcher };

/** Load private overrides from a directory holding dist/index.cjs (or index.cjs). Missing or broken -> fallbacks. */
export function loadExt(dir?: string | null, log: (...a: unknown[]) => void = console.error): Ext {
  if (!dir) return fallbacks;
  const file = [path.join(dir, "dist", "index.cjs"), path.join(dir, "index.cjs")].find(f => fs.existsSync(f));
  if (!file) { log("private extensions: none found in", dir); return fallbacks; }
  try {
    const mod = createRequire(import.meta.url)(file), over = (mod.ext || mod.default || {}) as Partial<Ext>;
    const keys = (Object.keys(fallbacks) as (keyof Ext)[]).filter(k => k !== "loaded" && typeof (over as any)[k] === "function");
    const ext = { ...fallbacks, ...Object.fromEntries(keys.map(k => [k, (over as any)[k]])), loaded: keys } as Ext;
    return ext;
  } catch (e: any) { log("private extensions failed to load, using public fallbacks:", e?.message || e); return fallbacks; }
}
