/**
 * Content-addressable storage (CAS) using SHA-256 + gzip.
 *
 * Every file is stored as a gzipped blob named by its SHA-256 hash, sharded into
 * subdirectories by 2-character hex prefix (e.g., `objects/ab/cdef...gz`).
 * Identical content is automatically deduplicated — storing the same file twice
 * is a no-op. GC removes objects not referenced by any checkpoint.
 */

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Manifest, GCResult, DiskUsage } from './types.js';

/**
 * Compute the SHA-256 hash of a buffer.
 * @param buf - Raw file content.
 * @returns 64-character lowercase hex string.
 */
export function hashContent(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Store a buffer in the CAS as a gzipped blob.
 * Deduplicates automatically — if the hash already exists, the write is skipped.
 * @param vigilDir - Path to `.claude/vigil/` directory.
 * @param buf - Raw file content to store.
 * @returns SHA-256 hex hash of the content.
 */
export function storeObject(vigilDir: string, buf: Buffer): string {
  const hash = hashContent(buf);
  const dir = join(vigilDir, 'objects', hash.slice(0, 2));
  const file = join(dir, hash.slice(2) + '.gz');
  if (existsSync(file)) return hash;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, gzipSync(buf));
  return hash;
}

/**
 * Read an object from the CAS by hash.
 * @param vigilDir - Path to `.claude/vigil/` directory.
 * @param hash - SHA-256 hex hash of the content.
 * @returns Original uncompressed file content.
 * @throws If the object does not exist (hash not found).
 */
export function readObject(vigilDir: string, hash: string): Buffer {
  const file = join(vigilDir, 'objects', hash.slice(0, 2), hash.slice(2) + '.gz');
  return gunzipSync(readFileSync(file));
}

/**
 * Mark-and-sweep garbage collection for the CAS.
 * Walks all objects, removes any not referenced by a checkpoint or the quicksave.
 * Also cleans up empty prefix directories.
 * @param vigilDir - Path to `.claude/vigil/` directory.
 * @param manifest - Current manifest (defines the "live" reference set).
 * @returns Count of removed objects and bytes freed.
 */
export function gcObjects(vigilDir: string, manifest: Manifest): GCResult {
  const referenced = new Set<string>();
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

    // Remove empty prefix directories (rmdirSync only removes if empty)
    try {
      rmdirSync(prefixDir);
    } catch {
      /* not empty or already gone */
    }
  }

  return { removed, bytesFreed };
}

/**
 * Calculate total disk usage of the CAS `objects/` directory.
 * @param vigilDir - Path to `.claude/vigil/` directory.
 * @returns Total bytes on disk and number of stored objects.
 */
export function diskUsage(vigilDir: string): DiskUsage {
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
