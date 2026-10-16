// immich.js — fetch duplicates, download originals, resolve back
import 'dotenv/config';

const SERVER = process.env.IMMICH_SERVER;
const KEY = process.env.IMMICH_API_KEY;

const headers = { 'x-api-key': KEY };

export async function getDuplicateGroups() {
  const res = await fetch(`${SERVER}/api/duplicates`, { headers });
  if (!res.ok) throw new Error(`Immich API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`  fetched ${data.length} duplicate groups from Immich`);
  return data;
}

export async function getAssetOriginal(assetId) {
  const res = await fetch(`${SERVER}/api/assets/${assetId}/original`, { headers });
  if (!res.ok) throw new Error(`Immich original fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return { buffer: buf, mime, base64: Buffer.from(buf).toString('base64') };
}

export async function getAssetThumbnail(assetId, size = 'preview') {
  const res = await fetch(`${SERVER}/api/assets/${assetId}/thumbnail?size=${size}`, { headers });
  if (!res.ok) throw new Error(`Immich thumbnail fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return { buffer: buf, mime, base64: Buffer.from(buf).toString('base64') };
}

export async function resolveDuplicates(groups) {
  // groups: [{duplicateId, keepAssetIds, trashAssetIds}]
  const res = await fetch(`${SERVER}/api/duplicates/resolve`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups }),
  });
  if (!res.ok) throw new Error(`Immich resolve ${res.status}: ${await res.text()}`);
  console.log(`  resolved ${groups.length} duplicate groups`);
  return res.json();
}

export async function createStack(assetIds) {
  const res = await fetch(`${SERVER}/api/stacks`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  });
  if (!res.ok) throw new Error(`Immich stack ${res.status}: ${await res.text()}`);
  console.log(`  stacked ${assetIds.length} assets`);
  return res.json();
}
