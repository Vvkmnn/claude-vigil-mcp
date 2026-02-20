/**
 * Type definitions for claude-vigil-mcp.
 *
 * All result types use discriminated unions with an `error` field for failures,
 * allowing callers to narrow with `'error' in result` checks.
 */

// ── Manifest ──────────────────────────────────────────────────────

/** Map of relative file paths to their SHA-256 content hashes. */
export interface CheckpointFiles {
  [relativePath: string]: string;
}

/** A single checkpoint: a named snapshot of every file in the project. */
export interface Checkpoint {
  name: string;
  type?: string;
  created: string; // ISO 8601
  files: CheckpointFiles;
  fileCount: number;
  description?: string;
}

/** User-configurable settings stored in the manifest. */
export interface ManifestConfig {
  maxCheckpoints?: number;
}

/** Top-level manifest: the list of checkpoints, the quicksave slot, and config. */
export interface Manifest {
  checkpoints: Checkpoint[];
  quicksave: Checkpoint | null;
  config: ManifestConfig;
}

// ── Store results ─────────────────────────────────────────────────

/** Result of garbage collection: how many objects were removed and bytes freed. */
export interface GCResult {
  removed: number;
  bytesFreed: number;
}

/** Disk usage summary for the CAS objects directory. */
export interface DiskUsage {
  totalBytes: number;
  objectCount: number;
}

// ── Snapshot results (discriminated unions) ────────────────────────

/** Result of creating a checkpoint. Success variants differ for manual vs quicksave. */
export type CreateCheckpointResult =
  | { name: string; type: string; created: string; fileCount: number; newObjects: number; usage: DiskUsage }
  | { name: string; type: string; created: string; fileCount: number }
  | { error: 'slots_full'; max: number; checkpoints: { name: string; created: string }[] }
  | { error: 'duplicate_name'; name: string };

/** A file that was displaced (moved to artifacts/) during restore. */
export interface DisplacedFile {
  /** Relative path within the project. */
  path: string;
  /** Why it was displaced: 'modified' = overwritten from checkpoint, 'new' = not in checkpoint. */
  reason: 'modified' | 'new';
}

/** Result of restoring a checkpoint. Includes displaced file info and quicksave confirmation. */
export type RestoreResult =
  | { error: 'not_found'; name: string }
  | {
      restored: string;
      quicksaved: boolean;
      filesRestored: number;
      artifactsDir: string;
      displaced: DisplacedFile[];
      usage: DiskUsage;
    };

/** Per-file change information returned in full diff mode. */
export interface FileChange {
  path: string;
  /** Unified diff string (empty for binary files or summary mode). */
  diff: string;
  /** True if the file is binary (no textual diff available). */
  binary: boolean;
  linesAdded: number;
  linesRemoved: number;
}

/** A search hit when scanning for a string across all checkpoints. */
export interface SearchHit {
  checkpoint: string;
  created: string;
  /** Matching lines with 2 lines of surrounding context. */
  lines: string[];
}

/**
 * Discriminated union for all diff operations.
 *
 * Variants:
 *   - Error: `{ error: 'not_found' | 'file_not_found', ... }`
 *   - Single file retrieval: `{ file, checkpoint, content, diff? }`
 *   - Full diff (vs working dir or another checkpoint): `{ added, modified, deleted, usage }`
 *   - Cross-checkpoint search: `{ search, file, hits }`
 */
export type DiffResult =
  | { error: 'not_found'; name: string }
  | { error: 'file_not_found'; file: string; checkpoint: string }
  | { file: string; checkpoint: string; content: string; diff?: string }
  | { added: string[]; modified: FileChange[]; deleted: string[]; usage: DiskUsage }
  | { search: string; file: string; hits: SearchHit[] };

/** Result of listing files in a checkpoint. */
export type ListResult = { error: string; name?: string } | { name: string; files: string[]; totalFiles: number };

/** Result of deleting a checkpoint. Includes GC stats for reclaimed space. */
export type DeleteResult = { error: 'not_found'; name: string } | { deleted: string; gc: GCResult; usage: DiskUsage };

// ── Callbacks ─────────────────────────────────────────────────────

/** Callback invoked for each file during project walking. */
export type WalkCallback = (relativePath: string, content: Buffer) => void;
