// clef.js — send images to Cloudflare Clef models via AI Gateway
//
// INPUT FORMAT (verified from the Cloudflare blog):
//   state: TEXT string describing the context
//   images: top-level array of base64 data URIs (data:image/jpeg;base64,...)
//   questions: schema of typed questions
//
// NOT state as an array. NOT images inside state. The blog example is definitive.

import 'dotenv/config';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_API_TOKEN;
const GATEWAY_ID = process.env.CF_GATEWAY_ID || 'default';

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`;

const MODELS = {
  clef: '@cf/cloudflare/clef',
  omni: '@cf/cloudflare/clef-omni',
  flash: '@cf/cloudflare/clef-flash',
};

const DUPLICATE_QUESTIONS = {
  classification: {
    type: 'choice',
    instructions: 'Are these the same exact photo (identical or near-identical), different frames of the same moment (burst photography), or genuinely different photos that happen to look similar?',
    criteria: {
      same: 'The same exact photo — same frame, same content, possibly different metadata or compression',
      burst: 'Different frames of the same moment — taken a fraction of a second apart, slightly different composition or motion',
      different: 'Genuinely different photos — different subjects, different scenes, or taken at different times',
    },
  },
  quality: {
    type: 'choice',
    instructions: 'Which photo has better technical quality? Consider sharpness, exposure, noise, motion blur, and composition.',
    criteria: {
      first: 'The first photo is clearly better quality',
      second: 'The second photo is clearly better quality',
      equal: 'They are essentially equal in quality',
    },
  },
};

export async function askClef(model, state, images, questions) {
  const modelId = MODELS[model];
  if (!modelId) throw new Error(`Unknown model: ${model}`);

  const started = Date.now();

  const payload = {
    model: model === 'clef' ? 'clef' : model === 'flash' ? 'clef-flash' : 'clef-omni',
    state,
    images,
    questions,
  };

  const res = await fetch(`${BASE}/${modelId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-gateway-id': GATEWAY_ID,
    },
    body: JSON.stringify(payload),
  });

  const latency = Date.now() - started;
  const json = await res.json();

  if (!res.ok) {
    const err = new Error(`Clef ${model} API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    err.latency = latency;
    throw err;
  }

  json._latency = latency;
  json._model = model;
  return json;
}

export { DUPLICATE_QUESTIONS };
