// Builds the search + AI-answer layer of caldera.social from scripts/seo-pages.mjs:
//   <slug>.html pages (answer-first, FAQ, JSON-LD), learn.html, sitemap.xml, robots.txt, llms.txt, llms-full.txt,
//   canonical/og tags on every page, and SoftwareApplication/Organization/FAQPage JSON-LD on the homepage.
import fs from "node:fs";
import { pages, UPDATED } from "./seo-pages.mjs";
import { activeFeatures } from "../../caldera/packages/core/dist/index.js";
const FEATURES = activeFeatures();   // the garden is paused (core flags.ts): nothing switched off reaches the site

const SITE = "https://caldera.social";
const dir = new URL("../packages/site/", import.meta.url);
const read = f => fs.readFileSync(new URL(f, dir), "utf8");
const write = (f, s) => fs.writeFileSync(new URL(f, dir), s);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = h => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const VERSION = (() => { try { const r = JSON.parse(fs.readFileSync(new URL("../packages/site/releases.json", import.meta.url), "utf8")); return String((r.releases || r)[0]?.version || "0.18"); } catch { return "0.18"; } })();
const ld = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const ORG = { "@type": "Organization", "@id": `${SITE}/#org`, name: "mjonesone, LLC", url: SITE, email: "hello@caldera.social" };

// shared chrome from guide.html (head up to </head>, the header, the footer)
const guide = read("guide.html");
const headTpl = guide.slice(0, guide.indexOf("</head>"))    // inherited per-page tags must not leak into other pages
  .replace(/<link rel="canonical"[^>]*>\s*/g, "").replace(/<meta (property|name)="(og|twitter):[^>]*>\s*/g, "")
  .replace(/<meta name="robots"[^>]*>\s*/g, "").replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/g, "");
const header = guide.slice(guide.indexOf('<header class="nav">'), guide.indexOf("</header>") + 9).replace(/ aria-current="page"/g, "");
// idempotent: drop any Learn links left by earlier builds before adding exactly one (it used to stack one per rebuild)
const noLearn = h => h.replace(/(<a href="\/learn">Learn<\/a> &middot; )+/g, "");
let footer = "";   // set below, once the page list is known

