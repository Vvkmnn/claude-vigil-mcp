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

export type RestoreResult =
  | { error: 'not_found'; name: string }
  | { restored: string; quicksaved: boolean; filesRestored: number; usage: DiskUsage };

export type DiffResult =
  | { error: 'not_found'; name: string }
  | { error: 'file_not_found'; file: string; checkpoint: string }
  | { file: string; checkpoint: string; content: string }
  | { added: string[]; modified: string[]; deleted: string[]; usage: DiskUsage };

export type ListResult =
  | { error: string; name?: string }
  | { name: string; files: string[]; totalFiles: number };

export type DeleteResult =
  | { error: 'not_found'; name: string }
  | { deleted: string; gc: GCResult; usage: DiskUsage };

// ── Callbacks ─────────────────────────────────────────────────────

export type WalkCallback = (relativePath: string, content: Buffer) => void;
