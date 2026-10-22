/**
 * Opt-in daily summary emails.
 *
 * - Double opt-in: an address is only used after its owner clicks the confirmation link we send to it.
 * - Addresses are sealed at rest (AES-GCM, the hub's private key) and never appear on a page or a public API.
 * - Every email carries a one-click unsubscribe (link + List-Unsubscribe / List-Unsubscribe-Post headers). Unsubscribing
 *   puts the address on a suppression list (stored as a hash) that only a fresh, confirmed opt-in lifts.
 * - The digest only goes out when something happened; a quiet "people you might know" email at most once a week.
 */
import crypto from "node:crypto";

/** `src` = which email this is (e.g. "email-digest"): every link back to our own site gets ?src=<it> so visits from email are attributable */
import type { NewsItem } from "./news";
export interface Mail { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; src?: string }
export interface DigestData {
  handle: string; name: string; hosted: boolean;
  views24: number; visitors24: number; views7: number; visitors7: number;
  requests: { handle: string; name: string; note: string; why?: string }[]; friends: { handle: string; name: string; kind?: string; why?: string; joined?: boolean }[];
  /** from the vault (journal entries + notes edited since the last email) and the city (commits this week) */
  vault?: { journal: number; notes: number }; cityCommits?: number;
  /** the ONE most valuable missing piece of setup, with the exact place to do it */
  setup?: { label: string; why: string; how: string; url: string };
  gravity: { handle: string; reason: string }[]; links: number; invited: { handle: string }[]; credits: number;
  suggestions: { handle: string; name: string; why: string; joined?: boolean }[]; newMembers: { handle: string; name: string }[];
  /** days since a vault-published page last updated (3+), takes the place of the finish-your-page step */
  stale?: number;
  /** kudos received since the last email, and the page's all-time views (one per visitor per day) */
  kudos?: { handle: string; name: string; emoji: string }[]; viewsAll?: number;
  /** members who asked to meet you (double opt-in introductions waiting for your answer) */
  intros?: { handle: string; name: string; tag: string }[];
  /** the one "finish your page" step to suggest, if any */
  nudge?: { label: string; why: string; how: string; url: string };
  /** alerts from Caldera posted since the last email that this member hasn't read */
  alerts?: { title: string; url: string }[];
  /** the feed: kudos on their posts, posts sent to them (or offers to help on theirs), asks that fit them, recommendations for people like them */
  postKudos?: { handle: string; name: string; emoji: string; url: string }[];
  postWaiting?: { handle: string; name: string; text: string; kind: string; url: string }[];
  lookingFor?: { handle: string; name: string; sentence: string; why: string; url: string }[];
  recommends?: { handle: string; name: string; sentence: string; why: string; link: string; url: string }[];
  /** unread direct messages (who from, how many, a 120-character preview); absent when the member turned these emails off */
  messages?: { unread: number; from: { handle: string; name: string; count: number; preview: string; request: boolean }[]; url: string };
  /** what happened on Caldera since the last email (the same for everyone), and the day's AI news */
  network?: Network; news?: NewsItem[];
  /** false when nothing happened to this member personally (the subject then leads with the network) */
  personal?: boolean;
}
export interface Network {
  joinedNew: number; joinedWeek: number; members: { handle: string; name: string; headline: string }[];
  cities: number; citiesNew: number; newCities: { handle: string; url: string }[];
  tools: { name: string; pitch: string; platforms: string[]; url: string; by: string }[]; toolsNew: number;
  boards: { group: string; groupName: string; by: string; text: string; replies: number; url: string }[];
  posts: { by: string; text: string; tags: string[]; comments: number; url: string }[];
}
export interface EmailCtx {
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string; hub: string;
  /** the hub's private key, for hashing addresses on the suppression list */
  pepper: Buffer;
  send?: (m: Mail) => Promise<void>; resendKey?: string; from?: string; replyTo?: string;
  digest: (owner: string, since: string) => DigestData | null;
  /** the network half of the daily email, and the day's AI news (left out when absent, e.g. in tests) */
  network?: (owner: string, since: string) => Network; news?: () => Promise<NewsItem[]>;
  /** open-core hooks: is today worth an email, and its subject line (the hub passes its loaded extensions) */
  rank?: { active(d: DigestData): boolean; subject(d: DigestData): string };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ascii = (s: string) => s.normalize("NFKD").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\n\x20-\x7e]/g, "");
const DAY = 86_400_000;

/** Attribution: add src=<kind> to every link back to the hub in an email (HTML hrefs and plain-text URLs). One-time and
 *  account links (unsubscribe, confirm, sign-in, /v1 API) and legal pages are left alone; other sites are never touched. */
const NO_TAG = /^\/(v1\/|start\/confirm|signin|auth\/|privacy|terms)/;
export function tagLinks(body: string, hub: string, src: string, html: boolean): string {
  if (!src) return body;
  const base = hub.replace(/\/$/, ""), re = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/[^\\s\"'<>()\\]]*|(?![\\w.-]))", "g");
  return body.replace(re, (whole: string, path = "") => {
    const trail = /[.,;:!?]+$/.exec(path)?.[0] || "", p0 = path.slice(0, path.length - trail.length) || "/";
    if (NO_TAG.test(p0) || /[?&](amp;)?src=/.test(p0)) return whole;
    const hashAt = p0.indexOf("#"), pathq = hashAt < 0 ? p0 : p0.slice(0, hashAt), hash = hashAt < 0 ? "" : p0.slice(hashAt);
    return base + pathq + (pathq.includes("?") ? (html ? "&amp;" : "&") : "?") + "src=" + encodeURIComponent(src) + hash + trail;
  });
}
// addresses we never mail: reserved/test domains, throwaway inboxes, and common typos of real providers
const BAD_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|mailinator\.com|guerrillamail\.com|10minutemail\.com|tempmail\.com|yopmail\.com|trashmail\.com)$/i;
const TYPO_DOMAIN = /^(gmial|gmai|gamil|gnail|gmaill|gmail\.co|gmail\.cm|gmail\.con|hotmial|hotmal|yaho|yahooo|outlok|iclod|icoud)(\.|$)/i;

