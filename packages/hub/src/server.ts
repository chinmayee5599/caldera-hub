/**
 * Caldera Hub - reference hub for the Caldera protocol (spec/PROTOCOL.md).
 * Stores and indexes signed envelopes, hosts profile pages, delivers encrypted cards,
 * enforces the gravity and credit rules, and serves discovery and leaderboards.
 * Zero framework: node:http + node:sqlite (Node 22+).
 */
import http from "node:http";
import { TRACK_JS } from "./hookpin.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as C from "@caldera/core";
import { github } from "./github";
import { connDots, type Conn } from "./settings";
import { alertsStore, bellHtml, type PostAlert, type Audience } from "./alerts";
import { appHeader, currentFor, swapHeader, swapFooter, setSiteFooter, HEADER_MARK, type HeaderItem, type HeaderViewer } from "./header";
import { loadExt, type Ext } from "./ext";
export { fallbacks as publicExt, type Ext } from "./ext";
export { effectiveTags, canonical, readmeSignal, depsOf } from "./tagkit";
import { building } from "./building";
import { cityArt, cardSvg, postCardSvg, toPng, groupPage, ogTags } from "./cards";
import { feed } from "./feed";
import { gifts } from "./gifts";
import { funnel } from "./funnel";
import { emailPages } from "./emailpages";
import { messages } from "./messages";
import { chat, CHAT_CSS, CHAT_JS } from "./chat";
import { ghPreview } from "./ghpreview";
export { cleanText, renderText } from "./messages";
import { emailer, type Mail } from "./email";
export { tagLinks } from "./email";
import { weatherService, dayStats, ownerSetup, extrasScript } from "./cityextra";
import { buildWorld, foldLive, worldPage, type World, type WorldMemberIn } from "./world";
import { citySnapshot, applyPrivateMode, rewriteCityPage, type CityData } from "../../../../caldera/packages/plugin/src/city";
import { privateModes, scrubPrivateLive } from "./privatemode";

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export interface HubOptions { dataDir: string; port?: number; publicUrl?: string; siteDir?: string; trustProxy?: boolean;
  /** the garden is paused (core flags.ts); true switches it back on for this hub (CLI: CALDERA_GARDEN=1) */
  garden?: boolean;
  /** open core: private hook implementations (or a directory to load them from; default CALDERA_PRIVATE_DIR) */ ext?: Ext; privateDir?: string;
  /** Private owner address (e.g. behind `tailscale serve`): a second listener on 127.0.0.1:privatePort that serves the
   *  owner's private view only when the proxy-set Tailscale-User-Login header maps to that profile's handle. */
  privatePort?: number; privateUrl?: string;
  /** Handle of the founder: every new profile starts out as their friend (MySpace's Tom). */ founder?: string; tailnetOwners?: Record<string, string>; githubFetch?: typeof fetch; /** run the shared-repo friendship job every 6 hours (the server binary turns it on; tests call it directly) */ repoJob?: boolean; /** read members' public GitHub signals into "what they're building" tags every 12 hours */ tagJob?: boolean; /** OpenRouter key for the tag normalising pass (rules only without it) */ llmKey?: string; onEvent?: (e: { type: "signup" | "delete"; handle?: string; name?: string; total: number }) => void; limits?: { perMinute?: number; writesPerMinute?: number; newProfilesPerDay?: number; newProfilesPerMinute?: number };
  /** daily summary emails: Resend key (production) or a send hook (tests); schedule starts the daily job */
  email?: { resendKey?: string; send?: (m: Mail) => Promise<void>; schedule?: boolean }; }

const MAX_BODY = 12 * 1024 * 1024;
const RESERVED = new Set(["admin", "api", "www", "caldera", "help", "support", "root", "hub", "v1", "about", "login", "settings", "official", "team", "security", "obsidian", "me", "auth", "setup"]);
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY" };
// User-uploaded profile pages run in a sandbox: unique origin, no access to the hub's origin, no forms, no top navigation.
const PROFILE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; manifest-src 'self'; base-uri 'none'; form-action 'none'";
// The city page may also poll the hub for live traffic on the owner's sites (same hub only).
const cityCsp = (...origins: string[]) => PROFILE_CSP + `; connect-src 'self' ${origins.filter(Boolean).join(" ")}`.trimEnd();
const originOf = (u?: string) => { try { return u ? new URL(u).origin : ""; } catch { return ""; } };
/** Home Screen app: the whole site is one app (scope "/"), so following a link from a saved page stays full screen
 *  instead of opening iOS's in-app browser sheet; viewport-fit=cover lets the phone tab bar clear the home indicator. */
const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Caldera"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="theme-color" content="#141416"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
function withAppHead(html: string): string {
  if (html.includes('rel="manifest"') || !/<\/head>/i.test(html)) return html;
  const out = html.replace(/<meta name="viewport" content="([^"]*)"/i, (m, c) => /viewport-fit/.test(c) ? m : `<meta name="viewport" content="${c}, viewport-fit=cover"`);
  const tags = /apple-touch-icon/.test(html) ? APP_HEAD.replace(/<link rel="apple-touch-icon"[^>]*>/, "") : APP_HEAD;   // keep a page's own icon
  return out.replace(/<\/head>/i, () => tags + "</head>");
}
export const MANIFEST = JSON.stringify({ name: "Caldera", short_name: "Caldera", id: "/", start_url: "/feed?src=homescreen", scope: "/", display: "standalone",
  background_color: "#141416", theme_color: "#141416", description: "The social layer for what you build",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }, { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] });
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const DAY = 86_400_000;

/** Platform bar injected at the top of every hosted profile: logo back to the hub + a sign-up call to action.
 *  Inline styles/SVG only (the profile CSP allows inline styles and blocks external resources). */
