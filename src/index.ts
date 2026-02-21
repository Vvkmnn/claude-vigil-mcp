#!/usr/bin/env node
/**
 * MCP server entry point for claude-vigil-mcp.
 *
 * Exposes 5 tools over JSON-RPC via stdio:
 *   - `vigil_save` — Create a named checkpoint of the entire project.
 *   - `vigil_list` — List all checkpoints and disk usage, or drill into files.
 *   - `vigil_diff` — Compare checkpoint vs working directory, two checkpoints, or search.
 *   - `vigil_restore` — Restore project to a checkpoint state (with artifact preservation).
 *   - `vigil_delete` — Delete a checkpoint and reclaim disk space via GC.
 */

import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
import { z } from 'zod';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readManifest,
  writeManifest,
  createCheckpoint,
  restoreCheckpoint,
  diffCheckpoint,
  listCheckpointFiles,
  deleteCheckpoint,
  detectDerivedDirs,
  writeVigilignore,
  hasVigilignore,
} from './snapshot.js';
import { diskUsage } from './store.js';

// ── Formatting helpers ────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${parseFloat((bytes / 1024).toFixed(1))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${parseFloat((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${parseFloat((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`;
}

/** Get artifact directory info: count of restore-artifact dirs and total size */
function getArtifactInfo(vigilDir: string): { count: number; totalBytes: number; dirs: string[] } {
  const artifactsBase = join(vigilDir, 'artifacts');
  if (!existsSync(artifactsBase)) return { count: 0, totalBytes: 0, dirs: [] };
  const entries = readdirSync(artifactsBase, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  let totalBytes = 0;
  // Shallow size estimate: sum file sizes in each artifact dir (1 level deep)
  for (const entry of entries) {
    const dirPath = join(artifactsBase, entry.name);
    try {
      for (const file of readdirSync(dirPath, { recursive: true })) {
        try {
          const s = statSync(join(dirPath, String(file)));
          if (s.isFile()) totalBytes += s.size;
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }
  return { count: entries.length, totalBytes, dirs: entries.map((e) => e.name) };
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusLine(projectDir: string): string {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);
  const usage = diskUsage(vigilDir);
  const max = manifest.config?.maxCheckpoints ?? 3;
  const count = manifest.checkpoints.length;
  const qs = manifest.quicksave ? timeAgo(manifest.quicksave.created) : 'none';
  return `vigil: ${count}/${max} | quicksave: ${qs} | ${formatBytes(usage.totalBytes)}`;
}

// Single-line: 🏺 ━━ action ━━ details ━━ status
// Multi-line:  🏺 ┏━ header ━━ status / ┃ line / ┗ last line
function fmt(header: string, body: string[] | null | undefined, projectDir?: string): string {
  const status = projectDir ? statusLine(projectDir) : '';
  if (!body || body.length === 0) {
    return status
      ? `\u{1F3FA} \u2501\u2501 ${header} \u2501\u2501 ${status}`
      : `\u{1F3FA} \u2501\u2501 ${header}`;
  }
  const lines = body.filter(Boolean);
  const top = status
    ? `\u{1F3FA} \u250F\u2501 ${header} \u2501\u2501 ${status}`
    : `\u{1F3FA} \u250F\u2501 ${header}`;
  if (lines.length === 0) return top;
  const mid = lines.slice(0, -1).map((l) => `   \u2503 ${l}`);
  const bot = `   \u2517 ${lines[lines.length - 1] ?? ''}`;
  return [top, ...mid, bot].join('\n');
}

// ── Project directory resolution ──────────────────────────────────

function getProjectDir(): string {
  // MCP servers receive cwd from the client, or use env var
  return process.env.VIGIL_PROJECT_DIR || process.cwd();
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'claude-vigil-mcp', version },
  {
    instructions:
      'Claude Vigil creates project checkpoints for safe rollback. Use vigil_save before risky changes, vigil_list to see checkpoints and artifact status, vigil_diff to compare states or search history, vigil_restore to roll back (displaced files are preserved in .claude/vigil/artifacts/ — vigil never deletes artifacts, ask the user before cleaning them up), vigil_delete to reclaim checkpoint space.',
  },
);

// ── vigil_save ────────────────────────────────────────────────────

server.tool(
  'vigil_save',
  'Create a named checkpoint of the entire project. Runs in background — returns immediately. If slots are full, DO NOT auto-retry — ask the user whether to delete an existing checkpoint or increase capacity.',
  {
    name: z.string().describe('Checkpoint name (e.g., "before-refactor", "v1.0")'),
    description: z
      .string()
      .optional()
      .describe('What this checkpoint captures (shown in vigil_list)'),
    max_checkpoints: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Increase the maximum number of checkpoint slots (default: 3)'),
  },
  async ({ name, description, max_checkpoints }) => {
    const projectDir = getProjectDir();
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);

    // Update capacity if requested
    if (max_checkpoints !== undefined) {
      manifest.config = manifest.config ?? {};
      manifest.config.maxCheckpoints = max_checkpoints;
      writeManifest(vigilDir, manifest);
    }

    const max = manifest.config?.maxCheckpoints ?? 3;

    // Check slot limit
    if (manifest.checkpoints.length >= max) {
      const names = manifest.checkpoints
        .map((c) => `${c.name} (${timeAgo(c.created)})`)
        .join(' \u00B7 ');
      return {
        content: [
          {
            type: 'text' as const,
            text: fmt(
              `${max}/${max} full — ask the user before proceeding`,
              [
                names,
                `ASK the user: delete one with vigil_delete, or increase capacity with max_checkpoints?`,
              ],
              projectDir,
            ),
          },
        ],
      };
    }

    // First save: auto-detect derived dirs from .gitignore + known patterns, create .vigilignore
    let firstSaveSkips: string[] | null = null;
    if (!hasVigilignore(vigilDir)) {
      const derived = detectDerivedDirs(projectDir);
      writeVigilignore(vigilDir, derived, projectDir);
      if (derived.length > 0) {
        firstSaveSkips = derived;
      }
    }

    // Check duplicate name
    if (manifest.checkpoints.some((c) => c.name === name)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: fmt(
              `"${name}" already exists \u2501\u2501 choose a different name or delete it first`,
              null,
              projectDir,
            ),
          },
        ],
      };
    }

    // Synchronous snapshot — confirmed before returning
    const result = createCheckpoint(projectDir, name, 'manual', description);
    if ('error' in result) {
      return {
        content: [{ type: 'text' as const, text: fmt(`error: ${result.error}`, null, projectDir) }],
      };
    }
    const saveHeader = `saved "${name}" \u2501\u2501 ${'fileCount' in result ? result.fileCount : 0} files \u00B7 ${'usage' in result ? formatBytes(result.usage.totalBytes) : ''}`;

    // Always show what derived dirs were skipped so the user can review
    const skippedDirs = detectDerivedDirs(projectDir);
    const saveLines: string[] = [];
    if (skippedDirs.length > 0) {
      saveLines.push(`skipped: ${skippedDirs.join(', ')}`);
    }
    if (firstSaveSkips) {
      saveLines.push('first save — confirm these exclusions look correct');
      saveLines.push('edit .claude/vigil/.vigilignore to adjust');
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: fmt(saveHeader, saveLines.length > 0 ? saveLines : null, projectDir),
        },
      ],
    };
  },
);

