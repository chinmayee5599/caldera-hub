/**
 * Caldera Hub - reference hub for the Caldera protocol (spec/PROTOCOL.md).
 * Stores and indexes signed envelopes, hosts profile pages, delivers encrypted cards,
 * enforces the gravity and credit rules, and serves discovery and leaderboards.
 * Zero framework: node:http + node:sqlite (Node 22+).
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { github } from "./github";
import { cityArt, cardSvg, toPng, groupPage, ogTags } from "./cards";
import { emailer, type Mail } from "./email";
import { weatherService, dayStats, ownerSetup, extrasScript } from "./cityextra";
import { buildWorld, foldLive, worldPage, type World, type WorldMemberIn } from "./world";
import { citySnapshot } from "../../../../caldera/packages/plugin/src/city";

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export interface HubOptions { dataDir: string; port?: number; publicUrl?: string; siteDir?: string; trustProxy?: boolean;
  /** Private owner address (e.g. behind `tailscale serve`): a second listener on 127.0.0.1:privatePort that serves the
   *  owner's private view only when the proxy-set Tailscale-User-Login header maps to that profile's handle. */
  privatePort?: number; privateUrl?: string;
  /** Handle of the founder: every new profile starts out as their friend (MySpace's Tom). */ founder?: string; tailnetOwners?: Record<string, string>; githubFetch?: typeof fetch; onEvent?: (e: { type: "signup" | "delete"; handle?: string; name?: string; total: number }) => void; limits?: { perMinute?: number; writesPerMinute?: number; newProfilesPerDay?: number };
  /** daily summary emails: Resend key (production) or a send hook (tests); schedule starts the daily job */
  email?: { resendKey?: string; send?: (m: Mail) => Promise<void>; schedule?: boolean }; }

const MAX_BODY = 12 * 1024 * 1024;
const RESERVED = new Set(["admin", "api", "www", "caldera", "help", "support", "root", "hub", "v1", "about", "login", "settings", "official", "team", "security", "obsidian", "me", "auth", "setup"]);
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY" };
// User-uploaded profile pages run in a sandbox: unique origin, no access to the hub's origin, no forms, no top navigation.
const PROFILE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// The city page may also poll the hub for live traffic on the owner's sites (same hub only).
const cityCsp = (...origins: string[]) => PROFILE_CSP + `; connect-src 'self' ${origins.filter(Boolean).join(" ")}`.trimEnd();
const originOf = (u?: string) => { try { return u ? new URL(u).origin : ""; } catch { return ""; } };
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// Live-traffic snippet for the owner's own sites: <script async src="https://caldera.social/t.js" data-site="KEY"></script>
// Counts page views (and single-page navigations); caldera("signup") / caldera("buy") mark conversions. No cookies.
const TRACK_JS = `(function(){var s=document.currentScript;if(!s)return;var k=s.getAttribute('data-site');if(!k)return;var base=s.src.replace(/\\/t\\.js.*$/,'');
function send(kind){var u=base+'/v1/t/'+encodeURIComponent(k)+'.gif?k='+(kind||'view')+'&r='+Math.random().toString(36).slice(2);try{if(navigator.sendBeacon&&navigator.sendBeacon(u))return}catch(e){}var i=new Image();i.src=u}
window.caldera=function(kind){send(kind==='signup'||kind==='buy'?kind:'view')};send('view');var last=location.pathname;
function nav(){if(location.pathname!==last){last=location.pathname;send('view')}}var ps=history.pushState;history.pushState=function(){var r=ps.apply(this,arguments);nav();return r};addEventListener('popstate',nav)})();`;
const DAY = 86_400_000;

/** Platform bar injected at the top of every hosted profile: logo back to the hub + a sign-up call to action.
 *  Inline styles/SVG only (the profile CSP allows inline styles and blocks external resources). */
/** Kudos a member can send: stored by key, shown as emoji. */
export const KUDOS: Record<string, string> = { heart: "\u2764\uFE0F", up: "\u{1F44D}", fire: "\u{1F525}", sparkle: "\u2728" };
/** Who's looking, for the inline kudos + friend controls: a signed-in member gets a short-lived action token. */
export interface BarViewer { handle: string; token: string; sent: string | null; friend: FriendState }
export type FriendState = "self" | "friends" | "incoming" | "requested" | "queued" | "none";
export interface BarSocial { views: number; showViews: boolean; tally: [string, number][]; owner: boolean; viewer?: BarViewer | null; inPage?: boolean }
export const FRIEND_LABEL: Record<FriendState, string> = { self: "", friends: "Friends \u2713", incoming: "Accept friend request", requested: "Friend request sent", queued: "Requested \u00b7 sends from your Obsidian", none: "+ Add friend" };
const compact = (n: number) => n < 1000 ? String(n) : n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : Math.round(n / 1000) + "k";
export interface OwnerNav { handle: string; current: "public" | "private"; publicHref: string; privateHref: string; privateExternal?: boolean; signout: string; note?: string; stale?: number }
const LOGO = `<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" style="display:block"><path d="M3 26 L11 10 L14 15 L17 8 L29 26 Z" fill="#8B6CF6"/><path d="M11 10 L14 15 L17 8" fill="none" stroke="#F2F2F5" stroke-width="1.2"/><circle cx="16" cy="21" r="2.4" fill="#4FB89A"/></svg>`;
const BAR_CSS = `<style>#caldera-bar{position:relative;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:8px 12px;min-height:46px;box-sizing:border-box;padding:7px 16px;background:#111113;border-bottom:1px solid #2A2A2E;font:500 13.5px/1.2 'IBM Plex Sans','Helvetica Neue',Arial,sans-serif;color:#D6D6DC}
#caldera-bar a{text-decoration:none}#caldera-bar .cb-l,#caldera-bar .cb-r{display:inline-flex;align-items:center;gap:10px;min-width:0}
#caldera-bar .cb-brand{display:inline-flex;align-items:center;gap:8px;color:#F2F2F5;font:600 15px 'Source Serif 4',Georgia,serif;white-space:nowrap}#caldera-bar .cb-l>.cb-brand:first-child:not(:last-child){width:84px;flex:none;overflow:hidden}
#caldera-bar .cb-sw{display:inline-flex;background:#1F1C2B;border:1px solid #2E2A40;border-radius:999px;padding:2px}#caldera-bar .cb-sw a{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;color:#B8B8C2;white-space:nowrap}
#caldera-bar .cb-sw a[aria-current="page"]{background:#8B6CF6;color:#fff;font-weight:600}
#caldera-bar .cb-btn{display:inline-flex;align-items:center;min-height:30px;padding:0 14px;border-radius:999px;background:#8B6CF6;color:#fff;font-weight:600;white-space:nowrap}
#caldera-bar details{position:relative}#caldera-bar summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 10px;border-radius:999px;border:1px solid #2E2A40;color:#F2F2F5;white-space:nowrap}#caldera-bar summary::-webkit-details-marker{display:none}
#caldera-bar .cb-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:190px;background:#18171D;border:1px solid #2E2A40;border-radius:12px;padding:6px;box-shadow:0 12px 30px rgba(0,0,0,.45);display:flex;flex-direction:column}
#caldera-bar .cb-menu a{padding:8px 10px;border-radius:8px;color:#E6E6EA}#caldera-bar .cb-menu a:hover{background:#26232F}#caldera-bar .cb-menu small{padding:4px 10px 6px;color:#8A8A93;font-size:11.5px;line-height:1.35}
#caldera-bar .cb-stale{color:#F2C46D;font-size:12.5px;white-space:nowrap}#caldera-bar .cb-short{display:none}
@media (max-width:620px){#caldera-bar .cb-tag,#caldera-bar .cb-v,#caldera-bar .cb-word{display:none}#caldera-bar .cb-l>.cb-brand:first-child:not(:last-child){width:22px}#caldera-bar{flex-wrap:wrap}#caldera-bar .cb-sw a{padding:5px 10px}#caldera-bar .cb-short{display:inline}#caldera-bar.cb-anon .cb-l .cb-brand span:first-of-type{display:none}#caldera-bar .cb-r{gap:8px}}</style>`;

/** Views and kudos on every hosted page: a public tally plus "+ Kudos", which opens a small first-party window on the hub
 *  (profile pages are sandboxed, so the member's sign-in can only ride along there). */
function socialChips(base: string, handle: string, so: BarSocial): string {
  const e = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const chip = "display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 10px;border-radius:999px;background:var(--bg-raised,#1C1C21);border:1px solid var(--line,#2A2A2E);color:var(--text,#D6D6DC);font:500 12.5px 'IBM Plex Sans',Arial,sans-serif;white-space:nowrap";
  const views = so.showViews || so.owner ? `<span class="cb-views" title="${so.views.toLocaleString("en-US")} views${so.showViews ? "" : " (hidden: only you see this)"}" style="${chip}">&#128065;&#65039; ${compact(so.views)}${so.showViews ? "" : `<span style="color:var(--text-muted,#8A8A93)">&nbsp;&middot; hidden</span>`}</span>` : "";
  const count = (k: string) => so.tally.find(([x]) => x === k)?.[1] || 0;
  if (so.owner) {
    const tally = so.tally.filter(([, n]) => n > 0).map(([k, n]) => `${KUDOS[k] || ""} ${compact(n)}`).join(" &nbsp;");
    return `<span class="cb-social">${views}${tally ? `<span title="Kudos people sent you" style="${chip}">${tally}</span>` : ""}</span>`;
  }
  // everyone else: the emoji row and Add friend act right here on the page (signed-in members, with the action token)
  const v = so.viewer || null, sent = v?.sent || null;
  const kd = Object.entries(KUDOS).map(([k, em]) => `<button type="button" class="cb-k${sent === k ? " on" : ""}" data-k="${k}"${sent ? ` disabled title="You sent kudos today. More tomorrow."` : ` title="Send @${e(handle)} ${em}"`}>${em}<i>${count(k) ? compact(count(k)) : ""}</i></button>`).join("");
  const fs = v ? v.friend : "none";
  const fr = fs === "self" ? "" : `<button type="button" class="cb-fr" data-caldera-friend="${e(handle)}" data-state="${fs}"${fs === "friends" || fs === "requested" || fs === "queued" ? " disabled" : ""}>${e(FRIEND_LABEL[fs])}</button>`;
  return `<span class="cb-social"${v ? ` data-act="${e(v.token)}"` : ""} data-api="${e(base)}" data-h="${e(handle)}">${views}<span class="cb-kd" role="group" aria-label="Send kudos">${kd}</span>${fr}</span>`;
}

/** Inline kudos + friend for hosted pages: talks to /v1/act with the token the hub put in the page (the page is sandboxed
 *  with no cookies, so the token is the only credential). Anonymous visitors get a small sign-in prompt instead. */
const BAR_ACT_JS = `(function(){function go(){var S=document.querySelector('.cb-social[data-api]');if(!S)return;var api=S.getAttribute('data-api'),t=S.getAttribute('data-act'),H=S.getAttribute('data-h');
var L={friends:'Friends \\u2713',incoming:'Accept friend request',requested:'Friend request sent',queued:'Requested \\u00b7 sends from your Obsidian',none:'+ Add friend'};
function need(el){var p=document.getElementById('cb-need');if(!p)return;p.hidden=false;var r=el.getBoundingClientRect();p.style.top=(r.bottom+window.scrollY+8)+'px';p.style.left=Math.max(8,Math.min(r.left,window.innerWidth-300))+'px'}
document.addEventListener('click',function(ev){var p=document.getElementById('cb-need');if(p&&!p.hidden&&!p.contains(ev.target)&&!ev.target.closest('.cb-k,[data-caldera-friend]'))p.hidden=true});
function post(o){o.t=t;return fetch(api+'/v1/act',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(o)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}})},function(){return{ok:false,status:0,j:{error:'Could not reach Caldera. Check your connection.'}}})}
function burst(el,em){var r=el.getBoundingClientRect();for(var i=0;i<14;i++){var s=document.createElement('span');s.textContent=em;s.style.cssText='position:fixed;z-index:99;pointer-events:none;font-size:22px;left:'+(r.left+r.width/2-11)+'px;top:'+(r.top)+'px;transition:transform 1.3s cubic-bezier(.2,.7,.3,1),opacity 1.3s';document.body.appendChild(s);(function(s){requestAnimationFrame(function(){s.style.transform='translate('+(Math.random()*160-80)+'px,'+(120+Math.random()*120)+'px) scale(1.3)';s.style.opacity='0'});setTimeout(function(){s.remove()},1400)})(s)}}
function tip(el,msg){el.title=msg;var p=document.createElement('span');p.className='cb-tip';p.textContent=msg;var r=el.getBoundingClientRect();p.style.top=(r.bottom+window.scrollY+6)+'px';p.style.left=Math.max(8,Math.min(r.left,window.innerWidth-260))+'px';document.body.appendChild(p);setTimeout(function(){p.remove()},2600)}
var ks=S.querySelectorAll('.cb-k');ks.forEach(function(b){b.addEventListener('click',function(){if(!t)return need(b);ks.forEach(function(x){x.disabled=true});post({action:'kudos',kind:b.getAttribute('data-k')}).then(function(x){
if(x.ok){b.classList.add('on','pop');var i=b.querySelector('i');var n=parseInt((i.textContent||'0'),10);if(!isNaN(n)&&!/k$/.test(i.textContent))i.textContent=String(n+1);else if(!i.textContent)i.textContent='1';burst(b,b.firstChild.textContent);tip(b,'Sent! @'+H+' will see it.');ks.forEach(function(x){x.title='You sent kudos today. More tomorrow.'})}
else{tip(b,x.j.error||'Could not send.');if(x.status!==409)ks.forEach(function(y){y.disabled=false})}})})});
function setF(st){document.querySelectorAll('[data-caldera-friend]').forEach(function(f){if(!L[st])return;f.setAttribute('data-state',st);if(f.classList.contains('cb-fr'))f.textContent=L[st];else f.textContent=st==='none'?'+ Add @'+H+' as friend':st==='incoming'?'Accept @'+H+"'s friend request":L[st];if(st!=='none'&&st!=='incoming'){if(f.tagName==='BUTTON')f.disabled=true;else f.setAttribute('aria-disabled','true')}})}
document.querySelectorAll('[data-caldera-friend]').forEach(function(f){f.addEventListener('click',function(ev){ev.preventDefault();if(!t)return need(f);var st=f.getAttribute('data-state')||'none';if(st!=='none'&&st!=='incoming')return;
post({action:st==='incoming'?'accept':'friend'}).then(function(x){if(x.ok){setF(x.j.state);tip(f,x.j.state==='friends'?'You and @'+H+' are friends.':x.j.state==='queued'?'Queued. It sends from your Obsidian the next time it is open.':'Friend request sent to @'+H+'.')}else tip(f,x.j.error||'Could not send the request.')})})})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go()})();`;

const BAR_ACT_CSS = `<style>.cb-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 18px}.cb-row .cb-social{gap:8px}.cb-social .cb-social{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}.cb-social .cb-kd{display:inline-flex;gap:2px;padding:1px;border-radius:999px;background:var(--bg-raised,#1C1C21);border:1px solid var(--line,#2A2A2E)}
.cb-social .cb-k{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:3px;min-height:24px;padding:0 7px;border-radius:999px;font-size:14px;line-height:1;transition:transform .15s,background .15s}.cb-social .cb-k i{font:500 11.5px 'IBM Plex Sans',Arial,sans-serif;font-style:normal;color:var(--text-muted,#B8B8C2);font-variant-numeric:tabular-nums}
.cb-social .cb-k:hover:not(:disabled){background:var(--bg-sunken,#2A2636);transform:translateY(-1px) scale(1.08)}.cb-social .cb-k:disabled{cursor:default;opacity:.55}.cb-social .cb-k.on{opacity:1;background:var(--accent-soft,#3A2F5C)}.cb-social .cb-k.pop{animation:cbpop .45s ease-out}
@keyframes cbpop{40%{transform:scale(1.35)}}.cb-social .cb-k:focus-visible,.cb-social .cb-fr:focus-visible{outline:2px solid #8B6CF6;outline-offset:1px}
.cb-social .cb-fr{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:26px;padding:0 11px;border-radius:999px;border:1px solid var(--accent,#5B47B8);color:var(--text-strong,#F2F2F5);font:600 12.5px 'IBM Plex Sans',Arial,sans-serif;font-weight:600;white-space:nowrap}.cb-social .cb-fr:disabled{cursor:default;border-color:var(--line,#2A2A2E);color:var(--text-muted,#9A9AA6);font-weight:500}.cb-social .cb-fr[data-state="incoming"]{background:#8B6CF6;border-color:#8B6CF6}
.cb-tip,#cb-need{position:absolute;z-index:100;max-width:280px;padding:8px 11px;border-radius:10px;background:#18171D;border:1px solid #2E2A40;color:#E6E6EA;font:500 12.5px/1.4 'IBM Plex Sans',Arial,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.45)}#cb-need[hidden]{display:none}
#cb-need b{display:block;margin-bottom:6px;color:#F2F2F5}#cb-need a{display:inline-flex;margin:4px 6px 0 0;padding:5px 11px;border-radius:999px;background:#8B6CF6;color:#fff;text-decoration:none;font-weight:600}#cb-need a.alt{background:transparent;border:1px solid #2E2A40;color:#E6E6EA}
@media (max-width:620px){.cb-social .cb-k{padding:0 5px}.cb-social .cb-k i:empty{display:none}}@media (prefers-reduced-motion:reduce){.cb-social .cb-k.pop{animation:none}}</style>`;

/** The social row under the person's name on their profile and city: views, kudos and Add friend belong to the person,
 *  not to the site bar. Carries the sign-in prompt and the inline actions script. */
export function socialRow(hub: string, handle: string, so: BarSocial): string {
  const base = hub.replace(/\/$/, ""), join = `${base}/?invite=${encodeURIComponent(handle)}`;
  const need = !so.owner && !so.viewer ? `<div id="cb-need" hidden role="dialog" aria-label="Sign in"><b>Sign in to send kudos and add friends</b>Caldera members can cheer each other on.<br><a href="${base}/auth/github" target="_blank" rel="noopener">Sign in with GitHub</a><a class="alt" href="${base}/signin" target="_blank" rel="noopener">Other ways</a><a class="alt" href="${join}#install" target="_blank" rel="noopener">Get your own page</a></div>` : "";
  return BAR_ACT_CSS + `<div class="cb-row">${socialChips(base, handle, so)}</div>` + need + (so.owner ? "" : `<script>${BAR_ACT_JS}</script>`);
}

/** THE Caldera bar: one component on every page that has one. Anonymous: logo, Owner? Sign in, Get your own page. Owner
 *  (public page with the owner cookie, or the private address): logo, the [Public view | Private view] switch in the same
 *  place on both addresses, then the account menu (@handle, Your public page, Private view, Sign out). Same height either way. */
