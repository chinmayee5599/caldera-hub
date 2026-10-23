/**
 * Apps and websites members list on their page: the hub looks up their public details once a day and serves the
 * images itself, so profile pages (CSP: images from this hub only) never hotlink a store or a member's site.
 *
 * - Apps: Apple's public iTunes Lookup API (by app id only) and the public Google Play listing page (by package name).
 * - Websites: the page's title, description and icon, fetched through safeGet(): public addresses only (every DNS answer
 *   is checked and the connection is pinned to the checked address, so DNS rebinding can't reach inside), ports 80/443,
 *   at most 3 redirects (each one checked again), size and time limits, no cookies.
 * Nothing about the member is ever sent: only the app id or the site's own URL.
 */
import type http from "node:http";
import httpMod from "node:http";
import httpsMod from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { parseListingLine, type ListingKind, type ListingMeta, type ListingRef } from "../../../../caldera/packages/plugin/src/listings";

const UA = "Mozilla/5.0 (compatible; CalderaBot/1.0; +https://caldera.social/bot)";
const DAY = 86_400_000;

// ---- SSRF guard -------------------------------------------------------------------------------------------------------

const v4 = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCK: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];
/** Is this address anything but the public internet? (loopback, private, link-local, carrier NAT, test nets, multicast, reserved) */
export function blockedIp(ip: string): boolean {
  const fam = net.isIP(ip); if (!fam) return true;
  if (fam === 4) { const n = v4(ip); return V4_BLOCK.some(([base, bits]) => (n >>> 0) >>> (32 - bits) === (v4(base) >>> 0) >>> (32 - bits)); }
  const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = x.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || x.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return blockedIp(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) { const [, a, b] = x.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/)!; const n = parseInt(a, 16) * 65536 + parseInt(b, 16); return blockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
  if (x === "::" || x === "::1") return true;
  const first = parseInt(x.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;   // multicast
  if (/^2001:0?db8:/.test(x) || /^2001:0{0,3}:/.test(x) || /^2002:/.test(x)) return true;   // documentation, Teredo, 6to4
  if (first === 0) return true;
  return false;
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const sysLookup: Lookup = h => dns.lookup(h, { all: true, verbatim: true });

export interface GetResult { status: number; type: string; body: Buffer; url: string }
/** GET a public URL, safely (see the top of this file). Throws on anything refused. */
type Hop = { status: number; type: string; body: Buffer; location?: string };
/** One request to an already-checked address (tests swap this out; the checks around it stay the same). */
export type Transport = (u: URL, pin: { address: string; family: number }, o: { maxBytes: number; timeoutMs: number; accept?: string }) => Promise<Hop>;
const transport: Transport = (u, pin, o) => new Promise<Hop>((ok, no) => {
  const mod = u.protocol === "https:" ? httpsMod : httpMod;
  const req = mod.request(u, { method: "GET", headers: { "user-agent": UA, accept: o.accept || "*/*", "accept-language": "en-US,en;q=0.8" },
    lookup: ((_h: string, opts: any, cb: any) => opts && opts.all ? cb(null, [pin]) : cb(null, pin.address, pin.family)) as any }, res => {
    const status = res.statusCode || 0, type = String(res.headers["content-type"] || "").toLowerCase();
    if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return ok({ status, type, body: Buffer.alloc(0), location: String(res.headers.location) }); }
    const len = Number(res.headers["content-length"] || 0); if (len > o.maxBytes) { res.destroy(); return no(new Error("too large")); }
    const chunks: Buffer[] = []; let n = 0;
    res.on("data", (c: Buffer) => { n += c.length; if (n > o.maxBytes) { res.destroy(); no(new Error("too large")); return; } chunks.push(c); });
    res.on("end", () => ok({ status, type, body: Buffer.concat(chunks) })); res.on("error", no);
  });
  req.setTimeout(o.timeoutMs, () => req.destroy(new Error("timeout")));
  req.on("error", no); req.end();
});
export async function safeGet(url: string, o: { maxBytes: number; timeoutMs?: number; accept?: string; lookup?: Lookup; redirects?: number; transport?: Transport }): Promise<GetResult> {
  let cur = url, hops = o.redirects ?? 3;
  const lookup = o.lookup || sysLookup;
  for (;;) {
    let u: URL; try { u = new URL(cur); } catch { throw new Error("bad url"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    if (u.username || u.password) throw new Error("credentials");
    if (u.port && u.port !== "80" && u.port !== "443") throw new Error("port");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || /\.(localhost|local|internal)$/i.test(host)) throw new Error("host");
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host);
    if (!addrs.length || addrs.some(a => blockedIp(a.address))) throw new Error("blocked address");
    const pin = addrs[0];
    const r = await (o.transport || transport)(u, pin, { maxBytes: o.maxBytes, timeoutMs: o.timeoutMs ?? 6000, accept: o.accept });
    if (r.body.length > o.maxBytes) throw new Error("too large");
    if (r.location) { if (hops-- <= 0) throw new Error("too many redirects"); cur = new URL(r.location, u).toString(); continue; }
    return { status: r.status, type: r.type, body: r.body, url: u.toString() };
  }
}

// ---- parsing ------------------------------------------------------------------------------------------------------------

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " "; }
  return ENT[e.toLowerCase()] ?? m; });
