// pipeline.js — collect results from all 3 Clef models for all duplicate groups
//
// Supports groups with 2+ assets (multi-duplicate groups).
// For each group: pick the keeper (largest file), compare keeper vs each remaining asset.
//
// Usage:
//   npm run pipeline              (all groups)
//   npm run pipeline -- 50       (first 50 groups only)
//   npm run pipeline -- --apply  (also apply consensus decisions)

import { getDuplicateGroups, getAssetThumbnail, resolveDuplicates, createStack } from './immich.js';
import { askClef, DUPLICATE_QUESTIONS } from './clef.js';
import { jpegDataUri } from './convert.js';
import { writeFile, readFile } from 'fs/promises';

const STATE = 'Compare two photos. Photo A is the first image (the probable original). Photo B is the second image. Assess whether they are the same exact photo (identical or near-identical), different frames of the same moment (burst photography), or genuinely different photos. Also assess which photo has better technical quality.';

const MODELS = ['clef', 'omni', 'flash'];
const MODEL_NAMES = { clef: 'Clef (27B)', omni: 'Clef-omni (30B)', flash: 'Clef-flash (9B)' };
const MODEL_PRICING = { clef: 0.24, omni: 0.15, flash: 0.038 };

// ─── parse ───

function parseDecision(resp) {
  const answers = resp?.result?.answers || resp?.answers;
  if (!answers) return null;
  const cls = answers.classification || {};
  const qly = answers.quality || {};
  return {
    classification: cls.choice || 'unknown',
    classificationProb: (cls.probabilities || {})[cls.choice] || 0,
    classificationConfidence: cls.confidence || 0,
    classificationProbs: cls.probabilities || {},
    quality: qly.choice || 'unknown',
    qualityProb: (qly.probabilities || {})[qly.choice] || 0,
    qualityConfidence: qly.confidence || 0,
    inputTokens: (resp?.result?.usage || resp?.usage)?.input_tokens || 0,
  };
}

// ─── multi-asset group processing ───

/**
 * Pick the keeper for a group: the asset with the largest file size.
 * Returns {keeper, others[]} — keeper is the likely original.
 */
function pickKeeper(assets) {
  const sorted = [...assets].sort((a, b) => {
    const aSize = a.exifInfo?.fileSizeInByte || 0;
    const bSize = b.exifInfo?.fileSizeInByte || 0;
    return bSize - aSize;
  });
  return {
    keeper: sorted[0],
    others: sorted.slice(1),
  };
}

/**
 * Compare keeper against one other asset via all 3 models.
 * Returns a comparison entry with per-model decisions and consensus.
 */
async function compareWithAllModels(keeperThumb, otherThumb) {
  const uris = [jpegDataUri(keeperThumb.base64), jpegDataUri(otherThumb.base64)];

  const responses = await Promise.allSettled(
    MODELS.map(m => askClef(m, STATE, uris, DUPLICATE_QUESTIONS))
  );

  const entry = {};
  for (let j = 0; j < MODELS.length; j++) {
    const model = MODELS[j];
    const result = responses[j];
    if (result.status === 'fulfilled') {
      entry[model] = parseDecision(result.value);
      entry[`${model}Latency`] = result.value._latency;
    } else {
      entry[model] = null;
      entry[`${model}Error`] = result.reason?.message?.slice(0, 200) || 'unknown';
    }
  }

  // consensus for this comparison
  const classifications = MODELS.map(m => entry[m]?.classification).filter(Boolean);
  const allAgree = classifications.length === MODELS.length &&
                    classifications.every(c => c === classifications[0]);

  return { ...entry, consensus: { allAgree, classification: allAgree ? classifications[0] : null, classifications } };
}

/**
 * Process a group of any size:
 * 1. Pick keeper (largest file)
 * 2. Compare keeper vs each other asset
 * 3. Aggregate decisions for the group
 * Returns a group result with per-comparison decisions and overall recommendation.
 */
