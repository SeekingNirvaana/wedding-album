// Memory-safe photo preparation for cheap phones: read the JPEG header (size, orientation, capture time)
// without decoding, then decode straight to the target size and re-encode. Re-encoding drops EXIF/GPS.

export async function readHeader(file) {
  const out = { w: 0, h: 0, orientation: 1, takenAt: null };
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return out;
    let p = 2;
    while (p + 9 < v.byteLength) {
      if (v.getUint8(p) !== 0xff) break;
      const marker = v.getUint8(p + 1);
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966) parseExif(v, p + 10, out);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        out.h = v.getUint16(p + 5); out.w = v.getUint16(p + 7);
        break;
      }
      p += 2 + len;
    }
  } catch { /* partial header is fine */ }
  return out;
}

function parseExif(v, t, out) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < v.byteLength; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  const ifd = (off) => {
    const tags = {};
    const n = u16(t + off);
    for (let i = 0; i < n; i++) {
      const e = t + off + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) tags[tag] = str(count > 4 ? t + u32(e + 8) : e + 8, count);
      else if (type === 3) tags[tag] = u16(e + 8);
      else if (type === 4) tags[tag] = u32(e + 8);
    }
    return tags;
  };
  const i0 = ifd(u32(t + 4));
  if (i0[0x0112]) out.orientation = i0[0x0112];
  const ex = i0[0x8769] ? ifd(i0[0x8769]) : {};
  const dt = ex[0x9003] || ex[0x9004] || i0[0x0132];
  const m = dt && dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const off = /^[+-]\d{2}:\d{2}$/.test(ex[0x9011] || '') ? ex[0x9011] : '+05:30';
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
    if (Number.isFinite(ms)) out.takenAt = ms;
  }
}

async function decodeScaled(file, hdr, maxEdge) {
  const rotated = hdr.orientation >= 5 && hdr.orientation <= 8;
  const W = rotated ? hdr.h : hdr.w, H = rotated ? hdr.w : hdr.h;
  if (W && H && 'createImageBitmap' in window) {
    const scale = Math.min(1, maxEdge / Math.max(W, H));
    try {
      // Decode directly at the reduced size so a 50-108 MP photo never sits full-size in memory
      return await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: Math.round(W * scale), resizeHeight: Math.round(H * scale), resizeQuality: 'high' });
    } catch { /* fall through */ }
  }
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}

export async function prepare(file, { edge, q }) {
  const hdr = await readHeader(file);
  const src = await decodeScaled(file, hdr, edge);
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), hgt = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = hgt;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, hgt);
  src.close?.();
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', q));
  canvas.width = canvas.height = 0; // release memory early on low-RAM phones
  return { blob, w, h: hgt, takenAt: hdr.takenAt || (file.lastModified && Math.abs(Date.now() - file.lastModified) < 400 * 86400_000 ? file.lastModified : null) };
}

export async function smallPreview(file) {
  const r = await prepare(file, { edge: 160, q: 0.6 });
  return URL.createObjectURL(r.blob);
}
