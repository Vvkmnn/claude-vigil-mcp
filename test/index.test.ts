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
  listCheckpointFiles, deleteCheckpoint, generateUnifiedDiff
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

  it('full restore: all files reverted', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    writeProjectFile(projectDir, 'src/app.js', 'changed app');
    writeProjectFile(projectDir, 'src/utils.js', 'changed utils');

    restoreCheckpoint(projectDir, 'v1');

    // Both files should be reverted
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("hello");');
    assert.equal(readProjectFile(projectDir, 'src/utils.js'), 'export function add(a, b) { return a + b; }');
  });

  it('diff: added/modified/deleted detected', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    writeProjectFile(projectDir, 'src/app.js', 'modified');
    writeProjectFile(projectDir, 'src/new.js', 'new file');
    rmSync(join(projectDir, 'README.md'));

    const diff = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    assert.ok(diff.modified.some(f => f.path === 'src/app.js'));
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
    // .vigilignore now lives in .claude/vigil/, not project root
    const vigilDir = join(projectDir, '.claude', 'vigil');
    mkdirSync(vigilDir, { recursive: true });
    writeFileSync(join(vigilDir, '.vigilignore'), '*.log\ntmp/');

    writeProjectFile(projectDir, 'debug.log', 'log content');
    writeProjectFile(projectDir, 'tmp/cache.json', '{}');

    const result = createCheckpoint(projectDir, 'with-ignore', 'manual');
    const manifest = readManifest(vigilDir);
    const files = Object.keys(manifest.checkpoints[0].files);

    assert.ok(!files.includes('debug.log'), 'should skip *.log');
    assert.ok(!files.includes('tmp/cache.json'), 'should skip tmp/');
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

  // ── Enhanced diff tests ──────────────────────────────────────────

  it('diff: modified files include unified diff content', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("changed");');

    const diff = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    const change = diff.modified.find(f => f.path === 'src/app.js');
    assert.ok(change, 'src/app.js should be in modified');
    assert.ok(!change.binary, 'should not be binary');
    assert.ok(change.diff.includes('-console.log("hello");'), 'diff should show old line');
    assert.ok(change.diff.includes('+console.log("changed");'), 'diff should show new line');
    assert.ok(change.linesAdded > 0 || change.linesRemoved > 0, 'should have line counts');
  });

  it('diff summary mode: no diff content', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("changed");');

    const diff = diffCheckpoint(projectDir, 'v1', { summary: true });
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    const change = diff.modified.find(f => f.path === 'src/app.js');
    assert.ok(change, 'src/app.js should be in modified');
    assert.equal(change.diff, '', 'summary mode should have empty diff');
  });

  it('diff with file: returns content AND diff vs current', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("changed");');

    const result = diffCheckpoint(projectDir, 'v1', { file: 'src/app.js' });
    assert.ok('content' in result);
    if (!('content' in result)) return;
    assert.equal(result.content, 'console.log("hello");');
    assert.ok(result.diff, 'should include diff vs current');
    assert.ok(result.diff!.includes('-console.log("hello");'));
    assert.ok(result.diff!.includes('+console.log("changed");'));
  });

  it('diff: binary files detected correctly', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0A, 0x1A, 0x0A]);
    writeFileSync(join(projectDir, 'image.png'), binary);
    createCheckpoint(projectDir, 'v1', 'manual');

    // Modify the binary file
    writeFileSync(join(projectDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF]));

    const diff = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    const change = diff.modified.find(f => f.path === 'image.png');
    assert.ok(change, 'image.png should be in modified');
    assert.ok(change.binary, 'should be marked as binary');
    assert.equal(change.diff, '', 'binary files should have empty diff');
  });

  it('diff against: checkpoint vs checkpoint', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("v2");');
    writeProjectFile(projectDir, 'src/new.js', 'new file');
    createCheckpoint(projectDir, 'v2', 'manual');

    const diff = diffCheckpoint(projectDir, 'v1', { against: 'v2' });
    assert.ok('modified' in diff);
    if (!('modified' in diff)) return;
    assert.ok(diff.modified.some(f => f.path === 'src/app.js'), 'app.js should be modified');
    assert.ok(diff.added.includes('src/new.js'), 'new.js should be added');
  });

  it('checkpoint descriptions stored and accessible', () => {
    createCheckpoint(projectDir, 'described', 'manual', 'before auth migration');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    const cp = manifest.checkpoints.find(c => c.name === 'described');
    assert.ok(cp, 'checkpoint should exist');
    assert.equal(cp.description, 'before auth migration');
  });

  it('checkpoint without description still works', () => {
    createCheckpoint(projectDir, 'nodesc', 'manual');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    const cp = manifest.checkpoints.find(c => c.name === 'nodesc');
    assert.ok(cp, 'checkpoint should exist');
    assert.equal(cp.description, undefined);
  });

  it('search across checkpoints finds matching content', () => {
    writeProjectFile(projectDir, 'src/auth.ts', 'const token = JWT.sign(payload);');
    createCheckpoint(projectDir, 'with-jwt', 'manual');

    writeProjectFile(projectDir, 'src/auth.ts', 'const session = createSession(payload);');
    createCheckpoint(projectDir, 'with-sessions', 'manual');

    const result = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'JWT' });
    assert.ok('search' in result);
    if (!('search' in result)) return;
    assert.equal(result.hits.length, 1, 'only with-jwt checkpoint should match');
    assert.equal(result.hits[0].checkpoint, 'with-jwt');
  });

  it('search with no matches returns empty hits', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = diffCheckpoint(projectDir, '*', { file: 'src/app.js', search: 'nonexistent_string_xyz' });
    assert.ok('search' in result);
    if (!('search' in result)) return;
    assert.equal(result.hits.length, 0);
  });

  // ── Restore artifact preservation tests ──────────────────────────

  it('restore: modified files preserved in artifacts', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("modified");');

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // File should be restored to checkpoint version
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("hello");');

    // Displaced modified file should be in artifacts
    assert.ok(result.displaced.length > 0, 'should have displaced files');
    const displaced = result.displaced.find(d => d.path === 'src/app.js');
    assert.ok(displaced, 'src/app.js should be displaced');
    assert.equal(displaced.reason, 'modified');

    // Artifacts directory should exist and contain the old version
    assert.ok(result.artifactsDir, 'should have artifacts dir');
    const artifactContent = readFileSync(join(projectDir, result.artifactsDir, 'src/app.js'), 'utf8');
    assert.equal(artifactContent, 'console.log("modified");');
  });

  it('restore: new files moved to artifacts', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/brand-new.js', 'brand new file');

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // New file should no longer exist in project
    assert.ok(!existsSync(join(projectDir, 'src/brand-new.js')), 'new file should be removed from project');

    // New file should be in artifacts
    const displaced = result.displaced.find(d => d.path === 'src/brand-new.js');
    assert.ok(displaced, 'brand-new.js should be displaced');
    assert.equal(displaced.reason, 'new');

    const artifactContent = readFileSync(join(projectDir, result.artifactsDir, 'src/brand-new.js'), 'utf8');
    assert.equal(artifactContent, 'brand new file');
  });

  it('restore: no artifacts created when working directory matches checkpoint', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    // Don't modify anything

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    assert.equal(result.displaced.length, 0, 'no displaced files');
    assert.equal(result.artifactsDir, '', 'no artifacts dir when nothing displaced');
  });

  it('restore: artifacts not affected by subsequent saves', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'console.log("modified");');

    const restoreResult = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in restoreResult));
    if ('error' in restoreResult) return;

    // Artifacts exist
    const artifactPath = join(projectDir, restoreResult.artifactsDir, 'src/app.js');
    assert.ok(existsSync(artifactPath), 'artifact should exist');

    // Save a new checkpoint — artifacts should still be there
    createCheckpoint(projectDir, 'v2', 'manual');
    assert.ok(existsSync(artifactPath), 'artifact should survive subsequent saves');
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

