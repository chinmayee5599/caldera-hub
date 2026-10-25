/**
 * Search titles and descriptions for indexable member pages (profile and GitHub city). Built only from what the page
 * itself shows: display name, handle, headline, the visible "Building" tags and the public repo count of the city.
 * Titles stay within ~60 characters (search results cut the rest) and keep the handle, which makes each one unique;
 * descriptions stay within ~160, cut at a word boundary.
 */
const BRAND = " | Caldera", TITLE_MAX = 60, DESC_MAX = 160;
const STOP = /\s+(?:a|an|the|and|or|of|to|for|with|by|in|on|at|what|so|that|per|my|your|their|&)$/i;
const clean = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
const trimEnd = (t: string) => { let w = t, was; do { was = w; w = w.replace(/[\s,;:(–—|/-]+$/, "").replace(STOP, ""); } while (w !== was); return w; };
/** t cut to at most n characters at a word boundary, without a dangling "and"/"of"; "" if too little is left */
function fit(t: string, n: number): string {
  if (t.length <= n) return t;
  const w = trimEnd(t.slice(0, n + 1).replace(/\s+\S*$/, ""));
  return w.length >= 8 ? w : "";
}
const firstSentence = (t: string) => t.split(/(?<=[.!?])\s/)[0].replace(/[.!?\s]+$/, "");
const period = (t: string) => /[.!?…]$/.test(t) ? t : t + ".";

export interface ProfileMetaIn { handle: string; name?: string | null; headline?: string | null; tags?: string[]; repos?: number; city?: boolean }

export function profileMeta(o: ProfileMetaIn): { title: string; desc: string } {
  const h = o.handle, nm = clean(o.name), hl = clean(o.headline);
  const named = !!nm && !/^untitled$/i.test(nm) && nm.replace(/^@/, "") !== h;   // "Cody" for @cody still shows the name
  const who = named ? `${nm} (@${h})` : `@${h}`, repos = o.repos || 0, tags = (o.tags || []).filter(Boolean);
  let title: string;
  if (o.city) {
    const full = named ? `${nm}'s GitHub city (@${h})` : `@${h}'s GitHub city`;
    title = (full.length + BRAND.length <= TITLE_MAX ? full : fit(`@${h}'s GitHub city`, TITLE_MAX - BRAND.length) || `@${h}`) + BRAND;
  } else {
    const lead = who.length + BRAND.length <= TITLE_MAX - 12 ? who : `@${h}`;
    const room = TITLE_MAX - lead.length - BRAND.length - 3, part = hl && room >= 8 ? fit(firstSentence(hl), room) : "";
    title = (lead.length + BRAND.length <= TITLE_MAX ? lead : fit(lead, TITLE_MAX - BRAND.length) || h.slice(0, TITLE_MAX - BRAND.length)) + (part ? ` - ${part}` : "") + BRAND;
  }
  const n = `${repos} repo${repos === 1 ? "" : "s"}`, short = hl ? firstSentence(hl) : "";
  const building = tags.length ? `Building: ${tags.slice(0, 5).join(", ")}.` : "";
  // each part: the full version first, then a shorter one (the headline's first sentence) if the full one doesn't fit
  const parts: string[][] = o.city
    ? [[`${who} on Caldera: GitHub as a living city${repos ? ` of ${n}` : ""}.`], hl ? [period(hl), period(short)] : [], [building]]
    : [hl ? [period(`${who}: ${hl}`), period(`${who}: ${short}`)] : [`${who} on Caldera.`], [building], [repos ? `GitHub city of ${n}.` : ""]];
  const tail = o.city ? ["Districts are projects, buildings are repos."]
    : hl ? ["Profile and projects on Caldera, the social network for GitHub and Obsidian.", "Profile and projects on Caldera."] : ["Caldera is the social network for GitHub and Obsidian."];
  let desc = "";
  for (const alts of parts) {
    const p = alts.filter(Boolean).find(x => (desc ? desc.length + 1 : 0) + x.length <= DESC_MAX);
    if (p) desc = desc ? `${desc} ${p}` : p;
    else if (!desc && alts[0]) desc = trimEnd(alts[alts.length - 1].slice(0, DESC_MAX).replace(/\s+\S*$/, "")) + "\u2026";   // one long sentence: cut at a word
  }
  if (desc.length < 110) for (const t of tail) if (desc.length + 1 + t.length <= DESC_MAX) { desc += " " + t; break; }
  return { title, desc };
}
