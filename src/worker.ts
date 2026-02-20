#!/usr/bin/env node
// Background snapshot worker. Spawned detached by MCP tool and pre-bash hook.
// Writes .in-progress lockfile, creates checkpoint, removes lockfile on completion.

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckpoint } from './snapshot.js';

const [,, projectDir, name, type = 'manual'] = process.argv;
const vigilDir = join(projectDir, '.claude', 'vigil');
const lockfile = join(vigilDir, '.in-progress');

mkdirSync(vigilDir, { recursive: true });
writeFileSync(lockfile, JSON.stringify({ name, type, started: Date.now(), pid: process.pid }));

try {
  createCheckpoint(projectDir, name, type);
} finally {
  try { unlinkSync(lockfile); } catch { /* already cleaned up */ }
}
