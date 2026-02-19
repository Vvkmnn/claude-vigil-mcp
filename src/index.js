#!/usr/bin/env node
// claude-vigil-mcp: Checkpoint, snapshot, and file recovery MCP server.
// 5 tools: vigil_save, vigil_list, vigil_diff, vigil_restore, vigil_delete.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusLine(projectDir) {
  const vigilDir = join(projectDir, '.claude', 'vigil');
  const manifest = readManifest(vigilDir);
  const usage = diskUsage(vigilDir);
  const max = manifest.config?.maxCheckpoints ?? 3;
  const count = manifest.checkpoints.length;
  const qs = manifest.quicksave ? timeAgo(manifest.quicksave.created) : 'none';
  return `vigil: ${count}/${max} | quicksave: ${qs} | ${formatBytes(usage.totalBytes)}`;
}

function box(title, lines, projectDir) {
  const footer = statusLine(projectDir);
  const content = lines.filter(Boolean);
  const allLines = ['', ...content, '', footer];
  const maxLen = Math.max(title.length + 10, ...allLines.map(l => l.length + 4));
  const pad = (s) => '┃  ' + s + ' '.repeat(Math.max(0, maxLen - s.length - 4)) + '┃';
  const top = '┏━ \u{1F985} ' + '━'.repeat(Math.max(0, maxLen - title.length - 8)) + ' ' + title + ' ━┓';
  const bot = '┗' + '━'.repeat(maxLen) + '┛';
  return [top, ...allLines.map(pad), bot].join('\n');
}

// ── Project directory resolution ──────────────────────────────────

function getProjectDir() {
  // MCP servers receive cwd from the client, or use env var
  return process.env.VIGIL_PROJECT_DIR || process.cwd();
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new Server(
  { name: 'claude-vigil-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

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

    // Check slot limit before spawning worker
    if (manifest.checkpoints.length >= max) {
      const cpList = manifest.checkpoints.map(c =>
        `  ${c.name}  (${timeAgo(c.created)})`
      ).join('\n');
      return { content: [{ type: 'text', text: box('slots full', [
        `${max}/${max} checkpoint slots used:`,
        ...manifest.checkpoints.map(c => `  ${c.name}  ${timeAgo(c.created)}`),
        '',
        'Delete one first with vigil_delete.'
      ], projectDir) }] };
    }

    // Check duplicate name
    if (manifest.checkpoints.some(c => c.name === name)) {
      return { content: [{ type: 'text', text: box('exists', [
        `Checkpoint '${name}' already exists.`,
        'Choose a different name or delete it first.'
      ], projectDir) }] };
    }

    // Spawn background worker
    const child = spawn(process.execPath, [
      join(__dirname, 'worker.js'), projectDir, name, 'manual'
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    return { content: [{ type: 'text', text: box('saved', [
      `${name}${' '.repeat(Math.max(1, 24 - name.length))}started (background)`,
    ], projectDir) }] };
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
      if (result.error) {
        return { content: [{ type: 'text', text: `Checkpoint '${name}' not found.` }] };
      }
      const lines = result.files.map(f => `  ${f}`);
      if (lines.length > 50) lines.splice(50, lines.length - 50, `  ... and ${result.files.length - 50} more`);
      lines.push('', `${result.files.length} of ${result.totalFiles} files`);
      return { content: [{ type: 'text', text: box(name, lines, projectDir) }] };
    }

    // Overview of all checkpoints
    const vigilDir = join(projectDir, '.claude', 'vigil');
    const manifest = readManifest(vigilDir);
    const usage = diskUsage(vigilDir);

    if (manifest.checkpoints.length === 0 && !manifest.quicksave) {
      return { content: [{ type: 'text', text: box('empty', [
        'No checkpoints yet.',
        'Use vigil_save to create one.'
      ], projectDir) }] };
    }

    const lines = manifest.checkpoints.map(c => {
      const age = timeAgo(c.created);
      const files = `${c.fileCount} files`;
      return `  ${c.name}${' '.repeat(Math.max(1, 20 - c.name.length))}${age}${' '.repeat(Math.max(1, 12 - age.length))}${files}`;
    });
    if (manifest.quicksave) {
      lines.push(`  ~quicksave${' '.repeat(8)}${timeAgo(manifest.quicksave.created)}`);
    }

    const count = manifest.checkpoints.length;
    return { content: [{ type: 'text', text: box(`${count} checkpoint${count !== 1 ? 's' : ''}`, lines, projectDir) }] };
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

    if (result.error === 'not_found') {
      return { content: [{ type: 'text', text: `Checkpoint '${name}' not found.` }] };
    }
    if (result.error === 'file_not_found') {
      return { content: [{ type: 'text', text: `File '${file}' not found in checkpoint '${name}'.` }] };
    }

    // Single file retrieval
    if (result.content !== undefined) {
      return { content: [{ type: 'text', text:
        box(`${file} from ${name}`, [result.content], projectDir)
      }] };
    }

    // Full diff
    const lines = [];
    for (const f of result.modified) lines.push(`  modified  ${f}`);
    for (const f of result.added) lines.push(`  added     ${f}`);
    for (const f of result.deleted) lines.push(`  deleted   ${f}`);
    const total = result.modified.length + result.added.length + result.deleted.length;

    if (total === 0) {
      lines.push('  No changes — current state matches checkpoint.');
    }

    return { content: [{ type: 'text', text: box(`${total} change${total !== 1 ? 's' : ''}`, lines, projectDir) }] };
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

    if (result.error === 'not_found') {
      return { content: [{ type: 'text', text: `Checkpoint '${name}' not found.` }] };
    }

    const lines = [
      `from: ${result.restored}`,
      'quicksaved current state first',
      files
        ? `restored: ${result.filesRestored} file${result.filesRestored !== 1 ? 's' : ''}`
        : `restored: ${result.filesRestored} files (full project)`
    ];

    return { content: [{ type: 'text', text: box('restored', lines, projectDir) }] };
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
      return { content: [{ type: 'text', text: 'Specify a checkpoint name or all=true.' }] };
    }

    const result = deleteCheckpoint(projectDir, name, { all });

    if (result.error === 'not_found') {
      return { content: [{ type: 'text', text: `Checkpoint '${name}' not found.` }] };
    }

    const lines = [
      `deleted: ${result.deleted}`,
      `removed: ${result.gc.removed} unreferenced objects`,
      `reclaimed: ${formatBytes(result.gc.bytesFreed)}`
    ];

    return { content: [{ type: 'text', text: box('deleted', lines, projectDir) }] };
  }
);

// ── Start server ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
