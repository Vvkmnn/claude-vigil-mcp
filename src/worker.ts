#!/usr/bin/env node
/**
 * Background snapshot worker for claude-vigil-mcp.
 *
 * Spawned as a detached child process by the MCP tool and the pre-bash hook.
 * Writes an `.in-progress` lockfile during operation so `vigil_list` can show status,
 * creates the checkpoint, and cleans up the lockfile on completion (even on error).
 *
 * Usage: `node worker.js <projectDir> <name> [type]`
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckpoint } from './snapshot.js';

const projectDir = process.argv[2];
const name = process.argv[3];
const type = process.argv[4] ?? 'manual';

if (!projectDir || !name) {
  console.error('Usage: worker.js <projectDir> <name> [type]');
  process.exit(1);
}

const vigilDir = join(projectDir, '.claude', 'vigil');
const lockfile = join(vigilDir, '.in-progress');

mkdirSync(vigilDir, { recursive: true });
writeFileSync(lockfile, JSON.stringify({ name, type, started: Date.now(), pid: process.pid }));

try {
  createCheckpoint(projectDir, name, type);
} finally {
  try {
    unlinkSync(lockfile);
  } catch {
    /* already cleaned up */
  }
}
