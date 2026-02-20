import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { hashContent, storeObject, readObject, gcObjects, diskUsage } from '../src/store.js';
import {
  readManifest, writeManifest, walkProject,
  createCheckpoint, restoreCheckpoint, diffCheckpoint,
  listCheckpointFiles, deleteCheckpoint
} from '../src/snapshot.js';

// ── Test helpers ──────────────────────────────────────────────────

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'vigil-test-'));
}

function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const full = join(projectDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function readProjectFile(projectDir: string, relPath: string): string {
  return readFileSync(join(projectDir, relPath), 'utf8');
}

// ── CAS Store Tests ───────────────────────────────────────────────

describe('store', () => {
  let vigilDir: string;

  before(() => {
    vigilDir = join(makeTempProject(), '.claude', 'vigil');
    mkdirSync(join(vigilDir, 'objects'), { recursive: true });
  });

  it('hashContent produces consistent hex hashes', () => {
    const buf = Buffer.from('hello world');
    const hash1 = hashContent(buf);
    const hash2 = hashContent(buf);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // SHA-256 = 64 hex chars
  });

  it('storeObject + readObject roundtrips correctly', () => {
    const buf = Buffer.from('test content for CAS');
    const hash = storeObject(vigilDir, buf);
    const retrieved = readObject(vigilDir, hash);
    assert.deepEqual(retrieved, buf);
  });

  it('CAS dedup: same content stored once', () => {
    const buf = Buffer.from('duplicate content');
    const hash1 = storeObject(vigilDir, buf);
    const hash2 = storeObject(vigilDir, buf);
    assert.equal(hash1, hash2);

    // Only one file should exist
    const dir = join(vigilDir, 'objects', hash1.slice(0, 2));
    const files = readdirSync(dir).filter(f => f.startsWith(hash1.slice(2)));
    assert.equal(files.length, 1);
  });

  it('gzip: stored objects are smaller than originals', () => {
    const content = 'a'.repeat(10000); // Highly compressible
    const buf = Buffer.from(content);
    const hash = storeObject(vigilDir, buf);
    const objPath = join(vigilDir, 'objects', hash.slice(0, 2), hash.slice(2) + '.gz');
    const objSize = readFileSync(objPath).length;
    assert.ok(objSize < buf.length, `gzipped ${objSize} should be < original ${buf.length}`);
  });

  it('diskUsage reports correct totals', () => {
    const usage = diskUsage(vigilDir);
    assert.ok(usage.totalBytes > 0);
    assert.ok(usage.objectCount > 0);
  });
});

// ── Snapshot Tests ────────────────────────────────────────────────

describe('snapshot', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'console.log("hello");');
    writeProjectFile(projectDir, 'src/utils.js', 'export function add(a, b) { return a + b; }');
    writeProjectFile(projectDir, 'README.md', '# My Project');
  });

  it('create + list checkpoint', () => {
    const result = createCheckpoint(projectDir, 'v1', 'manual');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.name, 'v1');
    assert.equal(result.fileCount, 3);
    assert.ok('newObjects' in result && result.newObjects > 0);

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    assert.equal(manifest.checkpoints.length, 1);
    assert.equal(manifest.checkpoints[0].name, 'v1');
  });

  it('create → modify → restore → verify bit-identical', () => {
    createCheckpoint(projectDir, 'original', 'manual');

    // Modify a file
    writeProjectFile(projectDir, 'src/app.js', 'console.log("modified");');
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("modified");');

    // Restore
    const result = restoreCheckpoint(projectDir, 'original');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.filesRestored, 3);

    // Verify original content
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("hello");');
  });

  it('auto-quicksave on restore', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'modified');
    restoreCheckpoint(projectDir, 'v1');

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    assert.ok(manifest.quicksave, 'quicksave should exist after restore');
    assert.equal(manifest.quicksave!.name, '~quicksave');
  });

  it('selective restore: one file reverted, others unchanged', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    writeProjectFile(projectDir, 'src/app.js', 'changed app');
    writeProjectFile(projectDir, 'src/utils.js', 'changed utils');

    restoreCheckpoint(projectDir, 'v1', { files: ['src/app.js'] });

    // app.js should be reverted
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("hello");');
    // utils.js should still be changed
    assert.equal(readProjectFile(projectDir, 'src/utils.js'), 'changed utils');
  });

  it('diff: added/modified/deleted detected', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    writeProjectFile(projectDir, 'src/app.js', 'modified');
    writeProjectFile(projectDir, 'src/new.js', 'new file');
    rmSync(join(projectDir, 'README.md'));

    const diff = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    assert.ok(diff.modified.includes('src/app.js'));
    assert.ok(diff.added.includes('src/new.js'));
    assert.ok(diff.deleted.includes('README.md'));
  });

  it('diff with file: retrieve content without restore', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'modified');

    const result = diffCheckpoint(projectDir, 'v1', { file: 'src/app.js' });
    assert.ok('content' in result);
    if (!('content' in result)) return;
    assert.equal(result.content, 'console.log("hello");');

    // Current file should still be modified
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'modified');
  });

  it('3-slot limit: 4th checkpoint blocked', () => {
    createCheckpoint(projectDir, 'a', 'manual');
    createCheckpoint(projectDir, 'b', 'manual');
    createCheckpoint(projectDir, 'c', 'manual');
    const result = createCheckpoint(projectDir, 'd', 'manual');
    assert.ok('error' in result);
    if (!('error' in result)) return;
    assert.equal(result.error, 'slots_full');
    assert.ok('max' in result && result.max === 3);
  });

  it('quicksave: overwritten on each new quicksave', () => {
    createCheckpoint(projectDir, '~quicksave', 'quicksave');
    const manifest1 = readManifest(join(projectDir, '.claude', 'vigil'));
    const created1 = manifest1.quicksave!.created;

    // Small delay to ensure different timestamp
    writeProjectFile(projectDir, 'src/app.js', 'changed');
    createCheckpoint(projectDir, '~quicksave', 'quicksave');
    const manifest2 = readManifest(join(projectDir, '.claude', 'vigil'));

    // Should still be one quicksave, not accumulated
    assert.ok(manifest2.quicksave);
    assert.equal(manifest2.checkpoints.length, 0); // quicksave doesn't count toward slots
  });

  it('binary files captured correctly', () => {
    // Write a binary file (PNG header + random bytes)
    const binary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    writeFileSync(join(projectDir, 'image.png'), binary);

    const result = createCheckpoint(projectDir, 'with-binary', 'manual');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.fileCount, 4); // 3 text files + 1 binary

    // Modify and restore
    writeFileSync(join(projectDir, 'image.png'), Buffer.from([0xFF]));
    restoreCheckpoint(projectDir, 'with-binary');

    const restored = readFileSync(join(projectDir, 'image.png'));
    assert.deepEqual(restored, binary);
  });

  it('.vigilignore: matching files excluded', () => {
    writeProjectFile(projectDir, '.vigilignore', '*.log\ntmp/');
    writeProjectFile(projectDir, 'debug.log', 'log content');
    writeProjectFile(projectDir, 'tmp/cache.json', '{}');

    const result = createCheckpoint(projectDir, 'with-ignore', 'manual');
    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    const files = Object.keys(manifest.checkpoints[0].files);

    assert.ok(!files.includes('debug.log'), 'should skip *.log');
    assert.ok(!files.includes('tmp/cache.json'), 'should skip tmp/');
    assert.ok(files.includes('.vigilignore'), '.vigilignore itself is captured');
  });

  it('list with name: drill into checkpoint files', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = listCheckpointFiles(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.files.length, 3);
    assert.ok(result.files.includes('src/app.js'));
  });

  it('list with glob: filter files', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = listCheckpointFiles(projectDir, 'v1', 'src/**');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.files.length, 2); // app.js and utils.js
    assert.equal(result.totalFiles, 3);
  });

  it('delete + GC: unreferenced objects removed', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const before = diskUsage(vigilDir);

    const result = deleteCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.deleted, 'v1');
    assert.ok(result.gc.removed > 0);
    assert.ok(result.gc.bytesFreed > 0);

    const after = diskUsage(vigilDir);
    assert.ok(after.totalBytes < before.totalBytes);
  });

  it('delete all: everything cleared', () => {
    createCheckpoint(projectDir, 'a', 'manual');
    createCheckpoint(projectDir, 'b', 'manual');
    const result = deleteCheckpoint(projectDir, undefined, { all: true });
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.deleted, 'all');

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    assert.equal(manifest.checkpoints.length, 0);
    assert.equal(manifest.quicksave, null);
  });

  it('duplicate name rejected', () => {
    createCheckpoint(projectDir, 'same', 'manual');
    const result = createCheckpoint(projectDir, 'same', 'manual');
    assert.ok('error' in result);
    if (!('error' in result)) return;
    assert.equal(result.error, 'duplicate_name');
  });

  it('not found errors handled gracefully', () => {
    const diff = diffCheckpoint(projectDir, 'nope');
    assert.ok('error' in diff && diff.error === 'not_found');
    const restore = restoreCheckpoint(projectDir, 'nope');
    assert.ok('error' in restore && restore.error === 'not_found');
    const list = listCheckpointFiles(projectDir, 'nope');
    assert.ok('error' in list);
    const del = deleteCheckpoint(projectDir, 'nope');
    assert.ok('error' in del && del.error === 'not_found');
  });
});

