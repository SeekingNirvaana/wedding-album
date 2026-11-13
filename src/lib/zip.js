// Minimal streaming ZIP writer (STORE, no compression: JPEGs are already compressed).
// Streams each file straight from R2 into the response, so memory stays small however many photos are chosen.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function header(size, fill) {
  const b = new Uint8Array(size);
  fill(new DataView(b.buffer));
  return b;
}

/**
 * files: async iterable of { name, open: () => Promise<ReadableStream|null>, date: Date }
 * Returns a ReadableStream of the zip. Files whose open() returns null are skipped.
 */
export function zipStream(files) {
  const enc = new TextEncoder();
  const central = [];
  let offset = 0;
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    const write = async (u8) => { await w.write(u8); offset += u8.length; };
    try {
      for await (const f of files) {
        const body = await f.open();
        if (!body) continue;
        const name = enc.encode(f.name);
        const { time, date } = dosTime(f.date || new Date());
        const start = offset;
        // Local header with "sizes in data descriptor" flag (bit 3) and UTF-8 names (bit 11)
        await write(header(30, (v) => {
          v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0808, true); v.setUint16(8, 0, true);
          v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint16(26, name.length, true);
        }));
        await write(name);
        let crc = 0, size = 0;
        const reader = body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          crc = crcUpdate(crc, value); size += value.length;
          await write(value);
        }
        await write(header(16, (v) => {
          v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true); v.setUint32(8, size, true); v.setUint32(12, size, true);
        }));
        central.push({ name, crc, size, start, time, date });
      }
      const cdStart = offset;
      for (const c of central) {
        await write(header(46, (v) => {
          v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0808, true);
          v.setUint16(12, c.time, true); v.setUint16(14, c.date, true); v.setUint32(16, c.crc, true);
          v.setUint32(20, c.size, true); v.setUint32(24, c.size, true); v.setUint16(28, c.name.length, true); v.setUint32(42, c.start, true);
        }));
        await write(c.name);
      }
      const cdSize = offset - cdStart;
      await write(header(22, (v) => {
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true);
        v.setUint32(12, cdSize, true); v.setUint32(16, cdStart, true);
      }));
      await w.close();
    } catch (e) {
      await w.abort(e).catch(() => {});
    }
  })();
  return readable;
}