// THE footer: every Learn page by topic, so search engines and AI crawlers reach all of them from any page.
// Written to assets/footer.html too: the hub serves it on its own pages (feed, people, world, settings...).
const topic = p => /obsidian/.test(p.slug) ? "Obsidian" : /github|readme|contribution|skyline/.test(p.slug) ? "GitHub" : /\bai\b|ai-|claude|agent|vibe|token|llm/.test(p.slug) ? "AI builders" : "Developers";
const TOPICS = ["GitHub", "AI builders", "Developers", "Obsidian"];
const col = (h, links) => `<div class="fcol"><b>${esc(h)}</b>${links.map(([u, t]) => `<a href="${u}">${esc(t)}</a>`).join("")}</div>`;
const short = p => { const t = (p.nav || p.h1).replace(/^How to /i, "").replace(/\?$/, ""); return t.charAt(0).toUpperCase() + t.slice(1); };
const bigFooter = `<footer class="footer footer-big"><div class="fgrid">${col("Caldera", [["/", "Home"], ["/feed", "Feed"], ["/people", "People"], ["/world", "World map"], ["/gh", "See any GitHub as a city"], ["/guide", "Guide"], ["/learn", "Learn"], ["/changelog", "What's new"]])}${TOPICS.map(t => col(t, pages.filter(p => topic(p) === t).map(p => [`/${p.slug}`, short(p)]))).join("")}</div><div class="fbase"><span>&copy; 2026 mjonesone, LLC</span><span><a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot; <a href="mailto:hello@caldera.social">hello@caldera.social</a></span></div></footer>`;
write("assets/footer.html", bigFooter + "\n");
footer = bigFooter;
// every static page gets the same footer (index, guide, people, changelog, privacy, terms...)
for (const f of fs.readdirSync(dir)) if (f.endsWith(".html")) { const h = read(f), n = h.replace(/<footer class="footer[^"]*">[\s\S]*?<\/footer>/, () => bigFooter); if (n !== h) write(f, n); }

function head(title, description, slug, extra = "") {
  const url = slug ? `${SITE}/${slug}` : `${SITE}/`;
  return headTpl.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    + `<link rel="canonical" href="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${url}"><meta property="og:type" content="article"><meta property="og:image" content="${SITE}/og.jpg"><meta name="twitter:card" content="summary_large_image"><meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">${extra}\n</head>`;
}

const bySlug = Object.fromEntries(pages.map(p => [p.slug, p]));
for (const p of pages) {
  const url = `${SITE}/${p.slug}`;
  const graph = { "@context": "https://schema.org", "@graph": [
    { "@type": "TechArticle", headline: p.h1, description: p.description, url, dateModified: UPDATED, datePublished: "2026-10-11", author: { "@id": `${SITE}/#org` }, publisher: { "@id": `${SITE}/#org` }, about: { "@type": "SoftwareApplication", name: "Caldera", url: SITE }, image: `${SITE}/og.jpg` },
    { "@type": "FAQPage", mainEntity: p.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Caldera", item: `${SITE}/` }, { "@type": "ListItem", position: 2, name: "Learn", item: `${SITE}/learn` }, { "@type": "ListItem", position: 3, name: p.h1, item: url }] },
    ORG ] };
  const body = `<main class="legal guide learn-page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Caldera</a> / <a href="/learn">Learn</a></nav>
  <h1>${esc(p.h1)}</h1>
  <p class="answer">${esc(p.answer)}</p>
  <p class="fine">Updated ${UPDATED} &middot; by mjonesone, LLC</p>
${p.sections.map(s => `  <h2>${esc(s.h2)}</h2>\n  ${s.html}`).join("\n")}
  <div class="cta-box"><b>Try it free.</b> Sign up with GitHub in about 30 seconds, or install Caldera in Obsidian. <a class="btn small" href="/auth/github">Sign up with GitHub</a> <a class="btn small ghost" href="/#obsidian">Install for Obsidian</a></div>
  <h2>Questions</h2>
  <div class="faq-list">${p.faq.map(([q, a]) => `<details open><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
  <h2>Related</h2>
  <ul>${p.related.map(r => `<li><a href="/${r}">${esc(bySlug[r].h1)}</a></li>`).join("")}</ul>
</main>`;
  write(`${p.slug}.html`, `${head(p.title, p.description, p.slug, ld(graph))}\n<body>\n${header}\n${body}\n${footer}\n<script src="assets/site.js"></script>\n</body>\n</html>\n`);
}

// /learn index
write("learn.html", `${head("Learn Caldera: GitHub cities, Obsidian profiles, sharing and AI agents", "Guides to GitHub cities, Obsidian public profiles, private note sharing, AI agents, daily journals, activity tracking and Obsidian Publish alternatives.", "learn", ld({ "@context": "https://schema.org", "@type": "CollectionPage", name: "Learn Caldera", url: `${SITE}/learn`, hasPart: pages.map(p => ({ "@type": "TechArticle", headline: p.h1, url: `${SITE}/${p.slug}` })) }))}
<body>
${header}
<main class="legal guide learn-page">
  <p class="eyebrow">Learn</p>
  <h1>GitHub cities, Obsidian profiles, sharing and AI agents</h1>
  <p class="lead-in">Short, practical answers about turning your GitHub into a living city, your Obsidian vault into a living profile, sharing notes privately, and letting AI agents help.</p>
  <div class="learn-list">${pages.map(p => `<a class="learn-item" href="/${p.slug}"><b>${esc(p.h1)}</b><span>${esc(p.description)}</span></a>`).join("")}</div>
</main>
${footer}
<script src="assets/site.js"></script>
</body>
</html>
`);

// canonical + og on existing pages; homepage JSON-LD
const core = [["index.html", ""], ["people.html", "people"], ["guide.html", "guide"], ["changelog.html", "changelog"], ["privacy.html", "privacy"], ["terms.html", "terms"]];
for (const [f, slug] of core) {
  let s = noLearn(read(f).replace(/<link rel="canonical"[^>]*>/g, ""));
  s = s.replace("</head>", `<link rel="canonical" href="${SITE}/${slug}">\n</head>`);
  s = s.replace(/<a href="guide\.html">Guide<\/a> &middot; <a href="changelog\.html">/, '<a href="/learn">Learn</a> &middot; <a href="/guide">Guide</a> &middot; <a href="/changelog">');
  if (f === "index.html") {
    const faq = [...s.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(m => ({ "@type": "Question", name: strip(m[1]), acceptedAnswer: { "@type": "Answer", text: strip(m[2]) } }));
    const app = { "@context": "https://schema.org", "@graph": [
      { "@type": "SoftwareApplication", name: "Caldera", applicationCategory: "SocialNetworkingApplication", operatingSystem: "Web (sign up with GitHub); Windows, macOS, Linux, iOS, Android (Obsidian plugin)", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, url: SITE, downloadUrl: `${SITE}/download/caldera-latest.zip`, softwareVersion: VERSION, license: "https://opensource.org/licenses/MIT", codeRepository: "https://github.com/schoettle-cmd/caldera", description: "Caldera is the social network for GitHub and Obsidian. Sign up with GitHub and your repos become a living city; install it in Obsidian and your vault becomes a living profile. Friends, groups, end-to-end encrypted shared notes, asks, offers and gravity. Free, open source and private by default.", publisher: { "@id": `${SITE}/#org` }, image: `${SITE}/og.jpg` },
      { "@type": "WebSite", name: "Caldera", url: SITE, publisher: { "@id": `${SITE}/#org` } },
      { "@type": "FAQPage", mainEntity: faq }, ORG ] };
    s = s.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "").replace("</head>", `${ld(app)}\n</head>`);
    if (!s.includes('href="/learn"')) s = s.replace('<span><a href="PROTOCOL.md">', '<span><a href="/learn">Learn</a> &middot; <a href="PROTOCOL.md">');
  }
  write(f, s.replace(/\n{3,}/g, "\n\n"));   // each build used to add blank lines before </head>
}

