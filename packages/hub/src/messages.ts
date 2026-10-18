/**
 * Direct messages (caldera.social/messages): signed-in members write to each other without ever seeing an email address.
 *
 * Friends (any kind of friendship) message each other directly. Anyone else's first message is a REQUEST: the recipient
 * sees it with Accept / Ignore / Block, and the sender can't send more until it's accepted (one pending request per pair;
 * after Ignore, no new request for 30 days). Accepting opens the conversation; it doesn't make them friends.
 *
 * Text only (2,000 characters, links shown as safe external links), no attachments. Bodies are sealed at rest with the
 * hub key: encrypted on our servers, not end-to-end, and the page says so. Block hides the thread and silently drops
 * everything from that person (they aren't told). Report puts the conversation's recent excerpt in a moderation queue.
 * Deleting a conversation removes it for both people; deleting an account removes that member's messages and the other
 * side sees "Deleted user".
 */
import http from "node:http";
import crypto from "node:crypto";

const DAY = 86_400_000;
export const MAX_LEN = 2000;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** text only: no markup survives (it's escaped on output), control characters out, newlines kept (max 3 in a row) */
export function cleanText(v: unknown): string {
  return String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮]/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, MAX_LEN);
}
/** a message as HTML: escaped text, https/http links as safe external links (new window, no referrer trust), newlines kept */
export function renderText(t: string): string {
  return esc(t).replace(/https?:\/\/[^\s<>"']+/g, u => { const tail = (u.match(/[.,;:!?)\]]+$/) || [""])[0], href = u.slice(0, u.length - tail.length);
    return `<a href="${href}" target="_blank" rel="noopener nofollow ugc">${href}</a>${tail}`; }).replace(/\n/g, "<br>");
}

