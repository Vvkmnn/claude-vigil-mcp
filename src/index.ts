#!/usr/bin/env node
// claude-vigil-mcp: Checkpoint, snapshot, and file recovery MCP server.
// 5 tools: vigil_save, vigil_list, vigil_diff, vigil_restore, vigil_delete.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readManifest, createCheckpoint, restoreCheckpoint,
  diffCheckpoint, listCheckpointFiles, deleteCheckpoint
} from './snapshot.js';
import { diskUsage } from './store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Formatting helpers ────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
    return status ? `\u{1F3FA} \u2501\u2501 ${header} \u2501\u2501 ${status}` : `\u{1F3FA} \u2501\u2501 ${header}`;
  }
  const lines = body.filter(Boolean);
  const top = status
    ? `\u{1F3FA} \u250F\u2501 ${header} \u2501\u2501 ${status}`
    : `\u{1F3FA} \u250F\u2501 ${header}`;
  const mid = lines.slice(0, -1).map(l => `   \u2503 ${l}`);
  const bot = `   \u2517 ${lines[lines.length - 1]}`;
  return [top, ...mid, bot].join('\n');
}

// ── Project directory resolution ──────────────────────────────────

function getProjectDir(): string {
  // MCP servers receive cwd from the client, or use env var
  return process.env.VIGIL_PROJECT_DIR || process.cwd();
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({ name: 'claude-vigil-mcp', version: '0.1.0' });

// ── vigil_save ────────────────────────────────────────────────────

server.tool(
  'vigil_save',
  'Create a named checkpoint of the entire project. Runs in background — returns immediately.',
  { name: z.string().describe('Checkpoint name (e.g., "before-refactor", "v1.0")') },
  async ({ name }) => {
    const projectDir = getProjectDir();
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    const max = manifest.config?.maxCheckpoints ?? 3;

    // Check slot limit
    if (manifest.checkpoints.length >= max) {
      const names = manifest.checkpoints.map(c => `${c.name} (${timeAgo(c.created)})`).join(' \u00B7 ');
      return { content: [{ type: 'text' as const, text:
        fmt(`${max}/${max} full \u2501\u2501 delete one first`, [names], projectDir)
      }] };
    }

    // Check duplicate name
    if (manifest.checkpoints.some(c => c.name === name)) {
      return { content: [{ type: 'text' as const, text:
        fmt(`"${name}" already exists \u2501\u2501 choose a different name or delete it first`, null, projectDir)
      }] };
    }

    // Synchronous snapshot — confirmed before returning
    const result = createCheckpoint(projectDir, name, 'manual');
    if ('error' in result) {
      return { content: [{ type: 'text' as const, text:
        fmt(`error: ${result.error}`, null, projectDir)
      }] };
    }
    return { content: [{ type: 'text' as const, text:
      fmt(`saved "${name}" \u2501\u2501 ${'fileCount' in result ? result.fileCount : 0} files \u00B7 ${'usage' in result ? formatBytes(result.usage.totalBytes) : ''}`, null, projectDir)
    }] };
  }
);

// ── vigil_list ────────────────────────────────────────────────────

server.tool(
  'vigil_list',
  'List all checkpoints and disk usage. With name: list files inside that checkpoint.',
  {
    name: z.string().optional().describe('Checkpoint name to drill into (omit for overview)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g., "src/auth/**")')
  },
  async ({ name, glob }) => {
    const projectDir = getProjectDir();

    // Drill into a specific checkpoint
    if (name) {
      const result = listCheckpointFiles(projectDir, name, glob);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }] };
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
      return { content: [{ type: 'text' as const, text:
        fmt('no checkpoints yet \u2501\u2501 use vigil_save to create one', null, projectDir)
      }] };
    }

    const lines: string[] = manifest.checkpoints.map(c => {
      const age = timeAgo(c.created);
      return `${c.name}${' '.repeat(Math.max(1, 20 - c.name.length))}${age}${' '.repeat(Math.max(1, 10 - age.length))}${c.fileCount} files`;
    });
    if (manifest.quicksave) {
      lines.push(`~quicksave${' '.repeat(9)}${timeAgo(manifest.quicksave.created)}`);
    }
    if (inProgress) {
      lines.push('(snapshotting in progress...)');
    }

    const count = manifest.checkpoints.length;
    const header = `${count} checkpoint${count !== 1 ? 's' : ''}`;
    return { content: [{ type: 'text' as const, text: fmt(header, lines.length ? lines : null, projectDir) }] };
  }
);

