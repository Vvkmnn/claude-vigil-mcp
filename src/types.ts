// Shared type definitions for claude-vigil-mcp.

// ── Manifest ──────────────────────────────────────────────────────

export interface CheckpointFiles {
  [relativePath: string]: string; // path → SHA-256 hex hash
}

export interface Checkpoint {
  name: string;
  type?: string;
  created: string; // ISO 8601
  files: CheckpointFiles;
  fileCount: number;
  description?: string;
}

export interface ManifestConfig {
  maxCheckpoints?: number;
}

export interface Manifest {
  checkpoints: Checkpoint[];
  quicksave: Checkpoint | null;
  config: ManifestConfig;
}

// ── Store results ─────────────────────────────────────────────────

export interface GCResult {
  removed: number;
  bytesFreed: number;
}

export interface DiskUsage {
  totalBytes: number;
  objectCount: number;
}

// ── Snapshot results (discriminated unions) ────────────────────────

export type CreateCheckpointResult =
  | { name: string; type: string; created: string; fileCount: number; newObjects: number; usage: DiskUsage }
  | { name: string; type: string; created: string; fileCount: number }
  | { error: 'slots_full'; max: number; checkpoints: { name: string; created: string }[] }
  | { error: 'duplicate_name'; name: string };

// Per-file info about what was displaced during restore
export interface DisplacedFile {
  path: string;
  reason: 'modified' | 'new'; // 'modified' = overwritten from checkpoint, 'new' = not in checkpoint
}

export type RestoreResult =
  | { error: 'not_found'; name: string }
  | {
      restored: string;
      quicksaved: boolean;
      filesRestored: number;
      artifactsDir: string;       // relative path to artifacts directory
      displaced: DisplacedFile[]; // files preserved in artifacts
      usage: DiskUsage;
    };

// Per-file change info returned in full diff mode
export interface FileChange {
  path: string;
  diff: string;        // unified diff (empty for binary files)
  binary: boolean;     // true if binary file (no diff available)
  linesAdded: number;
  linesRemoved: number;
}

// Search result when scanning across all checkpoints
export interface SearchHit {
  checkpoint: string;
  created: string;
  lines: string[];     // matching lines with surrounding context
}

export type DiffResult =
  | { error: 'not_found'; name: string }
  | { error: 'file_not_found'; file: string; checkpoint: string }
  | { file: string; checkpoint: string; content: string; diff?: string }
  | { added: string[]; modified: FileChange[]; deleted: string[]; usage: DiskUsage }
  | { search: string; file: string; hits: SearchHit[] };

export type ListResult =
  | { error: string; name?: string }
  | { name: string; files: string[]; totalFiles: number };

export type DeleteResult =
  | { error: 'not_found'; name: string }
  | { deleted: string; gc: GCResult; usage: DiskUsage };

// ── Callbacks ─────────────────────────────────────────────────────

export type WalkCallback = (relativePath: string, content: Buffer) => void;
