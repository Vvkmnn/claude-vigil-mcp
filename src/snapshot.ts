// Snapshot operations: create, restore, diff, and project walking.
// Captures EVERYTHING in the project — no file size or binary filtering.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync, unlinkSync, rmSync, copyFileSync, renameSync
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { hashContent, storeObject, readObject, gcObjects, diskUsage } from './store.js';
import type {
  Manifest, Checkpoint, CheckpointFiles, FileChange, SearchHit, DisplacedFile,
  CreateCheckpointResult, RestoreResult, DiffResult, ListResult, DeleteResult,
  WalkCallback
} from './types.js';

// VCS internals and OS junk — never useful to restore, can cause conflicts
const ALWAYS_SKIP = new Set(['.git', '.hg', '.svn', '.DS_Store', 'Thumbs.db', '.claude']);

// Derived artifact directories — managed by build systems, regenerated on install/build.
// Storing these wastes space and causes permission issues on restore (e.g. node_modules/.bin).
const DERIVED_DIRS = new Set([
  // JavaScript / TypeScript (Node.js, Deno, Bun)
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.parcel-cache', '.turbo',
  // Python
  'venv', '.venv', 'env', '__pycache__', '.eggs', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  // Rust
  'target',
  // Go
  'vendor',
  // Java / Kotlin / Scala
  '.gradle', '.m2', '.mvn', '.idea', 'bin', 'obj',
  // C# / .NET
  'packages',
  // C / C++
  'cmake-build-debug', 'cmake-build-release',
  // Ruby
  'vendor/bundle', '.bundle',
  // PHP (Composer)
  'vendor',
  // Swift / iOS
  'Pods', '.build', 'DerivedData',
  // Dart / Flutter
  '.dart_tool', '.flutter-plugins', '.pub-cache',
  // Elixir / Erlang
  '_build', 'deps',
  // Haskell
  '.stack-work', 'dist-newstyle',
  // Lua (LuaRocks)
  'lua_modules',
  // R
  'renv', 'packrat',
  // Terraform / IaC
  '.terraform',
  // General build caches
  '.cache', '.parcel-cache', '.eslintcache', '.stylelintcache',
]);

/**
 * Parse .gitignore to extract directory patterns.
 * This is the project's own declaration of "what's derived" — language-agnostic.
 */
function parseGitignoreDirs(projectDir: string): string[] {
  const p = join(projectDir, '.gitignore');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    // Only directory patterns (trailing / or known dir names that exist)
    .filter(l => {
      // Explicit directory pattern like "dist/" or "node_modules/"
      if (l.endsWith('/')) return true;
      // Check if the pattern (without negation/glob) refers to an existing directory
      const clean = l.replace(/^!/, '').replace(/\/\*\*$/, '').replace(/\/$/, '');
      if (clean.includes('*')) return false; // skip glob file patterns like *.pyc
      try {
        return existsSync(join(projectDir, clean)) && statSync(join(projectDir, clean)).isDirectory();
      } catch { return false; }
    })
    .map(l => l.replace(/\/\*\*$/, '/').replace(/\/$/, '') + '/') // normalize to "dir/"
    .filter(l => !l.startsWith('!')); // skip negation patterns
}

/** Return which derived dirs were skipped and exist in the project (need regenerating after restore). */
export function detectSkippedDirs(projectDir: string): string[] {
  return detectDerivedDirs(projectDir);
}

const DEFAULT_MAX_CHECKPOINTS = 3;

// ── Manifest I/O ──────────────────────────────────────────────────

function manifestPath(vigilDir: string): string {
  return join(vigilDir, 'manifest.json');
}

