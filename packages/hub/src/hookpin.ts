import crypto from "node:crypto";
/** The SHA-256 of site/agent-hook.mjs. Setup prompts ask the AI to check it before installing, so a swapped hook file
 * is refused. A test keeps it in step with the file; the Obsidian plugin carries its own copy from its release. */
export const AGENT_HOOK_SHA256 = "bfe8dbde26fdc5e8b2e33805cdd4cadb98020ecaf34fe3f7c2e491ed636aedae";
export const hookCheck = `   Before using it, check its SHA-256 is ${AGENT_HOOK_SHA256} (shasum -a 256 ~/.caldera/agent-hook.mjs). If it doesn't match, delete it, stop and tell me.`;
export const hookTasksNote = `\n\nIf I'd rather not send task titles at all, add "tasks": false to agent.json (drones still fly, without words).`;

// Live-traffic snippet for the owner's own sites. New snippets load the frozen /t/1.js with a Subresource Integrity hash,
// so even someone who took over this server couldn't change the script running on members' websites (the browser
// refuses a file that doesn't match). /t.js stays for snippets pasted before. Counts page views (and single-page
// navigations); caldera("signup") / caldera("buy") mark conversions. No cookies.
export const TRACK_JS = `(function(){var s=document.currentScript;if(!s)return;var k=s.getAttribute('data-site');if(!k)return;var base=s.src.replace(/\\/t(\\/\\d+)?\\.js.*$/,'');
function send(kind){var u=base+'/v1/t/'+encodeURIComponent(k)+'.gif?k='+(kind||'view')+'&r='+Math.random().toString(36).slice(2);try{if(navigator.sendBeacon&&navigator.sendBeacon(u))return}catch(e){}var i=new Image();i.src=u}
window.caldera=function(kind){send(kind==='signup'||kind==='buy'?kind:'view')};send('view');var last=location.pathname;
function nav(){if(location.pathname!==last){last=location.pathname;send('view')}}var ps=history.pushState;history.pushState=function(){var r=ps.apply(this,arguments);nav();return r};addEventListener('popstate',nav)})();`;
export const TRACK_SRI = "sha384-" + crypto.createHash("sha384").update(TRACK_JS).digest("base64");
export const trackTag = (hub: string, key: string) => `<script async src="${hub.replace(/\/$/, "")}/t/1.js" integrity="${TRACK_SRI}" crossorigin="anonymous" data-site="${key}"></script>`;
