/**
 * Shareable pictures of a profile: the link-preview card (og:image) and the city tiles on group pages.
 *
 * A profile's city preview is an SVG the plugin drew into the owner's index.html. That file is user-uploaded, so it is
 * never copied as-is: only <polygon> shapes are read back, and each one is rebuilt from a checked fill and point list.
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// the city preview's CSS classes, as plain fills (resvg and inline use don't get the page's <style>)
const CLASS_FILL: Record<string, string> = {
  "cp-pad": `fill="#7896D2" fill-opacity=".10" stroke="#8CAAE6" stroke-opacity=".22" stroke-width="1"`,
  "cp-w": `fill="#0A101E" fill-opacity=".55"`,
  "cp-on": `fill="#FFD98A"`,
  "cp-cool": `fill="#BFD8FF"`,
};

export interface CityArt { viewBox: string; shapes: string; buildings: number }

/** The city preview drawn into a hosted index.html, rebuilt from its polygons only. Null when the page has no city. */
export function cityArt(html: string): CityArt | null {
  const a = html.indexOf('class="city-peek"'); if (a < 0) return null;
  const s0 = html.indexOf("<svg", a), s1 = html.indexOf("</svg>", s0); if (s0 < 0 || s1 < 0) return null;
  const svg = html.slice(s0, s1);
  const vb = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/); if (!vb) return null;
  const out: string[] = []; let tops = 0;
  for (const m of svg.matchAll(/<polygon\s+(class|fill)="([^"]{1,60})"\s+points="([-\d., ]{1,2000})"\s*\/?>/g)) {
    let paint: string;
    if (m[1] === "fill") {
      if (!/^(#[0-9a-fA-F]{3,8}|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/.test(m[2])) continue;
      paint = `fill="${m[2]}"`;
    } else {
      const cls = m[2].split(/\s+/);
      paint = cls.includes("cp-cool") ? CLASS_FILL["cp-cool"] : cls.some(c => /^cp-on\d$/.test(c)) ? CLASS_FILL["cp-on"] : CLASS_FILL[cls[0]] || "";
      if (!paint) continue;
    }
    out.push(`<polygon ${paint} points="${m[3]}"/>`);
    if (m[1] === "fill") tops++;
  }
  if (!out.length) return null;
  return { viewBox: `${vb[1]} ${vb[2]} ${vb[3]} ${vb[4]}`, shapes: out.join(""), buildings: Math.round(tops / 3) };
}

const LOGO = (x: number, y: number, s: number) => `<g transform="translate(${x} ${y}) scale(${s / 32})"><path d="M3 26 L11 10 L14 15 L17 8 L29 26 Z" fill="#8B6CF6"/><path d="M11 10 L14 15 L17 8" fill="none" stroke="#F2F2F5" stroke-width="1.2"/><circle cx="16" cy="21" r="2.4" fill="#4FB89A"/></g>`;

/** Cut a string to about `max` characters on a word boundary, with an ellipsis. */
const clip = (s: string, max: number) => s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "...";

/** Deterministic star field so the same profile always gets the same sky. */
function stars(seed: string, w: number, h: number, n: number) {
  let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const r = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, () => `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * h).toFixed(1)}" r="${(0.5 + r() * 1.1).toFixed(2)}" fill="#DCE6FF" fill-opacity="${(0.25 + r() * 0.55).toFixed(2)}"/>`).join("");
}