// sitemap, robots, llms
const urls = [["", "weekly", "1.0"], ["learn", "weekly", "0.9"], ...pages.map(p => [p.slug, "monthly", "0.8"]), ["people", "daily", "0.7"], ["feed", "hourly", "0.7"], ["guide", "monthly", "0.7"], ["changelog", "weekly", "0.6"], ["privacy", "yearly", "0.3"], ["terms", "yearly", "0.3"]];
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, f, pr]) => `  <url><loc>${SITE}/${u}</loc><lastmod>${UPDATED}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join("\n")}\n</urlset>\n`);
const bots = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "anthropic-ai", "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "Applebot", "Applebot-Extended", "DuckAssistBot", "Meta-ExternalAgent", "MistralAI-User", "CCBot"];
write("robots.txt", `# caldera.social - search engines and AI assistants are welcome to read and cite the public site.\n# Profile pages carry noindex (owners' choice); the API is not for crawling.\n${bots.map(b => `User-agent: ${b}\nAllow: /\nDisallow: /v1/\nDisallow: /auth/\nDisallow: /signin\nDisallow: /messages\n`).join("\n")}\nUser-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /auth/\nDisallow: /signin\nDisallow: /messages\n\nSitemap: ${SITE}/sitemap.xml\nSitemap: ${SITE}/sitemap-profiles.xml\n`);
write("llms.txt", `# Caldera

> Caldera is the social network for GitHub and Obsidian: free, open source and built on an open protocol. Sign up with GitHub and your repos become a living city (districts are projects, buildings are repos, live visitors and AI agents move through it). Install the Obsidian plugin and your vault becomes a living public profile that updates itself. Members add friends, join groups, share end-to-end encrypted notes, post asks and offers for help, and give positive-only gravity. Private by default. Made by mjonesone, LLC.

- Sign up with GitHub (no install): ${SITE}/auth/github
- Install for Obsidian: Obsidian community plugins (search Caldera), or copy one prompt into Claude Code, Codex or Cursor: ${SITE}/#install
- Example city: ${SITE}/@mike/city.html
- Example profile: ${SITE}/@mike/
- Directory of people: ${SITE}/people
- Member profiles and cities (indexable ones): ${SITE}/sitemap-profiles.xml
- See any public GitHub account as a city: ${SITE}/gh/<github-username>
- Source (MIT plugin, AGPL hub): https://github.com/schoettle-cmd/caldera

## Guides
${pages.map(p => `- [${p.h1}](${SITE}/${p.slug}): ${p.description}`).join("\n")}

## Every feature, and how to turn it on (for AI agents setting up a member's page)
The full setup prompt (safe to paste again; it covers everything below and asks the owner before anything goes public): ${SITE}/#install . Per-feature prompts: ${SITE}/guide . Never read or edit .obsidian/plugins/caldera/data.json (the owner's private key).
${FEATURES.map(f => `- ${f.label}${f.ownerOnly ? " (only the owner sees it)" : ""}: fed by ${f.source}. ${f.how}`).join("\n")}

## Reference
- [Guide: every feature, change your page, commands, keys](${SITE}/guide)
- [Release notes](${SITE}/changelog)
- [Protocol spec](${SITE}/PROTOCOL.md)
- [Privacy policy](${SITE}/privacy)
- [Full text for language models](${SITE}/llms-full.txt)
`);
write("llms-full.txt", `# Caldera - full text\n\n${pages.map(p => `## ${p.h1}\nURL: ${SITE}/${p.slug}\n\n${p.answer}\n\n${p.sections.map(s => `### ${s.h2}\n${strip(s.html)}`).join("\n\n")}\n\n### Questions\n${p.faq.map(([q, a]) => `Q: ${q}\nA: ${a}`).join("\n")}\n`).join("\n")}`);
console.log(`seo built: ${pages.length} pages + learn, sitemap (${urls.length} urls), robots, llms.txt`);
