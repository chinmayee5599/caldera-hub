/**
 * Uploaded profile images (photo, masthead) for GitHub-hosted profiles: checked by their magic bytes, capped in size,
 * and stripped of metadata (EXIF/XMP/comments: camera, GPS, software) before they're stored or published.
 */
export type ImageKind = "jpg" | "png" | "webp";
export const MAX_IMAGE = 3 * 1024 * 1024;

export function sniff(b: Buffer): ImageKind | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** JPEG: drop APP1-APP15 (EXIF, XMP, IPTC...) and COM segments; keep APP0 (JFIF) and everything the decoder needs. */
function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)]; let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;                         // not a marker where one should be: leave the file alone
    const m = b[i + 1]!;
    if (m === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); }   // start of scan: the rest is image data
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = b.readUInt16BE(i + 2); if (len < 2 || i + 2 + len > b.length) return b;
    if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return b;
}
/** PNG: drop text, time and EXIF chunks. */
function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)]; let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString("latin1", i + 4, i + 8), end = i + 12 + len; if (end > b.length) return b;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(b.subarray(i, end));
    i = end; if (type === "IEND") break;
  }
  return Buffer.concat(out);
}
/** WebP: drop EXIF and XMP chunks and clear their flags in VP8X. */
function stripWebp(b: Buffer): Buffer {
  const chunks: Buffer[] = []; let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString("latin1", i, i + 4), len = b.readUInt32LE(i + 4), end = i + 8 + len + (len & 1); if (i + 8 + len > b.length) return b;
    if (type !== "EXIF" && type !== "XMP ") { const c = Buffer.from(b.subarray(i, Math.min(end, b.length))); if (type === "VP8X" && c.length > 8) c[8] = c[8]! & ~0x0c; chunks.push(c); }
    i = end;
  }
  const body = Buffer.concat(chunks), head = Buffer.from("RIFF0000WEBP", "latin1"); head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

/** Validate an upload; returns the cleaned bytes and its type, or an error message for the owner. */
export function cleanImage(b: Buffer): { ok: true; data: Buffer; ext: ImageKind } | { ok: false; error: string } {
  if (!b.length) return { ok: false, error: "That file is empty." };
  if (b.length > MAX_IMAGE) return { ok: false, error: "That image is over 3 MB. Try a smaller one." };
  const k = sniff(b); if (!k) return { ok: false, error: "Use a JPG, PNG or WebP image." };
  return { ok: true, ext: k, data: k === "jpg" ? stripJpeg(b) : k === "png" ? stripPng(b) : stripWebp(b) };
}
