// node tools/inspect-media.test.mjs : testy wykrywania metadanych na syntetycznych plikach z worker/fixtures
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectMedia } from './lib/inspect-media.mjs';
import { png } from './lib/png.mjs';

const fx = (f) => fs.readFileSync(new URL(`../worker/fixtures/${f}`, import.meta.url));

let r = inspectMedia(fx('synthetic-gps.jpg'));
assert.equal(r.format, 'jpeg');
assert.equal(r.gps, true);
for (const t of ['Make', 'Model', 'Software', 'DateTimeOriginal', 'BodySerialNumber']) assert.ok(r.bad.includes(t), `brakuje ${t}: ${r.bad}`);
assert.ok(!r.bad.includes('Orientation'), 'Orientation jest dozwolona');

r = inspectMedia(fx('synthetic-orientation-only.jpg'));
assert.deepEqual([r.gps, r.tags, r.bad], [false, ['Orientation'], []]);

// JPEG bez żadnego EXIF (usuwamy segmenty APP1): czysty
const dropApp1 = (j) => {
  const out = [j.subarray(0, 2)];
  let p = 2;
  while (j[p] === 0xff && j[p + 1] !== 0xda) {
    const len = j.readUInt16BE(p + 2);
    if (j[p + 1] !== 0xe1) out.push(j.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  out.push(j.subarray(p));
  return Buffer.concat(out);
};
const noExif = dropApp1(fx('synthetic-orientation-only.jpg'));
assert.ok(noExif.length < fx('synthetic-orientation-only.jpg').length);
assert.deepEqual(inspectMedia(noExif).bad, []);

r = inspectMedia(png(3));
assert.deepEqual([r.format, r.bad], ['png', []]);
const withExif = Buffer.concat([png(3).subarray(0, 33), Buffer.from([0, 0, 0, 0]), Buffer.from('eXIf'), Buffer.from([0, 0, 0, 0]), png(3).subarray(33)]);
assert.deepEqual(inspectMedia(withExif).bad, ['eXIf']);

r = inspectMedia(fx('synthetic-gps.mp4'));
assert.equal(r.gps, true); assert.ok(r.bad.includes('ISO6709 coordinates'), r.bad.join());
r = inspectMedia(fx('synthetic-voice.m4a'));
assert.equal(r.format, 'iso-media'); assert.equal(r.gps, true);

// plik MP4 po ręcznym wycięciu współrzędnych: GPS znika, tytuł zostaje jako informacja
const stripped = Buffer.from(fx('synthetic-gps.mp4').toString('latin1').split('+12.3456+065.4321').join('XXXXXXXXXXXXXXXXXX').replace(/\xa9xyz/g, 'free'), 'latin1');
r = inspectMedia(stripped);
assert.equal(r.gps, false, r.bad.join());
assert.ok(r.info.length > 0);

assert.deepEqual(inspectMedia(Buffer.from('not media at all')).bad, ['unrecognised format']);
console.log('inspect-media: wszystkie testy przeszły');