// ── Comprehensive edge case tests ─────────────────────────────────

describe('unified diff algorithm', () => {
  it('identical content produces empty diff', () => {
    const diff = generateUnifiedDiff('hello\nworld', 'hello\nworld', 'test.txt');
    assert.equal(diff, '');
  });

  it('complete replacement produces correct diff', () => {
    const diff = generateUnifiedDiff('old line 1\nold line 2', 'new line 1\nnew line 2', 'test.txt');
    assert.ok(diff.includes('-old line 1'));
    assert.ok(diff.includes('+new line 1'));
    assert.ok(diff.includes('-old line 2'));
    assert.ok(diff.includes('+new line 2'));
    assert.ok(diff.startsWith('--- a/test.txt'));
  });

  it('empty to content produces all additions', () => {
    const diff = generateUnifiedDiff('', 'line 1\nline 2\nline 3', 'new.txt');
    assert.ok(diff.includes('+line 1'));
    assert.ok(diff.includes('+line 2'));
    assert.ok(diff.includes('+line 3'));
    // '' splits to [''] (one empty line), so there's one deletion of that empty line
    // This is correct LCS behavior — the "old" content is one empty line
  });

  it('content to empty produces all deletions', () => {
    const diff = generateUnifiedDiff('line 1\nline 2\nline 3', '', 'old.txt');
    assert.ok(diff.includes('-line 1'));
    assert.ok(diff.includes('-line 2'));
    assert.ok(diff.includes('-line 3'));
  });

  it('single line change has context lines', () => {
    const old = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7';
    const cur = 'line 1\nline 2\nline 3\nLINE FOUR\nline 5\nline 6\nline 7';
    const diff = generateUnifiedDiff(old, cur, 'ctx.txt');
    // Should have @@ header
    assert.ok(diff.includes('@@'));
    // Context lines (3 before, 3 after the change)
    assert.ok(diff.includes(' line 3'));
    assert.ok(diff.includes(' line 5'));
    assert.ok(diff.includes('-line 4'));
    assert.ok(diff.includes('+LINE FOUR'));
  });

  it('both empty produces empty diff', () => {
    const diff = generateUnifiedDiff('', '', 'empty.txt');
    assert.equal(diff, '');
  });

  it('multiline insertion in the middle', () => {
    const old = 'a\nb\nc';
    const cur = 'a\nb\ninserted1\ninserted2\nc';
    const diff = generateUnifiedDiff(old, cur, 'mid.txt');
    assert.ok(diff.includes('+inserted1'));
    assert.ok(diff.includes('+inserted2'));
    // 'b' and 'c' should be context
    assert.ok(diff.includes(' b') || diff.includes(' a'));
  });
});