export function calderaBar(hub: string, handle: string, own?: OwnerNav | null, social?: BarSocial): string {
  const base = hub.replace(/\/$/, ""), join = `${base}/?invite=${encodeURIComponent(handle)}`;
  const e = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const chips = social && !social.inPage ? socialChips(base, handle, social) : "";
  if (!own) {
    const v = social?.viewer || null;
    // anyone tapping kudos or Add friend without being signed in gets this small prompt (sign-in opens in a new window:
    // the page is sandboxed and can't navigate the top window)
    const need = social && !social.inPage ? `<div id="cb-need" hidden role="dialog" aria-label="Sign in"><b>Sign in to send kudos and add friends</b>Caldera members can cheer each other on.<br><a href="${base}/auth/github" target="_blank" rel="noopener">Sign in with GitHub</a><a class="alt" href="${base}/signin" target="_blank" rel="noopener">Other ways</a><a class="alt" href="${join}#install" target="_blank" rel="noopener">Get your own page</a></div>` : "";
    const right = v ? `<a href="${base}/@${encodeURIComponent(v.handle)}/" title="Signed in as @${e(v.handle)}" style="color:#B8B8C2;font-size:12.5px;white-space:nowrap">@${e(v.handle)}</a>`
      : `<a href="${base}/signin?h=${encodeURIComponent(handle)}" rel="nofollow" style="color:#8A8A93;font-size:12.5px;white-space:nowrap"><span class="cb-tag">Owner? </span>Sign in</a>`;
    return BAR_CSS + (social && !social.inPage ? BAR_ACT_CSS : "") + `<div id="caldera-bar" class="cb-anon"><span class="cb-l"><a class="cb-brand" href="${join}">${LOGO}<span>Caldera</span><span class="cb-tag" style="font:400 12.5px 'IBM Plex Sans',Arial,sans-serif;color:#8A8A93;margin-left:4px">the social network for GitHub and Obsidian</span></a></span>`
      + chips + `<span class="cb-r">${right}${v ? "" : `<a class="cb-btn" href="${join}#install"><span class="cb-tag">Get your own page</span><span class="cb-short">Get a page</span></a>`}</span></div>` + need + (social && !social.inPage ? `<script>${BAR_ACT_JS}</script>` : "");
  }
  const ext = own.privateExternal ? ' target="_blank" rel="noopener"' : "";
  const sw = `<span class="cb-sw" role="group" aria-label="Which view"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${own.current === "public" ? "You're viewing your public page" : "Private address: you're in your private view"}</span>`
    + `<a href="${e(own.publicHref)}"${own.current === "public" ? ' aria-current="page"' : ""} title="Your page as everyone sees it">&#127760;<span class="cb-v"> Public view</span></a>`
    + `<a href="${e(own.privateHref)}"${ext}${own.current === "private" ? ' aria-current="page"' : ""} title="Your page with the private sections only you see">&#128274;<span class="cb-v"> Private view</span></a></span>`;
  const menu = `<details><summary aria-label="Account">@${e(own.handle)} <span aria-hidden="true">&#9662;</span></summary><span class="cb-menu">`
    + `<a href="${e(own.publicHref)}">Your public page</a><a href="${e(own.privateHref)}"${ext}>Private view</a>`
    + (own.note ? `<small>${e(own.note)}</small>` : "") + `<a href="${e(own.signout)}">Sign out</a></span></details>`;
  return BAR_CSS + `<div id="caldera-bar"><span class="cb-l"><a class="cb-brand" href="${base}/" title="Caldera">${LOGO}<span class="cb-word">Caldera</span></a>${sw}</span>`
    + chips + `<span class="cb-r">${own.stale ? `<span class="cb-stale" title="Your page updates while Obsidian is open. Open it to refresh the page.">Last updated ${own.stale} days ago</span>` : ""}${menu}</span></div>`;
}

/** Heatmap fix for profiles built before plugin 0.5.1 (their profile.css is frozen in the bundle): cells fill the column,
 *  room for the hover zoom, no stray scrollbar. Same rules as profile.css "Heatmap sizing (2026-10-12)". */
const HEAT_FIX = `<style>/* Heatmap sizing (2026-10-12) */.heat-box{container-type:inline-size}.heat-frame{--gap:3px;--cell:clamp(8px,calc((100cqw - 46px - 25 * var(--gap)) / 26),18px)}@container (max-width:460px){.heat-frame{--gap:2px}}.heat,.heat-days{gap:var(--gap,3px)}.heat-days{grid-template-rows:repeat(7,var(--cell,12px));line-height:var(--cell,12px)}.heat-wrap{overflow-x:auto;overflow-y:hidden;padding:4px;margin:-4px;scrollbar-width:none}.heat-wrap::-webkit-scrollbar{display:none}.heat{grid-template-rows:repeat(7,var(--cell,12px));grid-auto-columns:var(--cell,12px)}.heat i{width:var(--cell,12px);height:var(--cell,12px);border-radius:3px}.heat i[data-d]:hover,.heat i.is-sel{transform:scale(1.18)}</style>`;

/** caldera.social/gardens: the stream that serves the gardens - notes recently planted or tended, across every listed profile. */
function gardensPage(notes: { handle: string; name: string; slug: string; title: string; stage: string; updated: string; excerpt: string; words: number }[], hub: string): string {
  const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const icon: Record<string, string> = { seedling: "&#127793;", budding: "&#127807;", evergreen: "&#127795;" };
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const gardens = new Set(notes.map(n => n.handle)).size;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recently tended - Caldera gardens</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>:root{--bg:#111113;--raised:#18181B;--line:#2A2A2F;--text:#E6E6EA;--muted:#8A8A93;--strong:#F7F7FA;--accent:#8B6CF6;--accent-text:#B9A6FF}
@media (prefers-color-scheme: light){:root{--bg:#FAFAF7;--raised:#FFF;--line:#E4E4DF;--text:#26262B;--muted:#6B6B73;--strong:#111;--accent:#6E4FE0;--accent-text:#5A3CD0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 'IBM Plex Sans',system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}a{color:var(--accent-text);text-decoration:none}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px}.top a.home{color:var(--strong);font:600 17px 'Source Serif 4',Georgia,serif}
h1{font:600 2rem/1.15 'Source Serif 4',Georgia,serif;color:var(--strong);margin:0 0 8px}p.lede{color:var(--muted);margin:0 0 24px}
.card{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--raised);margin-bottom:10px;color:var(--text)}
.card:hover{border-color:var(--accent)}.t{font:600 1.08rem 'Source Serif 4',Georgia,serif;color:var(--strong)}.x{color:var(--muted);font-size:14px;margin:4px 0 6px}
.m{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--muted)}.who{color:var(--accent-text)}.st{text-transform:capitalize}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:24px;text-align:center}</style></head><body><main>
<div class="top"><a class="home" href="${e(hub)}/">Caldera</a><a href="${e(hub)}/people">People</a></div>
<h1>Recently tended</h1>
<p class="lede">Notes planted or updated in public gardens on Caldera${notes.length ? ` - ${notes.length} notes from ${gardens} garden${gardens === 1 ? "" : "s"}` : ""}. A garden is a set of notes grown in the open: seedlings are rough, evergreens are worked through.</p>
${notes.length ? notes.map(n => `<a class="card" href="/@${e(n.handle)}/n/${e(n.slug)}.html"><div class="t">${e(n.title)}</div>${n.excerpt ? `<div class="x">${e(n.excerpt)}</div>` : ""}<div class="m"><span class="who">@${e(n.handle)}</span><span class="st">${icon[n.stage] || ""} ${e(n.stage)}</span><span>Tended ${day(n.updated)}</span><span>${Number(n.words).toLocaleString("en-US")} words</span></div></a>`).join("\n")
    : `<div class="empty">No public gardens yet. Plant a note: put it in your vault's Garden folder.</div>`}
</main></body></html>`;
}

/** /watch/@handle: the city alone in a small window, to leave in a corner of the screen and watch all day. This page is
 *  the hub's own (not user content), so it can open a Document Picture-in-Picture window that stays on top (Chrome, Edge)
 *  and move the sandboxed city frame into it. Elsewhere it is just a small window with the city filling it. */
const WATCH_CSP = "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function watchPage(name: string, src: string): string {
  const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const FRAME_CSS = "html,body{margin:0;height:100%;background:#010207;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(name)}'s city</title><meta name="robots" content="noindex"><style>${FRAME_CSS}
body{font:12px/1.4 ui-monospace,'IBM Plex Mono',Menlo,monospace;color:#BFF8FF}
#pin{position:fixed;top:6px;left:6px;z-index:5;padding:3px 10px;border-radius:999px;border:1px solid rgba(61,242,255,.5);background:rgba(2,6,12,.88);color:#BFF8FF;font:inherit;cursor:pointer;opacity:.0;transition:opacity .2s}
body:hover #pin,#pin:focus{opacity:1}
#away{display:none;position:fixed;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:8px;text-align:center;padding:16px}
#away button{padding:4px 12px;border-radius:999px;border:1px solid rgba(61,242,255,.5);background:transparent;color:#BFF8FF;font:inherit;cursor:pointer}
body.floating #away{display:flex}body.floating #pin{display:none}</style></head><body>
<iframe id="c" src="${e(src)}" title="${e(name)}'s city"></iframe>
<button id="pin" type="button" hidden title="Float the city in a small window that stays on top of everything">&#128204; Keep on top</button>
<div id="away"><div>Your city is floating on top.</div><div style="opacity:.7">Minimize this window but keep it open: closing it closes the floating city too.</div><button id="back" type="button">Bring it back here</button></div>
<script>(function(){var d=window.documentPictureInPicture,f=document.getElementById('c'),pin=document.getElementById('pin'),pw=null;
if(!d)return;pin.hidden=false;
pin.onclick=function(){d.requestWindow({width:420,height:260}).then(function(w){pw=w;var s=w.document.createElement('style');s.textContent=${JSON.stringify(FRAME_CSS)};w.document.head.appendChild(s);w.document.title=document.title;
  w.document.body.appendChild(f);document.body.classList.add('floating');
  w.addEventListener('pagehide',function(){document.body.insertBefore(f,document.body.firstChild);document.body.classList.remove('floating');pw=null})}).catch(function(){})};
document.getElementById('back').onclick=function(){if(pw)pw.close()}})();</script></body></html>`;
}