export function readManifest(vigilDir: string): Manifest {
  const p = manifestPath(vigilDir);
  if (!existsSync(p)) return { checkpoints: [], quicksave: null, config: {} };
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeManifest(vigilDir: string, manifest: Manifest): void {
  mkdirSync(vigilDir, { recursive: true });
  writeFileSync(manifestPath(vigilDir), JSON.stringify(manifest, null, 2));
}

// ── .vigilignore parsing (gitignore subset) ───────────────────────

/** Detect which DERIVED_DIRS actually exist in the project. */
/**
 * Detect derived/artifact directories in the project.
 * Merges two sources:
 *   1. Project's .gitignore — the project's own declaration of what's derived
 *   2. DERIVED_DIRS fallback — common patterns for projects without .gitignore coverage
 * Returns normalized "dir/" patterns for directories that actually exist.
 */
export function detectDerivedDirs(projectDir: string): string[] {
  const found = new Set<string>();

  // Source 1: .gitignore directory patterns (language-agnostic, project-specific)
  for (const dir of parseGitignoreDirs(projectDir)) {
    found.add(dir);
  }

  // Source 2: hardcoded fallback for common derived dirs
  for (const dir of DERIVED_DIRS) {
    const fullPath = join(projectDir, dir);
    try {
      if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
        found.add(dir + '/');
      }
    } catch { /* permission denied, broken symlink */ }
  }

  return [...found].sort();
}

/** Write the .vigilignore file inside the vigil dir. */
export function writeVigilignore(vigilDir: string, patterns: string[], projectDir?: string): void {
  mkdirSync(vigilDir, { recursive: true });

  // Separate patterns by source for clarity
  const gitignoreDirs = projectDir ? new Set(parseGitignoreDirs(projectDir)) : new Set<string>();
  const fromGitignore = patterns.filter(p => gitignoreDirs.has(p));
  const fromFallback = patterns.filter(p => !gitignoreDirs.has(p));

  const lines: string[] = ['# Auto-detected by vigil — edit to adjust what gets checkpointed'];
  if (fromGitignore.length > 0) {
    lines.push('', '# From .gitignore (project declares these as derived)');
    lines.push(...fromGitignore);
  }
  if (fromFallback.length > 0) {
    lines.push('', '# Common build artifacts (detected by vigil)');
    lines.push(...fromFallback);
  }
  lines.push('', '# Add project-specific patterns below', '');

  writeFileSync(join(vigilDir, '.vigilignore'), lines.join('\n'));
}

/** Check if .vigilignore has been initialized (first-save flow complete). */
export function hasVigilignore(vigilDir: string): boolean {
  return existsSync(join(vigilDir, '.vigilignore'));
}

function parseVigilignore(projectDir: string): string[] {
  // Read from .claude/vigil/.vigilignore (not project root)
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const p = join(vigilDir, '.vigilignore');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

/** Simple gitignore-style match: supports trailing /, leading *, and exact names. */
function matchesIgnore(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Directory pattern: "node_modules/" matches any path starting with it
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (relPath === dir || relPath.startsWith(dir + '/')) return true;
    }
    // Glob pattern: "*.log" matches any file ending with .log
    else if (pattern.startsWith('*')) {
      if (relPath.endsWith(pattern.slice(1))) return true;
    }
    // Exact match or prefix match
    else {
      if (relPath === pattern || relPath.startsWith(pattern + '/')) return true;
    }
  }
  return false;
}

// ── Project walking ───────────────────────────────────────────────

/**
 * Walk the project directory, calling callback(relativePath, buffer) for each file.
 * Skips VCS internals, OS junk, and .vigilignore patterns.
 * No file size or binary filtering — captures everything.
 */
export function walkProject(projectDir: string, callback: WalkCallback, ignorePatterns: string[] = []): void {
  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; } // Permission denied, broken symlink, etc.

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (entry.isDirectory() && DERIVED_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(projectDir, fullPath);

      if (matchesIgnore(relPath, ignorePatterns)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const buf = readFileSync(fullPath);
          callback(relPath, buf);
        } catch { /* skip unreadable files */ }
      }
      // Skip symlinks, sockets, etc.
    }
  }

  walk(projectDir);
}

// ── Unified diff generation ───────────────────────────────────────

/** Check if content is binary by looking for null bytes in the first 8KB. */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Generate a unified diff between two strings.
 * LCS-based, zero dependencies. Returns standard format with @@ headers.
 */
