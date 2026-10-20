/**
 * "Power up your map": one prompt anyone can hand to their AI to turn on everything that makes a Caldera map come alive
 * (agent drones, live visitors, private repos as padlocked buildings). Shown under the World map and as a small
 * expandable pill on city pages. It carries no keys: it tells the AI where the member's own keys live (Settings).
 */
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function mapPrompt(hubUrl: string, handle = ""): string {
  const hub = hubUrl.replace(/\/$/, ""), page = handle ? `${hub}/@${handle}/` : `${hub}/@<my handle>/`, settings = `${hub}/settings`;
  return `Power up my Caldera map. My page: ${page} (if I don't have a Caldera page yet, help me make one first: ${hub}/#install).

Caldera turns my work into a living city on a shared world map (${hub}/world). Help me turn on everything that makes it come alive. Go in order, and ask me before anything that touches production or my keys.

1. My AI agents as drones over my repos
Each coding agent I run (Claude Code, Codex and others) flies as a drone over the repo it's working in. Only a state and a short task title are sent, never code, prompts or file contents; private repos stay padlocked.
- Ask me to open ${settings} -> "AI agents on the map" -> Copy setup prompt, and paste it here. It holds my personal agent key and secret: keep them out of every repo, commit and log.
- Follow that prompt exactly. It installs ~/.caldera/agent-hook.mjs, writes ~/.caldera/agent.json (chmod 600) and adds hooks to ~/.claude/settings.json, keeping any hooks already there. Repeat on each computer I code on.

2. Live visitors from my websites
Every visit to my sites arrives in the matching district of my city in real time, and signups and purchases get a celebration. Counts only: no cookies, no IP addresses, no personal data.
- Ask me to open ${settings} -> "Live visitors on your city" and paste the snippet lines here (one per district/project), like <script async src="${hub}/t/1.js" integrity="sha384-..." crossorigin="anonymous" data-site="KEY"></script>. Use each line exactly as given, integrity included.
- For each website I run, find its repo on this computer and the district it belongs to (ask me if unsure), and add that district's line to the site's shared layout so every page has it (the root layout, _app/_document, or base template).
- Mark conversions where they happen: call caldera('signup') after a signup and caldera('buy') after a purchase, guarded with if (window.caldera).
- Deploy each site the way it's normally deployed (ask me first if it goes to production).

3. All my real work as buildings
- GitHub: my public repos build the city by themselves. To add private repos as padlocked buildings (no names, no code), install the Caldera GitHub app on the repos I choose from ${settings}, then pick how they show under Private repos.
- Obsidian (optional): the Caldera plugin adds a daily journal, AI usage and more to my page and city.

4. Check it worked
Open my city (${page}city.html) and the world map. Visit one of my sites: I should land in my city within a minute. Start an agent task: a drone should appear over that repo.

Rules: never put keys or secrets in a repo, commit or log. Show me each change before you make it. Don't add any other tracking or analytics.`;
}

const CSS = `.mp{box-sizing:border-box;margin:18px 0 0;border:1px solid #2E2A40;border-radius:14px;background:#17151F;color:#DADADF;font:400 14px/1.5 'IBM Plex Sans',Arial,sans-serif;text-align:left}
.mp *{box-sizing:border-box}.mp>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;min-height:56px}.mp>summary::-webkit-details-marker{display:none}
.mp-ic{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#2A2440;color:#B9A6FF;font-size:18px}
.mp-t{flex:1;min-width:0;display:flex;flex-direction:column}.mp-t b{color:#F2F2F5;font-weight:600;font-size:15px}.mp-t span{color:#8A8A93;font-size:13px}
.mp-chev{flex:none;color:#8A8A93;transition:transform .15s}.mp[open] .mp-chev{transform:rotate(180deg)}
.mp-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:10px}.mp-list{margin:0;padding-left:18px;color:#B8B8C2;font-size:13.5px}.mp-list li{margin:2px 0}
.mp pre{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;font:12.5px/1.5 'IBM Plex Mono',ui-monospace,monospace;color:#CFCFD6;background:#0F0E14;border:1px solid #2A2A2E;border-radius:10px;padding:12px}
.mp-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.mp-copy{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:40px;padding:0 18px;border-radius:999px;background:#7A58F0;color:#fff;font-weight:600;font-size:14px}.mp-copy:hover{filter:brightness(1.08)}
.mp-copy:focus-visible,.mp>summary:focus-visible{outline:2px solid #B9A6FF;outline-offset:2px}.mp-note{color:#8A8A93;font-size:12.5px}.mp-note a{color:#B9A6FF}
.mp-float{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:65;margin:0;width:auto;max-width:min(560px,calc(100vw - 24px));box-shadow:0 12px 32px rgba(0,0,0,.45)}
.mp-float:not([open])>summary{min-height:44px;padding:6px 14px 6px 8px}.mp-float:not([open]) .mp-t span{display:none}.mp-float:not([open]) .mp-ic{width:30px;height:30px;font-size:15px}
.mp-float[open]{width:min(560px,calc(100vw - 24px))}.mp-float[open] pre{max-height:min(38vh,320px)}
@media (max-width:760px){.mp-float{bottom:calc(76px + env(safe-area-inset-bottom,0px))}}`;

const JS = `(function(){document.querySelectorAll('.mp').forEach(function(d){if(d.dataset.w)return;d.dataset.w='1';var b=d.querySelector('.mp-copy'),pre=d.querySelector('pre'),note=d.querySelector('.mp-done');
function sel(){var r=document.createRange();r.selectNodeContents(pre);var s=getSelection();s.removeAllRanges();s.addRange(r)}
function ok(m){if(note){note.textContent=m;note.hidden=false}b.textContent='Copied';setTimeout(function(){b.textContent='Copy prompt'},2200)}
b.addEventListener('click',function(){var t=pre.textContent;try{navigator.clipboard.writeText(t).then(function(){ok('Copied. Paste it into Claude, ChatGPT or your coding agent.')},function(){sel();ok('Selected: press Cmd+C (or Ctrl+C) to copy.')})}catch(e){sel();ok('Selected: press Cmd+C (or Ctrl+C) to copy.')}})})})();`;

/** The panel. `floating`: a small pill pinned to the bottom of a full-screen city page that expands in place. */
export function mapPanel(hubUrl: string, o: { floating?: boolean; handle?: string } = {}): string {
  const hub = hubUrl.replace(/\/$/, "");
  return `<style>${CSS}</style><details class="mp${o.floating ? " mp-float" : ""}" id="power-up"><summary><span class="mp-ic" aria-hidden="true">&#10022;</span><span class="mp-t"><b>Power up ${o.floating ? "this" : "your"} map</b><span>One prompt for your AI: drones, live visitors, private repos</span></span><svg class="mp-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>`
    + `<div class="mp-body"><ul class="mp-list"><li><b>Drones:</b> your AI coding agents fly over the repos they're working in.</li><li><b>Live visitors:</b> visits to your sites arrive in your city, with signup and sale celebrations.</li><li><b>Real work:</b> private repos as padlocked buildings, never names or code.</li></ul>`
    + `<pre>${esc(mapPrompt(hub, o.handle))}</pre><div class="mp-row"><button type="button" class="mp-copy">Copy prompt</button><span class="mp-note">Paste it into Claude, ChatGPT or your coding agent. Your keys stay in <a href="${esc(hub)}/settings" target="_blank" rel="noopener">Settings</a>, never in the prompt.</span></div><p class="mp-note mp-done" role="status" hidden></p></div></details><script>${JS}</script>`;
}