/** Kudos a member can send: stored by key, shown as emoji. */
export const KUDOS: Record<string, string> = { heart: "\u2764\uFE0F", up: "\u{1F44D}", fire: "\u{1F525}", sparkle: "\u2728" };
/** Who's looking, for the inline kudos + friend controls: a signed-in member gets a short-lived action token. */
export interface BarViewer { handle: string; token: string; sent: string | null; friend: FriendState; why?: string }
export type FriendState = "self" | "friends" | "incoming" | "requested" | "queued" | "none";
export interface BarSocial { views: number; showViews: boolean; tally: [string, number][]; owner: boolean; viewer?: BarViewer | null; inPage?: boolean; counts?: { friends: number; followers: number; following: number } }
export const FRIEND_LABEL: Record<FriendState, string> = { self: "", friends: "Friends \u2713", incoming: "Follow back", requested: "Following", queued: "Following", none: "+ Follow" };
const compact = (n: number) => n < 1000 ? String(n) : n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : Math.round(n / 1000) + "k";
export interface OwnerNav { handle: string; current: "public" | "private"; publicHref: string; privateHref: string; privateExternal?: boolean; signout: string; note?: string; stale?: number; settings?: string; conn?: { github: boolean; obsidian: boolean } }
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
@media (max-width:620px){#caldera-bar .cb-tag,#caldera-bar .cb-v,#caldera-bar .cb-word{display:none}#caldera-bar .cb-l>.cb-brand:first-child:not(:last-child){width:22px}#caldera-bar{flex-wrap:wrap}#caldera-bar .cb-sw a{padding:5px 10px}#caldera-bar .cb-short{display:inline}#caldera-bar.cb-anon .cb-l .cb-brand span:first-of-type{display:none}#caldera-bar .cb-r{gap:8px}#caldera-bar .cb-cl{display:none}}</style>`;

/** Views and kudos on every hosted page: a public tally plus "+ Kudos", which opens a small first-party window on the hub
 *  (profile pages are sandboxed, so the member's sign-in can only ride along there). */
function socialChips(base: string, handle: string, so: BarSocial): string {
  const e = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const chip = "display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 10px;border-radius:999px;background:var(--bg-raised,#1C1C21);border:1px solid var(--line,#2A2A2E);color:var(--text,#D6D6DC);font:500 12.5px 'IBM Plex Sans',Arial,sans-serif;white-space:nowrap";
  // three rows, one job each: who they are in numbers (plain text), what you can do (follow, message, kudos), never mixed
  const n = (v: number) => `<b>${compact(v)}</b>`, pl = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
  const c = so.counts, stats: string[] = [];
  if (c) stats.push(`<span title="Friends follow each other">${pl(c.friends, "friend", "friends")}</span>`, `<span>${pl(c.followers, "follower", "followers")}</span>`, `<span>${n(c.following)} following</span>`);
  if (so.showViews || so.owner) stats.push(`<span class="cb-views" title="${so.views.toLocaleString("en-US")} views${so.showViews ? "" : " (hidden: only you see this)"}">${pl(so.views, "view", "views")}${so.showViews ? "" : " (only you see this)"}</span>`);
  const count = (k: string) => so.tally.find(([x]) => x === k)?.[1] || 0;
  if (so.owner) {
    const tally = so.tally.filter(([, v]) => v > 0).map(([k, v]) => `${KUDOS[k] || ""}&nbsp;${compact(v)}`).join(" &nbsp;");
    if (tally) stats.push(`<span title="Kudos people sent you">${tally}</span>`);
    return `<div class="cb-social"><div class="cb-stats">${stats.join('<i aria-hidden="true">&middot;</i>')}</div></div>`;
  }
  // everyone else: follow, message and kudos act right here on the page (signed-in members, with the action token)
  const v = so.viewer || null, sent = v?.sent || null;
  const kd = Object.entries(KUDOS).map(([k, em]) => `<button type="button" class="cb-k${sent === k ? " on" : ""}" data-k="${k}"${sent ? ` disabled title="You sent kudos today. More tomorrow."` : ` title="Send @${e(handle)} ${em}"`}>${em}<i>${count(k) ? compact(count(k)) : ""}</i></button>`).join("");
  const fs = v ? v.friend : "none";
  const fr = fs === "self" ? "" : `<button type="button" class="cb-fr" data-caldera-friend="${e(handle)}" data-state="${fs}"${fs === "friends" ? " disabled" : ""}${fs === "friends" && v?.why ? ` title="Connected because ${e(v.why)}"` : fs === "requested" || fs === "queued" ? ` title="You follow @${e(handle)}. Tap to unfollow."` : fs === "incoming" ? ` title="@${e(handle)} follows you. Follow back to be friends."` : fs === "friends" ? "" : ` title="Follow @${e(handle)}. If they follow you back, you're friends."`}>${e(FRIEND_LABEL[fs])}</button>`;
  const msg = fs === "self" ? "" : `<a class="cb-msg" href="${e(base)}/messages/@${e(handle)}" target="_blank" rel="noopener" title="Send @${e(handle)} a message"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Message</a>`;
  // how you're connected reads as a quiet note next to the stats, not stuffed into the button
  if (fs === "friends" && v?.why) stats.push(`<span class="cb-why">Friends: ${e(v.why)}</span>`);
  return `<div class="cb-social"${v ? ` data-act="${e(v.token)}"` : ""} data-api="${e(base)}" data-h="${e(handle)}">${stats.length ? `<div class="cb-stats">${stats.join('<i aria-hidden="true">&middot;</i>')}</div>` : ""}<div class="cb-acts">${fr}${msg}<span class="cb-kd" role="group" aria-label="Send kudos">${kd}</span></div></div>`;
}

/** Inline kudos + friend for hosted pages: talks to /v1/act with the token the hub put in the page (the page is sandboxed
 *  with no cookies, so the token is the only credential). Anonymous visitors get a small sign-in prompt instead. */
const BAR_ACT_JS = `(function(){function go(){var S=document.querySelector('.cb-social[data-api]');if(!S)return;var api=S.getAttribute('data-api'),t=S.getAttribute('data-act'),H=S.getAttribute('data-h');
var L={friends:'Friends \\u2713',incoming:'Follow back',requested:'Following',queued:'Following',none:'+ Follow'};
function need(el){var p=document.getElementById('cb-need');if(!p)return;p.hidden=false;var r=el.getBoundingClientRect();p.style.top=(r.bottom+window.scrollY+8)+'px';p.style.left=Math.max(8,Math.min(r.left,window.innerWidth-300))+'px'}
document.addEventListener('click',function(ev){var p=document.getElementById('cb-need');if(p&&!p.hidden&&!p.contains(ev.target)&&!ev.target.closest('.cb-k,[data-caldera-friend]'))p.hidden=true});
function post(o){o.t=t;return fetch(api+'/v1/act',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(o)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}})},function(){return{ok:false,status:0,j:{error:'Could not reach Caldera. Check your connection.'}}})}
function burst(el,em){var r=el.getBoundingClientRect();for(var i=0;i<14;i++){var s=document.createElement('span');s.textContent=em;s.style.cssText='position:fixed;z-index:99;pointer-events:none;font-size:22px;left:'+(r.left+r.width/2-11)+'px;top:'+(r.top)+'px;transition:transform 1.3s cubic-bezier(.2,.7,.3,1),opacity 1.3s';document.body.appendChild(s);(function(s){requestAnimationFrame(function(){s.style.transform='translate('+(Math.random()*160-80)+'px,'+(120+Math.random()*120)+'px) scale(1.3)';s.style.opacity='0'});setTimeout(function(){s.remove()},1400)})(s)}}
function tip(el,msg){el.title=msg;var p=document.createElement('span');p.className='cb-tip';p.textContent=msg;var r=el.getBoundingClientRect();p.style.top=(r.bottom+window.scrollY+6)+'px';p.style.left=Math.max(8,Math.min(r.left,window.innerWidth-260))+'px';document.body.appendChild(p);setTimeout(function(){p.remove()},2600)}
var ks=S.querySelectorAll('.cb-k');ks.forEach(function(b){b.addEventListener('click',function(){if(!t)return need(b);ks.forEach(function(x){x.disabled=true});post({action:'kudos',kind:b.getAttribute('data-k')}).then(function(x){
if(x.ok){b.classList.add('on','pop');var i=b.querySelector('i');var n=parseInt((i.textContent||'0'),10);if(!isNaN(n)&&!/k$/.test(i.textContent))i.textContent=String(n+1);else if(!i.textContent)i.textContent='1';burst(b,b.firstChild.textContent);tip(b,'Sent! @'+H+' will see it.');ks.forEach(function(x){x.title='You sent kudos today. More tomorrow.'})}
else{tip(b,x.j.error||'Could not send.');if(x.status!==409)ks.forEach(function(y){y.disabled=false})}})})});
function setF(st){document.querySelectorAll('[data-caldera-friend]').forEach(function(f){if(!L[st])return;f.setAttribute('data-state',st);f.removeAttribute('data-sure');if(f.classList.contains('cb-fr'))f.textContent=L[st];else f.textContent=st==='none'?'+ Follow @'+H:st==='incoming'?'Follow @'+H+' back':L[st];var off=st==='friends';if(f.tagName==='BUTTON')f.disabled=off;else if(off)f.setAttribute('aria-disabled','true');else f.removeAttribute('aria-disabled')})}
document.querySelectorAll('[data-caldera-friend]').forEach(function(f){f.addEventListener('click',function(ev){ev.preventDefault();if(!t)return need(f);var st=f.getAttribute('data-state')||'none';if(st==='friends')return;
if((st==='requested'||st==='queued')&&!f.getAttribute('data-sure')){f.setAttribute('data-sure','1');var l=f.textContent;f.textContent='Tap again to unfollow';setTimeout(function(){if(f.getAttribute('data-sure')){f.removeAttribute('data-sure');f.textContent=l}},3500);return}
post({action:st==='incoming'?'accept':st==='none'?'friend':'unfollow'}).then(function(x){if(x.ok){setF(x.j.state);tip(f,x.j.state==='friends'?'You and @'+H+' follow each other: you are friends now.':x.j.state==='none'?'You unfollowed @'+H+'.':'You follow @'+H+'. If they follow you back, you are friends.')}else tip(f,x.j.error||'Could not do that.')})})})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go()})();`;

const BAR_ACT_CSS = `<style>.cb-row{margin:14px 0 20px}.cb-social{display:flex;flex-direction:column;gap:14px}.cb-stats{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;color:var(--text-muted,#9A9AA6);font:400 14px/1.4 'IBM Plex Sans',Arial,sans-serif;font-variant-numeric:tabular-nums}.cb-stats b{color:var(--text-strong,#F2F2F5);font-weight:600}.cb-stats>i{font-style:normal;opacity:.6}.cb-stats .cb-why{color:var(--accent-text,#B9A6FF)}.cb-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.cb-social .cb-kd{display:inline-flex;gap:2px;margin-left:auto;padding:2px;border-radius:999px;border:1px solid var(--line,#2A2A2E)}
.cb-social .cb-k{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:3px;min-height:26px;padding:0 7px;border-radius:999px;font-size:14px;line-height:1;transition:transform .15s,background .15s}.cb-social .cb-k i{font:500 11.5px 'IBM Plex Sans',Arial,sans-serif;font-style:normal;color:var(--text-muted,#B8B8C2);font-variant-numeric:tabular-nums}
.cb-social .cb-k:hover:not(:disabled){background:var(--bg-sunken,#2A2636);transform:translateY(-1px) scale(1.08)}.cb-social .cb-k:disabled{cursor:default;opacity:.55}.cb-social .cb-k.on{opacity:1;background:var(--accent-soft,#3A2F5C)}.cb-social .cb-k.pop{animation:cbpop .45s ease-out}
@keyframes cbpop{40%{transform:scale(1.35)}}.cb-social .cb-k:focus-visible,.cb-social .cb-fr:focus-visible{outline:2px solid #8B6CF6;outline-offset:1px}
.cb-social .cb-msg{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 14px;box-sizing:border-box;border-radius:999px;background:#7A58F0;color:#fff!important;font:600 12.5px 'IBM Plex Sans',Arial,sans-serif;text-decoration:none!important;white-space:nowrap}.cb-social .cb-msg:hover{filter:brightness(1.08)}.cb-social .cb-msg:focus-visible{outline:2px solid #8B6CF6;outline-offset:2px}
.cb-social .cb-fr{all:unset;cursor:pointer;box-sizing:border-box;display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--accent,#5B47B8);color:var(--text-strong,#F2F2F5);font:600 12.5px 'IBM Plex Sans',Arial,sans-serif;font-weight:600;white-space:nowrap}.cb-social .cb-fr:disabled{cursor:default;border-color:var(--line,#2A2A2E);color:var(--text-muted,#9A9AA6);font-weight:500}.cb-social .cb-fr[data-state="incoming"]{background:#8B6CF6;border-color:#8B6CF6}.cb-social .cb-fr[data-state="requested"],.cb-social .cb-fr[data-state="queued"]{border-color:var(--line,#2A2A2E);color:var(--text-muted,#B8B8C2);font-weight:500}
.cb-tip,#cb-need{position:absolute;z-index:100;max-width:280px;padding:8px 11px;border-radius:10px;background:#18171D;border:1px solid #2E2A40;color:#E6E6EA;font:500 12.5px/1.4 'IBM Plex Sans',Arial,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.45)}#cb-need[hidden]{display:none}
#cb-need b{display:block;margin-bottom:6px;color:#F2F2F5}#cb-need a{display:inline-flex;margin:4px 6px 0 0;padding:5px 11px;border-radius:999px;background:#8B6CF6;color:#fff;text-decoration:none;font-weight:600}#cb-need a.alt{background:transparent;border:1px solid #2E2A40;color:#E6E6EA}
@media (max-width:620px){.cb-social .cb-kd{margin-left:0}.cb-social .cb-k{padding:0 5px}.cb-social .cb-k i:empty{display:none}}@media (prefers-reduced-motion:reduce){.cb-social .cb-k.pop{animation:none}}</style>`;

/** The social row under the person's name on their profile and city: views, kudos and Add friend belong to the person,
 *  not to the site bar. Carries the sign-in prompt and the inline actions script. */
export function socialRow(hub: string, handle: string, so: BarSocial, back = ""): string {
  const base = hub.replace(/\/$/, ""), join = `${base}/?invite=${encodeURIComponent(handle)}`;
  const need = !so.owner && !so.viewer ? `<div id="cb-need" hidden role="dialog" aria-label="Sign in"><b>Sign in to send kudos and follow people</b>Caldera members can cheer each other on.<br><a href="${base}/auth/github${back ? `?back=${encodeURIComponent(back)}` : ""}" target="_blank" rel="noopener">Sign in with GitHub</a><a class="alt" href="${base}/signin" target="_blank" rel="noopener">Other ways</a><a class="alt" href="${join}#install" target="_blank" rel="noopener">Get your own page</a></div>` : "";
  return BAR_ACT_CSS + `<div class="cb-row">${socialChips(base, handle, so)}</div>` + need + (so.owner ? "" : `<script>${BAR_ACT_JS}</script>`);
}

/** THE Caldera bar: one component on every page that has one. Anonymous: logo, Owner? Sign in, Get your own page. Owner
 *  (public page with the owner cookie, or the private address): logo, the [Public view | Private view] switch in the same
 *  place on both addresses, then the account menu (@handle, Your public page, Private view, Sign out). Same height either way. */
/** The bar on hosted pages is now THE header (header.ts), swapped in at response time for the viewer of each request,
 *  so every page shows the same bar whatever plugin version built it. Callers keep this name; it returns the marker. */
export function calderaBar(hub: string, handle: string, _own?: OwnerNav | null, social?: BarSocial, _bell = ""): string {
  // pages with no title area to hang the social row on keep it right under the header
  return HEADER_MARK + (social && !social.inPage ? socialRow(hub, handle, social, `/@${handle}/`) : "");
}

/** Heatmap fix for profiles built before plugin 0.5.1 (their profile.css is frozen in the bundle): cells fill the column,
 *  room for the hover zoom, no stray scrollbar. Same rules as profile.css "Heatmap sizing (2026-10-12)". */
const HEAT_FIX = `<style>/* Heatmap sizing (2026-10-12) */.heat-box{container-type:inline-size}.heat-frame{--gap:3px;--cell:clamp(8px,calc((100cqw - 46px - 25 * var(--gap)) / 26),18px)}@container (max-width:460px){.heat-frame{--gap:2px}}.heat,.heat-days{gap:var(--gap,3px)}.heat-days{grid-template-rows:repeat(7,var(--cell,12px));line-height:var(--cell,12px)}.heat-wrap{overflow-x:auto;overflow-y:hidden;padding:4px;margin:-4px;scrollbar-width:none}.heat-wrap::-webkit-scrollbar{display:none}.heat{grid-template-rows:repeat(7,var(--cell,12px));grid-auto-columns:var(--cell,12px)}.heat i{width:var(--cell,12px);height:var(--cell,12px);border-radius:3px}.heat i[data-d]:hover,.heat i.is-sel{transform:scale(1.18)}</style>`;

/** The garden is paused (core flags.ts): pages built while it was on keep their files, but visitors never see them. These
 *  take the garden out of an already-published page: its stylesheet, the "Garden home" link, the Garden row in the
 *  on-this-page list, the Garden group in the side menu, and the Garden section itself. */
const gardenPath = (rel: string) => rel === "garden.html" || /^n\//.test(rel);
function stripGarden(html: string): string {
  return html
    .replace(/<link rel="stylesheet" href="assets\/garden\.css">/g, "")
    .replace(/<a class="tree-row toc-row page-row[^"]*" href="(?:\.\.\/)*garden\.html"[^>]*>Garden home<\/a>/g, "")
    .replace(/<a class="tree-row toc-row" href="#garden">Garden<\/a>/g, "")
    .replace(/<details class="tree-group"[^>]*>(?:(?!<\/details>)[\s\S])*?href="(?:\.\.\/)*garden\.html"(?:(?!<\/details>)[\s\S])*?<\/details>/g, "")
    .replace(/<h2 id="garden">[\s\S]*?(?=\n<h2 |<\/main>)/, "");
}

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
  C.FLAGS.garden = !!opts.garden;   // paused unless this hub turns it on
  fs.mkdirSync(path.join(opts.dataDir, "profiles"), { recursive: true });
  const ext = opts.ext || loadExt(opts.privateDir ?? process.env.CALDERA_PRIVATE_DIR);
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
    CREATE TABLE IF NOT EXISTS repo_tombstones (a TEXT, b TEXT, ts TEXT, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS gh_circle (member TEXT, login TEXT, relation TEXT, repo TEXT, seen TEXT, PRIMARY KEY (member, login, relation, repo));
    CREATE INDEX IF NOT EXISTS gh_circle_login ON gh_circle(login);
    CREATE TABLE IF NOT EXISTS friend_meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  // how two people became friends: request (accepted), invite (accepted request from an invitee), founder (the welcome
  // friendship every new profile gets), repo (both work on the same public GitHub repo; why = owner/repo)
  for (const col of ["kind TEXT DEFAULT 'request'", "why TEXT"]) { try { db.exec(`ALTER TABLE friends ADD COLUMN ${col}`); } catch { /* already there */ } }
  if (!db.prepare("SELECT 1 FROM friend_meta WHERE k='kinds_v1'").get()) {   // one-time backfill of kinds for rows made before they existed
    const fh = opts.founder ? (db.prepare("SELECT id FROM profiles WHERE handle=?").get(opts.founder.toLowerCase()) as any)?.id : null;
    const accepted = (a: string, b: string) => !!db.prepare("SELECT 1 FROM envelopes WHERE type='friend.accept' AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) LIMIT 1").get(a, b, b, a);
    const invited = (a: string, b: string) => !!db.prepare("SELECT 1 FROM referrals WHERE (invitee=? AND inviter=?) OR (invitee=? AND inviter=?)").get(a, b, b, a);
    const set = db.prepare("UPDATE friends SET kind=? WHERE a=? AND b=?");
    for (const r of db.prepare("SELECT a, b FROM friends").all() as any[]) {
      const kind = accepted(r.a, r.b) ? (invited(r.a, r.b) ? "invite" : "request") : fh && (r.a === fh || r.b === fh) ? "founder" : "request";
      set.run(kind, r.a, r.b);
    }
    db.prepare("INSERT OR REPLACE INTO friend_meta VALUES ('kinds_v1', ?)").run(new Date().toISOString());
  }
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
  // how each member's private repos show on their public city (privatemode.ts); enforced on every public page and feed below
  const PM = privateModes(q as any, undefined, (opts as any).privateModeSince);
  const alerts = alertsStore(q, crypto.createHash("sha256").update(PRIV_KEY).update("alerts").digest());
  const now = () => new Date().toISOString();

  // ---------------------------------------------------------------- helpers
  const profile = (id: string) => q("SELECT * FROM profiles WHERE id=?").get(id) as any;
  const byHandle = (h: string) => q("SELECT * FROM profiles WHERE handle=?").get(h) as any;
  // operator moderation (Terms s.3): hidden = taken down, owner cannot republish; blocked = handle can never be claimed
  const modOf = (handle: string | null, id?: string) => q("SELECT * FROM moderation WHERE handle=? OR (id IS NOT NULL AND id=?)").get(handle || "", id || "") as any;
  const body = (pr: any) => { try { return JSON.parse(pr.manifest).body || {}; } catch { return {}; } };
  const listed = (pr: any) => body(pr).listed !== false && !modOf(pr.handle, pr.id);
  const areFriends = (a: string, b: string) => !!q("SELECT 1 FROM friends WHERE a=? AND b=?").get(a, b);
  /** Following: a signed friend request (from Obsidian, or signed by the hub for GitHub sign-ups) or a follow tapped on the
   *  web by an Obsidian member that their plugin hasn't signed yet. Two people who follow each other are friends. */
  const follows = (a: string, b: string) => !!(q("SELECT 1 FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=? LIMIT 1").get(a, b) || q("SELECT 1 FROM friend_intents WHERE owner=? AND target=? AND kind='add'").get(a, b));
  const FOLLOW_EDGES = `SELECT sender a, recipient b FROM envelopes WHERE type='friend.request' UNION SELECT owner a, target b FROM friend_intents WHERE kind='add'`;
  function followCounts(id: string) {
    const live = `AND x IN (SELECT id FROM profiles) AND x NOT IN (SELECT id FROM moderation WHERE id IS NOT NULL) AND x NOT IN (SELECT b FROM friends WHERE a=?)`;
    const n = (sql: string) => (q(sql).get(id, id) as any).n as number;
    return { friends: (q("SELECT COUNT(*) n FROM friends WHERE a=? AND b IN (SELECT id FROM profiles)").get(id) as any).n as number,
      followers: n(`SELECT COUNT(DISTINCT x) n FROM (SELECT a x, b FROM (${FOLLOW_EDGES})) WHERE b=? ${live}`),
      following: n(`SELECT COUNT(DISTINCT x) n FROM (SELECT b x, a FROM (${FOLLOW_EDGES})) WHERE a=? ${live}`) };
  }
  /** Make two people friends (both directions). A real request or invite upgrades an existing welcome/repo link; a welcome
   *  or repo link never downgrades a real one. */
  function befriend(a: string, b: string, kind: "request" | "invite" | "intro" | "founder" | "repo" | "github", ts: string, why: string | null = null) {
    // what an incoming kind may replace: a real request or invite replaces any automatic link, a shared repo replaces a
    // follow or a welcome, a GitHub follow replaces a welcome
    const over = kind === "request" || kind === "invite" || kind === "intro" ? "('founder','repo','github')" : kind === "repo" ? "('founder','github')" : kind === "github" ? "('founder')" : "('')";
    for (const [x, y] of [[a, b], [b, a]]) q(`INSERT INTO friends (a, b, ts, kind, why) VALUES (?,?,?,?,?) ON CONFLICT(a, b) DO UPDATE SET
      why=CASE WHEN COALESCE(friends.kind,'request') IN ${over} THEN excluded.why ELSE friends.why END,
      kind=CASE WHEN COALESCE(friends.kind,'request') IN ${over} THEN excluded.kind ELSE friends.kind END`).run(x, y, ts, kind, why);
  }
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
    for (const r of q("SELECT target FROM friend_intents WHERE owner=?").all(id) as any[]) skip.add(r.target);   // follows waiting to be signed
    const mine = interests(me), wk = Date.now() - 7 * DAY;
    const arr = (x: { topics: Set<string>; groups: Set<string>; words: Set<string> }) => ({ topics: [...x.topics], groups: [...x.groups], words: [...x.words] }), meI = arr(mine);
    return (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(p => !skip.has(p.id) && listed(p)).map(p => {
      let both: { t: string; w: number }[] = []; try { both = B.shared(me, p); } catch { /* tags not ready */ }
      const { score, why } = ext.suggestScore(meI, { id: p.id, handle: p.handle, isNew: Date.parse(p.created) > wk, week: weekScore(p.manifest), gravity: gravityOf(p.id), interests: arr(interests(p)), building: both });
      const b = body(p), avatar = b.photos?.avatar ? `/@${p.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
      return { id: p.id, handle: p.handle, name: p.name, headline: p.headline, avatar, why, score };
    }).sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Why two members might know each other, in a few words (for friend requests in the daily email). */
  function whyPair(a: string, b: string): string {
    const pa = profile(a), pb = profile(b); if (!pa || !pb) return "";
    const ia = interests(pa), ib = interests(pb), grp = [...ib.groups].filter(g => ia.groups.has(g)), shared = [...ib.topics].filter(t => ia.topics.has(t));
    const nice = (t: string) => t.length <= 3 ? t.toUpperCase() : t;
    return grp.length ? `also in ${grp[0]}` : shared.length ? `also into ${shared.slice(0, 2).map(nice).join(", ")}` : "";
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
        // never call someone "Untitled": a blank or placeholder name keeps the name we already had, else their handle
        const realName = (v: unknown) => { const x = String(v ?? "").trim(); return x && !/^untitled$/i.test(x) ? x : ""; };
        const nameNow = realName(b.name) || realName(existing?.name) || handle;
        q(`INSERT INTO profiles (id, handle, box_key, name, headline, manifest, updated, created) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, box_key=excluded.box_key, name=excluded.name,
           headline=excluded.headline, manifest=excluded.manifest, updated=excluded.updated`)
          .run(e.from, handle || null, b.boxKey || "", nameNow, b.headline || "", JSON.stringify(e), e.ts, existing?.created || now());
        storeEnvelope(e, null);
        if (C.gardenEnabled()) indexGarden(e.from, handle, b.garden);   // paused: the garden index is left exactly as it was
        if (!existing && b.invitedBy) recordReferral(e.from, b.invitedBy, "obsidian");
        { // a new member, or one whose page just gained a GitHub link: connect their GitHub circle on Caldera
          const ghIn = (m: any) => { try { return JSON.stringify(m?.links || []).match(/github\.com\/[A-Za-z0-9-]+/gi)?.map(x => x.toLowerCase()).sort().join() || ""; } catch { return ""; } };
          const before = existing ? ghIn(JSON.parse(existing.manifest).body) : "";
          if (!existing || ghIn(b) !== before) setTimeout(() => { try { circleHooks.joined?.(e.from); } catch (err: any) { console.error("circle join", err?.message); } }, 0);
        }
        if (!existing && opts.founder) {   // the founder is everyone's first friend; it can be removed like any other
          const f = byHandle(opts.founder.toLowerCase());
          if (f && f.id !== e.from) befriend(f.id, e.from, "founder", now());
        }
        if (!existing) emit({ type: "signup", handle, name: nameNow, total: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
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
        // following someone who already follows you: you're friends
        if (!areFriends(e.from, b.to) && follows(b.to, e.from)) {
          const inv = !!q("SELECT 1 FROM referrals WHERE (invitee=? AND inviter=?) OR (invitee=? AND inviter=?)").get(e.from, b.to, b.to, e.from);
          befriend(e.from, b.to, inv ? "invite" : "request", e.ts);
          q("DELETE FROM friend_intents WHERE owner=? AND target=?").run(b.to, e.from);
        } else if (!areFriends(e.from, b.to)) notifyFollow(e.from, b.to);
        return { status: 200, body: { ok: true, request: hash } };
      }
      case "friend.accept": {
        const req = q("SELECT json FROM envelopes WHERE hash=? AND type='friend.request'").get(b.request) as any;
        if (!req) return { status: 404, body: { error: "unknown request" } };
        const r = JSON.parse(req.json) as C.Envelope;
        if (r.body.to !== e.from || r.from !== b.to) return { status: 403, body: { error: "request was not to you" } };
        const inv = !!q("SELECT 1 FROM referrals WHERE (invitee=? AND inviter=?) OR (invitee=? AND inviter=?)").get(e.from, r.from, r.from, e.from);
        befriend(e.from, r.from, inv ? "invite" : "request", e.ts);
        q("DELETE FROM friend_intents WHERE (owner=? AND target=?) OR (owner=? AND target=?)").run(e.from, r.from, r.from, e.from);
        storeEnvelope(e, r.from);
        return { status: 200, body: { ok: true } };
      }
      case "friend.remove": {
        // removing a shared-repo friendship leaves a tombstone, so the repo job never connects these two again
        if (["repo", "github"].includes((q("SELECT kind FROM friends WHERE a=? AND b=?").get(e.from, b.to) as any)?.kind)) q("INSERT OR IGNORE INTO repo_tombstones VALUES (?,?,?)").run(...[e.from, String(b.to)].sort(), now());
        q("DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)").run(e.from, b.to, b.to, e.from);
        // removing a friend is unfollowing them: my own follow goes, theirs (if they followed me first) stays
        q("DELETE FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=?").run(e.from, b.to);
        q("DELETE FROM friend_intents WHERE owner=? AND target=?").run(e.from, b.to);
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
  // A garden note other gardens link to, later unpublished: keep only its handle, slug and published title, so links into it
  // land on a "taken private" page instead of a 404 (no content is kept). Republishing the slug drops the tombstone.
  db.exec("CREATE TABLE IF NOT EXISTS garden_tombstones (handle TEXT, slug TEXT, title TEXT, removed_at TEXT, PRIMARY KEY (handle, slug))");
  const tombstoned = (handle: string, slug: string) => q("SELECT title, removed_at FROM garden_tombstones WHERE handle=? AND slug=?").get(handle, slug) as { title: string; removed_at: string } | undefined;

  function indexGarden(owner: string, handle: string, garden: unknown) {
    const before = handle ? q("SELECT slug, title FROM garden_notes WHERE owner=? AND handle=?").all(owner, handle) as { slug: string; title: string }[] : [];
    indexGardenRows(owner, handle, garden);
    if (!handle) return;
    const kept = new Set((q("SELECT slug FROM garden_notes WHERE owner=?").all(owner) as { slug: string }[]).map(r => r.slug));
    for (const r of before) if (!kept.has(r.slug) && q("SELECT 1 FROM garden_links WHERE dst_handle=? AND dst_slug=? AND owner<>? LIMIT 1").get(handle, r.slug, owner))
      q("INSERT OR REPLACE INTO garden_tombstones VALUES (?,?,?,?)").run(handle, r.slug, r.title, now());
    for (const sl of kept) q("DELETE FROM garden_tombstones WHERE handle=? AND slug=?").run(handle, sl);
  }

  /** "This note was taken private" page for a tombstoned garden note: who linked to it, and the way back to the garden. */
  function tombstonePage(handle: string, slug: string, t: { title: string; removed_at: string }): string {
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const hub = (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
    const day = new Date(t.removed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const from = (q(`SELECT l.src_handle, l.src_slug, l.src_title, p.id FROM garden_links l JOIN profiles p ON p.id=l.owner WHERE l.dst_handle=? AND l.dst_slug=? LIMIT 50`).all(handle, slug) as any[]).filter(r => !modOf(r.src_handle, r.id));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(t.title)} (made private) - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>:root{--bg:#111113;--raised:#18181B;--line:#2A2A2F;--text:#E6E6EA;--muted:#8A8A93;--strong:#F7F7FA;--accent-text:#B9A6FF}
@media (prefers-color-scheme: light){:root{--bg:#FAFAF7;--raised:#FFF;--line:#E4E4DF;--text:#26262B;--muted:#6B6B73;--strong:#111;--accent-text:#5A3CD0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 'IBM Plex Sans',system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:56px 16px 64px}
a{color:var(--accent-text);text-decoration:none}h1{font:600 1.7rem/1.2 'Source Serif 4',Georgia,serif;color:var(--strong);margin:6px 0 10px}.k{color:var(--muted);font-size:13px;letter-spacing:.06em;text-transform:uppercase}
p{color:var(--muted)}ul{padding-left:18px}li{margin:6px 0}.card{border:1px solid var(--line);background:var(--raised);border-radius:12px;padding:16px 18px;margin-top:22px}</style></head><body><main>
<div class="k">&#128274; Made private</div><h1>${e(t.title)}</h1>
<p>This note was taken private by <a href="${hub}/@${e(handle)}/">@${e(handle)}</a> on ${e(day)}. Its content is no longer published; only the title stays here so links into it still lead somewhere.</p>
<div class="card">${from.length ? `<b>Linked from</b><ul>${from.map(r => `<li><a href="${hub}/@${e(r.src_handle)}/n/${e(r.src_slug)}.html">${e(r.src_title)}</a> <span style="color:var(--muted)">@${e(r.src_handle)}</span></li>`).join("")}</ul>` : ""}
<a href="${hub}/@${e(handle)}/garden.html">Walk @${e(handle)}'s garden &rarr;</a></div></main></body></html>`;
  }

  function indexGardenRows(owner: string, handle: string, garden: unknown) {
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
<div class="gh-cta"><a class="gh-btn" href="${e(hub)}/kudos/${encodeURIComponent(handle)}" data-caldera-friend="${e(handle)}" target="_blank" rel="noopener">+ Follow @${e(handle)}</a> <span>Follow each other and you're friends: then give gravity, answer an ask, or link a note. New to Caldera? <a href="${e(hub)}/?invite=${encodeURIComponent(handle)}#install">Get it here</a> and you'll be walked back to follow @${e(handle)}.</span></div>
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
  const cityOf = (handle: string) => { try {
    const pr = byHandle(handle);
    if (pr && PM.modeFor(pr) !== "show") { const c = publicCityOf(handle); return c && c.districts.some((d: any) => d.repos.length) ? cityArt(citySnapshot(c, { name: pr.name || handle })) : null; }
    return cityArt(fs.readFileSync(path.join(opts.dataDir, "profiles", handle, "index.html"), "utf8")); } catch { return null; } };
  const cardDir = path.join(opts.dataDir, "cards");
  /** PNG card for link previews, cached until the profile is published again. */
  async function profileCard(pr: any): Promise<Buffer> {
    const f = path.join(cardDir, pr.handle + ".png"), idx = path.join(opts.dataDir, "profiles", pr.handle, "index.html");
    const fresh = Math.max(Date.parse(pr.updated) || 0, fs.existsSync(idx) ? fs.statSync(idx).mtimeMs : 0);
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs >= fresh) return fs.readFileSync(f);
    // one render per card at a time (link-preview bots and a launch crowd ask together), at most 2 renders at once
    const key = pr.handle + ":" + fresh, live = cardInflight.get(key); if (live) return live;
    const job = (async () => {
      if (cardsRendering >= 2) await new Promise<void>(r => cardWaiters.push(r));
      cardsRendering++;
      try {
        const png = await toPng(cardSvg({ handle: pr.handle, name: pr.name, headline: pr.headline, host: hubUrl().replace(/^https?:\/\//, ""), city: cityOf(pr.handle) }));
        fs.mkdirSync(cardDir, { recursive: true }); fs.writeFileSync(f, png);
        return png;
      } finally { cardsRendering--; cardWaiters.shift()?.(); cardInflight.delete(key); }
    })();
    cardInflight.set(key, job); return job;
  }
  const cardInflight = new Map<string, Promise<Buffer>>(); let cardsRendering = 0; const cardWaiters: (() => void)[] = [];
  // ---------------------------------------------------------------- search engines + AI assistants on profile pages
  // Listed members' pages are indexable (their choice in Settings). New members agree to this at sign-up; members who
  // joined before it shipped get a 7-day notice first (privacy policy: material changes are announced before they apply).
  q("CREATE TABLE IF NOT EXISTS search_prefs (owner TEXT PRIMARY KEY, on_ INTEGER, ts TEXT)").run();
  let SEO_SINCE = (q("SELECT v FROM hub_meta WHERE k='seo_since'").get() as any)?.v as string | undefined;
  if (!SEO_SINCE) { SEO_SINCE = (opts as any).seoSince || now(); q("INSERT OR REPLACE INTO hub_meta VALUES ('seo_since', ?)").run(SEO_SINCE); }
  function searchable(pr: any): boolean {
    if (!pr?.handle || !listed(pr)) return false;
    const pref = q("SELECT on_ FROM search_prefs WHERE owner=?").get(pr.id) as any; if (pref) return !!pref.on_;
    return String(pr.created || "") >= SEO_SINCE! || Date.now() >= Date.parse(SEO_SINCE!) + 7 * DAY;
  }
  /** index/follow, canonical, a real title and description, and ProfilePage + Person JSON-LD (what AI answers quote) */
  function profileSeo(pr: any, rel: string, html: string): string {
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const base = `${hubUrl()}/@${pr.handle}/`, url = base + (rel === "city.html" ? "city.html" : ""), b = body(pr), name = pr.name || "@" + pr.handle;
    const cut = (t: string, n: number) => { const first = t.split(/(?<=[.!?])\s/)[0]; if (first.length <= n) return first.replace(/[.!?]$/, ""); const w = t.slice(0, n).replace(/\s+\S*$/, ""); return w.replace(/[,;:\s]+$/, "") + "\u2026"; };
    const tags = (() => { try { return B.tagsOf(pr).map((t: any) => t.t).slice(0, 10); } catch { return [] as string[]; } })();
    const links = (Array.isArray(b.links) ? b.links : []).map((l: any) => Array.isArray(l) ? l[1] : l?.url).filter((u: any) => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 8);
    const c = cityOf(pr.handle), fc = followCounts(pr.id);
    const desc = (rel === "city.html" ? `${name}'s GitHub as a living city on Caldera${c?.buildings ? `: ${c.buildings} repos` : ""}. ` : "") + (pr.headline || `${name} builds with AI. Profile, projects and GitHub city on Caldera.`) + (tags.length ? ` Building: ${tags.slice(0, 5).join(", ")}.` : "");
    const title = rel === "city.html" ? `${name}'s GitHub city | Caldera` : `${name} (@${pr.handle})${pr.headline ? ` - ${cut(String(pr.headline), 60)}` : ""} | Caldera`;
    const person = { "@type": "Person", "@id": base + "#person", name, alternateName: "@" + pr.handle, url: base, description: pr.headline || undefined, image: `${base}card.png`,
      sameAs: links.length ? links : undefined, knowsAbout: tags.length ? tags : undefined,
      interactionStatistic: [{ "@type": "InteractionCounter", interactionType: "https://schema.org/FollowAction", userInteractionCount: fc.followers + fc.friends }] };
    const ld = { "@context": "https://schema.org", "@graph": [{ "@type": "ProfilePage", "@id": url, url, name: title, dateModified: pr.updated, mainEntity: { "@id": base + "#person" }, isPartOf: { "@type": "WebSite", name: "Caldera", url: hubUrl() + "/" } }, person,
      { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Caldera", item: hubUrl() + "/" }, { "@type": "ListItem", position: 2, name: "People", item: hubUrl() + "/people" }, { "@type": "ListItem", position: 3, name, item: base }] }] };
    html = html.replace(/<meta name="robots"[^>]*>/gi, "").replace(/<link rel="canonical"[^>]*>/gi, "").replace(/<meta name="description"[^>]*>/gi, "")
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${e(title)}</title>`);
    return html.replace(/<\/head>/i, `<meta name="robots" content="index, follow, max-image-preview:large"><link rel="canonical" href="${e(url)}"><meta name="description" content="${e(desc.slice(0, 300))}"><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script></head>`);
  }
  function previewTags(handle: string, rel: string): string {
    const pr = byHandle(handle); if (!pr) return "";
    const v = String(Date.parse(pr.updated) || 0).slice(-8) + ["show", "anonymous", "hidden"].indexOf(PM.modeFor(pr)), base = `${hubUrl()}/@${handle}/`;   // a new picture when the private-repos setting changes
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
  { const set = PM.set; PM.set = (owner: string, mode: unknown) => { const ok = set(owner, mode); if (ok) { worldCache = null; worldPng = null; const h = profile(owner)?.handle; if (h) fs.rmSync(path.join(opts.dataDir, "cards", h + ".png"), { force: true }); } return ok; }; }   // a privacy change shows on the World right away
  function publicCityOf(handle: string): any {
    try { const html = fs.readFileSync(path.join(opts.dataDir, "profiles", handle, "city.html"), "utf8");
      const m = html.match(/<script type="application\/json" id="city-data">([\s\S]{1,3000000}?)<\/script>/); const d = m ? JSON.parse(m[1]) : null;
      if (!d || !Array.isArray(d.districts) || d.private !== false) return null;
      return applyPrivateMode(d as CityData, PM.modeFor(byHandle(handle))); } catch { return null; }
  }
  /** a hosted index.html's city preview, redrawn from the projected city when private repos are anonymous or hidden */
  function privatePage(pr: any, rel: string, html: string): string {
    const mode = PM.modeFor(pr); if (mode === "show") return html;
    if (rel === "city.html") return rewriteCityPage(html, mode);
    if (rel === "index.html" && html.includes('class="city-peek"')) {
      const c = publicCityOf(pr.handle), peek = /<style>\.city-peek\{[\s\S]*?<a class="city-peek"[\s\S]*?<\/a>/;
      return html.replace(peek, () => c && c.districts.some((d: any) => d.repos.length) ? citySnapshot(c, { name: pr.name || pr.handle }) : "");
    }
    return html;
  }
  function worldNow(): World {
    if (worldCache && Date.now() - worldCache.at < 60_000) return worldCache.w;
    const prs = (q("SELECT * FROM profiles WHERE handle IS NOT NULL ORDER BY created").all() as any[]).filter(listed);
    const ids = new Map(prs.map(p => [p.id as string, p.handle as string]));
    const pairs = (q("SELECT a, b, kind, why FROM friends").all() as any[]).filter(r => ids.has(r.a) && ids.has(r.b)).map(r => [ids.get(r.a)!, ids.get(r.b)!, r.kind || "request", r.why || undefined] as [string, string, string, string?]);
    const fc = new Map<string, number>(); for (const [a] of pairs) fc.set(a, (fc.get(a) || 0) + 1);
    const members: WorldMemberIn[] = prs.map(pr => {
      const b = body(pr), city = publicCityOf(pr.handle);
      const busy = (city?.districts || []).flatMap((d: any) => d.repos || []).reduce((s: number, r: any) => s + (Number(r.week) || 0), 0);
      return { handle: pr.handle, name: pr.name || "@" + pr.handle, headline: pr.headline || "", created: pr.created || pr.updated || now(),
        groups: Array.isArray(b.groups) ? b.groups.filter((g: unknown) => typeof g === "string" && /^[a-z0-9][a-z0-9-]{1,29}$/.test(g)) : [],
        friends: fc.get(pr.handle) || 0, city, notes: C.gardenEnabled() ? (q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(pr.id) as any).n : 0, busy,
        tag: (() => { try { return B.problemOf(pr)[0]?.t; } catch { return undefined; } })() };
    });
    // "same stack" lines: each member's top 2 similar-stack matches (a friendship between the two wins over it)
    for (const pr of prs) for (const x of (() => { try { return B.similarStacks(pr, 2); } catch { return []; } })())
      pairs.push([pr.handle, x.handle, "stack", x.shared.slice(0, 3).map(s => s.dep).join(", ")]);
    const w = buildWorld(members, pairs, opts.founder ? opts.founder.toLowerCase() : null, opts.publicUrl || "https://caldera.social");
    worldCache = { at: Date.now(), w }; return w;
  }
  function worldLive(since: string | null) {
    const per = (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed)
      .filter(pr => sitesOf(pr.id).length || q("SELECT 1 FROM agents WHERE owner=? LIMIT 1").get(pr.id))
      .map(pr => ({ handle: pr.handle as string, live: scrubPrivateLive(liveStats(pr.id, false, since), PM.modeFor(pr)) }));
    return { ...foldLive(per, now()), lit: GIFTS ? GIFTS.litNow() : {} };
  }
  /** THE site header (logo, How it works, People, World, Guide, What's new, FAQ, Sign in, Get started), taken from the site's
   *  guide.html so hub-rendered pages match the static ones; current = the nav href to mark (e.g. "/world"). */
  function siteHeader(_current = ""): string { return HEADER_MARK; }
  function oldSiteHeader(current = ""): string {
    let h = ""; try { const g = fs.readFileSync(path.join(opts.siteDir || "", "guide.html"), "utf8"); h = g.slice(g.indexOf('<header class="nav">'), g.indexOf("</header>") + 9); } catch { /* no site */ }
    if (!h.startsWith("<header")) h = `<header class="nav"><a class="brand" href="/">Caldera</a><nav><a href="/people">People</a><a href="/world">World</a><a href="/guide">Guide</a><a href="/signin">Sign in</a></nav><a class="btn small" href="/#install">Get started</a></header>`;
    h = h.replace(/ aria-current="page"/g, "").replace(/href="\.\/"/g, 'href="/"').replace(/href="\.\/#/g, 'href="/#').replace(/href="#/g, 'href="/#');
    return current ? h.replace(`href="${current}"`, `href="${current}" aria-current="page"`) : h;
  }
  function worldNav(): string { return siteHeader("/world") + `<script src="/assets/site.js" defer></script>`; }
  /** Give a hub-rendered page the site header: replaces its own header (or the old ".top" link row), adds the site styles
   *  ahead of the page's own (so the page keeps its look) and the script that turns "Sign in" into the account menu. */
  function navify(html: string, current = ""): string {
    const head = siteHeader(current);
    if (/<header class="nav"[\s\S]*?<\/header>/.test(html)) html = html.replace(/<header class="nav"[\s\S]*?<\/header>/, head);
    else if (/<div class="top">[\s\S]*?<\/div>/.test(html)) html = html.replace(/<div class="top">[\s\S]*?<\/div>/, "").replace(/<body[^>]*>/i, b => b + head);
    else html = html.replace(/<body[^>]*>/i, b => b + head);
    if (!html.includes("/assets/site.css")) html = html.replace(/<head>/i, `<head><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css">`);
    if (!html.includes("/assets/site.js")) html = html.replace(/<\/body>/i, `<script src="/assets/site.js" defer></script></body>`);
    return html;
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

  let FEED: ReturnType<typeof feed> | null = null;   // the network feed (created once the helpers it needs exist)
  let MSG: ReturnType<typeof messages> | null = null;   // direct messages (same)
  let CHAT: ReturnType<typeof chat> | null = null;   // Groups under Messages (same)
  let GIFTS: ReturnType<typeof gifts> | null = null;   // light-ups on the world map (same)
  let EMP: ReturnType<typeof emailPages> | null = null;   // pages made by email + an AI (no GitHub, no Obsidian)
  function erase(id: string) {
    FEED?.erase(id); MSG?.erase(id); CHAT?.erase(id); GIFTS?.erase(id); EMP?.erase(id); PM.erase(id);
    q("DELETE FROM alerts WHERE target=?").run(id);
    const pr = profile(id);
    if (pr?.handle) { fs.rmSync(path.join(opts.dataDir, "profiles", pr.handle), { recursive: true, force: true }); fs.rmSync(path.join(opts.dataDir, "cards", pr.handle + ".png"), { force: true }); q("DELETE FROM page_views WHERE handle=?").run(pr.handle); q("DELETE FROM garden_tombstones WHERE handle=?").run(pr.handle); }
    for (const r of q("SELECT key FROM traffic_sites WHERE owner=?").all(id) as any[]) q("DELETE FROM traffic WHERE key=?").run(r.key);
    q("DELETE FROM traffic_sites WHERE owner=?").run(id); q("DELETE FROM client_versions WHERE owner=?").run(id); q("DELETE FROM agent_keys WHERE owner=?").run(id); q("DELETE FROM agents WHERE owner=?").run(id);
    q("DELETE FROM owner_private WHERE owner=?").run(id); q("DELETE FROM owner_sessions WHERE owner=?").run(id); q("DELETE FROM owner_links WHERE owner=?").run(id); q("DELETE FROM signin_links WHERE owner=?").run(id); q("DELETE FROM pair_codes WHERE owner=?").run(id);
    for (const sql of ["DELETE FROM profiles WHERE id=?", "DELETE FROM friends WHERE a=? OR b=?", "DELETE FROM repo_tombstones WHERE a=? OR b=?", "DELETE FROM gh_circle WHERE member=?", "DELETE FROM asks WHERE author=?", "DELETE FROM offers WHERE author=?",
      "DELETE FROM gravity WHERE sender=? OR recipient=?", "DELETE FROM ledger WHERE who=?", "DELETE FROM envelopes WHERE sender=? OR recipient=?", "DELETE FROM tokens WHERE id=?", "DELETE FROM garden_notes WHERE owner=?", "DELETE FROM garden_links WHERE owner=?", "DELETE FROM kudos WHERE sender=? OR recipient=?", "DELETE FROM friend_intents WHERE owner=? OR target=?",
      // a deleted member gets no more email, and no trace of who invited whom (their inviter keeps the credits earned)
      "DELETE FROM email_subs WHERE owner=?", "DELETE FROM email_suggest WHERE owner=?", "DELETE FROM email_prompt WHERE owner=?", "DELETE FROM referrals WHERE invitee=? OR inviter=?", "DELETE FROM invites_sent WHERE inviter=?"]) {
      const n = (sql.match(/\?/g) || []).length; q(sql).run(...Array(n).fill(id));
    }
  }

  // ---------------------------------------------------------------- operator tools (run on the server: node dist/admin.js)
  const admin = {
    alertPost: (o: PostAlert) => ({ posted: alerts.post(o) }),
    alertPin: (id: string, on: boolean) => ({ id, pinned: on, ok: alerts.pin(id, on) }),
    alertDelete: (id: string) => ({ id, deleted: alerts.remove(id) }),
    alertList: () => alerts.list().map(a => ({ id: a.id, title: a.title, pinned: !!a.pinned, audience: a.audience, ts: a.ts, version: a.version, reads: (q("SELECT COUNT(*) n FROM alert_reads WHERE alert_id=?").get(a.id) as any).n })),
    list: () => q("SELECT * FROM moderation ORDER BY at DESC").all(),
    hide(handle: string, reason = "") { const pr = byHandle(handle); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "hidden", reason, now()); return { hidden: handle, id: pr?.id || null }; },
    unhide(handle: string) { q("DELETE FROM moderation WHERE handle=?").run(handle); return { restored: handle }; },
    remove(handle: string, reason = "") { const pr = byHandle(handle); if (pr) erase(pr.id); q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, pr?.id || null, "removed", reason, now()); return { removed: handle, id: pr?.id || null }; },
    block(handle: string, reason = "") { q("INSERT OR REPLACE INTO moderation VALUES (?,?,?,?,?)").run(handle, null, "blocked", reason, now()); return { blocked: handle }; },
    // feed moderation: reported posts first
    "post-list": () => FEED!.admin.postsList(), "post-hide": (id: string) => FEED!.admin.postHide(id), "post-delete": (id: string) => FEED!.admin.postDelete(id), "funnel-report": (days?: number) => FUNNEL.report(Number(days) || 7), "email-nudge": (dry?: boolean) => {
      // GitHub members we have no email for (signed up before sign-in asked GitHub for it): one personal alert each, with a
      // one-click "Reconnect GitHub" that hands us their verified address. Idempotent (same key = one alert).
      const rows = q(`SELECT g.profile_id, g.handle FROM gh_accounts g WHERE g.claimed IS NULL
        AND NOT EXISTS (SELECT 1 FROM email_suggest e WHERE e.owner=g.profile_id AND e.verified=1)
        AND NOT EXISTS (SELECT 1 FROM email_subs s WHERE s.owner=g.profile_id AND s.confirmed IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.target=g.profile_id AND a.dkey='email-confirm')`).all() as any[];
      if (!dry) for (const r of rows) alerts.post({ target: r.profile_id, key: "email-confirm", by: "system", title: "Confirm your email in one click",
        body: "Reconnect GitHub once and we'll use your verified GitHub email for message alerts and, if you want it, a daily summary (only on days something happens). Nothing else changes.",
        ctaLabel: "Reconnect GitHub", ctaUrl: "/auth/github" });
      return { nudged: dry ? 0 : rows.length, handles: rows.map(r => r.handle) };
    }, "comment-list": () => FEED!.admin.commentsList(), "comment-hide": (id: string) => FEED!.admin.commentHide(id),
    "post-ban": (handle: string, reason = "") => FEED!.admin.postBan(handle, reason), "post-unban": (handle: string) => FEED!.admin.postUnban(handle),
    "msg-reports": () => MSG!.admin.reports(), "msg-view": (id: string) => MSG!.admin.view(id), "msg-close": (id: string) => MSG!.admin.close(id),
    "msg-ban": (handle: string, reason = "") => MSG!.admin.ban(handle, reason), "msg-unban": (handle: string) => MSG!.admin.unban(handle),
  };

  // ---------------------------------------------------------------- scores for leaderboards
  /** Points this week: the 7 full days before the member's "today", summed from the daily scores in their signed manifest
   *  (the same numbers their scoreboard draws). "Today" is the newest day they published if it's current (their own
   *  time zone), otherwise the hub's; so a page left unpublished doesn't keep last week's points. Every leaderboard uses this. */
  const weekCache = new Map<string, number>();
  function weekScore(manifestJson: string): number {
    const key = new Date().toISOString().slice(0, 10) + "|" + crypto.createHash("sha1").update(String(manifestJson || "")).digest("base64");
    const hit = weekCache.get(key); if (hit !== undefined) return hit;
    let pts = 0;
    try {
      const daily = ((JSON.parse(manifestJson).body?.daily || []) as any[]).filter(d => typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
      const hubToday = new Date().toISOString().slice(0, 10), newest = daily.reduce((m, d) => d.date > m ? d.date : m, "");
      const day = (s: string, n: number) => new Date(Date.parse(s + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
      const today = newest && newest >= day(hubToday, -1) && newest <= day(hubToday, 1) ? newest : hubToday, from = day(today, -7);
      pts = daily.filter(d => d.date >= from && d.date < today).reduce((s, d) => s + Math.max(0, Number(d.score) || 0), 0);
    } catch { pts = 0; }
    if (weekCache.size > 5000) weekCache.clear(); weekCache.set(key, pts);
    return pts;
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
    // the network Feed is the first tab on every page, before the person's own .md tabs
    if (html.includes('<div class="tabs">') && !html.includes('class="tab tab-feed"')) html = html.replace('<div class="tabs">', `<div class="tabs"><a class="tab tab-feed" href="${(opts.publicUrl || "https://caldera.social").replace(/\/$/, "")}/feed" title="What's happening across Caldera">&#x1F4E1; Feed</a>`);
    // every page's nav gets World just above City (pages built before plugin 0.19.x don't have it): one click up to the map
    if (!html.includes("/world?focus=") && html.includes('class="tree-row toc-row page-row')) {
      const hubBase = (opts.publicUrl || "https://caldera.social").replace(/\/$/, ""), w = `<a class="tree-row toc-row page-row" href="${hubBase}/world?focus=${encodeURIComponent(handle)}">World</a>`;
      const city = html.match(/<a class="tree-row toc-row page-row[^"]*" href="[^"]*city\.html"/);
      html = city ? html.replace(city[0], w + city[0]) : html.replace(/(<a class="tree-row toc-row page-row[^>]*>[^<]*<\/a>)(?![\s\S]*<a class="tree-row toc-row page-row(?! friend-row))/, "$1" + w);
    }
    if (!C.gardenEnabled()) html = stripGarden(html);
    const note = C.gardenEnabled() ? rel.match(/^n\/([a-z0-9-]+)\.html$/) : null;
    if (note && html.includes('class="xlink"')) html = html.replace(/(<a class="xlink" href="[^"]*\/@([a-z0-9-]+)\/n\/([a-z0-9-]+)\.html"[^>]*>)([\s\S]*?)<\/a>/g, (all, open, h, sl, inner) =>
      tombstoned(h, sl) ? `${open}${inner} <span class="xl-private" style="opacity:.7;font-size:.85em">(made private)</span></a>` : all);
    if (note) html = html.replace("<!--caldera:xlinks-->", xlinksBlock(handle, note[1]));
    if (rel === "garden.html" && C.gardenEnabled()) {   // garden home: live gravity/credits/asks/links block (marker from 0.6.0; older builds: before the stage filter)
      const gh = gardenHomeBlock(handle);
      html = html.includes("<!--caldera:gardenhome-->") ? html.replace("<!--caldera:gardenhome-->", gh) : html.replace('<div class="g-filter"', gh + '<div class="g-filter"');
    }
    if (!html.includes("Heatmap sizing (2026-10-12)") && html.includes('class="heat-box"')) html = html.replace(/<\/head>/i, HEAT_FIX + "</head>");   // pages built before 0.5.1
    if (html.includes('class="side-inner"')) html = html.replace(/<\/head>/i, "<style>.side-inner{scrollbar-width:none}.side-inner::-webkit-scrollbar{display:none}</style></head>");   // side menus scroll without a visible bar, whatever version built the page
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
  /** Which build of a member's city a page is showing: when their city was last published (plugin publish or GitHub
   *  rebuild), plus, on the private address, when the private layer was last pushed. */
  const buildOf = (handle: string, privBuilt?: string | null) => {
    let t = 0; try { t = Math.round(fs.statSync(path.join(opts.dataDir, "profiles", handle, "city.html")).mtimeMs); } catch { /* not built yet */ }
    return `${t}${privBuilt ? "|" + privBuilt : ""}`;
  };
  /** Open city pages (the watch window, a pop-out, a tab left open) check every minute whether a newer build exists and
   *  reload themselves, when visible and nobody has touched the page for 20 s, so new repos appear without a manual
   *  reload. Injected by the hub, so it works for every member whatever plugin version built the page. */
  const injectBuildWatch = (html: string, url: string, build: string) => {
    const js = `<script>(function(){var B=${JSON.stringify(build)},U=${JSON.stringify(url)},last=Date.now(),due=false;
['pointerdown','wheel','keydown','touchstart'].forEach(function(e){addEventListener(e,function(){last=Date.now()},{passive:true})});
function go(){if(due&&document.visibilityState==='visible'&&Date.now()-last>20000)location.reload()}
function check(){fetch(U,{cache:'no-store',credentials:'same-origin'}).then(function(r){if(r.status===403){due=true;go();return null}return r.ok?r.json():null}).then(function(j){if(j&&j.build&&j.build!==B){due=true;go()}}).catch(function(){})}
setInterval(check,60000);setInterval(go,5000);document.addEventListener('visibilitychange',go)})();</script>`;
    return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, js + "</body>") : html + js;
  };
  const injectLive = (html: string, cfg: object) => /<\/head>/i.test(html) ? html.replace(/<\/head>/i, liveScript(cfg) + "</head>") : liveScript(cfg) + html;
  const liveToken = (handle: string, day = new Date().toISOString().slice(0, 10)) => crypto.createHmac("sha256", PRIV_KEY).update("live:" + handle + ":" + day).digest("hex").slice(0, 24);
  /** A private city page's token, valid for 30 days: a watch window or pop-out left open for days keeps receiving live
   *  drones and visitors (the address itself is already limited to the owner's Tailscale login). */
  const liveTokenOk = (handle: string, t: string) => { if (!t) return false; for (let i = 0; i < 30; i++) if (t === liveToken(handle, new Date(Date.now() - i * DAY).toISOString().slice(0, 10))) return true; return false; };

  // ---------------------------------------------------------------- auth (signed nonce, no passwords)
  function authed(req: http.IncomingMessage): string | null {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const row = q("SELECT id FROM tokens WHERE token=? AND expires > ?").get(hashToken(t), Date.now()) as any;
    if (row?.id) FUNNEL.seen(row.id, "obsidian");   // their vault's plugin talked to us: they had Obsidian open
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
  const newProfiles = new Map<string, { n: number; day: string; min: number; minN: number }>();
  // A conference room or an office shares one address: a page view is ~20-30 requests (page, images, styles, live
  // polls), so the per-address budget is sized for a room full of people, and new profiles allow a crowd signing
  // up together (with a per-minute burst cap) while bots are held back by the GitHub account checks.
  const L = { perMinute: 3000, writesPerMinute: 400, newProfilesPerDay: 300, newProfilesPerMinute: 20, ...(opts.limits || {}) };
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
    const ip = ipOf(req), day = new Date().toISOString().slice(0, 10), min = Math.floor(Date.now() / 60_000); const r = newProfiles.get(ip);
    if (!r || r.day !== day) { newProfiles.set(ip, { n: 1, day, min, minN: 1 }); return true; }
    if (r.min !== min) { r.min = min; r.minN = 0; }
    r.n++; r.minN++; return r.n <= L.newProfilesPerDay && r.minN <= L.newProfilesPerMinute;
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
      garden: acct || !C.gardenEnabled() ? undefined : !!(q("SELECT COUNT(*) n FROM garden_notes WHERE owner=?").get(owner) as any).n,
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
  /** "Unlock more" state from what the hub can see: live visitors and agent drones in the last 7 days, a private layer pushed
   *  in the last 7 days (vault profiles). Hosted GitHub pages have no vault, so AI usage, timeline and private sections don't apply. */
  function unlockStateFor(owner: string): C.UnlockState | null {
    const pr = profile(owner); if (!pr?.handle) return null;
    const wk = new Date(Date.now() - 7 * DAY).toISOString(), hosted = !!q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner);
    const live = !!q("SELECT 1 FROM traffic t JOIN traffic_sites s ON s.key=t.key WHERE s.owner=? AND t.ts > ? LIMIT 1").get(owner, wk);
    const agents = !!q("SELECT 1 FROM agents WHERE owner=? AND ts > ? LIMIT 1").get(owner, wk);
    const pv = q("SELECT ts FROM owner_private WHERE owner=?").get(owner) as any;
    return hosted ? { live, agents } : { live, agents, private: !!pv && pv.ts > wk };
  }
  /** The owner's connection lights for /settings and the owner bar: GitHub, Obsidian, live visitors, agents, private view, email. */
  function connectionsFor(owner: string): Conn | null {
    const pr = profile(owner); if (!pr?.handle) return null;
    const acct = q("SELECT login, claimed FROM gh_accounts WHERE profile_id=? ORDER BY (claimed IS NULL) DESC LIMIT 1").get(owner) as any;
    const link = q("SELECT login FROM gh_links WHERE profile_id=? ORDER BY ts DESC LIMIT 1").get(owner) as any;
    const hosted = !!acct && !acct.claimed, listed = GH.ghLoginsOf(pr)[0];
    const login: string | undefined = hosted ? acct.login : link?.login || (acct?.claimed && listed && String(acct.login).toLowerCase() === listed ? acct.login : undefined);
    const u = unlockStateFor(owner) || {} as C.UnlockState;
    return { hosted, github: { on: !!login, login, listed: login ? undefined : listed }, obsidian: { on: !hosted, updated: hosted ? undefined : pr.updated },
      live: !!u.live, agents: !!u.agents, private: hosted ? undefined : !!u.private, email: mail.hasConfirmed(owner) };
  }
  function nudgeFor(owner: string, hosted: boolean) {
    const hub = (opts.publicUrl || "https://caldera.social").replace(/\/$/, "");
    const st = pageStateFor(owner), n = st && C.nextStep(st);
    if (!n) {   // basics done: one "unlock more" feature instead
      const u = st ? C.unlockChecklist(unlockStateFor(owner) || {}).find(i => !i.done) : undefined; if (!u) return undefined;
      return { label: u.label.toLowerCase(), why: u.why, how: hosted ? "Set it up from your account page" : "Open My profile in Obsidian", url: hosted ? `${hub}/settings#connections` : "obsidian://caldera?open=finish" };
    }
    return { label: n.label.toLowerCase(), why: n.why, how: hosted ? "Do it on your account page" : "Open My profile in Obsidian", url: hosted ? `${hub}/settings#finish` : "obsidian://caldera?open=finish" };
  }

  /** The ONE most valuable missing piece of setup for the daily email: a city first, then live visitors on it, then the
   *  AI agents over it, then Obsidian (journal, notes, private side). Each links to the exact place with the copy-prompt. */
  function setupStepFor(owner: string, hosted: boolean) {
    const pr = profile(owner); if (!pr?.handle) return undefined;
    const u = unlockStateFor(owner) || {};
    return ext.digestSetup({ hosted, hasCity: fs.existsSync(path.join(opts.dataDir, "profiles", pr.handle, "city.html")), hasSites: !!q("SELECT 1 FROM traffic_sites WHERE owner=? LIMIT 1").get(owner),
      live: !!u.live, agents: !!u.agents, account: `${(opts.publicUrl || "https://caldera.social").replace(/\/$/, "")}/settings` });
  }
  /** From the signed manifest's daily counts: journal entries + notes edited since the last email, commits this week. */
  function workFor(pr: any, since: string) {
    let daily: any[] = []; try { daily = JSON.parse(pr.manifest).body.daily || []; } catch { /* none */ }
    const s0 = since.slice(0, 10), w0 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    const recent = daily.filter(d => String(d.date) >= s0), week = daily.filter(d => String(d.date) >= w0);
    return { journal: recent.filter(d => d.headline || (Number(d.score) || 0) > 0).length, notes: recent.reduce((a, d) => a + (Number(d.counts?.notes) || 0), 0),
      commits: week.reduce((a, d) => a + (Number(d.counts?.commits) || 0), 0) };
  }

  function digestFor(owner: string, since: string) {
    const pr = profile(owner); if (!pr?.handle) return null;
    const h = pr.handle as string, d1 = new Date(Date.now() - DAY).toISOString(), d7 = new Date(Date.now() - 7 * DAY).toISOString();
    const v1 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor) u FROM page_views WHERE handle=? AND ts > ?").get(h, since > d1 ? since : d1) as any;   // since the last email, at most a day
    const v7 = q("SELECT COUNT(*) n, COUNT(DISTINCT visitor || substr(ts,1,10)) u FROM page_views WHERE handle=? AND ts > ?").get(h, d7) as any;
    const hosted = !!q("SELECT 1 FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(owner);
    const stale = hosted ? 0 : staleDays(owner);
    const fresh = alerts.forOwner(owner, hosted ? "github" : "obsidian", 20).filter(a => !a.read && a.ts > since).slice(0, 3).map(a => ({ title: a.title, url: `${PUB()}/alerts` }));
    return { alerts: fresh.length ? fresh : undefined, stale: stale || undefined, nudge: stale ? undefined : nudgeFor(owner, hosted), handle: h, name: pr.name, hosted, views24: v1.n, visitors24: v1.u, views7: v7.n, visitors7: v7.u,
      requests: openRequests(owner).incoming.filter(r => r.ts > since).map(r => ({ handle: r.handle || "someone", name: r.name || "", note: r.note, why: whyPair(owner, r.id) })),
      setup: stale ? undefined : setupStepFor(owner, hosted),
      vault: hosted ? undefined : (() => { const w = workFor(pr, since); return { journal: w.journal, notes: w.notes }; })(), cityCommits: workFor(pr, since).commits || undefined,
      friends: (q("SELECT p.handle, p.name, f.kind, f.why, p.created FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=? AND f.ts > ? AND COALESCE(f.kind,'request')<>'founder'").all(owner, since) as any[])
        .map(r => ({ handle: r.handle, name: r.name, kind: r.kind, why: r.why, joined: !!r.created && r.created > since })),
      gravity: (q("SELECT p.handle, g.reason FROM gravity g LEFT JOIN profiles p ON p.id=g.sender WHERE g.recipient=? AND g.ts > ?").all(owner, since) as any[]).map(g => ({ handle: g.handle || "friend", reason: g.reason || "" })),
      links: C.gardenEnabled() ? (q("SELECT COUNT(*) n FROM garden_links WHERE dst_handle=? AND src_handle<>?").get(h, h) as any).n : 0,
      invited: q("SELECT p.handle FROM referrals r JOIN profiles p ON p.id=r.invitee WHERE r.inviter=? AND r.ts > ?").all(owner, since) as any[],
      credits: (q("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE who=? AND reason LIKE 'invited%' AND ts > ?").get(owner, since) as any).s,
      suggestions: suggestFor(owner, 3).map(x => ({ handle: x.handle, name: x.name, why: x.why, joined: !!byHandle(x.handle)?.created && byHandle(x.handle).created > since })),
      newMembers: (q("SELECT * FROM profiles WHERE handle IS NOT NULL AND created > ? AND id<>? ORDER BY created DESC").all(d7, owner) as any[]).filter(listed).map(p => ({ handle: p.handle, name: p.name })),
      kudos: kudosFor(owner, since).map(k => ({ handle: k.from || "someone", name: k.name, emoji: k.emoji })), viewsAll: viewsOf(h),
      intros: B.pendingFor(owner, since).map(i => ({ handle: i.handle, name: i.name, tag: i.tag })),
      messages: MSG ? MSG.digestFor(owner, since) : undefined,
      ...(() => { if (!FEED) return {}; const n = FEED.noticesFor(owner, since);
        return { lookingFor: FEED.lookingFor(owner, 2), recommends: FEED.recsFor(owner, 2),
          postKudos: n.kudos.map(k => ({ handle: k.from.handle, name: k.from.name, emoji: k.emoji, url: k.url })),
          postWaiting: n.waiting.map(w => ({ handle: w.from.handle, name: w.from.name, text: w.text, kind: w.kind, url: w.url })) }; })() };
  }
  const mail = emailer({ q, seal, unseal, hub: opts.publicUrl || "https://caldera.social", pepper: PRIV_KEY, send: opts.email?.send, resendKey: opts.email?.resendKey, digest: digestFor, rank: { active: d => ext.digestActive(d), subject: d => ext.digestSubject(d) } });
  if (opts.email?.schedule) mail.schedule();

  const autoOff = (pr: any) => { const b = body(pr); return b.autoConnectGithub === false || b.autoConnectRepos === false; };
  const circleHooks: { joined?: (id: string) => void; signedIn?: (id: string) => void } = {};
  const FUNNEL = funnel({ q, ipOf, botUa: BOT_UA });
  const GH = github({ track: (req, step, detail) => FUNNEL.track(req, step, detail), accountOk: ext.githubAccountOk, privateMode: PM, searchPref: { on: searchable, set: (o: string, on: boolean) => q("INSERT OR REPLACE INTO search_prefs VALUES (?,?,?)").run(o, on ? 1 : 0, now()) }, q, seal, unseal, accept, erase, dataDir: opts.dataDir, publicUrl: opts.publicUrl || "https://caldera.social", privateUrl: opts.privateUrl,
    json, readBody, allowNewProfile, byHandle, reserved: RESERVED, fetch: opts.githubFetch, freshenMs: opts.githubFetch ? 0 : undefined,
    siteNav: () => siteHeader(),
    owner: { start: (id: string) => startOwner(id), of: (req: http.IncomingMessage) => ownerOf(req), usable: (pr: any) => !modOf(pr.handle, pr.id), bar: (id: string) => { const pr = profile(id); return pr?.handle ? calderaBar(opts.publicUrl || "https://caldera.social", pr.handle, navFor(pr, "private"), undefined, bellFor(id)) : ""; } },
    social: { suggest: suggestFor, openRequests, invitedCount, recordReferral, pageState: pageStateFor, unlockState: unlockStateFor, alerts: { forOwner: (id: string) => alerts.forOwner(id, alertKind(id), 50), markRead: (id: string, ids: string[]) => alerts.markRead(id, ids) }, connections: connectionsFor, friendAct: (me: string, to: string) => friendAct(me, profile(to)), email: { status: mail.status, subscribe: mail.subscribe, unsubscribe: mail.unsubscribe, suggest: mail.suggest, promptFor: mail.promptFor, dismissPrompt: mail.dismissPrompt },
      circle: { people: (id: string) => githubPeople(id), invite: (id: string, login: string) => githubInvite(id, login), signedIn: (id: string) => circleHooks.signedIn?.(id) },
      building: (id: string) => { const pr = profile(id); return { tags: B.tagsOf(pr).map(t => ({ t: t.t, kind: t.kind })), intros: B.pendingFor(id).length }; } } });

  // shared-repo friendships: members who both contributed to the same public GitHub repo become friends (kind "repo")
  const repoJob = ext.repoConnector({
    fetch: opts.githubFetch || fetch, pause: opts.githubFetch ? 0 : 250, log: (...a) => console.error(...a),
    token: () => GH.anyToken(),
    members: () => (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(pr => !modOf(pr.handle, pr.id)).map(pr => {
      // verified GitHub accounts only (signed up with it, or linked with proof): a link typed on a page proves nothing
      const logins = new Set<string>();
      for (const r of q("SELECT login FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").all(pr.id) as any[]) if (r.login) logins.add(String(r.login).toLowerCase());
      for (const r of q("SELECT login FROM gh_links WHERE profile_id=?").all(pr.id) as any[]) if (r.login) logins.add(String(r.login).toLowerCase());
      return { id: pr.id as string, handle: pr.handle as string, logins: [...logins].filter(l => /^[a-z0-9][a-z0-9-]{0,38}$/.test(l)), optOut: autoOff(pr),
        privateOk: PM.modeFor(pr) === "show" };   // anonymous/hidden: their private work leaves no public trace, so no private-project link
    }),
    kindOf: (a, b) => (q("SELECT COALESCE(kind,'request') k FROM friends WHERE a=? AND b=?").get(a, b) as any)?.k ?? null,
    tombstoned: (a, b) => !!q("SELECT 1 FROM repo_tombstones WHERE a=? AND b=?").get(...[a, b].sort()),
    connect: (a, b, kind, why) => { befriend(a, b, kind, now(), why); worldCache = null; },
    privateRepos: () => GH.appPrivateRepos(),
    storeCircle: (member, edges) => {
      const t = now(), ins = q("INSERT INTO gh_circle VALUES (?,?,?,?,?) ON CONFLICT(member, login, relation, repo) DO UPDATE SET seen=excluded.seen");
      q("DELETE FROM gh_circle WHERE member=?").run(member);   // each scan is the member's whole circle: replace, don't accumulate
      for (const e of edges.slice(0, 5000)) ins.run(member, e.login, e.relation, e.repo || "", t);
      q("DELETE FROM gh_circle WHERE seen < ?").run(new Date(Date.now() - 90 * DAY).toISOString());   // forget circles not seen for 90 days (members who stopped being scanned)
    },
  });
  /** a member's VERIFIED GitHub logins (their sign-up account, or one linked with proof), never one merely typed on their page */
  const loginsOf = (pr: any): string[] => { const s = new Set<string>();
    for (const r of q("SELECT login FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").all(pr.id) as any[]) if (r.login) s.add(String(r.login).toLowerCase());
    for (const r of q("SELECT login FROM gh_links WHERE profile_id=?").all(pr.id) as any[]) if (r.login) s.add(String(r.login).toLowerCase());
    return [...s].filter(l => /^[a-z0-9][a-z0-9-]{0,38}$/.test(l)); };
  /** Someone just joined (or added their GitHub): connect them with every member who has them in their GitHub circle. */
  function fulfilCircle(id: string): number {
    const pr = profile(id); if (!pr?.handle || autoOff(pr)) return 0;
    const ls = loginsOf(pr); if (!ls.length) return 0;
    const rows = q(`SELECT member, relation, repo FROM gh_circle WHERE login IN (${ls.map(() => "?").join(",")}) AND member<>?`).all(...ls, id) as any[];
    const per = new Map<string, { following: boolean; follower: boolean; repo: string }>();
    for (const r of rows) { const x = per.get(r.member) || { following: false, follower: false, repo: "" }; if (r.relation === "following") x.following = true; else if (r.relation === "follower") x.follower = true; else if (r.repo && !x.repo) x.repo = r.repo; per.set(r.member, x); }
    let n = 0;
    for (const [mid, x] of per) {
      const m = profile(mid); if (!m?.handle || modOf(m.handle, m.id) || autoOff(m)) continue;
      if (q("SELECT 1 FROM repo_tombstones WHERE a=? AND b=?").get(...[mid, id].sort())) continue;
      const cur = (q("SELECT COALESCE(kind,'request') k FROM friends WHERE a=? AND b=?").get(mid, id) as any)?.k;
      const kind = x.repo ? "repo" : "github", rank: Record<string, number> = { founder: 0, github: 1, repo: 2, request: 3, invite: 3 };
      if (cur && (rank[cur] ?? 3) >= rank[kind]!) continue;
      // m.following = m follows the newcomer; m.follower = the newcomer follows m
      const why = x.repo ? x.repo : x.following && x.follower ? "you follow each other on GitHub" : x.following ? `@${m.handle} follows @${pr.handle} on GitHub` : `@${pr.handle} follows @${m.handle} on GitHub`;
      befriend(mid, id, kind, now(), why); n++;
    }
    if (n) worldCache = null;
    return n;
  }
  const lastScan = new Map<string, number>();
  /** scan one member's GitHub circle soon (sign-up, sign-in, a GitHub link added), at most every 6 hours per member */
  function scanSoon(id: string) {
    if (!opts.repoJob || Date.now() - (lastScan.get(id) || 0) < 6 * 3600_000) return; lastScan.set(id, Date.now());
    setTimeout(() => { void repoJob.run({ only: id }).catch(e => console.error("circle scan", e.message)); }, 2000).unref?.();
  }
  circleHooks.joined = (id: string) => { fulfilCircle(id); scanSoon(id); };
  /** "Your GitHub people": circle logins not on Caldera yet, co-contributors first, then mutual follows. Only the member sees it. */
  async function githubPeople(id: string) {
    const members = new Set<string>(); for (const pr of q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]) for (const l of loginsOf(pr)) members.add(l);
    const per = new Map<string, { following: boolean; follower: boolean; repos: string[] }>();
    for (const r of q("SELECT login, relation, repo FROM gh_circle WHERE member=?").all(id) as any[]) {
      if (members.has(r.login)) continue;
      const x = per.get(r.login) || { following: false, follower: false, repos: [] };
      if (r.relation === "following") x.following = true; else if (r.relation === "follower") x.follower = true; else if (r.repo && !x.repos.includes(r.repo)) x.repos.push(r.repo);
      per.set(r.login, x);
    }
    const rank = (x: { following: boolean; follower: boolean; repos: string[] }) => x.repos.length ? 0 : x.following && x.follower ? 1 : x.following ? 2 : 3;
    const list = [...per].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0])).slice(0, 60);
    const month = new Date(Date.now() - 30 * DAY).toISOString();
    return Promise.all(list.map(async ([login, x], i) => ({ login, avatar: `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`, url: `https://github.com/${encodeURIComponent(login)}`,
      relation: x.repos.length ? `works on ${x.repos[0]}` : x.following && x.follower ? "you follow each other" : x.following ? "you follow them" : "follows you",
      invited: !!q("SELECT 1 FROM invites_sent WHERE login=? AND ts > ?").get(login, month),
      canEmail: i < 25 ? !!(await repoJob.publicEmail(login)) : false })));   // only a yes/no: the address itself is never kept
  }
  /** Email one of your GitHub people an invite: only to the PUBLIC email on their GitHub profile, within the caps. */
  async function githubInvite(id: string, raw: string): Promise<string> {
    const login = String(raw || "").toLowerCase(); const pr = profile(id); if (!pr?.handle) throw new Error("Publish your page first.");
    const rel = q("SELECT relation, repo FROM gh_circle WHERE member=? AND login=?").all(id, login) as any[];
    if (!rel.length) throw new Error(`@${login} isn't in your GitHub circle.`);
    const to = await repoJob.publicEmail(login); if (!to) throw new Error(`@${login} has no public email on GitHub. Copy your invite link instead.`);
    const repo = rel.find(r => r.relation === "repo" && r.repo)?.repo, fol = rel.some(r => r.relation === "following"), fer = rel.some(r => r.relation === "follower");
    const why = repo ? `you both work on ${repo}` : fol && fer ? "you follow each other on GitHub" : fol ? `@${pr.handle} follows you on GitHub` : `you follow @${pr.handle} on GitHub`;
    return mail.sendInvite({ inviter: id, inviterName: pr.name || "", inviterHandle: pr.handle, login, to, why, link: `${PUB()}/?invite=${encodeURIComponent(pr.handle)}` });
  }
  circleHooks.signedIn = (id: string) => scanSoon(id);
  (admin as any).repoConnect = (o: { dry?: boolean } = {}) => repoJob.run(o);
  if (opts.repoJob) { const t0 = setTimeout(function tick() { void repoJob.run().catch(e => console.error("repo-connect", e.message)); const t = setTimeout(tick, 6 * 3600_000); t.unref?.(); }, 5 * 60_000); t0.unref?.(); }

  // what people are building: tags from public GitHub signals, People search, shared-tag suggestions, double opt-in intros
  const B = building({ ext, q, now, profile, byHandle, body, listed, modOf, areFriends, befriend: (a, b, k, ts, why) => befriend(a, b, k, ts, why),
    memberOf: r => memberOf(r), sameOrigin: r => sameOrigin(r), authed: r => authed(r), readBody: r => readBody(r), json: (r, s, b) => json(r, s, b),
    siteHeader: cur => siteHeader(cur), loginsOf: pr => loginsOf(pr), fetch: opts.githubFetch || fetch, llmKey: opts.llmKey, token: () => GH.anyToken(), tokenOf: id => GH.tokenOf(id), pause: opts.githubFetch ? 0 : 400,
    privateLangs: h => { const cty = publicCityOf(h); return (cty?.districts || []).flatMap((d: any) => d.repos || []).filter((r: any) => r.locked && r.language).map((r: any) => String(r.language)).slice(0, 20); },
    onChange: () => { worldCache = null; } });
  { const j0 = circleHooks.joined, s0 = circleHooks.signedIn;
    circleHooks.joined = (id: string) => { j0?.(id); B.tagSoon(id, !!opts.tagJob); };
    circleHooks.signedIn = (id: string) => { s0?.(id); B.tagSoon(id, !!opts.tagJob); }; }
  (admin as any).tags = (o: { dry?: boolean; only?: string } = {}) => B.job.run(o);
  if (opts.tagJob) B.schedule();

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
  /** The alerts bell for a signed-in member (owner bar, or the member bar on someone else's page). */
  const alertKind = (owner: string): "github" | "obsidian" => hostedOf(owner) ? "github" : "obsidian";
  function bellFor(owner: string | null | undefined): string {
    if (!owner || !profile(owner)?.handle) return "";
    const rows = alerts.forOwner(owner, alertKind(owner), 20), upTo = rows.reduce((m, a) => a.ts > m ? a.ts : m, "");
    return (MSG ? MSG.iconFor(owner) : "") + bellHtml(PUB(), rows, upTo ? `${PUB()}/v1/alerts/seen?t=${encodeURIComponent(alerts.seenToken(owner, upTo))}` : "");
  }
  /** Extra signed-in header controls (e.g. Messages), registered by other modules. */
  const headerItems: HeaderItem[] = [];
  const ago = (iso: string) => { const mn = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    return mn < 1 ? "just now" : mn < 60 ? `${mn}m ago` : mn < 2880 ? `${Math.floor(mn / 60)}h ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  function headerViewer(id: string | null): HeaderViewer | null {
    const pr = id ? profile(id) : null; if (!pr?.handle) return null;
    const av = body(pr).photos?.avatar, rows = alerts.forOwner(pr.id, alertKind(pr.id), 20), upTo = rows.reduce((m, a) => a.ts > m ? a.ts : m, "");
    const cn = connectionsFor(pr.id);
    return { handle: pr.handle, name: pr.name || "", avatar: av ? `${PUB()}/@${pr.handle}/${String(av).replace(/^\.?\//, "")}` : undefined,
      conn: cn ? { github: cn.github.on, obsidian: cn.obsidian.on } : undefined, unread: rows.filter(a => !a.read).length,
      alerts: rows.map(a => ({ title: a.title, when: ago(a.ts), read: !!a.read, pinned: !!a.pinned, href: `${PUB()}/alerts#a-${a.id}` })),
      seenUrl: upTo ? `${PUB()}/v1/alerts/seen?t=${encodeURIComponent(alerts.seenToken(pr.id, upTo))}` : undefined,
      msgs: unreadMsgs(pr.id), feedNew: FEED ? FEED.newFor(pr.id) : 0, badgeToken: badgeToken(pr.id) };
  }
  /** One badge token per member, reused for 6 of its 12 hours: the header reads the same on every page. */
  const badgeToks = new Map<string, { t: string; until: number }>();
  function badgeToken(id: string): string {
    const c0 = badgeToks.get(id); if (c0 && c0.until - Date.now() > 6 * 3600_000) return c0.t;
    const t = actToken(id, "badges", 12 * 3600_000); badgeToks.set(id, { t, until: Date.now() + 12 * 3600_000 });
    if (badgeToks.size > 5000) for (const [k, v] of badgeToks) if (v.until < Date.now() + 6 * 3600_000) badgeToks.delete(k);
    return t;
  }
  /** Unread direct messages and the first few senders: the header badge and strip, and /v1/me/badges. */
  function unreadMsgs(id: string): { unread: number; from: string[]; groups: number } {
    const groups = CHAT ? CHAT.unreadTotal(id) : 0;
    if (!MSG) return { unread: 0, from: [], groups };
    const n = MSG.unreadFor(id); return { unread: n, from: n ? MSG.inbox(id).filter((x: any) => x.unread && x.handle).slice(0, 3).map((x: any) => x.handle) : [], groups };
  }
  /** THE header for one request on the public site: who is looking, and whether this is their own profile or city. */
  function headerFor(req: http.IncomingMessage, pathname: string): { header: string; signedIn: boolean } {
    const me = memberOf(req);
    if (me && FEED && currentFor(pathname) === "feed") try { FEED.markSeen(me); } catch { /* never break a page */ }   // opening the feed clears its count
    const viewer = headerViewer(me);
    const pm = pathname.match(/^\/@([a-z0-9-]+)(\/.*)?$/), h = pm ? pm[1] : "";
    let own = null as any;
    if (viewer && h && viewer.handle === h) {
      const rel = ((pm![2] || "/").slice(1) || "index.html").replace(/\/$/, "/index.html"), nav = ownerBar(req, h, rel);
      if (nav) { const pr = byHandle(h), hosted = pr ? hostedOf(pr.id) : false;
        own = { view: "public", publicHref: nav.publicHref, privateHref: hosted ? undefined : nav.privateHref, privateExternal: nav.privateExternal, stale: nav.stale }; }
    }
    const items = me && viewer ? headerItems.map(f => { try { return f(me); } catch { return ""; } }).filter(Boolean) : [];
    const header = appHeader({ hub: PUB(), current: currentFor(pathname), viewer, own, items,
      signinHref: h && byHandle(h) ? `${PUB()}/signin?h=${encodeURIComponent(h)}` : `${PUB()}/signin`,
      joinHref: h && byHandle(h) ? `${PUB()}/?invite=${encodeURIComponent(h)}#install` : `${PUB()}/#install` });
    return { header, signedIn: !!viewer };
  }
  /** The owner nav for `handle` (same switch + account menu on the public page and the private address), or null. */
  function navFor(pr: any, current: "public" | "private", rel = "index.html", stale?: number): OwnerNav {
    const h = pr.handle as string, sub = rel === "index.html" ? "" : rel, priv = privateFor(h), hosted = hostedOf(pr.id);
    const privateHref = priv ? priv + sub : hosted ? `${PUB()}/settings` : "obsidian://caldera?open=private";
    const cn = connectionsFor(pr.id);
    return { handle: h, current, publicHref: `${PUB()}/@${h}/${sub}`, privateHref, privateExternal: !priv && !hosted, signout: `${PUB()}/signout?h=${encodeURIComponent(h)}`, stale,
      settings: `${PUB()}/settings`, conn: cn ? { github: cn.github.on, obsidian: cn.obsidian.on } : undefined,
      note: priv ? "Private view opens your private address (your Tailscale devices only)." : hosted ? "Private view is your settings page." : "Private view opens Caldera in Obsidian on this computer." };
  }
  /** Is this request from the owner of `handle`? Returns their nav for the public page, or null. */
  function ownerBar(req: http.IncomingMessage, handle: string, rel = "index.html"): OwnerNav | null {
    const pr = byHandle(handle); if (!pr) return null;
    const t = reqCookies(req)[OWN_COOKIE];
    let mine = !!t && !!q("SELECT 1 FROM owner_sessions WHERE token_hash=? AND owner=? AND expires > ?").get(hashToken(t), pr.id, Date.now());
    if (!mine) { const a = GH.account(req); if (a && !a.claimed && a.profile_id === pr.id) mine = true; }
    if (!mine) return null;
    FUNNEL.seen(pr.id, "site");
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
.si .card{background:var(--bg-raised,#232327);border:1px solid var(--line,#2A2A2E);border-radius:12px;padding:16px 18px;margin:14px 0}.si .card h2{font-size:1.05rem;margin:0 0 4px}.si .mut{color:var(--text-muted,#9A9AA6);font-size:.93em}
.si input[type=email]{width:100%;box-sizing:border-box;background:var(--bg,#1C1C1F);color:inherit;border:1px solid var(--line,#2A2A2E);border-radius:8px;padding:10px 12px;font:inherit;margin:8px 0 10px}
.si .code{font:500 2rem/1.2 'IBM Plex Mono',monospace;letter-spacing:.18em;padding:10px 0}.si .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.si button.btn{cursor:pointer}</style></head>
<body>${siteHeader("/signin")}<main class="si">${inner}</main><footer class="footer"><span>&copy; 2026 mjonesone, LLC</span><span><a href="/guide">Guide</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></span></footer>${script ? `<script>${script}</script>` : ""}<script src="/assets/site.js" defer></script></body></html>`);
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
    const o = ownerOf(req); if (o && profile(o)) { FUNNEL.seen(o, "site"); return o; }
    const a = GH.account(req), id = a && !a.claimed && a.profile_id && profile(a.profile_id) ? a.profile_id : null; if (id) FUNNEL.seen(id, "site"); return id;
  }
  /** Views as people count them: one per visitor per day, bots and the owner's own visits never recorded. */
  const viewsOf = (handle: string, since = "") => (q("SELECT COUNT(DISTINCT visitor || substr(ts,1,10)) n FROM page_views WHERE handle=? AND ts > ?").get(handle, since) as any).n as number;
  const tallyOf = (id: string): [string, number][] => { const rows = q("SELECT kind, COUNT(*) n FROM kudos WHERE recipient=? GROUP BY kind").all(id) as any[];
    return Object.keys(KUDOS).map(k => [k, rows.find(r => r.kind === k)?.n || 0] as [string, number]); };
  const barSocial = (pr: any, owner: boolean): BarSocial => ({ views: viewsOf(pr.handle), showViews: body(pr).showViews !== false, tally: tallyOf(pr.id), owner, counts: followCounts(pr.id) });
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
    if (follows(to, me)) { const inc = q("SELECT hash FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=? ORDER BY ts DESC LIMIT 1").get(to, me) as any; return { state: "incoming", request: inc?.hash }; }
    if (q("SELECT 1 FROM friend_intents WHERE owner=? AND target=? AND kind='add'").get(me, to)) return { state: "queued" };
    if (q("SELECT 1 FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=? LIMIT 1").get(me, to)) return { state: "requested" };
    return { state: "none" };
  }
  /** Add friend / Accept for a signed-in member. GitHub sign-ups: the hub holds their key and signs now. Obsidian members:
   *  the key never leaves their vault, so the hub queues it and their plugin signs and sends it on its next sync. */
  function friendAct(me: string, to: any, action = "friend"): { status: number; body: any } {
    if (!to?.handle || modOf(to.handle, to.id)) return { status: 404, body: { error: "unknown profile" } };
    const st = friendState(me, to.id);
    if (st.state === "self") return { status: 400, body: { error: "That's your own page." } };
    if (action === "unfollow") { unfollow(me, to.id); return { status: 200, body: { ok: true, state: friendState(me, to.id).state } }; }
    if (st.state === "friends" || st.state === "requested" || st.state === "queued") return { status: 200, body: { ok: true, already: true, state: st.state } };
    if (tooMany("friend:" + me, 60)) return { status: 429, body: { error: "That's a lot of follows for one hour. Try again later." } };
    // they already follow me: following back makes us friends, right away, for everyone
    if (st.state === "incoming") {
      const inv = !!q("SELECT 1 FROM referrals WHERE (invitee=? AND inviter=?) OR (invitee=? AND inviter=?)").get(me, to.id, to.id, me);
      befriend(me, to.id, inv ? "invite" : "request", now());
      q("DELETE FROM friend_intents WHERE (owner=? AND target=?) OR (owner=? AND target=?)").run(me, to.id, to.id, me);
      return { status: 200, body: { ok: true, state: "friends" } };
    }
    // a new follow: signed now for GitHub sign-ups (the hub holds their key); Obsidian members' follow counts at once and
    // their plugin signs the request the next time it's open
    const a = q("SELECT key_sealed FROM gh_accounts WHERE profile_id=? AND claimed IS NULL").get(me) as any;
    if (a?.key_sealed) {
      const id = JSON.parse(unseal(a.key_sealed)) as C.Identity;
      const r = accept(C.sign(id, "friend.request", { to: to.id, note: "" }));
      if (r.status !== 200) return r;
    } else q("INSERT OR REPLACE INTO friend_intents VALUES (?,?,?,?,?)").run(me, to.id, "add", null, now());
    notifyFollow(me, to.id);
    return { status: 200, body: { ok: true, state: friendState(me, to.id).state } };
  }
  /** Stop following: my request (signed or queued) goes; a friendship ends, and if they followed me first they still do. */
  function unfollow(me: string, to: string) {
    q("DELETE FROM friend_intents WHERE owner=? AND target=?").run(me, to);
    q("DELETE FROM envelopes WHERE type='friend.request' AND sender=? AND recipient=?").run(me, to);
    if (areFriends(me, to)) {
      if (["repo", "github"].includes((q("SELECT kind FROM friends WHERE a=? AND b=?").get(me, to) as any)?.kind)) q("INSERT OR IGNORE INTO repo_tombstones VALUES (?,?,?)").run(...[me, to].sort(), now());
      q("DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)").run(me, to, to, me);
    }
  }
  /** A new follower gets one bell alert (the daily email lists followers too); repeat follows of the same pair stay quiet. */
  function notifyFollow(from: string, to: string) {
    const fp = profile(from); if (!fp?.handle) return;
    try { alerts.post({ title: `@${fp.handle} followed you`, body: `${fp.name && fp.name !== fp.handle ? fp.name + " " : ""}(@${fp.handle}) follows you on Caldera. Follow back and you're friends.`, ctaLabel: "See their page", ctaUrl: `/@${fp.handle}/`, target: to, key: "follow:" + from, by: "follows" }); } catch { /* never breaks a follow */ }
  }
  /** One-time "get your daily summary" strip on the owner's own page (until they subscribe or say not now). The page is
   *  sandboxed, so it acts through /v1/act with an owner token, like inline kudos. */
  function welcomeBanner(handle: string): string {
    return `<div id="cb-wel" style="position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:9px 40px 9px 16px;background:#1A1530;border-bottom:1px solid #3A2F5C;font:500 13.5px/1.35 'IBM Plex Sans',Arial,sans-serif;color:#E6E1F5">`
      + `<span><b style="color:#fff">You're in. This is your city.</b> Each building is a repo, taller with more commits. Your page is already filled in; change anything later in Settings.</span>`
      + `<span style="display:inline-flex;gap:12px"><a href="/@${handle}/" style="color:#C9B8FF">Your page</a><a href="/world" style="color:#C9B8FF">Fly over other cities</a><a href="/settings" style="color:#C9B8FF">Settings</a></span>`
      + `<button type="button" aria-label="Close" onclick="this.parentNode.remove()" style="all:unset;cursor:pointer;position:absolute;top:8px;right:10px;padding:2px 6px;color:#9A93B5;font-size:18px;line-height:1">&times;</button></div>`;
  }
  function summaryBanner(owner: string, handle: string): string {
    const pr = mail.promptFor(owner); if (!pr) return "";
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const api = (opts.publicUrl || "https://caldera.social").replace(/\/$/, ""), t = actToken(owner, handle), sug = pr.suggestion?.email || "";
    return `<div id="cb-sum" data-api="${e(api)}" data-t="${e(t)}" style="position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 40px 9px 16px;background:#1A1530;border-bottom:1px solid #3A2F5C;font:500 13.5px/1.35 'IBM Plex Sans',Arial,sans-serif;color:#E6E1F5">`
      + `<span style="flex:1 1 260px"><b style="color:#fff">Get your daily summary.</b> Who visited, kudos and new followers, people to meet. Only on days something happens.</span>`
      + `<span style="display:inline-flex;gap:6px;flex:1 1 300px;max-width:440px"><input id="cb-sum-e" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${e(sug)}" aria-label="Email for your daily summary" style="flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid #3A2F5C;background:#0F0C1C;color:#fff;font:inherit">`
      + `<button id="cb-sum-go" type="button" style="all:unset;cursor:pointer;padding:6px 14px;border-radius:999px;background:#8B6CF6;color:#fff;font-weight:600;white-space:nowrap">Send me summaries</button></span>`
      + `<button id="cb-sum-x" type="button" aria-label="Not now" title="Not now" style="all:unset;cursor:pointer;position:absolute;top:8px;right:10px;padding:2px 6px;color:#9A93B5;font-size:18px;line-height:1">&times;</button><span id="cb-sum-m" style="flex-basis:100%;display:none;color:#CFC6F5"></span></div>`
      + `<script>(function(){var B=document.getElementById('cb-sum');if(!B)return;var api=B.getAttribute('data-api'),t=B.getAttribute('data-t'),M=document.getElementById('cb-sum-m');
function post(o){o.t=t;return fetch(api+'/v1/act',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(o)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})},function(){return{ok:false,j:{error:'Could not reach Caldera.'}}})}
document.getElementById('cb-sum-go').addEventListener('click',function(){var v=document.getElementById('cb-sum-e').value.trim();if(!v)return;post({action:'email-subscribe',email:v}).then(function(x){M.style.display='block';M.textContent=x.ok?(x.j.message||'Done.'):(x.j.error||'Could not save that.');if(x.ok){setTimeout(function(){B.remove()},4000)}})});
document.getElementById('cb-sum-x').addEventListener('click',function(){post({action:'email-dismiss'});B.remove()})})();</script>`;
  }
  /** The viewer block for a hosted page: token + today's kudos + friend state (null for anonymous viewers and the owner). */
  function viewerFor(me: string | null, pr: any): BarViewer | null {
    const vp = me ? profile(me) : null; if (!vp?.handle || !pr || me === pr.id || modOf(vp.handle, vp.id)) return null;
    const day = new Date().toISOString().slice(0, 10), done = q("SELECT kind FROM kudos WHERE sender=? AND recipient=? AND day=?").get(me, pr.id, day) as any;
    const fr = q("SELECT kind, why FROM friends WHERE a=? AND b=?").get(me, pr.id) as any;
    return { handle: vp.handle, token: actToken(me!, pr.handle), sent: done?.kind || null, friend: friendState(me!, pr.id).state, why: fr?.why && fr.kind === "repo" ? `both work on ${fr.why}` : fr?.why && fr.kind === "github" ? String(fr.why) : undefined };
  }
  /** The help exchange (asks, offers, help credits) is retired: pages built by older plugin versions lose the section,
   *  its "On this page" link, and the friends / gravity / help credits strip (the counts under the name replace it). */
  function dropHelpExchange(html: string): string {
    const at = html.indexOf('<h2 id="help-exchange">');
    if (at >= 0) { const rest = html.slice(at + 10); const nx = rest.search(/<h2[ >]|<div class="stat-strip">|<div class="foot">/); if (nx >= 0) html = html.slice(0, at) + rest.slice(nx); }
    return html.replace(/<a class="tree-row toc-row" href="#help-exchange">[^<]*<\/a>/, "")
      .replace(/<div class="stat-strip">(?:<div class="stat"><div class="v">[^<]*<\/div><div class="l">(?:friends|gravity|help credits)<\/div><\/div>){3}<\/div>/, "");
  }
  /** The scoreboard's leaderboard, filled in on the hub: the page's owner and their friends, by points this week (weekScore,
   *  from each signed manifest). Visitors see the owner's name, the owner sees "You"; empty slots keep the invite button. */
  function realLeaderboard(html: string, pr: any, isOwner: boolean): string {
    const at = html.indexOf('<div class="lb-wrap">'); if (at < 0) return html;
    const end = html.indexOf('<div class="invite-pop"', at); const close = html.indexOf("</div></div>", at), stop = end > 0 ? end : close > 0 ? close + 6 : -1;
    if (stop < 0) return html;
    const block = html.slice(at, stop), empty = block.match(/<div class="lb-row empty">[\s\S]*?<\/div>/)?.[0] || "";
    const esc = (x: string) => x.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const mine = weekScore(pr.manifest);
    const rows = [{ h: pr.handle as string, name: isOwner ? "You" : (pr.name || "@" + pr.handle), pts: mine, me: true }];
    for (const f of q("SELECT p.handle, p.name, p.manifest FROM friends f JOIN profiles p ON p.id=f.b WHERE f.a=?").all(pr.id) as any[]) {
      if (!f.handle || modOf(f.handle)) continue; const pts = weekScore(f.manifest);
      rows.push({ h: f.handle, name: f.name || "@" + f.handle, pts, me: false });
    }
    rows.sort((a, b) => b.pts - a.pts || (a.me ? -1 : 1));
    const top = rows.slice(0, 5); if (!top.some(r => r.me)) top[4] = rows.find(r => r.me)!;
    const out = top.map((r, i) => `<div class="lb-row${r.me ? " me" : ""}"><span class="rank">${rows.indexOf(r) + 1}</span>${r.me ? `<span class="who">${esc(r.name)}</span>` : `<a class="who" href="${PUB()}/@${esc(r.h)}/" target="_blank" rel="noopener">${esc(r.name)}</a>`}<span class="num">${r.pts.toLocaleString("en-US")}</span></div>`);
    for (let i = out.length; i < 4 && empty; i++) out.push(empty.replace(/<span class="rank">\d+<\/span>/, `<span class="rank">${i + 1}</span>`));
    return html.slice(0, at) + `<div class="lb-wrap"><div class="label">Leaderboard / friends, points this week</div>` + out.join("") + html.slice(stop);
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
      const label = st === "none" ? `+ Follow @${handle}` : st === "incoming" ? `Follow @${handle} back` : FRIEND_LABEL[st];
      return `<a class="${esc(cls)}" href="${base}/kudos/${encodeURIComponent(handle)}" data-caldera-friend="${esc(handle)}" data-state="${st}" target="_blank" rel="noopener"${st === "friends" ? ' aria-disabled="true"' : ""}>${esc(label)}</a>`;
    });
  }

  // Pages served with Referrer-Policy: no-referrer (sign-in, sign-out, kudos) make browsers send "Origin: null" on their
  // own form posts; the browser's Sec-Fetch-Site still says same-origin, which a cross-site page cannot fake.
  const sameOrigin = (req: http.IncomingMessage) => { const o = String(req.headers.origin || ""); if (!o) return false;
    if (o === "null") return String(req.headers["sec-fetch-site"] || "") === "same-origin";
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
        : fst === "requested" || fst === "queued" ? `<p class="mut">You follow @${e(h)}. If they follow you back, you're friends.</p>`
        : `<button class="btn ghost" type="button" id="kd-friend">${fst === "incoming" ? `@${e(h)} follows you. Follow back` : `+ Follow @${e(h)}`}</button>`;
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
var fb=document.getElementById('kd-friend');if(fb)fb.addEventListener('click',function(){fb.disabled=true;fetch('/v1/friend/'+H,{method:'POST',credentials:'same-origin'}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){fb.outerHTML='<p class="mut">'+(x.ok?(x.j.state==='friends'?'You and @'+H+' follow each other: you are friends now.':'You follow @'+H+'. If they follow you back, you are friends.'):(x.j.error||'Could not do that.'))+'</p>'})});`;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kudos for @${e(h)} - Caldera</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>
body{overflow-x:hidden}.kd{max-width:440px;margin:0 auto;padding:22px 16px 40px}.kd h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.6rem;margin:14px 0 4px}.kd .mut{color:var(--text-muted,#9A9AA6);margin:0 0 14px}.kd .small{font-size:.85em;display:block;margin-top:6px}
.kd-who{display:flex;gap:12px;align-items:center}.kd-who img,.kd-ini{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none}.kd-ini{display:grid;place-items:center;background:var(--accent,#8B6CF6);color:#fff;font-weight:600;font-size:1.2rem}.kd-who b{display:block}.kd-who .mut{margin:0}
.kd-tally{display:flex;gap:12px;margin-top:10px;font-size:15px;font-variant-numeric:tabular-nums}
.kd-pick{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:8px 0 18px}.kd-pick button{font-size:34px;line-height:1;padding:16px 0;border-radius:14px;border:1px solid var(--line,#2A2A2E);background:var(--bg-raised,#232327);cursor:pointer;transition:transform .15s,border-color .15s}
.kd-pick button:hover:not(:disabled){transform:translateY(-2px) scale(1.06);border-color:var(--accent,#8B6CF6)}.kd-pick button:disabled{opacity:.45;cursor:default}.kd-pick button.on{opacity:1;border-color:var(--accent,#8B6CF6);transform:scale(1.12)}
.kd .row{display:flex;flex-wrap:wrap;gap:8px}.kd-friend{border-top:1px solid var(--line,#2A2A2E);padding-top:14px}.kd button.btn{cursor:pointer}
.kd-fly{position:fixed;bottom:30%;font-size:28px;pointer-events:none;animation:kdfly 1.7s ease-out forwards}@keyframes kdfly{0%{transform:translate(0,0) scale(.6);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx),-360px) scale(1.25);opacity:0}}
@media (prefers-reduced-motion:reduce){.kd-fly{display:none}}</style></head><body>${siteHeader()}<script src="/assets/site.js" defer></script><main class="kd">${inner}</main>${script ? `<script>${script}</script>` : ""}</body></html>`);
  }
  /** /signin with no page: GitHub first, then how to sign in to a page made in Obsidian. */
  function signinGeneral(res: http.ServerResponse, back = "") {
    const bq = /^\/(messages|messages\/@[a-z0-9-]+|messages\/groups(?:\/[a-z0-9-]+(?:\/[0-9a-f]{16})?)?|feed|people|world|@[a-z0-9-]+\/|me\/building|settings|alerts)$/.test(back) ? `?back=${encodeURIComponent(back)}` : "";   // come back to the page that asked (e.g. a conversation)
    // "Message" on someone's page, signed out: say why, offer sign-up first (credited to them), and land in the conversation after
    const mh = back.match(/^\/messages\/@([a-z0-9-]+)$/)?.[1] || "", them = mh ? byHandle(mh) : null;
    // a group link, signed out: same idea, "Sign up to join <group>", back into the group after
    const gs = back.match(/^\/messages\/groups\/([a-z0-9-]+)/)?.[1] || "", gname = gs && CHAT ? CHAT.nameOf(gs) : null;
    if (gname) {
      const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)), q2 = `back=${encodeURIComponent(back)}`;
      signinPage(res, 200, `Join ${gname}`, `<h1>Sign up to join ${e(gname)}</h1><p class="lede">Groups are where Caldera members talk shop. You need a free page first. It takes about a minute, then you land right in the conversation.</p>
<div class="card"><h2>Sign up</h2><p class="mut">No GitHub needed: ChatGPT or Claude writes your page, you confirm your email. Use GitHub? Your repos become your city.</p><div class="row"><a class="btn" href="/start?${q2}">Sign up with email</a><a class="btn ghost" href="/auth/github?${q2}">Sign up with GitHub</a></div><p class="mut" style="font-size:12.5px;margin-top:8px">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p></div>
<div class="card"><h2>Already on Caldera?</h2><div class="row"><a class="btn small ghost" href="/auth/github${bq}">Sign in with GitHub</a><a class="btn small ghost" href="/start${bq}">Email me a sign-in link</a></div></div>`);
      return;
    }
    if (them && !modOf(them.handle, them.id)) {
      const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
      const h = them.handle as string, who = String(body(them).name || "").trim() || `@${h}`, q2 = `back=${encodeURIComponent(back)}&invite=${encodeURIComponent(h)}`;
      signinPage(res, 200, `Message @${h}`, `<h1>Sign up to message ${e(who)}</h1><p class="lede">Messages on Caldera are between members, so you need a free page first. It takes about a minute, then you land right in your conversation with @${e(h)}.</p>
<div class="card"><h2>Sign up</h2><p class="mut">No GitHub needed: ChatGPT or Claude writes your page, you confirm your email. Use GitHub? Your repos become your city.</p><div class="row"><a class="btn" href="/start?${q2}">Sign up with email</a><a class="btn ghost" href="/auth/github?${q2}">Sign up with GitHub</a></div><p class="mut" style="font-size:12.5px;margin-top:8px">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p></div>
<div class="card"><h2>Already on Caldera?</h2><p class="mut">Sign in and you go straight to the conversation.</p><div class="row"><a class="btn small ghost" href="/auth/github${bq}">Sign in with GitHub</a><a class="btn small ghost" href="/start${bq}">Email me a sign-in link</a></div><p class="mut" style="font-size:12.5px;margin-top:8px">Made your page in Obsidian? Open your page and tap <b>Sign in</b> in the bar at the top, then tap Message again.</p></div>
<p class="mut"><a href="/@${e(h)}/">Back to ${e(who)}'s page</a></p>`);
      return;
    }
    signinPage(res, 200, "Sign in", `<h1>Sign in to Caldera</h1><p class="lede">Sign this browser in as the owner of your page. It stays signed in for a year.</p>
<div class="card"><h2>Sign in with GitHub</h2><p class="mut">Works if you signed up with GitHub, or if your page lists your GitHub account in its links.</p><a class="btn" href="/auth/github${bq}">Sign in with GitHub</a><p class="mut" style="font-size:12.5px;margin-top:8px">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p></div>
<div class="card"><h2>Made your page with ChatGPT or Claude?</h2><p class="mut">Enter your email on the start page (leave the profile box empty) and we send you a sign-in link.</p><a class="btn ghost" href="/start">Email me a sign-in link</a></div>
<div class="card"><h2>Made your page in Obsidian?</h2><p class="mut">Open your page and tap <b>Sign in</b> in the bar at the top for an email link or a code from Obsidian. Or in Obsidian, run <b>Caldera: Open my public page (as owner)</b>.</p></div>
<p class="mut">No page yet? <a href="/#install">Sign up with GitHub</a>, or <a href="/start">make your page with ChatGPT or Claude</a>.</p>`);
  }
  function signinHome(res: http.ServerResponse, pr: any, note = "") {
    const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const h = pr.handle as string, hosted = hostedOf(pr.id), hasEmail = mail.hasConfirmed(pr.id);
    const emailCard = `<div class="card"><h2>Email me a sign-in link</h2>${hasEmail
      ? `<p class="mut">Type the email your daily Caldera summary goes to. We'll send a link that works once, for 15 minutes.</p><form method="post" action="/signin/email"><input type="hidden" name="h" value="${e(h)}"><input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"><button class="btn small" type="submit">Send the link</button></form>`
      : `<p class="mut">This page has no confirmed summary email yet, so there's nowhere to send a link. ${hosted ? "Sign in with GitHub instead, and add your email on your account page for next time." : "Pair this device from Obsidian below, then turn on the daily summary email in Caldera settings for next time."}</p>`}</div>`;
    const ghLogin = hosted ? "" : GH.ghLoginsOf(pr)[0] || "";   // a page made in Obsidian that lists its GitHub account
    const ghCard = hosted || ghLogin ? `<div class="card"><h2>Sign in with GitHub</h2><p class="mut">${hosted ? "This page was made with GitHub. Sign in with the same GitHub account." : `Sign in as <b>${e(ghLogin)}</b>, the GitHub account linked on this page.`}</p><a class="btn" href="/auth/github?h=${encodeURIComponent(h)}">Sign in with GitHub</a><p class="mut" style="font-size:12.5px;margin-top:8px">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p></div>` : "";
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
  function guardLinks(req: http.IncomingMessage, res: http.ServerResponse, extra: string[] = [], hdr?: () => { header: string; signedIn: boolean }) {
    const hosts = [hostOf(opts.publicUrl), hostOf(opts.privateUrl), String(req.headers.host || ""), ...extra].filter(Boolean);
    let html = false, held: any[] | null = null;
    const wh = res.writeHead.bind(res) as any;
    const flush = () => { if (held) { const h = held; held = null; wh(...h); } };
    (res as any).writeHead = (status: number, ...rest: any[]) => {
      const hdrs = rest.find(x => x && typeof x === "object" && !Array.isArray(x));
      const ct = String((hdrs && (hdrs["content-type"] || hdrs["Content-Type"])) || res.getHeader("content-type") || "");
      html = /text\/html/i.test(ct);
      if (html && hdr) { held = [status, ...rest]; return res; }   // held until end(): the header and cache policy depend on the viewer
      return wh(status, ...rest);
    };
    const write = res.write.bind(res) as any;
    (res as any).write = (...a: any[]) => { flush(); return write(...a); };
    const end = res.end.bind(res) as any;
    (res as any).end = (chunk?: any, ...rest: any[]) => {
      if ((html || /text\/html/i.test(String(res.getHeader("content-type") || ""))) && chunk && (typeof chunk === "string" || Buffer.isBuffer(chunk))) {
        let out = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk as string;
        if (hdr && (out.includes(HEADER_MARK) || out.includes('<header class="nav"'))) {
          try {
            const r = hdr(), swapped = swapHeader(out, r.header);
            if (swapped !== null) { out = withAppHead(swapFooter(swapped));
              // public pages built without a footer (Feed, GitHub city previews, groups) get THE footer too
              if (!/<footer class="footer/.test(out) && /^\/(feed|gh|g\/)/.test(String(req.url || ""))) out = out.replace(/<\/body>/i, () => swapFooter('<footer class="footer"></footer>') + "</body>");
              const h0 = held ? held.find((x: any) => x && typeof x === "object" && !Array.isArray(x)) : null;
              if (r.signedIn) { if (h0) { h0["cache-control"] = "private, no-store"; h0["vary"] = "Cookie"; } else { res.setHeader("cache-control", "private, no-store"); res.setHeader("vary", "Cookie"); } }
              else if (h0) h0["vary"] = "Cookie"; else res.setHeader("vary", "Cookie"); }
          } catch (err: any) { console.error("header", err?.message); }
        }
        try { out = C.externalLinksNewWindow(out, hosts); } catch { /* never break a page */ }
        chunk = out;
      }
      flush();
      return end(chunk, ...rest);
    };
  }


  EMP = emailPages({ q, seal, unseal, accept, dataDir: opts.dataDir, publicUrl: opts.publicUrl || "https://caldera.social", reserved: RESERVED, byHandle, profile,
    startOwner, memberOf, sameOrigin, allowNewProfile, tooMany, note: (m) => mail.note(m),
    page: (res, status, title, body) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
      res.end(navify(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - Caldera</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap"></head><body>${body}</body></html>`)); },
    hasFollower: (id) => !!q("SELECT 1 FROM friends WHERE a=? OR b=? LIMIT 1").get(id, id) || !!q("SELECT 1 FROM friend_intents WHERE target=? AND kind='add' LIMIT 1").get(id),
    rememberEmail: (owner, email) => { try { mail.suggest(owner, email, true, "email-signup"); } catch { /* fine */ } },
    eraseProfile: (id) => erase(id),
    onPublished: () => { worldCache = null; }, recordReferral });
  EMP.schedule();
  GIFTS = gifts({ q, now, profile, byHandle, listed, modOf, memberOf, sameOrigin, readBody, json, tooMany, founder: opts.founder ? opts.founder.toLowerCase() : null,
    publicRepos: (h) => ((publicCityOf(h)?.districts || []) as any[]).flatMap((d: any) => (d.repos || []).filter((r: any) => !r.locked && r.name).map((r: any) => String(r.name))),
    notify: (to, a) => { alerts.post({ title: a.title, body: a.body, ctaLabel: a.ctaLabel, ctaUrl: a.ctaUrl, target: to, key: a.key, by: "gifts" }); },
    onChange: () => FEED?.invalidate() });
  FEED = feed({ q, now, hub: opts.publicUrl || "https://caldera.social", profile, byHandle, body, listed, modOf, areFriends, befriend: (a, b, kind, ts, why) => { befriend(a, b, kind, ts, why); worldCache = null; },
    memberOf, sameOrigin, readBody, json, navify, weekScore, tooMany, founder: opts.founder || null, ogTags,
    tagsOf: (pr: any) => B.tagsOf(pr), vocab: ext.tagVocab().problems, stackVocab: ext.tagVocab().stack, requestIntro: (from, to) => B.requestIntro(from, to), decide: (me, from, yes) => B.decide(me, from, yes),
    notify: (to, a) => { alerts.post({ title: a.title, body: a.body, ctaLabel: a.ctaLabel, ctaUrl: a.ctaUrl, target: to, key: a.key, by: "feed" }); },
    dropNotices: (postId) => { const like = [`%${postId}%`, `%/feed/p/${postId}%`];
      q("DELETE FROM alert_reads WHERE alert_id IN (SELECT id FROM alerts WHERE target IS NOT NULL AND (dkey LIKE ? OR cta_url LIKE ?))").run(...like);
      q("DELETE FROM alerts WHERE target IS NOT NULL AND (dkey LIKE ? OR cta_url LIKE ?)").run(...like); },
    postCard: async (o) => toPng(postCardSvg({ ...o, host: hubUrl().replace(/^https?:\/\//, "") })),
    fetch: opts.githubFetch || fetch, ghToken: () => GH.anyToken(), hasRepos: (pr: any) => !!cityOf(pr.handle)?.buildings,
    suggest: (id, n) => suggestFor(id, n) });
  // the feed's matching and posting policy is an open-core hook (public: exact tag overlap)
  FEED!.setMatcher(ext.feedMatcher());
  MSG = messages({ q, now, hub: opts.publicUrl || "https://caldera.social", profile, byHandle, body, modOf, areFriends, memberOf, sameOrigin, readBody, json, navify, tooMany, seal, unseal,
    // brand-new, empty accounts message friends only for their first two days (a public basic rule; abuse heuristics stay in the private extensions)
    canRequest: (pr: any) => Date.parse(pr.created) < Date.now() - 2 * DAY || !!cityOf(pr.handle)?.buildings,
    notify: (to, a) => { alerts.post({ title: a.title, body: a.body, ctaLabel: a.ctaLabel, ctaUrl: a.ctaUrl, target: to, key: a.key, by: "messages" }); },
    // a new message emails the recipient (summary address, else their GitHub-verified one) when email is set up on this hub
    mailAlert: (opts.email?.send || opts.email?.resendKey) ? (to, a) => mail.messageAlert(to, a) : undefined,
    sign: (s: string) => crypto.createHmac("sha256", PRIV_KEY).update(s).digest("hex") });
  // Groups under Messages: a few hub-wide topics the founder sets; members post and reply in threads (badge only, no email)
  CHAT = chat({ q, now, profile, byHandle, body, modOf, memberOf, sameOrigin, readBody, json, tooMany, founder: opts.founder ? opts.founder.toLowerCase() : null,
    canPost: (id: string) => !q("SELECT 1 FROM msg_bans WHERE member=?").get(id),
    notify: (to, a) => { alerts.post({ title: a.title, body: a.body, ctaLabel: a.ctaLabel, ctaUrl: a.ctaUrl, target: to, key: a.key, by: "groups" }); },
    ui: { ...MSG.ui, shell: (t: string, i: string, cls: string) => MSG!.ui.shell(t, i, cls, CHAT_CSS, CHAT_JS) } });
  MSG.setGroups(id => CHAT ? CHAT.unreadTotal(id) : 0);
  headerItems.push(me => MSG ? MSG.iconFor(me, true) : "");   // Messages + unread badge (DMs + groups), left of the bell in THE header
  const feedReady = Promise.resolve(true);

  // caldera.social/gh/<login>: anyone's public GitHub as a city (and README badges for previews and members)
  let ghMembers: { at: number; map: Map<string, string> } | null = null;
  const memberOfLogin = (login: string): string | null => {
    if (!ghMembers || Date.now() - ghMembers.at > 60_000) {
      const map = new Map<string, string>();
      for (const pr of q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]) { if (modOf(pr.handle, pr.id)) continue; for (const l of loginsOf(pr)) if (!map.has(l)) map.set(l, pr.handle); }
      ghMembers = { at: Date.now(), map };
    }
    return ghMembers.map.get(login.toLowerCase()) || null;
  };
  const GHP = ghPreview({ dataDir: opts.dataDir, hub: () => hubUrl(), fetch: opts.githubFetch || fetch, token: () => GH.anyToken(), header: HEADER_MARK, tooMany, ipOf,
    memberOf: memberOfLogin, memberCity: (h: string) => { const pr = byHandle(h); return pr && !modOf(pr.handle, pr.id) ? publicCityOf(h) : null; }, pause: opts.githubFetch ? 0 : 150 });

  // the big footer from the site build (assets/footer.html), re-read when the site is redeployed
  let footerAt = 0, footerChecked = 0;
  const freshFooter = () => { if (!opts.siteDir || Date.now() - footerChecked < 30_000) return; footerChecked = Date.now();
    try { const f = path.join(opts.siteDir, "assets", "footer.html"), mt = fs.statSync(f).mtimeMs; if (mt !== footerAt) { footerAt = mt; setSiteFooter(fs.readFileSync(f, "utf8")); } } catch { /* the short footer */ } };
  const server = http.createServer(async (req, res) => {
    freshFooter();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    guardLinks(req, res, [], () => headerFor(req, (() => { try { return new URL(req.url || "/", "http://hub").pathname; } catch { return "/"; } })()));
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
      if (req.method === "GET" && p === "/manifest.webmanifest") { res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }); return res.end(MANIFEST); }   // * : sandboxed profile pages fetch it from an opaque origin
      if (req.method === "GET" && p === "/v1/me/badges") {   // the signed-in header polls this: unread messages + alerts, nothing else
        // the cookie on hub pages; the header's short-lived token on sandboxed pages (profiles, cities), which send no cookie
        const tk = readAct(url.searchParams.get("t")), me = memberOf(req) || (tk && tk.h === "badges" && profile(tk.v) ? tk.v : null);
        res.setHeader("cache-control", "no-store"); res.setHeader("vary", "Cookie");
        if (!me) return json(res, 401, { error: "signed out" });
        const m = unreadMsgs(me), al = alerts.forOwner(me, alertKind(me), 20).filter((a: any) => !a.read).length;
        return json(res, 200, { messages: m.unread, from: m.from, groups: m.groups, alerts: al, feed: FEED ? FEED.newFor(me) : 0 });
      }
      if (/^\/(start(\/confirm)?|settings(\/page)?|me)$/.test(p) && await EMP!.route(req, res, url, p)) return;   // email pages (falls through for everyone else)
      if (/^\/(auth\/github|me$|me\/upload$|settings$|settings\/(status|claim)$|alerts$|v1\/github\/)/.test(p) && await GH.route(req, res, url)) return;
      if (/^\/(feed(\/|$)|v1\/feed$|v1\/posts|v1\/comments\/|v1\/me\/notices$)/.test(p) && await FEED!.route(req, res, url, p)) return;
      if (p.startsWith("/v1/gifts") && await GIFTS!.route(req, res, p)) return;
      if (/^\/(messages\/groups|v1\/groups)(\/|$)/.test(p) && CHAT && await CHAT.route(req, res, url, p)) return;
      if (/^\/(messages(\/|$)|v1\/messages\/)/.test(p) && await MSG!.route(req, res, url, p)) return;
      if (/^\/(me\/building\/?|v1\/tags|v1\/people\/[a-z0-9-]+\/similar-stack$|v1\/intro\/|v1\/me\/intro-state|v1\/owner\/cal:[^/]+\/intros)/.test(p) && await B.route(req, res, url, p)) return;

      if (req.method === "GET" && p === "/v1/weather") { const w = await WX.forIp(ipOf(req)); res.setHeader("cache-control", "no-store"); return json(res, 200, w || { c: null }); }   // the requester's own weather, never stored
      if (req.method === "GET" && p === "/v1/info") return json(res, 200, { name: "Caldera Hub", protocol: C.PROTOCOL_VERSION, profiles: (q("SELECT COUNT(*) c FROM profiles").get() as any).c });
      if (req.method === "GET" && p === "/v1/gardens/recent" && !C.gardenEnabled()) return json(res, 404, { error: "not found" });
      if (req.method === "GET" && (p === "/gardens" || p === "/gardens/") && !C.gardenEnabled()) { res.writeHead(301, { location: "/" }); return res.end(); }
      if (req.method === "GET" && p === "/v1/gardens/recent") return json(res, 200, { notes: recentGardenNotes(Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 60))) });
      if (req.method === "GET" && (p === "/gardens" || p === "/gardens/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
        return res.end(navify(gardensPage(recentGardenNotes(80), opts.publicUrl || "https://caldera.social")));
      }
      { const g = p.match(/^\/g\/([a-z0-9][a-z0-9-]{1,29})\/?$/);
        if (req.method === "GET" && g) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
          return res.end(navify(groupPage({ slug: g[1], hub: opts.publicUrl || "https://caldera.social", members: groupMembers(g[1]) })));
        } }
      if (req.method === "GET" && p === "/v1/world") { res.setHeader("cache-control", "public, max-age=60"); const w = worldNow(); return json(res, 200, { at: w.at, members: w.members, links: w.links, city: w.city }); }
      if (req.method === "GET" && p === "/v1/world/live") { res.setHeader("cache-control", "no-store"); return json(res, 200, worldLive(url.searchParams.get("since"))); }
      if (req.method === "GET" && (p === "/world" || p === "/world/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache",
          "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
        return res.end(worldPage(worldNow(), { hub: opts.publicUrl || "https://caldera.social", nav: worldNav() }));
      }
      if (req.method === "GET" && /^\/gh\/[A-Za-z0-9-]+\/?$/.test(p)) FUNNEL.track(req, "preview");
      if ((p === "/gh" || p.startsWith("/gh/")) && await GHP.route(req, res, url, p)) return;
      { const mb = p.match(/^\/@([a-z0-9-]+)\/badge\.svg$/); if (req.method === "GET" && mb) { await GHP.memberBadge(res, mb[1], url.searchParams.get("style") === "card" ? "card" : "flat"); return; } }
      // every indexable member page and city, for search engines (robots.txt points here)
      if (req.method === "GET" && p === "/sitemap-profiles.xml") {
        const rows = (q("SELECT * FROM profiles WHERE handle IS NOT NULL ORDER BY updated DESC").all() as any[]).filter(searchable);
        const u = (loc: string, mod: string) => `<url><loc>${loc}</loc><lastmod>${String(mod || now()).slice(0, 10)}</lastmod></url>`;
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map(r => u(`${PUB()}/@${r.handle}/`, r.updated) + (cityOf(r.handle)?.buildings ? u(`${PUB()}/@${r.handle}/city.html`, r.updated) : "")).join("")}</urlset>\n`);
      }
      if (req.method === "GET" && p === "/world/preview.png") { const png = await worldPreview(); res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=600" }); return res.end(png); }
      const m0 = p.match(/^\/watch\/@([a-z0-9-]+)\/?$/);
      if (req.method === "GET" && m0) {
        const pr = byHandle(m0[1]);
        if (!pr || modOf(pr.handle, pr.id) || !fs.existsSync(path.join(opts.dataDir, "profiles", m0[1], "city.html"))) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("No city here."); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex", "content-security-policy": WATCH_CSP });
        return res.end(watchPage(pr.name || "@" + m0[1], `/@${m0[1]}/city.html${url.search}#mini`));
      }
      if (req.method === "GET" && (p === "/t.js" || p === "/t/1.js")) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": p === "/t.js" ? "public, max-age=3600" : "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
        return res.end(TRACK_JS);
      }
      if (req.method === "GET" && opts.siteDir && !p.startsWith("/v1/") && !p.startsWith("/@")) {
        let rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
        if (p === "/") FUNNEL.track(req, "view", String(url.searchParams.get("ref") || "").slice(0, 40));
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
        if (env?.type === "profile.manifest" && !profile(env.from) && !allowNewProfile(req)) return json(res, 429, { error: "Lots of people are signing up from your network right now. Wait a minute and try again." });
        const r = accept(env); return json(res, r.status, r.body);
      }

      // upload a static profile bundle: { manifest: <signed profile.manifest>, files: { "index.html": "<base64>", ... } }
      let m = p.match(/^\/v1\/profiles\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/bundle$/);
      if (req.method === "POST" && m) {
        const body = await readBody(req);
        if (body.manifest?.from !== m[1]) return json(res, 403, { error: "manifest must be signed by the profile" });
        { const newer = staleClient(m[1], "bundle", body.v); if (newer) return json(res, 409, { error: `Caldera ${newer} already published this profile; update Caldera on this device (you have ${body.v || "an older version"})` }); }
        if (!profile(m[1]) && !allowNewProfile(req)) return json(res, 429, { error: "Lots of people are signing up from your network right now. Wait a minute and try again." });
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
        if (!C.gardenEnabled() && gardenPath(rel)) { res.writeHead(404); return res.end("not found"); }   // garden paused: files stay, nobody sees them
        const file = path.join(dir, path.normalize(rel));
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          const ns = rel.match(/^n\/([a-z0-9][a-z0-9-]*)\.html$/), tb = ns ? tombstoned(m[1], ns[1]) : undefined;
          if (tb) { res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" }); return res.end(navify(tombstonePage(m[1], ns![1], tb))); }
          if (rel.endsWith(".html")) {   // a missing page (deleted profile, old link): a friendly page with a way on, not a bare "not found"
            const gone = !byHandle(m[1]), h = m[1].replace(/[^a-z0-9-]/g, "");
            res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" });
            return res.end(navify(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not here - Caldera</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/site.css"><style>.nf{max-width:640px;margin:0 auto;padding:64px 16px 80px;text-align:center}.nf h1{font-family:var(--font-display,'Source Serif 4',Georgia,serif);font-size:2rem;margin:0 0 10px;color:var(--text-strong)}.nf p{color:var(--text-muted);margin:0 0 22px}.nf .row{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}</style></head><body><main class="nf"><h1>${gone ? `@${h} isn't on Caldera` : "This page isn't here"}</h1><p>${gone ? "This profile was deleted or never existed. Old links keep pointing here." : `It may have moved. @${h}'s page is still here.`}</p><div class="row">${gone ? "" : `<a class="btn" href="/@${h}/">Go to @${h}</a>`}<a class="btn${gone ? "" : " ghost"}" href="/people">Find people</a><a class="btn ghost" href="/world">Explore the world</a><a class="btn ghost" href="/#install">Get your own page</a></div></main></body></html>`));
          }
          res.writeHead(404); return res.end("not found");
        }
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
          // pages published with the placeholder name (older plugins): show the member's real name instead of "Untitled"
          if (prS?.name && !/^untitled$/i.test(prS.name) && /Untitled/.test(html)) { const nm = String(prS.name).replace(/[&<>"']/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" } as any)[c]);
            html = html.replace(/<title>Untitled/g, `<title>${nm}`).replace(/>Untitled</g, `>${nm}<`).replace(/Untitled\.md/g, `${nm}.md`).replace(/Untitled's/g, `${nm}'s`).replace(/(<h1 class="title">)Untitled/g, `$1${nm}`)
              .replace(/Notes connected to Untitled/g, `Notes connected to ${nm}`).replace(/%0A%0AUntitled"/g, `%0A%0A${encodeURIComponent(String(prS.name))}"`); }
          const soc: BarSocial | undefined = prS ? { ...barSocial(prS, !!own), viewer } : undefined;
          // views, kudos and Add friend sit under the person's name (profile) or the city title; other pages keep the bar clean
          const rowAt = rel === "index.html" ? (/<p class="lede">[\s\S]*?<\/p>/.test(html) ? /<p class="lede">[\s\S]*?<\/p>/ : /<h1 class="title">[\s\S]*?<\/h1>/) : rel === "city.html" ? /<h1 class="c-title">[\s\S]*?<\/h1>/ : null;
          const inPage = !!(soc && rowAt && rowAt.test(html));
          const bar = calderaBar(opts.publicUrl || "https://caldera.social", m[1], own, soc && (inPage || rel === "index.html" || rel === "city.html") ? { ...soc, inPage } : undefined,
            own && prS ? bellFor(prS.id) : viewer ? bellFor(memberOf(req)) : "");
          html = liveBlocks(m[1], rel, html);
          if (prS) html = privatePage(prS, rel, html);   // private repos: anonymous or hidden, whatever version built the page
          html = rewriteFriendLinks(html, m[1], viewer, !!own);
          if (prS && rel === "index.html") html = realLeaderboard(html, prS, !!own);
          if (rel === "index.html") html = dropHelpExchange(html);
          if (prS && (rel === "index.html" || rel === "city.html")) void GH.freshen(prS.id);   // new GitHub repos: rebuilt in the background, on the map by the next load
          (headers as any)["content-security-policy"] = cityCsp(originOf(opts.publicUrl));   // connect-src to this hub only (inline kudos/friends, city feeds); still sandboxed
          if ((rel === "index.html" || rel === "city.html") && !html.includes('property="og:image"')) html = html.replace(/<\/head>/i, previewTags(m[1], rel) + "</head>");
          if ((rel === "index.html" || rel === "city.html") && prS && !own && searchable(prS)) { html = profileSeo(prS, rel, html); (headers as any)["x-robots-tag"] = "index, follow, max-image-preview:large"; }
          if (rel === "city.html") html = injectBuildWatch(html, `/v1/build/${m[1]}`, buildOf(m[1]));
          if (rel === "city.html") { const pr = byHandle(m[1]); if (pr && hasLive(pr.id)) html = injectLive(html, { url: `/v1/live/${m[1]}`, mode: "public" });
            html = cityExtras(html, pr && own && memberOf(req) === pr.id ? pr.id : null); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.publicUrl)); }   // weather for every viewer; setup row for the owner only
          if (inPage && soc && rowAt) { const hd = m[1], meV = !own ? memberOf(req) : null;
            const build = prS ? B.CHIP_CSS + B.chips(PUB(), prS, !!own, viewer && meV ? { me: meV, token: viewer.token } : null) : "";
            // the profile's posts + activity card: visitors act with their member token, the owner with an owner token
            const card = rel === "index.html" && prS ? FEED!.profileCard(prS, { token: own ? actToken(prS.id, hd) : viewer?.token || null, owner: !!own }) : "";
            // "Builds with a similar stack": people whose public repos share uncommon packages with this page's owner
            const stack = rel === "index.html" && prS ? B.stackCard(PUB(), prS) : "";
            html = html.replace(rowAt, h => h + socialRow(opts.publicUrl || "https://caldera.social", hd, soc, `/@${hd}/${rel === "index.html" ? "" : rel}`) + build + card + stack); }
          // just claimed (from /settings?welcome=1): one short line on the city, nothing else competing with it
          const welcome = own && prS && rel === "city.html" && url.searchParams.get("welcome") ? welcomeBanner(m[1]) : "";
          if (welcome) FUNNEL.track(req, "landed");
          const sum = welcome || (own && prS && (rel === "index.html" || rel === "city.html") && memberOf(req) === prS.id ? summaryBanner(prS.id, m[1]) : "");
          const out = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar + sum) : bar + sum + html;
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
        const me = memberOf(req); if (!me) return json(res, 401, { error: "Sign in to follow people." });
        const ab = await readBody(req).catch(() => ({})) as any;
        const r = friendAct(me, byHandle(m[1]), ab?.action === "unfollow" ? "unfollow" : "friend"); return json(res, r.status, r.body);
      }
      // inline kudos + friends on hosted pages: the page's action token is the only credential (sandboxed pages send no
      // cookies, Origin is "null"); it names the viewer and the one page owner it may act on, and expires in 2 hours
      if (req.method === "POST" && p === "/v1/act") {
        if (tooMany("act-ip:" + ipOf(req), 120)) return json(res, 429, { error: "slow down" });
        const b = await readBody(req).catch(() => ({})) as { t?: string; action?: string; kind?: string };
        const tok = readAct(b.t); if (!tok) return json(res, 401, { error: "Sign in again to do that (your page session expired). Reload the page." });
        const me = profile(tok.v); if (!me?.handle || modOf(me.handle, me.id)) return json(res, 401, { error: "Sign in to do that." });
        const to = byHandle(tok.h); if (!to || modOf(to.handle, to.id)) return json(res, 404, { error: "unknown profile" });
        if (me.id === to.id && (b.action === "email-subscribe" || b.action === "email-dismiss")) {   // the owner answering the daily-summary banner on their own page
          if (b.action === "email-dismiss") { mail.dismissPrompt(me.id); return json(res, 200, { ok: true }); }
          try { return json(res, 200, { ok: true, message: await mail.subscribe(me.id, String((b as any).email || "").slice(0, 200)) }); } catch (e: any) { return json(res, 400, { error: e.message }); }
        }
        if (b.action === "kudos") { const r = sendKudos(me.id, to, String(b.kind || ""), "inline"); return json(res, r.status, r.body); }
        if (b.action === "friend" || b.action === "accept" || b.action === "unfollow") { const r = friendAct(me.id, to, b.action === "unfollow" ? "unfollow" : "friend"); return json(res, r.status, r.body); }
        if (b.action === "intro") { const r = B.requestIntro(me.id, to); return json(res, r.status, r.body); }
        // the profile's posts card: only posts by this page's owner; Close / Delete only with the owner's own token
        if (/^post-(kudos|help|close|delete)$/.test(String(b.action))) {
          const pid = String((b as any).post || ""), row = /^[0-9a-f]{12}$/.test(pid) ? FEED!.postRow(pid) : null;
          if (!row || row.author !== to.id) return json(res, 404, { error: "not found" });
          if (b.action === "post-kudos" || b.action === "post-help") { if (me.id === to.id) return json(res, 400, { error: "That's your own post." });
            const r = b.action === "post-kudos" ? FEED!.kudosPost(me.id, pid, String(b.kind || "")) : FEED!.helpPost(me.id, pid); FEED!.invalidate(); return json(res, r.status, r.body); }
          if (me.id !== to.id) return json(res, 403, { error: "Only the author can do that." });
          const r = FEED!.closePost(me.id, pid, b.action === "post-delete"); FEED!.invalidate(); return json(res, r.status, r.body);
        }
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
      // alerts: the bell's "seen" beacon (sandboxed pages carry no cookies, so a signed per-member token), and the plugin's feed
      if (req.method === "GET" && p === "/v1/alerts/seen") {
        const tk = alerts.checkSeen(url.searchParams.get("t")); if (tk) alerts.markSeenUpTo(tk.owner, alertKind(tk.owner), tk.upTo);
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store", "cross-origin-resource-policy": "cross-origin" }); return res.end(PIXEL);
      }
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/alerts(\/read)?$/);
      if (m && (req.method === "GET" || req.method === "POST")) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        if (req.method === "POST" && m[2]) { const { ids } = await readBody(req) as { ids?: unknown }; alerts.markRead(m[1], Array.isArray(ids) ? ids.map(String) : []); return json(res, 200, { ok: true }); }
        const rows = alerts.forOwner(m[1], alertKind(m[1]), 30);
        return json(res, 200, { unread: rows.filter(r => !r.read).length, url: `${PUB()}/alerts`, alerts: rows.map(r => ({ id: r.id, title: r.title, body: r.body, cta_label: r.cta_label, cta_url: r.cta_url, copy_label: r.copy_label, has_copy: !!r.copy_text, pinned: !!r.pinned, ts: r.ts, read: !!r.read })) });
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
        res.writeHead(302, { location: to === "settings" || to === "alerts" || to === "messages" ? "/" + to : `/@${pr.handle}/${sub}`, "set-cookie": ownCookie(t, OWN_AGE), "cache-control": "no-store" }); return res.end();
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
        return json(res, 200, { signedIn: true, handle: pr.handle, name: pr.name || "", page: n.publicHref, private: n.privateHref, privateExternal: !!n.privateExternal, signout: n.signout,
          messages: { unread: MSG ? MSG.unreadFor(pr.id) : 0, url: `${PUB()}/messages` } });
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
        if (req.method === "POST" && origin && pubOrigin && origin !== pubOrigin && !sameOrigin(req)) return json(res, 403, { error: "wrong origin" });
        const ip = ipOf(req);
        if (req.method === "GET" && p === "/signin") {
          if (!url.searchParams.get("h")) { signinGeneral(res, String(url.searchParams.get("back") || "")); return; }
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
        q("DELETE FROM challenges WHERE (id=? AND nonce=?) OR expires < ?").run(env.from, env.body?.nonce, Date.now());   // only the used one: the plugin signs in from several requests at once
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

      if (p === "/v1/email/invite-unsub" && (req.method === "GET" || req.method === "POST")) {
        const t = (url.searchParams.get("t") || "").replace(/[^\w-]/g, "");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        if (req.method === "GET") return res.end(mail.page("No more Caldera emails", `<form method="post" action="${p}?t=${t}"><p>Stop all Caldera emails to this address, including invites from people you know.</p><button class="btn" type="submit">Don't email me</button></form>`));
        mail.inviteUnsub(t);   // idempotent; also the RFC 8058 one-click POST
        return res.end(mail.page("Done", "<p>Caldera won't email this address again.</p>"));
      }
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/github-people$/);
      if (req.method === "GET" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const pr = profile(m[1]); if (!pr?.handle) return json(res, 404, { error: "publish your profile first" });
        const link = `${PUB()}/?invite=${encodeURIComponent(pr.handle)}`;
        return json(res, 200, { people: await githubPeople(m[1]), inviteLink: link, invitesLeft: Math.max(0, mail.inviteCap - mail.invitesToday(m[1])),
          message: `I'm on Caldera, a social network for GitHub and Obsidian (my repos are a little city). Join me: ${link}` });
      }
      m = p.match(/^\/v1\/owner\/(cal:[1-9A-HJ-NP-Za-km-z]+)\/github-invite$/);
      if (req.method === "POST" && m) {
        if (authed(req) !== m[1]) return json(res, 401, { error: "sign in as this profile" });
        const { login } = await readBody(req) as { login?: string };
        try { return json(res, 200, { ok: true, message: await githubInvite(m[1], String(login || "")) }); } catch (e: any) { return json(res, 400, { error: e.message }); }
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
        const friends = (q("SELECT b, ts, kind, why FROM friends WHERE a=? AND ts > ? ORDER BY ts DESC LIMIT 20").all(m[1], since) as any[]).map(r => ({ handle: hn(r.b), ts: r.ts, kind: r.kind || "request", why: r.why || undefined }));
        const links = C.gardenEnabled() ? (q("SELECT src_handle, src_slug, src_title, dst_slug FROM garden_links WHERE dst_handle=? AND src_handle<>? LIMIT 20").all(h, h) as any[]) : [];
        const asks = (q("SELECT title, status, ts FROM asks WHERE author=? ORDER BY ts DESC LIMIT 10").all(m[1]) as any[]);
        const pv = q("SELECT ts FROM owner_private WHERE owner=?").get(m[1]) as any;
        return json(res, 200, { emailConfirmed: mail.hasConfirmed(m[1]), since, handle: h, views: v.n, visitors: v.u, pages, days, totalViews: total, viewsAll: viewsOf(h), viewsWeek: viewsOf(h, new Date(Date.now() - 7 * DAY).toISOString()), showViews: body(pr).showViews !== false, kudos: kudosFor(m[1], since), kudosTally: Object.fromEntries(tallyOf(m[1])), gravity, friends, links, asks, privateUrl: privateFor(h), privatePushed: pv?.ts, unlock: unlockStateFor(m[1]) || {}, connections: connectionsFor(m[1]),
          messages: MSG ? { unread: MSG.unreadFor(m[1]), from: MSG.inbox(m[1]).filter(x => x.unread && x.handle).slice(0, 3).map(x => x.handle) } : undefined });
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
      // which build of a member's public city is current: open city pages reload when it changes (injectBuildWatch)
      m = p.match(/^\/v1\/build\/([a-z0-9-]+)$/);
      if (req.method === "GET" && m) { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); return res.end(JSON.stringify({ build: buildOf(m[1]) })); }
      m = p.match(/^\/v1\/live\/([a-z0-9-]+)$/);
      if (req.method === "GET" && m) {
        const pr = byHandle(m[1]); if (!pr || modOf(pr.handle, pr.id)) return json(res, 404, { error: "not found" });
        return json(res, 200, scrubPrivateLive(liveStats(pr.id, false, url.searchParams.get("since")), PM.modeFor(pr)) || { at: now(), districts: {} });
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
        const term = (url.searchParams.get("q") || "").toLowerCase().trim(), tag = (url.searchParams.get("tag") || "").toLowerCase().trim(), sort = url.searchParams.get("sort") || ((term || tag) ? "relevance" : "active");
        const rows = (q("SELECT * FROM profiles WHERE handle IS NOT NULL").all() as any[]).filter(listed).map(pr => {
          const b = body(pr), avatar = b.photos?.avatar ? `/@${pr.handle}/${String(b.photos.avatar).replace(/^\.?\//, "")}` : null;
          const tags = B.tagsOf(pr), rel = term || tag ? B.relevance(pr, tag, term) : 0;
          return { handle: pr.handle, name: pr.name, headline: pr.headline, avatar, topics: (b.topics || []).slice(0, 3).map((t: any) => t[0]),
            tags: tags.slice(0, 8).map(t => ({ t: t.t, kind: t.kind })), rel,
            week: weekScore(pr.manifest), gravity: gravityOf(pr.id), invited: invitedCount(pr.id), created: pr.created, updated: pr.updated, city: fs.existsSync(path.join(opts.dataDir, "profiles", pr.handle, "city.html")) };
        }).filter(r => (!term && !tag) || r.rel >= 0);
        rows.sort(sort === "new" ? (a, b) => String(b.created).localeCompare(String(a.created)) : sort === "relevance" ? (a, b) => b.rel - a.rel || b.week - a.week : (a, b) => b.week - a.week || b.gravity - a.gravity);
        return json(res, 200, { total: rows.length, profiles: rows.slice(0, 120).map(({ rel, ...r }) => r) });
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
        const rows = q("SELECT f.b AS id, p.handle, p.name, p.box_key, COALESCE(f.kind,'request') AS kind, f.why FROM friends f LEFT JOIN profiles p ON p.id=f.b WHERE f.a=?").all(m[1]);
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
    guardLinks(req, res, [], () => {   // the same header as the public site, on the private (Tailscale) address: the owner, Private selected
      const u = new URL(req.url || "/", "http://private"), mine0 = owners[String(req.headers["tailscale-user-login"] || "").toLowerCase()];
      const pr = mine0 ? byHandle(mine0) : null, viewer = headerViewer(pr?.id || null);
      const mm = u.pathname.match(/^\/@([a-z0-9-]+)(\/.*)?$/), sub = mm && mm[2] && mm[2] !== "/" ? mm[2].slice(1).replace(/^index\.html$/, "") : "";
      const own = pr ? { view: (u.searchParams.get("view") === "public" ? "public" : "private") as "public" | "private", publicHref: `${PUB()}/@${pr.handle}/${sub}`, privateHref: `${(privateFor(pr.handle) || "").replace(/\/$/, "")}/${sub}`.replace(/\/\/$/, "/") } : null;
      return { header: appHeader({ hub: PUB(), current: "profile", viewer, own }), signedIn: true };
    });
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
      if (m[2] === "/build.json") {   // open private city pages poll this to reload when a newer build or private push exists
        const t = url.searchParams.get("t") || "", pr0 = byHandle(mine);
        if (!pr0 || !liveTokenOk(mine, t)) { res.writeHead(403, { "content-type": "application/json" }); return res.end("{}"); }
        const r0 = url.searchParams.get("view") === "public" ? null : q("SELECT built FROM owner_private WHERE owner=?").get(pr0.id) as any;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify({ build: buildOf(mine, r0?.built) }));
      }
      if (m[2] === "/live.json") {   // the private city polls this; the token in the page stops other sites reading it through your browser
        const t = url.searchParams.get("t") || "", pr0 = byHandle(mine);
        if (!pr0 || !liveTokenOk(mine, t)) { res.writeHead(403, { "content-type": "application/json" }); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        const pubView = url.searchParams.get("view") === "public", ls = liveStats(pr0.id, !pubView, url.searchParams.get("since"));
        return res.end(JSON.stringify((pubView ? scrubPrivateLive(ls, PM.modeFor(pr0)) : ls) || { at: now(), districts: {} }));
      }
      const dir = path.join(opts.dataDir, "profiles", mine);
      let rel = m[2].slice(1) || "index.html"; if (rel.endsWith("/")) rel += "index.html";
      if (!C.gardenEnabled() && gardenPath(rel)) { res.writeHead(404); return res.end("not found"); }
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
      if (pub && !own && pr) html = privatePage(pr, rel, html);   // "Public view" shows exactly what visitors get
      const ago = (iso: string) => { const mn = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return mn < 60 ? `${mn} min ago` : mn < 2880 ? `${Math.floor(mn / 60)} h ago` : `${Math.floor(mn / 1440)} days ago`; };
      // the same bar as the public page signed in as owner: [Public view | Private view] in the same place, account menu on the right
      const nav = pr ? navFor(pr, "private", rel) : null;
      if (nav) nav.note = row ? `Private sections pushed from Obsidian ${ago(row.built)}. Only your Tailscale account can open this address.` : "No private sections yet: turn on the private address in Caldera settings in Obsidian.";
      const bar = nav ? calderaBar(opts.publicUrl || "https://caldera.social", mine, nav, undefined, bellFor(byHandle(mine)?.id)) : "";
      if (rel === "index.html" && !pub && row) html = html.replace("<!--caldera:owner-->", priv.layer);
      if (rel === "city.html" && pr && (sitesOf(pr.id).length || q("SELECT 1 FROM agent_keys WHERE owner=?").get(pr.id))) html = injectLive(html, { url: `live.json?t=${liveToken(mine)}${pub ? "&view=public" : ""}`, mode: pub ? "public" : "private" });
      if (rel === "city.html") html = injectBuildWatch(html, `build.json?t=${liveToken(mine)}${pub ? "&view=public" : ""}`, buildOf(mine, pub ? null : row?.built));
      if (rel === "city.html" && pr) { html = cityExtras(html, pub ? null : pr.id); (headers as any)["content-security-policy"] = cityCsp(originOf(opts.privateUrl), originOf(opts.publicUrl)); }
      html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, b => b + bar) : bar + html;
      res.writeHead(200, headers); return res.end(html);
    } catch (err: any) { res.writeHead(500, { "content-type": "text/plain" }); res.end("error"); }
  });

  // members who joined before the private-repos setting existed keep padlocked buildings until they choose; each one with
  // private work on their public city is asked once (a personal alert pointing at Settings > Privacy)
  function promptPrivateChoice() {
    for (const pr of q("SELECT * FROM profiles WHERE handle IS NOT NULL AND created < ?").all(PM.since) as any[]) {
      if (PM.chosen(pr) || modOf(pr.handle, pr.id)) continue;
      const c = publicCityOf(pr.handle); if (!c || !c.districts.some((d: any) => (d.repos || []).some((r: any) => r.locked))) continue;
      if (!PM.promptOnce(pr.id)) continue;
      try { alerts.post({ title: "Choose how your private repos show", target: pr.id, key: "private-repos-choice", by: "privacy", ctaLabel: "Open Privacy settings", ctaUrl: "/settings#private-repos",
        body: "Your public city shows private repos as padlocked buildings. Names stay hidden, but visitors can still tell roughly how big and how busy that work is, and which project it sits beside.\n\nYou can keep that, make private work **anonymous** (one separate padlocked district, no sizes or activity), or **hide** it completely. Your private view always shows everything." }); } catch { /* best effort */ }
    }
  }
  setTimeout(() => { try { promptPrivateChoice(); } catch (e: any) { console.error("private repos prompt", e?.message); } }, 15_000).unref?.();

  return { ext, server, privateServer, db, admin, mail, feed: FEED!, messages: MSG!, digestFor, feedReady, headerItems, privateModes: PM, promptPrivateChoice, act: { token: (v: string, h: string, ttl?: number) => actToken(v, h, ttl), read: readAct },
    listen: (port = opts.port || 8787, host = process.env.CALDERA_HOST || "127.0.0.1") => new Promise<number>(r => server.listen(port, host, () => r((server.address() as any).port))),
    listenPrivate: (port = opts.privatePort || 0) => new Promise<number>(r => privateServer.listen(port, "127.0.0.1", () => r((privateServer.address() as any).port))) };
}