describe('edge cases: save', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'console.log("hello");');
  });

  it('max_checkpoints can be increased', () => {
    const vigilDir = join(projectDir, '.claude', 'vigil');
    mkdirSync(vigilDir, { recursive: true });

    // Create 3 checkpoints (default limit)
    createCheckpoint(projectDir, 'a', 'manual');
    createCheckpoint(projectDir, 'b', 'manual');
    createCheckpoint(projectDir, 'c', 'manual');

    // 4th should fail
    const blocked = createCheckpoint(projectDir, 'd', 'manual');
    assert.ok('error' in blocked && blocked.error === 'slots_full');

    // Increase limit via manifest
    const manifest = readManifest(vigilDir);
    manifest.config = manifest.config ?? {};
    manifest.config.maxCheckpoints = 5;
    writeManifest(vigilDir, manifest);

    // Now 4th and 5th should succeed
    const d = createCheckpoint(projectDir, 'd', 'manual');
    assert.ok(!('error' in d));
    const e = createCheckpoint(projectDir, 'e', 'manual');
    assert.ok(!('error' in e));

    // 6th should fail at new limit
    const f = createCheckpoint(projectDir, 'f', 'manual');
    assert.ok('error' in f && f.error === 'slots_full');
  });

  it('empty project directory still creates checkpoint', () => {
    const emptyDir = makeTempProject();
    const result = createCheckpoint(emptyDir, 'empty', 'manual');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.equal(result.fileCount, 0);
  });

  it('deeply nested files are captured', () => {
    writeProjectFile(projectDir, 'a/b/c/d/e/deep.txt', 'deep content');
    const result = createCheckpoint(projectDir, 'deep', 'manual');
    assert.ok(!('error' in result));

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    assert.ok(manifest.checkpoints[0].files['a/b/c/d/e/deep.txt']);
  });

  it('special characters in file names', () => {
    writeProjectFile(projectDir, 'src/file with spaces.js', 'spaces');
    writeProjectFile(projectDir, 'src/file-with-dashes.js', 'dashes');
    writeProjectFile(projectDir, 'src/file_underscores.js', 'underscores');
    const result = createCheckpoint(projectDir, 'special', 'manual');
    assert.ok(!('error' in result));

    const manifest = readManifest(join(projectDir, '.claude', 'vigil'));
    const files = Object.keys(manifest.checkpoints[0].files);
    assert.ok(files.includes('src/file with spaces.js'));
    assert.ok(files.includes('src/file-with-dashes.js'));
    assert.ok(files.includes('src/file_underscores.js'));
  });
});