export function generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  // Build LCS table (O(n*m) space — fine for source files)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get edit script: 'keep' | 'delete' | 'insert'
  type Edit = { type: 'keep' | 'delete' | 'insert'; oldIdx: number; newIdx: number; line: string };
  const edits: Edit[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ type: 'keep', oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: 'insert', oldIdx: i - 1, newIdx: j - 1, line: newLines[j - 1] });
      j--;
    } else {
      edits.push({ type: 'delete', oldIdx: i - 1, newIdx: -1, line: oldLines[i - 1] });
      i--;
    }
  }
  edits.reverse();

  // Group into hunks with 3 lines of context
  const CONTEXT = 3;
  type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] };
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let lastChangeIdx = -999;

  let oldLine = 0, newLine = 0;
  for (let e = 0; e < edits.length; e++) {
    const edit = edits[e];
    const isChange = edit.type !== 'keep';

    if (isChange) {
      // Start a new hunk if this change is far from the last one
      if (e - lastChangeIdx > CONTEXT * 2 + 1 || !hunk) {
        // Flush previous hunk
        if (hunk) hunks.push(hunk);
        // Start new hunk with leading context
        const contextStart = Math.max(0, e - CONTEXT);
        hunk = { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] };
        // Recount positions for the context start
        let oPos = 0, nPos = 0;
        for (let k = 0; k < contextStart; k++) {
          if (edits[k].type === 'keep' || edits[k].type === 'delete') oPos++;
          if (edits[k].type === 'keep' || edits[k].type === 'insert') nPos++;
        }
        hunk.oldStart = oPos + 1;
        hunk.newStart = nPos + 1;
        // Add leading context lines
        for (let k = contextStart; k < e; k++) {
          if (edits[k].type === 'keep') {
            hunk.lines.push(' ' + edits[k].line);
            hunk.oldCount++;
            hunk.newCount++;
          }
        }
      }
      lastChangeIdx = e;
    }

    if (!hunk) continue;

    if (isChange) {
      if (edit.type === 'delete') {
        hunk.lines.push('-' + edit.line);
        hunk.oldCount++;
      } else {
        hunk.lines.push('+' + edit.line);
        hunk.newCount++;
      }
    } else {
      // Context line — only include if within CONTEXT of a change
      if (e - lastChangeIdx <= CONTEXT) {
        hunk.lines.push(' ' + edit.line);
        hunk.oldCount++;
        hunk.newCount++;
      }
    }

    if (edit.type === 'keep' || edit.type === 'delete') oldLine++;
    if (edit.type === 'keep' || edit.type === 'insert') newLine++;
  }
  if (hunk) hunks.push(hunk);

  if (hunks.length === 0) return '';

  // Format
  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}

// ── Checkpoint operations ─────────────────────────────────────────

/**
 * Create a named checkpoint. Walks project, hashes + stores every file.
 * Returns { name, type, created, fileCount, newObjects }.
 */
export function createCheckpoint(projectDir: string, name: string, type: string = 'manual', description?: string): CreateCheckpointResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  mkdirSync(join(vigilDir, 'objects'), { recursive: true });

  const manifest = readManifest(vigilDir);
  const ignorePatterns = parseVigilignore(projectDir);
  const maxCheckpoints = manifest.config?.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;

  // For quicksave type, overwrite the single quicksave slot
  if (type === 'quicksave') {
    const files: CheckpointFiles = {};
    let fileCount = 0;
    walkProject(projectDir, (relPath, buf) => {
      files[relPath] = storeObject(vigilDir, buf);
      fileCount++;
    }, ignorePatterns);

    manifest.quicksave = { name: '~quicksave', created: new Date().toISOString(), files, fileCount };
    writeManifest(vigilDir, manifest);
    return { name: '~quicksave', type: 'quicksave', created: manifest.quicksave.created, fileCount };
  }

  // Check slot limit for named checkpoints
  if (manifest.checkpoints.length >= maxCheckpoints) {
    return {
      error: 'slots_full',
      max: maxCheckpoints,
      checkpoints: manifest.checkpoints.map(c => ({ name: c.name, created: c.created }))
    };
  }

  // Check for duplicate name
  if (manifest.checkpoints.some(c => c.name === name)) {
    return { error: 'duplicate_name', name };
  }

  const files: CheckpointFiles = {};
  let fileCount = 0;
  let newObjects = 0;

  walkProject(projectDir, (relPath, buf) => {
    const hash = hashContent(buf);
    const objPath = join(vigilDir, 'objects', hash.slice(0, 2), hash.slice(2) + '.gz');
    if (!existsSync(objPath)) {
      storeObject(vigilDir, buf);
      newObjects++;
    }
    files[relPath] = hash;
    fileCount++;
  }, ignorePatterns);

  const checkpoint: Checkpoint = {
    name,
    type,
    created: new Date().toISOString(),
    files,
    fileCount,
    ...(description ? { description } : {}),
  };
  manifest.checkpoints.push(checkpoint);
  writeManifest(vigilDir, manifest);

  const usage = diskUsage(vigilDir);
  return { name, type, created: checkpoint.created, fileCount, newObjects, usage };
}