async function processGroup(group, thumbnails) {
  const { keeper, others } = pickKeeper(group.assets);

  const groupResult = {
    duplicateId: group.duplicateId,
    keeper: { id: keeper.id, name: keeper.originalFileName, size: keeper.exifInfo?.fileSizeInByte || 0 },
    others: others.map(a => ({ id: a.id, name: a.originalFileName, size: a.exifInfo?.fileSizeInByte || 0 })),
    comparisons: [],
  };

  for (const other of others) {
    const comp = await compareWithAllModels(thumbnails.get(keeper.id), thumbnails.get(other.id));
    comp.otherId = other.id;
    comp.otherName = other.originalFileName;
    comp.otherSize = other.exifInfo?.fileSizeInByte || 0;
    groupResult.comparisons.push(comp);
  }

  // aggregate group recommendation
  const trashIds = [];
  const stackIds = [];
  const keepIds = [keeper.id];
  const needsReview = [];

  for (const comp of groupResult.comparisons) {
    if (comp.consensus.allAgree) {
      switch (comp.consensus.classification) {
        case 'same':
          trashIds.push(comp.otherId);
          break;
        case 'burst':
          stackIds.push(comp.otherId);
          break;
        case 'different':
          keepIds.push(comp.otherId);
          break;
        default:
          needsReview.push({ id: comp.otherId, reason: `unknown classification: ${comp.consensus.classification}` });
      }
    } else {
      needsReview.push({ id: comp.otherId, reason: 'model disagreement' });
    }
  }

  groupResult.recommendation = { trashIds, stackIds, keepIds, needsReview };
  return groupResult;
}

// ─── stats helpers ───

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil(sortedArr.length * p / 100) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

// ─── main ───

