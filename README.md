# immich-clef-dedup

Resolve duplicate photos in your [Immich](https://immich.app) library using Cloudflare's Clef decision models.

This tool takes duplicate groups from Immich's built-in duplicate detection that contain exactly two photos (where simple file-size rules can't decide) and sends them to **three Clef models simultaneously** for visual classification. Only pairs where **all three models agree** are auto-resolved; disagreements go to manual review.

## How it works

```
For each duplicate pair flagged by Immich:
  1. Download two preview thumbnails (JPEG)
  2. Send to Clef (27B) + Clef-omni (30B) + Clef-flash (9B) in parallel
  3. Each model returns calibrated probabilities for:
     - classification: same | burst | different
     - quality: first | second | equal
  4. If all 3 models agree → auto-resolve
  5. If any disagree → flag for manual review
```

## Results from a real run

2,030 two-photo duplicate groups from a ~70,000-photo library. One pair errored before reaching the models; the other 2,029 went through all three. Numbers below are from the AI Gateway logs for that run (6,087 requests, zero failures).

| | Clef (27B) | Clef-omni (30B-A3B) | Clef-flash (9B) |
|---|---|---|---|
| Median latency | 1,308ms | **628ms** | 1,641ms |
| p95 latency | 2,736ms | **748ms** | 2,187ms |
| p99 latency | 7,055ms | **857ms** | 5,166ms |
| Input tokens per request | 2,329 | 2,325 | 2,329 |
| Cost for all pairs | $1.13 | $0.71 | **$0.18** |
| Avg confidence | 0.519 | 0.662 | **0.708** |
| Labeled "burst" | 476 | 23 | 35 |

Latencies are request durations recorded by AI Gateway. Client-side timings (`_latency`) were ~600ms higher because they include uploading each ~1.3MB request.

**Consensus results (2,030 pairs):**

| | Count | Percentage |
|---|---|---|
| All 3 agree (auto-resolve) | 1,544 | 76.1% |
| Disagreement (manual review) | 484 | 23.8% |
| Clef returned no answer (manual review) | 1 | <0.1% |
| Errored before reaching the models | 1 | <0.1% |

Of the 1,544 consensus pairs, 1,538 were `same` (trash one copy) and 6 were `burst` (stack both).

**Total cost: $2.02** · **Main run: 103 minutes** · **Output tokens: FREE**

### Interesting findings

- **The 30B MoE model is the fastest.** Clef-omni has only 3B active parameters per token, and its median latency was ~2× lower than Clef and ~2.6× lower than Clef-flash.
- **Parameter count does not predict latency.** The 27B Clef beat the 9B Clef-flash at the median, though with a much longer tail.
- **The 27B base model is the conservative outlier.** It labeled 476 pairs as "burst" while the other two labeled 23 and 35. In 437 of the 484 disagreements, Clef said burst and the other two said same, usually with low confidence (median 0.23).
- **Clef-omni and Clef-flash agree 97.7%** of the time. Running just these two costs $0.89 instead of $2.02.
- **The quality question never decided a keeper.** No consensus pair had all three models pick a better photo, so every keeper was chosen by file size.

## Prerequisites

- An Immich server with duplicate detection enabled
- A Cloudflare account with Workers AI access
- An Immich API key with these permissions:
  ```
  asset.read
  asset.download
  asset.view
  duplicate.read
  duplicate.resolve
  ```
- A Cloudflare API token with Workers AI permission
- Node.js 20.6+ (the npm scripts use `node --env-file`)
- `ffmpeg`, only if you run the benchmark against HEIC originals

## Setup

```bash
git clone https://github.com/harshil1712/immich-clef-dedup.git
cd immich-clef-dedup
npm install

# configure credentials
cp .env.example .env
# edit .env with your actual values
```

Your `.env` file:

```bash
IMMICH_SERVER=http://your-nas-ip:2283
IMMICH_API_KEY=your-immich-api-key
CF_ACCOUNT_ID=your-cloudflare-account-id
CF_API_TOKEN=your-cloudflare-api-token
CF_GATEWAY_ID=default
```

## Usage

### 1. Verify the format works (one pair)

```bash
npm run probe
```

Sends one duplicate pair to Clef-omni and Clef-flash to verify your credentials and the input format work end-to-end.

### 2. Benchmark the models (optional)

