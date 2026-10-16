// probe.js — verify the Clef format works with ONE pair (preview thumbnail, JPEG)
//
// This is the minimal test. Once it works, run benchmark.js for the
// thumbnail-vs-original comparison.
//
// Usage: npm run probe
// Requires: asset.view permission on the Immich API key

import { getDuplicateGroups, getAssetThumbnail } from './immich.js';
import { askClef, DUPLICATE_QUESTIONS } from './clef.js';
import { jpegDataUri } from './convert.js';

const STATE = 'Compare two photos. Photo A is the first image, Photo B is the second image. Assess whether they are the same photo, different frames of the same moment (burst), or different photos. Also assess which photo has better quality.';

async function main() {
  console.log('=== Clef Probe — format verification with preview thumbnails ===\n');

  // 1. Get a duplicate pair
  console.log('1. Fetching a duplicate pair...');
  const groups = await getDuplicateGroups();
  const group = groups.find(g => g.assets?.length === 2);
  if (!group) { console.log('   No pairs found.'); process.exit(0); }

  const [assetA, assetB] = group.assets;
  console.log(`   Pair: "${assetA.originalFileName}" vs "${assetB.originalFileName}"\n`);

  // 2. Download preview thumbnails (JPEG, ~1920×1440)
  console.log('2. Downloading preview thumbnails...');
  const [rawA, rawB] = await Promise.all([
    getAssetThumbnail(assetA.id, 'preview'),
    getAssetThumbnail(assetB.id, 'preview'),
  ]);
  console.log(`   Photo A: ${(rawA.buffer.byteLength / 1024).toFixed(0)} KB`);
  console.log(`   Photo B: ${(rawB.buffer.byteLength / 1024).toFixed(0)} KB\n`);

  // 3. Build JPEG data URIs (thumbnails are already JPEG from Immich)
  const imgA = jpegDataUri(rawA.base64);
  const imgB = jpegDataUri(rawB.base64);

  // 4. Send to Clef-omni
  console.log('3. Sending to Clef-omni...');
  try {
    const resp = await askClef('omni', STATE, [imgA, imgB], DUPLICATE_QUESTIONS);
    console.log(`   ✅ Clef-omni responded! (${resp._latency}ms)`);
    const { _latency, _model, ...clean } = resp;
    console.log('\n   Response:');
    console.log(JSON.stringify(clean, null, 2));

    // 5. Test Clef-flash
    console.log('\n4. Testing Clef-flash...');
    try {
      const flashResp = await askClef('flash', STATE, [imgA, imgB], DUPLICATE_QUESTIONS);
      console.log(`   ✅ Clef-flash responded! (${flashResp._latency}ms)`);
      const { _latency: fl, _model: fm, ...flashClean } = flashResp;
      console.log(JSON.stringify(flashClean, null, 2));

      console.log('\n=== FORMAT VERIFIED ===');
      console.log(`   Clef-omni:  ${resp._latency}ms`);
      console.log(`   Clef-flash: ${flashResp._latency}ms`);
    } catch (err) {
      console.log(`   ⚠️ Clef-flash: ${err.message.slice(0, 200)}`);
      console.log('\n=== FORMAT VERIFIED (omni only) ===');
    }
  } catch (err) {
    console.log(`   ❌ Clef-omni: ${err.message.slice(0, 300)}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