/** The 1200x630 link-preview card, as SVG (rendered to PNG by the hub). */
export function cardSvg(o: { handle: string; name: string; headline: string; host: string; city: CityArt | null }): string {
  const W = 1200, H = 630, name = clip(o.name || "@" + o.handle, 30), head = clip(o.headline || "", 72);
  const serif = `'DejaVu Serif','Liberation Serif',Georgia,serif`, sans = `'DejaVu Sans','Liberation Sans',Arial,sans-serif`;
  const initials = (o.name || o.handle).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "C";
  // a small city shouldn't be blown up to fill the card: never zoom in more than about 1.6x
  const vb = (() => { if (!o.city) return ""; const [x, y, w, h] = o.city.viewBox.split(" ").map(Number) as [number, number, number, number];
    const W2 = Math.max(w, 1080 / 1.6), H2 = Math.max(h, 410 / 1.6); return `${(x - (W2 - w) / 2).toFixed(1)} ${(y - (H2 - h) * 0.7).toFixed(1)} ${W2.toFixed(1)} ${H2.toFixed(1)}`; })();
  const art = o.city
    ? `<svg x="60" y="34" width="1080" height="410" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${o.city.shapes}</svg>`
    : `<circle cx="600" cy="230" r="120" fill="#8B6CF6" fill-opacity=".9"/><text x="600" y="262" text-anchor="middle" font-family="${serif}" font-size="96" font-weight="700" fill="#F7F7FA">${esc(initials)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="sky" cx="50%" cy="115%" r="95%"><stop offset="0" stop-color="#1D2B4A"/><stop offset=".6" stop-color="#0C1222"/><stop offset="1" stop-color="#080B14"/></radialGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#060912" stop-opacity="0"/><stop offset="1" stop-color="#060912" stop-opacity=".94"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars(o.handle, W, 300, 70)}${art}
<rect y="400" width="${W}" height="230" fill="url(#fade)"/>
<text x="64" y="520" font-family="${serif}" font-size="62" font-weight="700" fill="#F7F7FA">${esc(name)}</text>
${head ? `<text x="66" y="566" font-family="${sans}" font-size="24" fill="#C9D3E6">${esc(head)}</text>` : ""}
<text x="66" y="606" font-family="${sans}" font-size="22" fill="#9CC4FF">${esc(o.host)}/@${esc(o.handle)}${o.city?.buildings ? `  &#183;  ${o.city.buildings} building${o.city.buildings === 1 ? "" : "s"} in their city` : ""}</text>
${LOGO(1062, 538, 44)}<text x="1110" y="606" text-anchor="end" font-family="${serif}" font-size="22" font-weight="700" fill="#F2F2F5">Caldera</text>
</svg>`;
}

/** word-wrap for SVG text (no measuring available): about `width` characters per line, at most `max` lines */
function wrap(text: string, width: number, max: number): string[] {
  const out: string[] = []; let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if ((line + " " + w).trim().length > width) { if (line) out.push(line); line = w.length > width ? w.slice(0, width - 1) + "-" : w; if (out.length === max) break; }
    else line = (line + " " + w).trim();
  }
  if (out.length < max && line) out.push(line);
  if (out.length === max && text.length > out.join(" ").length + 1) out[max - 1] = clip(out[max - 1]!, width - 3).replace(/\.\.\.$/, "") + "...";
  return out.slice(0, max);
}
/** The share image for a feed post: text only (author + the post as a sentence + its specifics), Caldera styling, no user images. */
export function postCardSvg(o: { handle: string; name: string; sentence: string; detail: string; host: string }): string {
  const W = 1200, H = 630, serif = `'DejaVu Serif','Liberation Serif',Georgia,serif`, sans = `'DejaVu Sans','Liberation Sans',Arial,sans-serif`;
  const lines = wrap(`${o.name || "@" + o.handle} ${o.sentence}`, 38, 4), det = wrap(o.detail || "", 70, 2);
  const y0 = 150 + (4 - lines.length) * 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="sky" cx="50%" cy="115%" r="95%"><stop offset="0" stop-color="#1D2B4A"/><stop offset=".6" stop-color="#0C1222"/><stop offset="1" stop-color="#080B14"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars(o.handle + o.sentence, W, 260, 40)}
<text x="64" y="92" font-family="${sans}" font-size="24" fill="#9CC4FF">On Caldera, @${esc(o.handle)}</text>
${lines.map((l, i) => `<text x="64" y="${y0 + i * 66}" font-family="${serif}" font-size="54" font-weight="700" fill="#F7F7FA">${esc(l)}</text>`).join("\n")}
${det.map((l, i) => `<text x="66" y="${y0 + lines.length * 66 + 18 + i * 34}" font-family="${sans}" font-size="25" fill="#C9D3E6">${esc(l)}</text>`).join("\n")}
<text x="66" y="598" font-family="${sans}" font-size="22" fill="#9CC4FF">${esc(o.host)}/feed</text>
${LOGO(1062, 538, 44)}<text x="1110" y="606" text-anchor="end" font-family="${serif}" font-size="22" font-weight="700" fill="#F2F2F5">Caldera</text>
</svg>`;
}

let resvg: any;
/** SVG -> PNG with resvg (loaded on first use; optional dependency on the server). */
export async function toPng(svg: string): Promise<Buffer> {
  resvg ||= await import("@resvg/resvg-js");
  const r = new resvg.Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } });
  return Buffer.from(r.render().asPng());
}

/** Inline city tile for a group page (cleaned shapes only). */
export const cityTile = (c: CityArt | null) => c
  ? `<svg viewBox="${c.viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${c.shapes}</svg>`
  : `<div class="nocity">No city yet</div>`;

