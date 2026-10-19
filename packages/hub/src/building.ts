/**
 * "What people are building" on the hub: each member's tags (tags.ts does the extracting), the People search over them,
 * shared-tag reasons for suggestions, and double opt-in introductions.
 *
 * Intros: member A taps "Introduce me" on B's page or card. B sees "@A (also building X) would like to connect" with
 * Accept / Not now (on /me/building, in the plugin, and in the daily email). Accept makes them friends (kind "intro");
 * Not now just closes it, and A is never told which. Limits: 5 intro requests a day per member, one per pair per 30 days.
 * Members only: nothing is ever sent to someone who isn't on Caldera.
 */
import http from "node:http";
import { effectiveTags, canonical, type Tag, type RepoSignals } from "./tagkit";
import type { Ext } from "./ext";

const DAY = 86_400_000;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface BuildingCtx {
  q: (sql: string) => any;
  now: () => string;
  profile: (id: string) => any;
  byHandle: (h: string) => any;
  body: (pr: any) => any;
  listed: (pr: any) => boolean;
  modOf: (h: string | null, id?: string) => any;
  areFriends: (a: string, b: string) => boolean;
  befriend: (a: string, b: string, kind: any, ts: string, why: string | null) => void;
  memberOf: (req: http.IncomingMessage) => string | null;
  sameOrigin: (req: http.IncomingMessage) => boolean;
  authed: (req: http.IncomingMessage) => string | null;
  readBody: (req: http.IncomingMessage) => Promise<any>;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  siteHeader: (current?: string) => string;
  loginsOf: (pr: any) => string[];
  privateLangs: (handle: string) => string[];
  token: () => Promise<string | null>;
  tokenOf?: (profileId: string) => Promise<string | null>;
  fetch: typeof fetch;
  llmKey?: string;
  /** ms between GitHub calls (spreads the job out; 0 in tests) */
  pause?: number;
  onChange?: () => void;           // tags changed (World cache etc.)
  /** open-core hooks: tag vocabulary, extraction, overlap and search relevance */
  ext: Pick<Ext, "tagVocab" | "tagExtractor" | "tagShared" | "tagRelevance" | "depOverlap">;
}

