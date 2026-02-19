#!/usr/bin/env node
// Pre-bash safety hook for claude-vigil-mcp.
// Detects destructive bash commands and spawns a background quicksave.
// CJS (CommonJS) — Claude Code hooks require it.
// Always exits 0 — never blocks Claude.

const { spawn } = require('child_process');
const { join } = require('path');
const { readFileSync } = require('fs');

const DESTRUCTIVE = /\b(rm|rmdir|mv|sed\s+-i|perl\s+-i)\b|git\s+(checkout|reset|clean|restore)\b|>\s*\S/;

try {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  const cmd = (input.tool_input?.command || '').trim();

  if (DESTRUCTIVE.test(cmd)) {
    const projectDir = process.cwd();
    const workerPath = join(__dirname, '..', 'src', 'worker.js');

    const child = spawn(process.execPath, [
      workerPath, projectDir, '~quicksave', 'quicksave'
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    const out = JSON.stringify({
      hookSpecificOutput: {
        additionalContext: 'vigil: quicksaving before destructive command'
      }
    });
    process.stdout.write(out);
  }
} catch {
  // Never block Claude — swallow all errors
}

process.exit(0);