// ── vigil_list ────────────────────────────────────────────────────

server.tool(
  'vigil_list',
  'List all checkpoints and disk usage. With name: list files inside that checkpoint.',
  {
    name: z.string().optional().describe('Checkpoint name to drill into (omit for overview)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g., "src/auth/**")'),
  },
  async ({ name, glob }) => {
    const projectDir = getProjectDir();

    // Drill into a specific checkpoint
    if (name) {
      const result = listCheckpointFiles(projectDir, name, glob);
      if ('error' in result) {
        return {
          content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }],
        };
      }
      const lines = result.files.slice(0, 50);
      if (result.files.length > 50) lines.push(`... and ${result.files.length - 50} more`);
      const header = glob
        ? `${name} \u2501\u2501 ${result.files.length} of ${result.totalFiles} files matching ${glob}`
        : `${name} \u2501\u2501 ${result.totalFiles} files`;
      return { content: [{ type: 'text' as const, text: fmt(header, lines, projectDir) }] };
    }

    // Overview of all checkpoints
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);

    // Check for in-progress hook snapshot
    const inProgress = existsSync(join(vigilDir, '.in-progress'));

    if (manifest.checkpoints.length === 0 && !manifest.quicksave && !inProgress) {
      return {
        content: [
          {
            type: 'text' as const,
            text: fmt(
              'no checkpoints yet \u2501\u2501 use vigil_save to create one',
              null,
              projectDir,
            ),
          },
        ],
      };
    }

    const lines: string[] = manifest.checkpoints.map((c) => {
      const age = timeAgo(c.created);
      const base = `${c.name}${' '.repeat(Math.max(1, 20 - c.name.length))}${age}${' '.repeat(Math.max(1, 10 - age.length))}${c.fileCount} files`;
      return c.description ? `${base}\n${' '.repeat(3)}\u2503 ${c.description}` : base;
    });
    if (manifest.quicksave) {
      lines.push(`~quicksave${' '.repeat(9)}${timeAgo(manifest.quicksave.created)}`);
    }
    if (inProgress) {
      lines.push('(snapshotting in progress...)');
    }

    // Show artifact directories from previous restores
    const artifactInfo = getArtifactInfo(vigilDir);
    if (artifactInfo.count > 0) {
      lines.push('');
      lines.push(
        `artifacts: ${artifactInfo.count} restore${artifactInfo.count !== 1 ? 's' : ''} preserved (${formatBytes(artifactInfo.totalBytes)})`,
      );
      lines.push('  displaced files from vigil_restore — review and delete when no longer needed');
      lines.push(`  location: .claude/vigil/artifacts/`);
    }

    const count = manifest.checkpoints.length;
    const header = `${count} checkpoint${count !== 1 ? 's' : ''}`;
    return {
      content: [
        { type: 'text' as const, text: fmt(header, lines.length ? lines : null, projectDir) },
      ],
    };
  },
);