export function building(c: BuildingCtx) {
  const { q } = c;
  q(`CREATE TABLE IF NOT EXISTS member_tags (member TEXT PRIMARY KEY, tags TEXT, source TEXT, updated TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS tag_repo_cache (repo TEXT PRIMARY KEY, pushed TEXT, signals TEXT, ts TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS tag_edits (member TEXT PRIMARY KEY, added TEXT, hidden TEXT, auto INTEGER DEFAULT 1, ts TEXT)`).run();
  q(`CREATE TABLE IF NOT EXISTS intros (a TEXT, b TEXT, tag TEXT, status TEXT, ts TEXT, decided TEXT, PRIMARY KEY (a, b, ts))`).run();
  q(`CREATE INDEX IF NOT EXISTS intros_b ON intros(b, status)`).run();

  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 30) : typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean).slice(0, 30) : [];
  const editsOf = (id: string) => { const r = q("SELECT * FROM tag_edits WHERE member=?").get(id) as any;
    return { added: r ? JSON.parse(r.added || "[]") as string[] : [], hidden: r ? JSON.parse(r.hidden || "[]") as string[] : [], auto: r ? r.auto !== 0 : true }; };
  const extractedOf = (id: string): Tag[] => { try { return JSON.parse((q("SELECT tags FROM member_tags WHERE member=?").get(id) as any)?.tags || "[]"); } catch { return []; } };
  /** what a member shows: their page's own tags (profile.md tags / hideTags / autoTags) and web edits, over the extracted ones */
  function tagsOf(pr: any): Tag[] {
    if (!pr) return [];
    const b = c.body(pr), ed = editsOf(pr.id);
    return effectiveTags({ extracted: extractedOf(pr.id), auto: ed.auto && b.autoTags !== false,
      added: [...arr(b.tags), ...ed.added], hidden: [...arr(b.hideTags), ...ed.hidden] }, c.ext.tagVocab());
  }
  const problemOf = (pr: any) => tagsOf(pr).filter(t => t.kind !== "stack");

  // ---------------------------------------------------------------- extraction job
  const job = c.ext.tagExtractor({
    fetch: c.fetch, token: c.token, tokenFor: c.tokenOf, llmKey: c.llmKey, pause: c.pause ?? 0, floor: 500, log: (...a) => console.error(...a),
    members: () => (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(pr => !c.modOf(pr.handle, pr.id)).map(pr => {
      const b = c.body(pr);
      return { id: pr.id, handle: pr.handle, logins: c.loginsOf(pr), privateLangs: c.privateLangs(pr.handle),
        topics: (Array.isArray(b.topics) ? b.topics : []).map((t: any) => String(Array.isArray(t) ? t[0] : t)).filter(Boolean).slice(0, 20) };
    }),
    cacheGet: (repo) => { const r = q("SELECT pushed, signals FROM tag_repo_cache WHERE repo=?").get(repo) as any; try { return r ? { pushed: r.pushed, signals: JSON.parse(r.signals) as RepoSignals } : null; } catch { return null; } },
    cacheSet: (repo, pushed, s) => q("INSERT OR REPLACE INTO tag_repo_cache VALUES (?,?,?,?)").run(repo, pushed, JSON.stringify(s), c.now()),
    store: (member, tags, source) => { q("INSERT OR REPLACE INTO member_tags VALUES (?,?,?,?)").run(member, JSON.stringify(tags), source, c.now()); c.onChange?.(); },
  });
  const lastTagged = new Map<string, number>();
  /** tag one member soon (sign-up, sign-in, a GitHub link added), at most every 12 hours per member */
  function tagSoon(id: string, enabled: boolean) {
    if (!enabled || Date.now() - (lastTagged.get(id) || 0) < 12 * 3600_000) return; lastTagged.set(id, Date.now());
    setTimeout(() => { void job.run({ only: id }).catch(e => console.error("tags", e.message)); }, 4000).unref?.();
  }
  function schedule() {
    const t0 = setTimeout(function tick() { void job.run().catch(e => console.error("tags job", e.message)); const t = setTimeout(tick, 12 * 3600_000); t.unref?.(); }, 8 * 60_000); t0.unref?.();
  }

  // ---------------------------------------------------------------- search and matching
  /** problem tags two members share, strongest first, with a combined weight */
  function shared(a: any, b: any): { t: string; w: number }[] { return c.ext.tagShared(problemOf(a), problemOf(b)); }
  /** the People directory's tag chips: the most common tags across listed members (problem spaces first) */
  function topTags(limit = 18) {
    const n = new Map<string, { t: string; kind: string; n: number }>();
    for (const pr of (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(c.listed))
      for (const t of tagsOf(pr)) { const k = t.t.toLowerCase(), x = n.get(k) || { t: t.t, kind: t.kind, n: 0 }; x.n++; n.set(k, x); }
    const rank = (x: { kind: string }) => (x.kind === "stack" ? 1 : 0);
    return [...n.values()].sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.t.localeCompare(b.t)).slice(0, limit);
  }
  /** how well a member matches a search: a tag hit counts by its weight, plain text matches a little */
  function relevance(pr: any, tag: string, term: string): number { return c.ext.tagRelevance(tagsOf(pr), `${pr.handle} ${pr.name || ""} ${pr.headline || ""}`, tag, term); }

  // ---------------------------------------------------------------- similar stacks (shared public dependencies)
  /** a member's public dependencies: package names from the manifests the tag job already read (public repos only, names
   *  only, no extra GitHub calls), with the repos each came from */
  function depsOf(pr: any): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const login of c.loginsOf(pr).slice(0, 2)) {
      for (const r of q("SELECT repo, signals FROM tag_repo_cache WHERE lower(repo) LIKE ? ESCAPE '\\'").all(String(login).toLowerCase().replace(/[\\%_]/g, x => "\\" + x) + "/%") as any[]) {
        let s: RepoSignals | null = null; try { s = JSON.parse(r.signals); } catch { /* skip */ }
        for (const d of (s?.deps || []).slice(0, 200)) { const k = family(String(d).toLowerCase()); const l = out.get(k) || []; if (l.length < 3) l.push(s!.repo); out.set(k, l); }
      }
    }
    return out;
  }
  /** a package family counts once: @radix-ui/react-dialog and @radix-ui/react-popover are both "@radix-ui/*" (the big
   *  catch-all scopes keep their full names: sharing @google/genai says more than sharing "@google") */
  const family = (d: string) => { const m = d.match(/^(@[a-z0-9._-]+)\/[^/]+$/); return m && !/^@(google|aws-sdk|azure|types|google-cloud|microsoft)$/.test(m[1]!) ? m[1] + "/*" : d; };
  let stackMemo: { at: number; deps: Map<string, Map<string, string[]>>; df: Map<string, number>; n: number } | null = null;
  /** everyone listed, their dependency sets, and how many members use each package (rebuilt at most every 10 minutes) */
  function stackIndex() {
    if (stackMemo && Date.now() - stackMemo.at < 10 * 60_000) return stackMemo;
    const deps = new Map<string, Map<string, string[]>>(), df = new Map<string, number>();
    for (const pr of (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(p => c.listed(p) && !c.modOf(p.handle, p.id))) {
      const d = depsOf(pr); if (!d.size) continue; deps.set(pr.id, d); for (const k of d.keys()) df.set(k, (df.get(k) || 0) + 1);
    }
    return (stackMemo = { at: Date.now(), deps, df, n: deps.size });
  }
  /** members whose public code leans on the same uncommon packages, best first */
  function similarStacks(pr: any, n = 4): { handle: string; name: string; score: number; shared: { dep: string; mine: string[]; theirs: string[] }[] }[] {
    if (!pr) return [];
    const ix = stackIndex(), mine = ix.deps.get(pr.id) || depsOf(pr); if (!mine.size) return [];
    const out: any[] = [];
    for (const [id, theirs] of ix.deps) {
      if (id === pr.id) continue;
      const o = c.ext.depOverlap([...mine.keys()], [...theirs.keys()], d => ix.df.get(d) || 1, Math.max(ix.n, 1)); if (!(o.score > 0)) continue;
      const p = c.profile(id); if (!p?.handle) continue;
      out.push({ handle: p.handle, name: p.name || p.handle, score: o.score, shared: o.shared.slice(0, 6).map(d => ({ dep: d, mine: mine.get(d) || [], theirs: theirs.get(d) || [] })) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }
  /** on a profile: "Builds with a similar stack", the people and the uncommon packages they share (nothing when no one does) */
  function stackCard(hub: string, pr: any): string {
    const list = similarStacks(pr); if (!list.length) return "";
    const base = hub.replace(/\/$/, "");
    return `<section class="cb-stack" aria-label="Builds with a similar stack"><div class="cb-stack-h"><b>Builds with a similar stack</b><span>People whose public repos use the same uncommon packages. From dependency files in public repos only.</span></div>`
      + list.map(x => `<div class="cb-stack-row"><a class="cb-stack-who" href="${base}/@${esc(x.handle)}/">${esc(x.name)}</a><span class="cb-stack-deps">${x.shared.map(s => `<code title="${esc(`@${pr.handle}: ${s.mine.join(", ")} / @${x.handle}: ${s.theirs.join(", ")}`)}">${esc(s.dep)}</code>`).join("")}</span></div>`).join("")
      + `</section><style>.cb-stack{margin:0 0 22px;padding:14px 16px;border:1px solid var(--line,#2A2A2E);border-radius:14px;font:14px/1.45 'IBM Plex Sans',Arial,sans-serif}
.cb-stack-h{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}.cb-stack-h b{color:var(--text-strong,#F2F2F5);font-size:14.5px}.cb-stack-h span{color:var(--text-muted,#8A8A93);font-size:12.5px}
.cb-stack-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 0;border-top:1px solid var(--line,#2A2A2E)}.cb-stack-who{color:var(--accent-text,#C9B8FF);font-weight:600;text-decoration:none;min-width:120px}
.cb-stack-deps{display:flex;flex-wrap:wrap;gap:5px}.cb-stack-deps code{font:12px 'IBM Plex Mono',monospace;padding:2px 7px;border-radius:6px;background:var(--bg-raised,#1C1C21);border:1px solid var(--line,#2A2A2E);color:var(--text,#D6D6DC)}</style>`;
  }

  // ---------------------------------------------------------------- intros
  const introState = (me: string, other: string): "none" | "sent" | "incoming" | "friends" => {
    if (c.areFriends(me, other)) return "friends";
    if (q("SELECT 1 FROM intros WHERE a=? AND b=? AND status='pending'").get(other, me)) return "incoming";
    if (q("SELECT 1 FROM intros WHERE a=? AND b=? AND ts > ?").get(me, other, new Date(Date.now() - 30 * DAY).toISOString())) return "sent";
    return "none";
  };
  function requestIntro(fromId: string, to: any): { status: number; body: any } {
    const me = c.profile(fromId);
    if (!me?.handle || c.modOf(me.handle, me.id)) return { status: 401, body: { error: "Sign in to do that." } };
    if (!to?.handle || c.modOf(to.handle, to.id) || !c.listed(to)) return { status: 404, body: { error: "unknown profile" } };
    if (to.id === fromId) return { status: 400, body: { error: "That's your own page." } };
    const st = introState(fromId, to.id);
    if (st === "friends") return { status: 409, body: { error: `You and @${to.handle} are already friends.`, state: st } };
    if (st === "sent") return { status: 409, body: { error: `You asked to meet @${to.handle} recently. One intro per person every 30 days.`, state: st } };
    if (st === "incoming") { decide(fromId, to.id, true); return { status: 200, body: { ok: true, state: "friends" } }; }   // they already asked you: that's a yes both ways
    const day = new Date(Date.now() - DAY).toISOString();
    if ((q("SELECT COUNT(*) n FROM intros WHERE a=? AND ts > ?").get(fromId, day) as any).n >= 5) return { status: 429, body: { error: "That's 5 intros today. Try again tomorrow." } };
    const sh = shared(me, to)[0]?.t || "";
    q("INSERT INTO intros VALUES (?,?,?,?,?,?)").run(fromId, to.id, sh, "pending", c.now(), null);
    return { status: 200, body: { ok: true, state: "sent", tag: sh } };
  }
  /** B answers A: Accept -> friends (kind intro); Not now -> closed (A isn't told) */
  function decide(meId: string, fromId: string, yes: boolean): { status: number; body: any } {
    const row = q("SELECT * FROM intros WHERE a=? AND b=? AND status='pending' ORDER BY ts DESC").get(fromId, meId) as any;
    if (!row) return { status: 404, body: { error: "No open introduction from them." } };
    q("UPDATE intros SET status=?, decided=? WHERE a=? AND b=? AND status='pending'").run(yes ? "accepted" : "declined", c.now(), fromId, meId);
    if (yes) { c.befriend(fromId, meId, "intro", c.now(), row.tag ? `introduced: both building ${row.tag}` : "introduced on Caldera"); c.onChange?.(); }
    return { status: 200, body: { ok: true, state: yes ? "friends" : "closed" } };
  }
  /** open intros waiting on this member, newest first */
  const pendingFor = (id: string, since = "") => (q(`SELECT i.a, i.tag, i.ts, p.handle, p.name, p.headline FROM intros i JOIN profiles p ON p.id=i.a
      WHERE i.b=? AND i.status='pending' AND i.ts > ? ORDER BY i.ts DESC LIMIT 30`).all(id, since) as any[])
    .filter(r => r.handle && !c.modOf(r.handle, r.a)).map(r => ({ id: r.a as string, handle: r.handle as string, name: r.name || "", headline: r.headline || "", tag: r.tag || "", ts: r.ts as string }));

  // ---------------------------------------------------------------- HTML bits
  /** "Building:" chips under the headline (problem spaces first), each a People search; the owner gets "Edit tags" */
  function chips(hub: string, pr: any, owner: boolean, iv?: { me: string; token: string } | null): string {
    const tags = tagsOf(pr).slice(0, 8), base = hub.replace(/\/$/, "");
    // "Introduce me": a signed-in member who isn't friends with them yet asks to meet; they answer Accept / Not now
    let intro = "";
    if (iv && !owner) {
      const st = introState(iv.me, pr.id), sh = shared(c.profile(iv.me), pr)[0]?.t;
      if (st !== "friends") {
        const label = st === "sent" ? "Intro requested" : st === "incoming" ? `Accept @${pr.handle}'s intro` : "Introduce me";
        intro = `<button type="button" class="cb-intro" data-st="${st}" data-api="${esc(base)}" data-t="${esc(iv.token)}"${st === "sent" ? " disabled" : ""} title="${esc(sh ? `You're both building ${sh}. ` : "")}${st === "sent" ? "They'll see it and can accept." : `Ask to meet @${pr.handle}: they can accept or say not now.`}">${esc(label)}</button>`
          + `<script>(function(){var b=document.querySelector('.cb-intro');if(!b)return;b.addEventListener('click',function(){if(b.disabled)return;b.disabled=true;var was=b.getAttribute('data-st');
fetch(b.getAttribute('data-api')+'/v1/act',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({t:b.getAttribute('data-t'),action:'intro'})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera.'}}}).then(function(x){
if(x.ok){b.textContent=x.j.state==='friends'?'Friends \u2713':'Intro requested';b.title=x.j.state==='friends'?'You are now friends.':'They will see it and can accept.'}else{b.title=x.j.error||'Could not send.';b.textContent=x.j.state==='sent'?'Intro requested':x.j.state==='friends'?'Friends \u2713':(was==='incoming'?b.textContent:'Introduce me');if(x.j.state!=='sent'&&x.j.state!=='friends')b.disabled=false;var t=document.createElement('span');t.className='cb-tip';t.textContent=x.j.error||'Could not send.';var r=b.getBoundingClientRect();t.style.cssText='position:absolute;z-index:100;max-width:280px;padding:8px 11px;border-radius:10px;background:#18171D;border:1px solid #2E2A40;color:#E6E6EA;font:500 12.5px/1.4 IBM Plex Sans,Arial,sans-serif;top:'+(r.bottom+window.scrollY+6)+'px;left:'+Math.max(8,Math.min(r.left,window.innerWidth-290))+'px';document.body.appendChild(t);setTimeout(function(){t.remove()},3200)}})})})();</script>`;
      }
    }
    if (!tags.length && !owner && !intro) return "";
    // what they work on and what they write it in are different things: one labelled line each
    const tag = (t: any) => `<a class="cb-tag cb-tag-${t.kind === "stack" ? "stack" : "prob"}" href="${base}/people?tag=${encodeURIComponent(t.t)}"${t.repo && t.repo !== "topics" ? ` title="From ${esc(t.repo)}"` : ""}>${esc(t.t)}</a>`;
    const prob = tags.filter(t => t.kind !== "stack"), stack = tags.filter(t => t.kind === "stack");
    const edit = owner ? `<a class="cb-tag-edit" href="${base}/me/building">${tags.length ? "Edit tags" : "Add tags"}</a>` : "";
    const line = (label: string, items: string) => `<span class="cb-build-l">${label}</span><span class="cb-build-v">${items}</span>`;
    const rows = (prob.length || (owner && !stack.length) ? line("Building", prob.map(tag).join("") || `<span class="cb-build-none">No tags yet</span>`) : "")
      + (stack.length ? line("Stack", stack.map(tag).join("")) : "");
    return `<div class="cb-build">${rows ? `<div class="cb-build-g">${rows}</div>` : ""}${edit || intro ? `<div class="cb-build-a">${intro}${edit}</div>` : ""}</div>`;
  }
  const CHIP_CSS = `<style>.cb-build{display:flex;flex-direction:column;gap:12px;margin:0 0 22px;padding-top:16px;border-top:1px solid var(--line,#2A2A2E);font:500 12.5px/1.2 'IBM Plex Sans',Arial,sans-serif}
.cb-build-g{display:grid;grid-template-columns:max-content 1fr;align-items:center;gap:8px 14px}.cb-build-v{display:flex;flex-wrap:wrap;gap:6px}.cb-build-a{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.cb-build-l{color:var(--text-muted,#8A8A93);text-transform:uppercase;letter-spacing:.06em;font-size:11px}
.cb-tag{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:999px;text-decoration:none;transition:border-color .15s,background .15s}
.cb-tag-prob{background:var(--accent-soft,rgba(139,108,246,.10));color:var(--accent-text,#C9B8FF);border:1px solid transparent}
.cb-tag-stack{background:transparent;color:var(--text,#D6D6DC);border:1px solid var(--line,#2A2A2E)}
.cb-tag:hover{border-color:var(--accent,#8B6CF6);text-decoration:none}.cb-tag:focus-visible,.cb-tag-edit:focus-visible{outline:2px solid var(--accent,#8B6CF6);outline-offset:2px}
.cb-tag-edit{color:var(--text-muted,#8A8A93);font-size:12px;text-decoration:underline;text-underline-offset:2px}.cb-build-none{color:var(--text-muted,#8A8A93)}
.cb-intro{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:28px;padding:0 12px;border-radius:999px;background:var(--accent,#8B6CF6);color:#fff;font:600 12.5px 'IBM Plex Sans',Arial,sans-serif;white-space:nowrap;transition:filter .15s}
.cb-intro:hover:not(:disabled){filter:brightness(1.08)}.cb-intro:disabled{cursor:default;background:transparent;color:var(--text-muted,#9A9AA6);border:1px solid var(--line,#2A2A2E)}.cb-intro:focus-visible{outline:2px solid var(--accent,#8B6CF6);outline-offset:2px}
@media (max-width:620px){.cb-tag,.cb-intro{min-height:34px}.cb-build-g{grid-template-columns:1fr;gap:6px}.cb-build-l:not(:first-child){margin-top:6px}}</style>`;

  /** /me/building: the signed-in member's tags (hide, add, auto on/off) and the introductions waiting for them */
  function ownerPage(res: http.ServerResponse, meId: string, note = "") {
    const pr = c.profile(meId), b = c.body(pr), ed = editsOf(meId), tags = tagsOf(pr), extracted = extractedOf(meId);
    const auto = ed.auto && b.autoTags !== false, pend = pendingFor(meId);
    const src = (q("SELECT source, updated FROM member_tags WHERE member=?").get(meId) as any);
    const hiddenSet = new Set([...arr(b.hideTags), ...ed.hidden].map(x => x.toLowerCase()));
    const row = (t: Tag) => `<li><span class="bt-chip bt-${t.kind === "stack" ? "stack" : "prob"}">${esc(t.t)}</span>${t.repo && t.repo !== "topics" ? `<span class="mut">from ${esc(t.repo)}</span>` : t.w === 1 && !t.repo ? `<span class="mut">added by you</span>` : ""}
<form method="post"><input type="hidden" name="do" value="hide"><input type="hidden" name="tag" value="${esc(t.t)}"><button class="bt-x" type="submit" aria-label="Hide ${esc(t.t)}">Hide</button></form></li>`;
    const hiddenList = [...extracted.filter(t => hiddenSet.has(t.t.toLowerCase())).map(t => t.t), ...ed.hidden.filter(h => !extracted.some(t => t.t.toLowerCase() === h.toLowerCase()))];
    const intros = pend.length ? pend.map(p => `<li class="bt-intro"><div><b>@${esc(p.handle)}</b>${p.name ? ` <span class="mut">${esc(p.name)}</span>` : ""}<p class="mut">${p.tag ? `Also building ${esc(p.tag)}. ` : ""}${esc(p.headline).slice(0, 140)}</p></div>
<div class="bt-act"><form method="post"><input type="hidden" name="do" value="accept"><input type="hidden" name="from" value="${esc(p.handle)}"><button class="btn small" type="submit">Accept</button></form>
<form method="post"><input type="hidden" name="do" value="decline"><input type="hidden" name="from" value="${esc(p.handle)}"><button class="btn small ghost" type="submit">Not now</button></form></div></li>`).join("")
      : `<p class="mut">No one is waiting. When someone building the same things taps <b>Introduce me</b> on your page, they show up here and in your daily email.</p>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>What you're building - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
.bt{max-width:680px;margin:0 auto;padding:24px 16px 56px}.bt h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.8rem;margin:6px 0 6px}.bt h2{font-size:1.05rem;margin:0 0 10px}
.bt .mut{color:var(--text-muted);margin:0}.bt .card{background:var(--bg-raised);border:1px solid var(--line);border-radius:var(--radius-lg,14px);padding:18px;margin:16px 0}
.bt ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.bt li{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bt-chip{display:inline-flex;align-items:center;min-height:28px;padding:0 11px;border-radius:999px;font-size:13px;font-weight:500}.bt-prob{background:var(--accent-soft);color:var(--accent-text)}.bt-stack{border:1px solid var(--line);color:var(--text)}
.bt form{display:inline;margin:0}.bt form.bt-add,.bt form.bt-sw{display:flex}.bt li .mut{font-size:13px}.bt ul+.bt-add{margin-top:16px}.bt-x{all:unset;cursor:pointer;margin-left:auto;font-size:12.5px;color:var(--text-muted);padding:6px 8px;border-radius:8px}.bt-x:hover{color:var(--text-strong);background:var(--bg-sunken,rgba(127,127,127,.12))}
.bt-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.bt li form:has(.bt-x){margin-left:auto}
.bt-add{gap:8px;margin-top:14px}.bt-add input{flex:1;min-width:0;min-height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.bt-sw{align-items:flex-start;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}.bt-sw label{font-size:14px;line-height:1.45}.bt-sw input{width:18px;height:18px;margin-top:2px;accent-color:var(--accent)}
.bt-intro{justify-content:space-between;padding:12px 0;border-top:1px solid var(--line)}.bt-intro:first-child{border-top:0;padding-top:0}.bt-intro p{margin:4px 0 0;font-size:13.5px}.bt-act{display:flex;gap:8px}
.bt .note{padding:10px 12px;border-radius:10px;background:var(--accent-soft);color:var(--text);margin:12px 0}.bt button.btn{cursor:pointer;min-height:36px}
</style></head><body>${c.siteHeader()}<main class="bt">
<p class="mut"><a href="/@${esc(pr.handle)}/">@${esc(pr.handle)}</a></p><h1>What you're building</h1>
<p class="mut">These tags show on your page and in People, and help people building the same things find you. They come from your public GitHub repos (topics, descriptions, READMEs, dependencies) and the topics on your page. Private repos only ever add a language.</p>
${note ? `<p class="note" role="status">${esc(note)}</p>` : ""}
<section class="card" aria-labelledby="h-intros"><h2 id="h-intros">Introductions${pend.length ? ` (${pend.length})` : ""}</h2><ul>${intros}</ul></section>
<section class="card" aria-labelledby="h-tags"><h2 id="h-tags">Your tags</h2>
${tags.length ? `<ul>${tags.map(row).join("")}</ul>` : `<p class="mut">No tags yet${src ? "" : ": they're worked out within a few minutes of signing up with GitHub or adding your GitHub link"}.</p>`}
<form method="post" class="bt-add"><input type="hidden" name="do" value="add"><label class="sr-only" for="bt-new" style="position:absolute;left:-9999px">Add a tag</label><input id="bt-new" name="tag" maxlength="32" placeholder="Add a tag, like Social features or Next.js" autocomplete="off"><button class="btn small" type="submit">Add</button></form>
${hiddenList.length ? `<p class="mut" style="margin-top:12px">Hidden: ${hiddenList.map(h => `<form method="post"><input type="hidden" name="do" value="unhide"><input type="hidden" name="tag" value="${esc(h)}"><button class="bt-x" type="submit" style="margin:0" aria-label="Show ${esc(h)} again">${esc(h)} &#8634;</button></form>`).join(" ")}</p>` : ""}
<form method="post" class="bt-sw"><input type="hidden" name="do" value="auto"><input type="checkbox" id="bt-auto" name="on" ${auto ? "checked" : ""} onchange="this.form.submit()"><label for="bt-auto"><b>Tag me automatically from my public GitHub</b><br><span class="mut">${b.autoTags === false ? "Turned off in your page's settings (autoTags: false in Caldera/profile.md)." : "Turn off to show only the tags you add."}${src?.updated ? ` Last read ${esc(String(src.updated).slice(0, 10))}.` : ""}</span></label><noscript><button class="btn small" type="submit">Save</button></noscript></form>
</section>
<p class="mut">Obsidian page? You can also set <code>tags</code>, <code>hideTags</code> and <code>autoTags</code> in Caldera/profile.md.</p>
</main><script src="/assets/site.js" defer></script></body></html>`);
  }

  // ---------------------------------------------------------------- routes
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    if (p === "/me/building" || p === "/me/building/") {
      const me = c.memberOf(req);
      if (!me) { res.writeHead(302, { location: "/signin?back=%2Fme%2Fbuilding", "cache-control": "no-store" }); res.end(); return true; }
      if (req.method === "POST") {
        if (!c.sameOrigin(req)) { c.json(res, 403, { error: "wrong origin" }); return true; }
        const chunks: Buffer[] = []; for await (const ch of req) chunks.push(ch as Buffer);
        const f = new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 4000)), act = f.get("do"), ed = editsOf(me);
        let note = "";
        const tag = canonical(f.get("tag") || "", c.ext.tagVocab())?.t || "";
        if (act === "add" && tag) { ed.added = [...ed.added.filter(x => x.toLowerCase() !== tag.toLowerCase()), tag].slice(-12); ed.hidden = ed.hidden.filter(x => x.toLowerCase() !== tag.toLowerCase()); note = `Added ${tag}.`; }
        else if (act === "hide" && tag) { ed.added = ed.added.filter(x => x.toLowerCase() !== tag.toLowerCase()); if (!ed.hidden.some(x => x.toLowerCase() === tag.toLowerCase())) ed.hidden.push(tag); note = `Hidden ${tag}.`; }
        else if (act === "unhide" && tag) { ed.hidden = ed.hidden.filter(x => x.toLowerCase() !== tag.toLowerCase()); note = `${tag} shows again.`; }
        else if (act === "auto") { ed.auto = f.get("on") === "on"; note = ed.auto ? "Automatic tags are on." : "Automatic tags are off: only the tags you add show."; }
        else if ((act === "accept" || act === "decline") && f.get("from")) {
          const from = c.byHandle(String(f.get("from")).toLowerCase()); const r = from ? decide(me, from.id, act === "accept") : { status: 404, body: { error: "unknown profile" } };
          note = r.status === 200 ? (act === "accept" ? `You and @${from.handle} are now friends.` : "Closed. They won't be told.") : r.body.error;
        }
        if (["add", "hide", "unhide", "auto"].includes(act || "")) { q("INSERT OR REPLACE INTO tag_edits VALUES (?,?,?,?,?)").run(me, JSON.stringify(ed.added), JSON.stringify(ed.hidden.slice(-40)), ed.auto ? 1 : 0, c.now()); c.onChange?.(); }
        ownerPage(res, me, note); return true;
      }
      ownerPage(res, me); return true;
    }
    let ms = p.match(/^\/v1\/people\/([a-z0-9-]+)\/similar-stack$/);
    if (req.method === "GET" && ms) { const pr = c.byHandle(ms[1]!); if (!pr || !c.listed(pr) || c.modOf(pr.handle, pr.id)) { c.json(res, 404, { error: "unknown profile" }); return true; }
      c.json(res, 200, { handle: pr.handle, similar: similarStacks(pr, 8) }); return true; }
    if (req.method === "GET" && p === "/v1/tags") { c.json(res, 200, { tags: topTags(Number(url.searchParams.get("limit")) || 18), vocabulary: c.ext.tagVocab().problems }); return true; }
    // People cards: a signed-in member asks to meet someone (same-site page, member cookie)
    let m = p.match(/^\/v1\/intro\/([a-z0-9-]+)$/);
    if (req.method === "POST" && m) {
      if (!c.sameOrigin(req)) { c.json(res, 403, { error: "wrong origin" }); return true; }
      const me = c.memberOf(req); if (!me) { c.json(res, 401, { error: "Sign in to ask for an introduction." }); return true; }
      const r = requestIntro(me, c.byHandle(m[1]!)); c.json(res, r.status, r.body); return true;
    }
    if (req.method === "GET" && p === "/v1/me/intro-state") {   // People page: which cards can show "Introduce me" for this viewer
      const me = c.memberOf(req); if (!me) { c.json(res, 200, { member: false }); return true; }
      const pr = c.profile(me), out: Record<string, string> = {};
      for (const h of String(url.searchParams.get("h") || "").split(",").slice(0, 150)) { const o = c.byHandle(h.toLowerCase()); if (o && o.id !== me) out[o.handle] = introState(me, o.id); }
      c.json(res, 200, { member: true, handle: pr?.handle, state: out }); return true;
    }
    // the plugin: introductions waiting for you, and your answer (signed in with the vault's key)
    m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/intros$/);
    if (m && req.method === "GET") { if (c.authed(req) !== m[1]) { c.json(res, 401, { error: "sign in as this profile" }); return true; }
      c.json(res, 200, { intros: pendingFor(m[1]!), tags: tagsOf(c.profile(m[1]!)) }); return true; }
    m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/intros\/([a-z0-9-]+)$/);
    if (m && req.method === "POST") { if (c.authed(req) !== m[1]) { c.json(res, 401, { error: "sign in as this profile" }); return true; }
      const b = await c.readBody(req).catch(() => ({})) as { accept?: boolean; ask?: boolean }, other = c.byHandle(m[2]!);
      if (!other) { c.json(res, 404, { error: "unknown profile" }); return true; }
      const r = b.ask ? requestIntro(m[1]!, other) : decide(m[1]!, other.id, !!b.accept); c.json(res, r.status, r.body); return true; }
    return false;
  }

  return { tagsOf, problemOf, shared, topTags, similarStacks, stackCard, invalidateStacks: () => { stackMemo = null; }, relevance, introState, requestIntro, decide, pendingFor, chips, CHIP_CSS, route, job, tagSoon, schedule };
}
