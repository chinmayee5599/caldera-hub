/**
 * Groups: a few hub-wide conversations under Messages, one per topic (the group IS the topic). Members post into a group
 * and reply in threads under any post. Only the operator (the founder) makes, renames and archives groups.
 *
 * Unread: everything others posted in a group (posts and replies) since the member last opened it; never opened, the
 * whole group. It shows per group, on the Groups tab, and in the Messages badge (violet when only groups are new).
 * Deliberately no email: groups pull people in with the badge, not the inbox.
 */
import type http from "node:http";
import crypto from "node:crypto";
import { cleanText, renderText } from "./messages.js";

export interface ChatCtx {
  q: (sql: string) => any; now: () => string;
  profile: (id: string) => any; byHandle: (h: string) => any; body: (pr: any) => any; modOf: (h: string | null, id?: string) => any;
  memberOf: (req: http.IncomingMessage) => string | null; sameOrigin: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<any>; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  tooMany: (key: string, max: number, windowMs?: number) => boolean;
  /** the founder's handle: the only member who makes, renames and archives groups */
  founder: string | null;
  /** may this member post? (not banned from messaging) */
  canPost: (id: string) => boolean;
  /** what's new elsewhere for this member, shown as alerts on the Groups home (unread DMs, new feed items) */
  elsewhere?: (memberId: string) => { dms: number; feed: number };
  /** an alert in a member's bell (reports go to the founder) */
  notify?: (memberId: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void;
  /** the Messages page shell and pieces, shared with direct messages */
  ui: {
    shell: (title: string, inner: string, cls: string) => string;
    page: (res: http.ServerResponse, status: number, html: string) => void;
    listHead: (me: string, which: "dm" | "groups") => string;
    avatarHtml: (x: { avatar: string | null; name: string; handle: string | null }, size: number) => string;
    ago: (iso: string) => string;
  };
}

interface Group { id: string; name: string; about: string; created: string; sort: number; archived: number }
interface Post { id: string; grp: string; parent: string | null; author: string; body: string; ts: string; status: string; replies: number; last_reply: string | null }

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/, PID = /^[0-9a-f]{16}$/;
export const slugify = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function chat(c: ChatCtx) {
  const q = c.q;
  q(`CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, name TEXT, about TEXT, created TEXT, sort INTEGER, archived INTEGER DEFAULT 0)`).run();
  q(`CREATE TABLE IF NOT EXISTS chat_posts (id TEXT PRIMARY KEY, grp TEXT, parent TEXT, author TEXT, body TEXT, ts TEXT, status TEXT, replies INTEGER DEFAULT 0, last_reply TEXT)`).run();
  q(`CREATE INDEX IF NOT EXISTS chat_posts_grp ON chat_posts (grp, ts)`).run();
  q(`CREATE INDEX IF NOT EXISTS chat_posts_parent ON chat_posts (parent, ts)`).run();
  q(`CREATE TABLE IF NOT EXISTS chat_reads (member TEXT, grp TEXT, ts TEXT, PRIMARY KEY (member, grp))`).run();

  const founderId = () => { const pr = c.founder ? c.byHandle(c.founder) : null; return pr?.id || null; };
  const isFounder = (me: string | null) => !!me && me === founderId();
  const groups = (all = false) => q(`SELECT * FROM chat_groups ${all ? "" : "WHERE archived=0"} ORDER BY sort, created`).all() as Group[];
  const groupOf = (id: string) => q("SELECT * FROM chat_groups WHERE id=?").get(id) as Group | undefined;
  const postOf = (id: string) => q("SELECT * FROM chat_posts WHERE id=?").get(id) as Post | undefined;
  const who = (id: string) => { const pr = c.profile(id); if (!pr?.handle || c.modOf(pr.handle, pr.id)) return null;
    const b = c.body(pr); return { handle: pr.handle as string, name: (pr.name || pr.handle) as string, avatar: b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null }; };

  // ---------------------------------------------------------------- unread
  const readTs = (me: string, g: Group) => (q("SELECT ts FROM chat_reads WHERE member=? AND grp=?").get(me, g.id) as any)?.ts || g.created;
  function unreadIn(me: string, g: Group): number {
    return (q("SELECT COUNT(*) n FROM chat_posts WHERE grp=? AND author<>? AND status='ok' AND ts > ?").get(g.id, me, readTs(me, g)) as any).n;
  }
  /** all groups together: the Groups tab and the Messages badge */
  function unreadTotal(me: string | null): number {
    if (!me || !c.profile(me)?.handle) return 0;
    let n = 0; for (const g of groups()) n += unreadIn(me, g); return n;
  }
  const markRead = (me: string, g: Group) => { q("INSERT INTO chat_reads VALUES (?,?,?) ON CONFLICT(member, grp) DO UPDATE SET ts=excluded.ts").run(me, g.id, c.now()); };

  // ---------------------------------------------------------------- writes
  function post(me: string, slug: string, raw: unknown, parentId = ""): { status: number; body: any } {
    const g = groupOf(slug); if (!g || g.archived) return { status: 404, body: { error: "That group isn't here anymore." } };
    if (!who(me)) return { status: 403, body: { error: "Sign in to post." } };
    if (!c.canPost(me)) return { status: 403, body: { error: "You can't post in groups." } };
    const text = cleanText(raw); if (!text) return { status: 400, body: { error: "Write something first." } };
    if (c.tooMany("chat:" + me, 30)) return { status: 429, body: { error: "That's a lot of posts for one hour. Try again later." } };
    let parent: Post | undefined;
    if (parentId) { parent = postOf(parentId); if (!parent || parent.grp !== g.id || parent.parent || parent.status !== "ok") return { status: 404, body: { error: "That post isn't here anymore." } }; }
    const id = crypto.randomBytes(8).toString("hex"), ts = c.now();
    q("INSERT INTO chat_posts (id, grp, parent, author, body, ts, status, replies, last_reply) VALUES (?,?,?,?,?,?,?,?,?)").run(id, g.id, parent ? parent.id : null, me, text, ts, "ok", 0, null);
    if (parent) q("UPDATE chat_posts SET replies=replies+1, last_reply=? WHERE id=?").run(ts, parent.id);
    markRead(me, g);   // posting means you've seen the group
    return { status: 200, body: { ok: true, id, ts, html: postHtml(me, g, postOf(id)!, !!parent) } };
  }
  /** delete: the author or the founder. A post with replies keeps its place ("deleted") so the thread still reads. */
  function remove(me: string, id: string): { status: number; body: any } {
    const p = postOf(id); if (!p || p.status !== "ok") return { status: 404, body: { error: "Not found." } };
    if (p.author !== me && !isFounder(me)) return { status: 403, body: { error: "You can only delete your own posts." } };
    q("UPDATE chat_posts SET status='deleted', body='' WHERE id=?").run(id);
    if (p.parent) q("UPDATE chat_posts SET replies=MAX(0, replies-1) WHERE id=?").run(p.parent);
    return { status: 200, body: { ok: true } };
  }
  function report(me: string, id: string): { status: number; body: any } {
    const p = postOf(id), f = founderId(); if (!p || p.status !== "ok") return { status: 404, body: { error: "Not found." } };
    if (c.tooMany("chatrep:" + me, 10)) return { status: 429, body: { error: "Too many reports for now." } };
    const a = who(p.author), r = who(me), g = groupOf(p.grp);
    if (f) c.notify?.(f, { title: `Report in ${g?.name || "a group"}`, body: `@${r?.handle || "someone"} reported a post by @${a?.handle || "someone"}: "${p.body.slice(0, 140)}"`, ctaLabel: "Open it", ctaUrl: `/messages/groups/${p.grp}/${p.parent || p.id}#p-${p.id}`, key: "chatrep:" + p.id });
    return { status: 200, body: { ok: true } };
  }
  function saveGroup(me: string, b: any): { status: number; body: any } {
    if (!isFounder(me)) return { status: 403, body: { error: "Only the operator can change groups." } };
    const name = cleanText(b.name).replace(/\s+/g, " ").slice(0, 60), about = cleanText(b.about).replace(/\s+/g, " ").slice(0, 160);
    if (b.id) {
      const g = groupOf(String(b.id)); if (!g) return { status: 404, body: { error: "Not found." } };
      if (b.archive !== undefined) { q("UPDATE chat_groups SET archived=? WHERE id=?").run(b.archive ? 1 : 0, g.id); return { status: 200, body: { ok: true, id: g.id } }; }
      if (!name) return { status: 400, body: { error: "Give it a name." } };
      q("UPDATE chat_groups SET name=?, about=? WHERE id=?").run(name, about, g.id); return { status: 200, body: { ok: true, id: g.id } };
    }
    if (!name) return { status: 400, body: { error: "Give it a name." } };
    let id = slugify(name); if (!SLUG.test(id)) return { status: 400, body: { error: "Use letters or numbers in the name." } };
    if (groupOf(id)) id = `${id}-${crypto.randomBytes(2).toString("hex")}`;
    const sort = ((q("SELECT MAX(sort) m FROM chat_groups").get() as any)?.m ?? 0) + 1;
    q("INSERT INTO chat_groups (id, name, about, created, sort, archived) VALUES (?,?,?,?,?,0)").run(id, name, about, c.now(), sort);
    return { status: 200, body: { ok: true, id } };
  }
  function erase(id: string) { q("UPDATE chat_posts SET status='deleted', body='' WHERE author=?").run(id); q("DELETE FROM chat_reads WHERE member=?").run(id); }

  // ---------------------------------------------------------------- html
  const { avatarHtml, ago } = c.ui;
  const replyLabel = (p: Post) => p.replies ? `${p.replies} ${p.replies === 1 ? "reply" : "replies"} &middot; ${esc(ago(p.last_reply || p.ts))}` : "Reply";
  function postHtml(me: string, g: Group, p: Post, inThread: boolean, since = ""): string {
    const a = who(p.author);
    if (p.status !== "ok" || !a) return `<article class="cg-p cg-gone" id="p-${p.id}" data-ts="${esc(p.ts)}"><div class="cg-text">This post was deleted.</div>${!inThread && p.replies ? `<a class="cg-replies" href="/messages/groups/${g.id}/${p.id}">${replyLabel(p)}</a>` : ""}</article>`;
    const mine = p.author === me, isNew = since && p.author !== me && p.ts > since;
    return `<article class="cg-p${isNew ? " is-new" : ""}" id="p-${p.id}" data-ts="${esc(p.ts)}">${avatarHtml({ avatar: a.avatar, name: a.name, handle: a.handle }, 36)}`
      + `<div class="cg-m"><div class="cg-meta"><a class="cg-who" href="/@${esc(a.handle)}/"><b>${esc(a.name)}</b></a><span class="ms-mut">@${esc(a.handle)}</span><time datetime="${esc(p.ts)}">${esc(ago(p.ts))}</time></div>`
      + `<div class="cg-text">${renderText(p.body)}</div><div class="cg-acts">`
      + (inThread ? "" : `<a class="cg-replies${p.replies ? "" : " none"}" href="/messages/groups/${g.id}/${p.id}" data-rid="${p.id}">${replyLabel(p)}</a>`)
      + `<details class="ms-more cg-more"><summary aria-label="More">&#8943;</summary><span class="ms-menu">${mine || isFounder(me) ? `<button type="button" class="danger" data-del="${p.id}">Delete</button>` : ""}${mine ? "" : `<button type="button" data-rep="${p.id}">Report</button>`}<a href="/@${esc(a.handle)}/">View @${esc(a.handle)}</a></span></details>`
      + `</div></div></article>`;
  }
  function groupsList(me: string, current: string | null) {
    const gs = groups();
    const rows = gs.map(g => {
      const n = unreadIn(me, g), last = (q("SELECT ts FROM chat_posts WHERE grp=? AND status='ok' ORDER BY ts DESC LIMIT 1").get(g.id) as any)?.ts;
      return `<a class="ms-row cg-row${g.id === current ? " is-on" : ""}${n ? " is-unread" : ""}" href="/messages/groups/${g.id}"><span class="cg-hash" aria-hidden="true">#</span>`
        + `<span class="ms-row-m"><span class="ms-row-top"><b>${esc(g.name)}</b>${last ? `<time datetime="${esc(last)}">${esc(ago(last))}</time>` : ""}</span><span class="ms-row-last">${esc(g.about || "")}</span></span>`
        + `${n ? `<span class="cg-n" aria-label="${n} unread">${n > 99 ? "99+" : n}</span>` : ""}</a>`;
    }).join("");
    const admin = isFounder(me) ? `<details class="cg-admin"><summary>New group</summary><form class="cg-form" data-save=""><label>Name<input name="name" maxlength="60" required placeholder="AI model discussion"></label><label>About<input name="about" maxlength="160" placeholder="One line: what it's for"></label><button type="submit" class="ms-btn small">Create group</button></form></details>` : "";
    return `<section class="ms-list" aria-label="Groups">${c.ui.listHead(me, "groups")}`
      + (rows || `<div class="ms-empty"><b>No groups yet</b><span>${isFounder(me) ? "Make the first one below." : "Groups will show up here."}</span></div>`) + admin + `</section>`;
  }
  /** The Groups home: what others posted (posts and replies) in every group since you last opened it, newest first, with
   *  alerts for new direct messages and feed items. Opening it doesn't mark anything read: that happens per group. */
  function newPosts(me: string, limit = 40) {
    const out: (Post & { g: Group })[] = [];
    for (const g of groups()) for (const p of q("SELECT * FROM chat_posts WHERE grp=? AND author<>? AND status='ok' AND ts > ? ORDER BY ts DESC LIMIT ?").all(g.id, me, readTs(me, g), limit) as Post[]) out.push({ ...p, g });
    return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }
  function recentPosts(limit = 12) {
    const gs = new Map(groups().map(g => [g.id, g]));
    return (q("SELECT * FROM chat_posts WHERE status='ok' ORDER BY ts DESC LIMIT ?").all(limit * 3) as Post[]).filter(p => gs.has(p.grp)).slice(0, limit).map(p => ({ ...p, g: gs.get(p.grp)! }));
  }
  const snippet = (t: string, n = 240) => { const x = String(t || "").replace(/\s+/g, " ").trim(); return esc(x.length > n ? x.slice(0, n - 1) + "\u2026" : x); };
  function homeItem(me: string, p: Post & { g: Group }, isNew: boolean) {
    const a = who(p.author); if (!a) return "";
    const root = p.parent ? postOf(p.parent) : undefined;
    const href = p.parent ? `/messages/groups/${p.g.id}/${p.parent}#p-${p.id}` : `/messages/groups/${p.g.id}#p-${p.id}`;
    const ctx = root ? `replied in a thread${root.status === "ok" && who(root.author) ? `: <i>${snippet(root.body, 70)}</i>` : ""}` : "posted";
    return `<a class="cg-h-item${isNew ? " is-new" : ""}" href="${href}">${avatarHtml({ avatar: a.avatar, name: a.name, handle: a.handle }, 36)}`
      + `<span class="cg-m"><span class="cg-meta"><b>${esc(a.name)}</b><span class="ms-mut">${ctx}</span></span>`
      + `<span class="cg-h-text">${snippet(p.body)}</span>`
      + `<span class="cg-h-foot"><span class="cg-chip"># ${esc(p.g.name)}</span><time datetime="${esc(p.ts)}">${esc(ago(p.ts))}</time></span></span></a>`;
  }
  function homeView(me: string) {
    const fresh = newPosts(me), ex = c.elsewhere ? c.elsewhere(me) : { dms: 0, feed: 0 };
    const n = unreadTotal(me), alerts: string[] = [];
    if (ex.dms) alerts.push(`<a class="cg-alert dm" href="/messages"><span class="cg-alert-n">${ex.dms > 99 ? "99+" : ex.dms}</span><span><b>Unread direct ${ex.dms === 1 ? "message" : "messages"}</b><span>Someone wrote to you.</span></span><span class="cg-go">Open</span></a>`);
    if (ex.feed) alerts.push(`<a class="cg-alert feed" href="/feed"><span class="cg-alert-n">${ex.feed > 99 ? "99+" : ex.feed}</span><span><b>New in your feed</b><span>Posts and activity from people on Caldera.</span></span><span class="cg-go">Open</span></a>`);
    const body = fresh.length
      ? `<h2 class="cg-h-h">New posts <span class="cg-n">${n > 99 ? "99+" : n}</span></h2><div class="cg-h-list">${fresh.map(p => homeItem(me, p, true)).join("")}</div>`
      : `<div class="cg-caught"><b>You're all caught up</b><span>Nothing new in your groups since your last visit.</span></div>`
        + (() => { const r = recentPosts(); return r.length ? `<h2 class="cg-h-h">Recent in groups</h2><div class="cg-h-list">${r.map(p => homeItem(me, p, false)).join("")}</div>` : ""; })();
    return `<section class="ms-thread cg-home" aria-label="What's new" data-unread="${n}"><div class="ms-th-h"><span class="ms-th-who"><b>What's new</b><span class="ms-mut">New posts and replies in your groups since your last visit</span></span></div>`
      + `<div class="cg-h-body">${alerts.length ? `<div class="cg-alerts">${alerts.join("")}</div>` : ""}${body}</div>`
      + `<div class="cg-live" hidden><button type="button" class="ms-btn small" data-reload>New posts &middot; Show</button></div></section>`;
  }
  const backTo = (href: string, label: string) => `<a class="ms-back" href="${href}" aria-label="${esc(label)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>`;
  function groupView(me: string, g: Group) {
    const since = readTs(me, g);
    const roots = (q("SELECT * FROM chat_posts WHERE grp=? AND parent IS NULL AND (status='ok' OR replies>0) ORDER BY ts DESC LIMIT 150").all(g.id) as Post[]).reverse();
    let divided = false;
    const list = roots.map(p => { let h = postHtml(me, g, p, false, since);
      if (!divided && p.author !== me && p.ts > since && roots.some(r => r.ts <= since)) { divided = true; h = `<div class="cg-div" role="separator"><span>New since your last visit</span></div>` + h; }
      return h; }).join("");
    const edit = isFounder(me) ? `<details class="ms-more"><summary aria-label="Group settings">&#8943;</summary><span class="ms-menu cg-menu"><form class="cg-form" data-save="${g.id}"><label>Name<input name="name" maxlength="60" required value="${esc(g.name)}"></label><label>About<input name="about" maxlength="160" value="${esc(g.about)}"></label><button type="submit" class="ms-btn small">Save</button></form><button type="button" class="danger" data-archive="${g.id}">Archive group</button></span></details>` : "";
    return `<section class="ms-thread cg-view" aria-label="${esc(g.name)}" data-g="${g.id}" data-mode="group"><div class="ms-th-h">${backTo("/messages/groups", "Back to groups")}<span class="cg-hash big" aria-hidden="true">#</span>`
      + `<span class="ms-th-who"><b>${esc(g.name)}</b><span class="ms-mut">${esc(g.about || "")}</span></span><span class="ms-grow"></span>${edit}</div>`
      + `<div class="ms-msgs cg-posts" id="ms-msgs" aria-live="polite">${list || `<div class="ms-empty"><b>Start ${esc(g.name)}</b><span>Post the first thing. Anyone can reply in a thread under it.</span></div>`}</div>`
      + `<form class="ms-compose" id="cg-form"><label for="ms-text" class="sr">Post to ${esc(g.name)}</label><textarea id="ms-text" rows="2" maxlength="2000" placeholder="Post to ${esc(g.name)}. Enter to send, Shift+Enter for a new line."></textarea><button type="submit" class="ms-btn">Post</button></form>`
      + `<p class="ms-note">Every Caldera member can read and reply here. Text only.</p></section>`;
  }
  function threadView(me: string, g: Group, root: Post) {
    const replies = q("SELECT * FROM chat_posts WHERE parent=? AND status='ok' ORDER BY ts LIMIT 500").all(root.id) as Post[];
    return `<section class="ms-thread cg-view" aria-label="Thread in ${esc(g.name)}" data-g="${g.id}" data-root="${root.id}" data-mode="thread"><div class="ms-th-h">${backTo(`/messages/groups/${g.id}`, "Back to " + g.name)}`
      + `<span class="ms-th-who"><b>Thread</b><a href="/messages/groups/${g.id}"># ${esc(g.name)}</a></span><span class="ms-grow"></span></div>`
      + `<div class="ms-msgs cg-posts" id="ms-msgs" aria-live="polite"><div class="cg-root">${postHtml(me, g, root, true)}</div><div class="cg-div plain" role="separator"><span>${root.replies ? `${root.replies} ${root.replies === 1 ? "reply" : "replies"}` : "No replies yet"}</span></div>${replies.map(p => postHtml(me, g, p, true)).join("")}</div>`
      + (root.status === "ok" ? `<form class="ms-compose" id="cg-form"><label for="ms-text" class="sr">Reply</label><textarea id="ms-text" rows="2" maxlength="2000" placeholder="Reply in this thread. Enter to send, Shift+Enter for a new line."></textarea><button type="submit" class="ms-btn">Reply</button></form>` : "")
      + `</section>`;
  }

  // ---------------------------------------------------------------- routes
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    const me = c.memberOf(req);
    let m = p.match(/^\/messages\/groups(?:\/([a-z0-9-]+)(?:\/([0-9a-f]{16}))?)?\/?$/);
    if (req.method === "GET" && m) {
      if (!me) { res.writeHead(302, { location: `/signin?back=${encodeURIComponent(p.replace(/\/$/, ""))}`, "cache-control": "no-store" }); res.end(); return true; }
      const slug = m[1] || "", g = slug ? groupOf(slug) : undefined;
      if (!slug) { c.ui.page(res, 200, c.ui.shell("Groups", groupsList(me, null) + homeView(me), "is-list cg-is-home")); return true; }
      if (!g || (g.archived && !isFounder(me))) { c.ui.page(res, 404, c.ui.shell("Groups", groupsList(me, null) + `<section class="ms-thread"><div class="ms-empty"><b>That group isn't here</b><span>It may have been archived.</span></div></section>`, "is-thread")); return true; }
      let view: string;
      if (m[2]) { const root = postOf(m[2]); if (!root || root.grp !== g.id || root.parent) { res.writeHead(302, { location: `/messages/groups/${g.id}` }); res.end(); return true; } view = threadView(me, g, root); }
      else view = groupView(me, g);
      markRead(me, g);   // the view above used the previous visit ("new since your last visit"); the list, tab and badges count this group as read
      c.ui.page(res, 200, c.ui.shell(m[2] ? `Thread in ${g.name}` : g.name, groupsList(me, g.id) + view, "is-thread")); return true;
    }
    // polling: what's new in a group or a thread (pre-rendered), and updated reply counts on the group page
    m = p.match(/^\/v1\/groups\/([a-z0-9-]+)(?:\/([0-9a-f]{16}))?$/);
    if (req.method === "GET" && m) {
      res.setHeader("cache-control", "no-store");
      if (!me) { c.json(res, 401, { error: "sign in" }); return true; }
      const g = groupOf(m[1]); if (!g || g.archived) { c.json(res, 404, { error: "not found" }); return true; }
      const after = String(url.searchParams.get("after") || "");
      const rows = (m[2] ? q("SELECT * FROM chat_posts WHERE parent=? AND status='ok' AND ts > ? ORDER BY ts LIMIT 100").all(m[2], after)
        : q("SELECT * FROM chat_posts WHERE grp=? AND parent IS NULL AND status='ok' AND ts > ? ORDER BY ts LIMIT 100").all(g.id, after)) as Post[];
      const replies: Record<string, string> = {};
      if (!m[2]) for (const r of q("SELECT id, replies, last_reply, ts FROM chat_posts WHERE grp=? AND parent IS NULL AND last_reply > ?").all(g.id, after || "0") as Post[]) replies[r.id] = replyLabel(r);
      markRead(me, g);
      c.json(res, 200, { posts: rows.map(r => ({ id: r.id, ts: r.ts, mine: r.author === me, html: postHtml(me, g, r, !!m![2]) })), replies }); return true;
    }
    if (req.method === "GET" && p === "/v1/groups") {
      res.setHeader("cache-control", "no-store");
      if (!me) { c.json(res, 401, { error: "sign in" }); return true; }
      c.json(res, 200, { groups: groups().map(g => ({ id: g.id, name: g.name, about: g.about, unread: unreadIn(me, g) })), unread: unreadTotal(me) }); return true;
    }
    if (req.method === "POST" && /^\/v1\/groups(\/|$)/.test(p)) {
      if (!me) { c.json(res, 401, { error: "Sign in to post." }); return true; }
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const b = await c.readBody(req);
      if (p === "/v1/groups") { const r = saveGroup(me, b || {}); c.json(res, r.status, r.body); return true; }
      m = p.match(/^\/v1\/groups\/post\/([0-9a-f]{16})\/(delete|report)$/);
      if (m) { const r = m[2] === "delete" ? remove(me, m[1]) : report(me, m[1]); c.json(res, r.status, r.body); return true; }
      m = p.match(/^\/v1\/groups\/([a-z0-9-]+)\/post$/);
      if (m) { const parent = String(b?.parent || ""); if (parent && !PID.test(parent)) { c.json(res, 400, { error: "bad thread" }); return true; }
        const r = post(me, m[1], b?.text, parent); c.json(res, r.status, r.body); return true; }
      c.json(res, 404, { error: "not found" }); return true;
    }
    return false;
  }