/** caldera.social/g/<slug>: everyone in a group, each as their city. */
export function groupPage(o: { slug: string; hub: string; members: { handle: string; name: string; headline: string; city: CityArt | null }[] }): string {
  const n = o.members.length, hub = o.hub.replace(/\/$/, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.slug)} on Caldera</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${esc(o.slug)} on Caldera: ${n} ${n === 1 ? "city" : "cities"}"><meta property="og:description" content="Everyone in ${esc(o.slug)}, each as a city built from their work. Join with Obsidian or GitHub.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>:root{--bg:#0B0F1A;--raised:#121827;--line:#253049;--text:#E3E8F2;--muted:#8E98AD;--strong:#F7F9FD;--accent:#8B6CF6;--accent-text:#B9A6FF;--go:#9CC4FF}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 'IBM Plex Sans',system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}a{color:var(--go);text-decoration:none}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:26px}.top a.home{color:var(--strong);font:600 17px 'Source Serif 4',Georgia,serif}
h1{font:600 clamp(1.7rem,4vw,2.4rem)/1.15 'Source Serif 4',Georgia,serif;color:var(--strong);margin:0 0 6px;text-wrap:balance}p.lede{color:var(--muted);margin:0 0 18px;max-width:64ch}
.join{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--raised);margin-bottom:24px}
.join span{flex:1 1 260px;color:var(--muted);font-size:14px}.btn{display:inline-flex;align-items:center;min-height:38px;padding:0 16px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;white-space:nowrap}
.btn.alt{background:transparent;border:1px solid var(--line);color:var(--text)}
.town{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.lot{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:radial-gradient(ellipse at 50% 120%,#1d2b4a 0%,#0c1222 60%,#080b14 100%);color:var(--text)}
.lot:hover{border-color:var(--go)}.lot a{color:inherit;text-decoration:none}.lot a.who:hover b{text-decoration:underline}.lot svg{display:block;width:100%;height:170px;padding:10px}.nocity{height:170px;display:grid;place-items:center;color:var(--muted);font-size:13px}
.lot .who{padding:10px 14px 12px;background:rgba(6,9,18,.75)}.lot b{display:block;color:var(--strong);font:600 1.05rem 'Source Serif 4',Georgia,serif}.lot small{display:block;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:12px;padding:28px;text-align:center}</style></head><body><main>
<div class="top"><a class="home" href="${esc(hub)}/">Caldera</a><a href="${esc(hub)}/people">People</a></div>
<h1>${esc(o.slug)}</h1>
<p class="lede">${n ? `${n} ${n === 1 ? "member" : "members"}, each shown as a city: every building is a project or a folder of notes, lit up when it was worked on this week.` : "Nobody has joined this group yet. Be the first: your city appears here as soon as you join."}</p>
<div class="join"><span>Join ${esc(o.slug)}: your page and city show up here, and the people in the group are suggested to you as friends.</span>
<a class="btn" href="${esc(hub)}/auth/github?group=${encodeURIComponent(o.slug)}">Join with GitHub</a><a class="btn alt" href="obsidian://caldera?group=${encodeURIComponent(o.slug)}">Join from Obsidian</a><a class="btn alt" href="${esc(hub)}/?group=${encodeURIComponent(o.slug)}#install">Get Caldera</a></div>
${n ? `<div class="town">${o.members.map(m => `<div class="lot">${m.city ? `<a class="lot-city" href="${esc(hub)}/@${esc(m.handle)}/city.html" title="Walk ${esc(m.name || "@" + m.handle)}'s city">${cityTile(m.city)}</a>` : cityTile(m.city)}<a class="who" href="${esc(hub)}/@${esc(m.handle)}/"><b>${esc(m.name || "@" + m.handle)}</b><small>@${esc(m.handle)}${m.headline ? ` &middot; ${esc(m.headline)}` : ""}</small></a></div>`).join("")}</div>` : `<div class="empty">No members yet.</div>`}
</main></body></html>`;
}

/** Link-preview tags for a hosted profile page (placed before </head>; replaces nothing the plugin wrote). */
export function ogTags(o: { url: string; image: string; title: string; description: string }): string {
  return `<meta property="og:type" content="profile"><meta property="og:url" content="${esc(o.url)}"><meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.description)}">`
    + `<meta property="og:image" content="${esc(o.image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:site_name" content="Caldera">`
    + `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(o.title)}"><meta name="twitter:description" content="${esc(o.description)}"><meta name="twitter:image" content="${esc(o.image)}">`;
}