export function createHub(opts: HubOptions) {
  fs.mkdirSync(path.join(opts.dataDir, "profiles"), { recursive: true });
  const db = new DatabaseSync(path.join(opts.dataDir, "hub.sqlite"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS envelopes (hash TEXT PRIMARY KEY, type TEXT, sender TEXT, recipient TEXT, ts TEXT, json TEXT);
    CREATE INDEX IF NOT EXISTS env_to ON envelopes(recipient, ts);
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, handle TEXT UNIQUE, box_key TEXT, name TEXT, headline TEXT,
      manifest TEXT, updated TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS friends (a TEXT, b TEXT, ts TEXT, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS gravity (sender TEXT, recipient TEXT, ts TEXT, reason TEXT, ask TEXT);
    CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, author TEXT, title TEXT, detail TEXT, bounty INTEGER, tags TEXT,
      visibility TEXT, status TEXT, ts TEXT, awarded_to TEXT);
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, author TEXT, title TEXT, detail TEXT, tags TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS ledger (who TEXT, delta INTEGER, reason TEXT, ref TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT, nonce TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, id TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS moderation (handle TEXT PRIMARY KEY, id TEXT, action TEXT, reason TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS garden_notes (owner TEXT, handle TEXT, slug TEXT, title TEXT, stage TEXT, license TEXT, updated TEXT, excerpt TEXT,
      words INTEGER, sha256 TEXT, PRIMARY KEY (owner, slug));
    CREATE INDEX IF NOT EXISTS garden_recent ON garden_notes(updated);
    CREATE TABLE IF NOT EXISTS garden_links (owner TEXT, src_handle TEXT, src_slug TEXT, src_title TEXT, dst_handle TEXT, dst_slug TEXT);
    CREATE INDEX IF NOT EXISTS garden_dst ON garden_links(dst_handle, dst_slug);
    CREATE TABLE IF NOT EXISTS page_views (handle TEXT, path TEXT, ts TEXT, visitor TEXT);
    CREATE TABLE IF NOT EXISTS owner_private (owner TEXT PRIMARY KEY, blob TEXT, built TEXT, ts TEXT);
    CREATE INDEX IF NOT EXISTS views_by_handle ON page_views(handle, ts);
    CREATE TABLE IF NOT EXISTS traffic_sites (key TEXT PRIMARY KEY, owner TEXT, project TEXT, public INTEGER, secret TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS traffic (key TEXT, ts TEXT, kind TEXT, visitor TEXT);
    CREATE INDEX IF NOT EXISTS traffic_by_key ON traffic(key, ts);
    CREATE TABLE IF NOT EXISTS client_versions (owner TEXT, kind TEXT, v TEXT, PRIMARY KEY (owner, kind));
    CREATE TABLE IF NOT EXISTS agent_keys (key TEXT PRIMARY KEY, owner TEXT UNIQUE, secret TEXT, repos TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, owner TEXT, created TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS signin_links (code_hash TEXT PRIMARY KEY, owner TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS pair_codes (poll_hash TEXT PRIMARY KEY, code_hash TEXT, owner TEXT, expires INTEGER, approved INTEGER);
    CREATE TABLE IF NOT EXISTS owner_links (code_hash TEXT PRIMARY KEY, owner TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS agents (owner TEXT, id TEXT, label TEXT, machine TEXT, repo TEXT, state TEXT, task TEXT, did TEXT, tokens INTEGER, ts TEXT, PRIMARY KEY (owner, id));
    CREATE TABLE IF NOT EXISTS referrals (invitee TEXT PRIMARY KEY, inviter TEXT, ts TEXT, via TEXT);
    CREATE INDEX IF NOT EXISTS referrals_by_inviter ON referrals(inviter);
    CREATE TABLE IF NOT EXISTS kudos (sender TEXT, recipient TEXT, kind TEXT, ts TEXT, day TEXT, page TEXT, PRIMARY KEY (sender, recipient, day));
    CREATE TABLE IF NOT EXISTS friend_intents (owner TEXT, target TEXT, kind TEXT, request TEXT, ts TEXT, PRIMARY KEY (owner, target));
    CREATE INDEX IF NOT EXISTS kudos_to ON kudos(recipient, ts);
  `);
  // Page views for the owner's private "Since you last looked": no IPs or user agents are stored, only a salted hash
  // that rotates daily (counts unique visitors per day, cannot be reversed or joined across days).
  const VIEW_SALT = crypto.randomBytes(16).toString("hex");
  // Private owner layer at rest: AES-256-GCM with a key file that never leaves this server.
  const keyFile = path.join(opts.dataDir, "private.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const PRIV_KEY = fs.readFileSync(keyFile);
  const seal = (s: string) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", PRIV_KEY, iv);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); };
  const unseal = (b: string) => { const buf = Buffer.from(b, "base64"), d = crypto.createDecipheriv("aes-256-gcm", PRIV_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"); };
  const owners = opts.tailnetOwners || {};
  const privateFor = (handle: string) => opts.privateUrl && Object.values(owners).includes(handle) ? `${opts.privateUrl.replace(/\/$/, "")}/@${handle}/` : undefined;
  const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|node|headless|monitor|lighthouse|facebookexternalhit|embedly|discord|slack|telegram|whatsapp/i;
  const q = (sql: string) => db.prepare(sql);
  const now = () => new Date().toISOString();

  // ---------------------------------------------------------------- helpers
  const profile = (id: string) => q("SELECT * FROM profiles WHERE id=?").get(id) as any;
  const byHandle = (h: string) => q("SELECT * FROM profiles WHERE handle=?").get(h) as any;
  // operator moderation (Terms s.3): hidden = taken down, owner cannot republish; blocked = handle can never be claimed
  const modOf = (handle: string | null, id?: string) => q("SELECT * FROM moderation WHERE handle=? OR (id IS NOT NULL AND id=?)").get(handle || "", id || "") as any;
  const body = (pr: any) => { try { return JSON.parse(pr.manifest).body || {}; } catch { return {}; } };
  const listed = (pr: any) => body(pr).listed !== false && !modOf(pr.handle, pr.id);
  const areFriends = (a: string, b: string) => !!q("SELECT 1 FROM friends WHERE a=? AND b=?").get(a, b);
  const balance = (id: string) => (q("SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE who=?").get(id) as any).s as number;

  // ---------------------------------------------------------------- growth: referrals, open requests, suggestions
  const INVITE_REWARD = 25;
  const invitedCount = (id: string) => (q("SELECT COUNT(*) n FROM referrals WHERE inviter=?").get(id) as any).n as number;
  /** Someone joined from an invite link: remember who brought them (once), and thank the inviter with help credits. */
  function recordReferral(invitee: string, inviterHandle: unknown, via: string): string | null {
    const h = String(inviterHandle || "").toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(h)) return null;
    const inv = byHandle(h); if (!inv || inv.id === invitee || modOf(inv.handle, inv.id)) return null;
    if (q("SELECT 1 FROM referrals WHERE invitee=?").get(invitee)) return null;
    q("INSERT INTO referrals VALUES (?,?,?,?)").run(invitee, inv.id, now(), via.slice(0, 20));
    const who = profile(invitee)?.handle;
    q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(inv.id, INVITE_REWARD, `invited ${who ? "@" + who : "a friend"}`, invitee, now());
    return inv.id as string;
  }
  /** Open friend requests both ways (one row per person, newest wins), skipping people who are already friends. */
  function openRequests(id: string) {
    const open = (rows: any[], other: (e: C.Envelope) => string) => {
      const by = new Map<string, any>();
      for (const r of rows) { const e = JSON.parse(r.json) as C.Envelope<any>, o = other(e); if (areFriends(id, o)) continue;
        const pr = profile(o) as any; by.set(o, { request: r.hash, id: o, handle: pr?.handle || null, name: pr?.name || null, note: String(e.body?.note || "").slice(0, 200), ts: e.ts }); }
      return [...by.values()].reverse();
    };
    const inc = q("SELECT hash, json FROM envelopes WHERE type='friend.request' AND recipient=? ORDER BY ts").all(id) as any[];
    const out = q("SELECT hash, json FROM envelopes WHERE type='friend.request' AND sender=? ORDER BY ts").all(id) as any[];
    return { incoming: open(inc, e => e.from), outgoing: open(out, e => e.body.to) };
  }
  const STOP = new Set("the and for with that this from your you are was have has into about what when where who how all can will just more than then them they their our out not but get got use using also over under each make made like into onto very much many some any its it's i'm on in of to a an at by as is be or my me we us on github vault notes obsidian building builder".split(" "));
  const words = (s: unknown) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9+#.]+/).map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w.length > 2 && !STOP.has(w)));
  const interests = (pr: any) => { const b = body(pr);
    return { topics: new Set<string>([...(b.topics || []).map((t: any) => String(Array.isArray(t) ? t[0] : t).toLowerCase()), ...(b.languages || []).map((l: any) => String(l).toLowerCase())]),
      words: words(`${pr.headline || ""} ${b.summary || ""}`), groups: new Set<string>((b.groups || []).map((g: any) => String(g))) }; };
  /** People worth meeting: shared topics, languages and groups first, then shared words in the headline, with a nudge for
   *  people who just joined (they have nobody yet) and people active this week. Never friends or pending requests. */
  function suggestFor(id: string, n = 3) {
    const me = profile(id); if (!me) return [];
    const skip = new Set<string>([id, ...(q("SELECT b FROM friends WHERE a=?").all(id) as any[]).map(r => r.b)]);
    const rq = openRequests(id); for (const r of [...rq.incoming, ...rq.outgoing]) skip.add(r.id);
    const mine = interests(me), wk = Date.now() - 7 * DAY;
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(p => !skip.has(p.id) && listed(p)).map(p => {
      const it = interests(p), shared = [...it.topics].filter(t => mine.topics.has(t)), grp = [...it.groups].filter(g => mine.groups.has(g)), sw = [...it.words].filter(w => mine.words.has(w));
      const isNew = Date.parse(p.created) > wk, week = weekScore(p.manifest);
      const score = 3 * shared.length + 4 * grp.length + Math.min(3, sw.length) + (isNew ? 1.5 : 0) + Math.min(2, week / 150) + gravityOf(p.id) / 10;
      const nice = (t: string) => t.length <= 3 ? t.toUpperCase() : t;
      const why = grp.length ? `Also in ${grp[0]}` : shared.length ? `Also into ${shared.slice(0, 2).map(nice).join(", ")}` : sw.length ? `Also mentions ${sw.slice(0, 2).join(", ")}` : isNew ? "New this week" : week ? "Active this week" : "On Caldera";
      const b = body(p), avatar = b.photos?.avatar ? `/@${p.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
      return { id: p.id, handle: p.handle, name: p.name, headline: p.headline, avatar, why, score };
    }).sort((a, b) => b.score - a.score).slice(0, n);
  }

  function storeEnvelope(e: C.Envelope, recipient: string | null) {
    const hash = C.envelopeHash(e);
    q("INSERT OR IGNORE INTO envelopes VALUES (?,?,?,?,?,?)").run(hash, e.type, e.from, recipient, e.ts, JSON.stringify(e));
    return hash;
  }

  function settleExpiredAsks() {
    const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
    for (const a of q("SELECT * FROM asks WHERE status='open' AND ts < ?").all(cutoff) as any[]) {
      q("UPDATE asks SET status='expired' WHERE id=?").run(a.id);
      if (a.bounty > 0) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(a.author, a.bounty, "bounty returned", a.id, now());
    }
  }

  function gravityOf(id: string, depth = 0): number {
    const rows = q("SELECT sender, ts FROM gravity WHERE recipient=?").all(id) as any[];
    return C.gravityScore(rows.map(r => ({ ts: r.ts, giverWeight: depth < 1 ? C.giverWeight(gravityOf(r.sender, depth + 1)) : 1 })));
  }

  // ---------------------------------------------------------------- envelope rules
  function accept(e: C.Envelope): { status: number; body: any } {
    if (!C.verify(e)) return { status: 400, body: { error: "bad signature" } };
    const age = Date.now() - Date.parse(e.ts);
    if (!(age > -5 * 60_000 && age < 30 * DAY)) return { status: 400, body: { error: "stale or future timestamp" } };
    const b = e.body || {};
    switch (e.type) {
      case "profile.manifest": {
        const handle = String(b.handle || "").toLowerCase();
        if (handle && !/^[a-z0-9][a-z0-9-]{1,30}$/.test(handle)) return { status: 400, body: { error: "bad handle" } };
        if (RESERVED.has(handle)) return { status: 400, body: { error: "that handle is reserved" } };
        if (modOf(handle, e.from)) return { status: 403, body: { error: "this profile or handle is not available" } };
        const owner = handle ? byHandle(handle) : null;
        if (owner && owner.id !== e.from) return { status: 409, body: { error: "handle taken" } };
        const existing = profile(e.from);
        if (!existing) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, C.STARTING_CREDITS, "welcome", "", now());
        q(`INSERT INTO profiles (id, handle, box_key, name, headline, manifest, updated, created) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, box_key=excluded.box_key, name=excluded.name,
           headline=excluded.headline, manifest=excluded.manifest, updated=excluded.updated`)
          .run(e.from, handle || null, b.boxKey || "", b.name || "", b.headline || "", JSON.stringify(e), e.ts, existing?.created || now());
        storeEnvelope(e, null);
        indexGarden(e.from, handle, b.garden);
        if (!existing && b.invitedBy) recordReferral(e.from, b.invitedBy, "obsidian");
        if (!existing && opts.founder) {   // the founder is everyone's first friend; it can be removed like any other
          const f = byHandle(opts.founder.toLowerCase());
          if (f && f.id !== e.from) { const t = now(); q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(f.id, e.from, t); q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(e.from, f.id, t); }
        }
        if (!existing) emit({ type: "signup", handle, name: b.name || "", total: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
        return { status: 200, body: { ok: true, id: e.from, handle } };
      }
      case "profile.delete": {
        // Owner-signed erasure: profile, page files, friendships, asks, offers, gravity, ledger and stored envelopes.
        const gone = profile(e.from);
        erase(e.from);
        if (gone) emit({ type: "delete", handle: gone.handle, name: gone.name, total: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
        return { status: 200, body: { ok: true, deleted: e.from } };
      }
      case "friend.request": {
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "bad recipient" } };
        const hash = storeEnvelope(e, b.to);
        q("DELETE FROM friend_intents WHERE owner=? AND target=?").run(e.from, b.to);   // a request queued on the web just went out
        return { status: 200, body: { ok: true, request: hash } };
      }
      case "friend.accept": {
        const req = q("SELECT json FROM envelopes WHERE hash=? AND type='friend.request'").get(b.request) as any;
        if (!req) return { status: 404, body: { error: "unknown request" } };
        const r = JSON.parse(req.json) as C.Envelope;
        if (r.body.to !== e.from || r.from !== b.to) return { status: 403, body: { error: "request was not to you" } };
        q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(e.from, r.from, e.ts);
        q("INSERT OR IGNORE INTO friends VALUES (?,?,?)").run(r.from, e.from, e.ts);
        q("DELETE FROM friend_intents WHERE (owner=? AND target=?) OR (owner=? AND target=?)").run(e.from, r.from, r.from, e.from);
        storeEnvelope(e, r.from);
        return { status: 200, body: { ok: true } };
      }
      case "friend.remove": {
        q("DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)").run(e.from, b.to, b.to, e.from);
        return { status: 200, body: { ok: true } };
      }
      case "card":
      case "message": {
        const to: string[] = Array.isArray(b.to) ? b.to : [b.to];
        for (const t of to) if (!areFriends(e.from, t)) return { status: 403, body: { error: `not friends with ${t}` } };
        for (const t of to) storeEnvelope({ ...e }, t);
        return { status: 200, body: { ok: true, delivered: to.length } };
      }
      case "ask": {
        settleExpiredAsks();
        const bounty = Math.max(0, Math.floor(Number(b.bounty) || 0));
        if (!b.id || !b.title) return { status: 400, body: { error: "ask needs id and title" } };
        if (q("SELECT 1 FROM asks WHERE id=?").get(b.id)) return { status: 409, body: { error: "ask exists" } };
        if (bounty > balance(e.from)) return { status: 402, body: { error: "not enough credits", balance: balance(e.from) } };
        q("INSERT INTO asks VALUES (?,?,?,?,?,?,?,?,?,?)").run(b.id, e.from, String(b.title).slice(0, 140), String(b.detail || "").slice(0, 2000),
          bounty, JSON.stringify(b.tags || []), b.visibility === "friends" ? "friends" : "public", "open", e.ts, null);
        if (bounty) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, -bounty, "bounty escrow", b.id, now());
        storeEnvelope(e, null);
        return { status: 200, body: { ok: true, balance: balance(e.from) } };
      }
      case "offer": {
        if (!b.id || !b.title) return { status: 400, body: { error: "offer needs id and title" } };
        q("INSERT OR REPLACE INTO offers VALUES (?,?,?,?,?,?)").run(b.id, e.from, String(b.title).slice(0, 140), String(b.detail || "").slice(0, 2000), JSON.stringify(b.tags || []), e.ts);
        storeEnvelope(e, null);
        return { status: 200, body: { ok: true } };
      }
      case "gravity": {
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "gravity goes to someone else" } };
        if (!profile(b.to)) return { status: 404, body: { error: "unknown profile" } };
        const since = new Date(Date.now() - DAY).toISOString();
        if (q("SELECT 1 FROM gravity WHERE sender=? AND recipient=? AND ts > ?").get(e.from, b.to, since))
          return { status: 429, body: { error: "one gravity per person per day" } };
        q("INSERT INTO gravity VALUES (?,?,?,?,?)").run(e.from, b.to, e.ts, String(b.reason || "").slice(0, 140), b.ask || null);
        storeEnvelope(e, b.to);
        return { status: 200, body: { ok: true, gravity: gravityOf(b.to) } };
      }
      case "credit.award": {
        const a = q("SELECT * FROM asks WHERE id=?").get(b.ask) as any;
        if (!a) return { status: 404, body: { error: "unknown ask" } };
        if (a.author !== e.from) return { status: 403, body: { error: "only the asker can award" } };
        if (a.status !== "open") return { status: 409, body: { error: `ask is ${a.status}` } };
        if (!b.to || b.to === e.from) return { status: 400, body: { error: "award goes to a helper" } };
        const amount = Math.max(0, Math.min(a.bounty, Math.floor(Number(b.amount) || a.bounty)));
        q("UPDATE asks SET status='awarded', awarded_to=? WHERE id=?").run(b.to, a.id);
        q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(b.to, amount, "helped", a.id, now());
        if (a.bounty - amount > 0) q("INSERT INTO ledger VALUES (?,?,?,?,?)").run(e.from, a.bounty - amount, "bounty change", a.id, now());
        storeEnvelope(e, b.to);
        return { status: 200, body: { ok: true, awarded: amount } };
      }
      default:
        return { status: 200, body: { ok: true, ignored: e.type } };   // unknown types are ignored, not rejected
    }
  }

  /** The garden listed in a signed manifest: note index (for the feed) + links into other gardens (for their backlinks). */
  function indexGarden(owner: string, handle: string, garden: unknown) {
    q("DELETE FROM garden_notes WHERE owner=?").run(owner); q("DELETE FROM garden_links WHERE owner=?").run(owner);
    if (!handle || !Array.isArray(garden)) return;
    const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
    for (const g of garden.slice(0, 2000)) {
      const sl = str(g?.slug, 120); if (!/^[a-z0-9][a-z0-9-]*$/.test(sl)) continue;
      const stage = ["seedling", "budding", "evergreen"].includes(g.stage) ? g.stage : "seedling";
      const upd = Date.parse(g.updated) ? new Date(g.updated).toISOString() : now();
      q("INSERT OR REPLACE INTO garden_notes VALUES (?,?,?,?,?,?,?,?,?,?)").run(owner, handle, sl, str(g.title, 200), stage, str(g.license, 20), upd, str(g.excerpt, 240), Number(g.words) || 0, str(g.sha256, 64));
      for (const x of Array.isArray(g.xlinks) ? g.xlinks.slice(0, 100) : []) {
        const m = String(x).match(/^([a-z0-9][a-z0-9-]{1,30})\/([a-z0-9][a-z0-9-]*)$/);
        if (m && m[1] !== handle) q("INSERT INTO garden_links VALUES (?,?,?,?,?,?)").run(owner, handle, sl, str(g.title, 200), m[1], m[2]);
      }
    }
  }

  /** "Linked from other gardens" block injected into a hosted note page (static pages can't query the hub themselves). */
  function xlinksBlock(handle: string, slug: string): string {
    const rows = (q(`SELECT l.src_handle, l.src_slug, l.src_title, p.name, p.id, p.manifest FROM garden_links l JOIN profiles p ON p.id=l.owner
      WHERE l.dst_handle=? AND l.dst_slug=? LIMIT 50`).all(handle, slug) as any[]).filter(r => !modOf(r.src_handle, r.id));
    if (!rows.length) return "";
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    return `<section class="g-xlinks"><h2>Linked from other gardens</h2>${rows.map(r => `<a class="g-card" href="../../@${e(r.src_handle)}/n/${e(r.src_slug)}.html"><span class="g-card-t">${e(r.src_title)}</span><span class="g-card-m"><span class="g-who">@${e(r.src_handle)}</span>${r.name ? `<span>${e(r.name)}</span>` : ""}</span></a>`).join("")}</section>`;
  }

  /** "How this garden works" block injected into a hosted garden.html: everything the garden system tracks for this person,
   * read live (gravity, credits, asks/offers, links from other gardens, friends, rank) plus plain-English explainers. */
  function gardenHomeBlock(handle: string): string {
    const prof = q("SELECT id, name FROM profiles WHERE handle=?").get(handle) as any;
    if (!prof) return "";
    const id = prof.id;
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    settleExpiredAsks();
    const notes = (q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(id) as any).n;
    const links = q("SELECT COUNT(*) n, COUNT(DISTINCT src_handle) w FROM garden_links WHERE dst_handle=?").get(handle) as any;
    const grav = gravityOf(id);
    const givers = q(`SELECT g.reason, g.ts, p.handle FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? ORDER BY g.ts DESC LIMIT 5`).all(id) as any[];
    const bal = balance(id);
    const asks = q("SELECT title, bounty FROM asks WHERE author=? AND status='open' AND visibility='public' ORDER BY ts DESC LIMIT 5").all(id) as any[];
    const held = asks.reduce((s, a) => s + (a.bounty || 0), 0);
    const offers = q("SELECT title FROM offers WHERE author=? ORDER BY ts DESC LIMIT 5").all(id) as any[];
    const friends = (q("SELECT COUNT(*) n FROM friends WHERE a=? OR b=?").get(id, id) as any).n;
    const board = leaderboard(null) as any[];
    const rank = board.findIndex(r => r.id === id) + 1;
    const tile = (n: string, l: string, x: string) => `<div class="gh-tile"><b>${e(n)}</b><span>${e(l)}</span><small>${e(x)}</small></div>`;
    const hub = (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
    return `<section class="gh" aria-label="How this garden works">
<style>.gh{margin:22px 0 26px;padding:18px 18px 8px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg-raised)}
.gh h2{margin:0 0 4px;font-family:var(--font-display);font-size:1.15rem;color:var(--text-strong)}.gh>p{margin:0 0 14px;color:var(--text-muted);font-size:var(--text-sm)}
.gh-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.gh-tile{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--radius-md);background:var(--bg-sunken)}
.gh-tile b{font-size:1.4rem;color:var(--accent-text);font-variant-numeric:tabular-nums}.gh-tile span{font-weight:600;color:var(--text)}.gh-tile small{color:var(--text-muted);font-size:var(--text-xs);line-height:1.35}
.gh-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.gh-cols h3{margin:16px 0 6px;font-size:var(--text-sm);color:var(--text-strong);text-transform:uppercase;letter-spacing:.04em}
.gh-cols>div>h3:first-child{margin-top:4px}.gh-cols p,.gh-cols li{font-size:var(--text-sm);color:var(--text);line-height:1.5}.gh-cols ul{margin:0;padding-left:18px}.gh-cols .mut{color:var(--text-muted)}
.gh-cta{margin:14px 0 10px;padding:12px 14px;border-radius:var(--radius-md);background:var(--accent-soft);font-size:var(--text-sm);color:var(--text);display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.gh-cta span{flex:1 1 260px}.gh-btn{display:inline-block;padding:7px 14px;border-radius:var(--radius-round,999px);background:var(--accent);color:var(--bg,#fff);font-weight:600;text-decoration:none;white-space:nowrap}.gh-btn:hover{filter:brightness(1.08);text-decoration:none}</style>
<h2>How this garden works</h2>
<p>A garden is more than notes. It is a small economy of help between Obsidian vaults: notes link across gardens, friends give gravity, and asks pay out help credits.</p>
<div class="gh-tiles">${tile(String(notes), "notes planted", "Public notes, each signed and dated")}${tile(String(links.n || 0), "links in", `From ${links.w || 0} other garden${links.w === 1 ? "" : "s"}`)}${tile(grav.toFixed(1), "gravity", "Goodwill from friends")}${tile(String(bal), "help credits", held ? `${held} held in open bounties` : "Spendable on bounties")}${tile(String(friends), "friends", "Vaults connected")}${tile(rank ? `#${rank}` : "-", "this week", "Activity leaderboard")}${tile(String(invitedCount(id)), "brought in", "People who joined from their invite")}</div>
<div class="gh-cols">
<div><h3>Gravity (goodwill)</h3><p>Friends give gravity to say "you helped". It is positive only, fades with a 30-day half-life so it reflects recent help, and a gift from someone with more gravity counts a little more (1x to 2x, capped).</p>${givers.length ? `<ul>${givers.map(g => `<li>@${e(g.handle || "friend")}${g.reason ? `: ${e(g.reason)}` : ""}</li>`).join("")}</ul>` : `<p class="mut">No gravity yet. Be the first.</p>`}</div>
<div><h3>Help credits and asks</h3><p>Everyone starts with 100 credits. An ask can carry a bounty; the credits are held until the asker awards them to whoever helped, and come back after 30 days if nobody does. Credits have no cash value.</p>${asks.length ? `<ul>${asks.map(a => `<li>${e(a.title)}${a.bounty ? ` <span class="mut">(${a.bounty} credits)</span>` : ""}</li>`).join("")}</ul>` : `<p class="mut">No open asks right now.</p>`}</div>
<div><h3>Offers</h3><p>What this person is happy to help with.</p>${offers.length ? `<ul>${offers.map(o => `<li>${e(o.title)}</li>`).join("")}</ul>` : `<p class="mut">No offers posted yet.</p>`}<h3>Reuse and links</h3><p>Each note shows its license. Link to any note from your own garden with <code>[[@${e(handle)}/note-slug]]</code> and it appears on that note under "Linked from other gardens".</p></div>
</div>
<div class="gh-cta"><a class="gh-btn" href="${e(hub)}/kudos/${encodeURIComponent(handle)}" data-caldera-friend="${e(handle)}" target="_blank" rel="noopener">+ Add @${e(handle)} as a friend</a> <span>Become friends, then give gravity, answer an ask, or link a note. New to Caldera? <a href="${e(hub)}/?invite=${encodeURIComponent(handle)}#install">Get it here</a> and you'll be walked back to add @${e(handle)}.</span></div>
</section>`;
  }

  function recentGardenNotes(limit = 60) {
    return (q(`SELECT g.handle, g.slug, g.title, g.stage, g.license, g.updated, g.excerpt, g.words, p.name, p.id, p.manifest FROM garden_notes g
      JOIN profiles p ON p.id=g.owner WHERE p.handle IS NOT NULL ORDER BY g.updated DESC LIMIT ?`).all(Math.min(200, limit * 3)) as any[])
      .filter(r => listed(r) || false).slice(0, limit)
      .map(r => ({ handle: r.handle, name: r.name, slug: r.slug, title: r.title, stage: r.stage, license: r.license, updated: r.updated, excerpt: r.excerpt, words: r.words }));
  }

  // ---------------------------------------------------------------- link previews + group towns
  const hubUrl = () => (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
  const cityOf = (handle: string) => { try { return cityArt(fs.readFileSync(path.join(opts.dataDir, "profiles", handle, "index.html"), "utf8")); } catch { return null; } };
  const cardDir = path.join(opts.dataDir, "cards");
  /** PNG card for link previews, cached until the profile is published again. */
  async function profileCard(pr: any): Promise<Buffer> {
    const f = path.join(cardDir, pr.handle + ".png"), idx = path.join(opts.dataDir, "profiles", pr.handle, "index.html");
    const fresh = Math.max(Date.parse(pr.updated) || 0, fs.existsSync(idx) ? fs.statSync(idx).mtimeMs : 0);
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs >= fresh) return fs.readFileSync(f);
    const png = await toPng(cardSvg({ handle: pr.handle, name: pr.name, headline: pr.headline, host: hubUrl().replace(/^https?:\/\//, ""), city: cityOf(pr.handle) }));
    fs.mkdirSync(cardDir, { recursive: true }); fs.writeFileSync(f, png);
    return png;
  }
  function previewTags(handle: string, rel: string): string {
    const pr = byHandle(handle); if (!pr) return "";
    const v = String(Date.parse(pr.updated) || 0).slice(-8), base = `${hubUrl()}/@${handle}/`;
    const city = rel === "city.html";
    return ogTags({ url: base + (city ? "city.html" : ""), image: `${base}card.png?v=${v}`,
      title: city ? `${pr.name || "@" + handle}'s city on Caldera` : `${pr.name || "@" + handle} on Caldera`,
      description: pr.headline || "A living profile built from an Obsidian vault and code, on Caldera." });
  }
  function groupMembers(slug: string) {
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL ORDER BY created").all() as any[])
      .filter(p => listed(p) && Array.isArray(body(p).groups) && body(p).groups.includes(slug))
      .map(p => ({ handle: p.handle as string, name: p.name as string, headline: p.headline as string, city: cityOf(p.handle) }));
  }

  // ---------------------------------------------------------------- the world: every listed member's city on one map
  // Built from each member's PUBLIC city (their hosted city.html data), re-cleaned in world.ts; unlisted and moderated
  // profiles never appear. Cached for a minute; live activity is the public projection folded per member.
  let worldCache: { at: number; w: World } | null = null, worldPng: { at: number; png: Buffer } | null = null;
  function publicCityOf(handle: string): any {
    try { const html = fs.readFileSync(path.join(opts.dataDir, "profiles", handle, "city.html"), "utf8");
      const m = html.match(/<script type="application\/json" id="city-data">([\s\S]{1,3000000}?)<\/script>/); const d = m ? JSON.parse(m[1]) : null;
      return d && Array.isArray(d.districts) && d.private === false ? d : null; } catch { return null; }
  }
  function worldNow(): World {
    if (worldCache && Date.now() - worldCache.at < 60_000) return worldCache.w;
    const prs = (q("SELECT * FROM profiles WHERE handle IS NOT NULL ORDER BY created").all() as any[]).filter(listed);
    const ids = new Map(prs.map(p => [p.id as string, p.handle as string]));
    const pairs = (q("SELECT a, b FROM friends").all() as any[]).filter(r => ids.has(r.a) && ids.has(r.b)).map(r => [ids.get(r.a)!, ids.get(r.b)!] as [string, string]);
    const fc = new Map<string, number>(); for (const [a] of pairs) fc.set(a, (fc.get(a) || 0) + 1);
    const members: WorldMemberIn[] = prs.map(pr => {
      const b = body(pr), city = publicCityOf(pr.handle);
      const busy = (city?.districts || []).flatMap((d: any) => d.repos || []).reduce((s: number, r: any) => s + (Number(r.week) || 0), 0);
      return { handle: pr.handle, name: pr.name || "@" + pr.handle, headline: pr.headline || "", created: pr.created || pr.updated || now(),
        groups: Array.isArray(b.groups) ? b.groups.filter((g: unknown) => typeof g === "string" && /^[a-z0-9][a-z0-9-]{1,29}$/.test(g)) : [],
        friends: fc.get(pr.handle) || 0, city, notes: (q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(pr.id) as any).n, busy };
    });
    const w = buildWorld(members, pairs, opts.founder ? opts.founder.toLowerCase() : null, opts.publicUrl || "https://caldera.social");
    worldCache = { at: Date.now(), w }; return w;
  }
  function worldLive(since: string | null) {
    const per = (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed)
      .filter(pr => sitesOf(pr.id).length || q("SELECT 1 FROM agents WHERE owner=? LIMIT 1").get(pr.id))
      .map(pr => ({ handle: pr.handle as string, live: liveStats(pr.id, false, since) }));
    return foldLive(per, now());
  }
  function worldNav(): string {
    let h = ""; try { const g = fs.readFileSync(path.join(opts.siteDir || "", "guide.html"), "utf8"); h = g.slice(g.indexOf('<header class="nav">'), g.indexOf("</header>") + 9); } catch { /* no site */ }
    if (!h.startsWith("<header")) h = `<header class="nav"><a class="brand" href="/">Caldera</a><nav><a href="/people">People</a><a href="/world">World</a></nav></header>`;
    return h.replace(/ aria-current="page"/g, "").replace('href="/world"', 'href="/world" aria-current="page"').replace(/href="\.\/"/g, 'href="/"').replace(/href="#/g, 'href="/#') + `<script src="/assets/site.js" defer></script>`;
  }
  async function worldPreview(): Promise<Buffer> {
    if (worldPng && Date.now() - worldPng.at < 10 * 60_000) return worldPng.png;
    const w = worldNow(), snap = citySnapshot({ ...w.city, districts: w.city.districts.filter(d => d.repos.length) }, { name: "World" }), art = cityArt(snap);
    const n = w.members.length, b = w.city.districts.reduce((s, d) => s + d.repos.length, 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><radialGradient id="g" cx="50%" cy="110%" r="90%"><stop offset="0" stop-color="#1d2b4a"/><stop offset=".6" stop-color="#0c1222"/><stop offset="1" stop-color="#080b14"/></radialGradient></defs>`
      + `<rect width="1200" height="630" fill="url(#g)"/>${art ? `<svg x="40" y="30" width="1120" height="500" viewBox="${art.viewBox}" preserveAspectRatio="xMidYMid meet">${art.shapes}</svg>` : ""}`
      + `<text x="48" y="586" font-family="DejaVu Serif" font-weight="bold" font-size="40" fill="#F7F7FA">The Caldera world</text><text x="48" y="614" font-family="DejaVu Sans" font-size="20" fill="#9CC4FF">${n} neighborhood${n === 1 ? "" : "s"} · ${b.toLocaleString("en-US")} buildings · live</text></svg>`;
    const png = await toPng(svg); worldPng = { at: Date.now(), png }; return png;
  }

  const emit = (ev: Parameters<NonNullable<HubOptions["onEvent"]>>[0]) => { try { opts.onEvent?.(ev); } catch { /* never let a notifier break a request */ } };

  function erase(id: string) {
    const pr = profile(id);
    if (pr?.handle) { fs.rmSync(path.join(opts.dataDir, "profiles", pr.handle), { recursive: true, force: true }); fs.rmSync(path.join(opts.dataDir, "cards", pr.handle + ".png"), { force: true }); q("DELETE FROM page_views WHERE handle=?").run(pr.handle); }
    for (const r of q("SELECT key FROM traffic_sites WHERE owner=?").all(id) as any[]) q("DELETE FROM traffic WHERE key=?").run(r.key);
    q("DELETE FROM traffic_sites WHERE owner=?").run(id); q("DELETE FROM client_versions WHERE owner=?").run(id); q("DELETE FROM agent_keys WHERE owner=?").run(id); q("DELETE FROM agents WHERE owner=?").run(id);
    q("DELETE FROM owner_private WHERE owner=?").run(id); q("DELETE FROM owner_sessions WHERE owner=?").run(id); q("DELETE FROM owner_links WHERE owner=?").run(id); q("DELETE FROM signin_links WHERE owner=?").run(id); q("DELETE FROM pair_codes WHERE owner=?").run(id);
    for (const sql of ["DELETE FROM profiles WHERE id=?", "DELETE FROM friends WHERE a=? OR b=?", "DELETE FROM asks WHERE author=?", "DELETE FROM offers WHERE author=?",
      "DELETE FROM gravity WHERE sender=? OR recipient=?", "DELETE FROM ledger WHERE who=?", "DELETE FROM envelopes WHERE sender=? OR recipient=?", "DELETE FROM tokens WHERE id=?", "DELETE FROM garden_notes WHERE owner=?", "DELETE FROM garden_links WHERE owner=?", "DELETE FROM kudos WHERE sender=? OR recipient=?", "DELETE FROM friend_intents WHERE owner=? OR target=?"]) {
      const n = (sql.match(/\?/g) || []).length; q(sql).run(...Array(n).fill(id));
    }
  }

  // ---------------------------------------------------------------- operator tools (run on the server: node dist/admin.js)
  const admin = {
    list: () => q("SELECT * FROM moderation ORDER BY at DESC").all(),
    hide(handle: string, reason = "") { const pr = byHandle(handle); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "hidden", reason, now()); return { hidden: handle, id: pr?.id || null }; },
    unhide(handle: string) { q("DELETE FROM moderation WHERE handle=?").run(handle); return { restored: handle }; },
    remove(handle: string, reason = "") { const pr = byHandle(handle); if (pr) erase(pr.id); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "removed", reason, now()); return { removed: handle, id: pr?.id || null }; },
    block(handle: string, reason = "") { q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, null, "blocked", reason, now()); return { blocked: handle }; },
  };

  // ---------------------------------------------------------------- scores for leaderboards
  function weekScore(manifestJson: string): number {
    try {
      const m = JSON.parse(manifestJson).body;
      const cutoff = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
      return (m.daily || []).filter((d: any) => d.date >= cutoff).reduce((s: number, d: any) => s + (Number(d.score) || 0), 0);
    } catch { return 0; }
  }

  function leaderboard(ofId: string | null) {
    const rows = (ofId
      ? q("SELECT p.* FROM profiles p WHERE p.id=? OR p.id IN (SELECT b FROM friends WHERE a=?)").all(ofId, ofId)
      : (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed)) as any[];
    return rows.map(p => ({ id: p.id, handle: p.handle, name: p.name, week: weekScore(p.manifest), gravity: gravityOf(p.id) }))
      .sort((a, b) => b.week - a.week || b.gravity - a.gravity)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  /** Hub-side live blocks on hosted pages: links from other gardens, the garden home, layout fixes for old builds. */
  function liveBlocks(handle: string, rel: string, html: string): string {
    const note = rel.match(/^n\/([a-z0-9-]+)\.html$/);
    if (note) html = html.replace("<!--caldera:xlinks-->", xlinksBlock(handle, note[1]));
    if (rel === "garden.html") {   // garden home: live gravity/credits/asks/links block (marker from 0.6.0; older builds: before the stage filter)
      const gh = gardenHomeBlock(handle);
      html = html.includes("<!--caldera:gardenhome-->") ? html.replace("<!--caldera:gardenhome-->", gh) : html.replace('<div class="g-filter"', gh + '<div class="g-filter"');
    }
    if (!html.includes("Heatmap sizing (2026-10-12)") && html.includes('class="heat-box"')) html = html.replace(/<\/head>/i, HEAT_FIX + "</head>");   // pages built before 0.5.1
    return html;
  }

  // ---------------------------------------------------------------- live traffic on the owner's own sites
  // Sites are registered by the owner (one key per city district). Visits arrive from the t.js pixel or, for server-side
  // events, from the owner's own feed with the site's secret. Visitors are a salted daily hash, like profile views.
  const sitesOf = (owner: string) => q("SELECT key, project, public FROM traffic_sites WHERE owner=?").all(owner) as { key: string; project: string; public: number }[];
  const keyBuckets = new Map<string, { n: number; reset: number }>();
  function record(key: string, kind: string, visitor: string, ts = now()) {
    const t = Date.now(); let b = keyBuckets.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + 60_000 }; keyBuckets.set(key, b); }
    if (++b.n > 1200) return false;   // a flood on one site can't fill the database
    q("INSERT INTO traffic VALUES (?,?,?,?)").run(key, ts, kind, visitor);
    if (Math.random() < 0.002) q("DELETE FROM traffic WHERE ts < ?").run(new Date(Date.now() - 35 * DAY).toISOString());
    return true;
  }
  /** Per-district live numbers. full=false is the public projection: coarse activity levels only, unlisted projects merged. */
  /** Agents working for the owner right now (reported in the last 15 minutes). Public: district + state only. */
  const AGENT_TTL = 15 * 60_000;
  const repoHash = (r: string) => crypto.createHash("sha256").update(String(r).toLowerCase()).digest("hex").slice(0, 16);
  function agentsOf(owner: string, full: boolean, pubProjects: Set<string>) {
    const k = q("SELECT repos FROM agent_keys WHERE owner=?").get(owner) as any; let map: Record<string, string> = {};
    try { map = JSON.parse(k?.repos || "{}"); } catch { /* none */ }
    const rows = q("SELECT * FROM agents WHERE owner=? AND ts > ? ORDER BY ts DESC LIMIT 80").all(owner, new Date(Date.now() - AGENT_TTL).toISOString()) as any[];
    return rows.map(r => {
      const project = r.repo ? map[r.repo] || "" : "", ago = Math.round((Date.now() - Date.parse(r.ts)) / 1000);
      const state = ago > 300 && (r.state === "working" || r.state === "thinking") ? "idle" : r.state;   // went quiet without saying so
      if (!full) return { id: crypto.createHash("sha256").update(owner + r.id).digest("hex").slice(0, 10), d: pubProjects.has(project) ? project : project ? "Private" : "", state };
      let x: any = {}; try { x = JSON.parse(unseal(r.task)); } catch { /* unreadable */ }
      return { id: r.id, d: project, repo: x.repo || "", label: x.label || "", machine: x.machine || "", state, task: x.task || "", did: x.did || "", tokens: r.tokens, ago };
    });
  }
  // city extras: the viewer's weather, who came today and who just left (cityextra.ts)
  const WX = weatherService({ fetch: (opts as any).weatherFetch });
  const depSalt = (owner: string) => crypto.createHmac("sha256", PRIV_KEY).update("dep:" + owner).digest("hex");
  const cityExtras = (html: string, owner: string | null) => { const cfg: any = { weather: `${(opts.publicUrl || "").replace(/\/$/, "")}/v1/weather` }; if (owner) cfg.owner = ownerSetup(q, owner, opts.publicUrl || "https://caldera.social");
    const tag = extrasScript(cfg); return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tag + "</head>") : tag + html; };
  function liveStats(owner: string, full: boolean, since?: string | null) {
    const sites = sitesOf(owner), pubSet = new Set(sites.filter(s => s.public).map(s => s.project));
    const agents = agentsOf(owner, full, pubSet);
    if (!sites.length) return agents.length ? (full ? { at: now(), private: true, districts: {}, events: [], agents } : { at: now(), districts: {}, agents }) : null;
    const t5 = new Date(Date.now() - 5 * 60_000).toISOString(), t24 = new Date(Date.now() - DAY).toISOString(), t3 = new Date(Date.now() - 3 * 60_000).toISOString();
    const by = new Map(sites.map(s => [s.key, s]));
    const name = (k: string) => { const s = by.get(k)!; return full || s.public ? s.project : "Private"; };
    const ds: Record<string, { now: number; views: number; visitors: number; signups: number; buys: number }> = {};
    const d = (k: string) => ds[name(k)] ||= { now: 0, views: 0, visitors: 0, signups: 0, buys: 0 };
    const keys = sites.map(s => s.key), qs = keys.map(() => "?").join(",");
    for (const r of q(`SELECT key, COUNT(DISTINCT visitor) n FROM traffic WHERE key IN (${qs}) AND ts > ? AND kind='view' GROUP BY key`).all(...keys, t5) as any[]) d(r.key).now += r.n;
    for (const r of q(`SELECT key, kind, COUNT(*) n, COUNT(DISTINCT visitor) u FROM traffic WHERE key IN (${qs}) AND ts > ? GROUP BY key, kind`).all(...keys, t24) as any[]) {
      const x = d(r.key); if (r.kind === "view") { x.views += r.n; x.visitors += r.u; } else if (r.kind === "signup") x.signups += r.n; else if (r.kind === "buy") x.buys += r.n;
    }
    const level = (n: number) => n <= 0 ? 0 : n < 3 ? 1 : n < 10 ? 2 : n < 30 ? 3 : 4;
    // a "new" view is a visitor's first on that site in 30 minutes: it drops into the city as a new arrival
    const FRESH = `NOT EXISTS (SELECT 1 FROM traffic p WHERE p.key=t.key AND p.visitor=t.visitor AND p.kind='view' AND p.ts < t.ts AND p.ts > strftime('%Y-%m-%dT%H:%M:%fZ', t.ts, '-30 minutes'))`;
    if (!full) {
      // public: coarse counts per public district since the viewer's previous poll (at most 2 minutes back), private ones merged
      let arrivals: Record<string, { v: number; s: number; b: number }> | undefined;
      const lo = Date.parse(String(since || "")), floor = Date.now() - 120_000;
      if (lo) {
        arrivals = {};
        const from = new Date(Math.max(lo, floor)).toISOString();
        for (const r of q(`SELECT t.key, t.kind, (t.kind<>'view' OR ${FRESH}) AS fresh FROM traffic t WHERE t.key IN (${qs}) AND t.ts > ?`).all(...keys, from) as any[]) {
          if (!r.fresh) continue; const x = arrivals[name(r.key)] ||= { v: 0, s: 0, b: 0 };
          if (r.kind === "signup") x.s++; else if (r.kind === "buy") x.b++; else x.v++;
        }
      }
      return { at: now(), districts: Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, { level: level(v.now) }])), agents, ...(arrivals ? { arrivals } : {}), ...dayStats(q, keys, name, false, depSalt(owner), since) };
    }
    const events = (q(`SELECT t.key, t.ts, t.kind, (t.kind='view' AND ${FRESH}) AS fresh FROM traffic t WHERE t.key IN (${qs}) AND t.ts > ? ORDER BY t.ts DESC LIMIT 300`).all(...keys, t3) as any[]).map(r => ({ d: name(r.key), k: r.kind, ts: r.ts, ...(r.fresh ? { n: 1 } : {}) }));
    for (const k of kudosFor(owner, t3)) events.push({ d: "", k: "kudos", ts: k.ts, e: k.kind, from: k.from } as any);   // kudos burst over the private city
    return { at: now(), private: true, districts: Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, { ...v, level: level(v.now) }])), events, agents, ...dayStats(q, keys, name, true, depSalt(owner)) };
  }
  const hasLive = (owner: string) => { const wk = new Date(Date.now() - 7 * DAY).toISOString();
    return !!q(`SELECT 1 FROM traffic t JOIN traffic_sites s ON s.key=t.key WHERE s.owner=? AND t.ts > ? LIMIT 1`).get(owner, wk) || !!q("SELECT 1 FROM agents WHERE owner=? AND ts > ? LIMIT 1").get(owner, wk); };
  /** An older Caldera (say, a stale copy still running on another device) must not overwrite what a newer one published. */
  const semver = (v: unknown) => String(v || "0.0.0").split(".").map(x => parseInt(x, 10) || 0);
  function staleClient(owner: string, kind: string, v: unknown): string | null {
    const row = q("SELECT v FROM client_versions WHERE owner=? AND kind=?").get(owner, kind) as any, a = semver(v), b = semver(row?.v);
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) break; if ((a[i] || 0) < (b[i] || 0)) return row.v; }
    q("INSERT OR REPLACE INTO client_versions VALUES (?,?,?)").run(owner, kind, String(v || "0.0.0").slice(0, 20));
    return null;
  }
  const liveScript = (cfg: object) => `<script>window.CALDERA_LIVE=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>`;
  const injectLive = (html: string, cfg: object) => /<\/head>/i.test(html) ? html.replace(/<\/head>/i, liveScript(cfg) + "</head>") : liveScript(cfg) + html;
  const liveToken = (handle: string, day = new Date().toISOString().slice(0, 10)) => crypto.createHmac("sha256", PRIV_KEY).update("live:" + handle + ":" + day).digest("hex").slice(0, 24);

  // ---------------------------------------------------------------- auth (signed nonce, no passwords)
  function authed(req: http.IncomingMessage): string | null {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const row = q("SELECT id FROM tokens WHERE token=? AND expires > ?").get(hashToken(t), Date.now()) as any;
    return row?.id || null;
  }

  // ---------------------------------------------------------------- http
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error("too large"); chunks.push(c as Buffer); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" , ".md": "text/plain; charset=utf-8", ".zip": "application/zip", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", };

  const buckets = new Map<string, { n: number; w: number; reset: number }>();
  const newProfiles = new Map<string, { n: number; day: string }>();
  const L = { perMinute: 240, writesPerMinute: 40, newProfilesPerDay: 5, ...(opts.limits || {}) };
  // Behind nginx, X-Real-IP is set by the proxy from the TCP peer (clients cannot spoof it); X-Forwarded-For is not trusted.
  const ipOf = (req: http.IncomingMessage) => (opts.trustProxy ? String(req.headers["x-real-ip"] || "").trim() : "") || req.socket.remoteAddress || "?";
  function limited(req: http.IncomingMessage): boolean {
    const ip = ipOf(req), t = Date.now(); let b = buckets.get(ip);
    if (!b || b.reset < t) { b = { n: 0, w: 0, reset: t + 60_000 }; buckets.set(ip, b); }
    b.n++; if (req.method === "POST") b.w++;
    if (buckets.size > 50_000) buckets.clear();
    return b.n > L.perMinute || b.w > L.writesPerMinute;
  }
  function allowNewProfile(req: http.IncomingMessage): boolean {
    const ip = ipOf(req), day = new Date().toISOString().slice(0, 10); const r = newProfiles.get(ip);
    if (!r || r.day !== day) { newProfiles.set(ip, { n: 1, day }); return true; }
    r.n++; return r.n <= L.newProfilesPerDay;
  }

  /** What happened to one person since `since`, for their daily summary email. */
  /** "Finish your page" state for any profile, from what the hub can see (manifest, friends, garden, email). */
  function pageStateFor(owner: string): C.PageState | null {
    const pr = profile(owner); if (!pr?.handle) return null;
    const b = body(pr), acct = q("SELECT edits FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner) as any;
    let ed: any = {}; try { ed = JSON.parse(acct?.edits || "{}"); } catch { /* none */ }
    const links = Array.isArray(b.links) ? b.links.length : 0;
    return { photo: !!b.photos?.avatar, banner: !!b.photos?.banner, headline: !!String(b.headline || "").trim() && !/ on GitHub$/.test(String(b.headline)),
      summary: acct ? !!String(ed.summary || "").trim() : undefined, links: acct ? links > 1 : links > 0,
      garden: acct ? undefined : !!(q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(owner) as any).n,
      friend: !!q("SELECT 1 FROM friends WHERE a=? LIMIT 1").get(owner), group: Array.isArray(b.groups) && b.groups.length > 0,
      email: mail.hasConfirmed(owner) };
  }
  /** Days since a vault-published page last updated, when that's 3 or more (0 otherwise). Hosted GitHub pages rebuild
   *  themselves, so they never go stale; a vault page only updates while Obsidian is open on the owner's computer. */
  function staleDays(owner: string): number {
    const pr = profile(owner); if (!pr?.updated) return 0;
    if (q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner)) return 0;
    const d = Math.floor((Date.now() - Date.parse(pr.updated)) / DAY);
    return d >= 3 ? d : 0;
  }
  function nudgeFor(owner: string, hosted: boolean) {
    const st = pageStateFor(owner), n = st && C.nextStep(st); if (!n) return undefined;
    const hub = (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
    return { label: n.label.toLowerCase(), why: n.why, how: hosted ? "Do it on your account page" : "Open My profile in Obsidian", url: hosted ? `${hub}/me#finish` : "obsidian://caldera?open=finish" };
  }

  function digestFor(owner: string, since: string) {
    const pr = profile(owner); if (!pr?.handle) return null;
    const h = pr.handle as string, d1 = new Date(Date.now() - DAY).toISOString(), d7 = new Date(Date.now() - 7 * DAY).toISOString();
    const v1 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor) u FROM page_views WHERE handle=? AND ts > ?").get(h, since > d1 ? since : d1) as any;   // since the last email, at most a day
    const v7 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(h, d7) as any;
    const hosted = !!q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner);
    const stale = hosted ? 0 : staleDays(owner);
    return { stale: stale || undefined, nudge: stale ? undefined : nudgeFor(owner, hosted), handle: h, name: pr.name, hosted, views24: v1.n, visitors24: v1.u, views7: v7.n, visitors7: v7.u,
      requests: openRequests(owner).incoming.filter(r => r.ts > since).map(r => ({ handle: r.handle || "someone", name: r.name || "", note: r.note })),
      friends: q("SELECT p.handle, p.name FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=? AND f.ts > ?").all(owner, since) as any[],
      gravity: (q("SELECT p.handle, g.reason FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? AND g.ts > ?").all(owner, since) as any[]).map(g => ({ handle: g.handle || "friend", reason: g.reason || "" })),
      links: (q("SELECT COUNT(*) n FROM garden_links WHERE dst_handle=? AND src_handle<>?").get(h, h) as any).n,
      invited: q("SELECT p.handle FROM referrals r JOIN profiles p ON p.id=r.invitee WHERE r.inviter=? AND r.ts > ?").all(owner, since) as any[],
      credits: (q("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE who=? AND reason LIKE 'invited%' AND ts > ?").get(owner, since) as any).s,
      suggestions: suggestFor(owner, 3).map(x => ({ handle: x.handle, name: x.name, why: x.why })),
      newMembers: (q("SELECT * FROM profiles WHERE handle IS NOT NULL AND created > ? AND id<>? ORDER BY created DESC").all(d7, owner) as any[]).filter(listed).map(p => ({ handle: p.handle, name: p.name })),
      kudos: kudosFor(owner, since).map(k => ({ handle: k.from || "someone", name: k.name, emoji: k.emoji })), viewsAll: viewsOf(h) };
  }
  const mail = emailer({ q, seal, unseal, hub: opts.publicUrl || "https://caldera.social", pepper: PRIV_KEY, send: opts.email?.send, resendKey: opts.email?.resendKey, digest: digestFor });
  if (opts.email?.schedule) mail.schedule();

  const GH = github({ q, seal, unseal, accept, erase, dataDir: opts.dataDir, publicUrl: opts.publicUrl || "https://caldera.social", privateUrl: opts.privateUrl,
    json, readBody, allowNewProfile, byHandle, reserved: RESERVED, fetch: opts.githubFetch,
    owner: { start: (id: string) => startOwner(id), of: (req: http.IncomingMessage) => ownerOf(req), usable: (pr: any) => !modOf(pr.handle, pr.id), bar: (id: string) => { const pr = profile(id); return pr?.handle ? calderaBar(opts.publicUrl || "https://caldera.social", pr.handle, navFor(pr, "private")) : ""; } },
    social: { suggest: suggestFor, openRequests, invitedCount, recordReferral, pageState: pageStateFor, email: { status: mail.status, subscribe: mail.subscribe, unsubscribe: mail.unsubscribe } } });

  // ---------------------------------------------------------------- the owner, signed in on their own browser
  // A one-time link from the plugin (or the GitHub sign-in cookie for hosted profiles) marks this browser as the owner's,
  // so their public page offers a way back to the private view. Only token hashes are stored.
  const reqCookies = (req: http.IncomingMessage) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return i < 0 ? [c, ""] : [c.slice(0, i), (() => { try { return decodeURIComponent(c.slice(i + 1)); } catch { return ""; } })()]; }));
  const OWN_COOKIE = "cal_own", OWN_AGE = 365 * 86400;
  const ownCookie = (val: string, maxAge: number) => `${OWN_COOKIE}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${(opts.publicUrl || "").startsWith("https:") ? "; Secure" : ""}`;
  function ownerLink(owner: string): string {
    const code = crypto.randomBytes(24).toString("base64url");
    q("DELETE FROM owner_links WHERE expires < ?").run(Date.now());
    q("INSERT INTO owner_links VALUES (?,?,?)").run(hashToken(code), owner, Date.now() + 5 * 60_000);
    return `${(opts.publicUrl || "").replace(/\/$/, "")}/v1/own?c=${encodeURIComponent(code)}`;
  }
  /** Is this request from the owner of `handle`? Returns the bar's "back to private" target, or null. */
  const PUB = () => (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
  /** The owner nav for `handle` (same switch + account menu on the public page and the private address), or null. */
  function navFor(pr: any, current: "public" | "private", rel = "index.html", stale?: number): OwnerNav {
    const h = pr.handle as string, sub = rel === "index.html" ? "" : rel, priv = privateFor(h), hosted = hostedOf(pr.id);
    const privateHref = priv ? priv + sub : hosted ? `${PUB()}/me` : "obsidian://caldera?open=private";
    return { handle: h, current, publicHref: `${PUB()}/@${h}/${sub}`, privateHref, privateExternal: !priv && !hosted, signout: `${PUB()}/signout?h=${encodeURIComponent(h)}`, stale,
      note: priv ? "Private view opens your private address (your Tailscale devices only)." : hosted ? "Private view is your account page." : "Private view opens Caldera in Obsidian on this computer." };
  }
  /** Is this request from the owner of `handle`? Returns their nav for the public page, or null. */
  function ownerBar(req: http.IncomingMessage, handle: string, rel = "index.html"): OwnerNav | null {
    const pr = byHandle(handle); if (!pr) return null;
    const t = reqCookies(req)[OWN_COOKIE];
    let mine = !!t && !!q("SELECT 1 FROM owner_sessions WHERE token_hash=? AND owner=? AND expires > ?").get(hashToken(t), pr.id, Date.now());
    if (!mine) { const a = GH.account(req); if (a && !a.claimed && a.profile_id === pr.id) mine = true; }
    if (!mine) return null;
    return navFor(pr, "public", rel, staleDays(pr.id) || undefined);
  }

  // ---------------------------------------------------------------- owner sign-in from any device (/signin)
  // Three ways in, each ending in the same owner cookie: a one-time email link (only to the page's confirmed summary
  // address), GitHub (hosted profiles), or a 6-character code shown here and approved from the owner's Obsidian.
  const startOwner = (owner: string) => { const t = crypto.randomBytes(32).toString("hex");
    q("DELETE FROM owner_sessions WHERE expires < ?").run(Date.now());
    q("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(hashToken(t), owner, now(), Date.now() + OWN_AGE * 1000); return ownCookie(t, OWN_AGE); };
  const tries = new Map<string, { n: number; reset: number }>();
  const tooMany = (key: string, max: number, windowMs = 3600_000) => { const t = Date.now(); let b = tries.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; tries.set(key, b); } if (tries.size > 20_000) tries.clear(); return ++b.n > max; };
  const PAIR_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pairCode = () => Array.from(crypto.randomBytes(6), x => PAIR_ABC[x % PAIR_ABC.length]).join("");
  const normCode = (c: unknown) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const signinPage = (res: http.ServerResponse, status: number, title: string, inner: string, script = "") => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
.si{max-width:560px;margin:0 auto;padding:32px 16px 64px}.si h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.9rem;margin:.2em 0 .3em}.si .lede{color:var(--text-muted,#9A9AA6);margin:0 0 18px}
.si .card{background:var(--bg-raised,#16131F);border:1px solid var(--line,#2A2440);border-radius:12px;padding:16px 18px;margin:14px 0}.si .card h2{font-size:1.05rem;margin:0 0 4px}.si .mut{color:var(--text-muted,#9A9AA6);font-size:.93em}
.si input[type=email]{width:100%;box-sizing:border-box;background:var(--bg,#0E0B16);color:inherit;border:1px solid var(--line,#2A2440);border-radius:8px;padding:10px 12px;font:inherit;margin:8px 0 10px}
.si .code{font:500 2rem/1.2 'IBM Plex Mono',monospace;letter-spacing:.18em;padding:10px 0}.si .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.si button.btn{cursor:pointer}</style></head>
<body><header class="nav"><a class="brand" href="/">Caldera</a><nav><a href="/people">People</a><a href="/guide">Guide</a><a href="/signin">Sign in</a></nav></header><main class="si">${inner}</main>${script ? `<script>${script}</script>` : ""}<script src="/assets/site.js" defer></script></body></html>`);
  };
  const hostedOf = (owner: string) => !!q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner);
  /** The profile this browser is signed in as (owner cookie), if any. */
  function ownerOf(req: http.IncomingMessage): string | null {
    const t = reqCookies(req)[OWN_COOKIE]; if (!t) return null;
    return (q("SELECT owner FROM owner_sessions WHERE token_hash=? AND expires > ?").get(hashToken(t), Date.now()) as any)?.owner || null;
  }
  // ---------------------------------------------------------------- views and kudos
  /** The Caldera member signed in on this browser: an owner cookie (any page) or a GitHub sign-up's session. */
  function memberOf(req: http.IncomingMessage): string | null {
    const o = ownerOf(req); if (o && profile(o)) return o;
    const a = GH.account(req); return a && !a.claimed && a.profile_id && profile(a.profile_id) ? a.profile_id : null;
  }
  /** Views as people count them: one per visitor per day, bots and the owner's own visits never recorded. */
  const viewsOf = (handle: string, since = "") => (q("SELECT COUNT(DISTINCT visitor || substr(ts,1,10)) n FROM page_views WHERE handle=? AND ts > ?").get(handle, since) as any).n as number;
  const tallyOf = (id: string): [string, number][] => { const rows = q("SELECT kind, COUNT(*) n FROM kudos WHERE recipient=? GROUP BY kind").all(id) as any[];
    return Object.keys(KUDOS).map(k => [k, rows.find(r => r.kind === k)?.n || 0] as [string, number]); };
  const barSocial = (pr: any, owner: boolean): BarSocial => ({ views: viewsOf(pr.handle), showViews: body(pr).showViews !== false, tally: tallyOf(pr.id), owner });
  /** One kudos per sender per recipient per (UTC) day; members only; never to yourself. */
  function sendKudos(sender: string, to: any, kind: string, page = ""): { status: number; body: any } {
    if (!KUDOS[kind]) return { status: 400, body: { error: "pick one of: " + Object.keys(KUDOS).join(", ") } };
    if (!to?.handle || modOf(to.handle, to.id)) return { status: 404, body: { error: "unknown profile" } };
    if (to.id === sender) return { status: 400, body: { error: "That's your own page." } };
    if (tooMany("kudos:" + sender, 60)) return { status: 429, body: { error: "That's a lot of kudos for one hour. Try again later." } };
    const day = new Date().toISOString().slice(0, 10);
    const r = q("INSERT OR IGNORE INTO kudos VALUES (?,?,?,?,?,?)").run(sender, to.id, kind, now(), day, String(page).slice(0, 120));
    if (!r.changes) return { status: 409, body: { error: `You already sent @${to.handle} kudos today.`, tally: tallyOf(to.id) } };
    return { status: 200, body: { ok: true, sent: kind, tally: tallyOf(to.id) } };
  }
  const kudosFor = (id: string, since: string) => (q("SELECT k.kind, k.ts, k.page, p.handle, p.name FROM kudos k LEFT JOIN profiles p ON p.id=k.sender WHERE k.recipient=? AND k.ts > ? ORDER BY k.ts DESC LIMIT 50").all(id, since) as any[])
    .map(r => ({ kind: r.kind, emoji: KUDOS[r.kind] || "", from: r.handle || null, name: r.name || "", ts: r.ts, page: r.page || "" }));

  // ---------------------------------------------------------------- inline kudos + friends on hosted pages
  // Hosted pages are sandboxed (no cookies), so a signed-in member's page carries a short-lived action token instead:
  // HMAC over viewer + page owner + expiry. /v1/act accepts only that token, only for that page's owner.
  const ACT_TTL = 2 * 3600_000;
  const actMac = (p: string) => crypto.createHmac("sha256", PRIV_KEY).update("act:v1:" + p).digest("base64url");
  const actToken = (viewer: string, handle: string, ttl = ACT_TTL) => { const p = Buffer.from(JSON.stringify({ v: viewer, h: handle, x: Date.now() + ttl })).toString("base64url"); return p + "." + actMac(p); };
  function readAct(t: unknown): { v: string; h: string } | null {
    const [p, sig] = String(t || "").split("."); if (!p || !sig || p.length > 400) return null;
    const want = Buffer.from(actMac(p)), got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try { const o = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); return typeof o.v === "string" && typeof o.h === "string" && o.x > Date.now() ? { v: o.v, h: o.h } : null; } catch { return null; }
  }
  /** Where `me` stands with `to`: friends, a request either way, or a request queued on the web for their Obsidian. */
  function friendState(me: string, to: string): { state: FriendState; request?: string } {
    if (me === to) return { state: "self" };
    if (areFriends(me, to)) return { state: "friends" };
    const inc = q("SELECT hash FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=? ORDER BY ts DESC LIMIT 1").get(to, me) as any;
    if (inc) return { state: "incoming", request: inc.hash };
    if (q("SELECT 1 FROM friend_intents WHERE owner=? AND target=?").get(me, to)) return { state: "queued" };
    if (q("SELECT 1 FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=? LIMIT 1").get(me, to)) return { state: "requested" };
    return { state: "none" };
  }
  /** Add friend / Accept for a signed-in member. GitHub sign-ups: the hub holds their key and signs now. Obsidian members:
   *  the key never leaves their vault, so the hub queues it and their plugin signs and sends it on its next sync. */
  function friendAct(me: string, to: any): { status: number; body: any } {
    if (!to?.handle || modOf(to.handle, to.id)) return { status: 404, body: { error: "unknown profile" } };
    const st = friendState(me, to.id);
    if (st.state === "self") return { status: 400, body: { error: "That's your own page." } };
    if (st.state === "friends" || st.state === "requested" || st.state === "queued") return { status: 200, body: { ok: true, already: true, state: st.state } };
    if (tooMany("friend:" + me, 40)) return { status: 429, body: { error: "That's a lot of friend requests for one hour. Try again later." } };
    const a = q("SELECT key_sealed FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(me) as any;
    if (a?.key_sealed) {
      const id = JSON.parse(unseal(a.key_sealed)) as C.Identity;
      const r = st.state === "incoming" ? accept(C.sign(id, "friend.accept", { request: st.request, to: to.id })) : accept(C.sign(id, "friend.request", { to: to.id, note: "" }));
      if (r.status !== 200) return r;
      return { status: 200, body: { ok: true, state: st.state === "incoming" ? "friends" : "requested" } };
    }
    q("INSERT OR REPLACE INTO friend_intents VALUES (?,?,?,?,?)").run(me, to.id, st.state === "incoming" ? "accept" : "add", st.request || null, now());
    return { status: 200, body: { ok: true, state: "queued" } };
  }
  /** The viewer block for a hosted page: token + today's kudos + friend state (null for anonymous viewers and the owner). */
  function viewerFor(me: string | null, pr: any): BarViewer | null {
    const vp = me ? profile(me) : null; if (!vp?.handle || !pr || me === pr.id || modOf(vp.handle, vp.id)) return null;
    const day = new Date().toISOString().slice(0, 10), done = q("SELECT kind FROM kudos WHERE sender=? AND recipient=? AND day=?").get(me, pr.id, day) as any;
    return { handle: vp.handle, token: actToken(me!, pr.handle), sent: done?.kind || null, friend: friendState(me!, pr.id).state };
  }
  /** Add-friend links in pages built by any plugin version (obsidian:// links, the 0.19.3+ data-caldera-friend link and the
   *  garden home button) become the inline control, labelled for this viewer. The page owner sees no Add-friend link. */
  function rewriteFriendLinks(html: string, handle: string, v: BarViewer | null, isOwner: boolean): string {
    const base = PUB(), esc = (x: string) => x.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const st: FriendState = v ? v.friend : "none";
    return html.replace(/<a\b([^>]*?)(?:href="obsidian:\/\/caldera\?friend=([a-z0-9-]+)"|data-caldera-friend="([a-z0-9-]+)")([^>]*)>([\s\S]*?)<\/a>/gi, (whole, pre: string, h1: string, h2: string, post: string) => {
      const h = (h1 || h2 || "").toLowerCase(); if (h !== handle) return whole;
      if (isOwner || st === "self") return "";
      const cls = (pre + " " + post).match(/class="([^"]*)"/)?.[1] || "";
      const label = st === "none" ? `+ Add @${handle} as friend` : st === "incoming" ? `Accept @${handle}'s friend request` : FRIEND_LABEL[st];
      return `<a class="${esc(cls)}" href="${base}/kudos/${encodeURIComponent(handle)}" data-caldera-friend="${esc(handle)}" data-state="${st}" target="_blank" rel="noopener"${st === "none" || st === "incoming" ? "" : ' aria-disabled="true"'}>${esc(label)}</a>`;
    });
  }

  const sameOrigin = (req: http.IncomingMessage) => { const o = String(req.headers.origin || ""); if (!o) return false;
    return o === (originOf(opts.publicUrl) || `http://${req.headers.host}`); };
  /** The kudos window: tap an emoji to send (members), or sign in / get a page (everyone else). Also "Add friend". */
  function kudosPage(res: http.ServerResponse, pr: any, me: string | null) {
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const h = pr.handle as string, b = body(pr), av = b.photos?.avatar ? `/@${h}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : "";
    const tally = tallyOf(pr.id).filter(([, n]) => n > 0).map(([k, n]) => `<span>${KUDOS[k]} ${n}</span>`).join("");
    const head = `<div class="kd-who">${av ? `<img src="${e(av)}" alt="">` : `<span class="kd-ini">${e((pr.name || h).slice(0, 1).toUpperCase())}</span>`}<div><b>${e(pr.name || "@" + h)}</b><span class="mut">@${e(h)}</span></div></div>${tally ? `<div class="kd-tally" aria-label="Kudos so far">${tally}</div>` : ""}`;
    let inner: string, script = "";
    if (!me) inner = `${head}<h1>Send kudos</h1><p class="mut">Kudos come from Caldera members, so they mean something. Sign in, then tap <b>+ Kudos</b> on the page again.</p>
<div class="row"><a class="btn" href="/signin" target="_blank" rel="noopener">Sign in</a><a class="btn ghost" href="/?invite=${encodeURIComponent(h)}#install" target="_blank" rel="noopener">Get your own page</a></div>`;
    else if (me === pr.id) inner = `${head}<h1>This is your page</h1><p class="mut">Kudos people send you show here and on your page. You'll see who sent them in your private view and your daily email.</p>`;
    else {
      const day = new Date().toISOString().slice(0, 10), done = q("SELECT kind FROM kudos WHERE sender=? AND recipient=? AND day=?").get(me, pr.id, day) as any;
      const fst = friendState(me, pr.id).state;
      const friendRow = fst === "friends" ? `<p class="mut">You and @${e(h)} are friends \u2713</p>`
        : fst === "requested" ? `<p class="mut">Friend request sent to @${e(h)}.</p>`
        : fst === "queued" ? `<p class="mut">Friend request queued. It sends from your Obsidian the next time it's open.</p>`
        : `<button class="btn ghost" type="button" id="kd-friend">${fst === "incoming" ? `Accept @${e(h)}'s friend request` : `+ Add @${e(h)} as a friend`}</button>`;
      inner = `${head}<h1>${done ? "Kudos sent today" : `Send @${e(h)} kudos`}</h1>
<p class="mut" id="kd-msg">${done ? `You sent ${KUDOS[done.kind] || ""} today. You can send @${e(h)} more kudos tomorrow.` : "One tap. They'll see it on their page and in their daily email."}</p>
<div class="kd-pick" role="group" aria-label="Pick kudos">${Object.entries(KUDOS).map(([k, em]) => `<button type="button" data-k="${k}"${done ? " disabled" : ""} aria-label="${k}">${em}</button>`).join("")}</div>
<div class="kd-friend">${friendRow}</div>`;
      script = `var H=${JSON.stringify(h)},msg=document.getElementById('kd-msg'),pick=document.querySelectorAll('.kd-pick button');
function burst(em){for(var i=0;i<18;i++){var s=document.createElement('span');s.className='kd-fly';s.textContent=em;s.style.left=(40+Math.random()*20)+'%';s.style.setProperty('--dx',(Math.random()*240-120)+'px');s.style.animationDelay=(Math.random()*.25)+'s';document.body.appendChild(s);setTimeout(function(x){return function(){x.remove()}}(s),1900)}}
pick.forEach(function(b){b.addEventListener('click',function(){pick.forEach(function(x){x.disabled=true});var em=b.textContent;
fetch('/v1/kudos/'+H,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({kind:b.getAttribute('data-k'),page:'web'})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,j:j}})}).then(function(x){
if(x.ok){b.classList.add('on');burst(em);msg.textContent='Sent! @'+H+' will see it on their page.';document.querySelector('h1').textContent='Kudos sent';setTimeout(function(){try{if(window.opener)window.close()}catch(e){}},1900)}
else{msg.textContent=x.j.error||'Could not send.';if(x.status!==409)pick.forEach(function(y){y.disabled=false})}}).catch(function(){msg.textContent='Could not send. Check your connection.';pick.forEach(function(y){y.disabled=false})})})});
var fb=document.getElementById('kd-friend');if(fb)fb.addEventListener('click',function(){fb.disabled=true;fetch('/v1/friend/'+H,{method:'POST',credentials:'same-origin'}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){fb.outerHTML='<p class="mut">'+(x.ok?(x.j.state==='friends'?'You and @'+H+' are friends.':x.j.state==='queued'?'Friend request queued. It sends from your Obsidian the next time it is open.':'Friend request sent to @'+H+'.'):(x.j.error||'Could not send the request.'))+'</p>'})});`;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kudos for @${e(h)} - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
body{overflow-x:hidden}.kd{max-width:440px;margin:0 auto;padding:22px 16px 40px}.kd h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.6rem;margin:14px 0 4px}.kd .mut{color:var(--text-muted,#9A9AA6);margin:0 0 14px}.kd .small{font-size:.85em;display:block;margin-top:6px}
.kd-who{display:flex;gap:12px;align-items:center}.kd-who img,.kd-ini{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none}.kd-ini{display:grid;place-items:center;background:var(--accent,#8B6CF6);color:#fff;font-weight:600;font-size:1.2rem}.kd-who b{display:block}.kd-who .mut{margin:0}
.kd-tally{display:flex;gap:12px;margin-top:10px;font-size:15px;font-variant-numeric:tabular-nums}
.kd-pick{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:8px 0 18px}.kd-pick button{font-size:34px;line-height:1;padding:16px 0;border-radius:14px;border:1px solid var(--line,#2A2440);background:var(--bg-raised,#16131F);cursor:pointer;transition:transform .15s,border-color .15s}
.kd-pick button:hover:not(:disabled){transform:translateY(-2px) scale(1.06);border-color:var(--accent,#8B6CF6)}.kd-pick button:disabled{opacity:.45;cursor:default}.kd-pick button.on{opacity:1;border-color:var(--accent,#8B6CF6);transform:scale(1.12)}
.kd .row{display:flex;flex-wrap:wrap;gap:8px}.kd-friend{border-top:1px solid var(--line,#2A2440);padding-top:14px}.kd button.btn{cursor:pointer}
.kd-fly{position:fixed;bottom:30%;font-size:28px;pointer-events:none;animation:kdfly 1.7s ease-out forwards}@keyframes kdfly{0%{transform:translate(0,0) scale(.6);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx),-360px) scale(1.25);opacity:0}}
@media (prefers-reduced-motion:reduce){.kd-fly{display:none}}</style></head><body><main class="kd">${inner}</main>${script ? `<script>${script}</script>` : ""}</body></html>`);
  }
  /** /signin with no page: GitHub first, then how to sign in to a page made in Obsidian. */
  function signinGeneral(res: http.ServerResponse) {
    signinPage(res, 200, "Sign in", `<h1>Sign in to Caldera</h1><p class="lede">Sign this browser in as the owner of your page. It stays signed in for a year.</p>
<div class="card"><h2>Sign in with GitHub</h2><p class="mut">Works if you signed up with GitHub, or if your page lists your GitHub account in its links.</p><a class="btn" href="/auth/github">Sign in with GitHub</a></div>
<div class="card"><h2>Made your page in Obsidian?</h2><p class="mut">Open your page and tap <b>Sign in</b> in the bar at the top for an email link or a code from Obsidian. Or in Obsidian, run <b>Caldera: Open my public page (as owner)</b>.</p></div>
<p class="mut">No page yet? <a href="/#install">Get your own page</a>.</p>`);
  }
  function signinHome(res: http.ServerResponse, pr: any, note = "") {
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const h = pr.handle as string, hosted = hostedOf(pr.id), hasEmail = mail.hasConfirmed(pr.id);
    const emailCard = `<div class="card"><h2>Email me a sign-in link</h2>${hasEmail
      ? `<p class="mut">Type the email your daily Caldera summary goes to. We'll send a link that works once, for 15 minutes.</p><form method="post" action="/signin/email"><input type="hidden" name="h" value="${e(h)}"><input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"><button class="btn small" type="submit">Send the link</button></form>`
      : `<p class="mut">This page has no confirmed summary email yet, so there's nowhere to send a link. ${hosted ? "Sign in with GitHub instead, and add your email on your account page for next time." : "Pair this device from Obsidian below, then turn on the daily summary email in Caldera settings for next time."}</p>`}</div>`;
    const ghLogin = hosted ? "" : GH.ghLoginsOf(pr)[0] || "";   // a page made in Obsidian that lists its GitHub account
    const ghCard = hosted || ghLogin ? `<div class="card"><h2>Sign in with GitHub</h2><p class="mut">${hosted ? "This page was made with GitHub. Sign in with the same GitHub account." : `Sign in as <b>${e(ghLogin)}</b>, the GitHub account linked on this page.`}</p><a class="btn" href="/auth/github?h=${encodeURIComponent(h)}">Sign in with GitHub</a></div>` : "";
    const pairCard = hosted ? "" : `<div class="card" id="pair"><h2>Pair from Obsidian</h2><p class="mut">On a computer with your vault: in Obsidian, open the command palette and run <b>Caldera: Sign in another device</b> (or the key button in the My profile tab), then type the code shown here.</p>
<div id="pair-box"><button class="btn small" type="button" id="pair-go">Show a code</button></div></div>`;
    const js = hosted ? "" : `(function(){var b=document.getElementById('pair-go');if(!b)return;b.addEventListener('click',function(){b.disabled=true;
fetch('/signin/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({h:${JSON.stringify(h)}})}).then(function(r){return r.json()}).then(function(j){var box=document.getElementById('pair-box');
if(!j.code){box.textContent=j.error||'Could not make a code. Try again in a minute.';return}
box.innerHTML='<div class="code"></div><p class="mut">Waiting for Obsidian. The code works for 10 minutes.</p>';box.firstChild.textContent=j.code.slice(0,3)+' '+j.code.slice(3);
var t=setInterval(function(){fetch('/signin/pair/status?p='+encodeURIComponent(j.poll)).then(function(r){return r.json()}).then(function(s){
if(s.state==='approved'){clearInterval(t);var f=document.createElement('form');f.method='post';f.action='/signin/pair/done';var i=document.createElement('input');i.type='hidden';i.name='p';i.value=j.poll;f.appendChild(i);document.body.appendChild(f);f.submit()}
else if(s.state!=='waiting'){clearInterval(t);box.textContent='That code expired. Reload to get a new one.'}}).catch(function(){})},2000)}).catch(function(){b.disabled=false})})})();`;
    signinPage(res, 200, "Sign in", `${note ? `<div class="card">${note}</div>` : ""}<h1>Sign in as @${e(h)}</h1><p class="lede">For the owner of this page: sign this browser in, so your public page shows a way back to your private view. It stays signed in for a year.</p>${ghCard}${emailCard}${pairCard}<p class="mut"><a href="/@${e(h)}/">Back to the page</a></p>`, js);
  }

  /** Every link that leaves Caldera opens in a new window: rewrite off-site <a href> in any HTML this hub sends. */
  const hostOf = (u?: string) => { try { return u ? new URL(u).host : ""; } catch { return ""; } };
  function guardLinks(req: http.IncomingMessage, res: http.ServerResponse, extra: string[] = []) {
    const hosts = [hostOf(opts.publicUrl), hostOf(opts.privateUrl), String(req.headers.host || ""), ...extra].filter(Boolean);
    let html = false;
    const wh = res.writeHead.bind(res) as any;
    (res as any).writeHead = (status: number, ...rest: any[]) => {
      const hdrs = rest.find(x => x && typeof x === "object" && !Array.isArray(x));
      const ct = String((hdrs && (hdrs["content-type"] || hdrs["Content-Type"])) || res.getHeader("content-type") || "");
      html = /text\/html/i.test(ct); return wh(status, ...rest);
    };
    const end = res.end.bind(res) as any;
    (res as any).end = (chunk?: any, ...rest: any[]) => {
      if ((html || /text\/html/i.test(String(res.getHeader("content-type") || ""))) && chunk && (typeof chunk === "string" || Buffer.isBuffer(chunk))) {
        try { chunk = C.externalLinksNewWindow(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk, hosts); } catch { /* never break a page */ }
      }
      return end(chunk, ...rest);
    };
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    guardLinks(req, res);
    try {
      if (req.method === "HEAD") {   // link checkers (e.g. the Obsidian directory) probe with HEAD: answer like GET, without a body
        req.method = "GET"; const end = res.end.bind(res);
        (res as any).write = () => true; (res as any).end = (..._a: unknown[]) => end();
      }
      if (limited(req)) return json(res, 429, { error: "slow down" });
      const url = new URL(req.url || "/", "http://hub");
      // ids arrive percent-encoded ("cal%3A...") when a proxy passes the raw URI through; API routes match the decoded form
      const p = url.pathname.startsWith("/v1/") ? url.pathname.replace(/%3A/gi, ":") : url.pathname;
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (/^\/(auth\/github|me$|me\/upload$|v1\/github\/)/.test(p) && await GH.route(req, res, url)) return;

      if (req.method === "GET" && p === "/v1/weather") { const w = await WX.forIp(ipOf(req)); res.setHeader("cache-control", "no-store"); return json(res, 200, w || { c: null }); }   // the requester's own weather, never stored
      if (req.method === "GET" && p === "/v1/info") return json(res, 200, { name: "Caldera Hub", protocol: C.PROTOCOL_VERSION, profiles: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
      if (req.method === "GET" && p === "/v1/gardens/recent") return json(res, 200, { notes: recentGardenNotes(Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 60))) });
      if (req.method === "GET" && (p === "/gardens" || p === "/gardens/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
        return res.end(gardensPage(recentGardenNotes(80), opts.publicUrl || "https://caldera.social"));
      }
      { const g = p.match(/^\/g\/([a-z0-9][a-z0-9-]{1,29})\/?$/);
        if (req.method === "GET" && g) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
          return res.end(groupPage({ slug: g[1], hub: opts.publicUrl || "https://caldera.social", members: groupMembers(g[1]) }));
        } }
      if (req.method === "GET" && p === "/v1/world") { res.setHeader("cache-control", "public, max-age=60"); const w = worldNow(); return json(res, 200, { at: w.at, members: w.members, links: w.links, city: w.city }); }
      if (req.method === "GET" && p === "/v1/world/live") { res.setHeader("cache-control", "no-store"); return json(res, 200, worldLive(url.searchParams.get("since"))); }
      if (req.method === "GET" && (p === "/world" || p === "/world/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache",
          "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
        return res.end(worldPage(worldNow(), { hub: opts.publicUrl || "https://caldera.social", nav: worldNav() }));
      }
      if (req.method === "GET" && p === "/world/preview.png") { const png = await worldPreview(); res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=600" }); return res.end(png); }
      const m0 = p.match(/^\/watch\/@([a-z0-9-]+)\/?$/);
      if (req.method === "GET" && m0) {
        const pr = byHandle(m0[1]);
        if (!pr || modOf(pr.handle, pr.id) || !fs.existsSync(path.join(opts.dataDir, "profiles", m0[1], "city.html"))) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("No city here."); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex", "content-security-policy": WATCH_CSP });
        return res.end(watchPage(pr.name || "@" + m0[1], `/@${m0[1]}/city.html${url.search}#mini`));
      }
      if (req.method === "GET" && p === "/t.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
        return res.end(TRACK_JS);
      }
      if (req.method === "GET" && opts.siteDir && !p.startsWith("/v1/") && !p.startsWith("/@")) {
        let rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
        if (rel.endsWith("/")) rel += "index.html";
        const root = path.resolve(opts.siteDir);
        let file = path.resolve(root, path.normalize(rel));
        // clean URLs: /obsidian-public-profile serves obsidian-public-profile.html; /x.html 301s to /x so each page has one URL
        if (/\.html$/.test(rel) && rel !== "index.html" && !rel.endsWith("/index.html") && !/^google[0-9a-f]+\.html$/.test(rel) && fs.existsSync(file)) { res.writeHead(301, { location: "/" + rel.replace(/\.html$/, "") }); return res.end(); }
        if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
        if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, { "content-type": MIME[ext] || (ext === ".zip" ? "application/zip" : "application/octet-stream"), "cache-control": "public, max-age=600" });
          if (ext === ".html") return res.end(fs.readFileSync(file, "utf8"));   // whole, so off-site links get their new-window rewrite
          return fs.createReadStream(file).pipe(res);
        }
      }
      if (req.method === "GET" && p === "/") return json(res, 200, { name: "Caldera Hub", protocol: C.PROTOCOL_VERSION });

      if (req.method === "POST" && p === "/v1/envelopes") {
        const env = await readBody(req);
        if (env?.type === "profile.manifest" && !profile(env.from) && !allowNewProfile(req)) return json(res, 429, { error: "too many new profiles from this address today" });
        const r = accept(env); return json(res, r.status, r.body);
      }

      // upload a static profile bundle: { manifest: <signed profile.manifest>, files: { "index.html": "<base64>", ... } }
      let m = p.match(/^\/v1\/profiles\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/bundle$/);
      if (req.method === "POST" && m) {
        const body = await readBody(req);
        if (body.manifest?.from !== m[1]) return json(res, 403, { error: "manifest must be signed by the profile" });
        { const newer = staleClient(m[1], "bundle", body.v); if (newer) return json(res, 409, { error: `Caldera ${newer} already published this profile; update Caldera on this device (you have ${body.v || "an older version"})` }); }
        if (!profile(m[1]) && !allowNewProfile(req)) return json(res, 429, { error: "too many new profiles from this address today" });
        const r = accept(body.manifest); if (r.status !== 200) return json(res, r.status, r.body);
        const handle = r.body.handle; if (!handle) return json(res, 400, { error: "a handle is required to host a page" });
        const dir = path.join(opts.dataDir, "profiles", handle);
        fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
        for (const [rel, b64data] of Object.entries(body.files || {})) {
          const clean = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
          if (clean.includes("..") || path.isAbsolute(clean) || !MIME[path.extname(clean).toLowerCase()]) continue;
          fs.mkdirSync(path.dirname(path.join(dir, clean)), { recursive: true });
          fs.writeFileSync(path.join(dir, clean), Buffer.from(String(b64data), "base64"));
        }
        fs.writeFileSync(path.join(dir, "caldera.json"), JSON.stringify(body.manifest));
        return json(res, 200, { ok: true, url: `${opts.publicUrl || ""}/@${handle}/` });
      }

      // /@mike (no slash, any case) 301s to /@mike/ so the page's relative img/ and assets/ paths resolve
      m = p.match(/^\/@([A-Za-z0-9-]+)$/);
      if (req.method === "GET" && m) { res.writeHead(301, { location: `/@${m[1].toLowerCase()}/${url.search}` }); return res.end(); }
      m = p.match(/^\/@([a-z0-9-]+)(\/.*)?$/);
      if (req.method === "GET" && m) {
        if (modOf(m[1])) { res.writeHead(410, { "content-type": "text/plain" }); return res.end("This profile is not available."); }
        const dir = path.join(opts.dataDir, "profiles", m[1]);
        if (m[2] === "/card.png") {   // the link-preview picture: the city (or initials), name, headline
          const pr = byHandle(m[1]); if (!pr) { res.writeHead(404); return res.end("not found"); }
          try { const png = await profileCard(pr); res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }); return res.end(png); }
          catch (e: any) { console.error("card", m[1], e?.message); res.writeHead(302, { location: "/og.jpg" }); return res.end(); }
        }
        let rel = (m[2] || "/").slice(1) || "index.html";
        if (rel.endsWith("/")) rel += "index.html";
        const file = path.join(dir, path.normalize(rel));
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
        res.removeHeader("x-frame-options");
        const headers = { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "x-robots-tag": "noindex", "content-security-policy": PROFILE_CSP, "cache-control": "no-cache" };
        if (path.extname(file).toLowerCase() === ".html") {   // every hosted page gets the Caldera bar, whatever plugin version built it
          const ua = String(req.headers["user-agent"] || ""), own = ownerBar(req, m[1], rel);
          (headers as any).vary = "Cookie";
          if (!own && ua && !BOT_UA.test(ua) && url.searchParams.get("caldera") !== "owner" && req.method === "GET") {   // the owner's own Public view passes caldera=owner
            const day = new Date().toISOString().slice(0, 10);
            const visitor = crypto.createHash("sha256").update(VIEW_SALT + day + ipOf(req) + ua).digest("hex").slice(0, 16);
            try { q("INSERT INTO page_views VALUES (?,?,?,?)").run(m[1], rel, now(), visitor); } catch { /* counting never breaks a page */ }
          }
          // signed-in members (not the owner) get inline kudos + Add friend, with an action token for this page's owner only
          const prS = byHandle(m[1]), viewer = !own && prS ? viewerFor(memberOf(req), prS) : null;
          let html = fs.readFileSync(file, "utf8");
          const soc: BarSocial | undefined = prS ? { ...barSocial(prS, !!own), viewer } : undefined;
          // views, kudos and Add friend sit under the person's name (profile) or the city title; other pages keep the bar clean
          const rowAt = rel === "index.html" ? (/<p class="lede">[\s\S]*?<\/p>/.test(html) ? /<p class="lede">[\s\S]*?<\/p>/ : /<h1 class="title">[\s\S]*?<\/h1>/) : rel === "city.html" ? /<h1 class="c-title">[\s\S]*?<\/h1>/ : null;
          const inPage = !!(soc && rowAt && rowAt.test(html));
          const bar = calderaBar(opts.publicUrl || "https://caldera.social", m[1], own, soc && (inPage || rel === "index.html" || rel === "city.html") ? { ...soc, inPage } : undefined);
          html = liveBlocks(m[1], rel, html);
          html = rewriteFriendLinks(html, m[1], viewer, !!own);
          (headers as any)["content-security-policy"] = cityCsp(originOf(opts.publicUrl));   // connect-src to this hub only (inline kudos/friends, city feeds); still sandboxed
          if ((rel === "index.html" || rel === "city.html") && !html.includes('property="og:image"')) html = html.replace(/<\/head>/i, previewTags(m[1], rel) + "</head>");
          if (rel === "city.html") { const pr = byHandle(m[1]); if (pr && hasLive(pr.id)) html = injectLive(html, { url: `/v1/live/${m[1]}`, mode: "public" });
            html = cityExtras(html, pr && own && memberOf(req) === pr.id ? pr.id : null); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.publicUrl)); }   // weather for every viewer; setup row for the owner only
          if (inPage && soc && rowAt) { const hd = m[1]; html = html.replace(rowAt, h => h + socialRow(opts.publicUrl || "https://caldera.social", hd, soc)); }
          const out = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar) : bar + html;
          res.writeHead(200, headers); return res.end(out);
        }
        res.writeHead(200, headers);
        return fs.createReadStream(file).pipe(res);
      }

      // ---- kudos + views. /kudos/<handle>: a small first-party window (profile pages are sandboxed, so this is where the
      // member's sign-in rides along). Members send with one tap; everyone else is offered sign-in or a page of their own.
      m = p.match(/^\/friend\/([a-z0-9-]+)\/?$/);
      if (req.method === "GET" && m) { res.writeHead(302, { location: `/kudos/${m[1]}`, "cache-control": "no-store" }); return res.end(); }
      m = p.match(/^\/kudos\/([a-z0-9-]+)\/?$/);
      if (req.method === "GET" && m) {
        const pr = byHandle(m[1]); if (!pr || modOf(pr.handle, pr.id)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
        return kudosPage(res, pr, memberOf(req));
      }
      m = p.match(/^\/v1\/kudos\/([a-z0-9-]+)$/);
      if (m && req.method === "GET") { const pr = byHandle(m[1]); if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, { handle: pr.handle, tally: Object.fromEntries(tallyOf(pr.id)), views: body(pr).showViews !== false ? viewsOf(pr.handle) : null }); }
      if (m && req.method === "POST") {   // from the kudos window: same-origin only, the member's cookie
        if (!sameOrigin(req)) return json(res, 403, { error: "wrong origin" });
        const me = memberOf(req); if (!me) return json(res, 401, { error: "Sign in to send kudos." });
        const { kind, page } = await readBody(req) as { kind?: string; page?: string };
        const r = sendKudos(me, byHandle(m[1]), String(kind || ""), String(page || "")); return json(res, r.status, r.body);
      }
      // a GitHub sign-up, signed in on the web, adds a friend in one tap (the hub holds their key and signs for them)
      // Add friend / Accept from the hub's own pages (cookie + same origin): signed now for GitHub sign-ups, queued for Obsidian
      m = p.match(/^\/v1\/friend\/([a-z0-9-]+)$/);
      if (req.method === "POST" && m) {
        if (!sameOrigin(req)) return json(res, 403, { error: "wrong origin" });
        const me = memberOf(req); if (!me) return json(res, 401, { error: "Sign in to add friends." });
        const r = friendAct(me, byHandle(m[1])); return json(res, r.status, r.body);
      }
      // inline kudos + friends on hosted pages: the page's action token is the only credential (sandboxed pages send no
      // cookies, Origin is "null"); it names the viewer and the one page owner it may act on, and expires in 2 hours
      if (req.method === "POST" && p === "/v1/act") {
        if (tooMany("act-ip:" + ipOf(req), 120)) return json(res, 429, { error: "slow down" });
        const b = await readBody(req).catch(() => ({})) as { t?: string; action?: string; kind?: string };
        const tok = readAct(b.t); if (!tok) return json(res, 401, { error: "Sign in again to do that (your page session expired). Reload the page." });
        const me = profile(tok.v); if (!me?.handle || modOf(me.handle, me.id)) return json(res, 401, { error: "Sign in to do that." });
        const to = byHandle(tok.h); if (!to || modOf(to.handle, to.id)) return json(res, 404, { error: "unknown profile" });
        if (b.action === "kudos") { const r = sendKudos(me.id, to, String(b.kind || ""), "inline"); return json(res, r.status, r.body); }
        if (b.action === "friend" || b.action === "accept") { const r = friendAct(me.id, to); return json(res, r.status, r.body); }
        return json(res, 400, { error: "unknown action" });
      }
      // the plugin picks up Add friend / Accept taps queued on the web, signs them with the vault's key and sends them
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/intents$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const rows = q("SELECT i.target, i.kind, i.request, p.handle FROM friend_intents i LEFT JOIN profiles p ON p.id=i.target WHERE i.owner=? ORDER BY i.ts").all(m[1]) as any[];
        const out: any[] = [];
        for (const r of rows) {
          if (!r.handle || areFriends(m[1], r.target)) { q("DELETE FROM friend_intents WHERE owner=? AND target=?").run(m[1], r.target); continue; }
          out.push({ id: r.target, handle: r.handle, kind: r.kind === "accept" ? "accept" : "add", request: r.kind === "accept" ? r.request : null });
        }
        return json(res, 200, { intents: out });
      }
      // the plugin: send kudos and read the ones you got, signed in with the vault's key
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/kudos$/);
      if (m && req.method === "POST") {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const { to, kind, page } = await readBody(req) as { to?: string; kind?: string; page?: string };
        const t = String(to || ""), pr = t.startsWith("cal:") ? profile(t) : byHandle(t.replace(/^@/, "").toLowerCase());
        const r = sendKudos(m[1], pr, String(kind || ""), String(page || "obsidian")); return json(res, r.status, r.body);
      }
      if (m && req.method === "GET") {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        return json(res, 200, { kudos: kudosFor(m[1], url.searchParams.get("since") || "1970"), tally: Object.fromEntries(tallyOf(m[1])) });
      }

      // one-time owner link: the plugin asks for it (signed in), the browser trades it for a long-lived owner cookie
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/link$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle) return json(res, 404, { error: "publish your profile first" });
        return json(res, 200, { url: ownerLink(m[1]), expires_in: 300 });
      }
      if (req.method === "GET" && p === "/v1/own") {
        const c = url.searchParams.get("c") || "", row = c ? q("SELECT * FROM owner_links WHERE code_hash=?").get(hashToken(c)) as any : null;
        if (row) q("DELETE FROM owner_links WHERE code_hash=?").run(row.code_hash);   // single use
        const pr = row && row.expires > Date.now() ? profile(row.owner) : null;
        if (!pr?.handle) { res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link expired</title><body style="font:16px system-ui;max-width:520px;margin:60px auto;padding:0 16px"><h1>That link expired</h1><p>Owner links work once, for 5 minutes. In Obsidian, run <b>Caldera: Open my public page (as owner)</b> again.</p></body>`); }
        const t = crypto.randomBytes(32).toString("hex");
        q("DELETE FROM owner_sessions WHERE expires < ?").run(Date.now());
        q("INSERT INTO owner_sessions VALUES (?,?,?,?)").run(hashToken(t), pr.id, now(), Date.now() + OWN_AGE * 1000);
        const to = url.searchParams.get("to") || "", sub = /^[a-z0-9][a-z0-9._/-]{0,120}$/i.test(to) && !to.includes("..") ? to : "";   // a page inside their profile
        res.writeHead(302, { location: `/@${pr.handle}/${sub}`, "set-cookie": ownCookie(t, OWN_AGE), "cache-control": "no-store" }); return res.end();
      }
      if (req.method === "GET" && p === "/v1/own/out") {   // older bars: every sign-out goes through /signout
        const h = (url.searchParams.get("h") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
        res.writeHead(302, { location: `/signout${h ? `?h=${h}` : ""}`, "cache-control": "no-store" }); return res.end();
      }
      // who is signed in on this browser (the site nav swaps "Sign in" for the account menu)
      if (req.method === "GET" && p === "/v1/session") {
        const me = memberOf(req), pr = me ? profile(me) : null;
        res.setHeader("cache-control", "no-store");
        if (!pr?.handle) return json(res, 200, { signedIn: false });
        const n = navFor(pr, "public");
        return json(res, 200, { signedIn: true, handle: pr.handle, name: pr.name || "", page: n.publicHref, private: n.privateHref, privateExternal: !!n.privateExternal, signout: n.signout });
      }
      // sign out: GET asks, POST clears the owner cookie (and its session row) and the GitHub session, then back to the page
      if (p === "/signout") {
        const h = (url.searchParams.get("h") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (req.method === "POST") {
          const o = String(req.headers.origin || ""); if (o && !sameOrigin(req)) return json(res, 403, { error: "wrong origin" });
          const t = reqCookies(req)[OWN_COOKIE]; if (t) q("DELETE FROM owner_sessions WHERE token_hash=?").run(hashToken(t));
          GH.signOut(req, res);
          const prev = res.getHeader("set-cookie"), list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
          res.setHeader("set-cookie", [...list, ownCookie("", 0)]);
          res.writeHead(303, { location: h && byHandle(h) ? `/@${h}/` : "/", "cache-control": "no-store" }); return res.end();
        }
        if (req.method === "GET") {
          const me = memberOf(req), pr = me ? profile(me) : null;
          return signinPage(res, 200, "Sign out", pr ? `<h1>Sign out?</h1><p class="lede">This browser is signed in as <b>@${String(pr.handle).replace(/[<>&"]/g, "")}</b>. Signing out removes the Private view button and the account menu here. Your page stays exactly as it is.</p>
<form method="post" action="/signout${h ? `?h=${h}` : ""}"><button class="btn" type="submit">Sign out</button> <a class="btn ghost" href="${h ? `/@${h}/` : "/"}">Cancel</a></form>`
            : `<h1>You're signed out</h1><p class="lede">This browser isn't signed in to Caldera.</p><p><a class="btn" href="/signin">Sign in</a> <a class="btn ghost" href="${h ? `/@${h}/` : "/"}">Back</a></p>`);
        }
      }

      if (p === "/signin" || p.startsWith("/signin/")) {
        const form = async () => { const chunks: Buffer[] = []; let n = 0; for await (const c of req) { n += (c as Buffer).length; if (n > 8192) break; chunks.push(c as Buffer); } return new URLSearchParams(Buffer.concat(chunks).toString("utf8")); };
        const origin = String(req.headers.origin || ""), pubOrigin = originOf(opts.publicUrl);
        if (req.method === "POST" && origin && pubOrigin && origin !== pubOrigin) return json(res, 403, { error: "wrong origin" });
        const ip = ipOf(req);
        if (req.method === "GET" && p === "/signin") {
          if (!url.searchParams.get("h")) { signinGeneral(res); return; }
          const pr = byHandle((url.searchParams.get("h") || "").toLowerCase()); if (!pr || modOf(pr.handle, pr.id)) { signinPage(res, 404, "Sign in", `<h1>No such page</h1><p><a href="/people">Find people</a></p>`); return; }
          signinHome(res, pr); return;
        }
        if (req.method === "POST" && p === "/signin/email") {
          const f = await form(), pr = byHandle(String(f.get("h") || "").toLowerCase()), email = String(f.get("email") || "").trim().slice(0, 200);
          if (!pr || modOf(pr.handle, pr.id)) { signinPage(res, 404, "Sign in", `<h1>No such page</h1>`); return; }
          if (tooMany("email-ip:" + ip, 10) || tooMany("email-h:" + pr.handle, 5)) { signinHome(res, pr, "Too many tries. Wait an hour, or pair from Obsidian."); return; }
          if (mail.matches(pr.id, email)) {   // only the page's confirmed summary address ever gets a link; the answer is the same either way
            const code = crypto.randomBytes(24).toString("base64url");
            q("DELETE FROM signin_links WHERE expires < ?").run(Date.now());
            q("INSERT INTO signin_links VALUES (?,?,?)").run(hashToken(code), pr.id, Date.now() + 15 * 60_000);
            const link = `${(opts.publicUrl || "").replace(/\/$/, "")}/signin/link?c=${encodeURIComponent(code)}`;
            void mail.sendSignin(pr.id, pr.handle, link).catch((e: any) => console.error("signin mail", e?.message));
          }
          signinHome(res, pr, "If that's the email on this page, a sign-in link is on its way. It works once, for 15 minutes. Check your spam folder too."); return;
        }
        if (p === "/signin/link") {   // GET shows a button (mail scanners only GET); POST uses the link, once
          const c = req.method === "POST" ? String((await form()).get("c") || "") : url.searchParams.get("c") || "";
          const row = c ? q("SELECT * FROM signin_links WHERE code_hash=?").get(hashToken(c)) as any : null;
          const pr = row && row.expires > Date.now() ? profile(row.owner) : null;
          if (!pr?.handle) { signinPage(res, 400, "Link expired", `<h1>That link expired</h1><p class="mut">Sign-in links work once, for 15 minutes. Ask for a new one from the "Owner? Sign in" link at the top of your page.</p>`); return; }
          const e = (v: string) => v.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
          if (req.method === "GET") { signinPage(res, 200, "Sign in", `<h1>Sign in as @${e(pr.handle)}</h1><p class="lede">Sign this browser in as the owner of the page. It stays signed in for a year; "Sign out" in the bar at the top of your page ends it.</p><form method="post" action="/signin/link"><input type="hidden" name="c" value="${e(c)}"><button class="btn" type="submit">Sign in on this device</button></form>`); return; }
          q("DELETE FROM signin_links WHERE code_hash=?").run(row.code_hash);
          res.writeHead(303, { location: `/@${pr.handle}/`, "set-cookie": startOwner(pr.id), "cache-control": "no-store" }); return res.end();
        }
        if (req.method === "POST" && p === "/signin/pair") {
          const b = await readBody(req).catch(() => ({})) as any, pr = byHandle(String(b?.h || "").toLowerCase());
          if (!pr || modOf(pr.handle, pr.id) || hostedOf(pr.id)) return json(res, 404, { error: "Pairing is for pages made in Obsidian." });
          if (tooMany("pair-ip:" + ip, 20)) return json(res, 429, { error: "Too many codes from this network. Wait a bit." });
          const code = pairCode(), poll = crypto.randomBytes(24).toString("base64url");
          q("DELETE FROM pair_codes WHERE expires < ?").run(Date.now());
          q("INSERT INTO pair_codes VALUES (?,?,?,?,?)").run(hashToken(poll), hashToken(code), pr.id, Date.now() + 10 * 60_000, 0);
          return json(res, 200, { code, poll, expires_in: 600 });
        }
        if (req.method === "GET" && p === "/signin/pair/status") {
          const row = q("SELECT approved, expires FROM pair_codes WHERE poll_hash=?").get(hashToken(url.searchParams.get("p") || "")) as any;
          res.setHeader("cache-control", "no-store");
          return json(res, 200, { state: !row || row.expires < Date.now() ? "expired" : row.approved ? "approved" : "waiting" });
        }
        if (req.method === "POST" && p === "/signin/pair/done") {
          const pp = String((await form()).get("p") || ""), row = pp ? q("SELECT * FROM pair_codes WHERE poll_hash=?").get(hashToken(pp)) as any : null;
          const pr = row && row.approved && row.expires > Date.now() ? profile(row.owner) : null;
          if (row) q("DELETE FROM pair_codes WHERE poll_hash=?").run(row.poll_hash);   // single use
          if (!pr?.handle) { signinPage(res, 400, "Code expired", `<h1>That code expired</h1><p class="mut">Go back and get a new one.</p>`); return; }
          res.writeHead(303, { location: `/@${pr.handle}/`, "set-cookie": startOwner(pr.id), "cache-control": "no-store" }); return res.end();
        }
      }
      // the owner approves a pairing code from Obsidian (signed in with the vault's key): only codes made for their own page
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/pair$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        if (tooMany("approve:" + m[1], 30)) return json(res, 429, { error: "too many tries" });
        const { code } = await readBody(req) as { code?: string }, c = normCode(code);
        const row = c.length === 6 ? q("SELECT * FROM pair_codes WHERE code_hash=? AND owner=? AND expires > ? AND approved=0").get(hashToken(c), m[1], Date.now()) as any : null;
        if (!row) return json(res, 404, { error: "No waiting code like that for your page. Codes work for 10 minutes; get a fresh one on the sign-in page." });
        q("UPDATE pair_codes SET approved=1 WHERE poll_hash=?").run(row.poll_hash);
        return json(res, 200, { ok: true, handle: profile(m[1])?.handle });
      }

      if (req.method === "POST" && p === "/v1/auth/challenge") {
        const { id } = await readBody(req); const nonce = crypto.randomBytes(24).toString("base64");
        q("INSERT INTO challenges VALUES (?,?,?)").run(id, nonce, Date.now() + 5 * 60_000);
        return json(res, 200, { nonce });
      }
      if (req.method === "POST" && p === "/v1/auth/verify") {
        const env = await readBody(req) as C.Envelope;   // a "message" envelope whose body is { nonce }
        if (!C.verify(env)) return json(res, 401, { error: "bad signature" });
        const ch = q("SELECT * FROM challenges WHERE id=? AND nonce=? AND expires > ?").get(env.from, env.body?.nonce, Date.now());
        if (!ch) return json(res, 401, { error: "unknown or expired challenge" });
        q("DELETE FROM challenges WHERE id=?").run(env.from);
        const token = crypto.randomBytes(24).toString("hex");
        q("INSERT INTO tokens VALUES (?,?,?)").run(hashToken(token), env.from, Date.now() + 3600_000);  // only the hash is stored
        return json(res, 200, { token, expires_in: 3600 });
      }

      // daily summary email: owner subscribes (double opt-in), confirm + one-click unsubscribe links from the emails
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/email$/);
      if (m && (req.method === "GET" || req.method === "POST")) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        if (req.method === "GET") return json(res, 200, mail.status(m[1]) || { email: null, confirmed: false });
        const { email } = await readBody(req) as { email?: string | null };
        if (!email) { mail.unsubscribe(m[1]); return json(res, 200, { ok: true, off: true }); }
        try { return json(res, 200, { ok: true, message: await mail.subscribe(m[1], String(email)) }); } catch (e: any) { return json(res, 400, { error: e.message }); }
      }
      // links in emails get prefetched by mail scanners: GET only shows a button, the POST does the work
      if ((p === "/v1/email/confirm" || p === "/v1/email/unsub") && (req.method === "GET" || req.method === "POST")) {
        const t = (url.searchParams.get("t") || "").replace(/[^\w-]/g, ""), conf = p.endsWith("confirm");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        if (req.method === "GET") return res.end(mail.page(conf ? "Confirm your daily summary" : "Unsubscribe", `<form method="post" action="${p}?t=${t}"><p>${conf ? "Send me a short Caldera summary on days something happens." : "Stop sending Caldera summary emails to this address."}</p><button class="btn" type="submit">${conf ? "Yes, subscribe me" : "Unsubscribe"}</button></form>`));
        if (conf) { const ok = mail.confirm(t); return res.end(mail.page(ok ? "You're subscribed" : "Link expired", ok ? "<p>Your daily Caldera summary starts with the next one. It only comes on days something happens, and every email has a one-click unsubscribe.</p>" : "<p>This confirmation link isn't valid any more. Ask for a new one from Caldera.</p>")); }
        mail.unsubToken(t);   // idempotent; also the RFC 8058 one-click POST from the List-Unsubscribe header
        return res.end(mail.page("You're unsubscribed", "<p>No more Caldera summary emails will go to this address. You can turn them back on any time from Caldera.</p>"));
      }

      // Owner-only activity for the private view inside Obsidian: who looked, what they read, gravity, new friends, links in.
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/activity$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle) return json(res, 404, { error: "publish your profile first" });
        const since = url.searchParams.get("since") || new Date(Date.now() - 86400_000).toISOString();
        const h = pr.handle as string;
        const v = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(h, since) as any;
        const pages = (q("SELECT path, COUNT(*) n FROM page_views WHERE handle=? AND ts > ? GROUP BY path ORDER BY n DESC LIMIT 8").all(h, since) as any[]).map(r => [r.path, r.n]);
        const d14 = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
        const days = (q("SELECT substr(ts,1,10) d, COUNT(*) n, COUNT(DISTINCT visitor) u FROM page_views WHERE handle=? AND ts >= ? GROUP BY d ORDER BY d").all(h, d14) as any[]).map(r => [r.d, r.n, r.u]);
        const total = (q("SELECT COUNT(*) n FROM page_views WHERE handle=?").get(h) as any).n;
        const hn = (id: string) => (profile(id)?.handle as string) || null;
        const gravity = (q("SELECT sender, reason, ts FROM gravity WHERE recipient=? AND ts > ? ORDER BY ts DESC LIMIT 20").all(m[1], since) as any[]).map(r => ({ from: hn(r.sender), reason: r.reason || "", ts: r.ts }));
        const friends = (q("SELECT a, b, ts FROM friends WHERE (a=? OR b=?) AND ts > ? ORDER BY ts DESC LIMIT 20").all(m[1], m[1], since) as any[]).map(r => ({ handle: hn(r.a === m![1] ? r.b : r.a), ts: r.ts }));
        const links = (q("SELECT src_handle, src_slug, src_title, dst_slug FROM garden_links WHERE dst_handle=? AND src_handle<>? LIMIT 20").all(h, h) as any[]);
        const asks = (q("SELECT title, status, ts FROM asks WHERE author=? ORDER BY ts DESC LIMIT 10").all(m[1]) as any[]);
        const pv = q("SELECT ts FROM owner_private WHERE owner=?").get(m[1]) as any;
        return json(res, 200, { emailConfirmed: mail.hasConfirmed(m[1]), since, handle: h, views: v.n, visitors: v.u, pages, days, totalViews: total, viewsAll: viewsOf(h), viewsWeek: viewsOf(h, new Date(Date.now() - 7 * DAY).toISOString()), showViews: body(pr).showViews !== false, kudos: kudosFor(m[1], since), kudosTally: Object.fromEntries(tallyOf(m[1])), gravity, friends, links, asks, privateUrl: privateFor(h), privatePushed: pv?.ts });
      }
      // The owner's private layer, pushed from Obsidian for their private (Tailscale-only) address. Encrypted at rest.
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/private$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle || !privateFor(pr.handle)) return json(res, 403, { error: "no private address is set up for this profile on this hub" });
        const { html, built, pages, v } = await readBody(req) as { html?: string; built?: string; pages?: Record<string, unknown>; v?: string };
        const newer = staleClient(m[1], "private", v); if (newer) return json(res, 409, { error: `Caldera ${newer} already pushed this; update Caldera here (you have ${v || "an older version"})` });
        if (typeof html !== "string" || html.length > 3_000_000) return json(res, 400, { error: "bad private layer" });
        const priv: Record<string, string> = {};   // private versions of whole pages (only the city, for now)
        for (const [k, v] of Object.entries(pages || {})) if (k === "city.html" && typeof v === "string" && v.length < 4_000_000) priv[k] = v;
        q("INSERT OR REPLACE INTO owner_private VALUES (?,?,?,?)").run(m[1], seal(JSON.stringify({ layer: html, pages: priv })), String(built || now()).slice(0, 40), now());
        return json(res, 200, { ok: true, url: privateFor(pr.handle) });
      }

      // live traffic: the owner registers their sites (one key per district); the hub hands back each site's server secret
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/sites$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const { sites, repos } = await readBody(req) as { sites?: { key?: string; project?: string; public?: boolean }[]; repos?: Record<string, string> };
        if (!Array.isArray(sites) || sites.length > 60) return json(res, 400, { error: "send up to 60 sites" });
        const keep = new Set<string>();
        for (const s of sites) {
          const key = String(s.key || ""), project = String(s.project || "").trim().slice(0, 80);
          if (!/^[a-z0-9]{12,32}$/.test(key) || !project) continue;
          const row = q("SELECT owner FROM traffic_sites WHERE key=?").get(key) as any;
          if (row && row.owner !== m[1]) continue;   // someone else's key
          if (row) q("UPDATE traffic_sites SET project=?, public=? WHERE key=?").run(project, s.public ? 1 : 0, key);
          else q("INSERT INTO traffic_sites VALUES (?,?,?,?,?,?)").run(key, m[1], project, s.public ? 1 : 0, crypto.randomBytes(18).toString("hex"), now());
          keep.add(key);
        }
        for (const r of sitesOf(m[1])) if (!keep.has(r.key)) { q("DELETE FROM traffic_sites WHERE key=?").run(r.key); q("DELETE FROM traffic WHERE key=?").run(r.key); }
        // agents: one key per owner; the repo -> district map arrives hashed (the hub never needs private repo names to place a drone)
        const rmap: Record<string, string> = {};
        for (const [h, pj] of Object.entries(repos && typeof repos === "object" ? repos : {}).slice(0, 2000)) if (/^[0-9a-f]{16}$/.test(h)) rmap[h] = String(pj).slice(0, 80);
        let ak = q("SELECT key, secret FROM agent_keys WHERE owner=?").get(m[1]) as any;
        if (!ak) { ak = { key: crypto.randomBytes(9).toString("hex"), secret: crypto.randomBytes(18).toString("hex") }; q("INSERT INTO agent_keys VALUES (?,?,?,?,?)").run(ak.key, m[1], ak.secret, JSON.stringify(rmap), now()); }
        else if (repos) q("UPDATE agent_keys SET repos=? WHERE owner=?").run(JSON.stringify(rmap), m[1]);
        return json(res, 200, { sites: q("SELECT key, project, public, secret FROM traffic_sites WHERE owner=?").all(m[1]), agent: { key: ak.key, secret: ak.secret } });
      }
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/live$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        return json(res, 200, liveStats(m[1], true) || { at: now(), private: true, districts: {}, events: [] });
      }
      m = p.match(/^\/v1\/live\/([a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = byHandle(m[1]); if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, liveStats(pr.id, false, url.searchParams.get("since")) || { at: now(), districts: {} });
      }
      // the pixel: GET /v1/t/KEY.gif?k=view|signup|buy (also POST, for sendBeacon)
      m = p.match(/^\/v1\/t\/([a-z0-9]{12,32})(?:\.gif)?$/);
      if ((req.method === "GET" || req.method === "POST") && m) {
        const ua = String(req.headers["user-agent"] || ""), kind = ["signup", "buy"].includes(url.searchParams.get("k") || "") ? url.searchParams.get("k")! : "view";
        if (ua && !BOT_UA.test(ua) && q("SELECT 1 FROM traffic_sites WHERE key=?").get(m[1])) {
          const day = new Date().toISOString().slice(0, 10);
          try { record(m[1], kind, crypto.createHash("sha256").update(VIEW_SALT + day + ipOf(req) + ua).digest("hex").slice(0, 16)); } catch { /* never break the site */ }
        }
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
        return res.end(PIXEL);
      }
      // agents report what they're doing: POST /v1/agents/KEY  { agents: [{ id, label, machine, repo, state, task, did, tokens }] }
      m = p.match(/^\/v1\/agents\/([0-9a-f]{18})$/);
      if (req.method === "POST" && m) {
        const ak = q("SELECT owner, secret FROM agent_keys WHERE key=?").get(m[1]) as any;
        const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, "")), want = Buffer.from(String(ak?.secret || "x"));
        if (!ak || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 401, { error: "bad agent key or secret" });
        const { agents } = await readBody(req) as { agents?: any[] };
        if (!Array.isArray(agents) || agents.length > 50) return json(res, 400, { error: "send up to 50 agents" });
        const STATES = ["working", "thinking", "waiting", "idle", "done"], cut = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);
        let n = 0;
        for (const a of agents) {
          const id = cut(a?.id, 40); if (!/^[\w.:-]{4,40}$/.test(id)) continue;
          if (a.state === "gone") { q("DELETE FROM agents WHERE owner=? AND id=?").run(ak.owner, id); continue; }
          // details (label, machine, repo, task, last step) are sealed at rest; only the repo's hash stays readable, to place the drone
          const detail = seal(JSON.stringify({ label: cut(a.label, 60), machine: cut(a.machine, 40), repo: cut(a.repo, 80), task: cut(a.task, 90), did: cut(a.did, 90) }));
          q("INSERT OR REPLACE INTO agents VALUES (?,?,?,?,?,?,?,?,?,?)").run(ak.owner, id, "", "", a.repo ? repoHash(cut(a.repo, 80)) : "", STATES.includes(a.state) ? a.state : "working",
            detail, "", Math.max(0, Math.min(1e12, Number(a.tokens) || 0)), now()); n++;
        }
        q("DELETE FROM agents WHERE ts < ?").run(new Date(Date.now() - DAY).toISOString());
        return json(res, 200, { ok: true, recorded: n });
      }
      // server-side events from the owner's own feed: POST /v1/t/KEY/events  { events: [{ k, ts, v }] }  with the site secret
      m = p.match(/^\/v1\/t\/([a-z0-9]{12,32})\/events$/);
      if (req.method === "POST" && m) {
        const site = q("SELECT secret FROM traffic_sites WHERE key=?").get(m[1]) as any;
        const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, "")), want = Buffer.from(String(site?.secret || "x"));
        if (!site || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 401, { error: "bad site key or secret" });
        const { events } = await readBody(req) as { events?: { k?: string; ts?: string; v?: string }[] };
        if (!Array.isArray(events) || events.length > 1000) return json(res, 400, { error: "send up to 1000 events" });
        const lo = Date.now() - DAY, hi = Date.now() + 60_000, day = new Date().toISOString().slice(0, 10); let n = 0;
        for (const e of events) {
          const t = Date.parse(String(e.ts || "")); if (!(t > lo && t < hi)) continue;
          const kind = ["view", "signup", "buy"].includes(String(e.k)) ? String(e.k) : "view";
          if (record(m[1], kind, crypto.createHash("sha256").update(VIEW_SALT + day + String(e.v || "")).digest("hex").slice(0, 16), new Date(t).toISOString())) n++;
        }
        return json(res, 200, { ok: true, recorded: n });
      }

      // open friend requests, both ways: the source of truth for the plugin's "Friend requests" list (a request
      // never depends on the client having kept it); one row per person, newest request wins
      m = p.match(/^\/v1\/requests\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        return json(res, 200, openRequests(m[1]));
      }

      m = p.match(/^\/v1\/inbox\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const since = url.searchParams.get("since") || "1970-01-01";
        const rows = q("SELECT json FROM envelopes WHERE recipient=? AND ts > ? ORDER BY ts LIMIT 500").all(m[1], since) as any[];
        return json(res, 200, { envelopes: rows.map(r => JSON.parse(r.json)) });
      }

      if (req.method === "GET" && p === "/v1/profiles") {
        const term = "%" + (url.searchParams.get("q") || "").toLowerCase() + "%";
        const rows = q(`SELECT id, handle, name, headline, box_key FROM profiles WHERE handle IS NOT NULL AND
          (lower(name) LIKE ? OR lower(handle) LIKE ? OR lower(headline) LIKE ? OR lower(manifest) LIKE ?) ORDER BY updated DESC LIMIT 50`).all(term, term, term, term);
        return json(res, 200, { profiles: (rows as any[]).filter(r => !modOf(r.handle, r.id)) });
      }
      if (req.method === "GET" && p === "/v1/directory") {
        const term = (url.searchParams.get("q") || "").toLowerCase().trim(), sort = url.searchParams.get("sort") || "active";
        const rows = (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed).map(pr => {
          const b = body(pr), avatar = b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
          return { handle: pr.handle, name: pr.name, headline: pr.headline, avatar, topics: (b.topics || []).slice(0, 3).map((t: any) => t[0]),
            week: weekScore(pr.manifest), gravity: gravityOf(pr.id), invited: invitedCount(pr.id), created: pr.created, updated: pr.updated, city: fs.existsSync(path.join(opts.dataDir, "profiles", pr.handle, "city.html")) };
        }).filter(r => !term || [r.handle, r.name, r.headline, ...r.topics].join(" ").toLowerCase().includes(term));
        rows.sort(sort === "new" ? (a, b) => String(b.created).localeCompare(String(a.created)) : (a, b) => b.week - a.week || b.gravity - a.gravity);
        return json(res, 200, { total: rows.length, profiles: rows.slice(0, 120) });
      }
      m = p.match(/^\/v1\/profiles\/(cal:[1-9A-HJ-NP-Za-km-z]+|[a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = m[1].startsWith("cal:") ? profile(m[1]) : byHandle(m[1]);
        if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, { id: pr.id, handle: pr.handle, name: pr.name, headline: pr.headline, boxKey: pr.box_key, manifest: JSON.parse(pr.manifest) });
      }

      m = p.match(/^\/v1\/suggest\/(cal:[1-9A-HJ-NP-Za-km-z]+|[a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = m[1].startsWith("cal:") ? profile(m[1]) : byHandle(m[1]);
        if (!pr) return json(res, 404, { error: "not found" });
        return json(res, 200, { suggestions: suggestFor(pr.id, Math.max(1, Math.min(12, Number(url.searchParams.get("n")) || 3))).map(({ score, ...r }) => r) });
      }
      if (req.method === "GET" && p === "/v1/leaderboard") {
        const of = url.searchParams.get("scope") === "friends" ? url.searchParams.get("of") : null;
        return json(res, 200, { scope: of ? "friends" : "global", rows: leaderboard(of) });
      }
      if (req.method === "GET" && p === "/v1/asks") {
        settleExpiredAsks();
        const tag = url.searchParams.get("tag");
        const rows = (q("SELECT a.*, p.handle, p.name FROM asks a LEFT JOIN profiles p ON p.id=a.author WHERE a.status='open' AND a.visibility='public' ORDER BY a.ts DESC LIMIT 100").all() as any[])
          .map(a => ({ ...a, tags: JSON.parse(a.tags) })).filter(a => !tag || a.tags.includes(tag));
        return json(res, 200, { asks: rows });
      }
      if (req.method === "GET" && p === "/v1/offers") {
        const rows = (q("SELECT o.*, p.handle, p.name FROM offers o LEFT JOIN profiles p ON p.id=o.author ORDER BY o.ts DESC LIMIT 100").all() as any[]).map(o => ({ ...o, tags: JSON.parse(o.tags) }));
        return json(res, 200, { offers: rows });
      }
      m = p.match(/^\/v1\/gravity\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        const recent = q("SELECT g.sender, g.ts, g.reason, p.handle, p.name FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? ORDER BY g.ts DESC LIMIT 20").all(m[1]);
        return json(res, 200, { id: m[1], gravity: gravityOf(m[1]), recent });
      }
      m = p.match(/^\/v1\/credits\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        settleExpiredAsks();
        return json(res, 200, { id: m[1], balance: balance(m[1]), ledger: q("SELECT * FROM ledger WHERE who=? ORDER BY ts DESC LIMIT 50").all(m[1]) });
      }
      m = p.match(/^\/v1\/friends\/(cal:[1-9A-HJ-NP-Za-km-z]+)$/);
      if (req.method === "GET" && m) {
        const rows = q("SELECT f.b AS id, p.handle, p.name, p.box_key FROM friends f LEFT JOIN profiles p ON p.id=f.b WHERE f.a=?").all(m[1]);
        return json(res, 200, { friends: rows });
      }
      json(res, 404, { error: "not found" });
    } catch (err: any) {
      json(res, err?.message === "too large" ? 413 : 400, { error: String(err?.message || err) });
    }
  });

  // ---------------------------------------------------------------- private owner address
  // Listens on 127.0.0.1 only; meant to sit behind `tailscale serve`, which sets Tailscale-User-Login for the
  // connecting tailnet user (clients can't reach this port directly, so they can't forge the header).
  const privateServer = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    guardLinks(req, res);
    res.setHeader("cache-control", "no-store"); res.setHeader("x-robots-tag", "noindex, nofollow");
    try {
      const url = new URL(req.url || "/", "http://private");
      const login = String(req.headers["tailscale-user-login"] || "").toLowerCase();
      const mine = owners[login];
      if (!mine) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Private Caldera address: only the profile owner's Tailscale account can open it."); }
      if (url.pathname.startsWith("/setup/github") && await GH.privateRoute(req, res, url)) return;
      if (/^\/watch(\/(@[a-z0-9-]+\/?)?)?$/.test(url.pathname)) {   // the private city, popped out (see watchPage)
        const prw = byHandle(mine);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": WATCH_CSP });
        return res.end(watchPage(prw?.name || "@" + mine, `/@${mine}/city.html${url.search}#mini`));
      }
      const m = url.pathname.match(/^\/@([a-z0-9-]+)(\/.*)?$/);
      if (!m) { res.writeHead(302, { location: `/@${mine}/` }); return res.end(); }
      if (m[1] !== mine) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("This private address only shows your own profile."); }
      if (!m[2]) { res.writeHead(301, { location: `/@${mine}/${url.search}` }); return res.end(); }
      if (m[2] === "/live.json") {   // the private city polls this; the token in the page stops other sites reading it through your browser
        const t = url.searchParams.get("t") || "", y = new Date(Date.now() - DAY).toISOString().slice(0, 10), pr0 = byHandle(mine);
        if (!pr0 || (t !== liveToken(mine) && t !== liveToken(mine, y))) { res.writeHead(403, { "content-type": "application/json" }); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify(liveStats(pr0.id, url.searchParams.get("view") !== "public", url.searchParams.get("since")) || { at: now(), districts: {} }));
      }
      const dir = path.join(opts.dataDir, "profiles", mine);
      let rel = m[2].slice(1) || "index.html"; if (rel.endsWith("/")) rel += "index.html";
      const file = path.join(dir, path.normalize(rel));
      const pr = byHandle(mine), row = pr ? q("SELECT blob, built FROM owner_private WHERE owner=?").get(pr.id) as any : null;
      const pub = url.searchParams.get("view") === "public";
      let priv: { layer: string; pages: Record<string, string> } = { layer: "", pages: {} };
      if (row) { try { const s = unseal(row.blob); priv = s.startsWith('{"layer"') ? JSON.parse(s) : { layer: s, pages: {} }; } catch { priv = { layer: "<p>Couldn't read the private layer. Push again from Obsidian.</p>", pages: {} }; } }
      const own = !pub && priv.pages[rel];
      if (!own && (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory())) { res.writeHead(404); return res.end("not found"); }
      res.removeHeader("x-frame-options");
      const headers = { "content-type": own ? "text/html; charset=utf-8" : MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-security-policy": PROFILE_CSP };
      if (!own && path.extname(file).toLowerCase() !== ".html") { res.writeHead(200, headers); return fs.createReadStream(file).pipe(res); }
      let html = own || liveBlocks(mine, rel, fs.readFileSync(file, "utf8"));
      const ago = (iso: string) => { const mn = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return mn < 60 ? `${mn} min ago` : mn < 2880 ? `${Math.floor(mn / 60)} h ago` : `${Math.floor(mn / 1440)} days ago`; };
      // the same bar as the public page signed in as owner: [Public view | Private view] in the same place, account menu on the right
      const nav = pr ? navFor(pr, "private", rel) : null;
      if (nav) nav.note = row ? `Private sections pushed from Obsidian ${ago(row.built)}. Only your Tailscale account can open this address.` : "No private sections yet: turn on the private address in Caldera settings in Obsidian.";
      const bar = nav ? calderaBar(opts.publicUrl || "https://caldera.social", mine, nav) : "";
      if (rel === "index.html" && !pub && row) html = html.replace("<!--caldera:owner-->", priv.layer);
      if (rel === "city.html" && pr && (sitesOf(pr.id).length || q("SELECT 1 FROM agent_keys WHERE owner=?").get(pr.id))) html = injectLive(html, { url: `live.json?t=${liveToken(mine)}${pub ? "&view=public" : ""}`, mode: pub ? "public" : "private" });
      if (rel === "city.html" && pr) { html = cityExtras(html, pub ? null : pr.id); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.privateUrl), originOf(opts.publicUrl)); }
      html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar) : bar + html;
      res.writeHead(200, headers); return res.end(html);
    } catch (err: any) { res.writeHead(500, { "content-type": "text/plain" }); res.end("error"); }
  });

  return { server, privateServer, db, admin, mail, act: { token: (v: string, h: string, ttl?: number) => actToken(v, h, ttl), read: readAct },
    listen: (port = opts.port || 8787, host = process.env.CALDERA_HOST || "127.0.0.1") => new Promise<number>(r => server.listen(port, host, () => r((server.address() as any).port))),
    listenPrivate: (port = opts.privatePort || 0) => new Promise<number>(r => privateServer.listen(port, "127.0.0.1", () => r((privateServer.address() as any).port))) };
}

