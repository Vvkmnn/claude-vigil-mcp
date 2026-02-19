// CAS (Content-Addressable Storage) primitives for vigil checkpoints.
// Files stored as gzipped blobs named by SHA-256 hash, sharded by 2-char prefix.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, unlinkSync, statSync
} from 'node:fs';
import { join } from 'node:path';

/** SHA-256 hash of a buffer, returned as hex string. */
export function hashContent(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Store a buffer in the CAS. Returns its hash.
 * Dedup: if the object already exists, skip the write.
 */
export function storeObject(vigilDir, buf) {
  const hash = hashContent(buf);
  const dir = join(vigilDir, 'objects', hash.slice(0, 2));
  const file = join(dir, hash.slice(2) + '.gz');
  if (existsSync(file)) return hash;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, gzipSync(buf));
  return hash;
}

/** Read an object from the CAS by hash. Returns the original buffer. */
export function readObject(vigilDir, hash) {
  const file = join(vigilDir, 'objects', hash.slice(0, 2), hash.slice(2) + '.gz');
  return gunzipSync(readFileSync(file));
}

/**
 * Mark-and-sweep garbage collection.
 * Removes objects not referenced by any checkpoint in the manifest.
 * Returns { removed, bytesFreed }.
 */
export function gcObjects(vigilDir, manifest) {
  const referenced = new Set();
  for (const cp of manifest.checkpoints) {
    for (const hash of Object.values(cp.files)) {
      referenced.add(hash);
    }
  }
  // Also include quicksave references
  if (manifest.quicksave) {
    for (const hash of Object.values(manifest.quicksave.files)) {
      referenced.add(hash);
    }
  }

  let removed = 0;
  let bytesFreed = 0;
  const objectsDir = join(vigilDir, 'objects');
  if (!existsSync(objectsDir)) return { removed, bytesFreed };

  for (const prefix of readdirSync(objectsDir)) {
    const prefixDir = join(objectsDir, prefix);
    if (!statSync(prefixDir).isDirectory()) continue;

    for (const file of readdirSync(prefixDir)) {
      const hash = prefix + file.replace('.gz', '');
      if (!referenced.has(hash)) {
        const filePath = join(prefixDir, file);
        bytesFreed += statSync(filePath).size;
        unlinkSync(filePath);
        removed++;
      }
    }

    // Remove empty prefix directories
    if (readdirSync(prefixDir).length === 0) {
      try { unlinkSync(prefixDir); } catch { /* rmdir not unlinkSync for dirs */ }
      try { readdirSync(prefixDir); } catch { /* already gone, fine */ }
    }
  }

  return { removed, bytesFreed };
}

/**
 * Calculate total disk usage of the objects/ directory.
 * Returns { totalBytes, objectCount }.
 */
export function diskUsage(vigilDir) {
  let totalBytes = 0;
  let objectCount = 0;
  const objectsDir = join(vigilDir, 'objects');
  if (!existsSync(objectsDir)) return { totalBytes, objectCount };

  for (const prefix of readdirSync(objectsDir)) {
    const prefixDir = join(objectsDir, prefix);
    if (!statSync(prefixDir).isDirectory()) continue;

    for (const file of readdirSync(prefixDir)) {
      totalBytes += statSync(join(prefixDir, file)).size;
      objectCount++;
    }
  }

  return { totalBytes, objectCount };
}