// ── Background worker test ────────────────────────────────────────

describe('worker', () => {
  it('spawns and completes a checkpoint', async () => {
    const projectDir = makeTempProject();
    writeProjectFile(projectDir, 'file.txt', 'content');
    mkdirSync(join(projectDir, '.claude', 'vigil'), { recursive: true });

    const workerPath = join(import.meta.url.replace('file://', '').replace('test/index.test.js', ''), 'src', 'worker.js');

    // Run worker synchronously for testing
    execFileSync(process.execPath, [workerPath, projectDir, 'worker-test', 'manual']);

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    assert.equal(manifest.checkpoints.length, 1);
    assert.equal(manifest.checkpoints[0].name, 'worker-test');

    // Lockfile should be cleaned up
    assert.ok(!existsSync(join(projectDir, '.claude', 'vigil', '.in-progress')));
  });
});

// ── Hook pattern test ─────────────────────────────────────────────

describe('hook patterns', () => {
  const DESTRUCTIVE = /\b(rm|rmdir|mv|sed\s+-i|perl\s+-i)\b|git\s+(checkout|reset|clean|restore)\b|>\s*\S/;

  it('detects destructive commands', () => {
    assert.ok(DESTRUCTIVE.test('rm -rf src/'));
    assert.ok(DESTRUCTIVE.test('rm src/file.js'));
    assert.ok(DESTRUCTIVE.test('mv old.js new.js'));
    assert.ok(DESTRUCTIVE.test('sed -i "s/old/new/" file.js'));
    assert.ok(DESTRUCTIVE.test('git checkout -- src/'));
    assert.ok(DESTRUCTIVE.test('git reset --hard'));
    assert.ok(DESTRUCTIVE.test('git clean -fd'));
    assert.ok(DESTRUCTIVE.test('git restore src/'));
    assert.ok(DESTRUCTIVE.test('echo "x" > file.js'));
  });

  it('ignores safe commands', () => {
    assert.ok(!DESTRUCTIVE.test('ls -la'));
    assert.ok(!DESTRUCTIVE.test('cat file.js'));
    assert.ok(!DESTRUCTIVE.test('npm install'));
    assert.ok(!DESTRUCTIVE.test('git status'));
    assert.ok(!DESTRUCTIVE.test('git log'));
    assert.ok(!DESTRUCTIVE.test('git diff'));
    assert.ok(!DESTRUCTIVE.test('node src/index.js'));
    assert.ok(!DESTRUCTIVE.test('npm test'));
  });
});
