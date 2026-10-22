/**
 * The network feed (caldera.social/feed): what's happening across Caldera, plus members' asks.
 *
 * Activity is derived from what the hub already records (sign-ups, cities, Obsidian claims, real friendships, kudos,
 * release alerts), public-safe only: unlisted and moderated members never appear, private repo names never exist here.
 *
 * Posts are text only and structured: the author picks what they're looking for (someone, code, work, clients, feedback,
 * something else), answers a few short questions for that choice and adds one free-text line. Each post renders as one
 * readable sentence with the answers as chips. After posting, the author sees the members who match (structured fields
 * first, free text second) and can send the post to them: a double opt-in introduction (the recipient accepts or not).
 * Members can say "I can help", send kudos on a post (once a day per post), share it (permalink + their invite), report it.
 */
import http from "node:http";
import crypto from "node:crypto";
import { linkMentions, tellMentioned, MENTION_CSS, MENTION_JS } from "./mentions.js";

const DAY = 86_400_000;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** text only: no markup, no control characters, single spaces, capped */
export const clean = (v: unknown, max: number) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------------------------------- the questions
export const TYPES = ["someone", "code", "work", "clients", "feedback", "other", "recommend"] as const;
export const ASK_TYPES = ["someone", "code", "work", "clients", "feedback", "other"] as const;
export type PostType = typeof TYPES[number];
export const TYPE_LABEL: Record<PostType, string> = { someone: "someone", code: "code", work: "work", clients: "clients", feedback: "feedback", other: "something else", recommend: "recommendation" };
export const TYPE_HINT: Record<PostType, string> = { someone: "a person, collaborator, co-founder or hire", code: "a library, tool, snippet or repo", work: "a job, freelance or contract work",
  clients: "customers, users or beta testers", feedback: "eyes on what you're building", other: "anything else", recommend: "something worth knowing about" };
/** "I recommend...": what kind of thing, and whether a link is required */
export const REC = { repo: "a repo or code", model: "an AI model or engine", tool: "a tool or app", read: "an article, video or read", person: "a person or team to follow", other: "something else" } as const;
export const REC_NEEDS_LINK = ["repo", "model", "tool", "read"];
export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
export const NEED_ROLES = ["a developer", "a designer", "a co-founder", "a product manager", "a marketer", "an ML engineer", "a mentor", "someone else"];
export const MY_ROLES = ["developer", "designer", "product manager", "ML / data engineer", "marketer", "founder", "something else"];
export const COMMIT = { paid: "paid", equity: "equity", volunteer: "volunteer", unsure: "not sure yet" } as const;
export const WORK_KIND = { "full-time": "full-time", contract: "contract", freelance: "freelance" } as const;
export const STAGE = { idea: "idea", beta: "beta", live: "live" } as const;
export const FB_KIND = { ux: "UX", code: "code", idea: "idea", pricing: "pricing" } as const;
/** the problem-space vocabulary used for suggestions; the topic-tags module's list replaces it when present */
export const VOCAB = ["AI agents", "social features", "dev tools", "note-taking", "trading bots", "e-commerce", "fintech", "health", "education", "games", "creator tools",
  "data & analytics", "security", "open source", "mobile apps", "productivity", "marketing", "crypto", "climate", "hardware"];

export interface PostFields { type: PostType; role?: string; topic?: string; commitment?: string; what?: string; stack?: string[]; oss?: string; kind?: string; where?: string;
  offer?: string; audience?: string[]; stage?: string; link?: string; detail?: string;
  /** recommendations: what kind, its name, who it's for, and (repos) public GitHub facts the hub looked up */
  rec?: string; name?: string; forWhom?: string; meta?: { desc?: string; stars?: number; lang?: string };
  /** the simple composer (one choice + free text): `detail` is the text with its link lifted out into `link` */
  simple?: boolean }