  /** a group's name for the sign-up page ("Sign up to join ..."), if it exists */
  const nameOf = (slug: string) => { const g = SLUG.test(slug) ? groupOf(slug) : undefined; return g && !g.archived ? g.name : null; };
  return { route, unreadTotal, nameOf, erase, saveGroup, post, groups };
}

export const CHAT_CSS = `.cg-row{align-items:center}.cg-hash{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--accent-soft,rgba(139,108,246,.12));color:var(--accent-text,#b39dfa);font:600 20px var(--font-mono,'IBM Plex Mono',monospace)}
.cg-hash.big{width:36px;height:36px;font-size:17px;border-radius:10px}
.cg-n{flex:none;min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:#8B6CF6;color:#fff;font:600 12px/22px 'IBM Plex Sans',Arial,sans-serif;text-align:center}
.cg-admin{margin:12px 16px 0;padding:12px;border:1px dashed var(--line-strong,#3a3a40);border-radius:12px}.cg-admin>summary{cursor:pointer;color:var(--accent-text,#b39dfa);font-weight:600;font-size:14px}
.cg-form{display:flex;flex-direction:column;gap:10px;margin-top:10px}.cg-form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-muted,#8a8a93)}
.cg-form input{height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--line-strong,#3a3a40);background:var(--bg,#1c1c1f);color:var(--text-strong,#f2f2f5);font:14px var(--font-body,'IBM Plex Sans',Arial,sans-serif)}
.cg-menu{min-width:260px;gap:6px;padding:10px}
.cg-posts{gap:2px}.cg-p{display:flex;gap:12px;padding:10px 12px;border-radius:12px}.cg-p:hover{background:var(--bg-raised,#232327)}.cg-p.is-new{background:rgba(139,108,246,.07)}
.cg-p:target{outline:2px solid var(--accent,#8b6cf6);outline-offset:-2px}
.cg-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}.cg-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}.cg-who{color:var(--text-strong,#f2f2f5);text-decoration:none}.cg-who:hover{text-decoration:underline}.cg-meta time{font-size:12px;color:var(--text-muted,#8a8a93)}
.cg-text{font-size:15px;line-height:1.55;color:var(--text,#dadadf);overflow-wrap:anywhere}.cg-gone .cg-text{font-style:italic;color:var(--text-muted,#8a8a93)}
.cg-acts{display:flex;align-items:center;gap:8px;margin-top:2px}.cg-replies{font-size:13px;font-weight:600;color:var(--accent-text,#b39dfa);text-decoration:none;padding:6px 0;min-height:32px;display:inline-flex;align-items:center}.cg-replies.none{color:var(--text-muted,#8a8a93);font-weight:500}.cg-replies:hover{text-decoration:underline}
.cg-more>summary{width:30px;height:30px;font-size:16px;border:0}.cg-p:not(:hover) .cg-more:not([open])>summary{opacity:.45}
.cg-div{display:flex;align-items:center;gap:10px;margin:10px 0;color:#B9A6FF;font-size:12.5px;font-weight:600}.cg-div:before,.cg-div:after{content:"";flex:1;height:1px;background:#4A3A80}.cg-div.plain{color:var(--text-muted,#8a8a93);font-weight:500}.cg-div.plain:before,.cg-div.plain:after{background:var(--line,#2a2a2e)}
.cg-root .cg-p{background:var(--bg-raised,#232327)}.cg-root .cg-text{font-size:16px}
@media (max-width:760px){.cg-p{padding:10px 8px}.cg-more>summary{opacity:1!important}}
.cg-home .ms-th-h{border-bottom:1px solid var(--line,#2a2a2e)}.cg-h-body{padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px}
.cg-alerts{display:flex;flex-direction:column;gap:8px}.cg-alert{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;border:1px solid #4A3A80;background:rgba(139,108,246,.08);color:inherit;text-decoration:none}.cg-alert:hover{background:rgba(139,108,246,.14);text-decoration:none}
.cg-alert.dm{border-color:#6B2E2E;background:rgba(240,113,106,.08)}.cg-alert.dm:hover{background:rgba(240,113,106,.14)}
.cg-alert>span:nth-child(2){flex:1;min-width:0;display:flex;flex-direction:column}.cg-alert b{color:var(--text-strong,#f2f2f5);font-size:14.5px}.cg-alert>span:nth-child(2) span{font-size:13px;color:var(--text-muted,#8a8a93)}
.cg-alert-n{flex:none;min-width:30px;height:30px;padding:0 8px;border-radius:999px;background:#8B6CF6;color:#fff;font:600 13px/30px 'IBM Plex Sans',Arial,sans-serif;text-align:center}.cg-alert.dm .cg-alert-n{background:#E5484D}
.cg-go{flex:none;font-size:13px;font-weight:600;color:var(--accent-text,#b39dfa)}.cg-alert.dm .cg-go{color:#f0716a}
.cg-h-h{margin:6px 0 0;display:flex;align-items:center;gap:8px;font:600 13px var(--font-body,'IBM Plex Sans',Arial,sans-serif);letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted,#8a8a93)}
.cg-h-list{display:flex;flex-direction:column;gap:2px}.cg-h-item{display:flex;gap:12px;padding:12px;border-radius:12px;color:inherit;text-decoration:none}.cg-h-item:hover{background:var(--bg-raised,#232327);text-decoration:none}.cg-h-item.is-new{background:rgba(139,108,246,.07)}.cg-h-item.is-new:hover{background:rgba(139,108,246,.13)}
.cg-h-item .cg-meta b{color:var(--text-strong,#f2f2f5)}.cg-h-item .cg-meta i{font-style:normal;color:var(--text,#dadadf)}
.cg-h-text{font-size:14.5px;line-height:1.5;color:var(--text,#dadadf);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.cg-h-foot{display:flex;align-items:center;gap:10px;margin-top:2px}.cg-h-foot time{font-size:12px;color:var(--text-muted,#8a8a93)}.cg-chip{font:500 12px var(--font-mono,'IBM Plex Mono',monospace);color:var(--accent-text,#b39dfa);background:var(--accent-soft,rgba(139,108,246,.12));padding:2px 8px;border-radius:999px}
.cg-caught{padding:18px;border:1px dashed var(--line-strong,#3a3a40);border-radius:14px;display:flex;flex-direction:column;gap:4px;text-align:center}.cg-caught b{color:var(--text-strong,#f2f2f5)}.cg-caught span{font-size:13.5px;color:var(--text-muted,#8a8a93)}
.cg-live[hidden]{display:none}.cg-live{position:sticky;bottom:16px;display:flex;justify-content:center;pointer-events:none}.cg-live .ms-btn{pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,.4)}
@media (max-width:760px){.ms.cg-is-home{flex-direction:column}.ms.cg-is-home .ms-list{padding-bottom:0;border-bottom:1px solid var(--line,#2a2a2e)}.cg-h-body{padding:12px 12px 24px}.cg-home .ms-th-h{padding:12px 16px}.cg-live{bottom:calc(76px + env(safe-area-inset-bottom,0px))}}`;