/** Plain text, safe to embed anywhere: no tags, no control characters, collapsed, cut to n. */
export const plain = (v: unknown, n: number) => decode(String(v ?? "").replace(/<[^>]*>/g, " ")).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find(x => x !== undefined) ?? "";
function metaOf(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) { const k = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase(); if (keys.includes(k)) { const c = attr(tag, "content"); if (c) return c; } }
  return "";
}
/** A site's details from its HTML: title, description and the best icon link (apple-touch-icon, then icon, then og:image). */
export function parseSiteHtml(html: string, base: string): { name: string; desc: string; icons: string[] } {
  const head = html.slice(0, 300_000);
  // the product's name, not the page's headline: og:site_name, else the title up to its first " - ", " | ", " — " or ": "
  const title = plain(metaOf(head, ["og:title", "twitter:title"]) || head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "", 120);
  const short = title.split(/\s+[-|\u2013\u2014\u00b7]\s+|:\s+/)[0].trim();
  const name = plain(metaOf(head, ["og:site_name", "application-name"]), 60) || (short.length >= 2 ? short : title).slice(0, 80);
  const desc = plain(metaOf(head, ["og:description", "description", "twitter:description"]), 200);
  const icons: string[] = [], add = (h: string) => { if (!h) return; try { const u = new URL(decode(h), base); if ((u.protocol === "https:" || u.protocol === "http:") && !icons.includes(u.toString())) icons.push(u.toString()); } catch { /* skip */ } };
  const links = head.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  for (const want of [/apple-touch-icon/, /(^|\s)icon(\s|$)/]) for (const l of links) { const rel = attr(l, "rel").toLowerCase(); if (want.test(rel) && !/\.svg(\?|$)/i.test(attr(l, "href")) && !/svg/i.test(attr(l, "type"))) add(attr(l, "href")); }
  add(metaOf(head, ["og:image", "twitter:image"]));
  add("/favicon.ico");
  return { name, desc, icons: icons.slice(0, 4) };
}
/** Google Play listing page -> name, icon, category, rating (whatever is there). */
export function parsePlayHtml(html: string): { name: string; icon: string; genre: string; rating: number; ratings: number } {
  const name = plain(metaOf(html, ["og:title"]).replace(/\s*[-–]\s*Apps on Google Play\s*$/i, ""), 80);
  const icon = metaOf(html, ["og:image"]);
  const genre = plain(html.match(/itemprop="genre"[^>]*>([^<]{1,60})</)?.[1] || html.match(/"applicationCategory":"([^"]{1,60})"/)?.[1]?.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) || "", 40);
  const rating = Number(html.match(/"ratingValue":"?([\d.]+)/)?.[1] || html.match(/Rated ([\d.]+) stars out of five/i)?.[1] || 0);
  const ratings = Number(html.match(/"ratingCount":"?(\d+)/)?.[1] || 0);
  return { name, icon, genre, rating: rating > 0 && rating <= 5 ? rating : 0, ratings };
}

/** A small image we'll serve ourselves: PNG, JPEG, GIF, WebP or ICO (never SVG), by its bytes, not its claimed type. */
export function imageType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  return null;
}

// ---- the service --------------------------------------------------------------------------------------------------------

export interface ListingsCtx {
  q: (sql: string) => any; json: (res: http.ServerResponse, status: number, body: unknown) => void;
  readBody: (req: http.IncomingMessage) => Promise<any>; tooMany: (key: string, max: number, windowMs?: number) => boolean; ipOf: (req: http.IncomingMessage) => string;
  lookup?: Lookup; get?: typeof safeGet;
}
const IMG_MAX = 512 * 1024;

export function listings(c: ListingsCtx) {
  const q = c.q, get = c.get || safeGet;
  q(`CREATE TABLE IF NOT EXISTS listing_meta (key TEXT PRIMARY KEY, kind TEXT, url TEXT, json TEXT, img BLOB, img_type TEXT, img_id TEXT, fetched INTEGER, ok INTEGER)`).run();
  let running = 0; const waiting: (() => void)[] = [];
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => { if (running >= 3) await new Promise<void>(r => waiting.push(r)); running++; try { return await fn(); } finally { running--; waiting.shift()?.(); } };
  const opts = (max: number, accept?: string) => ({ maxBytes: max, timeoutMs: 6000, accept, lookup: c.lookup });

  async function image(urls: string[]): Promise<{ b: Buffer; type: string } | null> {
    for (const u of urls.slice(0, 4)) {
      try { const r = await get(u, opts(IMG_MAX, "image/avif,image/webp,image/png,image/*;q=0.8")); const t = r.status === 200 ? imageType(r.body) : null; if (t) return { b: r.body, type: t }; } catch { /* next */ }
    }
    return null;
  }
  async function fetchMeta(ref: ListingRef): Promise<{ meta: Omit<ListingMeta, "key" | "img">; img: { b: Buffer; type: string } | null }> {
    if (ref.kind === "app" && ref.store === "apple") {
      for (const cc of ["us", "gb"]) {
        const r = await get(`https://itunes.apple.com/lookup?id=${ref.id}&country=${cc}&entity=software`, opts(400_000, "application/json"));
        const a = r.status === 200 ? (JSON.parse(r.body.toString("utf8"))?.results || [])[0] : null; if (!a) continue;
        return { meta: { name: plain(a.trackName, 80), genre: plain(a.primaryGenreName, 40), rating: Number(a.averageUserRating) || undefined, ratings: Number(a.userRatingCount) || undefined, seller: plain(a.sellerName || a.artistName, 80) },
          img: await image([a.artworkUrl512, a.artworkUrl100].filter((x: unknown) => typeof x === "string" && /^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//.test(x as string))) };
      }
      return { meta: {}, img: null };
    }
    if (ref.kind === "app") {
      const r = await get(`https://play.google.com/store/apps/details?id=${encodeURIComponent(ref.id!)}&hl=en_US&gl=US`, opts(2_500_000, "text/html"));
      if (r.status !== 200) return { meta: {}, img: null };
      const p = parsePlayHtml(r.body.toString("utf8"));
      return { meta: { name: p.name, genre: p.genre || undefined, rating: p.rating || undefined, ratings: p.ratings || undefined },
        img: /^https:\/\/play-lh\.googleusercontent\.com\//.test(p.icon) ? await image([p.icon]) : null };
    }
    const r = await get(ref.url, opts(1_000_000, "text/html,application/xhtml+xml"));
    if (r.status !== 200 || !/html/.test(r.type)) return { meta: {}, img: null };
    const s = parseSiteHtml(r.body.toString("utf8"), r.url);
    return { meta: { name: s.name, desc: s.desc || undefined }, img: await image(s.icons) };
  }

  /** Details for these listings: from the cache when fresh (a day; a failed lookup retries after 6 hours), else fetched
   *  now, if allowed (fresh lookups are rate limited per caller). Unknown ones come back with just their key. */
  async function resolve(refs: ListingRef[], mayFetch = true): Promise<ListingMeta[]> {
    const out: ListingMeta[] = [];
    await Promise.all(refs.slice(0, 24).map(async ref => {
      let row = q("SELECT * FROM listing_meta WHERE key=?").get(ref.key) as any;
      const stale = !row || Date.now() - row.fetched > (row.ok ? DAY : DAY / 4);
      if (stale && mayFetch) {
        try {
          const f = await slot(() => fetchMeta(ref)), ok = f.meta.name ? 1 : 0;
          const img = f.img || (row?.img ? { b: Buffer.from(row.img), type: row.img_type } : null);
          const imgId = img ? `${ref.key}.${crypto.createHash("sha256").update(img.b).digest("hex").slice(0, 10)}` : null;
          q("INSERT OR REPLACE INTO listing_meta (key, kind, url, json, img, img_type, img_id, fetched, ok) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(ref.key, ref.kind, ref.url, JSON.stringify(ok ? f.meta : row?.ok ? JSON.parse(row.json) : f.meta), img?.b ?? null, img?.type ?? null, imgId, Date.now(), ok || row?.ok || 0);
        } catch { if (row) q("UPDATE listing_meta SET fetched=? WHERE key=?").run(Date.now() - DAY + DAY / 4, ref.key); else q("INSERT OR REPLACE INTO listing_meta (key, kind, url, json, fetched, ok) VALUES (?,?,?,?,?,0)").run(ref.key, ref.kind, ref.url, "{}", Date.now()); }
        row = q("SELECT * FROM listing_meta WHERE key=?").get(ref.key);
      }
      const m = row ? JSON.parse(row.json || "{}") : {};
      out.push({ key: ref.key, name: plain(m.name, 80) || undefined, genre: plain(m.genre, 40) || undefined, desc: plain(m.desc, 200) || undefined, seller: plain(m.seller, 80) || undefined,
        rating: Number(m.rating) > 0 && Number(m.rating) <= 5 ? Number(m.rating) : undefined, ratings: Number(m.ratings) > 0 ? Math.round(Number(m.ratings)) : undefined, img: row?.img_id || undefined });
    }));
    return out;
  }
  /** "link | repo | flags" lines -> refs (the same parsing as the plugin) */
  const refsOf = (lines: unknown, kind: ListingKind) => (Array.isArray(lines) ? lines : String(lines || "").split(/\r?\n/)).map(l => parseListingLine(l, kind)).filter((x): x is ListingRef => !!x);

  async function route(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
    if (req.method === "POST" && p === "/v1/listings/resolve") {
      let b: any; try { b = await c.readBody(req); } catch { c.json(res, 400, { error: "bad body" }); return true; }
      const items = Array.isArray(b?.items) ? b.items.slice(0, 24) : [];
      const refs = items.map((x: any) => parseListingLine(String(x?.url || ""), x?.kind === "site" ? "site" : "app")).filter((x: ListingRef | null): x is ListingRef => !!x);
      const mayFetch = !c.tooMany("listings:" + c.ipOf(req), 30, 3_600_000);
      c.json(res, 200, { items: await resolve(refs, mayFetch) }); return true;
    }
    const m = p.match(/^\/v1\/listings\/img\/([a-z0-9._-]{3,200})$/i);
    if (req.method === "GET" && m) {
      const row = q("SELECT img, img_type FROM listing_meta WHERE img_id=?").get(m[1]) as any, img = row?.img ? Buffer.from(row.img) : null;
      if (!img || !imageType(img)) { c.json(res, 404, { error: "not found" }); return true; }
      res.writeHead(200, { "content-type": imageType(img)!, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cross-origin-resource-policy": "cross-origin" });
      res.end(img); return true;
    }
    return false;
  }
  return { route, resolve, refsOf };
}