const list = (v: unknown, n: number, each: number) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map(x => clean(x, each)).filter(Boolean).slice(0, n);
const pick = <T extends Record<string, string>>(m: T, v: unknown): string | null => typeof v === "string" && Object.prototype.hasOwnProperty.call(m, v) ? v : null;
/** server-side validation for every field; returns the clean post or an error a person can act on */
export function validatePost(b: any, linkOk: (host: string) => boolean = () => true): { ok: true; p: PostFields } | { ok: false; error: string } {
  const type = TYPES.includes(b?.type) ? b.type as PostType : null;
  if (!type) return { ok: false, error: "Pick what you're looking for." };
  const detail = clean(b.detail, 280), p: PostFields = { type };
  if (type === "someone") {
    if (!NEED_ROLES.includes(b.role)) return { ok: false, error: "Pick who you're looking for." };
    const commitment = pick(COMMIT, b.commitment); if (!commitment) return { ok: false, error: "Pick paid, equity, volunteer or not sure." };
    const topic = clean(b.topic, 60); if (!topic) return { ok: false, error: "Say what it's for (a project or topic)." };
    Object.assign(p, { role: b.role, commitment, topic, detail });
  } else if (type === "code") {
    const what = clean(b.what, 200); if (what.length < 8) return { ok: false, error: "Say what the code should do." };
    Object.assign(p, { what, stack: list(b.stack, 6, 24), oss: b.oss === "yes" ? "yes" : "no" });
  } else if (type === "work") {
    if (!MY_ROLES.includes(b.role)) return { ok: false, error: "Pick your role." };
    const kind = pick(WORK_KIND, b.kind); if (!kind) return { ok: false, error: "Pick full-time, contract or freelance." };
    Object.assign(p, { role: b.role, kind, stack: list(b.stack, 6, 24), where: clean(b.where, 60), detail });
  } else if (type === "clients") {
    const offer = clean(b.offer, 120); if (offer.length < 4) return { ok: false, error: "Say what you offer, in one line." };
    const stage = pick(STAGE, b.stage); if (!stage) return { ok: false, error: "Pick idea, beta or live." };
    Object.assign(p, { offer, stage, audience: list(b.audience, 5, 30), detail });
  } else if (type === "feedback") {
    const kind = pick(FB_KIND, b.kind); if (!kind) return { ok: false, error: "Pick UX, code, idea or pricing." };
    const link = clean(b.link, 200); if (link && !/^https?:\/\/[^\s"'<>]+$/i.test(link)) return { ok: false, error: "The link should start with https://" };
    if (detail.length < 8) return { ok: false, error: "Say what you'd like feedback on." };
    Object.assign(p, { kind, link, detail });
  } else if (type === "recommend") {
    const rec = pick(REC, b.rec); if (!rec) return { ok: false, error: "Pick what you're recommending." };
    const name = clean(b.name, 60); if (name.length < 2) return { ok: false, error: "Give it a name." };
    const link = clean(b.link, 200);
    if (link) {
      if (!/^https:\/\/[^\s"'<>]+$/i.test(link)) return { ok: false, error: "Links need to start with https://" };
      const host = hostOf(link); if (!host || !host.includes(".")) return { ok: false, error: "That link doesn't look right." };
      if (!linkOk(host)) return { ok: false, error: "That link isn't allowed. Use the full, direct link (no link shorteners)." };
    } else if (REC_NEEDS_LINK.includes(rec)) return { ok: false, error: "Add the link (https://...)." };
    const why = clean(b.detail ?? b.why, 200); if (why.length < 8) return { ok: false, error: "Say why you recommend it." };
    Object.assign(p, { rec, name, link, detail: why, stack: list(b.stack, 6, 24), forWhom: clean(b.forWhom, 60) });
  } else {
    if (detail.length < 8) return { ok: false, error: "Say what you're looking for." };
    Object.assign(p, { topic: clean(b.topic, 60), detail });
  }
  if (p.detail === "") delete p.detail;
  return { ok: true, p };
}

/** first https link in free text (trailing punctuation dropped) */
export const firstLink = (t: string) => { const m = String(t || "").match(/https?:\/\/[^\s"'<>]+/i); return m ? m[0].replace(/[.,;:!?)\]]+$/, "") : ""; };
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** vocabulary terms that appear in the text: problem spaces case-insensitively; short stack names (Go, R, C) only as written */
export function termsIn(text: string, terms: string[], max = 6): string[] {
  const out: string[] = [];
  for (const t of terms) { if (!t || out.length >= max) continue; const ci = t.length > 3;
    if (new RegExp(`(^|[^A-Za-z0-9+#])${reEsc(t)}($|[^A-Za-z0-9+#])`, ci ? "i" : "").test(text)) out.push(t); }
  return out;
}
/** The simple composer: one choice (an ask kind, or a recommendation kind) and one free-text box, text only. The first
 *  https link in the text becomes the post's link; tags and stack for matching are read out of the text. */
export function validateSimple(b: any, linkOk: (host: string) => boolean = () => true, vocab: string[] = [], stackVocab: string[] = []): { ok: true; p: PostFields } | { ok: false; error: string } {
  const type = TYPES.includes(b?.type) ? b.type as PostType : null;
  if (!type) return { ok: false, error: "Pick what you're looking for or recommending." };
  const rec = type === "recommend" ? pick(REC, b.rec) : null;
  if (type === "recommend" && !rec) return { ok: false, error: "Pick what you're recommending." };
  const text = clean(b.text, 280); if (text.length < 8) return { ok: false, error: type === "recommend" ? "Say what it is and why you recommend it." : "Say what you're looking for." };
  const raw = firstLink(text); let link = "";
  if (raw) {
    if (!/^https:\/\//i.test(raw)) return { ok: false, error: "Links need to start with https://" };
    const host = hostOf(raw); if (!host || !host.includes(".")) return { ok: false, error: "That link doesn't look right." };
    if (!linkOk(host)) return { ok: false, error: "That link isn't allowed. Use the full, direct link (no link shorteners)." };
    link = raw.slice(0, 200);
  } else if (rec && REC_NEEDS_LINK.includes(rec)) return { ok: false, error: "Add a link (https://...) so people can find it." };
  const detail = (link ? text.replace(raw, " ") : text).replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim() || text;
  const p: PostFields = { type, simple: true, detail, audience: termsIn(text, vocab), stack: termsIn(text, stackVocab) };
  if (link) p.link = link;
  if (rec) { p.rec = rec; const head = detail.split(/\s[-\u2013\u2014:]\s|[.!?](\s|$)/)[0].trim(); p.name = clean(head.length >= 2 && head.length <= 60 ? head : detail.split(" ").slice(0, 6).join(" "), 60); }
  return { ok: true, p };
}

/** The post as one sentence: [text, slot] pieces, so the page and the share card render the same words. Used on the
 *  server and (via toString) in the composer's live preview, so keep it plain JS. */
export function sentence(p: any): [string, boolean][] {
  var out: [string, boolean][] = [], t = function (s: string) { out.push([s, false]); }, s = function (v: string) { out.push([v, true]); };
  var c: any = { paid: "paid", equity: "equity", volunteer: "volunteer", unsure: "not sure yet" }, fb: any = { ux: "UX", code: "code", idea: "idea", pricing: "pricing" };
  var stack = (p.stack || []).join(", ");
  if (p.simple) {
    var K: any = { someone: "someone", code: "code", work: "work", clients: "clients", feedback: "feedback", other: "something" };
    if (p.type === "recommend") t("recommends: "); else { t("is looking for "); s(K[p.type] || "something"); t(": "); }
    t(p.detail || "...");
    return out;
  }
  if (p.type === "someone") { t("is looking for "); s(p.role || "someone"); if (p.commitment) { t(" ("); s(c[p.commitment] || p.commitment); t(")"); } if (p.topic) { t(" for "); s(p.topic); } }
  else if (p.type === "code") { t("is looking for code: "); s(p.what || "..."); if (stack) { t(" in "); s(stack); } if (p.oss === "yes") { t(" ("); s("open source"); t(")"); } }
  else if (p.type === "work") { t("is a "); s(p.role || "builder"); t(" looking for "); s(p.kind || "new"); t(" work"); if (stack) { t(" with "); s(stack); } if (p.where) { t(" · "); s(p.where); } }
  else if (p.type === "clients") { t("is looking for users for "); s(p.offer || "..."); if ((p.audience || []).length) { t(", built for "); s(p.audience.join(", ")); } if (p.stage) { t(" ("); s(p.stage); t(")"); } }
  else if (p.type === "feedback") { t("would like "); s(fb[p.kind] || "your"); t(" feedback"); if (p.link) { t(" on "); s(String(p.link).replace(/^https?:\/\//, "").replace(/\/$/, "")); } }
  else if (p.type === "recommend") { t("recommends "); s(p.name || "..."); if (p.forWhom) { t(" for "); s(p.forWhom); } }
  else { t("is looking for "); s(p.topic || "a hand"); }
  return out;
}
export const sentenceText = (handle: string, p: any) => { const t = "@" + handle + " " + sentence(p).map(x => x[0]).join(""); return /[.!?]$/.test(t) ? t : t + "."; };

/** tags a post carries for matching: its topic, audience, stack and role words, lower-cased */
export function postTags(p: PostFields): string[] {
  const out = new Set<string>();
  for (const x of [p.topic, p.forWhom, ...(p.audience || []), ...(p.stack || [])]) if (x) out.add(String(x).toLowerCase());
  return [...out].slice(0, 12);
}

// ---------------------------------------------------------------------------------------------------- matching (pluggable)
/** What the feed knows about a member, for matching. */
export interface MemberFacts { id: string; handle: string; tags: Set<string>; stack: Set<string>; head: string; offers: string[]; groups: Set<string>; week: number; created: string }
/** The matching and spam policy. The hub ships a simple public one; a private module can replace it at startup. */
export interface FeedMatcher {
  score(f: PostFields, author: MemberFacts, member: MemberFacts): { score: number; why: string };
  /** score at which a member counts as a match (post panel), and at which a post is worth an email line */
  minMatch: number; minDigest: number;
  linkAllowed(host: string): boolean;
  /** how many recommendations a day a member may share (fresh = account under 2 days old or without public repos) */
  recsPerDay(fresh: boolean): number;
}
/** public fallback: exact tag and stack overlap only, any https link, no extra limits */
export const publicMatcher: FeedMatcher = {
  score(f, _a, m) {
    const tags = postTags(f), hits = tags.filter(t => m.tags.has(t) || m.stack.has(t));
    return { score: hits.length * 3, why: hits.length ? `shares ${hits.slice(0, 2).join(", ")}` : "on Caldera" };
  },
  minMatch: 3, minDigest: 3, linkAllowed: () => true, recsPerDay: () => 3,
};

// ---------------------------------------------------------------------------------------------------- the module
export interface FeedTag { t: string; kind?: string }
export interface FeedCtx {
  q: (sql: string) => any; now: () => string; hub: string;
  profile: (id: string) => any; byHandle: (h: string) => any; body: (pr: any) => any; listed: (pr: any) => boolean; modOf: (h: string | null, id?: string) => any;
  areFriends: (a: string, b: string) => boolean; befriend: (a: string, b: string, kind: any, ts: string, why: string | null) => void;
  memberOf: (req: http.IncomingMessage) => string | null; sameOrigin: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<any>; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  navify: (html: string, current?: string) => string; weekScore: (manifest: string) => number;
  /** member tags from the topic-tags module, when it's installed; otherwise the page's own topics and languages */
  tagsOf?: (pr: any) => FeedTag[];
  vocab?: string[];
  /** stack names (Next.js, Supabase...) read out of a post's free text for matching */
  stackVocab?: string[];
  /** the topic-tags module's double opt-in introductions, when installed */
  requestIntro?: (fromId: string, to: any) => { status: number; body: any };
  decide?: (meId: string, fromId: string, yes: boolean) => { status: number; body: any };
  founder?: string | null;
  postCard?: (o: { handle: string; name: string; sentence: string; detail: string }) => Promise<Buffer>;
  ogTags?: (o: { url: string; image: string; title: string; description: string }) => string;
  tooMany: (key: string, max: number, windowMs?: number) => boolean;
  /** free tools members listed, for the feed */
  toolItems?: () => { owner: string; ts: string; name: string; id: string }[];
  /** people this member might want to follow (ranked by the hub's suggestions), for the feed's right rail */
  suggest?: (meId: string, n: number) => { handle: string; name: string; headline?: string | null; avatar: string | null; why?: string | null }[];
  /** public GitHub metadata for recommended repos (a member's token raises the rate limit; none works too) */
  fetch?: typeof fetch; ghToken?: () => Promise<string | null>;
  /** has this member got a city with public repos (new accounts without one get stricter link limits) */
  hasRepos?: (pr: any) => boolean;
  /** is this member's city page actually on disk (a GitHub sign-up whose account or repos are gone has none) */
  hasCity?: (handle: string) => boolean;
  /** a personal alert in the member's bell (and so their daily email); `key` folds repeats into one */
  notify?: (memberId: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void;
  /** a deleted post takes its personal alerts (kudos, sends, recommendations) with it */
  dropNotices?: (postId: string) => void;
}
export const POST_KUDOS: Record<string, string> = { heart: "❤️", up: "\u{1F44D}", fire: "\u{1F525}", sparkle: "✨" };

export function feed(c: FeedCtx) {
  const { q } = c;
  let M: FeedMatcher = publicMatcher;
  q(`CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author TEXT, type TEXT, fields TEXT, detail TEXT, tags TEXT, status TEXT, ts TEXT, closed TEXT)`).run();
  q(`CREATE INDEX IF NOT EXISTS posts_ts ON posts(ts)`).run();
  q(`CREATE TABLE IF NOT EXISTS post_links (post TEXT, src TEXT, dst TEXT, kind TEXT, status TEXT, ts TEXT, decided TEXT, PRIMARY KEY (post, src, dst))`).run();
  q(`CREATE INDEX IF NOT EXISTS post_links_dst ON post_links(dst, status)`).run();
  q(`CREATE TABLE IF NOT EXISTS post_kudos (post TEXT, sender TEXT, kind TEXT, day TEXT, ts TEXT, PRIMARY KEY (post, sender, day))`).run();
  q(`CREATE TABLE IF NOT EXISTS post_reports (post TEXT, reporter TEXT, reason TEXT, ts TEXT, PRIMARY KEY (post, reporter))`).run();
  q(`CREATE TABLE IF NOT EXISTS post_bans (member TEXT PRIMARY KEY, reason TEXT, ts TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS feed_seen (member TEXT PRIMARY KEY, ts TEXT)`).run();   // when each member last opened the feed (the nav's "new" count)
  // comments: threaded under a post (parent = another comment on the same post, or null). status ok | deleted (kept as a
  // "[deleted]" stub while it still has replies) | hidden (operator)
  q(`CREATE TABLE IF NOT EXISTS post_comments (id TEXT PRIMARY KEY, post TEXT, parent TEXT, author TEXT, body TEXT, ts TEXT, status TEXT)`).run();
  q(`CREATE INDEX IF NOT EXISTS post_comments_post ON post_comments(post, ts)`).run();
  q(`CREATE INDEX IF NOT EXISTS post_comments_author ON post_comments(author)`).run();
  q(`CREATE TABLE IF NOT EXISTS comment_reports (comment TEXT, reporter TEXT, reason TEXT, ts TEXT, PRIMARY KEY (comment, reporter))`).run();
  const hub = c.hub.replace(/\/$/, "");
  const vocab = () => (c.vocab && c.vocab.length ? c.vocab : VOCAB);
  const visible = (pr: any) => !!pr?.handle && c.listed(pr) && !c.modOf(pr.handle, pr.id);
  const isMember = (h: string) => visible(c.byHandle(h));   // an @mention links only to a real, listed member
  const avatarOf = (pr: any) => { const b = c.body(pr); return b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null; };
  const fieldsOf = (row: any): PostFields => { try { return JSON.parse(row.fields); } catch { return { type: "other" }; } };
  const tell = (to: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => { try { c.notify?.(to, a); } catch { /* a failed alert never breaks the action */ } };

  // ---------------------------------------------------------------- posts
  function createPost(meId: string, b: any): { status: number; body: any } {
    const me = c.profile(meId); if (!visible(me)) return { status: 403, body: { error: "List your page in People to post (Settings)." } };
    if (q("SELECT 1 FROM post_bans WHERE member=?").get(meId)) return { status: 403, body: { error: "Posting is turned off for this account." } };
    const v = typeof b?.text === "string" ? validateSimple(b, h => M.linkAllowed(h), vocab(), c.stackVocab || []) : validatePost(b, h => M.linkAllowed(h));
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const day = new Date(Date.now() - DAY).toISOString();
    if ((q("SELECT COUNT(*) n FROM posts WHERE author=? AND ts > ?").get(meId, day) as any).n >= 3) return { status: 429, body: { error: "That's 3 posts today. Try again tomorrow." } };
    if (v.p.type !== "recommend" && q("SELECT 1 FROM posts WHERE author=? AND type=? AND status='open'").get(meId, v.p.type)) return { status: 409, body: { error: `You already have an open "${TYPE_LABEL[v.p.type]}" post. Close it first.` } };
    // links from brand-new accounts (under 2 days, or no public repos) are limited to one recommendation a day
    const fresh = Date.parse(me.created) > Date.now() - 2 * DAY || (c.hasRepos ? !c.hasRepos(me) : false);
    if (v.p.type === "recommend" && (q("SELECT COUNT(*) n FROM posts WHERE author=? AND type='recommend' AND ts > ?").get(meId, day) as any).n >= M.recsPerDay(fresh))
      return { status: 429, body: { error: "New accounts can share one recommendation a day. Try again tomorrow." } };
    const id = crypto.randomBytes(6).toString("hex"), ts = c.now();
    q("INSERT INTO posts VALUES (?,?,?,?,?,?,?,?,?)").run(id, meId, v.p.type, JSON.stringify(v.p), v.p.detail || "", JSON.stringify(postTags(v.p)), "open", ts, null);
    cache = null;
    if (v.p.detail) tellMentioned({ text: String(v.p.detail), author: meId, byHandle: c.byHandle, canSee: visible, tell, authorHandle: me.handle, where: "in a post", url: `/feed/p/${id}`, key: `mn:${id}` });
    if (v.p.type === "recommend") {
      const gh = v.p.link && v.p.rec === "repo" ? v.p.link.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/) : null;
      if (gh) void repoFacts(id, gh[1], gh[2]);
      const notified = notifyMatches(id);
      return { status: 200, body: { ok: true, post: postView(q("SELECT * FROM posts WHERE id=?").get(id), meId), notified } };
    }
    return { status: 200, body: { ok: true, post: postView(q("SELECT * FROM posts WHERE id=?").get(id), meId), matches: matchesFor(id, 5) } };
  }
  /** a recommended GitHub repo gets a small text card: description, stars, language (public API, nothing private) */
  async function repoFacts(postId: string, owner: string, repo: string) {
    if (!c.fetch) return;
    try {
      const tok = c.ghToken ? await c.ghToken() : null;
      const r = await c.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { accept: "application/vnd.github+json", "user-agent": "caldera-hub", ...(tok ? { authorization: "Bearer " + tok } : {}) } });
      if (!r.ok) return; const j: any = await r.json(); if (j.private) return;
      const row = postRow(postId); if (!row) return; const f = fieldsOf(row);
      f.meta = { desc: clean(j.description, 160), stars: Math.max(0, Number(j.stargazers_count) || 0), lang: clean(j.language, 30) };
      q("UPDATE posts SET fields=? WHERE id=?").run(JSON.stringify(f), postId); cache = null;
    } catch { /* the post shows without the card */ }
  }
  /** recommendations aren't sent: the members they fit best (top 5, unless they turned these off) just hear about them */
  function notifyMatches(postId: string): { handle: string; name: string; why: string }[] {
    const row = postRow(postId); if (!row) return [];
    const out: { handle: string; name: string; why: string }[] = [];
    for (const m of matchesFor(postId, 8)) {
      const pr = c.byHandle(m.handle); if (!pr || c.body(pr).recNotices === false) continue;
      q("INSERT OR IGNORE INTO post_links VALUES (?,?,?,?,?,?,?)").run(postId, row.author, pr.id, "rec", "notice", c.now(), null);
      { const au = c.profile(row.author), f = fieldsOf(row);
        tell(pr.id, { title: `@${au?.handle} recommends ${f.name || "something"} for people like you`, body: `${f.detail || ""}${f.link ? "\n\n" + f.link : ""}`, ctaLabel: "See it", ctaUrl: `/feed/p/${postId}` }); }
      out.push({ handle: m.handle, name: m.name, why: m.why }); if (out.length >= 5) break;
    }
    return out;
  }
  const postRow = (id: string) => q("SELECT * FROM posts WHERE id=?").get(id) as any;
  function postView(row: any, viewer: string | null) {
    const pr = c.profile(row.author), f = fieldsOf(row);
    const day = new Date().toISOString().slice(0, 10);
    const tally = Object.fromEntries((q("SELECT kind, COUNT(*) n FROM post_kudos WHERE post=? GROUP BY kind").all(row.id) as any[]).map(r => [r.kind, r.n]));
    const mine = viewer ? (q("SELECT kind FROM post_kudos WHERE post=? AND sender=? AND day=?").get(row.id, viewer, day) as any)?.kind || null : null;
    const helped = viewer ? !!q("SELECT 1 FROM post_links WHERE post=? AND src=? AND kind='help'").get(row.id, viewer) : false;
    return { id: row.id, type: row.type, fields: f, sentence: sentence(f), text: sentenceText(pr?.handle || "someone", f), detail: f.detail || "", status: row.status, ts: row.ts, comments: commentCount(row.id),
      author: { handle: pr?.handle, name: pr?.name || pr?.handle, avatar: pr ? avatarOf(pr) : null }, mine: viewer === row.author, kudos: tally, myKudos: mine, helped, url: `${hub}/feed/p/${row.id}` };
  }
  function closePost(meId: string, id: string, del: boolean) {
    const row = postRow(id); if (!row || row.author !== meId) return { status: 404, body: { error: "not found" } };
    if (del) { for (const t of ["posts WHERE id", "post_links WHERE post", "post_kudos WHERE post", "post_reports WHERE post"]) q(`DELETE FROM ${t}=?`).run(id); dropComments(id); try { c.dropNotices?.(id); } catch { /* best effort */ } }
    else q("UPDATE posts SET status='closed', closed=? WHERE id=?").run(c.now(), id);
    cache = null; return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------- comments (threaded)
  const CM_DEPTH = 4;   // replies nest 4 deep; a reply to the deepest level joins it as a sibling
  /** comment text: no markup or control characters, single blank lines at most, capped */
  const cleanComment = (v: unknown) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1000);
  const cmRow = (id: string) => q("SELECT * FROM post_comments WHERE id=?").get(id) as any;
  const commentCount = (postId: string) => (q("SELECT COUNT(*) n FROM post_comments WHERE post=? AND status='ok'").get(postId) as any).n as number;
  function depthOf(id: string | null): number { let d = 0, cur = id ? cmRow(id) : null; while (cur?.parent && d < 20) { d++; cur = cmRow(cur.parent); } return d; }
  function addComment(meId: string, postId: string, b: any): { status: number; body: any } {
    const row = postRow(postId), author = row ? c.profile(row.author) : null;
    if (!row || row.status === "hidden" || !visible(author)) return { status: 404, body: { error: "not found" } };
    const me = c.profile(meId); if (!visible(me)) return { status: 403, body: { error: "List your page in People to comment (Settings)." } };
    if (q("SELECT 1 FROM post_bans WHERE member=?").get(meId)) return { status: 403, body: { error: "Commenting is turned off for this account." } };
    const text = cleanComment(b?.text); if (text.length < 2) return { status: 400, body: { error: "Write a comment first." } };
    let parent: any = null;
    if (b?.parent) {
      parent = cmRow(String(b.parent)); if (!parent || parent.post !== postId) return { status: 404, body: { error: "That comment isn't here any more." } };
      if (parent.status !== "ok") return { status: 409, body: { error: "That comment was deleted." } };
      if (depthOf(parent.id) >= CM_DEPTH) parent = cmRow(parent.parent);   // deepest level: reply alongside it
    }
    if (c.tooMany("cmt:" + meId, 30)) return { status: 429, body: { error: "That's a lot of comments for one hour. Try again a little later." } };
    if (q("SELECT 1 FROM post_comments WHERE post=? AND author=? AND body=? AND ts > ?").get(postId, meId, text, new Date(Date.now() - 120_000).toISOString())) return { status: 409, body: { error: "You just posted that." } };
    const id = crypto.randomBytes(8).toString("hex"), ts = c.now();
    q("INSERT INTO post_comments VALUES (?,?,?,?,?,?,?)").run(id, postId, parent?.id || null, meId, text, ts, "ok");
    // tell the post's author and the person replied to (never yourself, never twice)
    const snip = text.length > 160 ? text.slice(0, 157) + "..." : text, url = `/feed/p/${postId}#c-${id}`, told = new Set<string>([meId]);
    if (parent && !told.has(parent.author)) { told.add(parent.author); tell(parent.author, { title: `@${me.handle} replied to your comment`, body: snip, ctaLabel: "Reply", ctaUrl: url, key: `cr:${parent.id}` }); }
    if (!told.has(row.author)) tell(row.author, { title: `@${me.handle} commented on your post`, body: snip, ctaLabel: "See the thread", ctaUrl: url, key: `cm:${postId}` });
    told.add(row.author);
    tellMentioned({ text, author: meId, skip: told, byHandle: c.byHandle, canSee: visible, tell, authorHandle: me.handle, where: "in a comment", url, key: `mn:${id}` });
    return { status: 200, body: { ok: true, id, parent: parent?.id || null, count: commentCount(postId), html: commentHtml(viewOf(cmRow(id)), [], meId, row.author, depthOf(id)) } };
  }
  /** take a comment away: a stub stays while others' replies hang off it; an empty stub chain is cleaned up */
  function removeComment(id: string): "deleted" | "removed" {
    const r = cmRow(id); if (!r) return "removed";
    if (q("SELECT 1 FROM post_comments WHERE parent=? LIMIT 1").get(id)) { q("UPDATE post_comments SET status='deleted', body='' WHERE id=?").run(id); return "deleted"; }
    q("DELETE FROM post_comments WHERE id=?").run(id); q("DELETE FROM comment_reports WHERE comment=?").run(id);
    let up = r.parent ? cmRow(r.parent) : null;
    while (up && up.status !== "ok" && !q("SELECT 1 FROM post_comments WHERE parent=? LIMIT 1").get(up.id)) { q("DELETE FROM post_comments WHERE id=?").run(up.id); up = up.parent ? cmRow(up.parent) : null; }
    return "removed";
  }
  function deleteComment(meId: string, id: string): { status: number; body: any } {
    const r = cmRow(id), row = r ? postRow(r.post) : null;
    if (!r || r.status !== "ok" || (r.author !== meId && row?.author !== meId)) return { status: 404, body: { error: "not found" } };   // yours, or any on your post
    const state = removeComment(id);
    return { status: 200, body: { ok: true, state, count: commentCount(r.post) } };
  }
  function reportComment(meId: string, id: string, reason: string) {
    if (!cmRow(id)) return { status: 404, body: { error: "not found" } };
    q("INSERT OR REPLACE INTO comment_reports VALUES (?,?,?,?)").run(id, meId, clean(reason, 200), c.now());
    return { status: 200, body: { ok: true } };
  }
  function dropComments(postId: string) { q("DELETE FROM comment_reports WHERE comment IN (SELECT id FROM post_comments WHERE post=?)").run(postId); q("DELETE FROM post_comments WHERE post=?").run(postId); }
  /** a comment as the page needs it; an author who has left (unlisted, moderated, deleted) shows as a stub like a deleted one */
  function viewOf(r: any) {
    const pr = r.status === "ok" ? c.profile(r.author) : null, gone = !visible(pr);
    return { id: r.id, parent: r.parent, ts: r.ts, removed: gone, body: gone ? "" : r.body, author: gone ? null : { id: r.author, handle: pr.handle, name: pr.name || pr.handle, avatar: avatarOf(pr) } };
  }
  /** the whole thread, oldest first at each level; stubs only where they still hold replies */
  function threadOf(postId: string) {
    const rows = (q("SELECT * FROM post_comments WHERE post=? AND status<>'hidden' ORDER BY ts").all(postId) as any[]).map(viewOf);
    const kids = new Map<string | null, any[]>(); for (const v of rows) { const k = v.parent && rows.some(x => x.id === v.parent) ? v.parent : null; (kids.get(k) || kids.set(k, []).get(k)!).push(v); }
    const build = (k: string | null): any[] => (kids.get(k) || []).map(v => ({ ...v, replies: build(v.id) })).filter(v => !v.removed || v.replies.length);
    return build(null);
  }

  // ---------------------------------------------------------------- matching (the policy lives in the matcher)
  function factsOf(pr: any): MemberFacts {
    const b = c.body(pr), tags = new Set<string>(), stack = new Set<string>();
    if (c.tagsOf) for (const t of c.tagsOf(pr)) (t.kind === "stack" ? stack : tags).add(String(t.t).toLowerCase());
    for (const t of (b.topics || [])) tags.add(String(Array.isArray(t) ? t[0] : t).toLowerCase());
    for (const l of (b.languages || [])) stack.add(String(l).toLowerCase());
    return { id: pr.id, handle: pr.handle, tags, stack, head: `${pr.headline || ""} ${b.summary || ""}`.toLowerCase(), offers: (q("SELECT title FROM offers WHERE author=?").all(pr.id) as any[]).map(o => String(o.title)),
      groups: new Set<string>((b.groups || []).map(String)), week: c.weekScore(pr.manifest), created: pr.created };
  }
  const scoreFor = (f: PostFields, author: any, pr: any) => { try { return M.score(f, factsOf(author), factsOf(pr)); } catch { return publicMatcher.score(f, factsOf(author), factsOf(pr)); } };
  function matchesFor(postId: string, n = 5) {
    const row = postRow(postId); if (!row) return [];
    const f = fieldsOf(row), author = c.profile(row.author); if (!author) return [];
    const sent = new Set((q("SELECT dst FROM post_links WHERE post=? AND src=?").all(postId, row.author) as any[]).map(r => r.dst));
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(pr => pr.id !== row.author && visible(pr))
      .map(pr => ({ pr, ...scoreFor(f, author, pr) })).filter(x => x.score >= M.minMatch).sort((a, b) => b.score - a.score).slice(0, n)
      .map(x => ({ handle: x.pr.handle, name: x.pr.name || x.pr.handle, headline: x.pr.headline || "", avatar: avatarOf(x.pr), why: x.why, sent: sent.has(x.pr.id), friends: c.areFriends(row.author, x.pr.id) }));
  }

  // ---------------------------------------------------------------- sending, helping, kudos, reports
  function sendPost(meId: string, postId: string, handles: string[]): { status: number; body: any } {
    const row = postRow(postId); if (!row || row.author !== meId) return { status: 404, body: { error: "not found" } };
    if (row.status !== "open") return { status: 409, body: { error: "This post is closed." } };
    const already = (q("SELECT COUNT(*) n FROM post_links WHERE post=? AND src=? AND kind='send'").get(postId, meId) as any).n;
    const out: { handle: string; state: string }[] = []; let left = 10 - already;
    for (const h of [...new Set(handles.map(x => String(x).toLowerCase().replace(/^@/, "")))].slice(0, 10)) {
      const pr = c.byHandle(h); if (!visible(pr) || pr.id === meId) { out.push({ handle: h, state: "unknown" }); continue; }
      if (q("SELECT 1 FROM post_links WHERE post=? AND src=? AND dst=?").get(postId, meId, pr.id)) { out.push({ handle: h, state: "sent" }); continue; }
      if (left <= 0) { out.push({ handle: h, state: "limit" }); continue; }
      q("INSERT INTO post_links VALUES (?,?,?,?,?,?,?)").run(postId, meId, pr.id, "send", "sent", c.now(), null); left--;
      { const me = c.profile(meId), f = fieldsOf(row);
        tell(pr.id, { title: `@${me?.handle} sent you a post: you match`, body: `${sentenceText(me?.handle || "someone", f)}${f.detail ? "\n\n" + f.detail : ""}\n\nAccept to connect, or not now. They won't be told which.`, ctaLabel: "See it and answer", ctaUrl: `/feed/p/${postId}` }); }
      // not friends yet: also an introduction, so it shows wherever intros do; accepting either one connects them
      if (!c.areFriends(meId, pr.id) && c.requestIntro) { try { c.requestIntro(meId, pr); } catch { /* the post link still stands */ } }
      out.push({ handle: h, state: "sent" });
    }
    return { status: 200, body: { ok: true, results: out, left: Math.max(0, left) } };
  }
  function helpPost(meId: string, postId: string): { status: number; body: any } {
    const row = postRow(postId); if (!row || row.status === "hidden") return { status: 404, body: { error: "not found" } };
    if (row.author === meId) return { status: 400, body: { error: "That's your own post." } };
    const me = c.profile(meId); if (!visible(me)) return { status: 403, body: { error: "List your page in People to reply (Settings)." } };
    if (c.tooMany("help:" + meId, 20)) return { status: 429, body: { error: "Slow down a little. Try again in an hour." } };
    const ins = q("INSERT OR IGNORE INTO post_links VALUES (?,?,?,?,?,?,?)").run(postId, meId, row.author, "help", "sent", c.now(), null);
    if (ins.changes) tell(row.author, { title: `@${me.handle} can help with your post`, body: `${me.name || "@" + me.handle}${me.headline ? ` (${String(me.headline).slice(0, 80)})` : ""} offered to help with: ${sentenceText(c.profile(row.author)?.handle || "you", fieldsOf(row))}\n\nAccept to connect.`, ctaLabel: "Answer", ctaUrl: "/feed" });
    const author = c.profile(row.author);
    if (!c.areFriends(meId, row.author) && c.requestIntro && author) { try { c.requestIntro(meId, author); } catch { /* fine */ } }
    return { status: 200, body: { ok: true, state: "sent" } };
  }
  /** the recipient answers a sent post (or the author answers an "I can help"): yes connects them, no just closes it */
  function answer(meId: string, postId: string, fromHandle: string, yes: boolean): { status: number; body: any } {
    const from = c.byHandle(String(fromHandle).toLowerCase().replace(/^@/, "")); if (!from) return { status: 404, body: { error: "not found" } };
    const row = q("SELECT * FROM post_links WHERE post=? AND src=? AND dst=? AND status='sent'").get(postId, from.id, meId) as any;
    if (!row) return { status: 404, body: { error: "Nothing waiting from them on this post." } };
    q("UPDATE post_links SET status=?, decided=? WHERE post=? AND src=? AND dst=?").run(yes ? "accepted" : "closed", c.now(), postId, from.id, meId);
    if (yes && !c.areFriends(meId, from.id)) {
      const r = c.decide ? c.decide(meId, from.id, true) : null;
      if (!r || r.status !== 200) c.befriend(meId, from.id, "request", c.now(), "met through a post");
    }
    return { status: 200, body: { ok: true, state: yes ? "friends" : "closed" } };
  }
  function kudosPost(meId: string, postId: string, kind: string): { status: number; body: any } {
    if (!POST_KUDOS[kind]) return { status: 400, body: { error: "pick one of: " + Object.keys(POST_KUDOS).join(", ") } };
    const row = postRow(postId); if (!row || row.status === "hidden") return { status: 404, body: { error: "not found" } };
    if (row.author === meId) return { status: 400, body: { error: "That's your own post." } };
    if (c.tooMany("pkudos:" + meId, 60)) return { status: 429, body: { error: "That's a lot of kudos for one hour." } };
    const day = new Date().toISOString().slice(0, 10);
    const r = q("INSERT OR IGNORE INTO post_kudos VALUES (?,?,?,?,?)").run(postId, meId, kind, day, c.now());
    if (!r.changes) return { status: 409, body: { error: "You sent kudos on this post today." } };
    { const n = (q("SELECT COUNT(*) n FROM post_kudos WHERE post=? AND day=?").get(postId, day) as any).n, me = c.profile(meId);
      tell(row.author, { title: n > 1 ? `${n} people sent kudos on your post today` : `@${me?.handle} sent ${POST_KUDOS[kind]} on your post`, body: sentenceText(c.profile(row.author)?.handle || "you", fieldsOf(row)), ctaLabel: "See the post", ctaUrl: `/feed/p/${postId}`, key: `pk:${postId}:${day}` }); }
    return { status: 200, body: { ok: true, kind } };
  }
  function report(meId: string, postId: string, reason: string) {
    if (!postRow(postId)) return { status: 404, body: { error: "not found" } };
    q("INSERT OR REPLACE INTO post_reports VALUES (?,?,?,?)").run(postId, meId, clean(reason, 200), c.now());
    return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------- what's waiting for a member (bell, email, the feed's "For you")
  function noticesFor(meId: string, since = "") {
    const name = (id: string) => { const p = c.profile(id); return p ? { handle: p.handle, name: p.name || p.handle } : { handle: "someone", name: "" }; };
    const waiting = (q("SELECT l.*, p.fields, p.author FROM post_links l JOIN posts p ON p.id=l.post WHERE l.dst=? AND l.status='sent' AND l.kind<>'rec' AND l.ts > ? AND p.status<>'hidden' ORDER BY l.ts DESC LIMIT 20").all(meId, since) as any[])
      .map(r => { const f = (() => { try { return JSON.parse(r.fields); } catch { return { type: "other" }; } })(), who = name(r.src), author = name(r.author);
        return { post: r.post, kind: r.kind as "send" | "help", from: who, text: r.kind === "help" ? `@${who.handle} can help with your post` : `${sentenceText(author.handle, f)}`, ts: r.ts, url: `${hub}/feed/p/${r.post}` }; });
    const kudos = (q("SELECT k.*, p.fields FROM post_kudos k JOIN posts p ON p.id=k.post WHERE p.author=? AND k.ts > ? ORDER BY k.ts DESC LIMIT 20").all(meId, since) as any[])
      .map(r => { const who = name(r.sender); return { post: r.post, from: who, emoji: POST_KUDOS[r.kind] || "", ts: r.ts, url: `${hub}/feed/p/${r.post}` }; });
    const recs = (q("SELECT l.*, p.fields, p.author FROM post_links l JOIN posts p ON p.id=l.post WHERE l.dst=? AND l.kind='rec' AND l.ts > ? AND p.status<>'hidden' ORDER BY l.ts DESC LIMIT 10").all(meId, since) as any[])
      .map(r => { const f = (() => { try { return JSON.parse(r.fields); } catch { return { type: "other" }; } })(), author = name(r.author);
        return { post: r.post, from: author, text: sentenceText(author.handle, f), name: f.name || "", ts: r.ts, url: `${hub}/feed/p/${r.post}` }; });
    return { waiting, kudos, recs };
  }
  /** open posts (last 3 days) that match a member, for the daily email's "Looking for" section */
  function lookingFor(meId: string, n = 2) {
    const me = c.profile(meId); if (!visible(me)) return [];
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    return (q("SELECT * FROM posts WHERE status='open' AND type<>'recommend' AND ts > ? AND author<>? ORDER BY ts DESC LIMIT 60").all(since, meId) as any[])
      .map(row => { const author = c.profile(row.author); if (!visible(author)) return null; const f = fieldsOf(row); const s = scoreFor(f, author, me);
        return { row, author, f, ...s }; }).filter(Boolean).filter((x: any) => x.score >= M.minDigest).sort((a: any, b: any) => b.score - a.score).slice(0, n)
      .map((x: any) => ({ handle: x.author.handle, name: x.author.name || x.author.handle, sentence: sentenceText(x.author.handle, x.f), why: x.why, url: `${hub}/feed/p/${x.row.id}` }));
  }

  /** recommendations (last 3 days) that fit a member, for the daily email: "@x recommends <repo> for people building AI agents" */
  function recsFor(meId: string, n = 2) {
    const me = c.profile(meId); if (!visible(me)) return [];
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    return (q("SELECT * FROM posts WHERE status='open' AND type='recommend' AND ts > ? AND author<>? ORDER BY ts DESC LIMIT 60").all(since, meId) as any[])
      .map(row => { const author = c.profile(row.author); if (!visible(author)) return null; const f = fieldsOf(row); const sc = scoreFor(f, author, me); return { row, author, f, ...sc }; })
      .filter(Boolean).filter((x: any) => x.score >= M.minDigest).sort((a: any, b: any) => b.score - a.score).slice(0, n)
      .map((x: any) => ({ handle: x.author.handle, name: x.author.name || x.author.handle, sentence: sentenceText(x.author.handle, x.f), why: x.why, link: x.f.link || "", url: `${hub}/feed/p/${x.row.id}` }));
  }

  // ---------------------------------------------------------------- the activity stream
  type Item = { kind: "join" | "city" | "obsidian" | "friends" | "kudos" | "release" | "post" | "rec" | "gift" | "tool"; ts: string; who?: any; other?: any; text?: string; n?: number; via?: string; emoji?: string; post?: any; title?: string; url?: string };
  let cache: { at: number; items: Item[] } | null = null;
  function activity(): Item[] {
    if (cache && Date.now() - cache.at < 30_000) return cache.items;
    const pub = new Map<string, any>(); for (const pr of q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]) if (visible(pr)) pub.set(pr.id, pr);
    const who = (pr: any) => ({ handle: pr.handle, name: pr.name || pr.handle, avatar: avatarOf(pr) });
    const items: Item[] = [];
    const hosted = new Map((q("SELECT profile_id, claimed, created FROM gh_accounts").all() as any[]).map(r => [r.profile_id, r]));
    for (const pr of pub.values()) {
      const gh = hosted.get(pr.id);
      items.push({ kind: "join", ts: pr.created, who: who(pr), via: gh && !gh.claimed ? "GitHub" : "Obsidian" });
      const sections = (() => { try { return JSON.parse(pr.manifest).body.sections || []; } catch { return []; } })();
      // only point at a city that exists: a deleted GitHub (or one with no public repos) leaves no city.html
      if ((sections.includes("city") || (gh && !gh.claimed)) && (!c.hasCity || c.hasCity(pr.handle))) {
        const ts = new Date(Date.parse(pr.created) + 1000).toISOString();
        items.push({ kind: "city", ts, who: who(pr), url: `/@${pr.handle}/city.html` });
      }
      if (gh?.claimed) items.push({ kind: "obsidian", ts: gh.claimed, who: who(pr) });
    }
    for (const f of q("SELECT a, b, ts, kind FROM friends WHERE a < b AND COALESCE(kind,'request') NOT IN ('founder')").all() as any[]) {
      const A = pub.get(f.a), B = pub.get(f.b); if (A && B) items.push({ kind: "friends", ts: f.ts, who: who(A), other: who(B) });
    }
    for (const k of q("SELECT sender, recipient, kind, ts FROM kudos ORDER BY ts DESC LIMIT 300").all() as any[]) {
      const A = pub.get(k.sender), B = pub.get(k.recipient); if (A && B) items.push({ kind: "kudos", ts: k.ts, who: who(A), other: who(B), emoji: POST_KUDOS[k.kind] || "" });
    }
    if (q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alerts'").get())
      for (const a of q("SELECT id, title, ts, version FROM alerts WHERE version IS NOT NULL AND audience='all' AND target IS NULL ORDER BY ts DESC LIMIT 20").all() as any[]) items.push({ kind: "release", ts: a.ts, title: a.title, url: "/alerts" });
    // light-ups on the world map: "@a lit up @b's city (for repo)"
    if (q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gifts'").get())
      for (const g of q("SELECT giver, recipient, repo, ts FROM gifts ORDER BY ts DESC LIMIT 200").all() as any[]) { const A = pub.get(g.giver), B = pub.get(g.recipient); if (A && B) items.push({ kind: "gift", ts: g.ts, who: who(A), other: who(B), text: g.repo || "" }); }
    for (const t of c.toolItems ? c.toolItems() : []) { const A = pub.get(t.owner); if (A) items.push({ kind: "tool", ts: t.ts, who: who(A), text: t.name, url: `/tools#t-${t.id}` }); }
    for (const r of q("SELECT * FROM posts WHERE status<>'hidden' ORDER BY ts DESC LIMIT 300").all() as any[]) { const A = pub.get(r.author); if (A) items.push({ kind: r.type === "recommend" ? "rec" : "post", ts: r.ts, who: who(A), post: r }); }
    items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    cache = { at: Date.now(), items }; return items;
  }
  const FILTER: Record<string, Item["kind"][]> = { all: ["join", "city", "obsidian", "friends", "kudos", "release", "post", "rec", "gift", "tool"], posts: ["post"], recommends: ["rec"], members: ["join", "obsidian"], cities: ["city", "gift"], kudos: ["kudos", "gift"] };
  function page(type: string, before: string, viewer: string | null, n = 30, author = "") {
    const kinds = FILTER[type] || FILTER.all;
    const by = (i: Item) => !author || i.who?.handle === author || i.other?.handle === author;
    const rows = activity().filter(i => kinds.includes(i.kind) && (!before || i.ts < before) && by(i)).slice(0, n);
    return rows.map(i => i.kind === "post" || i.kind === "rec" ? { kind: "post", ts: i.ts, post: postView(i.post, viewer) } : { kind: i.kind, ts: i.ts, who: i.who, other: i.other, via: i.via, emoji: i.emoji, title: i.title, url: i.url, text: i.text });
  }

  // ---------------------------------------------------------------- pages
  const ago = (iso: string) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 30 * 86400 ? `${Math.floor(s / 86400)}d` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  const CSS = `<style>
.fd [hidden]{display:none!important}
.fd-cm{border-top:1px solid var(--line);padding-top:12px;margin-top:2px}.fd-c-n{margin:0 0 10px;font-size:14px;color:var(--text-strong)}
.fd-thread{list-style:none;margin:0;padding:0}.fd-thread .fd-thread{margin:2px 0 0 15px;padding-left:14px;border-left:2px solid var(--line)}
.fd-c{padding:8px 0 2px}.fd-c-h{display:flex;align-items:center;gap:8px;font-size:13.5px;flex-wrap:wrap}.fd-c-h .fd-av{width:24px;height:24px;font-size:12px}
.fd-c-h a.who{color:var(--text-strong);font-weight:600;text-decoration:none}.fd-c-h a.t{color:var(--text-muted);font-size:12.5px;text-decoration:none}
.fd-c .op-t{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--accent-soft);color:var(--accent-text)}
.fd-c-b{margin:4px 0 0 32px;font-size:14.5px;line-height:1.55;color:var(--text);overflow-wrap:anywhere}.fd-c-b a{color:var(--accent-text)}.fd-c.gone>.fd-c-b{color:var(--text-muted);font-style:italic;margin-left:0}
.fd-c:target>.fd-c-b{background:var(--accent-soft);border-radius:6px;padding:2px 6px;margin-left:26px}
.fd-c-a{display:flex;gap:12px;margin:2px 0 0 32px}.fd-c-a button,.fd-c-a a{all:unset;cursor:pointer;font-size:12.5px;color:var(--text-muted);padding:4px 0}.fd-c-a button:hover,.fd-c-a a:hover{color:var(--accent-text)}
.fd-c-a button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fd-c-form{margin:0 0 6px}.fd-c-form textarea{display:block;width:100%;box-sizing:border-box;min-height:44px;resize:vertical;font:14.5px/1.5 var(--font-body,'IBM Plex Sans',Arial,sans-serif);color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.fd-c-form textarea:focus{outline:none;border-color:var(--accent)}.fd-c-f{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px}
.fd-c .fd-c-form{margin:6px 0 4px 32px}.fd-c-in{margin:0 0 6px;font-size:14px;color:var(--text-muted)}.fd-c-in a{color:var(--accent-text)}
.fd{max-width:720px;margin:0 auto;padding:24px 16px 72px}.fd h1{font-family:var(--font-display,'Source Serif 4',Georgia,serif);font-size:clamp(1.6rem,3vw,2.1rem);margin:0 0 4px;color:var(--text-strong)}
.fd .lede{margin:0 0 18px;color:var(--text-muted)}
.fd-card{border:1px solid var(--line);border-radius:var(--radius-lg,14px);background:var(--bg-raised);padding:16px 18px}
.fd-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:20px 0 12px}.fd-tabs a{padding:6px 12px;border-radius:999px;border:1px solid var(--line);color:var(--text-muted);font-size:14px;text-decoration:none}
.fd-tabs a[aria-current="page"]{background:var(--accent-soft);border-color:transparent;color:var(--accent-text);font-weight:600}
.fd-list{display:flex;flex-direction:column;gap:10px}.fd-act{display:flex;gap:12px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line);font-size:14.5px;color:var(--text)}
.fd-act .ic{width:28px;text-align:center;font-size:17px;flex:none}.fd-act .t{flex:1;min-width:0}.fd-act .t a{color:var(--text-strong);font-weight:600;text-decoration:none}.fd-act time{color:var(--text-muted);font-size:12.5px;white-space:nowrap}
.fd-av{width:36px;height:36px;border-radius:50%;flex:none;object-fit:cover;background:var(--accent-soft);display:grid;place-items:center;color:var(--accent-text);font:600 15px var(--font-display,Georgia,serif);overflow:hidden}
.fd-av img{width:100%;height:100%;object-fit:cover}.fd-thumb{width:96px;height:50px;border-radius:8px;object-fit:cover;flex:none;border:1px solid var(--line);background:#0c1222}
.fd-post{display:flex;flex-direction:column;gap:10px}.fd-post .fd-top{display:flex;gap:10px;align-items:flex-start}.fd-post .sent{font-size:16px;line-height:1.5;color:var(--text)}
.fd-post .sent a.who{color:var(--text-strong);font-weight:700;text-decoration:none}.fd-post .slot{color:var(--accent-text);font-weight:600}
.fd-post .det{margin:0;color:var(--text);font-size:14.5px;line-height:1.55;overflow-wrap:anywhere}.fd-post .det a{color:var(--accent-text)}
.fd-chips{display:flex;flex-wrap:wrap;gap:6px}.fd-chips span{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent-text)}
.fd-chips span.ty{background:transparent;border:1px solid var(--line);color:var(--text-muted)}
.fd-meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;color:var(--text-muted)}.fd-meta a{color:var(--text-muted)}
.fd-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fd-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--line);color:var(--text);font:500 13px var(--font-body,'IBM Plex Sans',Arial,sans-serif);white-space:nowrap}
.fd-btn:hover{border-color:var(--accent)}.fd-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.fd-btn:disabled,.fd-btn[aria-disabled="true"]{opacity:.55;cursor:default}
.fd-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fd-kd{display:inline-flex;gap:2px;padding:1px;border-radius:999px;border:1px solid var(--line)}.fd-kd button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:3px;min-height:26px;padding:0 7px;border-radius:999px;font-size:14px}
.fd-kd button i{font:500 11.5px var(--font-body,Arial,sans-serif);font-style:normal;color:var(--text-muted)}.fd-kd button:hover:not(:disabled){background:var(--accent-soft)}.fd-kd button:disabled{cursor:default;opacity:.6}.fd-kd button.on{opacity:1;background:var(--accent-soft)}
.fd-menu{position:relative}.fd-pop{position:absolute;z-index:20;top:calc(100% + 6px);left:0;min-width:210px;padding:6px;border-radius:12px;border:1px solid var(--line);background:var(--bg-raised);box-shadow:0 12px 30px rgba(0,0,0,.25);display:flex;flex-direction:column}
.fd-pop[hidden]{display:none}.fd-pop a,.fd-pop button{all:unset;cursor:pointer;padding:8px 10px;border-radius:8px;font-size:14px;color:var(--text)}.fd-pop a:hover,.fd-pop button:hover{background:var(--accent-soft)}
.fd-comp h2,.fd-match h2,.fd-you h2{margin:0 0 10px;font-size:15px;color:var(--text-strong)}
.fd-types{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px}.fd-types button{all:unset;cursor:pointer;padding:7px 13px;border-radius:999px;border:1px solid var(--line);font-size:14px;color:var(--text)}
.fd-types button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.fd-types small{display:block;color:var(--text-muted);font-size:12px;margin-top:-6px;margin-bottom:10px}
.fd-q{display:grid;gap:10px}.fd-q label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-muted)}
.fd-q input,.fd-q select,.fd-q textarea{font:15px var(--font-body,'IBM Plex Sans',Arial,sans-serif);color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px;width:100%;box-sizing:border-box}
.fd-q textarea{min-height:70px;resize:vertical}.fd-q .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.fd-prev{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--bg);border:1px dashed var(--line);font-size:14.5px;color:var(--text)}.fd-prev .slot{color:var(--accent-text);font-weight:600}
.fd-err{color:#E5484D;font-size:13.5px;margin:8px 0 0}.fd-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}.fd-count{font-size:12.5px;color:var(--text-muted)}
.fd-m{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.fd-m .t{flex:1;min-width:0}.fd-m b{color:var(--text-strong)}.fd-m small{display:block;color:var(--text-muted);font-size:12.5px}
.fd-link{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);text-decoration:none;color:var(--text)}
.fd-link:hover{border-color:var(--accent)}.fd-link .lc-h{font-weight:600;color:var(--accent-text);overflow-wrap:anywhere}.fd-link .lc-p{color:var(--text-muted);font-weight:400}
.fd-link .lc-m{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;color:var(--text-muted)}.fd-link .lc-m span{white-space:nowrap}
.fd-fam{display:flex;gap:6px;margin:0 0 12px}.fd-fam button{all:unset;cursor:pointer;padding:8px 14px;border-radius:10px;border:1px solid var(--line);font:600 15px var(--font-display,Georgia,serif);color:var(--text-muted)}
.fd-fam button[aria-pressed="true"]{border-color:var(--accent);color:var(--text-strong);background:var(--accent-soft)}
.fd-big{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 12px}
.fd-big button{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;min-height:46px;padding:0 16px;border-radius:14px;border:1.5px solid var(--line);background:var(--bg);color:var(--text-strong);font:600 16px var(--font-body,var(--font-body,'IBM Plex Sans',Arial,sans-serif));transition:transform .15s,border-color .15s,background .15s,box-shadow .15s}
.fd-big button b{font-size:22px;line-height:1}.fd-big button:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:0 8px 20px rgba(139,108,246,.18)}
.fd-big button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 3px rgba(139,108,246,.25)}
.fd-big button:focus-visible,.fd-chips2 button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fd-chips2{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.fd-chips2 button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;min-height:34px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:500 14px var(--font-body,var(--font-body,'IBM Plex Sans',Arial,sans-serif));transition:transform .15s,border-color .15s,background .15s}
.fd-chips2 button:hover{transform:translateY(-2px);border-color:var(--accent)}.fd-chips2 button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.fd-pop1{animation:fdpop .35s ease-out}@keyframes fdpop{40%{transform:scale(1.08)}100%{transform:scale(1)}}
.fd-comp textarea{font:15px var(--font-body,var(--font-body,'IBM Plex Sans',Arial,sans-serif));color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px 14px;width:100%;box-sizing:border-box;min-height:88px;resize:vertical;line-height:1.5}
.fd-comp textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.fd-row2{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:6px 0 4px}.fd-row2 .fd-hint{font-size:12.5px;color:var(--accent-text)}
.fd-postbtn{min-height:38px;padding:0 18px;transition:transform .15s}.fd-postbtn:hover{transform:translateY(-1px)}
.fd-burst{position:fixed;z-index:70;pointer-events:none;font-size:20px;animation:fdburst .9s ease-out forwards}@keyframes fdburst{to{transform:translate(var(--dx),var(--dy)) scale(1.2);opacity:0}}
.fd-big button span{white-space:nowrap}@media (max-width:420px){.fd-big{gap:8px}.fd-big button{font-size:14px;gap:6px;padding:0 8px}.fd-big button b{font-size:18px}}
@media (prefers-reduced-motion:reduce){.fd-big button,.fd-chips2 button,.fd-postbtn{transition:none}.fd-big button:hover,.fd-chips2 button:hover{transform:none}.fd-pop1{animation:none}}
.fd-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.fd-spin{display:inline-block;font-size:15px}.fd-btn.busy .fd-spin{animation:fdspin .8s linear infinite}@keyframes fdspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.fd-btn.busy .fd-spin{animation:none}}
.fd-more{display:flex;justify-content:center;margin:16px 0}.fd-empty{color:var(--text-muted);text-align:center;padding:24px}
.fd-dots{min-width:34px;justify-content:center;font-size:18px;line-height:1}.fd-own .fd-pop{min-width:180px;left:auto;right:0}.fd-own .fd-pop button{display:block;width:100%;text-align:left}.fd-confirm{display:block;padding:8px 10px;font-size:14px;color:var(--text)}.fd-confirm button{display:inline-flex!important;width:auto!important;margin:6px 6px 0 0;padding:5px 12px!important;border-radius:999px;border:1px solid var(--line)}.fd-confirm [data-yes]{background:#E5484D;border-color:#E5484D;color:#fff}
.fd-tip{position:fixed;z-index:60;left:50%;bottom:24px;transform:translateX(-50%);padding:9px 14px;border-radius:10px;background:var(--text-strong);color:var(--bg);font-size:14px;box-shadow:0 10px 26px rgba(0,0,0,.3)}
.fd-shared{margin:0 0 14px;padding:12px 14px;border-radius:12px;background:var(--accent-soft);color:var(--text)}
.fd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:520px){.fd-thumb{display:none}.fd-act{font-size:14px}.fd-q .row{grid-template-columns:1fr}}
.fd-wrap.has-rail{display:grid;grid-template-columns:minmax(0,720px) 300px;gap:24px;justify-content:center;max-width:1080px;margin:0 auto;padding:0 16px}
.fd-wrap.has-rail .fd{margin:0;max-width:none;padding-left:0;padding-right:0}.fd-rail{padding-top:24px}.fd-rail .fd-people{position:sticky;top:calc(env(safe-area-inset-top,0px) + 76px)}
.fd-people-top{display:none;margin-top:16px}@media (max-width:1000px){.fd-wrap.has-rail{display:block;padding:0}.fd-wrap.has-rail .fd{padding:24px 16px 72px}.fd-rail{display:none}.fd-people-top{display:block}}
.fd-people h2{font:600 15px 'Source Serif 4',Georgia,serif;margin:0 0 10px}.fd-pp{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}.fd-pp:first-of-type{border-top:0}
.fd-pp-av{flex:none;width:36px;height:36px;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:var(--accent-soft,rgba(108,71,255,.12));color:var(--accent,#6C47FF);font-weight:600;text-decoration:none}.fd-pp-av img{width:100%;height:100%;object-fit:cover}
.fd-pp-t{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}.fd-pp-t a{color:var(--text);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fd-pp-t a:hover b{text-decoration:underline}
.fd-pp-t small{color:var(--text-muted);font-size:12.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fd-pp-f{flex:none;min-height:30px;padding:0 12px}.fd-pp-f[data-done]{opacity:.75}.fd-pp-n{margin:8px 0 0;font-size:12.5px;color:var(--text-muted)}</style>`;
  const FOLLOW_JS = `<script>(function(){document.querySelectorAll('[data-follow]').forEach(function(b){b.addEventListener('click',function(){if(b.hasAttribute('data-done'))return;var h=b.getAttribute('data-follow');b.disabled=true;
fetch('/v1/friend/'+encodeURIComponent(h),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},function(){return{ok:false,j:{}}}).then(function(x){
document.querySelectorAll('[data-follow="'+h+'"]').forEach(function(o){if(x.ok){o.textContent=x.j.state==='friends'?'Friends':'Following';o.setAttribute('data-done','1');o.disabled=true}else o.disabled=false});
var m=x.ok?(x.j.state==='friends'?'You and @'+h+' follow each other: you are friends now.':'You follow @'+h+'. If they follow you back, you are friends.'):(x.j.error||'Could not follow. Try again.');
var t=document.createElement('div');t.className='fd-tip';t.setAttribute('role','status');t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},2600)})})})})();</script>`;
  const avatarHtml = (w: any) => w?.avatar ? `<span class="fd-av"><img src="${esc(w.avatar)}" alt="" loading="lazy"></span>` : `<span class="fd-av" aria-hidden="true">${esc(String(w?.name || w?.handle || "?").charAt(0).toUpperCase())}</span>`;
  const whoLink = (w: any) => `<a href="/@${esc(w.handle)}/">${esc(w.name || "@" + w.handle)}</a>`;
  const linkify = (t: string) => esc(t).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow ugc">${u.replace(/^https?:\/\//, "")}</a>`);
  function chipsOf(f: PostFields) {
    const ch: string[] = [`<span class="ty">${esc(f.type === "recommend" ? "recommends " + ((REC as any)[f.rec || "other"] || "").replace(/^an? /, "") : TYPE_LABEL[f.type])}</span>`];
    if (f.commitment) ch.push((COMMIT as any)[f.commitment]); if (f.kind && f.type === "work") ch.push((WORK_KIND as any)[f.kind]); if (f.stage) ch.push((STAGE as any)[f.stage]);
    if (f.kind && f.type === "feedback") ch.push((FB_KIND as any)[f.kind] + " feedback"); if (f.oss === "yes") ch.push("open source");
    for (const s of [...(f.stack || []), ...(f.audience || [])]) ch.push(s);
    return `<div class="fd-chips">${ch.map((x, i) => i ? `<span>${esc(x)}</span>` : x).join("")}</div>`;
  }
  /** a recommendation's link: the domain shown, opens in a new window; a GitHub repo adds its public description, stars and language */
  function linkCard(f: PostFields) {
    if (!f.link) return "";
    const host = hostOf(f.link), path = (() => { try { const u = new URL(f.link!); return (u.pathname + u.search).replace(/\/$/, ""); } catch { return ""; } })();
    const meta = f.meta ? `<span class="lc-m">${f.meta.desc ? esc(f.meta.desc) : ""}${f.meta.stars != null ? `<span>&#9733; ${f.meta.stars.toLocaleString("en-US")}</span>` : ""}${f.meta.lang ? `<span>${esc(f.meta.lang)}</span>` : ""}</span>` : "";
    return `<a class="fd-link" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer nofollow ugc"><span class="lc-h">${esc(host)}<span class="lc-p">${esc(path.slice(0, 80))}</span> &#8599;</span>${meta}</a>`;
  }
  function postHtml(v: any, viewer: string | null, standalone = false) {
    const f = v.fields as PostFields, rec = f.type === "recommend";
    const sent = v.sentence.map(([t, slot]: [string, boolean]) => slot ? `<span class="slot">${esc(t)}</span>` : esc(t)).join("");
    const kd = Object.entries(POST_KUDOS).map(([k, em]) => `<button type="button" data-k="${k}"${v.myKudos ? " disabled" : ""}${v.myKudos === k ? ' class="on"' : ""} title="${v.myKudos ? "You sent kudos on this post today" : "Send " + em}" aria-label="Send ${em}">${em}<i>${v.kudos[k] || ""}</i></button>`).join("");
    const actions = [
      v.mine ? "" : `<span class="fd-kd" role="group" aria-label="Kudos">${kd}</span>`,
      v.mine || v.status !== "open" || rec ? "" : `<button type="button" class="fd-btn${v.helped ? "" : " pri"}" data-help${v.helped ? ' aria-disabled="true"' : ""}>${v.helped ? "Offered to help" : "I can help"}</button>`,
      `<button type="button" class="fd-btn" data-comments aria-expanded="${standalone ? "true" : "false"}" title="Comments">&#128172; <span data-ccount>${v.comments ? v.comments : "Comment"}</span></button>`,
      v.mine || !v.author.handle ? "" : `<a class="fd-btn" href="/messages/@${esc(v.author.handle)}?about=${esc(v.id)}" title="Message @${esc(v.author.handle)} about this post">Message</a>`,
      `<span class="fd-menu"><button type="button" class="fd-btn" data-share aria-haspopup="true">Share</button><span class="fd-pop" hidden role="menu"></span></span>`,
      v.mine ? `${rec ? "" : `<button type="button" class="fd-btn" data-matches>People who match</button>`}<span class="fd-menu fd-own"><button type="button" class="fd-btn fd-dots" data-own aria-haspopup="true" aria-label="More for your post" title="More">&#8943;</button><span class="fd-pop" hidden role="menu">${v.status === "open" ? `<button type="button" role="menuitem" data-close>Close (mark done)</button>` : ""}<button type="button" role="menuitem" data-delete>Delete</button><span class="fd-confirm" hidden>Delete this post? <button type="button" data-yes>Yes</button> <button type="button" data-no>Cancel</button></span></span></span>` : (viewer ? `<button type="button" class="fd-btn" data-report title="Report this post">Report</button>` : ""),
    ].join("");
    return `<article class="fd-card fd-post" data-post="${esc(v.id)}" data-url="${esc(v.url)}" data-text="${esc(v.text)}">
<div class="fd-top">${avatarHtml(v.author)}<div style="min-width:0;flex:1"><div class="sent"><a class="who" href="/@${esc(v.author.handle)}/">${esc(v.author.name)}</a> ${sent}${/[.!?]$/.test(v.sentence.map((x: any) => x[0]).join("")) ? "" : "."}</div>
<div class="fd-meta"><span>@${esc(v.author.handle)}</span><a href="/feed/p/${esc(v.id)}"${standalone ? ' aria-current="page"' : ""}><time datetime="${esc(v.ts)}">${ago(v.ts)}</time></a>${v.status === "closed" ? "<span>closed</span>" : ""}</div></div></div>
${v.detail && !f.simple ? `<p class="det">${linkMentions(linkify(v.detail), isMember)}</p>` : ""}${rec || f.simple ? linkCard(f) : ""}${chipsOf(f)}<div class="fd-acts">${actions}</div><div class="fd-matches" hidden></div>${standalone ? commentsHtml(v.id, viewer, row0(v.id)) : ""}</article>`;
  }
  const row0 = (id: string) => postRow(id)?.author || "";
  function commentHtml(v: any, replies: any[], viewer: string | null, postAuthor: string, depth: number): string {
    const kids = replies.length ? `<ol class="fd-thread">${replies.map(r => commentHtml(r, r.replies, viewer, postAuthor, depth + 1)).join("")}</ol>` : "";
    if (v.removed) return `<li class="fd-c gone" id="c-${esc(v.id)}" data-c="${esc(v.id)}"><div class="fd-c-b">[deleted]</div>${kids}</li>`;
    const mine = viewer === v.author.id, canDel = mine || (viewer && viewer === postAuthor);
    const acts = [viewer ? `<button type="button" data-creply>Reply</button>` : "",
      canDel ? `<button type="button" data-cdel>${mine ? "Delete" : "Remove"}</button>` : "", viewer && !mine ? `<button type="button" data-crep>Report</button>` : ""].join("");
    return `<li class="fd-c${v.author.id === postAuthor ? " op" : ""}" id="c-${esc(v.id)}" data-c="${esc(v.id)}"><div class="fd-c-h">${avatarHtml(v.author)}<a class="who" href="/@${esc(v.author.handle)}/">${esc(v.author.name)}</a>${v.author.id === postAuthor ? `<span class="op-t">author</span>` : ""}<a class="t" href="#c-${esc(v.id)}"><time datetime="${esc(v.ts)}">${ago(v.ts)}</time></a></div>`
      + `<div class="fd-c-b">${linkMentions(linkify(v.body), isMember).replace(/\n/g, "<br>")}</div><div class="fd-c-a">${acts}</div>${kids}</li>`;
  }
  /** the thread under a post: the composer first, then every comment (signed-out readers see it all, and a way in) */
  function commentsHtml(postId: string, viewer: string | null, postAuthor: string): string {
    const t = threadOf(postId), n = commentCount(postId);
    const form = viewer ? `<div class="fd-c-form"><label class="fd-sr" for="cm-${esc(postId)}">Add a comment</label><textarea id="cm-${esc(postId)}" data-mention maxlength="1000" rows="2" placeholder="Add a comment. Type @ to mention someone"></textarea><div class="fd-c-f"><span class="fd-count">Text only. Links are fine.</span><button type="button" class="fd-btn pri" data-csend>Comment</button></div></div>`
      : `<p class="fd-c-in"><a href="/auth/github?back=${encodeURIComponent("/feed/p/" + postId)}">Sign in with GitHub</a> to comment.</p>`;
    return `<section class="fd-cm" id="comments" data-cm="${esc(postId)}" aria-label="Comments"><h2 class="fd-c-n">${n ? `${n} comment${n === 1 ? "" : "s"}` : "Comments"}</h2>${form}<ol class="fd-thread fd-top-t">${t.map(v => commentHtml(v, v.replies, viewer, postAuthor, 0)).join("")}</ol></section>`;
  }
  function actHtml(i: any) {
    const icon: Record<string, string> = { gift: "\u2726", join: "\u{1F44B}", city: "\u{1F3D9}️", obsidian: "\u{1F48E}", friends: "\u{1F91D}", kudos: i.emoji || "✨", release: "\u{1F680}", tool: "\u{1F6E0}\uFE0F" };
    const text = i.kind === "join" ? `${whoLink(i.who)} joined Caldera${i.via ? ` with ${esc(i.via)}` : ""}`
      : i.kind === "city" ? `${whoLink(i.who)}'s city is up. <a href="${esc(i.url)}">Walk the city</a>`
      : i.kind === "obsidian" ? `${whoLink(i.who)} connected Obsidian`
      : i.kind === "friends" ? `${whoLink(i.who)} and ${whoLink(i.other)} are now friends`
      : i.kind === "kudos" ? `${whoLink(i.who)} sent ${whoLink(i.other)} ${esc(i.emoji || "kudos")}`
      : i.kind === "gift" ? `${whoLink(i.who)} lit up ${whoLink(i.other)}'s city${i.text ? ` for <b>${esc(i.text)}</b>` : ""}. <a href="/world">See it on the map</a>`
      : i.kind === "tool" ? `${whoLink(i.who)} shared a free tool: <a href="${esc(i.url)}"><b>${esc(i.text || "")}</b></a>`
      : `<a href="${esc(i.url || "/alerts")}">${esc(i.title || "New in Caldera")}</a>`;
    const thumb = i.kind === "city" ? `<a href="${esc(i.url)}" tabindex="-1" aria-hidden="true"><img class="fd-thumb" src="/@${esc(i.who.handle)}/card.png" alt="" loading="lazy"></a>` : "";
    return `<div class="fd-act" data-ts="${esc(i.ts)}"><span class="ic" aria-hidden="true">${icon[i.kind] || "•"}</span>${i.who ? avatarHtml(i.who) : ""}<span class="t">${text}</span>${thumb}<time datetime="${esc(i.ts)}">${ago(i.ts)}</time></div>`;
  }
  const itemHtml = (i: any, viewer: string | null) => i.kind === "post" ? postHtml(i.post, viewer) : actHtml(i);

  const SIGNIN = (back: string, inv = "") => `<div class="fd-card"><h2 style="margin:0 0 6px;font-size:16px;color:var(--text-strong)">Ask the network</h2><p style="margin:0 0 12px;color:var(--text-muted)">Looking for someone, code, work, clients or feedback? Members post here, and Caldera sends your ask to the people who fit.</p><a class="btn small" href="/auth/github?back=${encodeURIComponent(back)}${inv ? `&invite=${encodeURIComponent(inv)}` : ""}">Sign in with GitHub to post</a> <a href="/signin?back=${encodeURIComponent(back)}" style="margin-left:10px;font-size:14px">Other ways</a></div>`;
  /** the composer: one choice + one free-text box. Placeholders show what a good post looks like for each choice. */
  const PH: Record<string, string> = {
    someone: "a co-founder for a social app built on Next.js and Supabase", code: "an open-source library that parses Obsidian vaults into a graph",
    work: "contract work building AI agents in TypeScript and Python", clients: "beta testers for an AI inbox that answers email for founders",
    feedback: "honest feedback on my onboarding https://example.com", other: "a few people to trade notes with on building in public",
    "recommend:repo": "Caldera - turns your GitHub into a living city https://github.com/schoettle-cmd/caldera", "recommend:model": "Claude Opus - best model I've used for long agent runs https://www.anthropic.com/claude",
    "recommend:tool": "Claude Code - best coding agent I've used https://claude.com/claude-code", "recommend:read": "this essay on agent memory changed how I build https://...",
    "recommend:person": "@someone - writes the clearest threads on agent evals", "recommend:other": "what you recommend, and why",
  };
  const ASK_CHIPS: [string, string][] = [["someone", "\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1} someone"], ["code", "\u{1F4BB} code"], ["work", "\u{1F4BC} work"], ["clients", "\u{1F91D} clients"], ["feedback", "\u{1F4AC} feedback"], ["other", "\u2728 something else"]];
  const REC_CHIPS: [string, string][] = [["recommend:repo", "\u{1F4E6} a repo"], ["recommend:model", "\u{1F916} an AI model"], ["recommend:tool", "\u{1F6E0}\uFE0F a tool"], ["recommend:read", "\u{1F4D6} something to read"], ["recommend:person", "\u{1F464} a person"], ["recommend:other", "\u2728 something else"]];
  function composerHtml() {
    const chips = (fam: string, list: [string, string][]) => `<div class="fd-chips2" data-chips="${fam}" role="group" aria-label="What kind" hidden>${list.map(([v, l]) => `<button type="button" data-kind="${v}" aria-pressed="false">${l}</button>`).join("")}</div>`;
    return `<section class="fd-card fd-comp" aria-label="Post to the network">
<div class="fd-big" role="group" aria-label="What kind of post"><button type="button" data-fam="ask" aria-pressed="false"><b>\u{1F64B}</b><span>I need...</span></button><button type="button" data-fam="rec" aria-pressed="false"><b>\u{1F4A1}</b><span>I recommend...</span></button></div>
${chips("ask", ASK_CHIPS)}${chips("rec", REC_CHIPS)}
<div class="fd-write" data-write hidden><label class="fd-sr" for="fd-text">Your post</label><textarea id="fd-text" data-text data-mention maxlength="280" rows="3" placeholder="Say it in your own words"></textarea>
<div class="fd-row2"><span class="fd-count" data-count>0 / 280</span><span class="fd-hint" data-hint hidden>Add a link (https://...) so people can find it.</span></div>
<div class="fd-prev" data-prev hidden></div><p class="fd-err" data-err hidden></p>
<div class="fd-foot" data-foot><span class="fd-count">Text only. Caldera sends it to the people who fit.</span><button type="button" class="fd-btn pri fd-postbtn" data-post-it>Post</button></div></div></section><section class="fd-card fd-match" data-newmatch hidden></section>`;
  }
  const SCRIPT = (me: string | null, invite: string) => `<style>${MENTION_CSS}</style><script>${MENTION_JS}</script><script>(function(){var ME=${JSON.stringify(me)},INV=${JSON.stringify(invite)},HINT=${JSON.stringify(TYPE_HINT)};
${sentence.toString()}
function $(s,r){return (r||document).querySelector(s)}function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function tip(m){var t=document.createElement('div');t.className='fd-tip';t.setAttribute('role','status');t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},2600)}
function api(path,o){return fetch(path,{method:o?'POST':'GET',credentials:'same-origin',headers:o?{'content-type':'application/json'}:{},body:o?JSON.stringify(o):undefined}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera. Try again.'}}})}
function need(back){tip('Sign in to do that');setTimeout(function(){location.href='/auth/github?back='+encodeURIComponent(back||location.pathname)},700)}
// share: the permalink, plus the sharer's invite so sign-ups from it credit them
function shareUrl(u){return ME&&INV?u+(u.indexOf('?')<0?'?':'&')+'invite='+encodeURIComponent(INV):u}
function shareMenu(card,btn){var pop=btn.parentNode.querySelector('.fd-pop');if(!pop.hidden){pop.hidden=true;return}var u=shareUrl(card.getAttribute('data-url')),t=card.getAttribute('data-text'),e=encodeURIComponent;
var links=[['Copy link',null],['Post on X','https://twitter.com/intent/tweet?text='+e(t)+'&url='+e(u)],['Share on LinkedIn','https://www.linkedin.com/sharing/share-offsite/?url='+e(u)],['Post on Bluesky','https://bsky.app/intent/compose?text='+e(t+' '+u)],['Post on Mastodon','https://mastodonshare.com/?text='+e(t)+'&url='+e(u)],['Send on WhatsApp','https://wa.me/?text='+e(t+' '+u)],['Text message','sms:?&body='+e(t+' '+u)]];
pop.textContent='';if(navigator.share){var b0=document.createElement('button');b0.textContent='Share...';b0.addEventListener('click',function(){try{navigator.share({title:'Caldera',text:t,url:u}).catch(function(){})}catch(x){}pop.hidden=true});pop.appendChild(b0)}
links.forEach(function(l){var a;if(!l[1]){a=document.createElement('button');a.textContent=l[0];a.addEventListener('click',function(){var done=function(){tip(ME?'Link copied, with your invite':'Link copied')};try{navigator.clipboard.writeText(u).then(done,function(){prompt('Copy this link',u)})}catch(x){prompt('Copy this link',u)}pop.hidden=true})}
else{a=document.createElement('a');a.href=l[1];a.target='_blank';a.rel='noopener noreferrer';a.textContent=l[0];a.addEventListener('click',function(){pop.hidden=true})}a.setAttribute('role','menuitem');pop.appendChild(a)});pop.hidden=false}
document.addEventListener('click',function(ev){$$('.fd-pop').forEach(function(p){if(!p.parentNode.contains(ev.target))p.hidden=true})});
function matchesInto(box,list,pid){box.hidden=false;box.textContent='';var h=document.createElement('h2');h.textContent=list.length?'People who match':'No close matches yet';box.appendChild(h);
if(!list.length){var p=document.createElement('p');p.style.cssText='margin:0;color:var(--text-muted)';p.textContent='As people with a fit join, they show up here. Your post stays in the feed.';box.appendChild(p);return}
var all=document.createElement('button');all.className='fd-btn pri';all.type='button';all.textContent='Send to all '+list.length;all.style.marginBottom='6px';
function send(hs,btns){btns.forEach(function(b){b.disabled=true});api('/v1/posts/'+pid+'/send',{to:hs}).then(function(x){if(!x.ok){tip(x.j.error||'Could not send');btns.forEach(function(b){b.disabled=false});return}
(x.j.results||[]).forEach(function(r){var b=box.querySelector('[data-to="'+r.handle+'"]');if(b){b.textContent=r.state==='sent'?'Sent':r.state==='limit'?'Limit reached':'Not sent';b.disabled=true}});tip('Sent. They can accept to connect with you.')})}
all.addEventListener('click',function(){send(list.filter(function(m){return!m.sent}).map(function(m){return m.handle}),$$('[data-to]',box).concat([all]))});box.appendChild(all);
list.forEach(function(m){var row=document.createElement('div');row.className='fd-m';var av=document.createElement('span');av.className='fd-av';if(m.avatar){var im=new Image();im.src=m.avatar;im.alt='';av.appendChild(im)}else av.textContent=(m.name||m.handle).charAt(0).toUpperCase();
var t=document.createElement('div');t.className='t';var a=document.createElement('a');a.href='/@'+m.handle+'/';var b=document.createElement('b');b.textContent=m.name;a.appendChild(b);t.appendChild(a);var s=document.createElement('small');s.textContent='@'+m.handle+' \\u00b7 '+m.why;t.appendChild(s);
var bt=document.createElement('button');bt.type='button';bt.className='fd-btn';bt.setAttribute('data-to',m.handle);bt.textContent=m.sent?'Sent':'Send it to them';bt.disabled=!!m.sent;bt.addEventListener('click',function(){send([m.handle],[bt])});
row.appendChild(av);row.appendChild(t);row.appendChild(bt);box.appendChild(row)})}
function wire(card){var pid=card.getAttribute('data-post');
$$('.fd-kd button',card).forEach(function(b){b.addEventListener('click',function(){if(!ME)return need('/feed/p/'+pid);$$('.fd-kd button',card).forEach(function(x){x.disabled=true});api('/v1/posts/'+pid+'/kudos',{kind:b.getAttribute('data-k')}).then(function(x){if(x.ok){b.classList.add('on');var i=b.querySelector('i');i.textContent=String((parseInt(i.textContent,10)||0)+1);tip('Kudos sent')}else{tip(x.j.error||'Could not send');if(x.status!==409)$$('.fd-kd button',card).forEach(function(y){y.disabled=false})}})})});
var help=$('[data-help]',card);if(help)help.addEventListener('click',function(){if(!ME)return need('/feed/p/'+pid);if(help.getAttribute('aria-disabled'))return;api('/v1/posts/'+pid+'/help',{}).then(function(x){if(x.ok){help.textContent='Offered to help';help.classList.remove('pri');help.setAttribute('aria-disabled','true');tip('Sent. They can accept to connect with you.')}else tip(x.j.error||'Could not send')})});
var sh=$('[data-share]',card);if(sh)sh.addEventListener('click',function(){shareMenu(card,sh)});
var mt=$('[data-matches]',card);if(mt)mt.addEventListener('click',function(){var box=$('.fd-matches',card);if(!box.hidden){box.hidden=true;return}api('/v1/posts/'+pid+'/matches').then(function(x){if(x.ok)matchesInto(box,x.j.matches||[],pid);else tip(x.j.error||'Could not load')})});
var own=$('[data-own]',card);if(own){var op=own.parentNode.querySelector('.fd-pop'),cf=$('.fd-confirm',op);own.addEventListener('click',function(){op.hidden=!op.hidden;if(cf)cf.hidden=true;$$('[role=menuitem]',op).forEach(function(b){b.hidden=false})})}
var cl=$('[data-close]',card);if(cl)cl.addEventListener('click',function(){api('/v1/posts/'+pid+'/close',{}).then(function(x){if(x.ok){cl.remove();if(op)op.hidden=true;var m=$('.fd-meta',card);if(m){var s=document.createElement('span');s.textContent='closed';m.appendChild(s)}tip('Closed. It stays in the feed, marked closed.')}else tip(x.j.error||'Could not close')})});
var de=$('[data-delete]',card);if(de)de.addEventListener('click',function(){$$('[role=menuitem]',op).forEach(function(b){b.hidden=true});cf.hidden=false;$('[data-yes]',cf).focus()});
if(de){$('[data-no]',cf).addEventListener('click',function(){cf.hidden=true;op.hidden=true});$('[data-yes]',cf).addEventListener('click',function(){api('/v1/posts/'+pid+'/delete',{}).then(function(x){if(x.ok){if(location.pathname.indexOf('/feed/p/')===0){location.href='/feed';return}card.remove();tip('Deleted')}else tip(x.j.error||'Could not delete')})})}
var cb=$('[data-comments]',card);if(cb)cb.addEventListener('click',function(){var box=$('.fd-cm',card);if(box){box.hidden=!box.hidden;cb.setAttribute('aria-expanded',String(!box.hidden));if(!box.hidden){var t0=$('.fd-c-form textarea',box);if(t0)t0.focus()}return}
cb.disabled=true;api('/v1/posts/'+pid+'/comments?format=html').then(function(x){cb.disabled=false;if(!x.ok){tip(x.j.error||'Could not load comments');return}var d=document.createElement('div');d.innerHTML=x.j.html;var s=d.firstElementChild;card.appendChild(s);cb.setAttribute('aria-expanded','true');wireCm(s,card);var t1=$('.fd-c-form textarea',s);if(t1)t1.focus()})});
var cm0=$('.fd-cm',card);if(cm0)wireCm(cm0,card);
var rp=$('[data-report]',card);if(rp)rp.addEventListener('click',function(){if(rp.getAttribute('data-sure')!=='1'){rp.setAttribute('data-sure','1');rp.textContent='Report it?';return}api('/v1/posts/'+pid+'/report',{reason:'reported from the feed'}).then(function(x){if(x.ok){rp.textContent='Reported';rp.disabled=true;tip('Thanks. We will take a look.')}})})}
// comments: one listener per thread; replies open a small box under the comment
function wireCm(sec,card){var pid=sec.getAttribute('data-cm');
function count(n){var h=$('.fd-c-n',sec);if(h)h.textContent=n?n+' comment'+(n===1?'':'s'):'Comments';var c=$('[data-ccount]',card);if(c)c.textContent=n?String(n):'Comment'}
function box(parent){var f=document.createElement('div');f.className='fd-c-form';f.setAttribute('data-parent',parent);var t=document.createElement('textarea');t.maxLength=1000;t.rows=2;t.placeholder='Write a reply';t.setAttribute('aria-label','Write a reply');
var r=document.createElement('div');r.className='fd-c-f';var x=document.createElement('button');x.type='button';x.className='fd-btn';x.textContent='Cancel';x.setAttribute('data-ccancel','');var g=document.createElement('button');g.type='button';g.className='fd-btn pri';g.textContent='Reply';g.setAttribute('data-csend','');
r.appendChild(x);r.appendChild(g);f.appendChild(t);f.appendChild(r);return f}
function send(f){var t=$('textarea',f),v=t.value.trim(),b=$('[data-csend]',f),par=f.getAttribute('data-parent')||null;if(v.length<2){t.focus();return}b.disabled=true;
api('/v1/posts/'+pid+'/comments',{text:v,parent:par}).then(function(x){b.disabled=false;if(!x.ok){tip(x.j.error||'Could not post that');return}
var d=document.createElement('ol');d.innerHTML=x.j.html;var li=d.firstElementChild,list;
if(x.j.parent){var p=sec.querySelector('[data-c="'+x.j.parent+'"]');list=p&&p.querySelector(':scope>ol.fd-thread');if(p&&!list){list=document.createElement('ol');list.className='fd-thread';p.appendChild(list)}}
if(!list)list=$('.fd-top-t',sec);list.appendChild(li);if(par)f.remove();else t.value='';count(x.j.count);li.scrollIntoView({block:'nearest'})})}
sec.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&e.target.tagName==='TEXTAREA'){e.preventDefault();send(e.target.closest('.fd-c-form'))}});
sec.addEventListener('click',function(e){var el=e.target.closest('button,a');if(!el||!sec.contains(el))return;var li=el.closest('.fd-c');
if(el.hasAttribute('data-csend')){send(el.closest('.fd-c-form'));return}
if(el.hasAttribute('data-ccancel')){el.closest('.fd-c-form').remove();return}
if(el.hasAttribute('data-creply')){e.preventDefault();if(!ME)return need('/feed/p/'+pid);var ex=li.querySelector(':scope>.fd-c-form');if(ex){$('textarea',ex).focus();return}var f=box(li.getAttribute('data-c'));li.querySelector(':scope>.fd-c-a').after(f);$('textarea',f).focus();return}
if(el.hasAttribute('data-cdel')){if(el.getAttribute('data-sure')!=='1'){el.setAttribute('data-sure','1');el.textContent='Sure?';return}
api('/v1/comments/'+li.getAttribute('data-c')+'/delete',{}).then(function(x){if(!x.ok){tip(x.j.error||'Could not delete');return}if(x.j.state==='deleted'){li.className='fd-c gone';li.querySelector(':scope>.fd-c-h').remove();li.querySelector(':scope>.fd-c-a').remove();li.querySelector(':scope>.fd-c-b').textContent='[deleted]'}else li.remove();count(x.j.count)});return}
if(el.hasAttribute('data-crep')){if(el.getAttribute('data-sure')!=='1'){el.setAttribute('data-sure','1');el.textContent='Report it?';return}
api('/v1/comments/'+li.getAttribute('data-c')+'/report',{reason:'reported from the thread'}).then(function(x){if(x.ok){el.textContent='Reported';el.disabled=true;tip('Thanks. We will take a look.')}})}})}
$$('.fd-post').forEach(wire);
// the composer: two big choices, optional chips, one text box
var comp=$('.fd-comp');if(comp){var prev=$('[data-prev]',comp),err=$('[data-err]',comp),ta=$('[data-text]',comp),cnt=$('[data-count]',comp),hint=$('[data-hint]',comp),write=$('[data-write]',comp),FAM=null,KIND='',PH=${JSON.stringify(PH)},NEEDLINK=${JSON.stringify(REC_NEEDS_LINK)};
var calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function pop(el){if(calm)return;el.classList.remove('fd-pop1');void el.offsetWidth;el.classList.add('fd-pop1')}
function vals(){var k=KIND||(FAM==='rec'?'recommend:other':'other'),o={text:ta.value.trim()};if(k.indexOf('recommend:')===0){o.type='recommend';o.rec=k.slice(10)}else o.type=k;return o}
function link(t){var m=t.match(/https?:\\/\\/[^\\s"'<>]+/i);return m?m[0].replace(/[.,;:!?)\\]]+$/,''):''}
function render(){var o=vals(),l=link(o.text);cnt.textContent=ta.value.length+' / 280';hint.hidden=!(o.type==='recommend'&&NEEDLINK.indexOf(o.rec)>=0&&o.text.length>3&&!/^https:/.test(l));
if(!o.text){prev.hidden=true;return}var d=(l?o.text.replace(l,' '):o.text).replace(/\\s+/g,' ').replace(/\\s+([.,;:!?])/g,'$1').trim();prev.hidden=false;prev.textContent='';var b=document.createElement('b');b.textContent=(ME?'@'+INV:'You')+' ';prev.appendChild(b);
sentence({simple:true,type:o.type,detail:d||o.text}).forEach(function(x){var s=document.createElement('span');if(x[1])s.className='slot';s.textContent=x[0];prev.appendChild(s)});if(l){var c=document.createElement('div');c.style.cssText='margin-top:6px;color:var(--text-muted);font-size:13px';try{c.textContent='Link: '+new URL(l).hostname.replace(/^www\\./,'')}catch(x){c.textContent='Link: '+l}prev.appendChild(c)}}
function setPh(){ta.placeholder=PH[KIND]||(FAM==='rec'?'What you recommend, and why (add the link)':'What you need, in your own words')}
$$('[data-fam]',comp).forEach(function(b){b.addEventListener('click',function(){FAM=b.getAttribute('data-fam');KIND='';$$('[data-fam]',comp).forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});pop(b);
$$('[data-chips]',comp).forEach(function(c){c.hidden=c.getAttribute('data-chips')!==FAM});$$('[data-kind]',comp).forEach(function(x){x.setAttribute('aria-pressed','false')});write.hidden=false;err.hidden=true;setPh();render();ta.focus()})});
$$('[data-kind]',comp).forEach(function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-kind'),on=KIND!==k;KIND=on?k:'';$$('[data-kind]',comp).forEach(function(x){x.setAttribute('aria-pressed',String(on&&x===b))});if(on)pop(b);setPh();render();ta.focus()})});
ta.addEventListener('input',render);
function burst(el){if(calm)return;var r=el.getBoundingClientRect();['\u{1F389}','\u2728','\u{1F64C}','\u{1F4A5}','\u2B50','\u{1F680}'].forEach(function(em,i){var s=document.createElement('span');s.textContent=em;s.className='fd-burst';s.style.left=(r.left+r.width/2-10)+'px';s.style.top=(r.top-6)+'px';s.style.setProperty('--dx',(Math.cos(i)*60)+'px');s.style.setProperty('--dy',(-40-Math.random()*50)+'px');document.body.appendChild(s);setTimeout(function(){s.remove()},900)})}
$('[data-post-it]',comp).addEventListener('click',function(){var btn=this,o=vals();err.hidden=true;btn.disabled=true;api('/v1/posts',o).then(function(x){btn.disabled=false;if(!x.ok){err.textContent=x.j.error||'Could not post';err.hidden=false;return}
burst(btn);var list=$('.fd-list');var tmp=document.createElement('div');tmp.innerHTML=x.j.html;var card=tmp.firstElementChild;if(list&&card){list.insertBefore(card,list.firstChild);wire(card)}
ta.value='';render();var nm=$('[data-newmatch]');if(x.j.notified){nm.hidden=false;nm.textContent='';var h=document.createElement('h2');h.textContent=x.j.notified.length?'Shared with '+x.j.notified.length+' people it fits':'Posted to the feed';nm.appendChild(h);
x.j.notified.forEach(function(m){var r=document.createElement('div');r.className='fd-m';var t=document.createElement('div');t.className='t';var b=document.createElement('b');b.textContent=m.name;t.appendChild(b);var sm=document.createElement('small');sm.textContent='@'+m.handle+' \\u00b7 '+m.why;t.appendChild(sm);r.appendChild(t);nm.appendChild(r)})}
else matchesInto(nm,x.j.matches||[],x.j.post.id);nm.scrollIntoView({behavior:calm?'auto':'smooth',block:'nearest'});tip('Posted')})})}
// "For you": answers
$$('[data-answer]').forEach(function(b){b.addEventListener('click',function(){var row=b.closest('[data-waiting]');api('/v1/posts/'+row.getAttribute('data-post')+'/answer',{from:row.getAttribute('data-from'),yes:b.getAttribute('data-answer')==='yes'}).then(function(x){if(x.ok){row.querySelector('.acts').textContent=x.j.state==='friends'?'You are now friends':'Closed';tip(x.j.state==='friends'?'Connected':'Closed')}else tip(x.j.error||'Could not answer')})})});
// older items
var more=$('[data-more]');if(more)more.addEventListener('click',function(){var last=$$('.fd-list > [data-ts], .fd-list > article').pop();var before=last?(last.getAttribute('data-ts')||last.querySelector('time').getAttribute('datetime')):'';more.disabled=true;
api('/v1/feed?format=html&type='+encodeURIComponent(more.getAttribute('data-type'))+'&author='+encodeURIComponent(more.getAttribute('data-author')||'')+'&before='+encodeURIComponent(before)).then(function(x){more.disabled=false;if(!x.ok)return;var tmp=document.createElement('div');tmp.innerHTML=x.j.html||'';var n=0;while(tmp.firstElementChild){var el=tmp.firstElementChild;$('.fd-list').appendChild(el);if(el.classList.contains('fd-post'))wire(el);n++}if(!n||!x.j.more)more.parentNode.hidden=true})})
// refresh: swap in the latest list (same tab and author filter) without reloading the page
function tsOf(el){var t=el.querySelector('time');return el.getAttribute('data-ts')||(t?t.getAttribute('datetime'):'')||''}
var rf=$('[data-refresh]');if(rf)rf.addEventListener('click',function(){if(rf.classList.contains('busy'))return;rf.classList.add('busy');var list=$('.fd-list'),ts0=list.firstElementChild?tsOf(list.firstElementChild):'';
api('/v1/feed?format=html&fresh=1&type='+encodeURIComponent(rf.getAttribute('data-type'))+'&author='+encodeURIComponent(rf.getAttribute('data-author')||'')).then(function(x){rf.classList.remove('busy');if(!x.ok){tip('Could not refresh. Try again.');return}
list.innerHTML=x.j.html||'<p class="fd-empty">Nothing here yet.</p>';var n=0;$$('.fd-list > [data-ts], .fd-list > article').forEach(function(el){if(el.classList.contains('fd-post'))wire(el);if(ts0&&tsOf(el)>ts0)n++});
var mw=$('.fd-more');if(mw)mw.hidden=!x.j.more;tip(n?n+' new':'Up to date')})})})();</script>`;

  function youHtml(meId: string) {
    const n = noticesFor(meId, new Date(Date.now() - 14 * DAY).toISOString()); if (!n.waiting.length && !n.recs.length) return "";
    const recs = n.recs.slice(0, 3).map(r => `<div class="fd-m"><div class="t"><b>${esc(r.text)}</b><small>Recommended for people like you &middot; <a href="${esc(r.url)}">see it</a></small></div></div>`).join("");
    return `<section class="fd-card fd-you" aria-label="For you"><h2>For you</h2>${n.waiting.slice(0, 6).map(w => `<div class="fd-m" data-waiting data-post="${esc(w.post)}" data-from="${esc(w.from.handle)}"><div class="t"><b>${esc(w.kind === "help" ? `@${w.from.handle} can help with your post` : w.text)}</b><small>${w.kind === "help" ? "Accept to connect" : "Sent to you because you match. Accept to connect"} &middot; <a href="${esc(w.url)}">see the post</a></small></div><span class="acts"><button type="button" class="fd-btn pri" data-answer="yes">Accept</button> <button type="button" class="fd-btn" data-answer="no">Not now</button></span></div>`).join("")}${recs}</section>`;
  }
  /** "People you might know": suggested members with one-tap Follow, in the right rail (above the feed on phones) */
  function peopleHtml(meId: string, where: "rail" | "top") {
    let ppl: NonNullable<ReturnType<NonNullable<FeedCtx["suggest"]>>> = [];
    try { ppl = (c.suggest?.(meId, 5) || []).filter(p => p?.handle); } catch { /* suggestions never break the feed */ }
    if (!ppl.length) return "";
    const rows = ppl.map(p => { const nm = p.name || "@" + p.handle;
      return `<div class="fd-pp"><a class="fd-pp-av" href="/@${esc(p.handle)}/" aria-hidden="true" tabindex="-1">${p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">` : esc(nm.replace(/^@/, "").charAt(0).toUpperCase())}</a>
<div class="fd-pp-t"><a href="/@${esc(p.handle)}/"><b>${esc(nm)}</b></a><small>${esc(p.why || p.headline || "@" + p.handle)}</small></div><button type="button" class="fd-btn fd-pp-f" data-follow="${esc(p.handle)}" aria-label="Follow ${esc(nm)}">Follow</button></div>`; }).join("");
    return `<section class="fd-card fd-people fd-people-${where}" aria-label="People you might know"><h2>People you might know</h2>${rows}<p class="fd-pp-n">Follow each other and you're friends.</p></section>`;
  }
  function feedPage(res: http.ServerResponse, type: string, me: string | null, authorIn = "") {
    const ap = authorIn ? c.byHandle(authorIn) : null, author = ap && visible(ap) ? ap.handle as string : "";
    const t = FILTER[type] ? type : "all", items = page(t, "", me, 30, author), meH = me ? c.profile(me)?.handle || "" : "";
    const people = me && !author ? peopleHtml(me, "rail") : "";
    const tabs = [["all", "All"], ["posts", "Asks"], ["recommends", "Recommends"], ["members", "New members"], ["cities", "Cities"], ["kudos", "Kudos"]].map(([k, l]) => `<a href="/feed${k === "all" ? "" : "?type=" + k}"${k === t ? ' aria-current="page"' : ""}>${l}</a>`).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Feed - Caldera</title>
<meta name="description" content="What's happening on Caldera: new members, new cities, kudos, and what people are looking for."><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css">${CSS}</head><body><div class="fd-wrap${people ? " has-rail" : ""}"><main class="fd">
<div class="fd-head"><h1>Feed</h1><button type="button" class="fd-btn" data-refresh data-type="${t}" data-author="${esc(author)}" title="Load the latest without reloading the page"><span class="fd-spin" aria-hidden="true">&#8635;</span> Refresh</button></div><p class="lede">What's happening across Caldera, and what people are looking for. Post an ask and it goes to the people who fit.</p>
${me ? youHtml(me) + composerHtml() + (people ? peopleHtml(me, "top") : "") : SIGNIN("/feed")}
${author ? `<p class="fd-shared">Showing posts and activity from <a href="/@${esc(author)}/">@${esc(author)}</a>. <a href="/feed">Show everyone</a></p>` : ""}<nav class="fd-tabs" aria-label="Filter the feed">${tabs}</nav><div class="fd-list">${items.map(i => itemHtml(i, me)).join("") || `<p class="fd-empty">Nothing here yet.</p>`}</div>
<div class="fd-more"${items.length >= 30 ? "" : " hidden"}><button type="button" class="fd-btn" data-more data-type="${t}" data-author="${esc(author)}">Show older</button></div>
</main>${people ? `<aside class="fd-rail">${people}</aside>` : ""}</div>${SCRIPT(me, meH)}${people ? FOLLOW_JS : ""}</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Cookie" });
    res.end(c.navify(html, "/feed"));
  }
  function postPage(res: http.ServerResponse, id: string, me: string | null, inv: string) {
    const row = postRow(id); const author = row ? c.profile(row.author) : null;
    if (!row || row.status === "hidden" || !visible(author)) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); res.end(c.navify(`<!doctype html><html><head><meta charset="utf-8"><title>Not found - Caldera</title></head><body><main class="fd"><h1>That post isn't here</h1><p class="lede">It may have been deleted. <a href="/feed">Back to the feed</a></p></main></body></html>`, "/feed")); return; }
    const v = postView(row, me), meH = me ? c.profile(me)?.handle || "" : "", invBy = inv ? c.byHandle(inv) : null;
    const og = c.ogTags ? c.ogTags({ url: v.url, image: `${hub}/feed/p/${id}.png`, title: v.text, description: v.detail || `On Caldera, the social network for GitHub and Obsidian.` }) : "";
    const shared = !me && invBy && visible(invBy) ? `<div class="fd-shared"><b>${esc(invBy.name || "@" + invBy.handle)}</b> shared this with you. <a href="/auth/github?invite=${encodeURIComponent(invBy.handle)}&back=${encodeURIComponent("/feed/p/" + id)}">Sign up with GitHub</a> to reply, and you'll start as friends.</div>` : "";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(v.text)} - Caldera</title>
<meta name="description" content="${esc(v.detail || v.text)}">${og}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css">${CSS}</head><body><main class="fd">
<p style="margin:0 0 12px"><a href="/feed">&larr; Feed</a></p>${shared}<div class="fd-list">${postHtml(v, me, true)}</div>${me ? "" : `<div style="margin-top:16px">${SIGNIN("/feed/p/" + id, invBy && visible(invBy) ? invBy.handle : "")}</div>`}
</main>${SCRIPT(me, meH)}</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Cookie" });
    res.end(c.navify(html, "/feed"));
  }

  // ---------------------------------------------------------------- routes
  const cards = new Map<string, { at: number; png: Buffer }>();
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    if (req.method === "GET" && (p === "/feed" || p === "/feed/")) { feedPage(res, url.searchParams.get("type") || "all", c.memberOf(req), String(url.searchParams.get("author") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31)); return true; }
    let m = p.match(/^\/feed\/p\/([0-9a-f]{12})(\.png)?$/);
    if (req.method === "GET" && m) {
      if (!m[2]) { postPage(res, m[1], c.memberOf(req), String(url.searchParams.get("invite") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31)); return true; }
      const row = postRow(m[1]), author = row ? c.profile(row.author) : null;
      if (!row || row.status === "hidden" || !visible(author) || !c.postCard) { res.writeHead(404); res.end(); return true; }
      const key = m[1] + ":" + row.status; let hit = cards.get(key);
      if (!hit || Date.now() - hit.at > 6 * 3600_000) { const f = fieldsOf(row); hit = { at: Date.now(), png: await c.postCard({ handle: author.handle, name: author.name || author.handle, sentence: sentence(f).map(x => x[0]).join("") + ".", detail: f.detail || "" }) }; cards.set(key, hit); if (cards.size > 300) cards.delete(cards.keys().next().value!); }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }); res.end(hit.png); return true;
    }
    if (req.method === "GET" && p === "/v1/feed") {
      const me = c.memberOf(req), t = url.searchParams.get("type") || "all", au = String(url.searchParams.get("author") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);
      if (url.searchParams.get("fresh") && cache && Date.now() - cache.at > 3000) cache = null;   // the Refresh button: skip the 30s cache
      const items = page(FILTER[t] ? t : "all", url.searchParams.get("before") || "", me, 30, au);
      if (url.searchParams.get("format") === "html") { c.json(res, 200, { html: items.map(i => itemHtml(i, me)).join(""), more: items.length >= 30 }); return true; }
      c.json(res, 200, { items, more: items.length >= 30 }); return true;
    }
    if (req.method === "GET" && p === "/v1/me/notices") { const me = c.memberOf(req); if (!me) { c.json(res, 401, { error: "sign in" }); return true; } c.json(res, 200, noticesFor(me, url.searchParams.get("since") || "")); return true; }
    m = p.match(/^\/v1\/posts\/([0-9a-f]{12})\/comments$/);
    if (req.method === "GET" && m) {
      const me = c.memberOf(req), row = postRow(m[1]); if (!row || row.status === "hidden" || !visible(c.profile(row.author))) { c.json(res, 404, { error: "not found" }); return true; }
      if (url.searchParams.get("format") === "html") { c.json(res, 200, { html: commentsHtml(m[1], me, row.author), count: commentCount(m[1]) }); return true; }
      const strip = (v: any): any => ({ id: v.id, parent: v.parent, ts: v.ts, deleted: v.removed, text: v.body, author: v.author ? { handle: v.author.handle, name: v.author.name } : null, replies: v.replies.map(strip) });
      c.json(res, 200, { count: commentCount(m[1]), comments: threadOf(m[1]).map(strip) }); return true;
    }
    m = p.match(/^\/v1\/comments\/([0-9a-f]{16})\/(delete|report)$/);
    if (req.method === "POST" && m) {
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const me = c.memberOf(req); if (!me) { c.json(res, 401, { error: "Sign in to do that." }); return true; }
      const b = await c.readBody(req).catch(() => ({}));
      const r = m[2] === "delete" ? deleteComment(me, m[1]) : reportComment(me, m[1], String(b.reason || ""));
      c.json(res, r.status, r.body); return true;
    }
    m = p.match(/^\/v1\/posts\/([0-9a-f]{12})\/matches$/);
    if (req.method === "GET" && m) { const me = c.memberOf(req), row = postRow(m[1]); if (!me || !row || row.author !== me) { c.json(res, 404, { error: "not found" }); return true; } c.json(res, 200, { matches: matchesFor(m[1], 5) }); return true; }
    if (req.method === "POST" && (p === "/v1/posts" || /^\/v1\/posts\/[0-9a-f]{12}\/(send|help|answer|kudos|close|delete|report|comments)$/.test(p))) {
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const me = c.memberOf(req); if (!me) { c.json(res, 401, { error: "Sign in to do that." }); return true; }
      const b = await c.readBody(req).catch(() => ({}));
      if (p === "/v1/posts") {
        if (c.tooMany("post:" + me, 10)) { c.json(res, 429, { error: "Slow down a little." }); return true; }
        const r = createPost(me, b); if (r.status === 200) r.body.html = postHtml(r.body.post, me); c.json(res, r.status, r.body); return true;
      }
      const [, id, act] = p.match(/^\/v1\/posts\/([0-9a-f]{12})\/(\w+)$/)!;
      const r = act === "send" ? sendPost(me, id, Array.isArray(b.to) ? b.to : [b.to].filter(Boolean)) : act === "help" ? helpPost(me, id) : act === "answer" ? answer(me, id, String(b.from || ""), !!b.yes)
        : act === "kudos" ? kudosPost(me, id, String(b.kind || "")) : act === "close" ? closePost(me, id, false) : act === "delete" ? closePost(me, id, true)
        : act === "comments" ? addComment(me, id, b) : report(me, id, String(b.reason || ""));
      if (r.status === 200) cache = null;
      c.json(res, r.status, r.body); return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the profile activity card
  /** On a member's profile: their posts (newest first), then their activity (joined, city, Obsidian, friendships, kudos),
   *  one item at a time with ‹ › (swipe, arrow keys). Profiles are sandboxed, so actions go through the page's action token
   *  (`/v1/act`): kudos and "I can help" for visitors, Close / Delete for the owner. Nothing when there's nothing to show. */
  function profileCard(pr: any, o: { token: string | null; owner: boolean }): string {
    if (!pr?.handle || !visible(pr)) return "";
    const h = pr.handle as string, all = activity();
    const posts = (q("SELECT * FROM posts WHERE author=? AND status<>'hidden' ORDER BY ts DESC LIMIT 20").all(pr.id) as any[]).map(r => postView(r, null));
    const acts = all.filter(i => i.kind !== "post" && i.kind !== "rec" && i.kind !== "release" && i.kind !== "kudos" && (i.who?.handle === h || i.other?.handle === h)).slice(0, 12);
    const given = (q("SELECT COUNT(*) n FROM kudos WHERE sender=?").get(pr.id) as any).n as number, got = (q("SELECT COUNT(*) n FROM kudos WHERE recipient=?").get(pr.id) as any).n as number;
    if (!posts.length && !acts.length && !given && !got) return "";
    const items: string[] = [];
    for (const v of posts) {
      const f = v.fields as PostFields, rec = f.type === "recommend";
      const sent = v.sentence.map(([t, slot]: [string, boolean]) => slot ? `<span class="pc-slot">${esc(t)}</span>` : esc(t)).join("");
      const end = /[.!?]$/.test(v.sentence.map((x: any) => x[0]).join("")) ? "" : ".";
      const kd = Object.entries(POST_KUDOS).map(([k, em]) => `<button type="button" class="pc-k" data-k="${k}" aria-label="Send ${em}">${em}<i>${v.kudos[k] || ""}</i></button>`).join("");
      const e2 = encodeURIComponent, share = `<span class="pc-menu"><button type="button" class="pc-b" data-share>Share</button><span class="pc-pop" hidden>`
        + [["Post on X", `https://twitter.com/intent/tweet?text=${e2(v.text)}&url=${e2(v.url)}`], ["Share on LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${e2(v.url)}`], ["Post on Bluesky", `https://bsky.app/intent/compose?text=${e2(v.text + " " + v.url)}`], ["Open the post", v.url]]
          .map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${l}</a>`).join("") + `</span></span>`;
      const ownMenu = o.owner ? `<span class="pc-menu"><button type="button" class="pc-b pc-dots" data-own aria-label="More for your post" title="More">&#8943;</button><span class="pc-pop" hidden>${v.status === "open" ? `<button type="button" data-close>Close (mark done)</button>` : ""}<button type="button" data-delete>Delete</button><span class="pc-confirm" hidden>Delete this post? <button type="button" data-yes>Yes</button> <button type="button" data-no>Cancel</button></span></span></span>` : "";
      const acts2 = o.owner ? ownMenu : `<span class="pc-kd" role="group" aria-label="Kudos">${kd}</span>${!rec && v.status === "open" ? `<button type="button" class="pc-b pri" data-help>I can help</button>` : ""}<a class="pc-b" href="${esc(hub)}/messages/@${esc(h)}?about=${esc(v.id)}" target="_blank" rel="noopener" title="Message @${esc(h)} about this post">Message</a>`;
      const cmLink = `<a class="pc-b" href="${esc(v.url)}#comments" target="_blank" rel="noopener">&#128172; ${v.comments ? v.comments : "Comment"}</a>`;
      items.push(`<div class="pc-item" data-post="${esc(v.id)}"><div class="pc-kind">${rec ? "&#128161; Recommends" : "&#128587; Looking for"}${v.status === "closed" ? ` &middot; closed` : ""}</div><p class="pc-sent">@${esc(h)} ${sent}${end}</p>${f.link ? `<a class="pc-link" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer nofollow ugc">${esc(hostOf(f.link))} &#8599;</a>` : ""}<div class="pc-acts">${acts2}${cmLink}${share}<time datetime="${esc(v.ts)}">${ago(v.ts)}</time></div></div>`);
    }
    const ic: Record<string, string> = { join: "&#128075;", city: "&#127961;&#65039;", obsidian: "&#128142;", friends: "&#129309;" };
    for (const i of acts) {
      const other = i.who?.handle === h ? i.other : i.who;
      const t = i.kind === "join" ? `Joined Caldera${i.via ? ` with ${esc(i.via)}` : ""}` : i.kind === "city" ? `Their city went up. <a href="${esc(hub)}/@${esc(h)}/city.html">Walk the city</a>` : i.kind === "obsidian" ? "Connected Obsidian"
        : i.kind === "friends" && other ? `Became friends with <a href="${esc(hub)}/@${esc(other.handle)}/">${esc(other.name || "@" + other.handle)}</a>` : "";
      if (t) items.push(`<div class="pc-item"><div class="pc-kind">${ic[i.kind] || "&#8226;"} Activity</div><p class="pc-sent">${t}</p><div class="pc-acts"><time datetime="${esc(i.ts)}">${ago(i.ts)}</time></div></div>`);
    }
    if (given || got) items.push(`<div class="pc-item"><div class="pc-kind">&#10024; Kudos</div><p class="pc-sent">Sent ${given} kudos &middot; received ${got}</p></div>`);
    const n = items.length;
    return `<style>.pc{margin:14px 0 22px;border:1px solid var(--line,#2A2A2E);border-radius:14px;background:var(--bg-raised,#1C1C21);padding:14px 16px 12px;font:15px/1.5 var(--font-body,var(--font-body,'IBM Plex Sans',Arial,sans-serif));color:var(--text,#D6D6DC)}
.pc [hidden]{display:none!important}.pc-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}.pc-head h3{margin:0;flex:1;font:600 13px 'IBM Plex Sans',Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#8A8A93)}
.pc-nav{display:inline-flex;align-items:center;gap:6px}.pc-nav button{all:unset;box-sizing:border-box;cursor:pointer;width:30px;height:30px;display:inline-grid;place-items:center;border-radius:999px;border:1px solid var(--line,#2A2A2E);color:var(--text-strong,#F2F2F5);font-size:16px}.pc-nav button:disabled{opacity:.35;cursor:default}.pc-nav button:focus-visible,.pc:focus-visible{outline:2px solid var(--accent,#8B6CF6);outline-offset:2px}
.pc-count{font:500 12.5px 'IBM Plex Mono',monospace;color:var(--text-muted,#8A8A93);min-width:44px;text-align:center}
.pc-track{overflow:hidden;touch-action:pan-y}.pc-item{animation:pcin .25s ease-out}@keyframes pcin{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
.pc-kind{font-size:12.5px;color:var(--text-muted,#8A8A93);margin:0 0 4px}.pc-sent{margin:0 0 8px;color:var(--text-strong,#F2F2F5);font-size:16px}.pc-sent a{color:var(--accent-text,#B9A6FF)}.pc-slot{color:var(--accent-text,#B9A6FF);font-weight:600}
.pc-link{display:inline-block;margin:0 0 8px;font-size:13.5px;color:var(--accent-text,#B9A6FF);text-decoration:none}
.pc-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.pc-acts time{margin-left:auto;font-size:12.5px;color:var(--text-muted,#8A8A93)}
.pc-kd{display:inline-flex;gap:2px;padding:1px;border-radius:999px;border:1px solid var(--line,#2A2A2E)}.pc-k{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;min-height:26px;padding:0 8px;border-radius:999px;font-size:14px}.pc-k i{font:500 11.5px 'IBM Plex Sans',Arial,sans-serif;font-style:normal;color:var(--text-muted,#B8B8C2);margin-left:3px}.pc-k:hover:not(:disabled){background:var(--bg-sunken,#2A2636)}.pc-k:disabled{opacity:.55;cursor:default}.pc-k.on{opacity:1;background:var(--accent-soft,#3A2F5C)}
.pc-b{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;min-height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--line,#2A2A2E);font-size:13px;color:var(--text,#E6E6EA)}.pc-b.pri{border-color:var(--accent,#8B6CF6);color:var(--text-strong,#F2F2F5);font-weight:600}.pc-dots{padding:0 10px;font-size:17px}
.pc-menu{position:relative}.pc-pop{position:absolute;z-index:30;bottom:calc(100% + 6px);left:0;min-width:180px;padding:6px;border-radius:12px;border:1px solid var(--line,#2A2A2E);background:var(--bg-raised,#18171D);box-shadow:0 12px 30px rgba(0,0,0,.35);display:flex;flex-direction:column}.pc-pop a,.pc-pop>button{all:unset;cursor:pointer;padding:8px 10px;border-radius:8px;font-size:14px;color:var(--text,#E6E6EA)}.pc-pop a:hover,.pc-pop>button:hover{background:var(--bg-sunken,#26232F)}
.pc-confirm{padding:8px 10px;font-size:14px}.pc-confirm button{all:unset;cursor:pointer;display:inline-flex;margin:6px 6px 0 0;padding:4px 12px;border-radius:999px;border:1px solid var(--line,#2A2A2E)}.pc-confirm [data-yes]{background:#E5484D;border-color:#E5484D;color:#fff}
.pc-foot{display:flex;justify-content:flex-end;margin-top:10px;font-size:13.5px}.pc-foot a{color:var(--accent-text,#B9A6FF);text-decoration:none}.pc-tip{position:fixed;z-index:99;left:50%;bottom:20px;transform:translateX(-50%);padding:8px 13px;border-radius:10px;background:#18171D;color:#F2F2F5;font-size:13.5px;border:1px solid #2E2A40}
@media (prefers-reduced-motion:reduce){.pc-item{animation:none}}</style>
<section class="pc" tabindex="0" aria-roledescription="carousel" aria-label="@${esc(h)}'s posts and activity" data-api="${esc(hub)}"${o.token ? ` data-act="${esc(o.token)}"` : ""}><div class="pc-head"><h3>Posts &amp; activity</h3><span class="pc-nav"><button type="button" data-prev aria-label="Previous">&#8249;</button><span class="pc-count" aria-live="polite">1 / ${n}</span><button type="button" data-next aria-label="Next">&#8250;</button></span></div>
<div class="pc-track">${items.map((x, i) => i ? x.replace('<div class="pc-item"', '<div class="pc-item" hidden') : x).join("")}</div>
<div class="pc-foot"><a href="${esc(hub)}/feed?author=${encodeURIComponent(h)}" target="_blank" rel="noopener">See all in Feed &#8594;</a></div></section>
<script>(function(){var S=document.querySelector('section.pc');if(!S)return;var it=[].slice.call(S.querySelectorAll('.pc-item')),i=0,cnt=S.querySelector('.pc-count'),pv=S.querySelector('[data-prev]'),nx=S.querySelector('[data-next]'),api=S.getAttribute('data-api'),t=S.getAttribute('data-act');
function show(k){if(k<0||k>=it.length)return;it[i].hidden=true;i=k;it[i].hidden=false;cnt.textContent=(i+1)+' / '+it.length;pv.disabled=i===0;nx.disabled=i===it.length-1}show(0);
pv.addEventListener('click',function(){show(i-1)});nx.addEventListener('click',function(){show(i+1)});S.addEventListener('keydown',function(e){if(e.target.closest&&e.target.closest('input,textarea'))return;if(e.key==='ArrowLeft'){show(i-1);e.preventDefault()}if(e.key==='ArrowRight'){show(i+1);e.preventDefault()}});
var x0=null;S.addEventListener('touchstart',function(e){x0=e.touches[0].clientX},{passive:true});S.addEventListener('touchend',function(e){if(x0==null)return;var d=e.changedTouches[0].clientX-x0;x0=null;if(Math.abs(d)>40)show(d<0?i+1:i-1)});
function tip(m){var p=document.createElement('div');p.className='pc-tip';p.textContent=m;document.body.appendChild(p);setTimeout(function(){p.remove()},2400)}
function post(o){if(!t){tip('Sign in to do that');return Promise.resolve({ok:false,j:{}})}o.t=t;return fetch(api+'/v1/act',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(o)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera.'}}})}
document.addEventListener('click',function(e){[].forEach.call(S.querySelectorAll('.pc-pop'),function(p){if(!p.parentNode.contains(e.target))p.hidden=true})});
it.forEach(function(el){var pid=el.getAttribute('data-post');if(!pid)return;
[].forEach.call(el.querySelectorAll('[data-share],[data-own]'),function(b){b.addEventListener('click',function(){var p=b.parentNode.querySelector('.pc-pop');p.hidden=!p.hidden;var c=p.querySelector('.pc-confirm');if(c){c.hidden=true;[].forEach.call(p.querySelectorAll(':scope>button'),function(x){x.hidden=false})}})});
var ks=[].slice.call(el.querySelectorAll('.pc-k'));ks.forEach(function(b){b.addEventListener('click',function(){ks.forEach(function(x){x.disabled=true});post({action:'post-kudos',post:pid,kind:b.getAttribute('data-k')}).then(function(x){if(x.ok){b.classList.add('on');var n=b.querySelector('i');n.textContent=String((parseInt(n.textContent,10)||0)+1);tip('Kudos sent')}else{tip(x.j.error||'Could not send');if(x.status!==409)ks.forEach(function(y){y.disabled=false})}})})});
var hp=el.querySelector('[data-help]');if(hp)hp.addEventListener('click',function(){post({action:'post-help',post:pid}).then(function(x){if(x.ok){hp.textContent='Offered to help';hp.disabled=true;tip('Sent. They can accept to connect with you.')}else tip(x.j.error||'Could not send')})});
var cl=el.querySelector('[data-close]');if(cl)cl.addEventListener('click',function(){post({action:'post-close',post:pid}).then(function(x){if(x.ok){cl.remove();el.querySelector('.pc-kind').insertAdjacentText('beforeend',' · closed');tip('Closed. It stays visible, marked closed.')}else tip(x.j.error||'Could not close')})});
var de=el.querySelector('[data-delete]');if(de){var cf=el.querySelector('.pc-confirm');de.addEventListener('click',function(){[].forEach.call(de.parentNode.querySelectorAll(':scope>button'),function(x){x.hidden=true});cf.hidden=false});
cf.querySelector('[data-no]').addEventListener('click',function(){cf.parentNode.hidden=true});cf.querySelector('[data-yes]').addEventListener('click',function(){post({action:'post-delete',post:pid}).then(function(x){if(!x.ok){tip(x.j.error||'Could not delete');return}var k=it.indexOf(el);el.remove();it.splice(k,1);if(!it.length){S.remove();return}i=Math.min(k,it.length-1);it[i].hidden=false;cnt.textContent=(i+1)+' / '+it.length;pv.disabled=i===0;nx.disabled=i===it.length-1;tip('Deleted')})})}})})();</script>`;
  }

  // ---------------------------------------------------------------- operator tools (admin.js)
  const admin = {
    postsList: () => (q("SELECT p.id, p.type, p.status, p.ts, pr.handle, (SELECT COUNT(*) FROM post_reports r WHERE r.post=p.id) reports FROM posts p LEFT JOIN profiles pr ON pr.id=p.author ORDER BY reports DESC, p.ts DESC LIMIT 200").all() as any[])
      .map(r => ({ ...r, text: (() => { const row = postRow(r.id); return row ? sentenceText(r.handle || "?", fieldsOf(row)) : ""; })() })),
    postHide: (id: string) => { q("UPDATE posts SET status='hidden' WHERE id=?").run(id); cache = null; return { hidden: id }; },
    postDelete: (id: string) => { for (const t of ["posts WHERE id", "post_links WHERE post", "post_kudos WHERE post", "post_reports WHERE post"]) q(`DELETE FROM ${t}=?`).run(id); dropComments(id); cache = null; return { deleted: id }; },
    /** reported comments first, then the newest */
    commentsList: () => (q("SELECT m.id, m.post, m.status, m.ts, m.body, pr.handle, (SELECT COUNT(*) FROM comment_reports r WHERE r.comment=m.id) reports FROM post_comments m LEFT JOIN profiles pr ON pr.id=m.author ORDER BY reports DESC, m.ts DESC LIMIT 200").all() as any[]),
    commentHide: (id: string) => { q("UPDATE post_comments SET status='hidden' WHERE id=?").run(id); return { hidden: id }; },
    postBan: (handle: string, reason = "") => { const pr = c.byHandle(handle); if (!pr) return { error: "unknown handle" }; q("INSERT OR REPLACE INTO post_bans VALUES (?,?,?)").run(pr.id, reason, c.now()); q("UPDATE posts SET status='hidden' WHERE author=?").run(pr.id); cache = null; return { banned: handle }; },
    postUnban: (handle: string) => { const pr = c.byHandle(handle); if (pr) q("DELETE FROM post_bans WHERE member=?").run(pr.id); return { unbanned: handle }; },
  };
  /** deleting a profile takes its posts, links, kudos and reports with it */
  function erase(id: string) {
    for (const r of q("SELECT id FROM posts WHERE author=?").all(id) as any[]) admin.postDelete(r.id);
    for (const r of q("SELECT id FROM post_comments WHERE author=?").all(id) as any[]) removeComment(r.id);
    q("DELETE FROM comment_reports WHERE reporter=?").run(id);
    for (const sql of ["DELETE FROM post_links WHERE src=? OR dst=?", "DELETE FROM post_kudos WHERE sender=?", "DELETE FROM post_reports WHERE reporter=?", "DELETE FROM post_bans WHERE member=?"]) { const n = (sql.match(/\?/g) || []).length; q(sql).run(...Array(n).fill(id)); }
    cache = null;
  }
  /** How many feed items arrived since `member` last opened the feed, not counting ones they're part of. Never opened it: the last 3 days. */
  function newFor(member: string): number {
    const pr = c.profile(member); if (!pr?.handle) return 0;
    const seen = (q("SELECT ts FROM feed_seen WHERE member=?").get(member) as any)?.ts || new Date(Date.now() - 3 * 86400_000).toISOString();
    let n = 0;
    for (const i of activity()) { if (String(i.ts) <= seen) break; if (i.who?.handle !== pr.handle && i.other?.handle !== pr.handle) n++; }   // newest first; their own news isn't "new" to them
    return n;
  }
  const markSeen = (member: string) => { q("INSERT INTO feed_seen VALUES (?,?) ON CONFLICT(member) DO UPDATE SET ts=excluded.ts").run(member, c.now()); };

  return { setMatcher: (m: FeedMatcher) => { M = m; }, bust: () => { cache = null; }, route, activity, page, newFor, markSeen, profileCard, closePost, postRow, matchesFor, noticesFor, lookingFor, recsFor, createPost, sendPost, helpPost, answer, kudosPost, admin, erase, addComment, deleteComment, threadOf, commentCount, invalidate: () => { cache = null; } };
}