/** Format a timestamp for artifact directory names. Includes milliseconds for uniqueness. */
function artifactTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${ms}`;
}

/**
 * Restore a checkpoint. Always restores the ENTIRE codebase (no selective file restore).
 * Quicksaves current state first (emulator pattern).
 *
 * No data loss: modified and new files are preserved in .claude/vigil/artifacts/
 * before being overwritten or moved. Artifacts are never touched by save/restore.
 */
export function restoreCheckpoint(projectDir: string, name: string): RestoreResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  // Find the checkpoint
  const checkpoint = findCheckpoint(manifest, name);
  if (!checkpoint) return { error: 'not_found', name };

  // Quicksave current state before restoring (emulator pattern)
  createCheckpoint(projectDir, '~quicksave', 'quicksave');

  // Create artifacts directory for displaced files
  const ts = artifactTimestamp();
  const artifactsDirName = `restored_${name}_${ts}`;
  const artifactsDir = join(vigilDir, 'artifacts', artifactsDirName);
  mkdirSync(artifactsDir, { recursive: true });

  const ignorePatterns = parseVigilignore(projectDir);
  const checkpointPaths = new Set(Object.keys(checkpoint.files));
  const displaced: DisplacedFile[] = [];

  // Phase 1: Walk project to find modified and new files, preserve them
  walkProject(projectDir, (relPath, buf) => {
    const cpHash = checkpoint!.files[relPath];
    const fullPath = join(projectDir, relPath);
    const artifactPath = join(artifactsDir, relPath);

    if (!cpHash) {
      // New file (not in checkpoint) — move to artifacts
      mkdirSync(dirname(artifactPath), { recursive: true });
      try {
        renameSync(fullPath, artifactPath);
      } catch {
        // Cross-device rename fails — fall back to copy+delete
        copyFileSync(fullPath, artifactPath);
        unlinkSync(fullPath);
      }
      displaced.push({ path: relPath, reason: 'new' });
    } else if (cpHash !== hashContent(buf)) {
      // Modified file — copy current version to artifacts before overwriting
      mkdirSync(dirname(artifactPath), { recursive: true });
      copyFileSync(fullPath, artifactPath);
      displaced.push({ path: relPath, reason: 'modified' });
    }
  }, ignorePatterns);

  // Phase 2: Restore all files from checkpoint
  let filesRestored = 0;
  for (const [relPath, hash] of Object.entries(checkpoint.files)) {
    const fullPath = join(projectDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, readObject(vigilDir, hash));
    filesRestored++;
  }

  // Clean up artifacts dir if nothing was displaced
  if (displaced.length === 0) {
    try { rmSync(artifactsDir, { recursive: true }); } catch { /* fine */ }
  }

  const usage = diskUsage(vigilDir);
  const artifactsRelDir = displaced.length > 0
    ? `.claude/vigil/artifacts/${artifactsDirName}`
    : '';
  return { restored: name, quicksaved: true, filesRestored, artifactsDir: artifactsRelDir, displaced, usage };
}

/** Look up a checkpoint by name in the manifest. */
function findCheckpoint(manifest: Manifest, name: string): Checkpoint | null {
  if (name === '~quicksave') return manifest.quicksave ?? null;
  return manifest.checkpoints.find(c => c.name === name) ?? null;
}

/** Build a FileChange from old and new content for a file. */
function buildFileChange(vigilDir: string, relPath: string, cpHash: string, currentBuf: Buffer): FileChange {
  const cpBuf = readObject(vigilDir, cpHash);
  if (isBinary(cpBuf) || isBinary(currentBuf)) {
    return { path: relPath, diff: '', binary: true, linesAdded: 0, linesRemoved: 0 };
  }
  const oldContent = cpBuf.toString('utf8');
  const newContent = currentBuf.toString('utf8');
  const diff = generateUnifiedDiff(oldContent, newContent, relPath);
  const linesAdded = (diff.match(/^\+[^+]/gm) || []).length;
  const linesRemoved = (diff.match(/^-[^-]/gm) || []).length;
  return { path: relPath, diff, binary: false, linesAdded, linesRemoved };
}

/**
 * Diff current project against a checkpoint (or two checkpoints against each other).
 *
 * Modes:
 *   - Full diff:   diffCheckpoint(dir, name) → { added, modified: FileChange[], deleted }
 *   - Summary:     diffCheckpoint(dir, name, { summary: true }) → same but no diffs in FileChange
 *   - Single file: diffCheckpoint(dir, name, { file }) → { file, checkpoint, content, diff }
 *   - Against:     diffCheckpoint(dir, name, { against }) → diff checkpoint vs checkpoint
 *   - Search:      diffCheckpoint(dir, "*", { file, search }) → { search, file, hits }
 */
export function diffCheckpoint(
  projectDir: string,
  name: string,
  opts: { file?: string; summary?: boolean; against?: string; search?: string } = {}
): DiffResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  // Search mode: scan all checkpoints for a string in a specific file
  if (name === '*' && opts.file && opts.search) {
    const hits: SearchHit[] = [];
    const allCheckpoints = [...manifest.checkpoints];
    if (manifest.quicksave) allCheckpoints.push(manifest.quicksave);

    for (const cp of allCheckpoints) {
      const hash = cp.files[opts.file];
      if (!hash) continue;
      const buf = readObject(vigilDir, hash);
      if (isBinary(buf)) continue;
      const content = buf.toString('utf8');
      const lines = content.split('\n');
      const matchingLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(opts.search!)) {
          // Include 2 lines of context around match
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);
          for (let k = start; k <= end; k++) {
            const prefix = k === i ? '>' : ' ';
            const lineRef = `${prefix} ${k + 1}: ${lines[k]}`;
            if (!matchingLines.includes(lineRef)) matchingLines.push(lineRef);
          }
        }
      }
      if (matchingLines.length > 0) {
        hits.push({ checkpoint: cp.name, created: cp.created, lines: matchingLines });
      }
    }
    return { search: opts.search!, file: opts.file, hits };
  }

  const checkpoint = findCheckpoint(manifest, name);
  if (!checkpoint) return { error: 'not_found', name };

  // Single file retrieval mode — returns content + diff vs current
  if (opts.file) {
    const hash = checkpoint.files[opts.file];
    if (!hash) return { error: 'file_not_found', file: opts.file, checkpoint: name };
    const cpBuf = readObject(vigilDir, hash);
    const content = cpBuf.toString('utf8');

    // Also generate diff against current version if it exists
    const currentPath = join(projectDir, opts.file);
    let diff: string | undefined;
    if (existsSync(currentPath)) {
      const currentBuf = readFileSync(currentPath);
      if (!isBinary(cpBuf) && !isBinary(currentBuf)) {
        diff = generateUnifiedDiff(content, currentBuf.toString('utf8'), opts.file);
      }
    }
    return { file: opts.file, checkpoint: name, content, diff };
  }

  // Checkpoint-vs-checkpoint mode
  if (opts.against) {
    const other = findCheckpoint(manifest, opts.against);
    if (!other) return { error: 'not_found', name: opts.against };

    const added: string[] = [];
    const modified: FileChange[] = [];
    const deleted: string[] = [];

    const baseFiles = new Set(Object.keys(checkpoint.files));
    const otherFiles = new Set(Object.keys(other.files));

    // Files in "other" but not in "base" = added
    for (const relPath of otherFiles) {
      if (!baseFiles.has(relPath)) added.push(relPath);
    }

    // Files in both but different hashes = modified
    for (const relPath of baseFiles) {
      if (!otherFiles.has(relPath)) {
        deleted.push(relPath);
      } else if (checkpoint.files[relPath] !== other.files[relPath]) {
        if (opts.summary) {
          modified.push({ path: relPath, diff: '', binary: false, linesAdded: 0, linesRemoved: 0 });
        } else {
          const oldBuf = readObject(vigilDir, checkpoint.files[relPath]);
          const newBuf = readObject(vigilDir, other.files[relPath]);
          if (isBinary(oldBuf) || isBinary(newBuf)) {
            modified.push({ path: relPath, diff: '', binary: true, linesAdded: 0, linesRemoved: 0 });
          } else {
            const diff = generateUnifiedDiff(oldBuf.toString('utf8'), newBuf.toString('utf8'), relPath);
            const linesAdded = (diff.match(/^\+[^+]/gm) || []).length;
            const linesRemoved = (diff.match(/^-[^-]/gm) || []).length;
            modified.push({ path: relPath, diff, binary: false, linesAdded, linesRemoved });
          }
        }
      }
    }

    const usage = diskUsage(vigilDir);
    return { added, modified, deleted, usage };
  }

  // Full diff mode: checkpoint vs current working directory
  const added: string[] = [];
  const modified: FileChange[] = [];
  const deleted: string[] = [];
  const ignorePatterns = parseVigilignore(projectDir);

  const currentFiles = new Set<string>();
  walkProject(projectDir, (relPath, buf) => {
    currentFiles.add(relPath);
    const cpHash = checkpoint!.files[relPath];
    if (!cpHash) {
      added.push(relPath);
    } else if (cpHash !== hashContent(buf)) {
      if (opts.summary) {
        modified.push({ path: relPath, diff: '', binary: false, linesAdded: 0, linesRemoved: 0 });
      } else {
        modified.push(buildFileChange(vigilDir, relPath, cpHash, buf));
      }
    }
  }, ignorePatterns);

  for (const relPath of Object.keys(checkpoint!.files)) {
    if (!currentFiles.has(relPath)) {
      deleted.push(relPath);
    }
  }

  const usage = diskUsage(vigilDir);
  return { added, modified, deleted, usage };
}

/**
 * List files in a checkpoint, optionally filtered by glob pattern.
 * Returns array of { path, size } objects.
 */
export function listCheckpointFiles(projectDir: string, name: string, glob?: string): ListResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  let checkpoint: Checkpoint | null | undefined;
  if (name === '~quicksave') {
    checkpoint = manifest.quicksave;
  } else {
    checkpoint = manifest.checkpoints.find(c => c.name === name);
  }
  if (!checkpoint) return { error: 'not_found', name };

  let files = Object.keys(checkpoint.files);

  // Simple glob filtering: supports "src/auth/**" and "*.ts" patterns
  if (glob) {
    const globPrefix = glob.replace(/\*.*$/, '');
    const globSuffix = glob.includes('*') ? glob.split('*').pop()! : null;
    files = files.filter(f => {
      if (globPrefix && !f.startsWith(globPrefix)) return false;
      if (globSuffix && !f.endsWith(globSuffix)) return false;
      return true;
    });
  }

  return {
    name,
    files: files.sort(),
    totalFiles: Object.keys(checkpoint.files).length
  };
}

/**
 * Delete a checkpoint by name. Runs GC to reclaim unreferenced objects.
 * Returns { deleted, gc }.
 */
export function deleteCheckpoint(projectDir: string, name?: string, opts: { all?: boolean } = {}): DeleteResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  if (opts.all) {
    manifest.checkpoints = [];
    manifest.quicksave = null;
    writeManifest(vigilDir, manifest);
    const gc = gcObjects(vigilDir, manifest);
    const usage = diskUsage(vigilDir);
    return { deleted: 'all', gc, usage };
  }

  const idx = manifest.checkpoints.findIndex(c => c.name === name);
  if (idx === -1) return { error: 'not_found', name: name! };

  manifest.checkpoints.splice(idx, 1);
  writeManifest(vigilDir, manifest);
  const gc = gcObjects(vigilDir, manifest);
  const usage = diskUsage(vigilDir);
  return { deleted: name!, gc, usage };
}