// ── vigil_diff ────────────────────────────────────────────────────

server.tool(
  'vigil_diff',
  'Compare current project to a checkpoint. With file: retrieve that file\'s content from the checkpoint.',
  {
    name: z.string().describe('Checkpoint name to diff against'),
    file: z.string().optional().describe('Specific file to retrieve from checkpoint (returns content)')
  },
  async ({ name, file }) => {
    const projectDir = getProjectDir();
    const result = diffCheckpoint(projectDir, name, { file });

    if ('error' in result) {
      if (result.error === 'not_found') {
        return { content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }] };
      }
      if (result.error === 'file_not_found') {
        return { content: [{ type: 'text' as const, text: fmt(`"${file}" not in "${name}"`, null, projectDir) }] };
      }
    }

    // Single file retrieval — header + raw content
    if ('content' in result) {
      return { content: [{ type: 'text' as const, text:
        `\u{1F3FA} \u2501\u2501 ${file} from ${name} \u2501\u2501\n${result.content}`
      }] };
    }

    // Full diff
    if ('added' in result) {
      const lines: string[] = [];
      for (const f of result.modified) lines.push(`modified  ${f}`);
      for (const f of result.added) lines.push(`added     ${f}`);
      for (const f of result.deleted) lines.push(`deleted   ${f}`);
      const total = result.modified.length + result.added.length + result.deleted.length;

      if (total === 0) {
        return { content: [{ type: 'text' as const, text:
          fmt(`no changes vs "${name}"`, null, projectDir)
        }] };
      }

      return { content: [{ type: 'text' as const, text:
        fmt(`${total} change${total !== 1 ? 's' : ''} vs ${name}`, lines, projectDir)
      }] };
    }

    // Fallback (shouldn't reach here)
    return { content: [{ type: 'text' as const, text: fmt('unexpected result', null, projectDir) }] };
  }
);

// ── vigil_restore ─────────────────────────────────────────────────

server.tool(
  'vigil_restore',
  'Restore project to a checkpoint state. Quicksaves current state first. Optionally restore specific files only.',
  {
    name: z.string().describe('Checkpoint name to restore'),
    files: z.array(z.string()).optional().describe('Specific files to restore (omit for full restore)')
  },
  async ({ name, files }) => {
    const projectDir = getProjectDir();
    const result = restoreCheckpoint(projectDir, name, { files });

    if ('error' in result) {
      return { content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }] };
    }

    const detail = files
      ? `${result.filesRestored} file${result.filesRestored !== 1 ? 's' : ''}`
      : `${result.filesRestored} files (full)`;
    return { content: [{ type: 'text' as const, text:
      fmt(`restored from "${name}" \u2501\u2501 ${detail} \u00B7 quicksaved first`, null, projectDir)
    }] };
  }
);

// ── vigil_delete ──────────────────────────────────────────────────

server.tool(
  'vigil_delete',
  'Delete a checkpoint and reclaim disk space. Use all=true to delete everything.',
  {
    name: z.string().optional().describe('Checkpoint name to delete'),
    all: z.boolean().optional().describe('Delete all checkpoints and reclaim all space')
  },
  async ({ name, all }) => {
    const projectDir = getProjectDir();

    if (!name && !all) {
      return { content: [{ type: 'text' as const, text:
        fmt('specify a checkpoint name or all=true', null, projectDir)
      }] };
    }

    const result = deleteCheckpoint(projectDir, name, { all });

    if ('error' in result) {
      return { content: [{ type: 'text' as const, text: fmt(`"${name}" not found`, null, projectDir) }] };
    }

    return { content: [{ type: 'text' as const, text:
      fmt(`deleted ${result.deleted} \u2501\u2501 reclaimed ${formatBytes(result.gc.bytesFreed)} (${result.gc.removed} objects)`, null, projectDir)
    }] };
  }
);

// ── Start server ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
