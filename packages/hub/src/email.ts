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
  requests: { handle: string; name: string; note: string }[]; friends: { handle: string; name: string }[];
  gravity: { handle: string; reason: string }[]; links: number; invited: { handle: string }[]; credits: number;
  suggestions: { handle: string; name: string; why: string }[]; newMembers: { handle: string; name: string }[];
}
export interface EmailCtx {
  q: (sql: string) => any; seal: (s: string) => string; unseal: (s: string) => string; hub: string;
  /** the hub's private key, for hashing addresses on the suppression list */
  pepper: Buffer;
  send?: (m: Mail) => Promise<void>; resendKey?: string; from?: string; replyTo?: string;
  digest: (owner: string, since: string) => DigestData | null;
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
  const { q } = ctx, hub = ctx.hub.replace(/\/$/, "");
  q(`CREATE TABLE IF NOT EXISTS email_subs (owner TEXT PRIMARY KEY, email TEXT, hash TEXT, confirmed INTEGER, token TEXT, created TEXT,
      last_sent TEXT, last_quiet TEXT, last_links INTEGER, confirm_sent INTEGER)`).run();
  q("CREATE TABLE IF NOT EXISTS email_suppress (hash TEXT PRIMARY KEY, reason TEXT, ts TEXT)").run();
  q("CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v TEXT)").run();
  const hashOf = (e: string) => crypto.createHmac("sha256", ctx.pepper).update("email:" + e.trim().toLowerCase()).digest("hex");
  const row = (owner: string) => q("SELECT * FROM email_subs WHERE owner=?").get(owner) as any;
  const addr = (r: any) => { try { return ctx.unseal(r.email); } catch { return ""; } };
  const unsubUrl = (t: string) => `${hub}/v1/email/unsub?t=${t}`;

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
${unsub ? `<p style="max-width:560px;margin:14px auto 0;color:#8A8794;font-size:12px;text-align:center">You get this because you asked for a daily Caldera summary. <a href="${esc(unsub)}" style="color:#6E4FE0">Unsubscribe</a> in one click.</p>` : ""}</body></html>`;

  /** Start (or restart) a subscription: stores the address sealed and mails a confirmation link. Returns a message for the owner. */
  async function subscribe(owner: string, email: string): Promise<string> {
    const bad = validEmail(email); if (bad) throw new Error(bad);
    const e = email.trim().toLowerCase(), h = hashOf(e), cur = row(owner);
    if (cur && cur.hash === h && cur.confirmed) return `Daily summaries already go to ${e}.`;
    if (cur && cur.hash === h && cur.confirm_sent > Date.now() - 10 * 60_000) return `A confirmation link is on its way to ${e}. Check your inbox (and spam).`;
    const token = crypto.randomBytes(18).toString("base64url");
    q(`INSERT INTO email_subs (owner, email, hash, confirmed, token, created, last_sent, last_quiet, last_links, confirm_sent) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(owner) DO UPDATE SET email=excluded.email, hash=excluded.hash, confirmed=0, token=excluded.token, confirm_sent=excluded.confirm_sent`)
      .run(owner, ctx.seal(e), h, 0, token, new Date().toISOString(), null, null, null, Date.now());
    const link = `${hub}/v1/email/confirm?t=${token}`;
    await send({ to: e, subject: "Confirm your daily Caldera summary",
      html: shell("Confirm your email", `<p>Someone (hopefully you) asked for a daily Caldera summary at this address: who visited your page, friend requests, links into your garden.</p><p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">Yes, send me summaries</a></p><p style="color:#8A8794;font-size:13px">If this wasn't you, ignore this email and nothing will be sent.</p>`),
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
  function compose(d: DigestData, unsub: string, quiet: boolean): Mail | null {
    const page = `${hub}/@${d.handle}/`, accept = d.hosted ? `${hub}/me` : "obsidian://caldera";
    const pl = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
    const subject = ascii(d.requests.length ? `Caldera: ${d.requests.length === 1 ? `@${d.requests[0]!.handle} wants to be friends` : `${d.requests.length} friend requests`}`
      : d.visitors24 ? `Caldera: ${pl(d.visitors24, "person", "people")} viewed your page`
      : d.friends.length ? `Caldera: you and @${d.friends[0]!.handle} are now friends`
      : d.invited.length ? `Caldera: @${d.invited[0]!.handle} joined from your invite`
      : d.gravity.length ? `Caldera: you got gravity from @${d.gravity[0]!.handle}`
      : d.links ? `Caldera: ${pl(d.links, "new link")} into your garden`
      : `Caldera: people you might know`);
    const H: string[] = [], T: string[] = [];
    const sec = (title: string, html: string, text: string) => { H.push(`<h2 style="margin:20px 0 6px;font:600 15px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#111113;text-transform:uppercase;letter-spacing:.04em">${title}</h2>${html}`); T.push(`${title.toUpperCase()}\n${text}`); };
    const who = (h: string, n: string) => `<a href="${esc(hub)}/@${esc(h)}/" style="color:#6E4FE0;text-decoration:none;font-weight:600">${esc(n || "@" + h)}</a> <span style="color:#8A8794">@${esc(h)}</span>`;
    if (d.views7 || d.visitors24) sec("Your page", `<p style="margin:0"><b style="font-size:26px;color:#111113">${d.visitors24}</b> ${d.visitors24 === 1 ? "person" : "people"} in the last day (${d.views24} views) &middot; <b>${d.visitors7}</b> this week. <a href="${esc(page)}" style="color:#6E4FE0">See your page</a></p>`,
      `${d.visitors24} people in the last day (${d.views24} views), ${d.visitors7} this week. ${page}`);
    if (d.requests.length) sec("Friend requests", d.requests.map(r => `<p style="margin:6px 0">${who(r.handle, r.name)}${r.note ? `<br><span style="color:#55525E">"${esc(r.note)}"</span>` : ""}</p>`).join("") + `<p style="margin:12px 0 0"><a href="${esc(accept)}" style="display:inline-block;padding:9px 18px;border-radius:999px;background:#6E4FE0;color:#fff;text-decoration:none;font-weight:600">Accept</a>${d.hosted ? "" : ` <span style="color:#8A8794;font-size:13px">(opens Obsidian; or open the Caldera panel)</span>`}</p>`,
      d.requests.map(r => `@${r.handle}${r.note ? `: "${r.note}"` : ""}`).join("\n") + `\nAccept: ${d.hosted ? accept : "open the Caldera panel in Obsidian"}`);
    if (d.friends.length) sec("New friends", `<p style="margin:0">${d.friends.map(f => who(f.handle, f.name)).join(" &middot; ")}</p>`, d.friends.map(f => "@" + f.handle).join(", "));
    if (d.gravity.length) sec("Gravity", d.gravity.map(g => `<p style="margin:4px 0">@${esc(g.handle)}${g.reason ? `: ${esc(g.reason)}` : ""}</p>`).join(""), d.gravity.map(g => `@${g.handle}${g.reason ? ": " + g.reason : ""}`).join("\n"));
    if (d.links) sec("Your garden", `<p style="margin:0">${pl(d.links, "new link")} from other gardens. <a href="${esc(page)}garden.html" style="color:#6E4FE0">See them</a></p>`, `${pl(d.links, "new link")} from other gardens. ${page}garden.html`);
    if (d.invited.length) sec("Your invites", `<p style="margin:0">${d.invited.map(i => "@" + esc(i.handle)).join(", ")} joined from your invite${d.credits ? `: +${d.credits} help credits` : ""}.</p>`, `${d.invited.map(i => "@" + i.handle).join(", ")} joined from your invite${d.credits ? ` (+${d.credits} credits)` : ""}.`);
    if (d.suggestions.length) sec("People you might know", d.suggestions.map(s => `<p style="margin:6px 0">${who(s.handle, s.name)} <span style="color:#8A8794">${esc(s.why)}</span></p>`).join(""), d.suggestions.map(s => `@${s.handle} (${s.why}) ${hub}/@${s.handle}/`).join("\n"));
    if (d.newMembers.length) sec("New this week", `<p style="margin:0">${d.newMembers.slice(0, 8).map(m => who(m.handle, m.name)).join(" &middot; ")}</p>`, d.newMembers.slice(0, 8).map(m => "@" + m.handle).join(", "));
    if (!H.length) return null;
    const invite = `${hub}/?invite=${encodeURIComponent(d.handle)}`;
    H.push(`<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #ECEAF2;color:#55525E;font-size:14px">Bring a friend: <a href="${esc(invite)}" style="color:#6E4FE0">${esc(invite)}</a> (you get 25 help credits when they join).</p>`);
    T.push(`Bring a friend: ${invite}`);
    return { to: "", subject, html: shell(quiet ? "This week on Caldera" : `Your day on Caldera, @${esc(d.handle)}`, H.join(""), unsub), text: ascii(`${T.join("\n\n")}\n\n--\nUnsubscribe in one click: ${unsub}`),
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
      const active = d.visitors24 || d.requests.length || d.friends.length || d.gravity.length || d.links || d.invited.length;
      const quietOk = !r.last_quiet || Date.parse(r.last_quiet) < Date.now() - 7 * DAY;
      if (!active && !(quietOk && (d.suggestions.length || d.newMembers.length))) { skipped++; q("UPDATE email_subs SET last_links=? WHERE owner=?").run(totalLinks, r.owner); continue; }
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
  return { subscribe, confirm, unsubToken, unsubscribe, status, runDigest, schedule, page, compose, hashOf };
}
