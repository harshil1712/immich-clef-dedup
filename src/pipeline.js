// pipeline.js — collect results from all 3 Clef models for all duplicate pairs
//
// No destructive actions. Pure data collection + analysis.
// Auto-resolve only where ALL 3 models agree.
//
// Usage:
//   npm run pipeline              (all pairs)
//   npm run pipeline -- 50       (first 50 pairs only)
//   npm run pipeline -- --apply  (also apply consensus decisions)

import { getDuplicateGroups, getAssetThumbnail, resolveDuplicates, createStack } from './immich.js';
import { askClef, DUPLICATE_QUESTIONS } from './clef.js';
import { jpegDataUri } from './convert.js';
import { writeFile, readFile } from 'fs/promises';

const STATE = 'Compare two photos. Photo A is the first image, Photo B is the second image. Assess whether they are the same photo, different frames of the same moment (burst), or different photos. Also assess which photo has better quality.';

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

function analyzeConsensus(r) {
  const classifications = MODELS.map(m => r[m]?.classification).filter(Boolean);
  const qualities = MODELS.map(m => r[m]?.quality).filter(Boolean);

  const allAgree = classifications.length === MODELS.length &&
                    classifications.every(c => c === classifications[0]);
  const qualityAgrees = qualities.length === MODELS.length &&
                        qualities.every(q => q === qualities[0]);

  let consensus = null;
  if (allAgree) {
    consensus = classifications[0];
    if (qualityAgrees) {
      consensus += ` / ${qualities[0]}`;
    }
  }

  return { allAgree, qualityAgrees, consensus, classifications, qualities };
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
  const maxPairs = args.length > 0 && !isNaN(parseInt(args[0])) ? parseInt(args[0]) : null;
  const apply = args.includes('--apply');

  const pipelineStart = Date.now();

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Clef 3-Model Ensemble — Duplicate Resolution       ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Models:  ${MODELS.map(m => MODEL_NAMES[m]).join(' + ')}${' '.repeat(Math.max(0, 24 - MODELS.map(m => MODEL_NAMES[m]).join(' + ').length))}║`);
  console.log(`║  Pairs:   ${maxPairs ? `first ${maxPairs}` : 'all'}${' '.repeat(45 - (maxPairs ? `first ${maxPairs}` : 'all').length)}║`);
  console.log(`║  Mode:    ${apply ? 'COLLECT + APPLY consensus' : 'COLLECT only (no changes)'}${' '.repeat(Math.max(0, 22 - (apply ? 'COLLECT + APPLY consensus'.length : 'COLLECT only'.length)))}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 1. Fetch pairs
  console.log('1. Fetching duplicate groups...');
  const groups = await getDuplicateGroups();
  const allPairs = groups.filter(g => g.assets?.length === 2);
  const pairs = maxPairs ? allPairs.slice(0, maxPairs) : allPairs;
  console.log(`   ${allPairs.length} total, processing ${pairs.length}\n`);

  // resume support
  let existingResults = [];
  try {
    existingResults = JSON.parse(await readFile('pipeline-results.json', 'utf8'));
    console.log(`   found ${existingResults.length} existing results — resuming\n`);
  } catch { /* no existing results */ }

  const results = [...existingResults];
  const startPos = existingResults.length;

  // 2. Collect
  console.log(`2. Collecting decisions from ${MODELS.length} models...\n`);

  for (let i = startPos; i < pairs.length; i++) {
    const pair = pairs[i];
    const [assetA, assetB] = pair.assets;
    const label = `${assetA.originalFileName} vs ${assetB.originalFileName}`;

    if (i % 10 === 0 || i === startPos) {
      const pct = ((i - startPos) / (pairs.length - startPos) * 100).toFixed(0);
      console.log(`   [${i + 1}/${pairs.length}] ${pct}% — ${label}`);
    }

    try {
      const [tA, tB] = await Promise.all([
        getAssetThumbnail(assetA.id, 'preview'),
        getAssetThumbnail(assetB.id, 'preview'),
      ]);
      const uris = [jpegDataUri(tA.base64), jpegDataUri(tB.base64)];

      // all 3 models in parallel
      const responses = await Promise.allSettled(
        MODELS.map(m => askClef(m, STATE, uris, DUPLICATE_QUESTIONS))
      );

      const entry = {
        duplicateId: pair.duplicateId,
        pair: label,
        assetA: { id: assetA.id, name: assetA.originalFileName, size: assetA.exifInfo?.fileSizeInByte || 0 },
        assetB: { id: assetB.id, name: assetB.originalFileName, size: assetB.exifInfo?.fileSizeInByte || 0 },
      };

      for (let j = 0; j < MODELS.length; j++) {
        const model = MODELS[j];
        const result = responses[j];

        if (result.status === 'fulfilled') {
          const parsed = parseDecision(result.value);
          entry[model] = parsed;
          entry[`${model}Latency`] = result.value._latency;
        } else {
          entry[model] = null;
          entry[`${model}Error`] = result.reason?.message?.slice(0, 200) || 'unknown';
        }
      }

      entry.consensus = analyzeConsensus(entry);
      results.push(entry);

    } catch (err) {
      results.push({ duplicateId: pair.duplicateId, pair: label, error: err.message.slice(0, 300) });
    }

    if ((i - startPos) % 50 === 49) {
      await writeFile('pipeline-results.json', JSON.stringify(results, null, 2));
    }

    await new Promise(r => setTimeout(r, 400));
  }

  // final save
  await writeFile('pipeline-results.json', JSON.stringify(results, null, 2));

  const pipelineElapsed = Date.now() - pipelineStart;

  // ─── 3. Analysis ───
  console.log('\n\n3. ═════════════════════════════════════════════════════');
  console.log('    A N A L Y S I S');
  console.log('    ═════════════════════════════════════════════════════\n');

  const valid = results.filter(r => !r.error && r.consensus);
  const errored = results.filter(r => r.error);

  // Build per-model stats from ALL results, including pairs loaded from a
  // previous (resumed) run. Collecting these inside the loop only covered the
  // pairs processed in this invocation, while the consensus section below
  // covers every pair — which made the two halves of the report disagree.
  const modelData = {};
  for (const m of MODELS) {
    modelData[m] = {
      latencies: [],
      tokens: [],
      classifications: [],
      qualities: [],
      classConfidences: [],
      qualityConfidences: [],
      errors: 0,
    };
  }
  for (const r of results) {
    if (r.error) continue;
    for (const m of MODELS) {
      const d = modelData[m];
      if (r[`${m}Error`]) { d.errors++; continue; }
      if (r[`${m}Latency`] === undefined) continue;
      const parsed = r[m];
      d.latencies.push(r[`${m}Latency`]);
      d.tokens.push(parsed?.inputTokens || 0);
      d.classifications.push(parsed?.classification || 'unknown');
      d.qualities.push(parsed?.quality || 'unknown');
      d.classConfidences.push(parsed?.classificationConfidence || 0);
      d.qualityConfidences.push(parsed?.qualityConfidence || 0);
    }
  }

  const resumedCount = existingResults.length;
  if (resumedCount > 0) {
    console.log(`  (stats include ${resumedCount} pairs resumed from pipeline-results.json)\n`);
  }

  // ── Per-Model Performance Table ──
  console.log('  ━━━━ Per-Model Performance ━━━━\n');
  console.log(`  ${'Model'.padEnd(18)} ${'Calls'.padEnd(7)} ${'Avg(ms)'.padEnd(10)} ${'Med(ms)'.padEnd(10)} ${'P95(ms)'.padEnd(10)} ${'Avg tok'.padEnd(10)} ${'Cost/pair'.padEnd(11)} ${'Total cost'.padEnd(11)} ${'Errors'.padEnd(7)} ${'Avg conf'.padEnd(9)}`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(7)} ${'─'.repeat(9)}`);

  let totalCostAll = 0;
  for (const m of MODELS) {
    const d = modelData[m];
    const calls = d.latencies.length;
    const sorted = [...d.latencies].sort((a, b) => a - b);
    const avgLat = avg(d.latencies);
    const medLat = percentile(sorted, 50);
    const p95Lat = percentile(sorted, 95);
    const avgTok = avg(d.tokens);
    const totalTok = d.tokens.reduce((s, v) => s + v, 0);
    const costPerPair = calls > 0 ? (avgTok * MODEL_PRICING[m] / 1_000_000) : 0;
    const totalCost = totalTok * MODEL_PRICING[m] / 1_000_000;
    totalCostAll += totalCost;
    const avgConf = avg(d.classConfidences);

    console.log(
      `  ${MODEL_NAMES[m].padEnd(18)} ${String(calls).padEnd(7)} ${avgLat.toFixed(0).padEnd(10)} ${medLat.toFixed(0).padEnd(10)} ${p95Lat.toFixed(0).padEnd(10)} ${avgTok.toFixed(0).padEnd(10)} $${costPerPair.toFixed(5).padEnd(10)} $${totalCost.toFixed(2).padEnd(10)} ${String(d.errors).padEnd(7)} ${avgConf.toFixed(3).padEnd(9)}`
    );
  }
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(11)} $${totalCostAll.toFixed(2).padEnd(10)}`);

  console.log(`\n  Total API cost:  $${totalCostAll.toFixed(2)}`);
  console.log(`  Wall-clock time: ${(pipelineElapsed / 1000).toFixed(0)}s (${(pipelineElapsed / 60000).toFixed(1)} min)${resumedCount ? ' — this invocation only' : ''}`);

  // ── Classification Distribution ──
  console.log('\n  ━━━━ Classification Distribution ━━━━\n');
  const clsTypes = ['same', 'burst', 'different', 'unknown'];
  console.log(`  ${'Model'.padEnd(18)} ${clsTypes.map(c => c.padEnd(11)).join(' ')}`);
  console.log(`  ${'─'.repeat(18)} ${clsTypes.map(() => '─'.repeat(11)).join(' ')}`);

  for (const m of MODELS) {
    const dist = {};
    for (const c of modelData[m].classifications) {
      dist[c] = (dist[c] || 0) + 1;
    }
    console.log(`  ${MODEL_NAMES[m].padEnd(18)} ${clsTypes.map(c => String(dist[c] || 0).padEnd(11)).join(' ')}`);
  }

  // ── Per-Classification Confidence ──
  console.log('\n  ━━━━ Confidence by Classification ━━━━\n');
  console.log(`  ${'Model'.padEnd(18)} ${'same conf'.padEnd(12)} ${'burst conf'.padEnd(12)} ${'diff conf'.padEnd(12)} ${'avg conf'.padEnd(10)}`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(10)}`);

  for (const m of MODELS) {
    const d = modelData[m];
    const confsByCls = { same: [], burst: [], different: [] };
    for (let i = 0; i < d.classifications.length; i++) {
      const cls = d.classifications[i];
      if (confsByCls[cls]) confsByCls[cls].push(d.classConfidences[i]);
    }
    const sameConf = avg(confsByCls.same);
    const burstConf = avg(confsByCls.burst);
    const diffConf = avg(confsByCls.different);
    const avgAll = avg(d.classConfidences);
    console.log(`  ${MODEL_NAMES[m].padEnd(18)} ${sameConf.toFixed(3).padEnd(12)} ${burstConf.toFixed(3).padEnd(12)} ${diffConf.toFixed(3).padEnd(12)} ${avgAll.toFixed(3).padEnd(10)}`);
  }

  // ── Pairwise Agreement Matrix ──
  console.log('\n  ━━━━ Pairwise Model Agreement ━━━━\n');

  for (let i = 0; i < MODELS.length; i++) {
    for (let j = i + 1; j < MODELS.length; j++) {
      const m1 = MODELS[i], m2 = MODELS[j];
      let agree = 0, total = 0;
      for (const r of valid) {
        if (r[m1] && r[m2]) {
          total++;
          if (r[m1].classification === r[m2].classification) agree++;
        }
      }
      console.log(`  ${MODEL_NAMES[m1]} ↔ ${MODEL_NAMES[m2]}: ${agree}/${total} agree (${(agree / (total || 1) * 100).toFixed(1)}%)`);
    }
  }

  // ── 3-Way Consensus ──
  console.log('\n  ━━━━ 3-Way Consensus ━━━━\n');

  const fullAgreement = valid.filter(r => r.consensus.allAgree);
  const partialAgreement = valid.filter(r => !r.consensus.allAgree && r.consensus.classifications.length > 1);
  const noData = valid.filter(r => r.consensus.classifications.length === 0);

  console.log(`  All 3 agree:     ${fullAgreement.length}/${valid.length} (${(fullAgreement.length / (valid.length || 1) * 100).toFixed(1)}%)`);
  console.log(`  Partial agree:   ${partialAgreement.length}/${valid.length} (${(partialAgreement.length / (valid.length || 1) * 100).toFixed(1)}%)`);
  console.log(`  No data:         ${noData.length}/${valid.length}`);
  console.log(`  Errors:          ${errored.length}`);

  if (partialAgreement.length > 0) {
    console.log('\n  ━━━━ Disagreements ━━━━\n');
    for (const r of partialAgreement.slice(0, 20)) { // first 20
      console.log(`  ${r.pair}`);
      for (const m of MODELS) {
        if (r[m]) {
          console.log(`    ${MODEL_NAMES[m].padEnd(18)} ${r[m].classification} (p=${r[m].classificationProb.toFixed(2)}, c=${r[m].classificationConfidence.toFixed(3)})`);
        }
      }
    }
    if (partialAgreement.length > 20) {
      console.log(`  ... and ${partialAgreement.length - 20} more (see pipeline-results.json)`);
    }
  }

  // ── Consensus Groups ──
  if (fullAgreement.length > 0) {
    console.log('\n  ━━━━ Consensus Groups (all 3 agree) ━━━━\n');
    const groups = {};
    for (const r of fullAgreement) {
      const key = r.consensus.classifications[0];
      groups[key] = (groups[key] || 0) + 1;
    }
    for (const [cls, count] of Object.entries(groups)) {
      console.log(`  ${cls}: ${count} pairs`);
    }
  }

  // ── Safe to Apply ──
  const safeToResolve = fullAgreement.filter(r =>
    r.consensus.classifications[0] === 'same'
  );
  const safeToStack = fullAgreement.filter(r =>
    r.consensus.classifications[0] === 'burst'
  );

  console.log(`\n  ━━━━ Ready to Apply ━━━━\n`);
  console.log(`  Auto-resolve (same):    ${safeToResolve.length} pairs`);
  console.log(`  Auto-stack (burst):     ${safeToStack.length} pairs`);
  console.log(`  Manual review (other):  ${valid.length - safeToResolve.length - safeToStack.length} pairs`);

  if (apply && (safeToResolve.length > 0 || safeToStack.length > 0)) {
    console.log(`\n4. Applying consensus decisions...\n`);
    // ... same apply logic as before ...
    const resolveGroups = [];

    for (const r of safeToResolve) {
      let keepId, trashId;
      if (r.consensus.qualityAgrees && r.consensus.qualities[0] === 'first') {
        keepId = r.assetA.id; trashId = r.assetB.id;
      } else if (r.consensus.qualityAgrees && r.consensus.qualities[0] === 'second') {
        keepId = r.assetB.id; trashId = r.assetA.id;
      } else {
        if (r.assetA.size >= r.assetB.size) { keepId = r.assetA.id; trashId = r.assetB.id; }
        else { keepId = r.assetB.id; trashId = r.assetA.id; }
      }
      resolveGroups.push({ duplicateId: r.duplicateId, keepAssetIds: [keepId], trashAssetIds: [trashId] });
    }

    const BATCH = 100;
    let applied = 0;
    for (let i = 0; i < resolveGroups.length; i += BATCH) {
      const batch = resolveGroups.slice(i, i + BATCH);
      try {
        await resolveDuplicates(batch);
        applied += batch.length;
        console.log(`   resolved ${applied}/${resolveGroups.length}`);
      } catch (err) {
        console.log(`   ⚠️ batch failed: ${err.message.slice(0, 200)}`);
      }
    }

    for (const r of safeToStack) {
      try { await createStack([r.assetA.id, r.assetB.id]); }
      catch (err) { console.log(`   ⚠️ stack failed: ${err.message.slice(0, 200)}`); }
    }

    console.log(`\n   ✅ Applied: ${applied} resolves + ${safeToStack.length} stacks`);
  } else if (!apply) {
    console.log(`\n  (run with --apply to apply the ${safeToResolve.length + safeToStack.length} consensus pairs)`);
  }

  console.log(`\n  Results: pipeline-results.json`);
  console.log(`  Cost: $${totalCostAll.toFixed(2)}`);
  console.log(`  Time: ${(pipelineElapsed / 1000).toFixed(0)}s${resumedCount ? ' (this invocation only)' : ''}`);
  console.log('\n═══ DONE ═══\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
