/**
 * @mentions in feed posts, comments and group chat: "@handle" links to the member's page and sends them an alert.
 * Typing "@" in a text box marked data-mention suggests members (GET /v1/mentions?q=, signed-in members only).
 */

/** "@ana" at the start or after a space or punctuation; never inside an email address or a URL path. */
const MENTION_RE = /(^|[^\w@./:-])@([a-z0-9][a-z0-9_-]{0,38})(?![\w-])/gi;

/** The handles mentioned in a piece of text, lowercased, first 10. */
export function mentionedHandles(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || "").matchAll(MENTION_RE)) { const h = m[2].toLowerCase(); if (!out.includes(h)) out.push(h); if (out.length >= 10) break; }
  return out;
}

/** Link mentions in already-escaped HTML text (outside tags) when the handle is a real member. */
export function linkMentions(html: string, isMember: (handle: string) => boolean): string {
  return String(html).split(/(<[^>]*>)/).map((part, i, all) => {
    if (part.startsWith("<")) return part;
    const inLink = all.slice(0, i).reduce((n, p) => /^<a[\s>]/i.test(p) ? n + 1 : /^<\/a>/i.test(p) ? n - 1 : n, 0) > 0;   // link text stays as it is
    return inLink ? part : part.replace(MENTION_RE, (all0, pre, h) => isMember(h.toLowerCase()) ? `${pre}<a class="mention" href="/@${h.toLowerCase()}">@${h}</a>` : all0);
  }).join("");
}

/** Alert each member mentioned in `text` (not the author, not anyone in `skip`, at most 10). Returns who was told. */
export function tellMentioned(o: { text: string; author: string; skip?: Set<string>; byHandle: (h: string) => any; canSee: (pr: any) => boolean;
  tell: (to: string, a: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; key?: string }) => void; authorHandle: string; where: string; url: string; key: string }): string[] {
  const told: string[] = [], skip = o.skip || new Set<string>();
  const snip = o.text.length > 160 ? o.text.slice(0, 157) + "..." : o.text;
  for (const h of mentionedHandles(o.text)) {
    const pr = o.byHandle(h); if (!pr || pr.id === o.author || skip.has(pr.id) || !o.canSee(pr)) continue;
    skip.add(pr.id); told.push(pr.id);
    try { o.tell(pr.id, { title: `@${o.authorHandle} mentioned you ${o.where}`, body: snip, ctaLabel: "See it", ctaUrl: o.url, key: o.key + ":" + pr.id }); } catch { /* an alert never breaks a post */ }
  }
  return told;
}

/** Suggestions for the "@" picker: listed members whose handle starts with, or name contains, the query. */
export function mentionSearch(rows: any[], query: string, avatarOf: (pr: any) => string | null, n = 6) {
  const qv = String(query || "").toLowerCase().replace(/^@/, "").slice(0, 40);
  const score = (pr: any) => { const h = String(pr.handle || "").toLowerCase(), nm = String(pr.name || "").toLowerCase();
    return !qv ? 1 : h === qv ? 4 : h.startsWith(qv) ? 3 : nm.split(/\s+/).some((w: string) => w.startsWith(qv)) ? 2 : h.includes(qv) || nm.includes(qv) ? 1 : 0; };
  return rows.map(pr => ({ pr, s: score(pr) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || String(a.pr.handle).localeCompare(String(b.pr.handle))).slice(0, n)
    .map(({ pr }) => ({ handle: pr.handle as string, name: (pr.name || pr.handle) as string, avatar: avatarOf(pr) }));
}

export const MENTION_CSS = `.mention{color:var(--accent,#8b6cf6);font-weight:600;text-decoration:none}.mention:hover{text-decoration:underline}
.mn-pop{position:absolute;z-index:60;min-width:220px;max-width:320px;background:var(--bg-raised,#232327);border:1px solid var(--line-strong,#3a3a40);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:4px;font:14px var(--font-body,'IBM Plex Sans',Arial,sans-serif)}
.mn-pop button{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:7px 9px;border-radius:8px;cursor:pointer;color:var(--text,#dadadf)}
.mn-pop button.on,.mn-pop button:hover{background:var(--bg,#1c1c1f)}.mn-pop img,.mn-pop i{width:24px;height:24px;border-radius:50%;flex:none;object-fit:cover;background:var(--line,#2a2a2e)}
.mn-pop b{color:var(--text-strong,#f2f2f5);font-weight:600}.mn-pop span{color:var(--text-mut,#9a9aa3);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

/** The "@" picker for every textarea marked data-mention (also ones added later). Enter/Tab picks, Esc closes. */
export const MENTION_JS = `(function(){if(window.__mn)return;window.__mn=1;var pop=null,ta=null,items=[],on=0,seq=0,timer=0;
function close(){if(pop){pop.remove();pop=null}items=[]}
function word(t){var v=t.value.slice(0,t.selectionStart),m=v.match(/(^|[\\s(])@([a-z0-9_-]{0,38})$/i);return m?{q:m[2],at:v.length-m[2].length-1}:null}
function pick(i){var it=items[i];if(!it||!ta)return;var w=word(ta);if(!w){close();return}var v=ta.value,end=ta.selectionStart,ins='@'+it.handle+' ';ta.value=v.slice(0,w.at)+ins+v.slice(end);var c=w.at+ins.length;ta.setSelectionRange(c,c);ta.dispatchEvent(new Event('input',{bubbles:true}));close();ta.focus()}
function draw(){if(!items.length){close();return}if(!pop){pop=document.createElement('div');pop.className='mn-pop';pop.setAttribute('role','listbox');document.body.appendChild(pop)}
pop.innerHTML='';items.forEach(function(it,i){var b=document.createElement('button');b.type='button';b.setAttribute('role','option');if(i===on)b.className='on';
var av=it.avatar?document.createElement('img'):document.createElement('i');if(it.avatar){av.src=it.avatar;av.alt=''}b.appendChild(av);var tx=document.createElement('div');tx.style.minWidth='0';var nm=document.createElement('b');nm.textContent=it.name;var hd=document.createElement('span');hd.textContent=' @'+it.handle;tx.appendChild(nm);tx.appendChild(hd);b.appendChild(tx);
b.addEventListener('mousedown',function(e){e.preventDefault();pick(i)});pop.appendChild(b)});
var r=ta.getBoundingClientRect(),h=pop.offsetHeight,below=r.bottom+6+h<innerHeight;pop.style.left=(scrollX+r.left)+'px';pop.style.top=(scrollY+(below?r.bottom+6:r.top-h-6))+'px'}
function look(t){var w=word(t);if(!w){close();return}ta=t;var my=++seq;clearTimeout(timer);timer=setTimeout(function(){fetch('/v1/mentions?q='+encodeURIComponent(w.q),{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{people:[]}}).then(function(j){if(my!==seq||document.activeElement!==t)return;items=(j.people||[]);on=0;draw()}).catch(function(){})},120)}
document.addEventListener('input',function(e){var t=e.target;if(t&&t.matches&&t.matches('textarea[data-mention]'))look(t)});
document.addEventListener('keydown',function(e){if(!pop||e.target!==ta)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();on=(on+(e.key==='ArrowDown'?1:items.length-1))%items.length;draw()}else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();e.stopImmediatePropagation();pick(on)}else if(e.key==='Escape'){e.preventDefault();close()}},true);
document.addEventListener('focusout',function(e){if(e.target===ta)setTimeout(close,150)});addEventListener('scroll',function(){if(pop)close()},true)})();`;
