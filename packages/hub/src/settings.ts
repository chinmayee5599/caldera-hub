/**
 * /settings: one account page for every owner, GitHub-first with Obsidian as an add-on.
 * The Connections panel shows a status light per source (GitHub, Obsidian, live visitors, AI agents, private view,
 * daily email) and a step-by-step connect flow right in the page for anything that's off. Pure rendering: the hub
 * computes the state (connectionsFor in server.ts) and the GitHub module wires the routes.
 */
export interface Conn {
  hosted: boolean;                                       // a GitHub sign-up the hub builds (no vault yet)
  github: { on: boolean; login?: string; listed?: string };   // listed: the GitHub login the page's links name
  obsidian: { on: boolean; updated?: string };
  live: boolean; agents: boolean; private?: boolean; email: boolean;
}
export interface PanelOpts {
  pub: string; handle: string; conn: Conn;
  sites: { key: string; project: string }[];
  livePrompt: string; agentPrompt: string; privatePrompt?: string;
  app?: { slug: string } | null; installation?: boolean;  // hosted: the GitHub app for private repos
  email?: string;                                        // the address the daily email goes to (shown on the row only)
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ago = (iso?: string) => { if (!iso) return ""; const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`; };

/** Styles for /settings (Caldera's tokens from theme.css, dark fallbacks). */
export const SETTINGS_CSS = `<style>
.set-nav{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:14px -16px 4px;padding:8px 16px;background:var(--bg,#0E0B16);border-bottom:1px solid var(--line,#2A2440)}
.set-nav::-webkit-scrollbar{display:none}.set-nav a{flex:none;padding:6px 12px;border-radius:999px;color:var(--text-muted,#9A9AA6);font-size:14px;text-decoration:none;border:1px solid transparent}
.set-nav a:hover{color:var(--text,#E6E6EA);border-color:var(--line,#2A2440)}
.me h2.set-h{font-family:'Source Serif 4',Georgia,serif;font-size:1.35rem;margin:30px 0 4px;scroll-margin-top:64px}.me p.set-sub{margin:0 0 6px;color:var(--text-muted,#9A9AA6);font-size:.95em}
.conn{background:var(--bg-raised,#16131F);border:1px solid var(--line,#2A2440);border-radius:12px;margin:14px 0;overflow:hidden}
.conn-row{border-top:1px solid var(--line,#2A2440)}.conn-row:first-child{border-top:0}
.conn-row>summary,.conn-row>.conn-head{list-style:none;display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer}.conn-row>.conn-head{cursor:default}
.conn-row>summary::-webkit-details-marker{display:none}.conn-row>summary:hover{background:var(--bg-sunken,rgba(255,255,255,.03))}
.conn-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--text-muted,#6B6B78);box-shadow:0 0 0 3px rgba(128,128,140,.15)}
.conn-dot.on{background:#3FB97F;box-shadow:0 0 0 3px rgba(63,185,127,.22)}
.conn-t{flex:1;min-width:0}.conn-t>b{display:block;color:var(--text-strong,#F7F7FA);font-weight:600}.conn-t span{display:block;color:var(--text-muted,#9A9AA6);font-size:13.5px;overflow-wrap:anywhere}
.conn-act{flex:none;font-size:13px;font-weight:600;color:var(--accent-text,#B9A6FF);white-space:nowrap}.conn-row[open] .conn-act .when-closed,.conn-row:not([open]) .conn-act .when-open{display:none}
.conn-body{padding:2px 16px 16px 38px}.conn-body ol{margin:6px 0 0;padding-left:20px}.conn-body li{margin:10px 0}.conn-body li::marker{color:var(--text-muted,#9A9AA6)}
.conn-code{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}.conn-code code{font:600 18px 'IBM Plex Mono',monospace;letter-spacing:.04em;padding:8px 12px;border-radius:8px;border:1px dashed var(--accent,#8B6CF6);background:var(--bg,#0E0B16);color:var(--text-strong,#F7F7FA)}
.conn-wait{display:inline-flex;align-items:center;gap:8px;color:var(--text-muted,#9A9AA6);font-size:13.5px}.conn-wait i{width:8px;height:8px;border-radius:50%;background:var(--accent,#8B6CF6);animation:connp 1.4s ease-in-out infinite}
@keyframes connp{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.conn-wait i{animation:none}}
@media (max-width:520px){.conn-body{padding-left:16px}.conn-act{font-size:12.5px}}
.danger-zone{border-color:rgba(240,113,106,.45)!important}
</style>`;

export const settingsNav = (items: [string, string][]) => `<nav class="set-nav" aria-label="Settings sections">${items.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join("")}</nav>`;
export const sectionHead = (id: string, title: string, sub = "") => `<h2 class="set-h" id="${id}">${esc(title)}</h2>${sub ? `<p class="set-sub">${sub}</p>` : ""}`;

/** One row: light, title, status line, and (when there's something to do) an expandable in-page flow. */
function row(id: string, on: boolean, title: string, status: string, body: string, actOff = "Connect", actOn = "Details", open = false): string {
  const head = `<span class="conn-dot${on ? " on" : ""}" role="img" aria-label="${on ? "Connected" : "Not connected"}"></span><span class="conn-t"><b>${esc(title)}</b><span>${status}</span></span>`;
  if (!body) return `<div class="conn-row" id="conn-${id}"><div class="conn-head">${head}</div></div>`;
  return `<details class="conn-row" id="conn-${id}"${open ? " open" : ""}><summary>${head}<span class="conn-act"><span class="when-closed">${esc(on ? actOn : actOff)} &rsaquo;</span><span class="when-open">Close</span></span></summary><div class="conn-body">${body}</div></details>`;
}
const copyBlock = (id: string, text: string, label = "Copy prompt for my AI") => `<pre id="${id}" style="max-height:150px">${esc(text)}</pre><button class="btn small" type="button" data-copy-text="${id}">${esc(label)}</button>`;

/** The Connections panel. GitHub first, then Obsidian, then what makes a city come alive. */
export function connectionsPanel(o: PanelOpts): string {
  const { pub, handle, conn } = o, hs = encodeURIComponent(handle);
  // GitHub
  let gh: string;
  if (conn.github.on) {
    gh = conn.hosted
      ? `<p class="mut">Your page and city are built from your public GitHub and refreshed every 6 hours.</p><form method="post" class="row"><input type="hidden" name="do" value="refresh"><button class="btn small ghost" type="submit">Refresh from GitHub now</button></form>
<p style="margin:14px 0 4px"><b>Private repos</b></p><p class="mut">Add private repos as padlocked buildings: size and activity only, never names or code. The Caldera GitHub app can only read repository metadata.</p>${o.app ? `<a class="btn small" href="https://github.com/apps/${esc(o.app.slug)}/installations/new">${o.installation ? "Change which repos" : "Add private repos"}</a>` : ""}`
      : `<p class="mut">Sign in with GitHub works on any device, and people you know from GitHub connect with you automatically.</p>`;
  } else if (conn.github.listed) {
    gh = `<p>Your page already lists <b>github.com/${esc(conn.github.listed)}</b>. Sign in with that GitHub account once to link it:</p><a class="btn small" href="/auth/github?h=${hs}">Sign in with GitHub</a>
<p class="mut" style="margin-top:8px">Linking lets you sign in with GitHub on any device, and connects you with people you know from GitHub.</p>`;
  } else {
    const line = `  - "GitHub | https://github.com/YOUR-LOGIN"`;
    gh = `<ol><li>Add your GitHub to your page's links. In your vault, open <code>Caldera/profile.md</code> and add this line under <code>links:</code> (put your GitHub username in):${copyBlock("gh-line", line, "Copy line")}
<span class="mut">Caldera republishes your page about a minute after you save. Your repos also become your city.</span></li>
<li>Then sign in with that GitHub account to link it:<br><a class="btn small" href="/auth/github?h=${hs}" style="margin-top:6px">Sign in with GitHub</a></li></ol>`;
  }
  const ghStatus = conn.github.on ? `Connected as <b>@${esc(conn.github.login)}</b>` : conn.github.listed ? "Listed on your page, not linked yet" : "Not connected";
  // Obsidian
  let ob: string;
  if (conn.obsidian.on) ob = "";
  else ob = `<p class="mut">Your vault adds a daily journal, your notes as a garden, the underground under your city, and end-to-end encrypted sharing with friends. Your page keeps its address and friends.</p><ol>
<li><b>Install Caldera in Obsidian.</b><br><a class="btn small" href="obsidian://show-plugin?id=caldera" style="margin-top:6px">Open in Obsidian</a> <a href="https://community.obsidian.md/plugins/caldera" target="_blank" rel="noopener">or find it in the plugin directory</a><br><span class="mut">No Obsidian yet? <a href="https://obsidian.md/download" target="_blank" rel="noopener">Get it free</a>, open it and create a vault.</span></li>
<li><b>Get your code.</b><br><span class="conn-code" id="claim-box"><button class="btn small" type="button" id="claim-get">Get my code</button></span><br><span class="mut" id="claim-note">The code works once, for 30 minutes.</span></li>
<li><b>Paste it in Obsidian:</b> Settings &rarr; Caldera &rarr; <b>Import a GitHub sign-up</b>. <span class="conn-wait" id="claim-wait" hidden><i></i>Waiting for Obsidian&hellip; this turns green by itself.</span></li></ol>`;
  const obStatus = conn.obsidian.on ? `Connected &middot; last updated from your vault ${esc(ago(conn.obsidian.updated))}` : "Not connected";
  // live visitors
  const snippets = o.sites.map(s => `<div style="margin:6px 0"><span class="mut">${esc(s.project)}</span><pre id="sn-${esc(s.key)}">&lt;script async src="${esc(pub)}/t.js" data-site="${esc(s.key)}"&gt;&lt;/script&gt;</pre></div>`).join("");
  const live = `<p class="mut">Put a district's snippet in a site's shared layout and every visit arrives in your city live. Call <code>caldera('signup')</code> or <code>caldera('buy')</code> to celebrate conversions.</p>${snippets || `<p class="mut">${conn.hosted ? "Refresh from GitHub once to get your snippets." : "In Obsidian: Settings &rarr; Caldera &rarr; Live traffic on your city gives each district a snippet."}</p>`}
<p style="margin:12px 0 4px"><b>Or let your AI do it</b></p>${copyBlock("pr-live", o.livePrompt)}`;
  const agents = `<p class="mut">Each AI coding agent you run becomes a drone over the repo it's working in. Paste this into Claude Code on each computer you use.</p>${copyBlock("pr-agents", o.agentPrompt, "Copy setup prompt")}`;
  const priv = o.privatePrompt ? `<p class="mut">See your page with the private sections only you can see, on any device you're signed in on.</p>${copyBlock("pr-private", o.privatePrompt)}` : "";
  const em = `<p class="mut">${conn.email ? `Going to <b>${esc(o.email || "your address")}</b>.` : "One short email on days something happens."} <a href="#notifications">${conn.email ? "Change" : "Turn it on"}</a></p>`;
  const rows = [
    row("github", conn.github.on, "GitHub", ghStatus, gh, conn.github.listed ? "Link" : "Connect", conn.hosted ? "Options" : "Details"),
    row("obsidian", conn.obsidian.on, "Obsidian", obStatus, ob, "Connect"),
    row("live", conn.live, "Live visitors on your city", conn.live ? "Visits arrived in the last 7 days" : "No visits in the last 7 days", live, "Set up", "Snippets"),
    row("agents", conn.agents, "AI agents on the map", conn.agents ? "Agents reported in the last 7 days" : "No agents in the last 7 days", agents, "Set up", "Setup"),
    ...(conn.hosted ? [] : [row("private", !!conn.private, "Private view", conn.private ? "Your private sections are up to date" : "Not turned on", priv, "Set up", "Setup")]),
    row("email", conn.email, "Daily summary email", conn.email ? "On" : "Off", em, "Turn on", "Change"),
  ];
  const script = conn.obsidian.on ? "" : `<script>(function(){var b=document.getElementById('claim-get');if(!b)return;var box=document.getElementById('claim-box'),w=document.getElementById('claim-wait'),n=document.getElementById('claim-note'),t=null;
function poll(){fetch('/settings/status',{cache:'no-store',credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.conn&&j.conn.obsidian&&j.conn.obsidian.on){clearInterval(t);location.href='/settings?connected=obsidian#connections'}}).catch(function(){})}
b.addEventListener('click',function(){b.disabled=true;b.textContent='Getting your code...';fetch('/settings/claim',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){
if(!x.ok){b.disabled=false;b.textContent='Get my code';n.textContent=x.j.error||'Could not get a code. Try again.';return}
box.innerHTML='';var c=document.createElement('code');c.id='claim-code';c.textContent=x.j.code;box.appendChild(c);var cp=document.createElement('button');cp.type='button';cp.className='btn small';cp.textContent='Copy';cp.addEventListener('click',function(){navigator.clipboard.writeText(x.j.code).then(function(){cp.textContent='Copied'},function(){})});box.appendChild(cp);
n.textContent='Works once, until '+new Date(x.j.expires).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.';w.hidden=false;if(!t)t=setInterval(poll,4000)})})})()</script>`;
  return `<div class="conn">${rows.join("")}</div>${script}`;
}

/** Tiny GitHub / Obsidian status dots for the owner bar (labels hide on phones). */
export function connDots(href: string, c: { github: boolean; obsidian: boolean }): string {
  const t = `GitHub ${c.github ? "connected" : "not connected"} · Obsidian ${c.obsidian ? "connected" : "not connected"}`;
  const d = (on: boolean) => `<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${on ? "#3FB97F" : "#5A5A66"}"></i>`;
  return `<a class="cb-conn" href="${esc(href)}" title="${esc(t)}" aria-label="${esc(t + ". Open settings")}" style="display:inline-flex;align-items:center;gap:6px;padding:0 6px;color:#B8B8C2;font-size:12px;white-space:nowrap">`
    + `<span class="cb-cl">GitHub</span>${d(c.github)}<span class="cb-cl" style="margin-left:4px">Obsidian</span>${d(c.obsidian)}</a>`;
}
