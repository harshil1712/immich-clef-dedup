# immich-clef-dedup

Resolve duplicate photos in your [Immich](https://immich.app) library using Cloudflare's Clef decision models.

This tool takes the duplicate pairs that Immich's built-in duplicate detection flags as "ambiguous" (where simple file-size rules can't decide) and sends them to **three Clef models simultaneously** for visual classification. Only pairs where **all three models agree** are auto-resolved; disagreements go to manual review.

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

2,029 duplicate pairs processed through all 3 models:

| | Clef (27B) | Clef-omni (30B) | Clef-flash (9B) |
|---|---|---|---|
| Avg latency | 2,218ms | **1,246ms** | 2,268ms |
| Avg tokens | 2,328 | 2,324 | 2,328 |
| Cost for all pairs | $1.11 | $0.69 | **$0.18** |
| Avg confidence | 0.517 | 0.662 | **0.707** |
| Errors | 0 | 0 | 0 |

**Consensus results:**

| | Count | Percentage |
|---|---|---|
| All 3 agree (auto-resolve) | 1,544 | 76.1% |
| Disagreement (manual review) | 485 | 23.9% |

**Total cost: $1.97** · **Wall-clock time: 103 minutes** · **Output tokens: FREE**

### Interesting findings

- **The 30B MoE model is the fastest** (1,246ms) — only 3B active parameters per inference makes it 1.8× faster than the 27B base model
- **The 9B model has the highest confidence and lowest cost** — for binary decisions, model size doesn't matter
- **The 27B base model is the conservative outlier** — it classified 467 pairs as "burst" while the other two saw only 22 and 34. It's seeing subtle frame differences the others don't
- **Clef-omni and Clef-flash agree 97.7%** of the time — running just these two saves 56% of the cost ($0.87 vs $1.97)

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
- Node.js 18+

## Setup

```bash
git clone https://github.com/your-username/immich-clef-dedup.git
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
- **Resume support** — saves progress every 50 pairs, can stop and restart
- **AI Gateway integration** — every request logged in your Cloudflare dashboard
- **Full audit trail** — `pipeline-results.json` contains every model's raw response for every pair

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
if (bytes[4] === 'f' && bytes[5] === 't' && bytes[6] === 'y' && bytes[7] === 'p') return 'heic';
```

### Thumbnail vs original

Clef caps every image at ~1024×1024 pixels (1,024 tokens per image). Preview thumbnails at 1920×1440 already exceed this cap — originals add nothing. Thumbnails are JPEG (no HEIC conversion needed), 3× faster, and 6.5× smaller.

## Cost breakdown

| Model | Pricing | Cost for 2,029 pairs |
|---|---|---|
| Clef (27B) | $0.24/M input tokens | $1.11 |
| Clef-omni (30B) | $0.15/M input tokens | $0.69 |
| Clef-flash (9B) | $0.038/M input tokens | $0.18 |
| Output tokens | **FREE** | $0.00 |
| **Total** | | **$1.97** |

For a cheaper run: use only Clef-omni + Clef-flash (97.7% agreement rate) — $0.87 total.

## License

MIT

## Acknowledgments

- [Immich](https://immich.app) — the photo management server
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef-omni/) — the decision models that make this possible
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) — request logging and analytics
