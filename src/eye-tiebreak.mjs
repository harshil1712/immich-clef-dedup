// eye-tiebreak.mjs — Desert Ant Labs Eye as the local tiebreaker for Clef-disagreement groups
//
// Phase A: calibrate similarity thresholds on full-consensus comparisons from pipeline-results.json
//          (known-same vs known-burst — ground truth from the 3-model ensemble)
// Phase B: run Eye on every disputed asset in the disagreement groups, emit verdicts
//
// Eye inference runs locally (Core ML on macOS), so no API cost and no photos are uploaded.
//
// Usage:
//   npm run eye-tiebreak               (calibrate + tiebreak, collect-only)
//   npm run eye-tiebreak -- --apply    (also apply confident verdicts)

import { getAssetThumbnail, resolveDuplicates, getAsset } from './immich.js';
import sharp from 'sharp';
import { Eye } from '@desert-ant-labs/eye/native';
import { writeFile, readFile } from 'fs/promises';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const CALIB_N = 60;   // pairs per class for calibration

async function toPixels(buf) {
  const { data, info } = await sharp(buf).rotate().resize(720, 720, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const t0 = Date.now();
console.log('loading Eye (Core ML)...');
const eye = await Eye.load();
console.log(`  ready in ${Date.now() - t0}ms\n`);

// ─── load Phase 2 results ───
const results = JSON.parse(await readFile('pipeline-results.json', 'utf8'));
const valid = results.filter(r => !r.error && r.comparisons);

// consensus comparisons: all 3 models agreed — our ground truth
const knownSame = [];   // comparisons where all-3 said 'same'
const knownBurst = []; // comparisons where all-3 said 'burst'
for (const g of valid) {
  for (const c of g.comparisons) {
    if (!c.consensus?.allAgree) continue;
    if (c.consensus.classification === 'same' && knownSame.length < CALIB_N) {
      knownSame.push({ keeperId: g.keeper.id, otherId: c.otherId, groupId: g.duplicateId });
    }
    if (c.consensus.classification === 'burst' && knownBurst.length < CALIB_N) {
      knownBurst.push({ keeperId: g.keeper.id, otherId: c.otherId, groupId: g.duplicateId });
    }
  }
}
console.log(`calibration pool: ${knownSame.length} known-same, ${knownBurst.length} known-burst`);

// the disagreement groups (any group with needsReview)
const reviewGroups = valid.filter(g => g.recommendation?.needsReview?.length > 0);
console.log(`tiebreak targets: ${reviewGroups.length} groups\n`);

// ─── analysis cache ───
const analyses = new Map();  // assetId -> Eye analysis (embedded; serialize-safe via toJSON)

async function analyzeAsset(assetId) {
  if (analyses.has(assetId)) return analyses.get(assetId);
  const thumb = await getAssetThumbnail(assetId, 'preview');
  const pix = await toPixels(Buffer.from(thumb.buffer));
  const a = await eye.analyze(pix);
  analyses.set(assetId, a);
  return a;
}

// capture time per asset (for Eye.duplicates' date logic)
const captureTimes = new Map();
async function getCaptureTime(assetId) {
  if (captureTimes.has(assetId)) return captureTimes.get(assetId);
  const meta = await getAsset(assetId);
  const t = meta?.exifInfo?.dateTimeOriginal ? Math.floor(new Date(meta.exifInfo.dateTimeOriginal).getTime() / 1000) : null;
  captureTimes.set(assetId, t);
  return t;
}

// ─── Phase A: calibration ───
console.log('═══ Phase A: calibrating similarity thresholds ═══\n');

async function calibrate(pairs, label) {
  const sims = [];
  for (const p of pairs) {
    try {
      const [a, b] = await Promise.all([analyzeAsset(p.keeperId), analyzeAsset(p.otherId)]);
      const sim = a.similarity(b);
      if (sim !== null) sims.push(sim);
    } catch (e) { /* skip */ }
  }
  if (!sims.length) throw new Error(`no ${label} pairs could be analyzed — cannot calibrate`);
  sims.sort((x, y) => x - y);
  const q = (arr, p) => arr[Math.floor(arr.length * p)] ?? 0;
  console.log(`${label}: n=${sims.length}`);
  console.log(`  min=${sims[0]?.toFixed(4)} p10=${q(sims, .1).toFixed(4)} p25=${q(sims, .25).toFixed(4)} median=${q(sims, .5).toFixed(4)} p75=${q(sims, .75).toFixed(4)} max=${sims[sims.length - 1]?.toFixed(4)}`);
  return sims;
}

const sameSims = await calibrate(knownSame, 'known-SAME (3/3 models agree: duplicate)');
const burstSims = await calibrate(knownBurst, 'known-BURST (3/3 models agree: burst)');

// empirical threshold: midpoint between the classes' overlap region
// same-class p10 vs burst-class max — if they overlap heavily, similarity alone can't separate
const sameLow = sameSims[Math.floor(sameSims.length * 0.10)];
const burstHigh = burstSims[burstSims.length - 1];
const separation = sameLow - burstHigh;
const SAME_THRESHOLD = sameLow;  // conservative: must beat the 10th percentile of true duplicates

console.log(`\n  separation check: same-p10 ${sameLow?.toFixed(4)} vs burst-max ${burstHigh?.toFixed(4)} → gap ${separation.toFixed(4)}`);
console.log(`  SAME_THRESHOLD = ${SAME_THRESHOLD.toFixed(4)} (disputed pair must exceed same-class p10)`);
console.log(separation > 0.01
  ? '  classes separate cleanly ✓'
  : '  ⚠️ overlap — similarity alone is NOT sufficient; require Eye.duplicates corroboration\n');

// ─── Phase B: tiebreak the 856 groups ───
console.log('\n═══ Phase B: tiebreaking disagreement groups ═══\n');

const verdicts = [];
let n = 0;

for (const g of reviewGroups) {
  n++;
  if (n % 25 === 0) console.log(`  [${n}/${reviewGroups.length}]...`);

  const keeperId = g.keeper.id;
  const disputed = g.recommendation.needsReview;
  const groupVerdict = {
    duplicateId: g.duplicateId,
    keeperId,
    keeperName: g.keeper.name,
    // decisions the 3 Clef models already agreed on for the rest of the group
    consensusKeepIds: [...g.recommendation.keepIds, ...g.recommendation.stackIds],
    consensusTrashIds: g.recommendation.trashIds,
    clefMajority: g.comparisons.map(c => ({
      other: c.otherName,
      votes: c.consensus.classifications.join(','),
    })),
    assets: [],
    verdict: null,
  };

  // analyze all assets in the group
  const ids = [keeperId, ...disputed.map(d => d.id)];
  const eyeAssets = [];
  const times = [];
  for (const id of ids) {
    try {
      const [a, t] = await Promise.all([analyzeAsset(id), getCaptureTime(id)]);
      eyeAssets.push(a);
      times.push(t);
    } catch (e) {
      eyeAssets.push(null);
      times.push(null);
    }
  }

  // Eye's own grouping + best, over the whole group at once (only when every asset analyzed,
  // so indices line up with `ids`)
  let eyeGroups = null, bestIdx = null;
  try {
    if (eyeAssets.every(Boolean) && eyeAssets.length >= 2) {
      eyeGroups = Eye.duplicates(eyeAssets, { dates: times });
      bestIdx = Eye.best(eyeAssets);
    }
  } catch { /* optional */ }

  // per-asset similarity vs keeper
  const keeperAnalysis = eyeAssets[0];
  for (let i = 1; i < ids.length; i++) {
    const a = eyeAssets[i];
    if (!keeperAnalysis || !a) {
      groupVerdict.assets.push({ id: ids[i], error: 'analysis failed' });
      continue;
    }
    const sim = keeperAnalysis.similarity(a);
    if (sim === null) {
      groupVerdict.assets.push({ id: ids[i], error: 'no embedding' });
      continue;
    }
    let eyeVerdict;
    if (sim >= SAME_THRESHOLD && separation > 0.01) {
      eyeVerdict = 'same';          // Eye says: duplicate of keeper → trash
    } else if (sim >= SAME_THRESHOLD) {
      eyeVerdict = sim >= 0.995 ? 'same' : 'uncertain-close';
    } else {
      eyeVerdict = 'different';     // below duplicate range → different frame → keep/stack
    }
    // corroborate with Eye.duplicates: did Eye group them together?
    const inSameEyeGroup = eyeGroups ? eyeGroups.some(gr => gr.includes(0) && gr.includes(i)) : null;

    groupVerdict.assets.push({
      id: ids[i],
      name: g.others.find(o => o.id === ids[i])?.name,
      similarity: Number(sim.toFixed(4)),
      eyeVerdict,
      eyeDuplicatesGrouped: inSameEyeGroup,
      aesthetic: a.scores?.aesthetic?.toFixed(3),
      keeperAesthetic: keeperAnalysis.scores?.aesthetic?.toFixed(3),
    });
  }

  // Eye's keeper preference (may differ from largest-file)
  if (bestIdx !== null && bestIdx > 0) {
    groupVerdict.eyePrefers = ids[bestIdx];
    groupVerdict.eyePrefersName = g.others.find(o => o.id === ids[bestIdx])?.name || 'disputed asset';
  }

  // aggregate verdict per group
  const allSame = groupVerdict.assets.length > 0 && groupVerdict.assets.every(a => a.eyeVerdict === 'same');
  const allDifferent = groupVerdict.assets.length > 0 && groupVerdict.assets.every(a => a.eyeVerdict === 'different');
  const mixed = !allSame && !allDifferent;
  groupVerdict.verdict = allSame ? 'TRASH-ALL' : allDifferent ? 'KEEP-ALL' : mixed ? 'MIXED' : 'UNCLEAR';
  verdicts.push(groupVerdict);
}

// ─── report ───
const counts = { 'TRASH-ALL': 0, 'KEEP-ALL': 0, 'MIXED': 0, 'UNCLEAR': 0 };
for (const v of verdicts) counts[v.verdict]++;
const eyeSwaps = verdicts.filter(v => v.eyePrefers).length;

console.log('\n═══ Tiebreak report ═══\n');
console.log(`  groups: ${verdicts.length}`);
console.log(`  TRASH-ALL (Eye: all disputes are duplicates): ${counts['TRASH-ALL']}`);
console.log(`  KEEP-ALL  (Eye: all disputes are different frames): ${counts['KEEP-ALL']}`);
console.log(`  MIXED     (some same, some different): ${counts['MIXED']}`);
console.log(`  UNCLEAR:  ${counts['UNCLEAR']}`);
console.log(`  Eye prefers a different keeper than largest-file: ${eyeSwaps} groups`);
console.log(`\n  elapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min — local inference, $0 API cost`);

await writeFile('eye-tiebreak-results.json', JSON.stringify({
  calibration: {
    sameSims: sameSims.map(s => Number(s.toFixed(4))),
    burstSims: burstSims.map(s => Number(s.toFixed(4))),
    sameThreshold: Number(SAME_THRESHOLD.toFixed(4)),
    separation: Number(separation.toFixed(4)),
  },
  verdicts,
}, null, 2));
console.log('\n  results: eye-tiebreak-results.json');
console.log(apply ? '\n  (--apply given — see below)' : '\n  (collect-only — review eye-tiebreak-results.json, then run with --apply)');

// ─── apply ───
if (apply) {
  console.log('\n═══ Applying confident verdicts ═══\n');
  // Only TRASH-ALL groups where Eye corroborated via duplicates() grouping on every asset
  const toResolve = [];
  const toKeep = [];
  for (const v of verdicts) {
    if (v.verdict === 'TRASH-ALL' && v.assets.every(a => a.eyeDuplicatesGrouped === true)) {
      // Every disputed asset is a duplicate of the size-keeper. Combine with the decisions Clef
      // already agreed on for the rest of the group, so no asset is left out of the resolve.
      // If Eye prefers one of the disputed assets, keep it and trash the size-keeper instead.
      const keeper = v.eyePrefers || v.keeperId;
      const keep = [keeper, ...v.consensusKeepIds.filter(id => id !== v.keeperId)];
      const trash = [...v.consensusTrashIds, ...v.assets.map(a => a.id)].filter(id => id !== keeper);
      if (keeper !== v.keeperId) trash.push(v.keeperId);
      toResolve.push({ duplicateId: v.duplicateId, keepAssetIds: keep, trashAssetIds: trash });
    } else if (v.verdict === 'KEEP-ALL') {
      toKeep.push(v.duplicateId);  // dismissed — different frames, leave as-is or stack later
    }
  }
  console.log(`  resolving ${toResolve.length} groups (trash ${toResolve.reduce((s, r) => s + r.trashAssetIds.length, 0)} assets)`);
  console.log(`  leaving ${toKeep.length} KEEP-ALL groups untouched (different frames — Immich keeps them flagged)`);
  if (toResolve.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < toResolve.length; i += BATCH) {
      await resolveDuplicates(toResolve.slice(i, i + BATCH));
      console.log(`    batch ${Math.floor(i / BATCH) + 1} done`);
    }
  }
  console.log('\n  ✅ apply complete');
}

eye.dispose();
process.exit(0);
