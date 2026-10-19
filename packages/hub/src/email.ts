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

export interface Mail { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }
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
}
export interface EmailCtx {
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string; hub: string;
  /** the hub's private key, for hashing addresses on the suppression list */
  pepper: Buffer;
  send?: (m: Mail) => Promise<void>; resendKey?: string; from?: string; replyTo?: string;
  digest: (owner: string, since: string) => DigestData | null;
  /** open-core hooks: is today worth an email, and its subject line (the hub passes its loaded extensions) */
  rank?: { active(d: DigestData): boolean; subject(d: DigestData): string };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ascii = (s: string) => s.normalize("NFKD").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\n\x20-\x7e]/g, "");
const DAY = 86_400_000;
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

  async function send(m: Mail) {
    if (ctx.send) return ctx.send(m);
    if (!ctx.resendKey) throw new Error("email is not set up on this hub");
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { authorization: "Bearer " + ctx.resendKey, "content-type": "application/json", "user-agent": "Mozilla/5.0 (caldera-hub)" },
      body: JSON.stringify({ from: ctx.from || "Caldera <hello@caldera.social>", reply_to: ctx.replyTo || "hello@caldera.social", to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers }) });
    if (!r.ok) throw new Error(`email send failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }

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
    const cons = d.friends;
    const subject = ascii(rank.subject(d));
    const H: string[] = [], T: string[] = [];
    const sec = (title: string, html: string, text: string) => { H.push(`<h2 style="margin:22px 0 8px;font:600 13px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#55525E;text-transform:uppercase;letter-spacing:.06em">${title}</h2>${html}`); T.push(`${title.toUpperCase()}\n${text}`); };
    const who = (h: string, n: string) => `<a href="${esc(at(h))}" style="color:#6E4FE0;text-decoration:none;font-weight:600">${esc(n || "@" + h)}</a> <span style="color:#8A8794">@${esc(h)}</span>`;
    const btn = (href: string, label: string, ghost = false) => `<a href="${esc(href)}" style="display:inline-block;margin:6px 6px 0 0;padding:7px 14px;border-radius:999px;${ghost ? "border:1px solid #D9D4EA;color:#24222B" : "background:#6E4FE0;color:#fff"};text-decoration:none;font-weight:600;font-size:13px">${esc(label)}</a>`;
    const row = (inner: string) => `<div style="margin:0 0 10px;padding:10px 12px;border:1px solid #ECEAF2;border-radius:10px">${inner}</div>`;
    // 0. unread messages (a short preview only; the conversation itself stays on Caldera)
    if (d.messages?.unread) sec(`Messages: ${pl(d.messages.unread, "unread")}`, d.messages.from.map(m => row(`${who(m.handle, m.name)}${m.request ? ` <span style="color:#55525E">&middot; wants to message you</span>` : m.count > 1 ? ` <span style="color:#55525E">&middot; ${m.count} messages</span>` : ""}<br><span style="color:#55525E">"${esc(m.preview)}"</span><br>${btn(`${hub}/messages/@${encodeURIComponent(m.handle)}`, m.request ? "See the request" : "Reply")}`)).join(""),
      d.messages.from.map(m => `@${m.handle}${m.request ? " wants to message you" : ""}: "${m.preview}" - reply: ${hub}/messages/@${m.handle}`).join("\n"));
    // 1. kudos
    if (d.kudos?.length) sec("Kudos", d.kudos.map(k => row(`<span style="font-size:20px">${esc(k.emoji)}</span> ${who(k.handle, k.name)} sent you kudos<br>${btn(at(k.handle), "Send one back", true)}`)).join(""),
      d.kudos.map(k => `@${k.handle} sent you ${k.emoji} - send one back: ${at(k.handle)}`).join("\n"));
    if (d.postKudos?.length) sec("Kudos on your posts", d.postKudos.slice(0, 6).map(k => row(`<span style="font-size:20px">${esc(k.emoji)}</span> ${who(k.handle, k.name)} on your post<br>${btn(k.url, "See the post", true)}`)).join(""),
      d.postKudos.slice(0, 6).map(k => `@${k.handle} sent ${k.emoji} on your post: ${k.url}`).join("\n"));
    // 2. new followers (Follow back on their page makes you friends, for everyone)
    if (d.requests.length) sec("New followers", d.requests.map(r => row(`${who(r.handle, r.name)}${r.why ? ` <span style="color:#55525E">&middot; ${esc(r.why)}</span>` : ""}${r.note ? `<br><span style="color:#55525E">"${esc(r.note)}"</span>` : ""}<br>${btn(at(r.handle), "Follow back")}`)).join("")
      + `<p style="margin:0;color:#8A8794;font-size:12.5px">Follow back and you're friends.</p>`,
      d.requests.map(r => `@${r.handle}${r.why ? ` (${r.why})` : ""}${r.note ? `: "${r.note}"` : ""} follows you - follow back: ${at(r.handle)}`).join("\n"));
    // 3. intros (double opt-in)
    if (d.intros?.length) { const ans = `${hub}/me/building`;
      sec("Would like to connect", d.intros.map(x => row(`${who(x.handle, x.name)}${x.tag ? `, also building ${esc(x.tag)},` : ""} would like to connect<br>${btn(ans, "Accept")}${btn(at(x.handle), "See their page", true)}`)).join(""),
        d.intros.map(x => `@${x.handle}${x.tag ? ` (also building ${x.tag})` : ""} would like to connect - answer: ${ans}`).join("\n")); }
    // 3b. feed posts sent to them because they match, and offers to help on their posts (double opt-in)
    if (d.postWaiting?.length) sec("Sent to you", d.postWaiting.slice(0, 5).map(w => row(`${esc(w.text)}<br><span style="color:#55525E">${w.kind === "help" ? "Accept to connect" : "You match. Accept to connect"}</span><br>${btn(w.url, "See it and answer")}`)).join(""),
      d.postWaiting.slice(0, 5).map(w => `${w.text} - answer: ${w.url}`).join("\n"));
    // 4. people to meet
    if (d.suggestions.length) sec("People to meet", d.suggestions.slice(0, 3).map(x => row(`${who(x.handle, x.name)}${x.why ? ` <span style="color:#55525E">&middot; ${esc(x.why)}</span>` : ""}<br>${btn(at(x.handle), "Follow", true)}`)).join(""),
      d.suggestions.slice(0, 3).map(x => `@${x.handle}${x.why ? ` (${x.why})` : ""} - follow: ${at(x.handle)}`).join("\n"));
    // 4b. what people are looking for that fits them, and recommendations for people like them
    if (d.lookingFor?.length) sec("Looking for", d.lookingFor.map(x => row(`${esc(x.sentence)}<br><span style="color:#55525E">You match: ${esc(x.why)}</span><br>${btn(x.url, "See the post", true)}`)).join(""),
      d.lookingFor.map(x => `${x.sentence} (you match: ${x.why}) ${x.url}`).join("\n"));
    if (d.recommends?.length) sec("Recommended for you", d.recommends.map(x => row(`${esc(x.sentence)}<br>${btn(x.url, "See why", true)}`)).join(""),
      d.recommends.map(x => `${x.sentence} ${x.url}`).join("\n"));
    // 5. new connections made for them (shared repo, GitHub follows, people who just joined)
    const because = (f: DigestData["friends"][number]) => f.kind === "repo" && f.why ? `you both work on ${f.why}` : f.kind === "github" && f.why ? f.why : f.kind === "intro" ? "you both said yes to an intro" : "";
    if (cons.length) sec("New connections", `<p style="margin:0;line-height:1.7">${cons.map(f => { const b = because(f);
        return f.joined ? `${who(f.handle, f.name)} just joined Caldera${b ? ` - you're connected because ${esc(b)}` : " - you're connected"}` : b ? `You and ${who(f.handle, f.name)} are now connected: ${esc(b)}` : `You and ${who(f.handle, f.name)} are now friends`; }).join("<br>")}</p>`,
      cons.map(f => { const b = because(f); return f.joined ? `@${f.handle} just joined Caldera${b ? ` - you're connected because ${b}` : ""}` : `You and @${f.handle} are now connected${b ? ": " + b : ""}`; }).join("\n"));
    if (d.invited.length) sec("Your invites", `<p style="margin:0">${d.invited.map(i => "@" + esc(i.handle)).join(", ")} joined from your invite.</p>`, `${d.invited.map(i => "@" + i.handle).join(", ")} joined from your invite.`);
    if (d.gravity.length) sec("Gravity", d.gravity.map(g => `<p style="margin:4px 0">@${esc(g.handle)}${g.reason ? `: ${esc(g.reason)}` : ""}</p>`).join(""), d.gravity.map(g => `@${g.handle}${g.reason ? ": " + g.reason : ""}`).join("\n"));
    // 6. your page
    const pg: string[] = [], pt: string[] = [];
    if (d.views7 || d.visitors24) { pg.push(`<b style="font-size:24px;color:#111113">${d.visitors24}</b> ${d.visitors24 === 1 ? "person" : "people"} in the last day &middot; <b>${d.visitors7}</b> this week${d.viewsAll ? ` &middot; ${d.viewsAll.toLocaleString("en-US")} all time` : ""}`);
      pt.push(`${d.visitors24} people in the last day, ${d.visitors7} this week${d.viewsAll ? `, ${d.viewsAll} all time` : ""}`); }
    if (d.vault && (d.vault.journal || d.vault.notes)) { pg.push(`From your vault: ${pl(d.vault.journal, "journal entry", "journal entries")}, ${pl(d.vault.notes, "note")} edited`); pt.push(`From your vault: ${pl(d.vault.journal, "journal entry", "journal entries")}, ${pl(d.vault.notes, "note")} edited`); }
    if (d.cityCommits) { pg.push(`Your city: ${pl(d.cityCommits, "commit")} this week`); pt.push(`Your city: ${pl(d.cityCommits, "commit")} this week`); }
    if (d.links) { pg.push(`${pl(d.links, "new link")} into your page from other members`); pt.push(`${pl(d.links, "new link")} into your page`); }
    if (pg.length) sec("Your page", `<p style="margin:0;line-height:1.7">${pg.join("<br>")}<br><a href="${esc(page)}" style="color:#6E4FE0">See your page</a> &middot; <a href="${esc(page)}city.html" style="color:#6E4FE0">your city</a></p>`, pt.join("\n") + `\n${page}`);
    if (!H.length && !d.setup) return null;
    // 7. exactly one setup step (a page that stopped updating comes first)
    if (d.stale) { H.push(`<p style="margin:22px 0 0;padding:12px 14px;border-radius:10px;background:#FFF4DC;color:#24222B;font-size:14px"><b>Your page last updated ${d.stale} days ago</b> - open Obsidian to refresh it. Your page updates itself while Obsidian is open. <a href="obsidian://caldera" style="color:#6E4FE0">Open Obsidian</a></p>`);
      T.push(`Your page last updated ${d.stale} days ago - open Obsidian to refresh it.`); }
    else if (d.setup) { H.push(`<div style="margin:22px 0 0;padding:14px 16px;border-radius:12px;background:#F1EDFF;color:#24222B;font-size:14px"><b>Next for your page: ${esc(d.setup.label)}.</b> ${esc(d.setup.why)}<br>${btn(d.setup.url, d.setup.how)}</div>`);
      T.push(`NEXT FOR YOUR PAGE: ${d.setup.label}. ${d.setup.why} ${d.setup.how}: ${d.setup.url}`); }
    else if (d.nudge) { H.push(`<p style="margin:22px 0 0;padding:12px 14px;border-radius:10px;background:#F1EDFF;color:#24222B;font-size:14px"><b>Finish your page: ${esc(d.nudge.label)}.</b> ${esc(d.nudge.why)} <a href="${esc(d.nudge.url)}" style="color:#6E4FE0">${esc(d.nudge.how)}</a></p>`);
      T.push(`FINISH YOUR PAGE: ${d.nudge.label}. ${d.nudge.why} ${d.nudge.how}: ${d.nudge.url}`); }
    if (d.alerts?.length) { H.push(`<p style="margin:18px 0 0;font-size:13.5px;color:#55525E"><b>From Caldera:</b> ${d.alerts.map(a => `<a href="${esc(a.url)}" style="color:#6E4FE0">${esc(a.title)}</a>`).join(" &middot; ")}</p>`);
      T.push(`FROM CALDERA\n${d.alerts.map(a => `${a.title}: ${a.url}`).join("\n")}`); }
    const invite = `${hub}/?invite=${encodeURIComponent(d.handle)}`;
    H.push(`<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #ECEAF2;color:#55525E;font-size:13.5px">Bring a friend: <a href="${esc(invite)}" style="color:#6E4FE0">${esc(invite)}</a>.</p>`);
    T.push(`Bring a friend: ${invite}`);
    return { to: "", subject, html: shell(quiet ? "This week on Caldera" : `Your day on Caldera, @${esc(d.handle)}`, H.join(""), unsub), text: ascii(`${T.join("\n\n")}\n\n--\nUnsubscribe in one click: ${unsub}\nCaldera is run by mjonesone, LLC. Privacy: ${hub}/privacy`),
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }

  /** One pass over every confirmed subscriber. `force` ignores the once-a-day guard (tests, manual runs). */
  async function runDigest(force = false): Promise<{ sent: number; skipped: number; errors: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const last = (q("SELECT v FROM hub_meta WHERE k='digest_last'").get() as any)?.v;
    if (!force && last === today) return { sent: 0, skipped: 0, errors: 0 };
    q("INSERT OR REPLACE INTO hub_meta VALUES ('digest_last', ?)").run(today);
    let sent = 0, skipped = 0, errors = 0;
    for (const r of q("SELECT * FROM email_subs WHERE confirmed=1").all() as any[]) {
      const to = addr(r); if (!to || suppressed(to)) { skipped++; continue; }
      const since = r.last_sent || new Date(Date.now() - DAY).toISOString();
      const d = ctx.digest(r.owner, since); if (!d) { skipped++; continue; }
      // links into the garden have no timestamp: compare with the count at the last send
      const newLinks = r.last_links == null ? 0 : Math.max(0, d.links - r.last_links), totalLinks = d.links; d.links = newLinks;
      const active = rank.active(d);
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
    await send({ to: o.to, subject: ascii(`${who} invited you to Caldera`),
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
    await send({ to, subject: ascii(`${what} on Caldera`),
      html: shell(esc(what), `<p style="margin:0 0 14px;padding:12px 14px;border-left:3px solid #6E4FE0;background:#F7F5FC;color:#24222B">${esc(a.preview)}</p>${a.request ? `<p style="margin:0 0 12px;color:#55525E">Accept to reply, or ignore it. They won't be told which.</p>` : ""}<p style="margin:18px 0"><a href="${esc(a.url)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">${a.request ? "See the request" : "Reply on Caldera"}</a></p><p style="color:#8A8794;font-size:12.5px;margin:0">Replying to this email doesn't reach @${esc(a.handle)}. <a href="${esc(a.off)}" style="color:#8A8794">Stop emails about messages</a> (one click).</p>`),
      text: ascii(`${what} on Caldera:\n\n"${a.preview}"\n\n${a.request ? "See the request" : "Reply"}: ${a.url}\n\nReplying to this email doesn't reach @${a.handle}.\n--\nStop emails about messages: ${a.off}\nCaldera is run by mjonesone, LLC. Privacy: ${hub}/privacy`),
      headers: { "List-Unsubscribe": `<${a.off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    return true;
  }

  /** a plain one-off email in the Caldera shell (sign-up links, weekly update nudges) */
  async function note(m: { to: string; subject: string; title: string; html: string; text: string; headers?: Record<string, string> }) {
    if (!m.to || suppressed(m.to)) return false;
    await send({ to: m.to, subject: ascii(m.subject), html: shell(esc(m.title), m.html), text: ascii(m.text), headers: m.headers }); return true;
  }
  return { note, subscribe, confirm, messageAlert, unsubToken, unsubscribe, status, runDigest, schedule, page, compose, isActive: (d: DigestData) => rank.active(d), hashOf, suggest, suggestion, promptFor, dismissPrompt, matches, hasConfirmed, sendSignin, sendInvite, inviteBlock, inviteUnsub, invitesToday: (inviter: string) => (q("SELECT COUNT(*) n FROM invites_sent WHERE inviter=? AND ts > ?").get(inviter, new Date(Date.now() - DAY).toISOString()) as any).n as number, inviteCap: INVITES_PER_DAY };
}