// ── vigil_diff ────────────────────────────────────────────────────

server.tool(
  'vigil_diff',
  "Search and investigate previous versions of your codebase. Compare checkpoint vs current working directory (with full unified diffs), compare two checkpoints against each other, retrieve any file's content from any checkpoint, or search for a string across all checkpoints to find when code existed. Use this to find previous versions of files or functions, understand what changed, and pull out whatever snippets or diffs are needed — then apply selectively with Edit.",
  {
    name: z
      .string()
      .describe(
        'Checkpoint name to diff against (use "*" with file+search to scan all checkpoints)',
      ),
    file: z
      .string()
      .optional()
      .describe('Specific file to retrieve from checkpoint (returns content + diff vs current)'),
    summary: z
      .boolean()
      .optional()
      .describe('Return file list only without content diffs (faster for large changesets)'),
    against: z
      .string()
      .optional()
      .describe('Compare against another checkpoint instead of current working directory'),
    search: z
      .string()
      .optional()
      .describe('Search for this string across all checkpoints (requires name="*" and file)'),
  },
  async ({ name, file, summary, against, search }) => {
    const projectDir = getProjectDir();
    const result = diffCheckpoint(projectDir, name, { file, summary, against, search });

    if ('error' in result) {
      if (result.error === 'not_found') {
        return {
          content: [
            { type: 'text' as const, text: fmt(`"${result.name}" not found`, null, projectDir) },
          ],
        };
      }
      if (result.error === 'file_not_found') {
        return {
          content: [
            { type: 'text' as const, text: fmt(`"${file}" not in "${name}"`, null, projectDir) },
          ],
        };
      }
    }

    // Search results
    if ('search' in result) {
      if (result.hits.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: fmt(
                `"${result.search}" not found in ${result.file} across any checkpoint`,
                null,
                projectDir,
              ),
            },
          ],
        };
      }
      const lines: string[] = [];
      for (const hit of result.hits) {
        lines.push(`${hit.checkpoint} (${timeAgo(hit.created)})`);
        for (const line of hit.lines) lines.push(`  ${line}`);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: fmt(
              `"${result.search}" in ${result.file} \u2501\u2501 ${result.hits.length} checkpoint${result.hits.length !== 1 ? 's' : ''}`,
              lines,
              projectDir,
            ),
          },
        ],
      };
    }

    // Single file retrieval — content + diff vs current
    if ('content' in result) {
      let text = `\u{1F3FA} \u2501\u2501 ${file} from ${name} \u2501\u2501\n${result.content}`;
      if (result.diff) {
        text += `\n\n\u2501\u2501 diff vs current \u2501\u2501\n${result.diff}`;
      }
      return { content: [{ type: 'text' as const, text }] };
    }

    // Full diff (checkpoint vs current or checkpoint vs checkpoint)
    if ('added' in result) {
      const total = result.modified.length + result.added.length + result.deleted.length;
      if (total === 0) {
        const target = against ? `"${name}" vs "${against}"` : `"${name}"`;
        return {
          content: [
            { type: 'text' as const, text: fmt(`no changes vs ${target}`, null, projectDir) },
          ],
        };
      }

      const lines: string[] = [];
      for (const f of result.modified) {
        const stats = f.binary ? '(binary)' : `(+${f.linesAdded} -${f.linesRemoved})`;
        lines.push(`modified  ${f.path} ${stats}`);
      }
      for (const f of result.added) lines.push(`added     ${f}`);
      for (const f of result.deleted) lines.push(`deleted   ${f}`);

      const target = against ? `${name} vs ${against}` : name;
      let text = fmt(`${total} change${total !== 1 ? 's' : ''} vs ${target}`, lines, projectDir);

      // Append per-file diffs (unless summary mode)
      if (!summary) {
        for (const f of result.modified) {
          if (f.diff) {
            text += `\n\n\u2501\u2501 ${f.path} \u2501\u2501\n${f.diff}`;
          }
        }
      }

      return { content: [{ type: 'text' as const, text }] };
    }

    return {
      content: [{ type: 'text' as const, text: fmt('unexpected result', null, projectDir) }],
    };
  },
);

