// Snapshot operations: create, restore, diff, and project walking.
// Captures EVERYTHING in the project — no file size or binary filtering.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync, unlinkSync, rmSync
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { hashContent, storeObject, readObject, gcObjects, diskUsage } from './store.js';
import type {
  Manifest, Checkpoint, CheckpointFiles,
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

// ── Checkpoint operations ─────────────────────────────────────────

/**
 * Create a named checkpoint. Walks project, hashes + stores every file.
 * Returns { name, type, created, fileCount, newObjects }.
 */
export function createCheckpoint(projectDir: string, name: string, type: string = 'manual'): CreateCheckpointResult {
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
    fileCount
  };
  manifest.checkpoints.push(checkpoint);
  writeManifest(vigilDir, manifest);

  const usage = diskUsage(vigilDir);
  return { name, type, created: checkpoint.created, fileCount, newObjects, usage };
}

/**
 * Restore a checkpoint. Quicksaves current state first (emulator pattern).
 * opts.files: array of specific file paths to restore (selective).
 * Returns { restored, quicksaved, filesRestored }.
 */
export function restoreCheckpoint(projectDir: string, name: string, opts: { files?: string[] } = {}): RestoreResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  // Find the checkpoint
  let checkpoint: Checkpoint | null | undefined;
  if (name === '~quicksave') {
    checkpoint = manifest.quicksave;
  } else {
    checkpoint = manifest.checkpoints.find(c => c.name === name);
  }
  if (!checkpoint) return { error: 'not_found', name };

  // Quicksave current state before restoring (emulator pattern)
  createCheckpoint(projectDir, '~quicksave', 'quicksave');

  // Determine which files to restore
  const filesToRestore = opts.files
    ? Object.entries(checkpoint.files).filter(([p]) => opts.files!.includes(p))
    : Object.entries(checkpoint.files);

  let filesRestored = 0;
  for (const [relPath, hash] of filesToRestore) {
    const fullPath = join(projectDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, readObject(vigilDir, hash));
    filesRestored++;
  }

  // If full restore (not selective), remove files that exist now but weren't in checkpoint
  if (!opts.files) {
    const ignorePatterns = parseVigilignore(projectDir);
    const checkpointPaths = new Set(Object.keys(checkpoint.files));
    walkProject(projectDir, (relPath) => {
      if (!checkpointPaths.has(relPath)) {
        try { unlinkSync(join(projectDir, relPath)); } catch { /* skip */ }
      }
    }, ignorePatterns);
  }

  const usage = diskUsage(vigilDir);
  return { restored: name, quicksaved: true, filesRestored, usage };
}

/**
 * Diff current project against a checkpoint.
 * Returns { added, modified, deleted } arrays of file paths.
 * If opts.file is set, returns the file content from the checkpoint instead.
 */
export function diffCheckpoint(projectDir: string, name: string, opts: { file?: string } = {}): DiffResult {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);

  let checkpoint: Checkpoint | null | undefined;
  if (name === '~quicksave') {
    checkpoint = manifest.quicksave;
  } else {
    checkpoint = manifest.checkpoints.find(c => c.name === name);
  }
  if (!checkpoint) return { error: 'not_found', name };

  // Single file retrieval mode
  if (opts.file) {
    const hash = checkpoint.files[opts.file];
    if (!hash) return { error: 'file_not_found', file: opts.file, checkpoint: name };
    return { file: opts.file, checkpoint: name, content: readObject(vigilDir, hash).toString('utf8') };
  }

  // Full diff mode
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const ignorePatterns = parseVigilignore(projectDir);

  // Check current files against checkpoint
  const currentFiles = new Set<string>();
  walkProject(projectDir, (relPath, buf) => {
    currentFiles.add(relPath);
    const cpHash = checkpoint!.files[relPath];
    if (!cpHash) {
      added.push(relPath);
    } else if (cpHash !== hashContent(buf)) {
      modified.push(relPath);
    }
  }, ignorePatterns);

  // Check checkpoint files not in current project
  for (const relPath of Object.keys(checkpoint.files)) {
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
    const globPrefix = glob.replace(/\*\*.*$/, '');
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
