// eye-probe.mjs — verify Desert Ant Labs Eye on two real Immich thumbnails
// Tests: analyze(), embedding similarity, Eye.duplicates(), Eye.best()
//
// Usage:
//   npm run eye-probe -- <assetIdA> <assetIdB>

import { getAssetThumbnail, getAsset } from './immich.js';
import sharp from 'sharp';
import { Eye } from '@desert-ant-labs/eye/native';

const [ID_A, ID_B] = process.argv.slice(2);
if (!ID_A || !ID_B) {
  console.error('usage: npm run eye-probe -- <assetIdA> <assetIdB>');
  process.exit(1);
}

async function toPixels(buf) {
  const { data, info } = await sharp(buf).rotate().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const captureTime = meta => meta?.exifInfo?.dateTimeOriginal
  ? Math.floor(new Date(meta.exifInfo.dateTimeOriginal).getTime() / 1000)
  : null;

const t0 = Date.now();

console.log('1. Eye.load() (Core ML native on macOS)...');
const eye = await Eye.load();
console.log(`   loaded in ${Date.now() - t0}ms`);

console.log('2. downloading thumbnails + metadata from Immich...');
const [aRaw, bRaw, aMeta, bMeta] = await Promise.all([
  getAssetThumbnail(ID_A, 'preview'),
  getAssetThumbnail(ID_B, 'preview'),
  getAsset(ID_A),
  getAsset(ID_B),
]);
const [aPix, bPix] = await Promise.all([toPixels(Buffer.from(aRaw.buffer)), toPixels(Buffer.from(bRaw.buffer))]);
console.log(`   A: ${aPix.width}x${aPix.height}, B: ${bPix.width}x${bPix.height}`);

console.log('3. analyzing both photos...');
const t1 = Date.now();
const a = await eye.analyze(aPix);
const b = await eye.analyze(bPix);
console.log(`   2 analyses in ${Date.now() - t1}ms (${(Date.now() - t1) / 2}ms avg)`);

for (const [label, r, meta] of [['A', a, aMeta], ['B', b, bMeta]]) {
  console.log(`\n── ${label} (${meta.originalFileName}) ──`);
  console.log('   tags:', r.tags().slice(0, 8).join(', '));
  console.log('   kind:', r.kind, '| aesthetic:', r.scores?.aesthetic);
}

console.log('\n4. embedding similarity — the number that answers "same or burst?":');
const sim = a.similarity(b);
console.log('   similarity =', sim === null ? 'unavailable' : sim.toFixed(4));

const dates = [captureTime(aMeta), captureTime(bMeta)];
console.log(`\n5. Eye.duplicates with capture times (${dates[0] && dates[1] ? `${Math.abs(dates[0] - dates[1])}s apart` : 'unknown'}):`);
console.log('   ', JSON.stringify(Eye.duplicates([a, b], { dates })));

console.log('\n6. Eye.best (which to keep?):');
const best = Eye.best([a, b]);
console.log('   best picks:', best === null ? 'no preference' : best === 0 ? 'A' : 'B');

eye.dispose();
console.log('\nprobe complete');
process.exit(0);
