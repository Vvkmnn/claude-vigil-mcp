# claude-vigil-mcp

<!-- ![claude-vigil-mcp](demo.gif) -->

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for **checkpoint, snapshot, and file recovery** in [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Perfect snapshots, selective restore, bash safety net, and honest disk management.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/) [![Claude](https://img.shields.io/badge/Claude-D97757?logo=claude&logoColor=fff)](#)

## why

Claude Code's built-in `/rewind` has significant gaps:

- **Bash commands are invisible** — `rm`, `mv`, `sed -i` aren't tracked by checkpoints ([#6413](https://github.com/anthropics/claude-code/issues/6413), [#10077](https://github.com/anthropics/claude-code/issues/10077))
- **No selective file restore** — rewind is all-or-nothing, can't undo file A while keeping file B
- **No named checkpoints** — timestamps only, finding the right checkpoint in 50+ snapshots is guesswork
- **Rewind reliability bugs** — "Restore code" sometimes doesn't work ([#21608](https://github.com/anthropics/claude-code/issues/21608), [#18516](https://github.com/anthropics/claude-code/issues/18516))
- **Rewind always creates forks** — clutters session history ([#9279](https://github.com/anthropics/claude-code/issues/9279))
- **No headless/programmatic rewind** — can't trigger from scripts ([#16976](https://github.com/anthropics/claude-code/issues/16976))

No tool — not Claude Code, Cursor, or Windsurf — tracks bash-made file changes.

## install

Requirements:

> [Claude Code](https://claude.ai/code) and [Node.js](https://nodejs.org/) >= 20

**From shell:**

```bash
claude mcp add claude-vigil-mcp -- npx claude-vigil-mcp
```

**From inside Claude** (restart required):

```
Add this to our global mcp config: npx claude-vigil-mcp
```

**From any manually configurable `mcp.json`:** (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "claude-vigil-mcp": {
      "command": "npx",
      "args": ["claude-vigil-mcp"],
      "env": {}
    }
  }
}
```

## features

5 tools. Perfect snapshots. Honest about disk usage. The vigil watches over your codebase `🦅`:

### vigil_save

Create a named checkpoint of the entire project. Runs in the background — Claude never waits.

```
🦅 vigil_save name="before-refactor"
  > "Snapshot before risky auth changes"
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ saved ━┓
┃                                                   ┃
┃  before-refactor          started (background)    ┃
┃  ~4 MB estimated          12 files changed        ┃
┃                                                   ┃
┃  vigil: 2/3 │ quicksave: 8m ago │ 273 MB         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### vigil_list

Browse checkpoints. With a name: drill into that checkpoint's files.

```
🦅 vigil_list
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2 checkpoints ━┓
┃                                                    ┃
┃  v1.0               2h ago    265 MB   1,247 files ┃
┃  before-refactor    45m ago     4 MB   1,247 files ┃
┃  ~quicksave          3m ago                        ┃
┃                                                    ┃
┃  vigil: 2/3 │ quicksave: 3m ago │ 273 MB          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

```
🦅 vigil_list name="v1.0" glob="src/auth/**"
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ v1.0 ━┓
┃                                                ┃
┃  src/auth/index.ts          2.1 KB             ┃
┃  src/auth/middleware.ts      1.4 KB             ┃
┃  src/auth/types.ts           0.8 KB             ┃
┃                                                ┃
┃  3 of 1,247 files │ 265 MB total               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### vigil_diff

See what changed since a checkpoint. With a file path: retrieve that file's old content without restoring.

```
🦅 vigil_diff name="before-refactor"
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 4 changes ━┓
┃                                                   ┃
┃  modified  src/auth.ts                            ┃
┃  modified  src/middleware/validate.ts              ┃
┃  added     src/services/oauth.ts                  ┃
┃  deleted   src/utils/legacy-auth.ts               ┃
┃                                                   ┃
┃  vigil: 2/3 │ quicksave: 3m ago │ 273 MB         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### vigil_restore

Restore to a checkpoint. Always quicksaves current state first (emulator pattern). Selective restore with `files` parameter.

```
🦅 vigil_restore name="v1.0" files=["src/auth.ts"]
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ restored ━┓
┃                                                   ┃
┃  from: v1.0                                       ┃
┃  quicksaved current state first                   ┃
┃  restored: src/auth.ts (reverted 23 lines)        ┃
┃                                                   ┃
┃  vigil: 2/3 │ quicksave: just now │ 273 MB       ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### vigil_delete

Delete a checkpoint and reclaim disk space. GC removes unreferenced objects.

```
🦅 vigil_delete name="v1.0"
```

```
┏━ 🦅 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ deleted ━┓
┃                                                 ┃
┃  deleted: v1.0                                  ┃
┃  removed: 3,412 unreferenced objects            ┃
┃  reclaimed: 241 MB                              ┃
┃                                                 ┃
┃  vigil: 1/3 │ quicksave: 3m ago │ 32 MB        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### pre-bash hook (automatic)

Auto-quicksaves before destructive commands (`rm`, `mv`, `sed -i`, `git checkout`, `git reset`). The one gap no other tool fills. Fires in background, never blocks Claude.

## how it works

```
                    🦅 claude-vigil-mcp
                    ━━━━━━━━━━━━━━━━━━━

     Claude calls tool              Pre-bash hook fires
     vigil_save                     (destructive command)
            │                              │
            └──────────┬───────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  spawn worker   │  <5ms, returns immediately
              │  (detached)     │
              └────────┬────────┘
                       │
            ┌──────────┴──────────┐
            │   background worker │
            │                     │
            │  ┌───────────────┐  │
            │  │ walk project  │  │  every file, no skipping
            │  └───────┬───────┘  │
            │          │          │
            │  ┌───────▼───────┐  │
            │  │ hash (SHA-256)│  │  same content = same hash
            │  └───────┬───────┘  │
            │          │          │
            │  ┌───────▼───────┐  │
            │  │ gzip + store  │  │  dedup: skip if exists
            │  └───────┬───────┘  │
            │          │          │
            │  ┌───────▼───────┐  │
            │  │update manifest│  │  {path → hash} per checkpoint
            │  └───────────────┘  │
            └─────────────────────┘

     ┌─────────────────────────────────────────┐
     │  .claude/vigil/                         │
     │  ├── manifest.json    checkpoints + meta│
     │  └── objects/                           │
     │      ├── ab/cdef01...gz   gzipped file  │
     │      ├── f3/981a02...gz   gzipped file  │
     │      └── ...              (deduped)     │
     └─────────────────────────────────────────┘

     3 named slots + 1 rotating quicksave
     Every response: "vigil: 2/3 | quicksave: 3m ago | 287 MB"


     RESTORE (only sync operation):

     vigil_restore("v1.0")
            │
            ├── quicksave current state (overwrite previous)
            │
            ├── read manifest → get {path → hash}
            │
            ├── for each file: gunzip object → write to project
            │
            └── done: bit-identical working directory
```

**Storage**: Content-addressable storage (SHA-256 + gzip). Same file across checkpoints = stored once. Binary files included — a restored checkpoint is bit-identical to the original.

**Performance**: Background worker via `spawn(detached)`. MCP tool returns in <5ms. Worker runs independently. Only `vigil_restore` is synchronous (must write files before Claude proceeds).

**Disk honesty**: Every tool response shows `vigil: 2/3 | quicksave: 3m ago | 273 MB`. No hidden costs. 3 checkpoint slots by default. `.vigilignore` for excluding paths you don't need.

## architecture

```
claude-vigil-mcp/
├── package.json
├── src/
│   ├── index.js       # MCP server, 5 tools
│   ├── store.js       # CAS: hash, store, read, gc, disk usage
│   ├── snapshot.js    # create, restore, diff, list, delete
│   └── worker.js      # background snapshot process
├── hooks/
│   └── pre-bash.js    # PreToolUse: quicksave before destructive bash
└── test/
    └── index.test.js  # 24 tests
```

**Design decisions:**
- **No git dependency** — pure Node.js built-ins (crypto, zlib, fs)
- **Perfect snapshots** — every file captured, no size/binary filtering
- **CAS + gzip** — 3.5x leaner than hard links, automatic dedup
- **Background execution** — Claude never blocks on snapshot creation
- **3-slot limit** — conservative default prevents runaway storage
- **Stateless server** — reads manifest from disk each call, no in-memory state to lose
- **Cross-platform** — macOS, Linux, Windows. No shell dependencies

## disk usage

| Project type | Raw size | First snapshot | Incremental |
|-------------|----------|---------------|-------------|
| Next.js + node_modules | 750 MB | ~265 MB | ~5 MB |
| Rust + target/ | 2.5 GB | ~2.0 GB | ~15 MB |
| Python + venv | 350 MB | ~130 MB | ~3 MB |

After the first snapshot, only changed files add storage. Use `.vigilignore` to exclude large directories you don't need to checkpoint (e.g., `target/`, `node_modules/`).

## development

```bash
git clone https://github.com/Vvkmnn/claude-vigil-mcp
cd claude-vigil-mcp
npm install
npm test
```

- **Node.js** >= 20.0.0 (ES modules)
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod`
- **Zero external databases**
- **24 tests**, ~100ms

## plugin roadmap

Features planned for the [claude-emporium](https://github.com/Vvkmnn/claude-emporium) plugin wrapper:

- **`/checkpoint` command** — slash command for save/list/restore/diff/delete
- **Pre-compaction hook** — auto-snapshot before context compaction (insurance against amnesia)
- **Session file history** — parse `messages.jsonl` to show per-file edit timeline
- **Skill** — teach Claude when to proactively create checkpoints
- **Global status CLI** — `npx claude-vigil-mcp status --global` to see disk usage across all projects
- **Configurable slot limit** — `.vigilconfig` for per-project settings
- **Age-based cleanup** — `npx claude-vigil-mcp cleanup --older-than 7d` across projects

## research

Designed across sessions `snappy-wondering-sunbeam` and `temporal-pondering-nest` (2026-02-18/19). Key findings:

- **No tool tracks bash changes** — Claude Code, Cursor, and Windsurf all miss `rm`, `mv`, `sed -i`
- **Rewind reliability issues** — multiple GitHub issues report silent failures on multi-file restores
- **CAS + gzip is 3.5x leaner** than hard-link (Time Machine) approach
- **Shadow git repos have 6 high-severity failure modes** — self-tracking recursion, concurrent locks, overlay mode, env var interference, binary bloat, git clean danger

**Part of**: [claude-emporium](https://github.com/Vvkmnn/claude-emporium) — Claude Code plugins with a Roman theme.

## license

[MIT](LICENSE)

---

<!-- ![Vigiles](logo/vigil.jpg) -->

_The Vigiles Urbani — Rome's watchmen and fire brigade, who patrolled the city through the night_