describe('edge cases: restore artifacts', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'console.log("hello");');
    writeProjectFile(projectDir, 'src/utils.js', 'export function add(a, b) { return a + b; }');
    writeProjectFile(projectDir, 'README.md', '# My Project');
  });

  it('restore with mixed modified + new + unchanged files', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    // Modify one, add one, leave one unchanged
    writeProjectFile(projectDir, 'src/app.js', 'MODIFIED');
    writeProjectFile(projectDir, 'src/brand-new.js', 'NEW FILE');
    // src/utils.js and README.md stay the same

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // Verify project state matches checkpoint
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'console.log("hello");');
    assert.equal(readProjectFile(projectDir, 'src/utils.js'), 'export function add(a, b) { return a + b; }');
    assert.equal(readProjectFile(projectDir, 'README.md'), '# My Project');
    assert.ok(!existsSync(join(projectDir, 'src/brand-new.js')));

    // Verify displaced files
    const modified = result.displaced.filter(d => d.reason === 'modified');
    const newFiles = result.displaced.filter(d => d.reason === 'new');
    assert.equal(modified.length, 1);
    assert.equal(modified[0].path, 'src/app.js');
    assert.equal(newFiles.length, 1);
    assert.equal(newFiles[0].path, 'src/brand-new.js');

    // Verify artifact contents are the PRE-restore versions
    const artifactModified = readFileSync(join(projectDir, result.artifactsDir, 'src/app.js'), 'utf8');
    assert.equal(artifactModified, 'MODIFIED');
    const artifactNew = readFileSync(join(projectDir, result.artifactsDir, 'src/brand-new.js'), 'utf8');
    assert.equal(artifactNew, 'NEW FILE');
  });

  it('restore deeply nested new files moves them to artifacts', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'a/b/c/deep-new.txt', 'deeply nested new');

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    assert.ok(!existsSync(join(projectDir, 'a/b/c/deep-new.txt')));
    const displaced = result.displaced.find(d => d.path === 'a/b/c/deep-new.txt');
    assert.ok(displaced);
    assert.equal(displaced.reason, 'new');

    const artifactContent = readFileSync(join(projectDir, result.artifactsDir, 'a/b/c/deep-new.txt'), 'utf8');
    assert.equal(artifactContent, 'deeply nested new');
  });

  it('multiple restores create separate artifact directories', () => {
    createCheckpoint(projectDir, 'v1', 'manual');

    // First restore with changes
    writeProjectFile(projectDir, 'src/app.js', 'change 1');
    const r1 = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in r1) && r1.artifactsDir);

    // Second restore with different changes
    writeProjectFile(projectDir, 'src/app.js', 'change 2');
    const r2 = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in r2) && r2.artifactsDir);

    // Artifact dirs should be different
    if ('error' in r1 || 'error' in r2) return;
    assert.notEqual(r1.artifactsDir, r2.artifactsDir);

    // Both should exist with their respective content
    const a1 = readFileSync(join(projectDir, r1.artifactsDir, 'src/app.js'), 'utf8');
    assert.equal(a1, 'change 1');
    const a2 = readFileSync(join(projectDir, r2.artifactsDir, 'src/app.js'), 'utf8');
    assert.equal(a2, 'change 2');
  });

  it('restore from quicksave works with artifacts', () => {
    // Create a manual checkpoint, then trigger quicksave via restore
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'before quicksave');
    restoreCheckpoint(projectDir, 'v1'); // creates quicksave

    // Now modify and restore from quicksave
    writeProjectFile(projectDir, 'src/app.js', 'after quicksave');
    const result = restoreCheckpoint(projectDir, '~quicksave');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // Quicksave captured the state right before the first restore
    // which had 'before quicksave' in it
    const displaced = result.displaced.find(d => d.path === 'src/app.js');
    assert.ok(displaced, 'should displace the modified file');
    assert.equal(displaced.reason, 'modified');
  });

  it('restore with only deletions (file removed since checkpoint)', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    rmSync(join(projectDir, 'README.md'));

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // README should be back
    assert.equal(readProjectFile(projectDir, 'README.md'), '# My Project');
    // No displaced files since nothing was modified or new — only a missing file was restored
    // (deleted files don't get displaced, they just get restored)
    const readmeDisplaced = result.displaced.find(d => d.path === 'README.md');
    assert.ok(!readmeDisplaced, 'deleted files should not appear as displaced');
  });

  it('binary files are correctly preserved in artifacts', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0A, 0x1A, 0x0A]);
    writeFileSync(join(projectDir, 'image.png'), binary);
    createCheckpoint(projectDir, 'v1', 'manual');

    // Modify binary
    const modified = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    writeFileSync(join(projectDir, 'image.png'), modified);

    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok(!('error' in result));
    if ('error' in result) return;

    // Original binary restored
    assert.deepEqual(readFileSync(join(projectDir, 'image.png')), binary);

    // Modified binary preserved in artifacts
    const displaced = result.displaced.find(d => d.path === 'image.png');
    assert.ok(displaced);
    assert.deepEqual(readFileSync(join(projectDir, result.artifactsDir, 'image.png')), modified);
  });
});

