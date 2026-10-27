/**
 * The sign-up gate: a signed-out visitor who taps Follow, Message, Kudos (or comments, helps, replies in the feed) gets a
 * small panel that says what they were about to do and what joining takes (GitHub, or email: no GitHub needed), instead of being sent straight to GitHub's
 * permission screen. Built in the browser, so the page itself carries no /auth/github link for crawlers to follow; with no
 * JavaScript the buttons fall back to their plain links (Message -> the sign-up page that explains the same thing).
 *
 * calGate({ kind, title, name, avatar, gh, obsidian, start, signin, api, blank }) opens it. Each open counts once as the
 * funnel step "gate" (detail = kind) via POST /v1/funnel/gate, so gate -> click -> back can be read per action.
 */

export const GATE_KINDS = ["follow", "message", "kudos", "comment", "reply", "help", "post", "join"] as const;
export const okGateKind = (v: unknown) => (GATE_KINDS as readonly string[]).includes(String(v)) ? String(v) : "";

const GH = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="flex:none"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

export const GATE_CSS = `<style>.cg-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,7,12,.62);box-sizing:border-box}.cg-ov[hidden]{display:none}
.cg-box{position:relative;width:100%;max-width:400px;box-sizing:border-box;padding:22px 20px 18px;border-radius:18px;background:#18171D;border:1px solid #2E2A40;color:#E6E6EA;font:400 14px/1.5 'IBM Plex Sans',Arial,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.55);text-align:left}
.cg-x{all:unset;cursor:pointer;position:absolute;top:10px;right:10px;width:32px;height:32px;display:grid;place-items:center;border-radius:999px;color:#B8B8C2;font-size:20px;line-height:1}.cg-x:hover{background:#25222F;color:#fff}.cg-x:focus-visible{outline:2px solid #8B6CF6}
.cg-who{display:flex;align-items:center;gap:12px;margin:0 32px 12px 0}.cg-av{width:46px;height:46px;border-radius:50%;object-fit:cover;flex:none;background:#8B6CF6;color:#fff;display:grid;place-items:center;font:600 18px 'IBM Plex Sans',Arial,sans-serif}
.cg-t{margin:0;color:#F2F2F5;font:600 18px/1.3 'Source Serif 4',Georgia,serif;text-wrap:balance}.cg-p{margin:0 0 14px;color:#C9C6D3}.cg-p b{color:#F2F2F5;font-weight:600}
.cg-gh{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;box-sizing:border-box;min-height:46px;padding:0 16px;border-radius:999px;background:#F2F2F5;color:#111!important;font:600 15px 'IBM Plex Sans',Arial,sans-serif;text-decoration:none!important}.cg-gh:hover{background:#fff}.cg-gh:focus-visible{outline:2px solid #8B6CF6;outline-offset:2px}
.cg-em{display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;min-height:44px;margin-top:10px;padding:0 16px;border-radius:999px;border:1px solid #4A4560;color:#F2F2F5!important;font:600 15px 'IBM Plex Sans',Arial,sans-serif;text-decoration:none!important}.cg-em:hover{background:#25222F}.cg-em:focus-visible{outline:2px solid #8B6CF6;outline-offset:2px}
.cg-alt{display:flex;flex-wrap:wrap;gap:6px 14px;margin:14px 0 0;font-size:13px}.cg-alt a{color:#B9A6FF!important;text-decoration:none}.cg-alt a:hover{text-decoration:underline}
@media (max-width:620px){.cg-ov{align-items:flex-end;padding:0}.cg-box{max-width:none;border-radius:18px 18px 0 0;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}}</style>`;

/** Defines window.calGate. Every string goes in with textContent/attributes, never as HTML. */
export const GATE_JS = `(function(){if(window.calGate)return;var GH=${JSON.stringify(GH)},ov,last,counted={};
function el(t,c){var e=document.createElement(t);if(c)e.className=c;return e}
function close(){if(!ov||ov.hidden)return;ov.hidden=true;if(last&&last.focus)try{last.focus()}catch(e){}}
window.calGate=function(o){last=document.activeElement;if(!ov){ov=el('div','cg-ov');ov.hidden=true;ov.setAttribute('role','dialog');ov.setAttribute('aria-modal','true');ov.setAttribute('aria-labelledby','cg-t');document.body.appendChild(ov);
ov.addEventListener('click',function(e){if(e.target===ov)close()});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()})}
ov.textContent='';var box=el('div','cg-box'),x=el('button','cg-x');x.type='button';x.setAttribute('aria-label','Close');x.textContent='\\u00d7';x.addEventListener('click',close);box.appendChild(x);
var who=el('div','cg-who'),av;if(o.avatar){av=el('img','cg-av');av.src=o.avatar;av.alt=''}else{av=el('span','cg-av');av.setAttribute('aria-hidden','true');av.textContent=(o.name||'C').replace(/^@/,'').charAt(0).toUpperCase()}
var h=el('h2','cg-t');h.id='cg-t';h.textContent=o.title||'Join Caldera';who.appendChild(av);who.appendChild(h);box.appendChild(who);
var p=el('p','cg-p'),b=el('b');b.textContent='Join free with GitHub.';p.appendChild(b);p.appendChild(document.createTextNode(' Read-only: your public profile and email, never your code. About 10 seconds.'));box.appendChild(p);
var g=el('a','cg-gh');g.href=o.gh;g.rel='nofollow noopener';if(o.blank)g.target='_blank';g.innerHTML=GH;g.appendChild(document.createTextNode('Join free with GitHub'));box.appendChild(g);
if(o.start){var m=el('a','cg-em');m.href=o.start;m.rel='nofollow noopener';if(o.blank)m.target='_blank';m.textContent='Sign up with email';box.appendChild(m)}
var alt=el('p','cg-alt');[[o.obsidian,'Use Obsidian?'],[o.signin,'Already a member? Sign in']].forEach(function(a){if(!a[0])return;var l=el('a');l.href=a[0];l.rel='nofollow noopener';if(o.blank)l.target='_blank';l.textContent=a[1];alt.appendChild(l)});box.appendChild(alt);
ov.appendChild(box);ov.hidden=false;try{g.focus()}catch(e){}
var k=o.kind||'join';if(typeof o.api==='string'&&!counted[k]){counted[k]=1;try{fetch(o.api+'/v1/funnel/gate',{method:'POST',headers:{'content-type':'text/plain'},body:k,keepalive:true}).catch(function(){})}catch(e){}}};
window.calGate.close=close})();`;