/** Owner alerts for sign-ups and deletions: the first `perDay` events each UTC day are sent one by one; after that they
 *  queue and flush() sends one digest ("37 new profiles in the last hour: @a, @b, ..."). */
export function makeAlertBatcher(send: (subject: string, text: string) => void, site: string, perDay = 10, now = () => Date.now()) {
  let day = "", sent = 0; let queue: { type: string; handle?: string; name?: string; total: number }[] = [];
  const who = (h?: string) => h ? `@${h}` : "(no handle)";
  return {
    event(ev: { type: "signup" | "delete"; handle?: string; name?: string; total: number }) {
      const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; sent = 0; }
      if (sent < perDay) {
        sent++;
        if (ev.type === "signup") send(`New Caldera profile: ${who(ev.handle)} (${ev.total} total)`, `New Caldera profile: ${who(ev.handle)}${ev.name ? ` (${ev.name})` : ""}\nTotal profiles: ${ev.total}\n${site}/@${ev.handle || ""}/?src=email-signup-alert\n\nAll profiles: ${site}/people?src=email-signup-alert` + (sent === perDay ? `\n\nThat's ${perDay} today: further sign-ups today arrive as one email an hour.` : ""));
        else send(`Caldera profile deleted: ${who(ev.handle)} (${ev.total} total)`, `Caldera profile deleted: ${who(ev.handle)}. Total profiles: ${ev.total}\n\nAll profiles: ${site}/people?sort=new&src=email-signup-alert`);
        return;
      }
      queue.push(ev);
    },
    flush() {
      if (!queue.length) return;
      const q = queue; queue = [];
      const ups = q.filter(e => e.type === "signup"), dels = q.filter(e => e.type === "delete"), total = q[q.length - 1].total;
      const subject = `${ups.length} new Caldera profile${ups.length === 1 ? "" : "s"} in the last hour${dels.length ? `, ${dels.length} deleted` : ""} (${total} total)`;
      const text = [ups.length ? `New: ${ups.map(e => who(e.handle) + (e.name ? ` (${e.name})` : "")).join(", ")}` : "", dels.length ? `Deleted: ${dels.map(e => who(e.handle)).join(", ")}` : "", `Total profiles: ${total}`, `${site}/people?sort=new&src=email-signup-alert`].filter(Boolean).join("\n\n");
      send(subject, text);
    },
    pending: () => queue.length,
  };
}