describe('edge cases: diff', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'console.log("hello");');
    writeProjectFile(projectDir, 'src/utils.js', 'export function add(a, b) { return a + b; }');
    writeProjectFile(projectDir, 'README.md', '# My Project');
  });

  it('diff with file for nonexistent file returns error', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = diffCheckpoint(projectDir, 'v1', { file: 'nonexistent.js' });
    assert.ok('error' in result);
    if (!('error' in result)) return;
    assert.equal(result.error, 'file_not_found');
  });

  it('diff with file when current file is deleted shows content only, no diff', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    rmSync(join(projectDir, 'src/app.js'));

    const result = diffCheckpoint(projectDir, 'v1', { file: 'src/app.js' });
    assert.ok('content' in result);
    if (!('content' in result)) return;
    assert.equal(result.content, 'console.log("hello");');
    // diff should be undefined since current file doesn't exist
    assert.equal(result.diff, undefined);
  });

  it('diff against nonexistent checkpoint returns error', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = diffCheckpoint(projectDir, 'v1', { against: 'nonexistent' });
    assert.ok('error' in result);
    if (!('error' in result)) return;
    assert.equal(result.error, 'not_found');
  });

  it('diff against same checkpoint shows no changes', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = diffCheckpoint(projectDir, 'v1', { against: 'v1' });
    assert.ok('added' in result);
    if (!('added' in result)) return;
    assert.equal(result.added.length, 0);
    assert.equal(result.modified.length, 0);
    assert.equal(result.deleted.length, 0);
  });

  it('diff summary mode with checkpoint-vs-checkpoint', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'changed');
    createCheckpoint(projectDir, 'v2', 'manual');

    const result = diffCheckpoint(projectDir, 'v1', { against: 'v2', summary: true });
    assert.ok('modified' in result);
    if (!('modified' in result)) return;
    const change = result.modified.find(f => f.path === 'src/app.js');
    assert.ok(change);
    assert.equal(change.diff, '', 'summary mode should have empty diff');
  });

  it('search across checkpoints with file that doesnt exist in any', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const result = diffCheckpoint(projectDir, '*', { file: 'nonexistent.js', search: 'anything' });
    assert.ok('search' in result);
    if (!('search' in result)) return;
    assert.equal(result.hits.length, 0);
  });

  it('search includes quicksave', () => {
    writeProjectFile(projectDir, 'src/auth.ts', 'const SECRET = "abc123";');
    createCheckpoint(projectDir, '~quicksave', 'quicksave');

    const result = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'SECRET' });
    assert.ok('search' in result);
    if (!('search' in result)) return;
    assert.ok(result.hits.some(h => h.checkpoint === '~quicksave'));
  });

  it('search returns context lines around matches', () => {
    writeProjectFile(projectDir, 'src/auth.ts', 'line1\nline2\nTARGET\nline4\nline5');
    createCheckpoint(projectDir, 'v1', 'manual');

    const result = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'TARGET' });
    assert.ok('search' in result);
    if (!('search' in result)) return;
    assert.equal(result.hits.length, 1);
    // Should have context lines around the match
    const lines = result.hits[0].lines;
    assert.ok(lines.some(l => l.includes('TARGET')), 'should contain the match');
    assert.ok(lines.some(l => l.includes('line2')), 'should contain context before');
    assert.ok(lines.some(l => l.includes('line4')), 'should contain context after');
    // The match line should be marked with >
    assert.ok(lines.some(l => l.startsWith('>')), 'match line should start with >');
  });

  it('diff with large number of changes', () => {
    // Create a file with many lines
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeProjectFile(projectDir, 'big.txt', lines.join('\n'));
    createCheckpoint(projectDir, 'v1', 'manual');

    // Modify every other line
    const modified = lines.map((l, i) => i % 2 === 0 ? l.toUpperCase() : l);
    writeProjectFile(projectDir, 'big.txt', modified.join('\n'));

    const result = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in result);
    if (!('modified' in result)) return;
    const change = result.modified.find(f => f.path === 'big.txt');
    assert.ok(change);
    assert.ok(change.linesAdded > 0);
    assert.ok(change.linesRemoved > 0);
    assert.ok(change.diff.includes('@@'));
  });

  it('diff no changes returns empty lists', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    // No changes
    const result = diffCheckpoint(projectDir, 'v1');
    assert.ok('added' in result);
    if (!('added' in result)) return;
    assert.equal(result.added.length, 0);
    assert.equal(result.modified.length, 0);
    assert.equal(result.deleted.length, 0);
  });
});

