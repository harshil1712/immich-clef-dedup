// eye-tag-calibrate.mjs — test whether Eye tag divergence separates same-photo from burst-frame
//
// Signal hypothesis: a re-encoded duplicate gets identical tags (same pixels, re-compressed);
// a burst frame gets divergent tags (faces/expressions/positions moved).
// One-way signal: tags differ → different frame; tags match → inconclusive (static scenes match both).
//
// Runs on up to CALIB_N full-consensus pairs per class (same / burst) from pipeline-results.json.
//
// Usage:
//   npm run eye-calibrate

import { getAssetThumbnail } from './immich.js';
import sharp from 'sharp';
import { Eye } from '@desert-ant-labs/eye/native';
import { writeFile, readFile } from 'fs/promises';

const CALIB_N = 60;

async function toPixels(buf) {
  const { data, info } = await sharp(buf).rotate().resize(720, 720, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const t0 = Date.now();
const eye = await Eye.load();
console.log(`Eye loaded (${Date.now() - t0}ms)\n`);

const results = JSON.parse(await readFile('pipeline-results.json', 'utf8'));
const valid = results.filter(r => !r.error && r.comparisons);

// tag signature: { tag: confidence } for tags with confidence >= cutoff
function tagSig(analysis, cutoff = 0.5) {
  const sig = {};
  for (const [tag, conf] of Object.entries(analysis.confidences || {})) {
    if (conf >= cutoff) sig[tag] = Number(conf.toFixed(3));
  }
  return sig;
}

// divergence metrics between two tag signatures
function tagMetrics(sigA, sigB) {
  const keysA = new Set(Object.keys(sigA));
  const keysB = new Set(Object.keys(sigB));
  const union = new Set([...keysA, ...keysB]);
  const inter = [...keysA].filter(k => keysB.has(k));
  const jaccard = union.size ? inter.length / union.size : 1;   // 1 = identical tag sets
  // max confidence delta on shared tags, plus full confidence of differing tags
  let delta = 0;
  const differing = [];
  for (const k of union) {
    const ca = sigA[k], cb = sigB[k];
    if (ca !== undefined && cb !== undefined) {
      delta = Math.max(delta, Math.abs(ca - cb));
    } else {
      differing.push(`${k}:${(ca ?? cb).toFixed(2)}`);
    }
  }
  return {
    jaccard: Number(jaccard.toFixed(3)),
    sharedTags: inter.length,
    differingTags: union.size - inter.length,
    differing: differing.slice(0, 6),
    maxConfDelta: Number(delta.toFixed(3)),
  };
}

// ─── analyze cache ───
const cache = new Map();
async function analyzeAsset(id) {
  if (cache.has(id)) return cache.get(id);
  const thumb = await getAssetThumbnail(id, 'preview');
  const pix = await toPixels(Buffer.from(thumb.buffer));
  const a = await eye.analyze(pix);
  const sig = tagSig(a);
  const rec = { id, sig, aesthetic: a.scores?.aesthetic, analysis: a };
  cache.set(id, rec);
  return rec;
}

// ─── Phase A: tag divergence calibration on consensus pairs ───
console.log('═══ Tag divergence calibration ═══\n');

const pairs = { same: [], burst: [] };
for (const g of valid) {
  for (const c of g.comparisons) {
    if (!c.consensus?.allAgree) continue;
    const cls = c.consensus.classification;
    if (cls === 'same' && pairs.same.length < CALIB_N) pairs.same.push([g.keeper.id, c.otherId, g.keeper.name, c.otherName]);
    if (cls === 'burst' && pairs.burst.length < CALIB_N) pairs.burst.push([g.keeper.id, c.otherId, g.keeper.name, c.otherName]);
  }
}

async function calibTags(list, label) {
  const out = [];
  for (const [kId, oId, kName, oName] of list) {
    const [a, b] = await Promise.all([analyzeAsset(kId), analyzeAsset(oId)]);
    const m = tagMetrics(a.sig, b.sig);
    const sim = a.analysis.similarity(b.analysis);
    out.push({ kName, oName, sim: sim === null ? null : Number(sim.toFixed(4)), ...m });
  }
  console.log(`${label} (n=${out.length}):`);
  const jacc = out.map(o => o.jaccard).sort((x, y) => y - x);
  const dTags = out.map(o => o.differingTags).sort((x, y) => y - x);
  const dConf = out.map(o => o.maxConfDelta).sort((x, y) => y - x);
  const p = (arr, q) => arr[Math.floor(arr.length * q)] ?? arr[arr.length - 1] ?? 0;
  console.log(`  jaccard:    max=${jacc[0]} p25=${p(jacc, .25)} median=${p(jacc, .5)} p75=${p(jacc, .75)} min=${jacc[jacc.length - 1]}`);
  console.log(`  differingTags: max=${dTags[0]} p25=${p(dTags, .25)} median=${p(dTags, .5)} min=${dTags[dTags.length - 1]}`);
  console.log(`  maxConfDelta: max=${dConf[0]} p25=${p(dConf, .25)} median=${p(dConf, .5)} min=${dConf[dConf.length - 1]}`);
  const perfectJaccard = out.filter(o => o.jaccard === 1).length;
  const anyDiffering = out.filter(o => o.differingTags > 0).length;
  console.log(`  identical tag sets (jaccard=1): ${perfectJaccard}/${out.length}`);
  console.log(`  any differing tags: ${anyDiffering}/${out.length}`);
  console.log();
  return out;
}

const sameTagMetrics = await calibTags(pairs.same, 'known-SAME (3/3 duplicate)');
const burstTagMetrics = await calibTags(pairs.burst, 'known-BURST (3/3 burst)');

// how well does "differingTags > 0" identify bursts?
const burstWithDiffs = burstTagMetrics.filter(m => m.differingTags > 0).length;
const sameWithDiffs = sameTagMetrics.filter(m => m.differingTags > 0).length;
console.log(`── discrimination check ──`);
console.log(`bursts with differing tags:   ${burstWithDiffs}/${burstTagMetrics.length} (${(100 * burstWithDiffs / burstTagMetrics.length).toFixed(0)}%)`);
console.log(`sames  with differing tags:   ${sameWithDiffs}/${sameTagMetrics.length} (${(100 * sameWithDiffs / sameTagMetrics.length).toFixed(0)}%) ← false-positive rate`);
console.log(`→ tag divergence ${burstTagMetrics.length && sameTagMetrics.length && burstWithDiffs / burstTagMetrics.length > 0.7 && sameWithDiffs / sameTagMetrics.length < 0.1 ? 'SEPARATES the classes ✓' : 'is INCONCLUSIVE — check numbers'}`);

await writeFile('eye-tag-calibration.json', JSON.stringify({ sameTagMetrics, burstTagMetrics }, null, 2));

eye.dispose();
console.log(`\nelapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