// CLI: node dist/server.js  (env: CALDERA_DATA, PORT, CALDERA_PUBLIC_URL)
if (import.meta.url === `file://${process.argv[1]}` && /server\.js$/.test(process.argv[1] || "")) {
  // Owner alerts on signups/deletions: Telegram and/or email (Resend). Both optional, fire-and-forget.
  const tg = process.env.CALDERA_TELEGRAM_TOKEN, chat = process.env.CALDERA_TELEGRAM_CHAT, site = process.env.CALDERA_PUBLIC_URL || "https://caldera.social";
  const resend = process.env.CALDERA_RESEND_KEY, mailTo = process.env.CALDERA_NOTIFY_EMAIL, mailFrom = process.env.CALDERA_NOTIFY_FROM || "Caldera <inbox@caldera.social>";
  const warn = (what: string) => (r: Response) => { if (!r.ok) console.error(what + " notify failed", r.status); };
  const sendAlert = (subject: string, text: string) => {
    if (tg && chat) fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) })
      .then(warn("telegram")).catch(err => console.error("telegram notify error", String(err)));
    if (resend && mailTo) fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + resend, "content-type": "application/json" }, body: JSON.stringify({ from: mailFrom, to: [mailTo], subject, text }) })
      .then(warn("email")).catch(err => console.error("email notify error", String(err)));
  };
  // a launch can bring hundreds of sign-ups: the first 10 a day arrive one by one, the rest as one email an hour
  const alerts = makeAlertBatcher(sendAlert, site);
  const onEvent: HubOptions["onEvent"] = (tg && chat) || (resend && mailTo) ? (ev) => alerts.event(ev) : undefined;
  if (onEvent) setInterval(() => alerts.flush(), 3600_000).unref?.();
  const hub = createHub({ garden: process.env.CALDERA_GARDEN === "1", dataDir: process.env.CALDERA_DATA || "./data", port: Number(process.env.PORT || 8787), publicUrl: process.env.CALDERA_PUBLIC_URL || "",
    siteDir: process.env.CALDERA_SITE || undefined, trustProxy: process.env.CALDERA_TRUST_PROXY === "1", onEvent, founder: process.env.CALDERA_FOUNDER || undefined, repoJob: process.env.CALDERA_REPO_JOB !== "0", tagJob: process.env.CALDERA_TAG_JOB !== "0", llmKey: process.env.CALDERA_OPENROUTER_KEY || undefined,
    email: resend ? { resendKey: resend, schedule: true } : undefined,
    // CALDERA_TAILNET_OWNERS="you@example.com:handle,..."  (Tailscale login -> Caldera handle)
    privatePort: Number(process.env.CALDERA_PRIVATE_PORT) || undefined, privateUrl: process.env.CALDERA_PRIVATE_URL || undefined,
    tailnetOwners: Object.fromEntries((process.env.CALDERA_TAILNET_OWNERS || "").split(",").map(s => s.trim().split(":")).filter(x => x.length === 2 && x[0] && x[1]).map(([l, h]) => [l.toLowerCase(), h.toLowerCase()])) });
  console.log(`private extensions loaded: ${hub.ext.loaded.length ? hub.ext.loaded.join(", ") : "none (public fallbacks)"}`);
  hub.listen().then(p => console.log(`Caldera Hub listening on :${p}`));
  if (process.env.CALDERA_PRIVATE_PORT) hub.listenPrivate().then(p => console.log(`Caldera private owner address on 127.0.0.1:${p}`));
}
