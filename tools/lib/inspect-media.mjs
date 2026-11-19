// Wykrywanie wrażliwych metadanych w plikach, bez zewnętrznych bibliotek. Do testów A2: czy pobrany plik ma jeszcze GPS, aparat, numery seryjne.
// Zdjęcia (JPEG, PNG): dozwolona jest wyłącznie Orientation. Wideo i dźwięk (MP4/M4A): GPS to błąd, pozostałe znaczniki to informacja.
const NAMES = {
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
  0x8298: 'Copyright', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x927c: 'MakerNote',
  0x9286: 'UserComment', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
};
const tagName = (t) => NAMES[t] ?? `tag0x${t.toString(16).padStart(4, '0')}`;

function tiffTags(tiff) {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return { tags: ['badTiffHeader'], gps: false };
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const tags = [];
  let gps = false;
  const seen = new Set();
  const walk = (off, label) => {
    if (off + 2 > tiff.length || seen.has(off)) return;
    seen.add(off);
    const n = u16(off);
    for (let i = 0; i < n && off + 2 + i * 12 + 12 <= tiff.length; i++) {
      const e = off + 2 + i * 12, tag = u16(e);
      tags.push(label === 'GPS' ? `GPS:${tag}` : tagName(tag));
      if (label === 'GPS') gps = true;
      if (tag === 0x8769 || tag === 0xa005) walk(u32(e + 8), 'EXIF');
      if (tag === 0x8825) { gps = true; walk(u32(e + 8), 'GPS'); }
    }
    if (label === 'IFD0') {
      const next = u32(off + 2 + n * 12);
      if (next) { tags.push('IFD1(thumbnail)'); walk(next, 'IFD1'); }
    }
  };
  walk(u32(4), 'IFD0');
  return { tags, gps };
}

function inspectJpeg(b) {
  const tags = [];
  let gps = false, xmp = false, iptc = false, comment = false, p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = b.readUInt16BE(p + 2), seg = b.subarray(p + 4, p + 2 + len);
    if (m === 0xe1 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
      const r = tiffTags(seg.subarray(6));
      tags.push(...r.tags);
      gps ||= r.gps;
    }
    if (m === 0xe1 && seg.toString('latin1', 0, 28).startsWith('http://ns.adobe.com/xap/1.0/')) xmp = true;
    if (m === 0xed) iptc = true;
    if (m === 0xfe) comment = true;
    p += 2 + len;
  }
  const extra = [...(xmp ? ['XMP'] : []), ...(iptc ? ['IPTC/APP13'] : []), ...(comment ? ['JPEG comment'] : [])];
  const bad = tags.filter((t) => t !== 'Orientation').concat(extra);
  return { format: 'jpeg', gps, tags: [...tags, ...extra], bad };
}

function inspectPng(b) {
  const found = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const n = b.readUInt32BE(p), t = b.toString('latin1', p + 4, p + 8);
    if (['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(t)) found.push(t);
    p += 12 + n;
  }
  return { format: 'png', gps: found.includes('eXIf'), tags: found, bad: found };
}

function inspectIso(b) {
  const s = b.toString('latin1');
  const gpsMarks = [];
  if (/[+-]\d{1,3}\.\d{2,}[+-]\d{1,3}\.\d{2,}(\/|\b)/.test(s)) gpsMarks.push('ISO6709 coordinates');
  if (b.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a]))) gpsMarks.push('©xyz atom');
  // shortcut: szukamy ciągu bajtów w całym pliku, nie parsujemy pudełek. Możliwy rzadki fałszywy alarm w danych audio/wideo, wtedy sprawdź ffprobe.
  if (s.includes('loci')) gpsMarks.push('loci atom (3GPP location)');
  if (s.includes('com.apple.quicktime.location')) gpsMarks.push('quicktime location key');
  const info = [];
  for (const [k, n] of [[[0xa9, 0x6e, 0x61, 0x6d], 'title'], [[0xa9, 0x41, 0x52, 0x54], 'artist'], [[0xa9, 0x63, 0x6d, 0x74], 'comment'], [[0xa9, 0x64, 0x61, 0x79], 'date']]) {
    if (b.includes(Buffer.from(k))) info.push(n);
  }
  for (const k of ['title', 'artist', 'comment', 'location', 'creation_time']) if (s.includes(k) && !info.includes(k)) info.push(k);
  return { format: 'iso-media', gps: gpsMarks.length > 0, tags: [...gpsMarks, ...info], bad: gpsMarks, info };
}

// Zwraca { format, gps, tags, bad }: `bad` puste = plik czysty według zasad powyżej.
export function inspectMedia(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return inspectJpeg(buf);
  if (buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG') return inspectPng(buf);
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return inspectIso(buf);
  return { format: 'unknown', gps: false, tags: [], bad: ['unrecognised format'] };
}
