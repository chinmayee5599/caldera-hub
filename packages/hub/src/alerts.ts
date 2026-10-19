/**
 * Alerts: short notes from Caldera to its members (welcome, release notes, announcements). Posted only by the operator
 * (node dist/admin.js alert-post ...). Members see them behind a bell in the signed-in bar, on /alerts and in Settings.
 * Read state is per member. Profile pages are sandboxed (no cookies on requests), so "seen" is a GET beacon carrying a
 * short-lived HMAC token the hub put in the page for that member.
 */
import crypto from "node:crypto";

export type Audience = "all" | "github" | "obsidian";
export interface AlertRow { id: string; title: string; body: string; cta_label: string | null; cta_url: string | null; copy_text: string | null; copy_label: string | null; pinned: number; audience: Audience; ts: string; by: string; version: string | null; read?: boolean }
export interface PostAlert { title: string; body: string; ctaLabel?: string; ctaUrl?: string; copyText?: string; copyLabel?: string; pinned?: boolean; audience?: Audience; by?: string; version?: string; ts?: string;
  /** a personal alert for one member (feed: "@x sent you a post", kudos on your post); `key` folds repeats into one unread alert */
  target?: string; key?: string }

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Markdown-lite: paragraphs, "- " bullet lists, **bold**, `code`, [text](https://link). Everything else is escaped. */
export function mdLite(src: string, hub = ""): string {
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, (_m, txt, url) => {
      const u = String(url).replace(/&amp;/g, "&"), abs = u.startsWith("/") ? hub.replace(/\/$/, "") + u : u;
      return `<a href="${esc(abs)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });
  return String(src || "").replace(/\r/g, "").trim().split(/\n{2,}/).map(block => {
    const lines = block.split("\n");
    if (lines.every(l => /^\s*-\s+/.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*-\s+/, ""))}</li>`).join("")}</ul>`;
    // a paragraph followed by a list in the same block
    const firstList = lines.findIndex(l => /^\s*-\s+/.test(l));
    if (firstList > 0 && lines.slice(firstList).every(l => /^\s*-\s+/.test(l)))
      return `<p>${lines.slice(0, firstList).map(inline).join("<br>")}</p><ul>${lines.slice(firstList).map(l => `<li>${inline(l.replace(/^\s*-\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

export function alertsStore(q: (sql: string) => any, key: Buffer) {
  q(`CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, title TEXT, body TEXT, cta_label TEXT, cta_url TEXT, copy_text TEXT, copy_label TEXT,
    pinned INTEGER DEFAULT 0, audience TEXT DEFAULT 'all', ts TEXT, by TEXT, version TEXT)`).run();
  q("CREATE TABLE IF NOT EXISTS alert_reads (owner TEXT, alert_id TEXT, ts TEXT, PRIMARY KEY (owner, alert_id))").run();
  for (const col of ["target TEXT", "dkey TEXT"]) { try { q(`ALTER TABLE alerts ADD COLUMN ${col}`).run(); } catch { /* already there */ } }
  q("CREATE INDEX IF NOT EXISTS alerts_target ON alerts(target, ts)").run();
  const mac = (s: string) => crypto.createHmac("sha256", key).update("alerts-seen:" + s).digest("base64url").slice(0, 32);
  const visible = (aud: Audience, kind: "github" | "obsidian") => aud === "all" || aud === kind;
  const store = {
    post(o: PostAlert): string {
      const title = String(o.title || "").trim().slice(0, 140), body = String(o.body || "").slice(0, 8000);
      if (!title) throw new Error("an alert needs a title");
      const aud: Audience = o.audience === "github" || o.audience === "obsidian" ? o.audience : "all";
      if (o.version) { const ex = q("SELECT id FROM alerts WHERE version=?").get(o.version) as any; if (ex) return ex.id; }   // one alert per release
      const ts = o.ts || new Date().toISOString(), target = o.target || null, dkey = o.key || null;
      if (target && dkey) {   // the same thing again (more kudos on the same post): update the unread alert instead of stacking
        const ex = q("SELECT a.id FROM alerts a WHERE a.target=? AND a.dkey=? AND NOT EXISTS (SELECT 1 FROM alert_reads r WHERE r.owner=a.target AND r.alert_id=a.id)").get(target, dkey) as any;
        if (ex) { q("UPDATE alerts SET title=?, body=?, ts=? WHERE id=?").run(title, body, ts, ex.id); return ex.id; }
      }
      const id = crypto.randomBytes(6).toString("hex");
      q("INSERT INTO alerts (id, title, body, cta_label, cta_url, copy_text, copy_label, pinned, audience, ts, by, version, target, dkey) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, title, body, o.ctaLabel || null, o.ctaUrl || null, o.copyText ? String(o.copyText).slice(0, 60000) : null,
        o.copyLabel || null, o.pinned ? 1 : 0, aud, ts, o.by || "caldera", o.version || null, target, dkey);
      if (target && Math.random() < 0.02) q("DELETE FROM alerts WHERE target IS NOT NULL AND ts < ?").run(new Date(Date.now() - 45 * 86_400_000).toISOString());   // personal alerts don't pile up forever
      return id;
    },
    pin(id: string, on: boolean) { return q("UPDATE alerts SET pinned=? WHERE id=?").run(on ? 1 : 0, id).changes > 0; },
    remove(id: string) { q("DELETE FROM alert_reads WHERE alert_id=?").run(id); return q("DELETE FROM alerts WHERE id=?").run(id).changes > 0; },
    list(): AlertRow[] { return q("SELECT * FROM alerts WHERE target IS NULL ORDER BY pinned DESC, ts DESC").all() as AlertRow[]; },
    /** A member's alerts, pinned first then newest, with read flags. */
    forOwner(owner: string, kind: "github" | "obsidian", limit = 50): AlertRow[] {
      const read = new Set((q("SELECT alert_id FROM alert_reads WHERE owner=?").all(owner) as any[]).map(r => r.alert_id));
      // a new member starts at zero: news posted before they joined is there to read, but not counted as unread (the pinned welcome still is)
      const joined = String((q("SELECT created FROM profiles WHERE id=?").get(owner) as any)?.created || "");
      return (q("SELECT * FROM alerts WHERE target IS NULL OR target=? ORDER BY pinned DESC, ts DESC LIMIT 200").all(owner) as AlertRow[]).filter(a => visible(a.audience, kind)).slice(0, limit)
        .map(a => ({ ...a, read: read.has(a.id) || (!(a as any).target && !a.pinned && !!joined && a.ts < joined) }));
    },
    unread(owner: string, kind: "github" | "obsidian"): number { return store.forOwner(owner, kind, 200).filter(a => !a.read).length; },
    markRead(owner: string, ids: string[]) { const t = new Date().toISOString(); for (const id of ids.slice(0, 200)) q("INSERT OR IGNORE INTO alert_reads VALUES (?,?,?)").run(owner, id, t); },
    /** Token for the "seen" beacon: marks this member's alerts up to `upTo` read. Valid 1 day. */
    seenToken(owner: string, upTo: string): string { const p = Buffer.from(JSON.stringify({ o: owner, u: upTo, x: Date.now() + 86_400_000 })).toString("base64url"); return p + "." + mac(p); },
    checkSeen(t: unknown): { owner: string; upTo: string } | null {
      const [p, sig] = String(t || "").split("."); if (!p || !sig || p.length > 600) return null;
      const want = Buffer.from(mac(p)), got = Buffer.from(sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      try { const o = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); return o.x > Date.now() && typeof o.o === "string" && typeof o.u === "string" ? { owner: o.o, upTo: o.u } : null; } catch { return null; }
    },
    markSeenUpTo(owner: string, kind: "github" | "obsidian", upTo: string) { store.markRead(owner, store.forOwner(owner, kind, 200).filter(a => a.ts <= upTo).map(a => a.id)); },
  };
  return store;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** One alert as HTML (bell panel, /alerts, Settings). `idp` keeps copy-button ids unique per placement. */
export function alertItem(a: AlertRow, hub: string, idp: string): string {
  const base = hub.replace(/\/$/, ""), cta = a.cta_url ? (a.cta_url.startsWith("/") ? base + a.cta_url : a.cta_url) : "";
  const copyId = `${idp}-cp-${a.id}`;
  return `<article class="al-item${a.read ? "" : " al-unread"}${a.pinned ? " al-pinned" : ""}"><div class="al-top">${a.read ? "" : `<i class="al-dot" aria-label="Unread"></i>`}<b class="al-t">${a.pinned ? `<span class="al-pin" title="Pinned">&#128204;</span> ` : ""}${esc(a.title)}</b><span class="al-d">${esc(day(a.ts))}</span></div>
<div class="al-body">${mdLite(a.body, base)}</div>${a.copy_text || cta ? `<div class="al-cta">${a.copy_text ? `<textarea id="${copyId}" class="al-copy" readonly hidden>${esc(a.copy_text)}</textarea><button type="button" class="al-btn" data-al-copy="${copyId}">${esc(a.copy_label || "Copy")}</button>` : ""}${cta ? `<a class="al-btn al-ghost" href="${esc(cta)}" target="_blank" rel="noopener">${esc(a.cta_label || "Open")}</a>` : ""}</div>` : ""}</article>`;
}

/** Shared alert styles (scoped by the containers that use them). Uses Caldera's tokens with dark fallbacks. */
export const ALERT_CSS = `.al-item{padding:12px 2px;border-top:1px solid var(--line,#2A2A2F)}.al-item:first-child{border-top:0}
.al-top{display:flex;align-items:baseline;gap:8px}.al-t{flex:1;min-width:0;color:var(--text-strong,#F2F2F5);font-weight:600}.al-d{flex:none;color:var(--text-muted,#8A8A93);font-size:12px}
.al-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--danger,#F0716A);align-self:center}.al-pin{font-size:12px}
.al-body{color:var(--text,#D6D6DC);font-size:13.5px;line-height:1.55}.al-body p{margin:.5em 0}.al-body ul{margin:.4em 0;padding-left:18px}.al-body li{margin:.25em 0}
.al-body code{font:12px 'IBM Plex Mono',monospace;padding:1px 5px;border-radius:5px;background:rgba(127,127,140,.18)}.al-body a{color:var(--accent-text,#B9A6FF)}
.al-cta{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.al-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:28px;padding:0 12px;border-radius:999px;background:#8B6CF6;color:#fff;font:600 12.5px 'IBM Plex Sans',Arial,sans-serif;white-space:nowrap}
.al-btn.al-ghost{background:transparent;border:1px solid var(--line,#2E2A40);color:var(--text,#E6E6EA)}.al-btn:focus-visible{outline:2px solid #8B6CF6;outline-offset:2px}
.al-copy{display:block;width:100%;box-sizing:border-box;min-height:90px;margin-top:8px;font:12px 'IBM Plex Mono',monospace;background:rgba(0,0,0,.25);color:inherit;border:1px solid var(--line,#2E2A40);border-radius:8px;padding:8px}`;

/** Copy buttons: clipboard when allowed, otherwise reveal the text selected (sandboxed pages may refuse the clipboard). */
export const ALERT_JS = `document.addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('[data-al-copy]');if(!b)return;var t=document.getElementById(b.getAttribute('data-al-copy'));if(!t)return;
var show=function(){t.hidden=false;t.focus();t.select();b.textContent='Selected: press Cmd/Ctrl+C'};try{navigator.clipboard.writeText(t.value).then(function(){b.textContent='Copied'},show)}catch(e){show()}});`;

/** The bell + panel for the signed-in bar. `seenUrl` is the beacon that marks everything shown as read. */
export function bellHtml(hub: string, rows: AlertRow[], seenUrl: string): string {
  const base = hub.replace(/\/$/, ""), unread = rows.filter(a => !a.read).length;
  const bell = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" style="display:block"><path d="M12 3a6 6 0 0 0-6 6v3.6l-1.6 2.7A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.7L18 12.6V9a6 6 0 0 0-6-6Zm0 19a3 3 0 0 0 2.9-2.2H9.1A3 3 0 0 0 12 22Z" fill="currentColor"/></svg>`;
  return `<style>#caldera-bar .cb-bell{position:relative}#caldera-bar .cb-bell>summary{padding:0 8px;border-color:transparent;color:#D6D6DC}#caldera-bar .cb-bell>summary:hover{border-color:#2E2A40}
#caldera-bar .cb-badge{position:absolute;top:-3px;right:-2px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:var(--danger,#F0716A);color:#fff;font:700 10.5px/16px 'IBM Plex Sans',Arial,sans-serif;text-align:center}
#caldera-bar .cb-al{position:absolute;right:0;top:calc(100% + 6px);z-index:80;width:min(380px,calc(100vw - 24px));max-height:min(70vh,560px);overflow:auto;background:#18171D;border:1px solid #2E2A40;border-radius:12px;padding:6px 14px 10px;box-shadow:0 12px 30px rgba(0,0,0,.45);font-family:'IBM Plex Sans',Arial,sans-serif;text-align:left;white-space:normal;--line:#2A2A2F;--text:#D6D6DC;--text-strong:#F2F2F5;--text-muted:#8A8A93;--accent-text:#B9A6FF}
#caldera-bar .cb-al h4{margin:8px 0 2px;font:600 13px 'IBM Plex Sans',Arial,sans-serif;color:#F2F2F5;display:flex;justify-content:space-between}#caldera-bar .cb-al h4 a{color:#B9A6FF;font-weight:500}
#caldera-bar .cb-al .al-empty{color:#8A8A93;font-size:13px;padding:10px 0}#caldera-bar .cb-al ${ALERT_CSS.replace(/\n/g, "\n#caldera-bar .cb-al ").replace(/}(?=[^\n])/g, "}#caldera-bar .cb-al ")}
@media (max-width:620px){#caldera-bar .cb-al{position:fixed;left:12px;right:12px;top:52px;width:auto}}</style>`
    + `<details class="cb-bell" data-seen="${esc(seenUrl)}"><summary aria-label="Alerts${unread ? `, ${unread} unread` : ""}">${bell}${unread ? `<span class="cb-badge">${unread > 9 ? "9+" : unread}</span>` : ""}</summary>`
    + `<div class="cb-al" role="dialog" aria-label="Alerts"><h4><span>Alerts</span><a href="${esc(base)}/alerts" target="_blank" rel="noopener">See all</a></h4>${rows.length ? rows.slice(0, 8).map(a => alertItem(a, base, "bell")).join("") : `<div class="al-empty">Nothing yet.</div>`}</div></details>`
    + `<script>(function(){var d=document.querySelector('#caldera-bar .cb-bell');if(!d)return;d.addEventListener('toggle',function(){if(!d.open||d.getAttribute('data-done'))return;d.setAttribute('data-done','1');var u=d.getAttribute('data-seen');if(u){var i=new Image();i.src=u}var b=d.querySelector('.cb-badge');if(b)b.remove()});
document.addEventListener('click',function(ev){if(d.open&&!d.contains(ev.target))d.open=false});${ALERT_JS}})()</script>`;
}