// CLI: node dist/server.js  (env: CALDERA_DATA, PORT, CALDERA_PUBLIC_URL)
if (import.meta.url === `file://${process.argv[1]}` && /server\.js$/.test(process.argv[1] || "")) {
  // Owner alerts on signups/deletions: Telegram and/or email (Resend). Both optional, fire-and-forget.
  const tg = process.env.CALDERA_TELEGRAM_TOKEN, chat = process.env.CALDERA_TELEGRAM_CHAT, site = process.env.CALDERA_PUBLIC_URL || "https://caldera.social";
  const resend = process.env.CALDERA_RESEND_KEY, mailTo = process.env.CALDERA_NOTIFY_EMAIL, mailFrom = process.env.CALDERA_NOTIFY_FROM || "Caldera <inbox@caldera.social>";
  const onEvent: HubOptions["onEvent"] = (tg && chat) || (resend && mailTo) ? (ev) => {
    const who = ev.handle ? `@${ev.handle}` : "(no handle)";
    const subject = ev.type === "signup" ? `New Caldera profile: ${who} (${ev.total} total)` : `Caldera profile deleted: ${who} (${ev.total} total)`;
    const text = ev.type === "signup" ? `New Caldera profile: ${who}${ev.name ? ` (${ev.name})` : ""}\nTotal profiles: ${ev.total}\n${site}/@${ev.handle || ""}/\n\nAll profiles: ${site}/people.html`
      : `Caldera profile deleted: ${who}. Total profiles: ${ev.total}`;
    const warn = (what: string) => (r: Response) => { if (!r.ok) console.error(what + " notify failed", r.status); };
    if (tg && chat) fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) })
      .then(warn("telegram")).catch(err => console.error("telegram notify error", String(err)));
    if (resend && mailTo) fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + resend, "content-type": "application/json" }, body: JSON.stringify({ from: mailFrom, to: [mailTo], subject, text }) })
      .then(warn("email")).catch(err => console.error("email notify error", String(err)));
  } : undefined;
  const hub = createHub({ dataDir: process.env.CALDERA_DATA || "./data", port: Number(process.env.PORT || 8787), publicUrl: process.env.CALDERA_PUBLIC_URL || "",
    siteDir: process.env.CALDERA_SITE || undefined, trustProxy: process.env.CALDERA_TRUST_PROXY === "1", onEvent, founder: process.env.CALDERA_FOUNDER || undefined,
    email: resend ? { resendKey: resend, schedule: true } : undefined,
    // CALDERA_TAILNET_OWNERS="you@example.com:handle,..."  (Tailscale login -> Caldera handle)
    privatePort: Number(process.env.CALDERA_PRIVATE_PORT) || undefined, privateUrl: process.env.CALDERA_PRIVATE_URL || undefined,
    tailnetOwners: Object.fromEntries((process.env.CALDERA_TAILNET_OWNERS || "").split(",").map(s => s.trim().split(":")).filter(x => x.length === 2 && x[0] && x[1]).map(([l, h]) => [l.toLowerCase(), h.toLowerCase()])) });
  hub.listen().then(p => console.log(`Caldera Hub listening on :${p}`));
  if (process.env.CALDERA_PRIVATE_PORT) hub.listenPrivate().then(p => console.log(`Caldera private owner address on 127.0.0.1:${p}`));
}