```bash
npm run benchmark
```

Runs 20 pairs through all 3 models with both thumbnail and original inputs. Reports per-model latency, confidence, classification distribution, and pairwise agreement rates. Useful for validating that thumbnails give identical results to originals (they do — Clef caps at ~1024×1024 pixels).

### 3. Run the pipeline

```bash
# collect only — no changes to your library
npm run pipeline

# collect + apply consensus decisions
npm run pipeline -- --apply

# limit to first N pairs (for testing)
npm run pipeline -- 50

# limit + apply
npm run pipeline -- 50 --apply
```

The pipeline:
1. Fetches all remaining duplicate pairs from Immich
2. Downloads preview thumbnails for each pair
3. Sends to all 3 Clef models in parallel
4. Analyzes consensus (all 3 agree / disagreement)
5. Reports per-model stats: latency (avg/median/P95), tokens, cost, confidence
6. Saves full results to `pipeline-results.json`
7. With `--apply`: auto-resolves pairs where all 3 models agree

### Safety features

- **Collect-only by default** — `--apply` flag required for any changes
- **All trashed photos go to Immich's trash** — recoverable for 30 days
- **Resume support** — saves progress every 50 pairs, can stop and restart. The final report covers all pairs, including resumed ones
- **AI Gateway integration** — every request logged in your Cloudflare dashboard
- **Full audit trail** — `pipeline-results.json` contains every model's parsed answer for every pair

## The questions we ask each model

```javascript
{
  classification: {
    type: "choice",
    instructions: "Are these the same exact photo, different frames of the same moment (burst photography), or genuinely different photos?",
    criteria: {
      same: "The same exact photo",
      burst: "Different frames of the same moment",
      different: "Genuinely different photos"
    }
  },
  quality: {
    type: "choice",
    instructions: "Which photo has better technical quality?",
    criteria: {
      first: "The first photo is better",
      second: "The second photo is better",
      equal: "They are essentially equal"
    }
  }
}
```

Clef returns calibrated probabilities for every option — not text to parse, just structured probability scores. Output tokens are free.

## Key technical details

### Input format (verified from the Cloudflare blog)

```json
{
  "model": "clef-omni",
  "state": "Compare two photos...",
  "images": ["data:image/jpeg;base64,...", "data:image/jpeg;base64,..."],
  "questions": { ... }
}
```

- `state` is **text only**
- `images` is a **top-level array** of properly-typed data URIs
- The `model` field must match the endpoint you're calling (Clef base rejects `"clef-omni"`)

### Image format sniffing

Immich's binary endpoints return `Content-Type: application/octet-stream` regardless of actual format. This tool sniffs the real format from magic bytes:

```javascript
if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
if (ftyp === 'ftyp') return 'heic';
```

The `ftyp` check also matches AVIF, MP4, and MOV (they share the ISO BMFF container). Check the brand at bytes 8–11 if your library contains those.

Note that Clef only accepts PNG, JPEG, and WebP. A HEIC data URI is rejected with `image must be an embedded base64 data URI`, which does not mention the format. The pipeline avoids this by sending Immich's preview thumbnails, which are always JPEG.

### Thumbnail vs original

Clef scales every image to about one megapixel and caps it at 1,024 tokens. Immich previews already exceed that, so originals add nothing. In the benchmark, thumbnails and originals got the same label on every pair that completed, with identical token counts, ~6× smaller requests, and lower latency.

Full-resolution originals can also exceed Clef's 4 MiB per-image limit (`image exceeds the decoded byte limit`). The benchmark now skips those pairs' original comparison instead of failing.

## Cost breakdown

| Model | Pricing | Cost for 2,029 pairs |
|---|---|---|
| Clef (27B) | $0.24/M input tokens | $1.13 |
| Clef-omni (30B) | $0.15/M input tokens | $0.71 |
| Clef-flash (9B) | $0.038/M input tokens | $0.18 |
| Output tokens | **FREE** | $0.00 |
| **Total** | | **$2.02** |

For a cheaper run: use only Clef-omni + Clef-flash (97.7% agreement rate) — $0.89 total. That is a one-line change to the `MODELS` array in `src/pipeline.js`.

## License

MIT

## Acknowledgments

- [Immich](https://immich.app) — the photo management server
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef-omni/) — the decision models that make this possible
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) — request logging and analytics
