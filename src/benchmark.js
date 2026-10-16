// benchmark.js — three-way comparison: thumbnail vs original × omni vs flash
//
// For each pair, we send 4 requests:
//   1. thumbnail → Clef-omni
//   2. thumbnail → Clef-flash
//   3. original (converted) → Clef-omni
//   4. original (converted) → Clef-flash
//
// This answers:
//   - Does resolution matter? (thumbnail vs original)
//   - Does model size matter? (omni 30B vs flash 9B)
//   - Which combination is optimal?
//
// Usage: npm run benchmark

import { getDuplicateGroups, getAssetThumbnail, getAssetOriginal } from './immich.js';
import { askClef, DUPLICATE_QUESTIONS } from './clef.js';
import { toJpeg, jpegDataUri, sniffFormat } from './convert.js';

const STATE = 'Compare two photos. Photo A is the first image, Photo B is the second image. Assess whether they are the same photo, different frames of the same moment (burst), or different photos. Also assess which photo has better quality.';

const NUM_PAIRS = 20;

// ─── response parser (matches verified Clef format) ───

function parseAnswers(resp) {
  const answers = resp?.result?.answers || resp?.answers;
  if (!answers) return { classification: 'no-answer', quality: 'no-answer', raw: resp };

  const cls = answers.classification || {};
  const qly = answers.quality || {};

  return {
    classification: cls.choice || 'unknown',
    clsProbabilities: cls.probabilities || {},
    clsConfidence: cls.confidence || 0,
    quality: qly.choice || 'unknown',
    qlyProbabilities: qly.probabilities || {},
    qlyConfidence: qly.confidence || 0,
    inputTokens: resp?.result?.usage?.input_tokens || 0,
  };
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

function topProb(parsed, field) {
  const probs = field === 'cls' ? parsed.clsProbabilities : parsed.qlyProbabilities;
  const choice = field === 'cls' ? parsed.classification : parsed.quality;
  return probs[choice] || 0;
}

// ─── main ───

async function main() {
  console.log('=== Clef Benchmark: Resolution × Model ===\n');
  console.log(`Testing ${NUM_PAIRS} pairs across 4 conditions:\n`);
  console.log(`  A: thumbnail → omni   B: thumbnail → flash`);
  console.log(`  C: original  → omni   D: original  → flash\n`);

  console.log('Fetching duplicate groups...');
  const groups = await getDuplicateGroups();
  const pairs = groups.filter(g => g.assets?.length === 2).slice(0, NUM_PAIRS);
  console.log(`Found ${pairs.length} pairs\n`);

  const results = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const [assetA, assetB] = pair.assets;
    const label = `"${assetA.originalFileName}" vs "${assetB.originalFileName}"`;
    console.log(`\n--- Pair ${i + 1}/${pairs.length}: ${label}`);

    try {
      // ── Download both input sizes ──
      console.log('  downloading thumbnails + originals...');
      const [tA, tB] = await Promise.all([
        getAssetThumbnail(assetA.id, 'preview'),
        getAssetThumbnail(assetB.id, 'preview'),
      ]);

      let origA, origB;
      let origConversionFailed = false;
      try {
        const [rawA, rawB] = await Promise.all([
          getAssetOriginal(assetA.id),
          getAssetOriginal(assetB.id),
        ]);
        // convert HEIC → JPEG via ffmpeg, keep full resolution
        origA = await toJpeg(rawA.buffer, null);
        origB = await toJpeg(rawB.buffer, null);
      } catch (convErr) {
        console.log(`  ⚠️ original conversion failed: ${convErr.message.slice(0, 100)}`);
        origConversionFailed = true;
      }

      // build data URIs
      const thumbUris = [jpegDataUri(tA.base64), jpegDataUri(tB.base64)];
      const origUris = origConversionFailed ? null : [jpegDataUri(origA.base64), jpegDataUri(origB.base64)];

      // ── Condition A: thumbnail → Clef-omni ──
      const aResp = await askClef('omni', STATE, thumbUris, DUPLICATE_QUESTIONS);
      const a = parseAnswers(aResp);
      console.log(`  A thumb/omni:  ${a.classification} (${fmt(topProb(a, 'cls'))}) | quality: ${a.quality} (${fmt(topProb(a, 'qly'))}) | ${aResp._latency}ms`);

      // ── Condition B: thumbnail → Clef-flash ──
      const bResp = await askClef('flash', STATE, thumbUris, DUPLICATE_QUESTIONS);
      const b = parseAnswers(bResp);
      console.log(`  B thumb/flash: ${b.classification} (${fmt(topProb(b, 'cls'))}) | quality: ${b.quality} (${fmt(topProb(b, 'qly'))}) | ${bResp._latency}ms`);

      // ── Condition C: original → Clef-omni ──
      let c = null, cResp = null;
      if (origUris) {
        cResp = await askClef('omni', STATE, origUris, DUPLICATE_QUESTIONS);
        c = parseAnswers(cResp);
        console.log(`  C orig/omni:   ${c.classification} (${fmt(topProb(c, 'cls'))}) | quality: ${c.quality} (${fmt(topProb(c, 'qly'))}) | ${cResp._latency}ms`);
      }

      // ── Condition D: original → Clef-flash ──
      let d = null, dResp = null;
      if (origUris) {
        dResp = await askClef('flash', STATE, origUris, DUPLICATE_QUESTIONS);
        d = parseAnswers(dResp);
        console.log(`  D orig/flash:  ${d.classification} (${fmt(topProb(d, 'cls'))}) | quality: ${d.quality} (${fmt(topProb(d, 'qly'))}) | ${dResp._latency}ms`);
      }

      // ── Comparisons ──
      const abClassAgrees = a.classification === b.classification;
      console.log(`  ${abClassAgrees ? '✅' : '❌'} omni vs flash (thumb): ${abClassAgrees ? 'agrees' : `DIFFERS (${a.classification} vs ${b.classification})`}`);

      if (c && d) {
        const cdClassAgrees = c.classification === d.classification;
        const acClassAgrees = a.classification === c.classification;
        console.log(`  ${cdClassAgrees ? '✅' : '❌'} omni vs flash (orig): ${cdClassAgrees ? 'agrees' : `DIFFERS (${c.classification} vs ${d.classification})`}`);
        console.log(`  ${acClassAgrees ? '✅' : '❌'} thumb vs orig (omni): ${acClassAgrees ? 'agrees' : `DIFFERS (${a.classification} vs ${c.classification})`}`);
      }

      results.push({
        pair: label,
        thumbOmni: a,
        thumbFlash: b,
        origOmni: c,
        origFlash: d,
        origAvailable: origUris !== null,
        latencies: {
          thumbOmni: aResp._latency,
          thumbFlash: bResp._latency,
          origOmni: cResp?._latency || null,
          origFlash: dResp?._latency || null,
        },
        tokens: {
          thumbOmni: a.inputTokens,
          thumbFlash: b.inputTokens,
          origOmni: c?.inputTokens || null,
          origFlash: d?.inputTokens || null,
        },
      });

    } catch (err) {
      console.log(`  ❌ error: ${err.message.slice(0, 200)}`);
      results.push({ pair: label, error: err.message });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // ─── Summary ───
  console.log('\n\n=== BENCHMARK SUMMARY ===\n');

  const valid = results.filter(r => !r.error);
  const errors = results.filter(r => r.error);

  console.log(`  Pairs tested: ${valid.length} (${errors.length} errors)\n`);

  // Dimension 1: Resolution (thumbnail vs original, same model)
  const withOrig = valid.filter(r => r.origAvailable && r.origOmni && r.thumbOmni);
  const resClassAgree = withOrig.filter(r => r.thumbOmni.classification === r.origOmni.classification).length;
  const resQualityAgree = withOrig.filter(r => r.thumbOmni.quality === r.origOmni.quality).length;

  console.log('  ━━━ Resolution: does thumbnail vs original matter?');
  console.log(`     Classification: ${resClassAgree}/${withOrig.length} agree (${(resClassAgree / (withOrig.length || 1) * 100).toFixed(0)}%)`);
  console.log(`     Quality:         ${resQualityAgree}/${withOrig.length} agree (${(resQualityAgree / (withOrig.length || 1) * 100).toFixed(0)}%)`);

  // Dimension 2: Model (omni vs flash, same input)
  const modelClassAgree = valid.filter(r => r.thumbOmni.classification === r.thumbFlash.classification).length;
  const modelQualityAgree = valid.filter(r => r.thumbOmni.quality === r.thumbFlash.quality).length;

  console.log('\n  ━━━ Model: does 30B (omni) outperform 9B (flash)?');
  console.log(`     Classification: ${modelClassAgree}/${valid.length} agree (${(modelClassAgree / (valid.length || 1) * 100).toFixed(0)}%)`);
  console.log(`     Quality:         ${modelQualityAgree}/${valid.length} agree (${(modelQualityAgree / (valid.length || 1) * 100).toFixed(0)}%)`);

  // Latency comparison
  const avgLat = (results, key) => {
    const vals = results.filter(r => r.latencies?.[key]).map(r => r.latencies[key]);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(0) : 'n/a';
  };

  console.log('\n  ━━━ Latency:');
  console.log(`     thumb → omni:   ${avgLat(valid, 'thumbOmni')}ms`);
  console.log(`     thumb → flash:  ${avgLat(valid, 'thumbFlash')}ms`);
  console.log(`     orig  → omni:   ${avgLat(valid, 'origOmni')}ms`);
  console.log(`     orig  → flash:  ${avgLat(valid, 'origFlash')}ms`);

  // Token comparison
  console.log('\n  ━━━ Token count:');
  console.log(`     thumb → omni:   ${avgLat(valid, 'thumbOmni') !== 'n/a' ? valid[0]?.thumbOmni?.inputTokens : 'n/a'} tokens`);
  console.log(`     thumb → flash:  ${valid[0]?.thumbFlash?.inputTokens || 'n/a'} tokens`);

  // Classification distribution per model
  console.log('\n  ━━━ Classification breakdown (thumbnail input):');

  const omniCls = {};
  for (const r of valid) {
    const c = r.thumbOmni?.classification || 'unknown';
    omniCls[c] = (omniCls[c] || 0) + 1;
  }
  console.log(`     omni:  ${JSON.stringify(omniCls)}`);

  const flashCls = {};
  for (const r of valid) {
    const c = r.thumbFlash?.classification || 'unknown';
    flashCls[c] = (flashCls[c] || 0) + 1;
  }
  console.log(`     flash: ${JSON.stringify(flashCls)}`);

  // Confidence comparison
  const avgConf = (results, model, field) => {
    const vals = results.filter(r => r[model]).map(r => r[model][field]);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3) : 'n/a';
  };

  console.log('\n  ━━━ Confidence scores (calibration):');
  console.log(`     omni classification:  ${avgConf(valid, 'thumbOmni', 'clsConfidence')}`);
  console.log(`     flash classification: ${avgConf(valid, 'thumbFlash', 'clsConfidence')}`);
  console.log(`     omni quality:           ${avgConf(valid, 'thumbOmni', 'qlyConfidence')}`);
  console.log(`     flash quality:          ${avgConf(valid, 'thumbFlash', 'qlyConfidence')}`);

  // Disagreements between models
  const modelDisagreements = valid.filter(r => r.thumbOmni.classification !== r.thumbFlash.classification);
  if (modelDisagreements.length > 0) {
    console.log('\n  ━━━ Model disagreements:');
    for (const d of modelDisagreements) {
      console.log(`     ${d.pair}`);
      console.log(`       omni:  ${d.thumbOmni.classification} (${fmt(topProb(d.thumbOmni, 'cls'))})`);
      console.log(`       flash: ${d.thumbFlash.classification} (${fmt(topProb(d.thumbFlash, 'cls'))})`);
    }
  } else {
    console.log('\n  ━━━ Model disagreements: none — both models agree on all pairs');
  }

  // Cost comparison
  console.log('\n  ━━━ Cost estimate (for 3,456 pairs):');
  const tokensPerCall = valid[0]?.thumbOmni?.inputTokens || 2325;
  const omniCost = (tokensPerCall * 3456 * 0.15) / 1_000_000;
  const flashCost = (tokensPerCall * 3456 * 0.038) / 1_000_000;
  console.log(`     omni:  $${omniCost.toFixed(2)} ($0.15/M tokens)`);
  console.log(`     flash: $${flashCost.toFixed(2)} ($0.038/M tokens)`);
  console.log(`     savings with flash: $${(omniCost - flashCost).toFixed(2)}`);

  // ─── Verdict ───
  console.log('\n  ━━━━ VERDICT ━━━━\n');

  if (modelClassAgree === valid.length) {
    console.log('  ✅ Both models agree on 100% of classifications.');
    console.log('     → Use Clef-flash for the pipeline:');
    console.log(`       Same accuracy, $${flashCost.toFixed(2)} vs $${omniCost.toFixed(2)} (${(flashCost / omniCost * 100).toFixed(0)}% of the cost)`);
  } else {
    const disagreeRate = (1 - modelClassAgree / valid.length) * 100;
    console.log(`  ⚠️ Models disagree on ${modelDisagreements.length} pairs (${disagreeRate.toFixed(0)}%).`);
    console.log('     → Use Clef-omni if the disagreements matter.');
    console.log('     → Or use flash for bulk + omni for edge cases.');
  }

  const fs = await import('fs');
  fs.writeFileSync('benchmark-results.json', JSON.stringify(results, null, 2));
  console.log('\n  Full results: benchmark-results.json');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
