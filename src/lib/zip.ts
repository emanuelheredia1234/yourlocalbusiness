// Minimal ZIP writer: stored (uncompressed) entries with CRC-32, enough for .xlsx packages.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

/** Build a ZIP archive. Entries are kept in the given order (a package's first part stays first). */
export function zip(entries: ZipEntry[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const files = entries.map((e) => ({ name: enc.encode(e.name), data: typeof e.data === 'string' ? enc.encode(e.data) : e.data }));
  let size = 22;
  for (const f of files) size += 30 + 46 + 2 * f.name.length + f.data.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const central: { offset: number; crc: number; name: Uint8Array; len: number }[] = [];
  let off = 0;
  for (const f of files) {
    const crc = crc32(f.data);
    central.push({ offset: off, crc, name: f.name, len: f.data.length });
    v.setUint32(off, 0x04034b50, true); // local file header
    v.setUint16(off + 4, 20, true); // version needed
    v.setUint16(off + 6, 0x0800, true); // UTF-8 names
    v.setUint16(off + 8, 0, true); // stored
    v.setUint16(off + 10, time, true);
    v.setUint16(off + 12, day, true);
    v.setUint32(off + 14, crc, true);
    v.setUint32(off + 18, f.data.length, true);
    v.setUint32(off + 22, f.data.length, true);
    v.setUint16(off + 26, f.name.length, true);
    v.setUint16(off + 28, 0, true);
    out.set(f.name, off + 30);
    out.set(f.data, off + 30 + f.name.length);
    off += 30 + f.name.length + f.data.length;
  }
  const cdStart = off;
  for (const c of central) {
    v.setUint32(off, 0x02014b50, true); // central directory header
    v.setUint16(off + 4, 20, true); // made by
    v.setUint16(off + 6, 20, true); // version needed
    v.setUint16(off + 8, 0x0800, true);
    v.setUint16(off + 10, 0, true);
    v.setUint16(off + 12, time, true);
    v.setUint16(off + 14, day, true);
    v.setUint32(off + 16, c.crc, true);
    v.setUint32(off + 20, c.len, true);
    v.setUint32(off + 24, c.len, true);
    v.setUint16(off + 28, c.name.length, true);
    v.setUint16(off + 30, 0, true); // extra
    v.setUint16(off + 32, 0, true); // comment
    v.setUint16(off + 34, 0, true); // disk
    v.setUint16(off + 36, 0, true); // internal attrs
    v.setUint32(off + 38, 0, true); // external attrs
    v.setUint32(off + 42, c.offset, true);
    out.set(c.name, off + 46);
    off += 46 + c.name.length;
  }
  v.setUint32(off, 0x06054b50, true); // end of central directory
  v.setUint16(off + 4, 0, true);
  v.setUint16(off + 6, 0, true);
  v.setUint16(off + 8, files.length, true);
  v.setUint16(off + 10, files.length, true);
  v.setUint32(off + 12, off - cdStart, true);
  v.setUint32(off + 16, cdStart, true);
  v.setUint16(off + 20, 0, true);
  return out;
}