export interface MsgCtx {
  q: (sql: string) => any; now: () => string; hub: string;
  profile: (id: string) => any; byHandle: (h: string) => any; body: (pr: any) => any; modOf: (h: string | null, id?: string) => any;
  areFriends: (a: string, b: string) => boolean;
  memberOf: (req: http.IncomingMessage) => string | null; sameOrigin: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<any>; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  navify: (html: string, current?: string) => string; tooMany: (key: string, max: number, windowMs?: number) => boolean;
  seal: (s: string) => string; unseal: (s: string) => string;
  /** may this member start conversations with non-friends? (brand-new, empty accounts message friends only) */
  canRequest?: (pr: any) => boolean;
  /** a personal alert in the member's bell (message requests only; ordinary messages use the Messages badge) */
  notify?: (memberId: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void;
  /** email a member about new messages (false: no address on file); `sign` makes the one-click "stop these emails" link */
  mailAlert?: (owner: string, a: { handle: string; name: string; preview: string; count: number; request: boolean; url: string; off: string }) => Promise<boolean>;
  sign?: (s: string) => string;
}

interface Thread { id: string; a: string; b: string; status: "open" | "request" | "ignored"; requested_by: string | null; created: string; updated: string; ignored_at: string | null }

export function messages(c: MsgCtx) {
  const { q } = c;
  q(`CREATE TABLE IF NOT EXISTS msg_threads (id TEXT PRIMARY KEY, a TEXT, b TEXT, status TEXT, requested_by TEXT, created TEXT, updated TEXT, ignored_at TEXT, UNIQUE (a, b))`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_messages (id TEXT PRIMARY KEY, thread TEXT, sender TEXT, body TEXT, ts TEXT, read_at TEXT)`).run();
  q(`CREATE INDEX IF NOT EXISTS msg_by_thread ON msg_messages(thread, ts)`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_blocks (blocker TEXT, blocked TEXT, ts TEXT, PRIMARY KEY (blocker, blocked))`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_reports (id TEXT PRIMARY KEY, thread TEXT, reporter TEXT, reported TEXT, reason TEXT, excerpt TEXT, ts TEXT, status TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_prefs (owner TEXT PRIMARY KEY, email_off INTEGER)`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_bans (member TEXT PRIMARY KEY, reason TEXT, ts TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS msg_emailed (owner TEXT, sender TEXT, ts TEXT, PRIMARY KEY (owner, sender))`).run();
  const hub = c.hub.replace(/\/$/, "");
  const pair = (x: string, y: string): [string, string] => x < y ? [x, y] : [y, x];
  const sentenceOf = (row: any): string => { try { const f = JSON.parse(row.fields || "{}"); return String(f.text || f.what || f.name || f.topic || "").trim(); } catch { return ""; } };
  const threadOf = (x: string, y: string) => { const [a, b] = pair(x, y); return q("SELECT * FROM msg_threads WHERE a=? AND b=?").get(a, b) as Thread | undefined; };
  const threadById = (id: string) => q("SELECT * FROM msg_threads WHERE id=?").get(id) as Thread | undefined;
  const other = (t: Thread, me: string) => t.a === me ? t.b : t.a;
  const blocked = (blocker: string, who: string) => !!q("SELECT 1 FROM msg_blocks WHERE blocker=? AND blocked=?").get(blocker, who);
  const usable = (pr: any) => !!pr?.handle && !c.modOf(pr.handle, pr.id);
  const avatarOf = (pr: any) => { const b = c.body(pr); return b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null; };
  const open = (s: string) => { try { return c.unseal(s); } catch { return ""; } };
  const tell = (to: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => { try { c.notify?.(to, a); } catch { /* never breaks a send */ } };

  // ---------------------------------------------------------------- actions
  function send(me: string, toHandle: string, raw: unknown): { status: number; body: any } {
    const mp = c.profile(me); if (!usable(mp)) return { status: 403, body: { error: "Sign in to send messages." } };
    if (q("SELECT 1 FROM msg_bans WHERE member=?").get(me)) return { status: 403, body: { error: "Messaging is turned off for this account." } };
    const to = c.byHandle(String(toHandle || "").toLowerCase().replace(/^@/, ""));
    if (!usable(to)) return { status: 404, body: { error: "That person isn't on Caldera." } };
    if (to.id === me) return { status: 400, body: { error: "That's you." } };
    const text = cleanText(raw); if (!text) return { status: 400, body: { error: "Write something first." } };
    if (blocked(me, to.id)) return { status: 409, body: { error: `You blocked @${to.handle}. Unblock them to send messages.` } };
    if (c.tooMany("msg:" + me, 30)) return { status: 429, body: { error: "That's 30 messages this hour. Try again a little later." } };
    let t = threadOf(me, to.id); const ts = c.now();
    const friends = c.areFriends(me, to.id);
    if (t && t.status === "request" && t.requested_by === to.id) { q("UPDATE msg_threads SET status='open', updated=? WHERE id=?").run(ts, t.id); t = threadById(t.id)!; }   // replying to a request accepts it
    if (t && t.status === "request" && t.requested_by === me && !friends) return { status: 409, body: { error: `Waiting for @${to.handle} to accept your request.`, state: "pending" } };
    let isRequest = false;
    if (!t || t.status === "ignored" || (t.status === "request" && !friends)) {
      if (friends) {
        if (t) q("UPDATE msg_threads SET status='open', requested_by=NULL, ignored_at=NULL, updated=? WHERE id=?").run(ts, t.id);
        else { const [a, b] = pair(me, to.id); q("INSERT INTO msg_threads VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomBytes(8).toString("hex"), a, b, "open", null, ts, ts, null); }
      } else {
        if (t?.status === "ignored" && t.requested_by === me && t.ignored_at && Date.parse(t.ignored_at) > Date.now() - 30 * DAY) return { status: 409, body: { error: `@${to.handle} isn't taking a request from you right now.`, state: "ignored" } };
        if (c.canRequest && !c.canRequest(mp)) return { status: 403, body: { error: "New accounts can message friends for their first couple of days. Add a friend, or try again soon." } };
        if (c.tooMany("msgreq:" + me, 10, DAY)) return { status: 429, body: { error: "That's 10 new message requests today. Try again tomorrow." } };
        if (t) q("UPDATE msg_threads SET status='request', requested_by=?, ignored_at=NULL, updated=? WHERE id=?").run(me, ts, t.id);
        else { const [a, b] = pair(me, to.id); q("INSERT INTO msg_threads VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomBytes(8).toString("hex"), a, b, "request", me, ts, ts, null); }
        isRequest = true;
      }
      t = threadOf(me, to.id)!;
    }
    // someone who blocked the sender never receives anything, and the sender isn't told
    if (blocked(to.id, me)) { q("UPDATE msg_threads SET updated=? WHERE id=?").run(ts, t.id); return { status: 200, body: { ok: true, state: isRequest ? "requested" : "sent", message: { mine: true, html: renderText(text), ts } } }; }
    const id = crypto.randomBytes(8).toString("hex");
    q("INSERT INTO msg_messages VALUES (?,?,?,?,?,?)").run(id, t.id, me, c.seal(text), ts, null);
    q("UPDATE msg_threads SET updated=? WHERE id=?").run(ts, t.id);
    if (isRequest) tell(to.id, { title: `@${mp.handle} wants to message you`, body: `${text.slice(0, 120)}${text.length > 120 ? "..." : ""}\n\nAccept to reply, or ignore it. They won't be told which.`, ctaLabel: "See the request", ctaUrl: `/messages/@${mp.handle}`, key: "msgreq:" + me });
    return { status: 200, body: { ok: true, state: isRequest ? "requested" : "sent", message: { id, mine: true, html: renderText(text), ts } } };
  }
  function decide(me: string, threadId: string, action: string, reason = ""): { status: number; body: any } {
    const t = threadById(threadId); if (!t || (t.a !== me && t.b !== me)) return { status: 404, body: { error: "not found" } };
    const them = other(t, me), ts = c.now();
    if (action === "accept" || action === "ignore") {
      if (t.status !== "request" || t.requested_by === me) return { status: 409, body: { error: "There's no request to answer." } };
      if (action === "accept") q("UPDATE msg_threads SET status='open', updated=? WHERE id=?").run(ts, t.id);
      else q("UPDATE msg_threads SET status='ignored', ignored_at=? WHERE id=?").run(ts, t.id);
      q("UPDATE msg_messages SET read_at=? WHERE thread=? AND sender=? AND read_at IS NULL").run(ts, t.id, them);
      return { status: 200, body: { ok: true, state: action === "accept" ? "open" : "ignored" } };
    }
    if (action === "block") { q("INSERT OR IGNORE INTO msg_blocks VALUES (?,?,?)").run(me, them, ts); q("UPDATE msg_messages SET read_at=? WHERE thread=? AND sender=? AND read_at IS NULL").run(ts, t.id, them); return { status: 200, body: { ok: true, state: "blocked" } }; }
    if (action === "unblock") { q("DELETE FROM msg_blocks WHERE blocker=? AND blocked=?").run(me, them); return { status: 200, body: { ok: true, state: "unblocked" } }; }
    if (action === "report") {
      if (c.tooMany("msgrep:" + me, 10, DAY)) return { status: 429, body: { error: "Too many reports today." } };
      const ex = (q("SELECT sender, body, ts FROM msg_messages WHERE thread=? ORDER BY ts DESC LIMIT 10").all(t.id) as any[]).reverse()
        .map(m => ({ from: c.profile(m.sender)?.handle || "deleted", ts: m.ts, text: open(m.body).slice(0, 500) }));
      q("INSERT INTO msg_reports VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomBytes(6).toString("hex"), t.id, me, them, String(reason || "").slice(0, 300), c.seal(JSON.stringify(ex)), ts, "open");
      return { status: 200, body: { ok: true, state: "reported" } };
    }
    if (action === "delete") { q("DELETE FROM msg_messages WHERE thread=?").run(t.id); q("DELETE FROM msg_threads WHERE id=?").run(t.id); return { status: 200, body: { ok: true, state: "deleted" } }; }
    return { status: 400, body: { error: "unknown action" } };
  }

  // ---------------------------------------------------------------- reading
  /** this member's conversations, newest first (a thread is hidden from someone who blocked the other person) */
  function inbox(me: string) {
    const rows = q("SELECT * FROM msg_threads WHERE (a=? OR b=?) ORDER BY updated DESC LIMIT 200").all(me, me) as Thread[];
    return rows.filter(t => !blocked(me, other(t, me)) && !(t.status === "ignored" && t.requested_by !== me)).map(t => {
      const them = c.profile(other(t, me)), last = q("SELECT sender, body, ts FROM msg_messages WHERE thread=? ORDER BY ts DESC LIMIT 1").get(t.id) as any;
      const unread = (q("SELECT COUNT(*) n FROM msg_messages WHERE thread=? AND sender<>? AND read_at IS NULL").get(t.id, me) as any).n;
      const state = t.status === "open" ? "open" : t.status === "request" ? (t.requested_by === me ? "pending" : "request") : "pending";
      return { id: t.id, handle: them?.handle || null, name: them ? (them.name || them.handle) : "Deleted user", avatar: them ? avatarOf(them) : null, state,
        last: last ? { mine: last.sender === me, text: open(last.body).replace(/\s+/g, " ").slice(0, 140), ts: last.ts } : null, unread, updated: t.updated };
    }).filter(x => x.last || x.state !== "open");
  }
  /** unread messages for the Messages badge: open threads plus requests waiting for this member */
  function unreadFor(me: string): number {
    const rows = q(`SELECT m.thread, t.a, t.b, t.status, t.requested_by FROM msg_messages m JOIN msg_threads t ON t.id=m.thread WHERE (t.a=? OR t.b=?) AND m.sender<>? AND m.read_at IS NULL`).all(me, me, me) as any[];
    return rows.filter(r => r.status !== "ignored" && !(r.status === "request" && r.requested_by === me) && !blocked(me, r.a === me ? r.b : r.a)).length;
  }
  /** a thread for its participant: the other person, the messages (marked read as they're shown), and what can be done */
  function thread(me: string, handle: string, after = "") {
    const them = c.byHandle(String(handle || "").toLowerCase()); if (!them || them.id === me) return null;
    const t = threadOf(me, them.id), friends = c.areFriends(me, them.id);
    const youBlocked = blocked(me, them.id);
    let msgs: any[] = [];
    if (t && !youBlocked) {
      msgs = q(`SELECT id, sender, body, ts, read_at FROM msg_messages WHERE thread=? ${after ? "AND ts > ?" : ""} ORDER BY ts ASC LIMIT 500`).all(...(after ? [t.id, after] : [t.id])) as any[];
      if (!(t.status === "request" && t.requested_by !== me)) q("UPDATE msg_messages SET read_at=? WHERE thread=? AND sender<>? AND read_at IS NULL").run(c.now(), t.id, me);   // a request is read when it's answered
    }
    const state = youBlocked ? "blocked" : !t ? (friends ? "new" : "new-request") : t.status === "open" ? "open" : t.status === "request" ? (t.requested_by === me ? "pending" : "request") : t.requested_by === me ? "pending" : "ignored";
    return { id: t?.id || null, state, friends, them: { handle: them.handle, name: them.name || them.handle, headline: them.headline || "", avatar: avatarOf(them), id: them.id },
      messages: msgs.map(m => ({ id: m.id, mine: m.sender === me, html: renderText(open(m.body)), ts: m.ts })) };
  }

  // ---------------------------------------------------------------- daily email + settings
  function digestFor(me: string, since: string) {
    if ((q("SELECT email_off FROM msg_prefs WHERE owner=?").get(me) as any)?.email_off) return undefined;
    const rows = q(`SELECT m.sender, m.body, m.ts, t.status, t.requested_by FROM msg_messages m JOIN msg_threads t ON t.id=m.thread WHERE (t.a=? OR t.b=?) AND m.sender<>? AND m.read_at IS NULL AND m.ts > ? ORDER BY m.ts DESC`).all(me, me, me, since) as any[];
    const by = new Map<string, { handle: string; name: string; count: number; preview: string; request: boolean }>();
    for (const r of rows) {
      if (r.status === "ignored" || blocked(me, r.sender)) continue;
      const pr = c.profile(r.sender); if (!pr?.handle) continue;
      const x = by.get(r.sender) || { handle: pr.handle, name: pr.name || pr.handle, count: 0, preview: open(r.body).replace(/\s+/g, " ").slice(0, 120), request: r.status === "request" };
      x.count++; by.set(r.sender, x);
    }
    const from = [...by.values()]; if (!from.length) return undefined;
    return { unread: from.reduce((a, x) => a + x.count, 0), from: from.slice(0, 5), url: `${hub}/messages` };
  }
  const emailOff = (me: string) => !!(q("SELECT email_off FROM msg_prefs WHERE owner=?").get(me) as any)?.email_off;
  function setEmail(me: string, on: boolean) { q("INSERT INTO msg_prefs VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET email_off=excluded.email_off").run(me, on ? 0 : 1); }

  // ---------------------------------------------------------------- email alerts for new messages
  // A minute after a message lands, if it's still unread, the recipient gets one email per sender; more from the same
  // person within 30 minutes wait for the next round (and still only if unread). Off with the Messages-page checkbox.
  const offSig = (id: string) => (c.sign ? c.sign("msg-email-off:" + id) : "").slice(0, 32);
  const offUrl = (id: string) => `${hub}/v1/messages/email-off?o=${encodeURIComponent(id)}&s=${offSig(id)}`;
  let sweeping = false;
  async function sweepAlerts(delayMs = 60_000): Promise<number> {
    if (!c.mailAlert || sweeping) return 0; sweeping = true; let sent = 0;
    try {
      const nowMs = Date.now(), upto = new Date(nowMs - delayMs).toISOString(), from = new Date(nowMs - DAY).toISOString(), gap = new Date(nowMs - 30 * 60_000).toISOString();
      const rows = q(`SELECT t.a, t.b, t.status, m.sender, m.body, m.ts FROM msg_messages m JOIN msg_threads t ON t.id=m.thread
        WHERE m.read_at IS NULL AND m.ts > ? AND m.ts <= ? ORDER BY m.ts`).all(from, upto) as any[];
      const by = new Map<string, { owner: string; sender: string; request: boolean; n: number; last: any }>();
      for (const r of rows) {
        const owner = r.a === r.sender ? r.b : r.a, k = owner + " " + r.sender;
        const x = by.get(k) || { owner, sender: r.sender, request: r.status === "request", n: 0, last: r };
        x.n++; x.last = r; by.set(k, x);
      }
      for (const x of by.values()) {
        if (x.last.status === "ignored" || emailOff(x.owner) || blocked(x.owner, x.sender)) continue;
        const prev = (q("SELECT ts FROM msg_emailed WHERE owner=? AND sender=?").get(x.owner, x.sender) as any)?.ts;
        if (prev && (prev > gap || prev >= x.last.ts)) continue;
        const fresh = prev ? (q("SELECT COUNT(*) n FROM msg_messages m JOIN msg_threads t ON t.id=m.thread WHERE (t.a=? OR t.b=?) AND m.sender=? AND m.read_at IS NULL AND m.ts > ?").get(x.owner, x.owner, x.sender, prev) as any).n : x.n;
        const pr = c.profile(x.sender), mine = c.profile(x.owner); if (!usable(pr) || !usable(mine)) continue;
        q("INSERT OR REPLACE INTO msg_emailed VALUES (?,?,?)").run(x.owner, x.sender, new Date().toISOString());   // before sending: a failure never repeats every minute
        const text = open(x.last.body).replace(/\s+/g, " ").trim();
        try { if (await c.mailAlert(x.owner, { handle: pr.handle, name: pr.name || pr.handle, preview: text.length > 200 ? text.slice(0, 199) + "\u2026" : text, count: fresh || 1, request: x.request, url: `${hub}/messages/@${pr.handle}`, off: offUrl(x.owner) })) sent++; }
        catch (e: any) { console.error("message email", e?.message); }
      }
    } finally { sweeping = false; }
    return sent;
  }
  if (c.mailAlert) { const t = setInterval(() => { sweepAlerts().catch(e => console.error("message email", e?.message)); }, 30_000); t.unref?.(); }

  /** an account is deleted: its messages and blocks go; the other side keeps the thread, shown as "Deleted user" */
  function erase(id: string) {
    q("DELETE FROM msg_emailed WHERE owner=? OR sender=?").run(id, id);
    q("DELETE FROM msg_messages WHERE sender=?").run(id);
    for (const t of q("SELECT id FROM msg_threads WHERE a=? OR b=?").all(id, id) as any[]) {
      if (!(q("SELECT 1 FROM msg_messages WHERE thread=? LIMIT 1").get(t.id))) q("DELETE FROM msg_threads WHERE id=?").run(t.id);
    }
    q("DELETE FROM msg_blocks WHERE blocker=? OR blocked=?").run(id, id); q("DELETE FROM msg_prefs WHERE owner=?").run(id); q("DELETE FROM msg_reports WHERE reporter=?").run(id);
  }

  // ---------------------------------------------------------------- operator moderation (admin CLI)
  const admin = {
    reports: () => (q("SELECT * FROM msg_reports ORDER BY ts DESC LIMIT 100").all() as any[]).map(r => ({ id: r.id, ts: r.ts, status: r.status, reason: r.reason,
      reporter: c.profile(r.reporter)?.handle || null, reported: c.profile(r.reported)?.handle || null })),
    view: (id: string) => { const r = q("SELECT * FROM msg_reports WHERE id=?").get(id) as any; if (!r) return { error: "no such report" };
      let ex: any[] = []; try { ex = JSON.parse(open(r.excerpt)); } catch { /* unreadable */ }
      return { id: r.id, reason: r.reason, reporter: c.profile(r.reporter)?.handle || null, reported: c.profile(r.reported)?.handle || null, excerpt: ex }; },
    close: (id: string) => { q("UPDATE msg_reports SET status='closed' WHERE id=?").run(id); return { closed: id }; },
    ban: (handle: string, reason = "") => { const pr = c.byHandle(handle); if (!pr) return { error: "unknown handle" }; q("INSERT OR REPLACE INTO msg_bans VALUES (?,?,?)").run(pr.id, reason, c.now()); return { banned: handle }; },
    unban: (handle: string) => { const pr = c.byHandle(handle); if (!pr) return { error: "unknown handle" }; q("DELETE FROM msg_bans WHERE member=?").run(pr.id); return { unbanned: handle }; },
  };

  // ---------------------------------------------------------------- pages
  const avatarHtml = (x: { avatar: string | null; name: string; handle: string | null }, size: number) => x.avatar
    ? `<img class="ms-av" src="${esc(x.avatar)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`
    : `<span class="ms-av ms-ini" style="width:${size}px;height:${size}px" aria-hidden="true">${esc((x.name || x.handle || "?").replace(/^@/, "").slice(0, 1).toUpperCase())}</span>`;
  const ago = (iso: string) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 7 * 86400 ? `${Math.floor(s / 86400)}d` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  function listHtml(me: string, current: string | null, tab: string) {
    const all = inbox(me), reqs = all.filter(x => x.state === "request"), rows = tab === "requests" ? reqs : all;
    const items = rows.map(x => `<a class="ms-row${x.handle === current ? " is-on" : ""}${x.unread ? " is-unread" : ""}" href="/messages/@${esc(x.handle || "")}"${x.handle ? "" : ' aria-disabled="true"'}>${avatarHtml(x, 44)}`
      + `<span class="ms-row-m"><span class="ms-row-top"><b>${esc(x.name)}</b><time datetime="${esc(x.last?.ts || x.updated)}">${esc(ago(x.last?.ts || x.updated))}</time></span>`
      + `<span class="ms-row-last">${x.state === "request" ? "Wants to message you" : x.state === "pending" ? "Request sent" + (x.last ? `: ${esc(x.last.text)}` : "") : x.last ? (x.last.mine ? "You: " : "") + esc(x.last.text) : ""}</span></span>`
      + `${x.unread ? '<span class="ms-dot" aria-label="Unread"></span>' : ""}</a>`).join("");
    const unread = all.reduce((a, x) => a + (x.unread ? 1 : 0), 0);
    return `<section class="ms-list" aria-label="Conversations"><div class="ms-list-h"><h1>Messages</h1>${unread ? `<span class="ms-mut">${unread} unread</span>` : ""}</div>`
      + `<div class="ms-tabs" role="tablist"><a role="tab" href="/messages${current ? "/@" + esc(current) : ""}" aria-selected="${tab !== "requests"}">All</a><a role="tab" href="/messages?tab=requests" aria-selected="${tab === "requests"}">Requests${reqs.length ? ` &middot; ${reqs.length}` : ""}</a></div>`
      + (items || `<div class="ms-empty"><b>${tab === "requests" ? "No requests" : "No messages yet"}</b><span>${tab === "requests" ? "When someone who isn't a friend writes to you, it waits here until you accept." : "Open someone's profile and tap Message. Friends get it right away; anyone else gets a request first."}</span>${tab === "requests" ? "" : '<a class="ms-btn ghost" href="/people">Find people</a>'}</div>`)
      + `<label class="ms-pref"><input type="checkbox" id="ms-email"${emailOff(me) ? "" : " checked"}> Email me when someone messages me</label></section>`;
  }
  function threadHtml(me: string, th: NonNullable<ReturnType<typeof thread>>) {
    const h = th.them.handle as string;
    const head = `<div class="ms-th-h"><a class="ms-back" href="/messages" aria-label="Back to messages"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>${avatarHtml({ avatar: th.them.avatar, name: th.them.name, handle: h }, 36)}`
      + `<span class="ms-th-who"><b>${esc(th.them.name)}</b><a href="/@${esc(h)}/">@${esc(h)}</a></span><span class="ms-grow"></span>`
      + `${th.friends ? "" : `<a class="ms-btn ghost small hide-sm" href="/@${esc(h)}/" title="Follow them from their page">Follow</a>`}<a class="ms-btn ghost small hide-sm" href="/@${esc(h)}/">View profile</a>`
      + `<details class="ms-more"><summary aria-label="More: block, report or delete">&#8943;</summary><span class="ms-menu">`
      + `<a href="/@${esc(h)}/">View profile</a>${th.id ? `<button type="button" data-act="${th.state === "blocked" ? "unblock" : "block"}">${th.state === "blocked" ? "Unblock" : "Block"} @${esc(h)}</button><button type="button" data-act="report">Report</button><button type="button" data-act="delete" class="danger">Delete conversation</button>` : ""}</span></details></div>`;
    let body = "", foot = "";
    const bubbles = th.messages.map(m => `<div class="ms-b ${m.mine ? "me" : "them"}" data-ts="${esc(m.ts)}">${m.html}</div>`).join("");
    if (th.state === "request") {
      body = `<div class="ms-req"><div class="ms-req-who">${avatarHtml({ avatar: th.them.avatar, name: th.them.name, handle: h }, 48)}<span><b>@${esc(h)} wants to message you</b><span class="ms-mut">${esc(th.them.headline || "Not a friend yet")}</span></span></div>`
        + `<div class="ms-req-msgs">${bubbles}</div><p class="ms-mut">Accept to reply. Ignore hides it and they can't ask again for 30 days. They won't be told which.</p>`
        + `<div class="ms-row-btns"><button type="button" class="ms-btn" data-act="accept">Accept</button><button type="button" class="ms-btn ghost" data-act="ignore">Ignore</button><button type="button" class="ms-link danger" data-act="block">Block</button><span class="ms-grow"></span><button type="button" class="ms-link" data-act="report">Report</button></div></div>`;
    } else if (th.state === "blocked") {
      body = `<div class="ms-empty"><b>You blocked @${esc(h)}</b><span>They can't message you, and they weren't told. Unblock from the menu to see this conversation again.</span></div>`;
    } else {
      body = bubbles || `<div class="ms-empty"><b>${th.state === "new-request" ? `Say hi to @${esc(h)}` : `Start a conversation with @${esc(h)}`}</b><span>${th.state === "new-request" ? "You're not friends yet, so your first message goes as a request. They can accept, or not." : "You're friends, so your message goes straight to them."}</span></div>`;
      const pending = th.state === "pending";
      foot = `<form class="ms-compose" id="ms-form"${pending ? " hidden" : ""}><label for="ms-text" class="sr">Message</label><textarea id="ms-text" rows="2" maxlength="${MAX_LEN}" placeholder="Write a message. Enter to send, Shift+Enter for a new line."></textarea><button type="submit" class="ms-btn" aria-label="Send">Send</button></form>`
        + (pending ? `<p class="ms-wait">Request sent. You can send more once @${esc(h)} accepts.</p>` : "")
        + `<p class="ms-note">Text only. Messages are encrypted on our servers; Caldera staff can read them only to investigate a report.</p>`;
    }
    return `<section class="ms-thread" aria-label="Conversation with @${esc(h)}" data-h="${esc(h)}" data-id="${esc(th.id || "")}" data-state="${esc(th.state)}">${head}<div class="ms-msgs" id="ms-msgs" aria-live="polite">${body}</div>${foot}</section>`;
  }
  function shell(title: string, inner: string, cls: string) {
    return c.navify(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>${CSS}</style></head><body><main class="ms ${cls}">${inner}</main><script>${JS}</script></body></html>`, "/messages");
  }
  const page = (res: http.ServerResponse, status: number, html: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", vary: "Cookie" }); res.end(html); };

  // ---------------------------------------------------------------- routes
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    const me = c.memberOf(req);
    if (req.method === "GET" && (p === "/messages" || p === "/messages/" || /^\/messages\/@[A-Za-z0-9-]+\/?$/.test(p))) {
      const h = (p.match(/^\/messages\/@([A-Za-z0-9-]+)/)?.[1] || "").toLowerCase();
      if (!me) { res.writeHead(302, { location: `/signin?back=${encodeURIComponent(h ? `/messages/@${h}` : "/messages")}`, "cache-control": "no-store" }); res.end(); return true; }
      const tab = url.searchParams.get("tab") === "requests" ? "requests" : "all";
      if (!h) { page(res, 200, shell("Messages", listHtml(me, null, tab) + `<section class="ms-thread ms-none"><div class="ms-empty"><b>Pick a conversation</b><span>Or open someone's profile and tap Message.</span></div></section>`, "is-list")); return true; }
      const them = c.byHandle(h);
      if (!usable(them)) { page(res, 404, shell("Messages", listHtml(me, null, tab) + `<section class="ms-thread"><div class="ms-empty"><b>@${esc(h)} isn't on Caldera</b><span>The account may have been deleted.</span></div></section>`, "is-thread")); return true; }
      if (them.id === me) { res.writeHead(302, { location: "/messages" }); res.end(); return true; }
      const th = thread(me, h)!;
      // "Message" on a feed post: start the reply with a quote of the post, so the author knows what it's about
      let draft = ""; const about = url.searchParams.get("about") || "";
      if (/^[A-Za-z0-9_-]{4,40}$/.test(about)) { try { const row = q("SELECT fields, detail FROM posts WHERE id=? AND author=?").get(about, them.id) as any;
        if (row) { const said = String(row.detail || "").trim() || sentenceOf(row); if (said) draft = `About your post "${said.length > 140 ? said.slice(0, 139) + "\u2026" : said}": `; } } catch { /* no posts table yet */ } }
      let html = threadHtml(me, th); if (draft) html = html.replace('placeholder="Write', `data-draft="${esc(draft)}" placeholder="Write`);
      page(res, 200, shell(`Messages with @${h}`, listHtml(me, h, tab) + html + (draft ? `<script>(function(){var t=document.getElementById("ms-text");if(t&&!t.value){t.value=t.getAttribute("data-draft")||"";t.focus();t.setSelectionRange(t.value.length,t.value.length)}})()</script>` : ""), "is-thread")); return true;
    }
    if (p === "/v1/messages/email-off" && (req.method === "GET" || req.method === "POST")) {
      const o = url.searchParams.get("o") || "", sig = url.searchParams.get("s") || "", ok = !!c.sign && !!o && sig.length === 32 && sig === offSig(o);
      const pg = (t: string, b: string) => { res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t} - Caldera</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"></head><body><main style="max-width:560px;margin:0 auto;padding:48px 16px"><h1 style="font-family:'Source Serif 4',Georgia,serif">${t}</h1>${b}<p><a href="/messages">Your messages</a></p></main></body></html>`); };
      if (!ok) { pg("Link not valid", "<p>This link isn't valid. You can turn message emails off on the Messages page.</p>"); return true; }
      if (req.method === "GET") { pg("Stop message emails", `<form method="post" action="/v1/messages/email-off?o=${encodeURIComponent(o)}&s=${sig}"><p>Stop emailing me when someone sends me a message on Caldera.</p><button class="btn" type="submit">Stop these emails</button></form>`); return true; }
      setEmail(o, false); pg("Done", "<p>No more emails about messages. Turn them back on any time on the Messages page.</p>"); return true;
    }
    if (req.method === "GET" && p === "/v1/messages/inbox") { if (!me) { c.json(res, 401, { error: "sign in" }); return true; } c.json(res, 200, { conversations: inbox(me), unread: unreadFor(me) }); return true; }
    if (req.method === "GET" && p === "/v1/messages/unread") { res.setHeader("cache-control", "no-store"); c.json(res, 200, { unread: me ? unreadFor(me) : 0 }); return true; }
    let m = p.match(/^\/v1\/messages\/thread\/@?([a-z0-9-]+)$/);
    if (req.method === "GET" && m) { if (!me) { c.json(res, 401, { error: "sign in" }); return true; } const th = thread(me, m[1], url.searchParams.get("after") || ""); if (!th) { c.json(res, 404, { error: "not found" }); return true; }
      res.setHeader("cache-control", "no-store"); c.json(res, 200, th); return true; }
    if (req.method === "POST" && /^\/v1\/messages\//.test(p)) {
      if (!me) { c.json(res, 401, { error: "Sign in to send messages." }); return true; }
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "cross-site request refused" }); return true; }
      const b = await c.readBody(req);
      if (p === "/v1/messages/send") { const r = send(me, String(b.to || ""), b.text); c.json(res, r.status, r.body); return true; }
      if (p === "/v1/messages/prefs") { setEmail(me, !!b.email); c.json(res, 200, { ok: true, email: !!b.email }); return true; }
      m = p.match(/^\/v1\/messages\/([0-9a-f]{16})\/(accept|ignore|block|unblock|report|delete)$/);
      if (m) { const r = decide(me, m[1], m[2], b.reason); c.json(res, r.status, r.body); return true; }
      c.json(res, 404, { error: "not found" }); return true;
    }
    return false;
  }
  /** the Messages icon + unread badge for a signed-in bar */
  /** The Messages link with its unread badge: `header` styles it for THE header (ch-icon), otherwise the older bars. */
  function iconFor(me: string | null | undefined, header = false): string {
    if (!me) return "";
    const n = unreadFor(me);
    if (header) return `<a class="ch-icon ch-msgs" href="${hub}/messages" aria-label="Messages${n ? `, ${n} unread` : ""}" title="Messages"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${n ? `<span class="ch-badge">${n > 9 ? "9+" : n}</span>` : ""}</a>`;
    return `<a class="cb-msgs" href="${hub}/messages" aria-label="Messages${n ? `, ${n} unread` : ""}" title="Messages" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:30px;border-radius:999px;color:#D6D6DC;text-decoration:none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${n ? `<span style="position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:var(--danger,#F0716A);color:#fff;font:600 10.5px/16px 'IBM Plex Sans',Arial,sans-serif;text-align:center">${n > 9 ? "9+" : n}</span>` : ""}</a>`;
  }
  return { route, send, decide, inbox, thread, unreadFor, digestFor, erase, admin, iconFor, setEmail, sweepAlerts };
}

// ---------------------------------------------------------------------------------------------------- page styles + script
const CSS = `.ms{max-width:1180px;margin:0 auto;padding:0 16px;display:flex;min-height:calc(100vh - 140px);box-sizing:border-box}
.ms *{box-sizing:border-box}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.ms-list{width:340px;flex:none;border-right:1px solid var(--line,#2a2a2e);display:flex;flex-direction:column;padding-bottom:12px}
.ms-list-h{display:flex;align-items:baseline;justify-content:space-between;padding:20px 16px 10px}.ms-list-h h1{margin:0;font:600 26px var(--font-display,'Source Serif 4',Georgia,serif);color:var(--text-strong,#f2f2f5)}
.ms-mut{color:var(--text-muted,#8a8a93);font-size:13px}
.ms-tabs{display:flex;gap:6px;padding:0 12px 8px}.ms-tabs a{padding:5px 12px;border-radius:999px;color:var(--text-muted,#8a8a93);font-size:13px;text-decoration:none}.ms-tabs a[aria-selected="true"]{background:var(--accent-soft,rgba(139,108,246,.1));color:var(--accent-text,#b39dfa);font-weight:600}
.ms-row{display:flex;gap:12px;padding:12px 16px;color:inherit;text-decoration:none;align-items:flex-start}.ms-row:hover{background:var(--bg-raised,#232327);text-decoration:none}.ms-row.is-on{background:var(--bg-raised,#232327)}
.ms-row-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.ms-row-top{display:flex;justify-content:space-between;gap:8px}.ms-row-top b{color:var(--text-strong,#f2f2f5);font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ms-row.is-unread .ms-row-top b{font-weight:600}
.ms-row-top time{font-size:12px;color:var(--text-muted,#8a8a93);flex:none}.ms-row-last{font-size:13.5px;color:var(--text-muted,#8a8a93);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ms-row.is-unread .ms-row-last{color:var(--text,#dadadf)}
.ms-dot{width:9px;height:9px;margin-top:7px;flex:none;border-radius:999px;background:var(--accent,#8b6cf6)}
.ms-av{flex:none;border-radius:999px;object-fit:cover;background:#3a2f66}.ms-ini{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:600}
.ms-pref{display:flex;gap:8px;align-items:center;margin-top:auto;padding:16px;font-size:13px;color:var(--text-muted,#8a8a93)}
.ms-thread{flex:1;min-width:0;display:flex;flex-direction:column}
.ms-th-h{min-height:64px;padding:10px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line,#2a2a2e)}.ms-th-who{display:flex;flex-direction:column;min-width:0}.ms-th-who b{color:var(--text-strong,#f2f2f5)}.ms-th-who a{font:400 12.5px var(--font-mono,'IBM Plex Mono',monospace)}
.ms-grow{flex:1}.ms-back{display:none;width:40px;height:40px;align-items:center;justify-content:center;color:var(--text-strong,#f2f2f5)}
.ms-more{position:relative}.ms-more>summary{list-style:none;cursor:pointer;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--line,#2a2a2e);color:var(--text-muted,#8a8a93);font-size:18px}.ms-more>summary::-webkit-details-marker{display:none}
.ms-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:5;min-width:200px;display:flex;flex-direction:column;padding:6px;background:var(--bg-raised,#232327);border:1px solid var(--line-strong,#3a3a40);border-radius:var(--radius-md,8px)}
.ms-menu a,.ms-menu button{all:unset;cursor:pointer;padding:8px 10px;border-radius:6px;color:var(--text,#dadadf);font-size:14px}.ms-menu a:hover,.ms-menu button:hover{background:var(--bg,#1c1c1f)}.danger,.ms-menu .danger{color:var(--danger,#f0716a)!important}
.ms-msgs{flex:1;padding:20px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:calc(100vh - 300px);min-height:280px}
.ms-b{max-width:min(520px,80%);padding:10px 14px;font-size:15px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}.ms-b.them{align-self:flex-start;border-radius:18px 18px 18px 6px;background:var(--bg-raised,#232327);color:var(--text,#dadadf)}
.ms-b.me{align-self:flex-end;border-radius:18px 18px 6px 18px;background:#7a58f0;color:#fff}.ms-b.me a{color:#fff;text-decoration:underline}.ms-b.sending{opacity:.6}
.ms-compose{display:flex;gap:10px;align-items:flex-end;padding:12px 20px 8px;border-top:1px solid var(--line,#2a2a2e)}
.ms-compose textarea{flex:1;resize:none;min-height:46px;max-height:180px;padding:11px 14px;border-radius:14px;border:1px solid var(--line-strong,#3a3a40);background:var(--bg-raised,#232327);color:var(--text-strong,#f2f2f5);font:15px/1.5 var(--font-body,'IBM Plex Sans',Arial,sans-serif)}
.ms-compose textarea:focus{outline:2px solid var(--accent,#8b6cf6);outline-offset:1px}
.ms-btn{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 22px;border:0;border-radius:999px;background:#7a58f0;color:#fff;font:600 15px var(--font-body,'IBM Plex Sans',Arial,sans-serif);cursor:pointer;text-decoration:none;white-space:nowrap}
.ms-btn:hover{filter:brightness(1.08);text-decoration:none}.ms-btn.ghost{background:transparent;border:1px solid var(--line-strong,#3a3a40);color:var(--text-strong,#f2f2f5)}.ms-btn.small{height:30px;padding:0 14px;font-size:13.5px}.ms-btn:focus-visible,.ms-link:focus-visible{outline:2px solid var(--accent,#8b6cf6);outline-offset:2px}
.ms-link{all:unset;cursor:pointer;padding:8px 10px;font:600 14px var(--font-body,Arial,sans-serif);color:var(--text-muted,#8a8a93)}
.ms-note,.ms-wait{margin:0 20px 14px;font-size:12px;color:var(--text-muted,#8a8a93)}.ms-wait{font-size:13.5px;color:var(--text,#dadadf)}
.ms-empty{margin:auto;max-width:420px;padding:24px;border:1px dashed var(--line-strong,#3a3a40);border-radius:var(--radius-lg,14px);text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center}.ms-empty b{color:var(--text-strong,#f2f2f5)}.ms-empty span{font-size:13.5px;color:var(--text-muted,#8a8a93)}
.ms-list .ms-empty{margin:12px 16px}
.ms-req{margin:auto;width:min(560px,100%);padding:24px;border-radius:var(--radius-lg,14px);background:var(--bg-raised,#232327);border:1px solid var(--line,#2a2a2e);display:flex;flex-direction:column;gap:14px}
.ms-req-who{display:flex;gap:12px;align-items:center}.ms-req-who>span{display:flex;flex-direction:column}.ms-req-who b{color:var(--text-strong,#f2f2f5);font-size:17px}.ms-req-msgs{display:flex;flex-direction:column;gap:8px}.ms-req .ms-b.them{background:var(--bg,#1c1c1f)}
.ms-row-btns{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.ms-row-btns .ms-btn{height:38px;font-size:14px}
.ms-tip{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9;padding:9px 14px;border-radius:10px;background:#18171D;border:1px solid #2E2A40;color:#E6E6EA;font-size:13.5px}
@media (max-width:760px){.ms{padding:0;min-height:calc(100vh - 120px)}.ms-list{width:100%;border-right:0}.ms.is-thread .ms-list,.ms.is-list .ms-none{display:none}.ms-back{display:inline-flex}.hide-sm{display:none}
.ms-th-h{padding:8px 8px 8px 4px}.ms-msgs{padding:16px;max-height:none}.ms-compose{padding:10px 12px 8px}.ms-note,.ms-wait{margin:0 12px 12px}.ms-b{max-width:85%}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;

const JS = `(function(){var T=document.querySelector('.ms-thread[data-h]');var box=document.getElementById('ms-msgs');
function tip(m){var t=document.createElement('div');t.className='ms-tip';t.setAttribute('role','status');t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},3200)}
function post(u,o){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(o||{})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera. Check your connection.'}}})}
var pref=document.getElementById('ms-email');if(pref)pref.addEventListener('change',function(){post('/v1/messages/prefs',{email:pref.checked}).then(function(x){tip(x.ok?(pref.checked?'You\\'ll get an email when someone messages you.':'No more emails about messages.'):'Could not save that.')})});
if(!T)return;var h=T.getAttribute('data-h'),id=T.getAttribute('data-id');if(box)box.scrollTop=box.scrollHeight;
var last=(function(){var b=box&&box.querySelectorAll('.ms-b[data-ts]');return b&&b.length?b[b.length-1].getAttribute('data-ts'):''})();
var F=document.getElementById('ms-form'),ta=document.getElementById('ms-text');
function add(m){var e=box.querySelector('.ms-empty');if(e)e.remove();var d=document.createElement('div');d.className='ms-b '+(m.mine?'me':'them');d.innerHTML=m.html;if(m.ts){d.setAttribute('data-ts',m.ts);last=m.ts}box.appendChild(d);box.scrollTop=box.scrollHeight;return d}
if(F&&ta){ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();F.requestSubmit?F.requestSubmit():F.dispatchEvent(new Event('submit',{cancelable:true}))}});
ta.addEventListener('input',function(){ta.style.height='auto';ta.style.height=Math.min(180,ta.scrollHeight)+'px'});ta.focus();
F.addEventListener('submit',function(e){e.preventDefault();var v=ta.value.trim();if(!v)return;var btn=F.querySelector('button');btn.disabled=true;
post('/v1/messages/send',{to:h,text:v}).then(function(x){btn.disabled=false;if(!x.ok){tip(x.j.error||'Could not send that.');return}ta.value='';ta.style.height='';add(x.j.message);
if(x.j.state==='requested'){F.hidden=true;var w=document.createElement('p');w.className='ms-wait';w.textContent='Request sent. You can send more once @'+h+' accepts.';F.after(w);tip('Request sent to @'+h+'.')}})})}
document.querySelectorAll('[data-act]').forEach(function(b){b.addEventListener('click',function(){var a=b.getAttribute('data-act');if(!id)return;
if((a==='block'||a==='delete')&&!b.getAttribute('data-sure')){b.setAttribute('data-sure','1');var l=b.textContent;b.textContent=a==='block'?'Tap again to block':'Tap again to delete for both of you';setTimeout(function(){b.removeAttribute('data-sure');b.textContent=l},4000);return}
var reason='';post('/v1/messages/'+id+'/'+a,{reason:reason}).then(function(x){if(!x.ok){tip(x.j.error||'Could not do that.');return}
if(a==='report'){tip('Reported. Thanks, we\\'ll take a look.');return}if(a==='delete'){location.href='/messages';return}location.reload()})})});
if(id&&box&&(T.getAttribute('data-state')==='open'||T.getAttribute('data-state')==='pending')){setInterval(function(){if(document.hidden)return;fetch('/v1/messages/thread/'+h+(last?'?after='+encodeURIComponent(last):''),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;
(j.messages||[]).forEach(function(m){if(!m.mine)add(m);else last=m.ts});if(j.state==='open'&&T.getAttribute('data-state')==='pending')location.reload()}).catch(function(){})},8000)}})();`;