async function main() {
  const args = process.argv.slice(2);
  const maxGroups = args.length > 0 && !isNaN(parseInt(args[0])) ? parseInt(args[0]) : null;
  const apply = args.includes('--apply');

  const pipelineStart = Date.now();

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Clef 3-Model Ensemble — Duplicate Resolution       ║');
  console.log('║  (multi-asset group support)                        ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Models:  ${MODELS.map(m => MODEL_NAMES[m]).join(' + ')}${' '.repeat(Math.max(0, 24 - MODELS.map(m => MODEL_NAMES[m]).join(' + ').length))}║`);
  console.log(`║  Groups:  ${maxGroups ? `first ${maxGroups}` : 'all'}${' '.repeat(45 - (maxGroups ? `first ${maxGroups}` : 'all').length)}║`);
  console.log(`║  Mode:    ${apply ? 'COLLECT + APPLY consensus' : 'COLLECT only (no changes)'}${' '.repeat(Math.max(0, 22 - (apply ? 'COLLECT + APPLY consensus'.length : 'COLLECT only'.length)))}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 1. Fetch ALL duplicate groups (any size)
  console.log('1. Fetching duplicate groups...');
  const groups = await getDuplicateGroups();

  const eligible = groups.filter(g => g.assets?.length >= 2);
  const limited = maxGroups ? eligible.slice(0, maxGroups) : eligible;

  const groupSizes = {};
  for (const g of eligible) {
    const size = g.assets.length;
    groupSizes[size] = (groupSizes[size] || 0) + 1;
  }

  console.log(`   ${eligible.length} total groups:`);
  for (const [size, count] of Object.entries(groupSizes).sort()) {
    console.log(`     ${size}-asset groups: ${count}`);
  }
  console.log(`   processing ${limited.length} groups\n`);

  // resume support
  let existingResults = [];
  try {
    existingResults = JSON.parse(await readFile('pipeline-results.json', 'utf8'));
    console.log(`   found ${existingResults.length} existing results — resuming\n`);
  } catch { /* no existing results */ }

  const results = [...existingResults];
  const startPos = existingResults.length;

  // 2. Process each group
  console.log(`2. Processing ${limited.length} groups with ${MODELS.length} models...\n`);

  for (let i = startPos; i < limited.length; i++) {
    const group = limited[i];
    const assetCount = group.assets.length;
    const comparisonsNeeded = assetCount - 1;
    const names = group.assets.map(a => a.originalFileName).join(', ');

    if (i % 10 === 0 || i === startPos) {
      const pct = ((i - startPos) / (limited.length - startPos) * 100).toFixed(0);
      console.log(`   [${i + 1}/${limited.length}] ${pct}% — ${assetCount} assets, ${comparisonsNeeded} comparisons — ${names.slice(0, 60)}`);
    }

    try {
      // download all thumbnails for this group
      const thumbPromises = group.assets.map(a => getAssetThumbnail(a.id, 'preview'));
      const thumbs = await Promise.all(thumbPromises);
      const thumbMap = new Map();
      group.assets.forEach((a, j) => thumbMap.set(a.id, thumbs[j]));

      // process the group
      results.push(await processGroup(group, thumbMap));

    } catch (err) {
      results.push({ duplicateId: group.duplicateId, error: err.message.slice(0, 300) });
    }

    if ((i - startPos) % 25 === 24) {
      await writeFile('pipeline-results.json', JSON.stringify(results, null, 2));
    }

    await new Promise(r => setTimeout(r, 400));
  }

  await writeFile('pipeline-results.json', JSON.stringify(results, null, 2));

  const pipelineElapsed = Date.now() - pipelineStart;

  // ─── 3. Analysis ───
  console.log('\n\n3. ═══════════════════════════════════════════════════════');
  console.log('    A N A L Y S I S');
  console.log('    ═════════════════════════════════════════════════════\n');

  const valid = results.filter(r => !r.error && r.comparisons);
  const errored = results.filter(r => r.error);

  // Build per-model stats from ALL results, including groups loaded from a
  // previous (resumed) run. Collecting these inside the loop only covered the
  // groups processed in this invocation, while the outcome section below
  // covers every group — which made the two halves of the report disagree.
  const modelStats = {};
  for (const m of MODELS) {
    modelStats[m] = { latencies: [], tokens: [], errors: 0, classifications: [], classConfidences: [] };
  }
  let comparisonCount = 0;
  for (const r of valid) {
    for (const comp of r.comparisons) {
      comparisonCount++;
      for (const m of MODELS) {
        const s = modelStats[m];
        if (comp[`${m}Error`]) { s.errors++; continue; }
        if (!comp[m]) continue;
        s.latencies.push(comp[`${m}Latency`] || 0);
        s.tokens.push(comp[m].inputTokens || 0);
        s.classifications.push(comp[m].classification || 'unknown');
        s.classConfidences.push(comp[m].classificationConfidence || 0);
      }
    }
  }

  if (existingResults.length > 0) {
    console.log(`  (stats include ${existingResults.length} groups resumed from pipeline-results.json)\n`);
  }

  // per-model performance
  console.log('  ━━━━ Per-Model Performance ━━━━\n');
  console.log(`  ${'Model'.padEnd(18)} ${'Calls'.padEnd(7)} ${'Avg(ms)'.padEnd(10)} ${'Med(ms)'.padEnd(10)} ${'P95(ms)'.padEnd(10)} ${'Cost/comp'.padEnd(11)} ${'Total cost'.padEnd(11)} ${'Errors'.padEnd(7)} ${'Avg conf'.padEnd(9)}`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(7)} ${'─'.repeat(9)}`);

  let totalCostAll = 0;
  for (const m of MODELS) {
    const s = modelStats[m];
    const calls = s.latencies.length;
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const avgLat = avg(s.latencies);
    const medLat = percentile(sorted, 50);
    const p95Lat = percentile(sorted, 95);
    const avgTok = avg(s.tokens);
    const totalTok = s.tokens.reduce((sum, v) => sum + v, 0);
    const costPer = calls > 0 ? (avgTok * MODEL_PRICING[m] / 1_000_000) : 0;
    const totalCost = totalTok * MODEL_PRICING[m] / 1_000_000;
    totalCostAll += totalCost;
    const avgConf = avg(s.classConfidences);

    console.log(`  ${MODEL_NAMES[m].padEnd(18)} ${String(calls).padEnd(7)} ${avgLat.toFixed(0).padEnd(10)} ${medLat.toFixed(0).padEnd(10)} ${p95Lat.toFixed(0).padEnd(10)} $${costPer.toFixed(5).padEnd(10)} $${totalCost.toFixed(2).padEnd(10)} ${String(s.errors).padEnd(7)} ${avgConf.toFixed(3).padEnd(9)}`);
  }
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(11)} $${totalCostAll.toFixed(2).padEnd(10)}`);
  console.log(`\n  Total comparisons: ${comparisonCount} (across ${valid.length} groups)`);
  console.log(`  Total API cost:  $${totalCostAll.toFixed(2)}`);
  console.log(`  Wall-clock time: ${(pipelineElapsed / 1000).toFixed(0)}s (${(pipelineElapsed / 60000).toFixed(1)} min)`);

  // group outcomes
  console.log('\n  ━━━━ Group Outcomes ━━━━\n');

  let totalTrash = 0, totalStack = 0, totalKeep = 0, totalReview = 0;
  const groupsByOutcome = { 'full-consensus': 0, 'mixed': 0, 'no-consensus': 0 };

  for (const r of valid) {
    totalTrash += r.recommendation.trashIds.length;
    totalStack += r.recommendation.stackIds.length;
    totalKeep += r.recommendation.keepIds.length;
    totalReview += r.recommendation.needsReview.length;

    const allComparisonsAgree = r.comparisons.every(c => c.consensus.allAgree);
    const noComparisonsAgree = r.comparisons.every(c => !c.consensus.allAgree);
    if (allComparisonsAgree) groupsByOutcome['full-consensus']++;
    else if (noComparisonsAgree) groupsByOutcome['no-consensus']++;
    else groupsByOutcome['mixed']++;
  }

  console.log(`  Full consensus groups:  ${groupsByOutcome['full-consensus']} (all comparisons agree)`);
  console.log(`  Mixed groups:           ${groupsByOutcome['mixed']} (some agree, some don't)`);
  console.log(`  No-consensus groups:    ${groupsByOutcome['no-consensus']} (no comparisons agree)`);
  console.log(`  Errored groups:         ${errored.length}`);
  console.log(`\n  Asset outcomes:`);
  console.log(`    → Trash (duplicates):    ${totalTrash}`);
  console.log(`    → Stack (burst photos):  ${totalStack}`);
  console.log(`    → Keep (different):      ${totalKeep}`);
  console.log(`    → Needs review:          ${totalReview}`);

  // classification distribution
  console.log('\n  ━━━━ Classification Distribution ━━━━\n');
  const clsTypes = ['same', 'burst', 'different', 'unknown'];
  console.log(`  ${'Model'.padEnd(18)} ${clsTypes.map(c => c.padEnd(11)).join(' ')}`);
  console.log(`  ${'─'.repeat(18)} ${clsTypes.map(() => '─'.repeat(11)).join(' ')}`);
  for (const m of MODELS) {
    const dist = {};
    for (const c of modelStats[m].classifications) {
      dist[c] = (dist[c] || 0) + 1;
    }
    console.log(`  ${MODEL_NAMES[m].padEnd(18)} ${clsTypes.map(c => String(dist[c] || 0).padEnd(11)).join(' ')}`);
  }

  // ─── apply if requested ───
  if (apply && valid.length > 0) {
    console.log(`\n4. Applying consensus decisions...\n`);

    const resolveGroups = [];
    const stackRequests = [];

    for (const r of valid) {
      const rec = r.recommendation;

      // Resolving a group clears Immich's duplicate flag for every asset in it, so
      // groups with disputed assets are left for manual review / eye-tiebreak.
      if (rec.trashIds.length > 0 && rec.needsReview.length === 0) {
        resolveGroups.push({
          duplicateId: r.duplicateId,
          keepAssetIds: rec.keepIds,
          trashAssetIds: rec.trashIds,
        });
      }

      if (rec.stackIds.length > 0) {
        const stackAssets = [r.keeper.id, ...rec.stackIds];
        stackRequests.push(stackAssets);
      }
    }

    const BATCH = 100;
    let applied = 0;
    for (let i = 0; i < resolveGroups.length; i += BATCH) {
      const batch = resolveGroups.slice(i, i + BATCH);
      try {
        await resolveDuplicates(batch);
        applied += batch.length;
        console.log(`   resolved ${applied}/${resolveGroups.length} groups`);
      } catch (err) {
        console.log(`   ⚠️ batch failed: ${err.message.slice(0, 200)}`);
      }
    }

    for (const ids of stackRequests) {
      try { await createStack(ids); }
      catch (err) { console.log(`   ⚠️ stack failed: ${err.message.slice(0, 200)}`); }
    }

    console.log(`\n   ✅ Applied: ${applied} group resolves + ${stackRequests.length} stacks`);
  } else if (!apply) {
    const actionable = valid.filter(r => (r.recommendation.trashIds.length > 0 && r.recommendation.needsReview.length === 0) || r.recommendation.stackIds.length > 0);
    console.log(`\n  (run with --apply to act on ${actionable.length} groups with consensus)`);
  }

  console.log(`\n  Results: pipeline-results.json`);
  console.log(`  Cost: $${totalCostAll.toFixed(2)}`);
  console.log('\n═══ DONE ═══\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
