// convert.js — image conversion for Clef (HEIC via ffmpeg, JPEG/PNG via sharp)
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// detect image format from magic bytes
export function sniffFormat(buffer) {
  const bytes = new Uint8Array(buffer);
  // JPEG: FF D8
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  // HEIC/HEIF: starts with "ftyp" at offset 4
  if (bytes.length > 8) {
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (ftyp === 'ftyp') return 'heic';
  }
  return 'unknown';
}

// convert HEIC to JPEG using ffmpeg (sharp's prebuilt macOS binaries lack HEVC support)
async function heicToJpeg(buffer) {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `clef-${id}.heic`);
  const outputPath = join(tmpdir(), `clef-${id}.jpg`);

  try {
    await writeFile(inputPath, Buffer.from(buffer));

    // ffmpeg: -i input.heic -q:v 2 output.jpg
    // -q:v 2 = high quality JPEG (scale 1-31, lower is better)
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-q:v', '2',
      '-y',              // overwrite output
      outputPath,
    ], { timeout: 30000 });

    return await readFile(outputPath);
  } finally {
    // cleanup temp files
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Convert any image to JPEG, optionally resizing.
 * Handles HEIC (via ffmpeg) and JPEG/PNG (via sharp).
 *
 * @param {Buffer} buffer — raw image bytes
 * @param {number|null} maxDim — max dimension (null = keep original size)
 * @returns {Promise<{buffer: Buffer, base64: string, format: string, dimensions: {width, height}}>}
 */
export async function toJpeg(buffer, maxDim = null) {
  const format = sniffFormat(buffer);
  let jpegBuffer;

  if (format === 'heic') {
    // HEIC → ffmpeg → JPEG
    jpegBuffer = await heicToJpeg(buffer);
  } else {
    // JPEG/PNG → sharp (or pass through if already JPEG and no resize needed)
    jpegBuffer = buffer;
  }

  // optional resize with sharp (JPEG in → JPEG out, no HEIC issues)
  let finalBuffer;
  let meta;

  if (maxDim) {
    finalBuffer = await sharp(jpegBuffer)
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: false })
      .jpeg({ quality: 92 })
      .toBuffer();
  } else {
    // re-encode as JPEG if not already, or pass through
    if (format === 'jpeg') {
      finalBuffer = jpegBuffer;
    } else {
      finalBuffer = await sharp(jpegBuffer).jpeg({ quality: 92 }).toBuffer();
    }
  }

  meta = await sharp(finalBuffer).metadata();

  return {
    buffer: finalBuffer,
    base64: finalBuffer.toString('base64'),
    format: 'jpeg',
    sourceFormat: format,
    dimensions: { width: meta.width, height: meta.height },
  };
}

/**
 * Build a properly-typed JPEG data URI.
 */
export function jpegDataUri(base64) {
  return `data:image/jpeg;base64,${base64}`;
}