export function validEmail(e: string): string | null {
  const m = e.trim().toLowerCase();
  if (m.length > 200 || !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(m)) return "That doesn't look like an email address.";
  const domain = m.split("@")[1]!;
  if (BAD_DOMAIN.test(domain)) return "Please use a real inbox (test and throwaway domains aren't mailed).";
  if (TYPO_DOMAIN.test(domain) || /\.(con|cmo|cm|comm)$/.test(domain)) return `Check the domain: "${domain}" looks like a typo.`;
  return null;
}

export function emailer(ctx: EmailCtx) {
  const rank = ctx.rank || { active: (d: DigestData) => !!(d.visitors24 || d.requests.length || d.friends.length), subject: () => "Caldera: your daily summary" };
  const { q } = ctx, hub = ctx.hub.replace(/\/$/, "");
  q(`CREATE TABLE IF NOT EXISTS email_subs (owner TEXT PRIMARY KEY, email TEXT, hash TEXT, confirmed INTEGER, token TEXT, created TEXT,
      last_sent TEXT, last_quiet TEXT, last_links INTEGER, confirm_sent INTEGER)`).run();
  q("CREATE TABLE IF NOT EXISTS email_suppress (hash TEXT PRIMARY KEY, reason TEXT, ts TEXT)").run();
  q("CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v TEXT)").run();
  const hashOf = (e: string) => crypto.createHmac("sha256", ctx.pepper).update("email:" + e.trim().toLowerCase()).digest("hex");
  const row = (owner: string) => q("SELECT * FROM email_subs WHERE owner=?").get(owner) as any;
  const addr = (r: any) => { try { return ctx.unseal(r.email); } catch { return ""; } };
  const unsubUrl = (t: string) => `${hub}/v1/email/unsub?t=${t}`;
  // A suggested summary address per member: GitHub's primary VERIFIED email (needs the app's "Email addresses" permission)
  // or their public profile email. Sealed at rest; used only to prefill the opt-in and, once they opt in, for the summary.
  q("CREATE TABLE IF NOT EXISTS email_suggest (owner TEXT PRIMARY KEY, email TEXT, hash TEXT, verified INTEGER, source TEXT, ts TEXT)").run();
  q("CREATE TABLE IF NOT EXISTS email_prompt (owner TEXT PRIMARY KEY, dismissed TEXT)").run();
  function suggest(owner: string, email: string, verified: boolean, source: string) {
    if (!email || validEmail(email)) return;
    const e = email.trim().toLowerCase(), cur = q("SELECT verified, hash FROM email_suggest WHERE owner=?").get(owner) as any;
    if (cur && cur.verified && !verified) return;   // a verified address is never replaced by an unverified guess
    q("INSERT OR REPLACE INTO email_suggest VALUES (?,?,?,?,?,?)").run(owner, ctx.seal(e), hashOf(e), verified ? 1 : 0, source.slice(0, 40), new Date().toISOString());
    // got it: the "Confirm your email" nudge has done its job, so it disappears from their bell
    if (verified) try { q("DELETE FROM alert_reads WHERE alert_id IN (SELECT id FROM alerts WHERE target=? AND dkey='email-confirm')").run(owner); q("DELETE FROM alerts WHERE target=? AND dkey='email-confirm'").run(owner); } catch { /* no alerts table yet */ }
  }
  function suggestion(owner: string): { email: string; verified: boolean } | null {
    const r = q("SELECT * FROM email_suggest WHERE owner=?").get(owner) as any; if (!r) return null;
    try { return { email: ctx.unseal(r.email), verified: !!r.verified }; } catch { return null; }
  }
  /** Show the "get your daily summary" prompt? Not once they're subscribed (or have a confirmation pending), or dismissed it. */
  const promptFor = (owner: string) => { const r = row(owner); if (r && (r.confirmed || r.confirm_sent > Date.now() - 7 * DAY)) return null;
    if (q("SELECT 1 FROM email_prompt WHERE owner=? AND dismissed IS NOT NULL").get(owner)) return null; return { suggestion: suggestion(owner) }; };
  const dismissPrompt = (owner: string) => q("INSERT OR REPLACE INTO email_prompt VALUES (?,?)").run(owner, new Date().toISOString());

  async function send(m0: Mail) {
    const m: Mail = m0.src ? { ...m0, html: tagLinks(m0.html, hub, m0.src, true), text: tagLinks(m0.text, hub, m0.src, false) } : m0;
    if (ctx.send) return ctx.send(m);
    if (!ctx.resendKey) throw new Error("email is not set up on this hub");
    // Resend allows 10 requests a second: sends go out one at a time at most ~8 a second, and a 429 waits and retries
    const turn = sendChain.then(async () => {
      const wait = lastSend + 125 - Date.now(); if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        lastSend = Date.now();
        const r = await fetch("https://api.resend.com/emails", { method: "POST",
          headers: { authorization: "Bearer " + ctx.resendKey, "content-type": "application/json", "user-agent": "Mozilla/5.0 (caldera-hub)" },
          body: JSON.stringify({ from: ctx.from || "Caldera <hello@caldera.social>", reply_to: ctx.replyTo || "hello@caldera.social", to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers }) });
        if (r.ok) return;
        if (r.status === 429 && attempt < 4) { await sleep(Math.max(1000 * (Number(r.headers.get("retry-after")) || 0), 500 * 2 ** attempt)); continue; }
        throw new Error(`email send failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
      }
    });
    sendChain = turn.catch(() => {});
    return turn;
  }
  let sendChain: Promise<void> = Promise.resolve(), lastSend = 0;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const shell = (title: string, inner: string, unsub?: string) => `<!doctype html><html><body style="margin:0;background:#F4F3F8;padding:24px 12px;font:15px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#24222B">
<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E4E1EE;border-radius:12px;overflow:hidden">
<div style="padding:16px 22px;background:#111113;color:#F2F2F5;font:600 16px Georgia,serif">Caldera</div>
<div style="padding:22px">${title ? `<h1 style="margin:0 0 12px;font:600 21px/1.3 Georgia,serif;color:#111113">${title}</h1>` : ""}${inner}</div></div>
${unsub ? `<p style="max-width:560px;margin:14px auto 0;color:#8A8794;font-size:12px;text-align:center">You get this because you asked for a daily Caldera summary. <a href="${esc(unsub)}" style="color:#6E4FE0">Unsubscribe</a> in one click.</p>` : ""}<p style="max-width:560px;margin:8px auto 0;color:#8A8794;font-size:11.5px;text-align:center">Caldera is run by mjonesone, LLC &middot; <a href="${hub}/privacy" style="color:#8A8794">Privacy</a> &middot; <a href="${hub}/terms" style="color:#8A8794">Terms</a></p></body></html>`;

  /** Start (or restart) a subscription: stores the address sealed and mails a confirmation link. Returns a message for the owner. */
  async function subscribe(owner: string, email: string): Promise<string> {
    const bad = validEmail(email); if (bad) throw new Error(bad);
    const e = email.trim().toLowerCase(), h = hashOf(e), cur = row(owner);
    if (cur && cur.hash === h && cur.confirmed) return `Daily summaries already go to ${e}.`;
    if (cur && cur.hash === h && cur.confirm_sent > Date.now() - 10 * 60_000) return `A confirmation link is on its way to ${e}. Check your inbox (and spam).`;
    const token = crypto.randomBytes(18).toString("base64url");
    // GitHub already verified this exact address for this member: their click is the opt-in, no confirmation email needed
    if (q("SELECT 1 FROM email_suggest WHERE owner=? AND hash=? AND verified=1").get(owner, h)) {
      q(`INSERT INTO email_subs (owner, email, hash, confirmed, token, created, last_sent, last_quiet, last_links, confirm_sent) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(owner) DO UPDATE SET email=excluded.email, hash=excluded.hash, confirmed=1, token=excluded.token, confirm_sent=excluded.confirm_sent`)
        .run(owner, ctx.seal(e), h, 1, token, new Date().toISOString(), null, null, null, null);
      q("DELETE FROM email_suppress WHERE hash=?").run(h);   // a fresh opt-in lifts an old unsubscribe
      return `Daily summaries will go to ${e}. GitHub already verified it, so there's nothing to confirm.`;
    }
    q(`INSERT INTO email_subs (owner, email, hash, confirmed, token, created, last_sent, last_quiet, last_links, confirm_sent) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(owner) DO UPDATE SET email=excluded.email, hash=excluded.hash, confirmed=0, token=excluded.token, confirm_sent=excluded.confirm_sent`)
      .run(owner, ctx.seal(e), h, 0, token, new Date().toISOString(), null, null, null, Date.now());
    const link = `${hub}/v1/email/confirm?t=${token}`;
    await send({ to: e, subject: "Confirm your daily Caldera summary",
      html: shell("Confirm your email", `<p>Someone (hopefully you) asked for a daily Caldera summary at this address: who visited your page, kudos and new followers, people to meet, and a nudge when your page needs attention.</p><p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">Yes, send me summaries</a></p><p style="color:#8A8794;font-size:13px">If this wasn't you, ignore this email and nothing will be sent.</p>`),
      text: `Confirm your daily Caldera summary:\n${link}\n\nIf this wasn't you, ignore this email and nothing will be sent.` });
    return `Check ${e} for a confirmation link. Summaries start once you click it.`;
  }
  function confirm(token: string): boolean {
    const r = q("SELECT * FROM email_subs WHERE token=?").get(String(token || "")) as any; if (!r) return false;
    q("UPDATE email_subs SET confirmed=1 WHERE owner=?").run(r.owner);
    q("DELETE FROM email_suppress WHERE hash=?").run(r.hash);   // a fresh, confirmed opt-in lifts an old unsubscribe
    return true;
  }
  function unsubToken(token: string): boolean {
    const r = q("SELECT * FROM email_subs WHERE token=?").get(String(token || "")) as any; if (!r) return false;
    q("INSERT OR REPLACE INTO email_suppress VALUES (?,?,?)").run(r.hash, "unsubscribed", new Date().toISOString());
    q("DELETE FROM email_subs WHERE owner=?").run(r.owner); return true;
  }
  function unsubscribe(owner: string) { const r = row(owner); if (r) unsubToken(r.token); }
  const status = (owner: string) => { const r = row(owner); return r ? { email: addr(r), confirmed: !!r.confirmed } : null; };
  const suppressed = (email: string) => !!q("SELECT 1 FROM email_suppress WHERE hash=?").get(hashOf(email));

  // ---------------------------------------------------------------- the digest
  /** The daily email, most important first: kudos, new followers, intros, people to meet, new connections, your page,
   *  then exactly one setup step and any unread alerts. Every section links to the place to act on it. */
  function compose(d: DigestData, unsub: string, quiet: boolean): Mail | null {
    const page = `${hub}/@${d.handle}/`, at = (h: string) => `${hub}/@${encodeURIComponent(h)}/`;
    const pl = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
    const cons = d.friends, net = d.network, news = d.news || [];
    const subject = ascii(d.personal === false && net ? netSubject(d) : rank.subject(d)).replace(/ {2,}/g, " ").replace(/ +$/, "");
    // GitHub-style boxes: a gray header bar (an <h2>) over rows. Tables and inline styles only, so Gmail and Outlook render it.
    const F = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif", M = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";
    const INK = "#1f2328", MUT = "#59636e", LINE = "#d0d7de", ROWL = "#d8dee4", BG = "#f6f8fa", LINK = "#0969da", ACC = "#6e4fe0";
    const H: string[] = [], T: string[] = [];
    const a = (href: string, label: string, bold = false) => `<a href="${esc(href)}" style="color:${LINK};text-decoration:none${bold ? ";font-weight:600" : ""}">${label}</a>`;
    const who = (h: string, n?: string) => `${a(at(h), `@${esc(h)}`, true)}${n && n.toLowerCase() !== h.toLowerCase() ? ` <span style="color:${MUT}">${esc(n)}</span>` : ""}`;
    const btn = (href: string, label: string, kind: "plain" | "green" | "accent" = "plain") => `<a href="${esc(href)}" style="display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;white-space:nowrap;${kind === "green" ? "background:#1f883d;border:1px solid #1a7f37;color:#ffffff" : kind === "accent" ? `background:${ACC};border:1px solid ${ACC};color:#ffffff` : `background:${BG};border:1px solid ${LINE};color:${INK}`}">${esc(label)}</a>`;
    const mut = (s: string) => `<div style="color:${MUT};font-size:13px;margin-top:2px">${s}</div>`;
    const row = (inner: string, action = "", last = false) => `<tr><td style="padding:10px 14px;${last ? "" : `border-bottom:1px solid ${ROWL};`}font-size:14px;line-height:1.45;vertical-align:top">${inner}</td>${action ? `<td style="padding:10px 14px 10px 0;${last ? "" : `border-bottom:1px solid ${ROWL};`}text-align:right;vertical-align:top;white-space:nowrap">${action}</td>` : `<td style="${last ? "" : `border-bottom:1px solid ${ROWL};`}"></td>`}</tr>`;
    const rows = (xs: [string, string?][]) => xs.map((x, i) => row(x[0], x[1] || "", i === xs.length - 1)).join("");
    const box = (title: string, right: string, body: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:6px;border-collapse:separate;margin:0 0 16px">
<tr><td colspan="2" style="background:${BG};padding:8px 14px;border-bottom:1px solid ${LINE};border-radius:6px 6px 0 0;font-size:13px"><h2 style="display:inline;margin:0;font:600 13px ${F};color:${INK}">${title}</h2>${right ? `<span style="float:right;color:${MUT};font-size:12px">${right}</span>` : ""}</td></tr>${body}</table>`;
    const sec = (title: string, right: string, xs: [string, string?][], text: string) => { H.push(box(title, right, rows(xs))); T.push(`${title.replace(/&amp;/g, "&").toUpperCase()}\n${text}`); };
    const pill = (t: string) => `<span style="display:inline-block;margin:4px 4px 0 0;padding:1px 9px;border-radius:999px;background:#ddf4ff;color:#0550ae;font-size:12px">${esc(t)}</span>`;
    const chip = (t: string) => `<span style="display:inline-block;margin:4px 4px 0 0;padding:1px 8px;border:1px solid ${LINE};border-radius:999px;color:${MUT};font-size:12px">${esc(t)}</span>`;

    // Inbox: unread messages (a short preview only; the conversation itself stays on Caldera)
    if (d.messages?.unread) sec("Inbox", pl(d.messages.unread, "unread"), d.messages.from.map(m => [`<span style="color:${ACC}">&#9679;</span> ${who(m.handle, m.name)} <span style="color:${MUT}">&middot; ${m.request ? "wants to message you" : pl(m.count, "message")}</span>${mut(`"${esc(m.preview)}"`)}`, btn(`${hub}/messages/@${encodeURIComponent(m.handle)}`, m.request ? "See request" : "Reply", "accent")] as [string, string]),
      d.messages.from.map(m => `@${m.handle}${m.request ? " wants to message you" : ""}: "${m.preview}" - reply: ${hub}/messages/@${m.handle}`).join("\n"));
    // Notifications: everything that happened to you, one row each
    const N: [string, string?][] = [], NT: string[] = [];
    for (const k of d.kudos || []) { N.push([`${esc(k.emoji)} ${who(k.handle, k.name)} sent you kudos`, btn(at(k.handle), "Send one back")]); NT.push(`@${k.handle} sent you ${k.emoji} - send one back: ${at(k.handle)}`); }
    for (const k of (d.postKudos || []).slice(0, 6)) { N.push([`${esc(k.emoji)} ${who(k.handle, k.name)} on your post`, btn(k.url, "See the post")]); NT.push(`@${k.handle} sent ${k.emoji} on your post: ${k.url}`); }
    for (const r of d.requests) { N.push([`${who(r.handle, r.name)} followed you${r.why ? ` <span style="color:${MUT}">&middot; ${esc(r.why)}</span>` : ""}${r.note ? mut(`"${esc(r.note)}"`) : ""}`, btn(at(r.handle), "Follow back", "green")]); NT.push(`@${r.handle}${r.why ? ` (${r.why})` : ""}${r.note ? `: "${r.note}"` : ""} follows you - follow back: ${at(r.handle)}`); }
    for (const x of d.intros || []) { N.push([`${who(x.handle, x.name)} would like to connect${x.tag ? mut(`also building ${esc(x.tag)}`) : ""}`, `${btn(`${hub}/me/building`, "Accept", "green")} ${btn(at(x.handle), "Their page")}`]); NT.push(`@${x.handle}${x.tag ? ` (also building ${x.tag})` : ""} would like to connect - answer: ${hub}/me/building`); }
    for (const w of (d.postWaiting || []).slice(0, 5)) { N.push([`${esc(w.text)}${mut(w.kind === "help" ? "Accept to connect" : "You match. Accept to connect")}`, btn(w.url, "Answer", "green")]); NT.push(`${w.text} - answer: ${w.url}`); }
    const because = (f: DigestData["friends"][number]) => f.kind === "repo" && f.why ? `you both work on ${f.why}` : f.kind === "github" && f.why ? f.why : f.kind === "intro" ? "you both said yes to an intro" : "";
    for (const f of cons) { const b = because(f); N.push([f.joined ? `${who(f.handle, f.name)} just joined Caldera - you're connected${b ? mut(esc(b)) : ""}` : `You and ${who(f.handle, f.name)} are now ${b ? "connected" : "friends"}${b ? mut(esc(b)) : ""}`, btn(at(f.handle), "Say hi")]);
      NT.push((f.joined ? `@${f.handle} just joined Caldera${b ? ` - you're connected because ${b}` : ""}` : `You and @${f.handle} are now connected${b ? ": " + b : ""}`) + ` - ${at(f.handle)}`); }
    for (const i of d.invited) { N.push([`${who(i.handle)} joined from your invite`, btn(at(i.handle), "Say hi")]); NT.push(`@${i.handle} joined from your invite (${at(i.handle)})`); }
    for (const g of d.gravity) { N.push([`${who(g.handle)} sent you gravity${g.reason ? mut(esc(g.reason)) : ""}`, btn(at(g.handle), "See their page")]); NT.push(`@${g.handle} sent you gravity${g.reason ? ": " + g.reason : ""} - ${at(g.handle)}`); }
    if (N.length) sec("Notifications", pl(N.length, "new item"), N, NT.join("\n"));
    // Picked for you: posts that match you, then the newest feed posts
    const P: [string, string?][] = [], PT: string[] = [], seen = new Set<string>();
    for (const x of d.lookingFor || []) { seen.add(x.url); P.push([`${a(x.url, esc(x.sentence), true)}${mut(`You match: ${esc(x.why)}`)}`, btn(x.url, "See the post")]); PT.push(`${x.sentence} (you match: ${x.why}) ${x.url}`); }
    for (const x of d.recommends || []) { seen.add(x.url); P.push([`${a(x.url, esc(x.sentence), true)}${x.why ? mut(esc(x.why)) : ""}`, btn(x.url, "See why")]); PT.push(`${x.sentence} ${x.url}`); }
    for (const x of net?.posts || []) { if (seen.has(x.url) || P.length >= 4) continue; P.push([`${a(x.url, esc(x.text), true)}${mut(`in Feed${x.comments ? ` &middot; ${pl(x.comments, "comment")}` : ""}`)}${x.tags.length ? `<div>${x.tags.map(pill).join("")}</div>` : ""}`, btn(x.url, "Open")]); PT.push(`${x.text} ${x.url}`); }
    if (P.length) sec("Picked for you", d.lookingFor?.length || d.recommends?.length ? "matches your tags" : "new in the feed", P, PT.join("\n"));
    // Bulletin boards
    if (net?.boards.length) sec("Bulletin boards", "since your last email", net.boards.map(b => [`<span style="font:12px ${M};color:${MUT}">#${esc(b.group)}</span> ${a(b.url, esc(b.text))}${mut(`@${esc(b.by)}`)}`, `<span style="color:${MUT};font-size:12px">${pl(b.replies, "reply", "replies")}</span>`] as [string, string]),
      net.boards.map(b => `#${b.group}: ${b.text} (@${b.by}, ${pl(b.replies, "reply", "replies")}) ${b.url}`).join("\n"));
    // New members
    if (net?.members.length) sec("New members", a(`${hub}/people?sort=new`, `See all ${net.joinedWeek} this week`), net.members.map(m => [`${who(m.handle, m.name)}${m.headline ? mut(esc(m.headline)) : ""}`, btn(at(m.handle), "Say hi")] as [string, string]),
      net.members.map(m => `@${m.handle}${m.headline ? ` - ${m.headline}` : ""}: ${at(m.handle)}`).join("\n") + `\nEveryone new: ${hub}/people?sort=new`);
    // People to meet (picked for you from your repos and tags)
    const met = new Set((net?.members || []).map(m => m.handle));
    const sug = d.suggestions.filter(x => !met.has(x.handle)).slice(0, 3);
    if (sug.length) sec("People to meet", "", sug.map(x => [`${who(x.handle, x.name)}${x.why ? mut(esc(x.why)) : ""}`, btn(at(x.handle), "Follow")] as [string, string]),
      sug.map(x => `@${x.handle}${x.why ? ` (${x.why})` : ""} - follow: ${at(x.handle)}`).join("\n"));
    // New cities | New tools, side by side
    const cityCell = net?.newCities.length ? box("New cities", "", rows(net.newCities.map(c => [`${a(c.url, `@${esc(c.handle)}'s city`, true)}${mut("Their public repos as a living city")}`, btn(c.url, "Walk it")] as [string, string]))) : "";
    const toolCell = net?.tools.length ? box("New tools", "", rows(net.tools.map(t => [`${a(t.url, esc(t.name), true)}${t.pitch ? mut(esc(t.pitch)) : ""}${t.platforms.length ? `<div>${t.platforms.map(chip).join("")}</div>` : ""}`, btn(t.url, "Download", "green")] as [string, string]))) : "";
    if (cityCell || toolCell) {
      H.push(cityCell && toolCell ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="cd-half" width="50%" style="vertical-align:top;padding-right:8px">${cityCell}</td><td class="cd-half" width="50%" style="vertical-align:top;padding-left:8px">${toolCell}</td></tr></table>` : cityCell || toolCell);
      if (net!.newCities.length) T.push(`NEW CITIES\n${net!.newCities.map(c => `@${c.handle}'s city: ${c.url}`).join("\n")}`);
      if (net!.tools.length) T.push(`NEW TOOLS\n${net!.tools.map(t => `${t.name}${t.pitch ? ` - ${t.pitch}` : ""}: ${t.url}`).join("\n")}`);
    }
    // AI & agents today
    if (news.length) sec("AI &amp; agents today", "Hacker News &middot; GitHub &middot; Hugging Face", news.map(n => [`<span style="display:inline-block;width:56px;font:12px ${M};color:${MUT}">${esc(n.src)}</span>${a(n.url, esc(n.title))}${mut(`<span style="display:inline-block;width:56px"></span>${esc(n.meta)}`)}`] as [string]),
      news.map(n => `[${n.src}] ${n.title} (${n.meta}) ${n.url}`).join("\n"));
    // Your page: one stat strip
    const pg: string[] = [], pt: string[] = [];
    const stat = (n: number | string, label: string) => `<span style="display:inline-block;white-space:nowrap;margin-right:14px"><b style="font-family:${M};color:${INK}">${n}</b> ${label}</span>`;
    if (d.views7 || d.visitors24) { pg.push(stat(d.visitors24, "visitors today"), stat(d.visitors7, "this week")); const all = d.viewsAll && d.viewsAll > d.visitors7 ? d.viewsAll : 0; if (all) pg.push(stat(all.toLocaleString("en-US"), "all time")); pt.push(`${d.visitors24} people in the last day, ${d.visitors7} this week${all ? `, ${all} all time` : ""}`); }
    if (d.vault && (d.vault.journal || d.vault.notes)) { pg.push(stat(d.vault.journal, d.vault.journal === 1 ? "journal entry" : "journal entries"), stat(d.vault.notes, d.vault.notes === 1 ? "note edited" : "notes edited")); pt.push(`From your vault: ${pl(d.vault.journal, "journal entry", "journal entries")}, ${pl(d.vault.notes, "note")} edited`); }
    if (d.cityCommits) { pg.push(stat(d.cityCommits.toLocaleString("en-US"), "commits on your city")); pt.push(`Your city: ${pl(d.cityCommits, "commit")} this week`); }
    if (d.links) { pg.push(stat(d.links, d.links === 1 ? "new link in" : "new links in")); pt.push(`${pl(d.links, "new link")} into your page`); }
    if (pg.length) { H.push(box("Your page", `${a(page, "Your page")} &middot; ${a(`${page}city.html`, "your city")}`, `<tr><td colspan="2" style="padding:10px 14px;font-size:13px;color:${MUT};line-height:1.9">${pg.join("")}</td></tr>`)); T.push(`YOUR PAGE\n${pt.join("\n")}\n${page}`); }
    if (!H.length && !d.setup) return null;
    // exactly one setup step (a page that stopped updating comes first)
    const callout = (bg: string, border: string, inner: string) => H.push(`<div style="margin:0 0 16px;padding:12px 14px;border:1px solid ${border};border-radius:6px;background:${bg};font-size:14px;color:${INK}">${inner}</div>`);
    if (d.stale) { callout("#fff8c5", "#d4a72c66", `<b>Your page last updated ${d.stale} days ago</b> - open Obsidian to refresh it. Your page updates itself while Obsidian is open. <a href="obsidian://caldera" style="color:${LINK}">Open Obsidian</a> &middot; <a href="${esc(page)}" style="color:${LINK}">See your page</a>`);
      T.push(`Your page last updated ${d.stale} days ago - open Obsidian to refresh it. Your page: ${page}`); }
    else if (d.setup) { callout("#f5f0ff", "#c8b8f5", `<b>Next for your page: ${esc(d.setup.label)}.</b> ${esc(d.setup.why)}<div style="margin-top:8px">${btn(d.setup.url, d.setup.how, "accent")}</div>`);
      T.push(`NEXT FOR YOUR PAGE: ${d.setup.label}. ${d.setup.why} ${d.setup.how}: ${d.setup.url}`); }
    else if (d.nudge) { callout("#f5f0ff", "#c8b8f5", `<b>Finish your page: ${esc(d.nudge.label)}.</b> ${esc(d.nudge.why)} <a href="${esc(d.nudge.url)}" style="color:${LINK}">${esc(d.nudge.how)}</a>`);
      T.push(`FINISH YOUR PAGE: ${d.nudge.label}. ${d.nudge.why} ${d.nudge.how}: ${d.nudge.url}`); }
    if (d.alerts?.length) { H.push(`<p style="margin:0 0 16px;font-size:13px;color:${MUT}"><b style="color:${INK}">From Caldera:</b> ${d.alerts.map(x => a(x.url, esc(x.title))).join(" &middot; ")}</p>`);
      T.push(`FROM CALDERA\n${d.alerts.map(x => `${x.title}: ${x.url}`).join("\n")}`); }
    const invite = `${hub}/?invite=${encodeURIComponent(d.handle)}`;
    T.push(`Bring a friend: ${invite}`);
    // header: breadcrumb + the four numbers that matter today
    const day = new Date().toISOString().slice(0, 10), unread = d.messages?.unread || 0;
    const tile = (n: string, label: string, color: string, last = false) => `<td class="cd-tile" width="25%" style="padding:12px 14px;${last ? "" : `border-right:1px solid ${LINE};`}vertical-align:top"><div style="font:700 22px/1.2 ${M};color:${color}">${n}</div><div style="font-size:12px;color:${MUT}">${label}</div></td>`;
    const tiles = net ? `<tr><td style="padding:0;border-bottom:1px solid ${LINE}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tile(String(unread), "unread messages", unread ? ACC : INK)}${tile(`+${net.joinedNew}`, `joined &middot; ${net.joinedWeek} this week`, INK)}${tile(String(net.cities), net.citiesNew ? `cities &middot; +${net.citiesNew} new` : "cities on the map", INK)}${tile(String(net.toolsNew || net.tools.length), net.toolsNew ? (net.toolsNew === 1 ? "new tool" : "new tools") : "tools this week", net.tools.length ? "#1a7f37" : INK, true)}</tr></table></td></tr>` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media (max-width:520px){.cd-tile{display:inline-block!important;width:50%!important;box-sizing:border-box;border-right:0!important;border-bottom:1px solid #d0d7de}.cd-half{display:block!important;width:100%!important;padding:0!important}.cd-pad{padding-left:12px!important;padding-right:12px!important}}a{word-break:break-word}</style></head><body style="margin:0;background:${BG};padding:20px 10px;font:14px/1.5 ${F};color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:6px;border-collapse:separate;text-align:left">
<tr><td style="padding:14px 20px;border-bottom:1px solid ${LINE}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font:14px ${M};color:${INK}"><span style="display:inline-block;width:24px;height:24px;line-height:24px;border-radius:6px;background:${ACC};color:#fff;text-align:center;font-weight:700;margin-right:8px">C</span><span style="color:${MUT}">caldera /</span> <b>${quiet ? "weekly" : "daily"}</b> <span style="color:${MUT}">/ ${day}</span></td><td style="text-align:right">${btn(page, "Open Caldera")}</td></tr></table></td></tr>
${tiles}<tr><td class="cd-pad" style="padding:16px 20px 0">${H.join("\n")}</td></tr>
<tr><td style="padding:12px 20px;border-top:1px solid ${LINE};background:${BG};border-radius:0 0 6px 6px;font-size:12px;color:${MUT}">Bring a friend: <a href="${esc(invite)}" style="color:${LINK}">${esc(invite.replace(/^https?:\/\//, ""))}</a><span style="float:right"><a href="${esc(unsub)}" style="color:${MUT}">Unsubscribe</a></span></td></tr>
</table>
<p style="max-width:640px;margin:12px auto 0;color:${MUT};font-size:11.5px;text-align:center">You get this because you signed up for the Caldera Daily. <a href="${esc(unsub)}" style="color:${MUT}">Unsubscribe</a> in one click. Caldera is run by mjonesone, LLC &middot; <a href="${hub}/privacy" style="color:${MUT}">Privacy</a> &middot; <a href="${hub}/terms" style="color:${MUT}">Terms</a></p>
</td></tr></table></body></html>`;
    return { to: "", subject, html, text: ascii(`${T.join("\n\n")}\n\n--\nUnsubscribe in one click: ${unsub}\nCaldera is run by mjonesone, LLC. Privacy: ${hub}/privacy`), src: quiet ? "email-weekly" : "email-digest",
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }
  /** Subject on a day with nothing personal: what happened on Caldera, then the top AI story. */
  function netSubject(d: DigestData): string {
    const n = d.network!, pl = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`, bits: string[] = [];
    if (n.joinedNew) bits.push(`${pl(n.joinedNew, "new member")}`);
    if (n.toolsNew) bits.push(`${pl(n.toolsNew, "new tool")}`);
    if (n.boards.length) bits.push(`${pl(n.boards.length, "board post")}`);
    if (n.posts.length) bits.push(`${pl(n.posts.length, "feed post")}`);
    const top = d.news?.find(x => x.src === "HN");
    return `Caldera Daily: ${bits.length ? bits.join(", ") : "today in AI and agents"}${top ? ` | ${top.title.slice(0, 70)}` : ""}`;
  }

  /** One pass over every confirmed subscriber. `force` ignores the once-a-day guard (tests, manual runs). */
  async function runDigest(force = false): Promise<{ sent: number; skipped: number; errors: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const last = (q("SELECT v FROM hub_meta WHERE k='digest_last'").get() as any)?.v;
    if (!force && last === today) return { sent: 0, skipped: 0, errors: 0 };
    q("INSERT OR REPLACE INTO hub_meta VALUES ('digest_last', ?)").run(today);
    let sent = 0, skipped = 0, errors = 0;
    const news = ctx.news ? await ctx.news().catch((e: any) => { console.error("digest news", e?.message); return []; }) : [];
    for (const r of q("SELECT * FROM email_subs WHERE confirmed=1").all() as any[]) {
      const to = addr(r); if (!to || suppressed(to)) { skipped++; continue; }
      const since = r.last_sent || new Date(Date.now() - DAY).toISOString();
      const d = ctx.digest(r.owner, since); if (!d) { skipped++; continue; }
      // links into the garden have no timestamp: compare with the count at the last send
      const newLinks = r.last_links == null ? 0 : Math.max(0, d.links - r.last_links), totalLinks = d.links; d.links = newLinks;
      const personal = rank.active(d);
      if (ctx.network) { d.network = ctx.network(r.owner, since); d.news = news; d.personal = personal; }
      // the network counts too: someone joined, a new tool, a board or feed post since the last email
      const n = d.network, active = personal || !!(n && (n.joinedNew || n.toolsNew || n.boards.length || n.posts.length));
      const quietOk = !r.last_quiet || Date.parse(r.last_quiet) < Date.now() - 7 * DAY;   // people to meet / one setup step alone: at most weekly
      if (!active && !(quietOk && (d.suggestions.length || d.newMembers.length || d.setup || d.nudge))) { skipped++; q("UPDATE email_subs SET last_links=? WHERE owner=?").run(totalLinks, r.owner); continue; }
      const m = compose(d, unsubUrl(r.token), !active); if (!m) { skipped++; continue; }
      try {
        await send({ ...m, to });
        q("UPDATE email_subs SET last_sent=?, last_links=?, last_quiet=COALESCE(?, last_quiet) WHERE owner=?").run(new Date().toISOString(), totalLinks, active ? null : new Date().toISOString(), r.owner);
        sent++;
      } catch (e: any) { errors++; console.error("digest", r.owner, e?.message); }
    }
    return { sent, skipped, errors };
  }
  /** Daily at ~15:00 UTC; after a restart it catches up the same day. */
  function schedule() {
    const tick = () => { if (new Date().getUTCHours() >= 15) runDigest().then(r => { if (r.sent || r.errors) console.log("digest", JSON.stringify(r)); }).catch(e => console.error("digest", e?.message)); };
    const t = setInterval(tick, 10 * 60_000); t.unref?.(); setTimeout(tick, 30_000).unref?.();
  }

  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - Caldera</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"></head><body><main style="max-width:560px;margin:0 auto;padding:48px 16px"><h1 style="font-family:'Source Serif 4',Georgia,serif">${esc(title)}</h1>${body}<p><a href="/">caldera.social</a></p></main></body></html>`;
  /** Is `email` this owner's confirmed summary address? (Owner sign-in by email uses only confirmed addresses.) */
  const matches = (owner: string, email: string) => { const r = row(owner); return !!r && !!r.confirmed && r.hash === hashOf(email) && !suppressed(email); };
  const hasConfirmed = (owner: string) => { const r = row(owner); return !!r && !!r.confirmed; };
  /** One-time owner sign-in link, to the owner's confirmed address only. */
  async function sendSignin(owner: string, handle: string, link: string) {
    const r = row(owner); if (!r || !r.confirmed) return; const to = addr(r); if (!to) return;
    await send({ to, subject: ascii(`Sign in to your Caldera page (@${handle})`),
      html: shell("Sign in on this device", `<p>Someone (hopefully you) asked to sign in as the owner of <b>@${esc(handle)}</b> on caldera.social. The link works once, for 15 minutes.</p><p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">Sign in</a></p><p style="color:#8A8794;font-size:13px">Open it on the phone or computer you want to sign in. If this wasn't you, ignore this email: nothing changes until the link is used.</p>`),
      text: `Sign in as the owner of @${handle} on caldera.social (works once, for 15 minutes):\n${link}\n\nIf this wasn't you, ignore this email.` });
  }

  // ---- invites to GitHub people who aren't on Caldera yet: member-initiated only, to a PUBLIC GitHub profile email, never
  // stored (only a hash, for caps and unsubscribes). 10 per inviter per day; one per recipient per 30 days across everyone.
  q("CREATE TABLE IF NOT EXISTS invites_sent (id TEXT PRIMARY KEY, inviter TEXT, login TEXT, hash TEXT, ts TEXT)").run();
  const INVITES_PER_DAY = 10;
  function inviteBlock(inviter: string, login: string, email: string): string | null {
    const bad = validEmail(email); if (bad) return "That GitHub profile's email can't be mailed.";
    if (suppressed(email)) return `@${login} asked not to get Caldera emails.`;
    const day = new Date(Date.now() - DAY).toISOString(), month = new Date(Date.now() - 30 * DAY).toISOString(), h = hashOf(email);
    if ((q("SELECT COUNT(*) n FROM invites_sent WHERE inviter=? AND ts > ?").get(inviter, day) as any).n >= INVITES_PER_DAY) return `You've sent ${INVITES_PER_DAY} email invites today. Copy your invite link instead, or try tomorrow.`;
    if (q("SELECT 1 FROM invites_sent WHERE (hash=? OR lower(login)=lower(?)) AND ts > ?").get(h, login, month)) return `@${login} already got a Caldera invite this month. Send them your invite link instead.`;
    return null;
  }
  async function sendInvite(o: { inviter: string; inviterName: string; inviterHandle: string; login: string; to: string; why: string; link: string }): Promise<string> {
    const blocked = inviteBlock(o.inviter, o.login, o.to); if (blocked) throw new Error(blocked);
    const id = crypto.randomBytes(18).toString("base64url"), un = `${hub}/v1/email/invite-unsub?t=${id}`, who = o.inviterName || "@" + o.inviterHandle;
    q("INSERT INTO invites_sent VALUES (?,?,?,?,?)").run(id, o.inviter, o.login.toLowerCase(), hashOf(o.to), new Date().toISOString());
    const why = o.why ? ` (${o.why})` : "";
    await send({ to: o.to, src: "email-invite", subject: ascii(`${who} invited you to Caldera`),
      html: shell(`${esc(who)} invited you to Caldera`, `<p style="margin:0 0 12px">Hi @${esc(o.login)},</p><p style="margin:0 0 12px">${esc(who)} (@${esc(o.inviterHandle)}) is on Caldera and thought you'd like it${esc(why)}.</p><p style="margin:0 0 12px">Caldera is a free, open-source social network for GitHub and Obsidian: your public repos become a living city, and you meet people by what they build. Signing up with GitHub takes about 30 seconds, and you'll start out connected with ${esc(who)}.</p><p style="margin:22px 0"><a href="${esc(o.link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">See ${esc(who)}'s page and join</a></p><p style="color:#8A8794;font-size:13px;margin:0">We found this address on your public GitHub profile. This is the only invite we'll send you this month, and you won't get another from us unless someone you know asks. <a href="${esc(un)}" style="color:#6E4FE0">Don't email me about Caldera</a> (one click).</p>`),
      text: ascii(`Hi @${o.login},\n\n${who} (@${o.inviterHandle}) is on Caldera and thought you'd like it${why}.\n\nCaldera is a free, open-source social network for GitHub and Obsidian: your public repos become a living city, and you meet people by what they build. Signing up with GitHub takes about 30 seconds.\n\nSee ${who}'s page and join: ${o.link}\n\nWe found this address on your public GitHub profile.\n\n--\nDon't want Caldera emails? One click: ${un}\nCaldera is run by mjonesone, LLC. Privacy: ${hub}/privacy`),
      headers: { "List-Unsubscribe": `<${un}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    return `Invite sent to @${o.login}.`;
  }
  /** One click from an invite email: that address never gets another Caldera email (the hash goes on the suppression list). */
  function inviteUnsub(id: string): boolean {
    const r = q("SELECT hash FROM invites_sent WHERE id=?").get(id) as any; if (!r) return false;
    q("INSERT OR REPLACE INTO email_suppress VALUES (?,?,?)").run(r.hash, "invite-unsubscribed", new Date().toISOString()); return true;
  }

  /** A new direct message: one short email to the member's summary address, or their GitHub-verified address if they
   *  haven't set one. The conversation itself stays on Caldera; `off` turns these emails off in one click. */
  async function messageAlert(owner: string, a: { handle: string; name: string; preview: string; count: number; request: boolean; url: string; off: string }): Promise<boolean> {
    const r = row(owner); let to = r && r.confirmed ? addr(r) : "";
    if (!to) { const s = suggestion(owner); if (s?.verified) to = s.email; }
    if (!to || suppressed(to)) return false;
    const who = a.name && a.name !== a.handle ? `${a.name} (@${a.handle})` : `@${a.handle}`;
    const what = a.request ? `${who} wants to message you` : a.count > 1 ? `${who} sent you ${a.count} messages` : `${who} sent you a message`;
    await send({ to, src: a.request ? "email-message-request" : "email-message", subject: ascii(`${what} on Caldera`),
      html: shell(esc(what), `<p style="margin:0 0 14px;padding:12px 14px;border-left:3px solid #6E4FE0;background:#F7F5FC;color:#24222B">${esc(a.preview)}</p>${a.request ? `<p style="margin:0 0 12px;color:#55525E">Accept to reply, or ignore it. They won't be told which.</p>` : ""}<p style="margin:18px 0"><a href="${esc(a.url)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">${a.request ? "See the request" : "Reply on Caldera"}</a></p><p style="color:#8A8794;font-size:12.5px;margin:0">Replying to this email doesn't reach @${esc(a.handle)}. <a href="${esc(a.off)}" style="color:#8A8794">Stop emails about messages</a> (one click).</p>`),
      text: ascii(`${what} on Caldera:\n\n"${a.preview}"\n\n${a.request ? "See the request" : "Reply"}: ${a.url}\n\nReplying to this email doesn't reach @${a.handle}.\n--\nStop emails about messages: ${a.off}\nCaldera is run by mjonesone, LLC. Privacy: ${hub}/privacy`),
      headers: { "List-Unsubscribe": `<${a.off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    return true;
  }

  /** a plain one-off email in the Caldera shell (sign-up links, weekly update nudges) */
  async function note(m: { to: string; subject: string; title: string; html: string; text: string; headers?: Record<string, string>; src?: string }) {
    if (!m.to || suppressed(m.to)) return false;
    await send({ to: m.to, subject: ascii(m.subject), html: shell(esc(m.title), m.html), text: ascii(m.text), headers: m.headers, src: m.src }); return true;
  }
  return { note, subscribe, confirm, messageAlert, unsubToken, unsubscribe, status, runDigest, schedule, page, compose, isActive: (d: DigestData) => rank.active(d), hashOf, suggest, suggestion, promptFor, dismissPrompt, matches, hasConfirmed, sendSignin, sendInvite, inviteBlock, inviteUnsub, invitesToday: (inviter: string) => (q("SELECT COUNT(*) n FROM invites_sent WHERE inviter=? AND ts > ?").get(inviter, new Date(Date.now() - DAY).toISOString()) as any).n as number, inviteCap: INVITES_PER_DAY };
}
