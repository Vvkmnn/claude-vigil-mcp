---
name: vigil-checkpointing
description: Use when about to make risky changes, before refactors, migrations, or destructive operations — checkpoint project state with vigil so you can restore if something goes wrong
---

# Vigil Checkpointing

## Overview

Checkpoint project state before risky work. Restore if things break. Like quicksave in a video game.

**Core principle:** Save before danger, restore on failure.

## When to Use

- Before refactors, migrations, or large code changes
- Before destructive operations (file deletions, schema changes)
- Before experimenting with approaches you might revert
- When the user asks to "save state" or "checkpoint"

## Quick Reference

| Tool | Purpose |
|------|---------|
| `vigil_save` | Create named checkpoint |
| `vigil_list` | Show all checkpoints and disk usage |
| `vigil_diff` | Compare current state to a checkpoint |
| `vigil_restore` | Revert to a checkpoint (quicksaves current state first) |
| `vigil_delete` | Remove a checkpoint and reclaim space |

## Workflow

### Save before risky work

```
vigil_save(name: "before-refactor")
```

First save auto-detects derived dirs (node_modules, dist, etc.) from `.gitignore` and skips them. Output shows what was skipped — confirm with the user if it looks right.

### Check what changed

```
vigil_diff(name: "before-refactor")
```

Returns added/modified/deleted file lists. Use `file` param to retrieve a specific file's content from the checkpoint without restoring.

### Restore if needed

```
vigil_restore(name: "before-refactor")
```

Quicksaves current state first (safety net), then restores. Output lists derived dirs that weren't restored — **you must rebuild these** (e.g., `npm install && npm run build`). Read the project's package manager and build system to determine the right commands.

### Selective restore

```
vigil_restore(name: "before-refactor", files: ["src/broken.ts"])
```

Restore specific files without touching the rest.

## Slot Management

Default: 3 checkpoint slots. When full:
- Delete old checkpoints: `vigil_delete(name: "old-one")`
- Or increase capacity: `vigil_save(name: "new", max_checkpoints: 5)`

## What Gets Skipped

Vigil auto-skips derived artifact directories (node_modules, dist, target, venv, __pycache__, etc.) detected from `.gitignore` and common patterns. Only source files are checkpointed. Edit `.claude/vigil/.vigilignore` to adjust.

## After Restore

Vigil tells you which derived dirs exist but weren't restored. You need to regenerate them:
- Read the project's build system (package.json, Cargo.toml, etc.)
- Run the appropriate install and build commands
- Don't assume — check what the project actually uses

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting to rebuild after restore | Read vigil's output — it lists what needs rebuilding |
| Saving with a duplicate name | Delete or choose a different name |
| Running out of slots | Delete old checkpoints or increase max_checkpoints |
| Restoring without checking diff first | Use vigil_diff to see what will change |