export const CHAT_JS = `(function(){var H=document.querySelector('.cg-home');if(H){var base=+H.getAttribute('data-unread')||0,lv=H.querySelector('.cg-live');lv.querySelector('[data-reload]').addEventListener('click',function(){location.reload()});
function chk(){if(document.hidden)return;fetch('/v1/groups',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.unread>base)lv.hidden=false},function(){})}
setInterval(chk,30000);document.addEventListener('visibilitychange',chk)}})();
(function(){var V=document.querySelector('.cg-view');var box=document.getElementById('ms-msgs');
function tip(m){var t=document.createElement('div');t.className='ms-tip';t.setAttribute('role','status');t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},3200)}
function post(u,o){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(o||{})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera. Check your connection.'}}})}
document.querySelectorAll('form[data-save]').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var id=f.getAttribute('data-save');post('/v1/groups',{id:id||undefined,name:f.name.value,about:f.about.value}).then(function(x){if(!x.ok){tip(x.j.error||'Could not save.');return}location.href='/messages/groups/'+x.j.id})})});
document.addEventListener('click',function(e){var b=e.target.closest('[data-del],[data-rep],[data-archive]');if(!b)return;
if(b.hasAttribute('data-archive')){if(!b.getAttribute('data-sure')){b.setAttribute('data-sure','1');b.textContent='Tap again to archive';return}post('/v1/groups',{id:b.getAttribute('data-archive'),archive:true}).then(function(x){if(x.ok)location.href='/messages/groups';else tip(x.j.error||'Could not archive.')});return}
var id=b.getAttribute('data-del')||b.getAttribute('data-rep'),del=b.hasAttribute('data-del');
if(del&&!b.getAttribute('data-sure')){b.setAttribute('data-sure','1');b.textContent='Tap again to delete';return}
post('/v1/groups/post/'+id+'/'+(del?'delete':'report')).then(function(x){if(!x.ok){tip(x.j.error||'Could not do that.');return}
if(del){var a=document.getElementById('p-'+id);if(a){if(a.closest('.cg-root'))location.href='/messages/groups/'+V.getAttribute('data-g');else a.remove()}tip('Deleted.')}else{tip('Reported. Thanks, we\\'ll take a look.');var d=b.closest('details');if(d)d.open=false}})});
if(!V||!box)return;var g=V.getAttribute('data-g'),root=V.getAttribute('data-root')||'';
function toBottom(){if(location.hash)return;box.scrollTop=box.scrollHeight;if(box.scrollHeight<=box.clientHeight+2)window.scrollTo(0,document.documentElement.scrollHeight)}   // chat order: newest at the bottom, opened at the bottom
toBottom();setTimeout(toBottom,120);window.addEventListener('load',toBottom);
var last=(function(){var b=box.querySelectorAll('.cg-p[data-ts]');var l='';b.forEach(function(x){var t=x.getAttribute('data-ts');if(t>l)l=t});return l})();
function add(p){if(document.getElementById('p-'+p.id))return;var e=box.querySelector('.ms-empty');if(e)e.remove();var w=document.createElement('div');w.innerHTML=p.html;var el=w.firstChild;box.appendChild(el);if(p.ts>last)last=p.ts;var near=box.scrollHeight-box.scrollTop-box.clientHeight<240;if(near||p.mine)box.scrollTop=box.scrollHeight}
var F=document.getElementById('cg-form'),ta=document.getElementById('ms-text');
if(F&&ta){ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();F.requestSubmit?F.requestSubmit():F.dispatchEvent(new Event('submit',{cancelable:true}))}});
ta.addEventListener('input',function(){ta.style.height='auto';ta.style.height=Math.min(180,ta.scrollHeight)+'px'});
F.addEventListener('submit',function(e){e.preventDefault();var v=ta.value.trim();if(!v)return;var btn=F.querySelector('button');btn.disabled=true;
post('/v1/groups/'+g+'/post',{text:v,parent:root||undefined}).then(function(x){btn.disabled=false;if(!x.ok){tip(x.j.error||'Could not post that.');return}ta.value='';ta.style.height='';add({id:x.j.id,ts:x.j.ts,html:x.j.html,mine:true});
if(root){var d=box.querySelector('.cg-div.plain span');if(d){var n=box.querySelectorAll('.cg-p').length-1;d.textContent=n+(n===1?' reply':' replies')}}})})}
setInterval(function(){if(document.hidden)return;fetch('/v1/groups/'+g+(root?'/'+root:'')+'?after='+encodeURIComponent(last),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;(j.posts||[]).forEach(add);
Object.keys(j.replies||{}).forEach(function(id){var a=box.querySelector('[data-rid="'+id+'"]');if(a){a.innerHTML=j.replies[id];a.classList.remove('none')}})}).catch(function(){})},8000)})();`;
