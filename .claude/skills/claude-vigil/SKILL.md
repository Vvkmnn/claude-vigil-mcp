---
name: claude-vigil
description: Use when about to make risky changes — refactors, migrations, destructive bash commands, schema changes, or experimental approaches that might need reverting. Checkpoint project state for safe rollback.
---

# Claude Vigil

Checkpoint project state before risky work. Restore if things break.

## When to Use

- Before refactors, migrations, or large code changes
- Before destructive operations (file deletions, schema changes)
- Before experimenting with approaches you might revert
- Before `rm`, `mv`, `sed -i`, `git checkout`, `git reset`
- When the user asks to "save state" or "checkpoint"

## Quick Reference

| Tool | Purpose |
|------|---------|
| `vigil_save` | Create named checkpoint — background, returns in <5ms |
| `vigil_list` | Show all checkpoints with disk usage |
| `vigil_diff` | Compare current state to a checkpoint |
| `vigil_restore` | Revert to checkpoint — quicksaves current state first, preserves displaced files |
| `vigil_delete` | Remove a checkpoint and reclaim space |

## Workflow

1. `vigil_save(name: "before-refactor")` — first save auto-detects derived dirs from `.gitignore`
2. Make the risky changes
3. `vigil_diff(name: "before-refactor")` — check what changed
4. If broken: `vigil_restore(name: "before-refactor")` — then rebuild derived dirs
5. If good: `vigil_delete(name: "before-refactor")` — reclaim space

## After Restore

Vigil skips derived directories (node_modules, dist, target, venv). Read the output — it lists what needs rebuilding. Run the project's install and build commands.

## Slot Management

Default: 3 checkpoint slots. When full, delete old checkpoints or increase capacity via `max_checkpoints` parameter.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting to rebuild after restore | Read vigil's output — it lists what needs rebuilding |
| Restoring without checking diff first | Use `vigil_diff` to see what will change |
| Not saving before destructive bash | Save before `rm`, `mv`, `sed -i`, `git checkout`, `git reset` |