// ── vigil_restore ─────────────────────────────────────────────────

server.tool(
  'vigil_restore',
  'Restore project to a checkpoint state. Quicksaves current state first. Displaced files (modified + new) are preserved in .claude/vigil/artifacts/ — nothing is ever deleted. For individual file/function restores, use vigil_diff to get the content and apply with Edit.',
  {
    name: z.string().describe('Checkpoint name to restore'),
  },
  async ({ name }) => {
    const projectDir = getProjectDir();
    const result = restoreCheckpoint(projectDir, name);

    if ('error' in result) {
      return {
        content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }],
      };
    }

    // Report what happened + safety info
    const skipped = detectDerivedDirs(projectDir);
    const lines: string[] = [];

    // Displaced files info
    if (result.displaced.length > 0) {
      lines.push(
        `preserved ${result.displaced.length} displaced file${result.displaced.length !== 1 ? 's' : ''} in ${result.artifactsDir}`,
      );
      const modified = result.displaced.filter((d) => d.reason === 'modified');
      const newFiles = result.displaced.filter((d) => d.reason === 'new');
      if (modified.length > 0) {
        for (const d of modified.slice(0, 10))
          lines.push(`  modified: ${d.path} (current version saved)`);
        if (modified.length > 10)
          lines.push(`  ... and ${modified.length - 10} more modified files`);
      }
      if (newFiles.length > 0) {
        for (const d of newFiles.slice(0, 10))
          lines.push(`  new: ${d.path} (moved, not in checkpoint)`);
        if (newFiles.length > 10) lines.push(`  ... and ${newFiles.length - 10} more new files`);
      }
      lines.push(`review ${result.artifactsDir} — delete when no longer needed`);
    } else {
      lines.push('no displaced files (working directory matched checkpoint)');
    }

    lines.push('previous state also quicksaved (use ~quicksave to undo)');

    if (skipped.length > 0) {
      lines.push(`not restored (derived): ${skipped.join(', ')}`);
      lines.push('rebuild these before running the project');
    }
    lines.push(
      'for individual file/function restores, use vigil_diff to search previous versions and apply with Edit',
    );

    // Remind about artifact cleanup when they accumulate
    const artifactsBase = join(projectDir, '.claude', 'vigil', 'artifacts');
    if (existsSync(artifactsBase)) {
      const artifactDirs = readdirSync(artifactsBase, { withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      );
      if (artifactDirs.length >= 3) {
        lines.push(
          `note: ${artifactDirs.length} artifact directories in .claude/vigil/artifacts/ — review and clean up old ones if no longer needed`,
        );
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: fmt(
            `restored from "${name}" \u2501\u2501 ${result.filesRestored} files`,
            lines,
            projectDir,
          ),
        },
      ],
    };
  },
);

// ── vigil_delete ──────────────────────────────────────────────────

server.tool(
  'vigil_delete',
  'Delete a checkpoint and reclaim disk space. Use all=true to delete all checkpoints. Note: artifact directories from previous restores are NOT deleted — ask the user if they want you to clean those up separately.',
  {
    name: z.string().optional().describe('Checkpoint name to delete'),
    all: z.boolean().optional().describe('Delete all checkpoints and reclaim all space'),
  },
  async ({ name, all }) => {
    const projectDir = getProjectDir();

    if (!name && !all) {
      return {
        content: [
          {
            type: 'text' as const,
            text: fmt('specify a checkpoint name or all=true', null, projectDir),
          },
        ],
      };
    }

    const result = deleteCheckpoint(projectDir, name, { all });

    if ('error' in result) {
      return {
        content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }],
      };
    }

    // Check for artifact directories that should be reviewed
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const artifactInfo = getArtifactInfo(vigilDir);
    const deleteLines: string[] = [];
    if (artifactInfo.count > 0) {
      deleteLines.push(
        `${artifactInfo.count} artifact director${artifactInfo.count !== 1 ? 'ies' : 'y'} from previous restores (${formatBytes(artifactInfo.totalBytes)}) still in .claude/vigil/artifacts/`,
      );
      deleteLines.push(
        'vigil never deletes artifacts — ask the user if they want you to remove them',
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: fmt(
            `deleted ${result.deleted} \u2501\u2501 reclaimed ${formatBytes(result.gc.bytesFreed)} (${result.gc.removed} objects)`,
            deleteLines.length > 0 ? deleteLines : null,
            projectDir,
          ),
        },
      ],
    };
  },
);

// ── Start server ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