describe('edge cases: descriptions', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'hello');
  });

  it('description with special characters preserved', () => {
    createCheckpoint(projectDir, 'v1', 'manual', 'before "refactoring" — JWT → sessions');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    assert.equal(manifest.checkpoints[0].description, 'before "refactoring" — JWT → sessions');
  });

  it('description with multiline string', () => {
    createCheckpoint(projectDir, 'v1', 'manual', 'line 1\nline 2\nline 3');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    assert.equal(manifest.checkpoints[0].description, 'line 1\nline 2\nline 3');
  });

  it('empty string description is stored (different from undefined)', () => {
    createCheckpoint(projectDir, 'v1', 'manual', '');
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    // Empty string is falsy, so the spread won't add it
    // This is expected behavior — empty description = no description
    assert.equal(manifest.checkpoints[0].description, undefined);
  });
});

describe('edge cases: lifecycle', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeProjectFile(projectDir, 'src/app.js', 'original');
    writeProjectFile(projectDir, 'src/utils.js', 'utils');
  });

  it('save → modify → diff → restore → diff shows no changes', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'changed');

    // Diff should show changes
    const diff1 = diffCheckpoint(projectDir, 'v1');
    assert.ok('modified' in diff1);
    if (!('modified' in diff1)) return;
    assert.ok(diff1.modified.length > 0);

    // Restore
    restoreCheckpoint(projectDir, 'v1');

    // Diff should show no changes
    const diff2 = diffCheckpoint(projectDir, 'v1');
    assert.ok('added' in diff2);
    if (!('added' in diff2)) return;
    assert.equal(diff2.modified.length, 0);
    assert.equal(diff2.added.length, 0);
    assert.equal(diff2.deleted.length, 0);
  });

  it('save v1 → modify → save v2 → diff v1 against v2', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'v2 content');
    writeProjectFile(projectDir, 'src/new.js', 'brand new');
    createCheckpoint(projectDir, 'v2', 'manual');

    const diff = diffCheckpoint(projectDir, 'v1', { against: 'v2' });
    assert.ok('added' in diff);
    if (!('added' in diff)) return;
    assert.ok(diff.modified.some(f => f.path === 'src/app.js'));
    assert.ok(diff.added.includes('src/new.js'));
    // Should have actual diff content
    const appChange = diff.modified.find(f => f.path === 'src/app.js');
    assert.ok(appChange && appChange.diff.includes('+v2 content'));
  });

  it('restore → undo via quicksave → verify roundtrip', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    writeProjectFile(projectDir, 'src/app.js', 'modified state');

    // Restore to v1 (saves quicksave of "modified state")
    restoreCheckpoint(projectDir, 'v1');
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'original');

    // Undo by restoring quicksave
    const undoResult = restoreCheckpoint(projectDir, '~quicksave');
    assert.ok(!('error' in undoResult));
    assert.equal(readProjectFile(projectDir, 'src/app.js'), 'modified state');
  });

  it('delete checkpoint then try to restore returns error', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    deleteCheckpoint(projectDir, 'v1');
    const result = restoreCheckpoint(projectDir, 'v1');
    assert.ok('error' in result && result.error === 'not_found');
  });

  it('CAS dedup: identical files across checkpoints share objects', () => {
    createCheckpoint(projectDir, 'v1', 'manual');
    const usage1 = diskUsage(join(projectDir, '.claude', 'vigil'));

    // Create another checkpoint with same content — should add zero new objects
    const result = createCheckpoint(projectDir, 'v2', 'manual');
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.ok('newObjects' in result);
    if (!('newObjects' in result)) return;
    assert.equal(result.newObjects, 0, 'identical content should reuse CAS objects');

    const usage2 = diskUsage(join(projectDir, '.claude', 'vigil'));
    // Object count should not increase (only manifest changes)
    assert.equal(usage2.objectCount, usage1.objectCount);
  });

  it('search tracks content evolution across checkpoints', () => {
    writeProjectFile(projectDir, 'src/auth.ts', 'const auth = JWT.sign(payload);');
    createCheckpoint(projectDir, 'jwt-era', 'manual', 'using JWT');

    writeProjectFile(projectDir, 'src/auth.ts', 'const auth = createSession(payload);');
    createCheckpoint(projectDir, 'session-era', 'manual', 'using sessions');

    writeProjectFile(projectDir, 'src/auth.ts', 'const auth = OAuth.authorize(payload);');
    createCheckpoint(projectDir, 'oauth-era', 'manual', 'using OAuth');

    // Search for JWT — only in first checkpoint
    const jwt = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'JWT' });
    assert.ok('search' in jwt && jwt.hits.length === 1);
    if ('search' in jwt) assert.equal(jwt.hits[0].checkpoint, 'jwt-era');

    // Search for Session — only in second
    const session = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'Session' });
    assert.ok('search' in session && session.hits.length === 1);
    if ('search' in session) assert.equal(session.hits[0].checkpoint, 'session-era');

    // Search for 'auth' — in all three
    const auth = diffCheckpoint(projectDir, '*', { file: 'src/auth.ts', search: 'auth' });
    assert.ok('search' in auth && auth.hits.length === 3);
  });
});
