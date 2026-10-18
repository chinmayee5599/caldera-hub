// Fills the static site from single sources:
//   @caldera/core prompts  -> index.html (the one setup prompt) and guide.html (edit)
//   site/releases.json     -> changelog.html (rendered at rest) and releases.xml (RSS)
import fs from "node:fs";
import { agentPrompt, editPrompt, FEATURES, featurePrompt, upgradePrompt } from "../../caldera/packages/core/dist/index.js";

const site = new URL("../packages/site/", import.meta.url);
const HUB = "https://caldera.social";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fill = (html, marker, content) => html.replace(new RegExp(`<!-- ${marker}_START -->[\\s\\S]*?<!-- ${marker}_END -->`), `<!-- ${marker}_START -->${content}<!-- ${marker}_END -->`);
const update = (file, fn) => { const p = new URL(file, site); fs.writeFileSync(p, fn(fs.readFileSync(p, "utf8"))); };

update("index.html", h => fill(h, "AGENT_PROMPT", esc(agentPrompt({ hubUrl: HUB }))));
update("guide.html", h => fill(h, "EDIT_PROMPT", esc(editPrompt({ hubUrl: HUB }))));

// guide.html "Every feature": one section per feature in core's inventory (same source as the setup prompt), with a
// screenshot from @mike's public page where there is one, and the feature's own prompt for the owner's AI
const GROUPS = [
  ["Your page", ["masthead", "links", "now", "topics", "sidebar", "graph"]],
  ["Your story and your work", ["timeline", "projects", "code", "ai", "knows", "inbox"]],
  ["Every day", ["journal", "scoreboard", "activity", "growth"]],
  ["The live city", ["live", "agents", "weather"]],
  ["Your people", ["friends", "groups", "asks", "garden", "email"]],
  ["Only for you", ["private"]],
];
const SHOT = { journal: "journal", ai: "ai", timeline: "timeline", projects: "projects", code: "city", knows: "knows", inbox: "inbox", activity: "activity", asks: "asks", masthead: "masthead", live: "city", friends: "world" };
const PROMPT = { live: "live", agents: "agents", ai: "ai", private: "private", timeline: "story", projects: "story", code: "code", email: "email", groups: "groups" };
const seen = new Set();
const card = f => {
  const pid = PROMPT[f.id], shot = SHOT[f.id], first = pid && !seen.has(pid); if (pid) seen.add(pid);
  return `<section class="feat" id="f-${f.id}"><h3>${esc(f.label)}${f.ownerOnly ? ' <span class="feat-tag">only you</span>' : ""}</h3>
    ${shot ? `<img class="feat-shot" src="/assets/guide/${shot}.jpg" alt="${esc(f.label)} on a real Caldera page" loading="lazy" width="960">` : ""}
    <p><b>What feeds it:</b> ${esc(f.source)}</p><p><b>Turn it on:</b> ${esc(f.how)}</p>${first ? `
    <details class="feat-prompt"><summary>Prompt for your AI</summary><div class="prompt-card"><div class="prompt-bar"><div class="prompt-file"><span class="pf-dot"></span>caldera-${pid}.md</div><button class="btn copy" type="button" data-copy="fp-${pid}"><span class="copy-label">Copy prompt</span></button></div><div class="prompt-body"><pre id="fp-${pid}">${esc(featurePrompt(pid, { hubUrl: HUB }))}</pre></div></div></details>` : ""}</section>`;
};
const byId = Object.fromEntries(FEATURES.map(f => [f.id, f]));
const missing = FEATURES.filter(f => !GROUPS.some(([, ids]) => ids.includes(f.id))).map(f => f.id);
if (missing.length) throw new Error("guide groups miss features: " + missing.join(", "));
const featuresHtml = `\n  <nav class="feat-toc" aria-label="Features">${GROUPS.map(([g, ids]) => `<span><b>${esc(g)}</b> ${ids.map(id => `<a href="#f-${id}">${esc(byId[id].label.replace(/ \(.*\)$/, ""))}</a>`).join(" &middot; ")}</span>`).join("")}</nav>
  ${GROUPS.map(([g, ids]) => `<h2 class="feat-group">${esc(g)}</h2>\n  ${ids.map(id => card(byId[id])).join("\n  ")}`).join("\n  ")}
  <h2 id="upgrade">Already on Caldera? Turn on what you're missing</h2>
  <p>Paste this into your AI agent: it walks through the features most pages leave off, asks before each one, and skips the ones you say no to. In Obsidian, the <b>Unlock more</b> card in your Private view copies a version with only the features you still need, already filled in with your own site snippets and agent hook.</p>
  <div class="prompt-card"><div class="prompt-bar"><div class="prompt-file"><span class="pf-dot"></span>caldera-upgrade.md</div><button class="btn copy" type="button" data-copy="upgrade-prompt"><span class="copy-label">Copy prompt</span></button></div><div class="prompt-body is-collapsed"><pre id="upgrade-prompt">${esc(upgradePrompt(["live", "agents", "ai", "private", "story", "code", "email", "groups"], { hubUrl: HUB }))}</pre><button class="prompt-expand" type="button" aria-expanded="false">Show the full prompt</button></div></div>\n  `;
update("guide.html", h => fill(h, "FEATURES_GUIDE", featuresHtml));

const { releases } = JSON.parse(fs.readFileSync(new URL("releases.json", site), "utf8"));
const rendered = releases.map((r, i) => `
  <article class="release" id="v${esc(r.version)}">
    <div class="release-meta"><span class="tag">${esc(r.version)}</span><time datetime="${esc(r.date)}">${esc(r.date)}</time>${i === 0 ? "<span>latest</span>" : ""}</div>
    <h2>${esc(r.title)}</h2>
    <ul>${r.items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>${r.howto ? `\n    <p class="howto">${esc(r.howto)}</p>` : ""}
  </article>`).join("");
update("changelog.html", h => fill(h, "RELEASES", rendered + "\n  "));

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Caldera - what's new</title><link>${HUB}/changelog</link><description>Caldera release notes</description>
${releases.map(r => `<item><title>${esc(r.version + ": " + r.title)}</title><link>${HUB}/changelog#v${esc(r.version)}</link><guid>${HUB}/changelog#v${esc(r.version)}</guid><pubDate>${new Date(r.date + "T17:00:00Z").toUTCString()}</pubDate><description>${esc(r.items.join(" "))}</description></item>`).join("\n")}
</channel></rss>
`;
fs.writeFileSync(new URL("releases.xml", site), rss);
console.log(`site built: 3 prompts, ${releases.length} releases`);
