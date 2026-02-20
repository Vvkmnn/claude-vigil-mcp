# claude-vigil-mcp

<!-- ![claude-vigil-mcp](demo.gif) -->

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for **checkpoint, snapshot, and file recovery** in [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Perfect snapshots, selective restore, bash safety net, and honest disk management.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/) [![Claude](https://img.shields.io/badge/Claude-D97757?logo=claude&logoColor=fff)](#)

## why

Every AI coding tool tracks file edits made through its own editor, but none of them track file changes made externally: bash commands (`rm`, `mv`, `sed -i`), Python scripts, build tools, or any process that modifies files outside the editor's API. When those changes go wrong, there's nothing to rewind to.

Claude Code's built-in `/rewind` has additional gaps:

- **External changes are invisible** - `rm`, `mv`, `sed -i`, scripts, build tools aren't tracked ([#6413](https://github.com/anthropics/claude-code/issues/6413), [#10077](https://github.com/anthropics/claude-code/issues/10077))
- **No selective file restore** - rewind is all-or-nothing, can't undo file A while keeping file B
- **No named checkpoints** - timestamps only, finding the right checkpoint in 50+ snapshots is guesswork
- **Rewind reliability bugs** - "Restore code" sometimes doesn't work ([#21608](https://github.com/anthropics/claude-code/issues/21608), [#18516](https://github.com/anthropics/claude-code/issues/18516))
- **Rewind always creates forks** - clutters session history ([#9279](https://github.com/anthropics/claude-code/issues/9279))
- **Context compaction loses work** - silent amnesia after auto-compaction ([#8839](https://github.com/anthropics/claude-code/issues/8839), [#20696](https://github.com/anthropics/claude-code/issues/20696))
- **No headless/programmatic rewind** - can't trigger from scripts or automation ([#16976](https://github.com/anthropics/claude-code/issues/16976))

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

5 tools. Perfect snapshots. Content diffs. Safe restores with artifact preservation. The vigil watches over your codebase:

### vigil_save

Create a named checkpoint of the entire project. Runs in the background — Claude never waits. Optional `description` to annotate the checkpoint. If slots are full, Claude asks the user whether to delete an existing checkpoint or increase capacity.

```
🏺 ┏━ before-refactor saved ━━ vigil: 2/3 | quicksave: 8m ago | 4.2 MB
   ┃ Snapshot before risky auth changes
   ┗ 12 files · 4.1 MB
```

With `max_checkpoints` to expand capacity:

```
🏺 ┏━ experiment saved ━━ vigil: 4/5 | quicksave: 2m ago | 8.7 MB
   ┃ Testing new caching layer
   ┗ 47 files · 3.2 MB
```

### vigil_list

Browse checkpoints with descriptions. With `name`: drill into that checkpoint's files. With `glob`: filter files by pattern.

```
🏺 ┏━ 2 checkpoints ━━ vigil: 2/3 | quicksave: 3m ago | 8.7 MB
   ┃ v1.0                2h ago    4.2 MB   47 files — Initial stable release
   ┃ before-refactor     45m ago   4.1 MB   47 files — Snapshot before risky auth changes
   ┗ ~quicksave          3m ago
```

Drill into a checkpoint with glob filtering:

```
vigil_list name="v1.0" glob="src/auth/**"
```

```
🏺 ┏━ v1.0 (3 files) ━━ vigil: 2/3 | quicksave: 3m ago | 8.7 MB
   ┃ src/auth/index.ts          2.1 KB
   ┃ src/auth/middleware.ts      1.4 KB
   ┗ src/auth/types.ts           0.8 KB
```

### vigil_diff

Search and investigate previous versions of your codebase. Compare a checkpoint against the current working directory with full unified diffs, compare two checkpoints against each other, retrieve any file's content from any checkpoint, or search for a string across all checkpoints.

**Summary of changes:**

```
vigil_diff name="before-refactor" summary=true
```

```
🏺 ┏━ before-refactor vs working directory (3 changes) ━━ vigil: 2/3 | ...
   ┃ modified  src/auth.ts
   ┃ modified  src/middleware/validate.ts
   ┗ added     src/services/oauth.ts
```

**Full unified diffs:**

```
vigil_diff name="before-refactor"
```

```
🏺 ┏━ before-refactor vs working directory (3 changes) ━━ vigil: 2/3 | ...
   ┃ --- a/src/auth.ts
   ┃ +++ b/src/auth.ts
   ┃ @@ -12,6 +12,8 @@
   ┃  import { validateToken } from './utils';
   ┃ -function authenticate(req: Request) {
   ┃ +function authenticate(req: Request, options?: AuthOptions) {
   ┃ +  if (options?.skipValidation) return true;
   ┃    const token = req.headers.authorization;
   ┗ ...
```

**Retrieve a single file from a checkpoint:**

```
vigil_diff name="v1.0" file="src/auth.ts"
```

Returns the file's content as it existed in that checkpoint, plus a unified diff against the current version.

**Compare two checkpoints:**

```
vigil_diff name="v1.0" against="before-refactor"
```

Shows unified diffs between the two checkpoint states — no working directory involved.

**Search across all checkpoints:**

```
vigil_diff name="*" file="src/auth.ts" search="validateToken"
```

Finds which checkpoints contain the search string in the specified file. Returns matching lines with context.

### vigil_restore

Restore the project to a checkpoint state. Quicksaves current state first (undo with `vigil_restore name="~quicksave"`). Displaced files — both modified and newly created since the checkpoint — are preserved in `.claude/vigil/artifacts/` so nothing is ever lost. For individual file restores, use `vigil_diff` to retrieve file content, then apply with Edit.

```
vigil_restore name="v1.0"
```

```
🏺 ┏━ restored from v1.0 ━━ vigil: 2/3 | quicksave: just now | 8.7 MB
   ┃ quicksaved current state (undo: vigil_restore name="~quicksave")
   ┃ restored 47 files
   ┃ displaced files preserved in .claude/vigil/artifacts/restored_v1.0_20260219_143022/
   ┃   modified: src/auth.ts, src/middleware/validate.ts
   ┗   new: src/services/oauth.ts
```

When 3+ artifact directories accumulate, the output reminds about cleanup:

```
note: 4 artifact directories in .claude/vigil/artifacts/ — review and clean up old ones if no longer needed
```

### vigil_delete

Delete a checkpoint and reclaim disk space. GC removes unreferenced objects. Use `all=true` to delete everything.

```
vigil_delete name="v1.0"
```

```
🏺 ━━ deleted v1.0 ━━ vigil: 1/3 | quicksave: 3m ago | 4.5 MB
   reclaimed 241 MB · removed 3,412 unreferenced objects
```

### pre-bash hook (automatic)

Auto-quicksaves before destructive commands (`rm`, `mv`, `sed -i`, `git checkout`, `git reset`). The one gap no other tool fills. Fires in background, never blocks Claude.

## how it works

```
                    🏺 claude-vigil-mcp
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
            │  │ walk project  │  │  source files only (skips derived dirs)
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
     │  ├── objects/                           │
     │  │   ├── ab/cdef01...gz   gzipped file  │
     │  │   ├── f3/981a02...gz   gzipped file  │
     │  │   └── ...              (deduped)     │
     │  └── artifacts/                         │
     │      └── restored_v1.0_20260219_.../    │
     │          ├── src/auth.ts   (modified)   │
     │          └── src/new.ts    (new file)   │
     └─────────────────────────────────────────┘

     3 named slots + 1 rotating quicksave
     Every response: "vigil: 2/3 | quicksave: 3m ago | 287 MB"


     RESTORE (only sync operation):

     vigil_restore("v1.0")
            │
            ├── quicksave current state (overwrite previous)
            │
            ├── preserve displaced files in artifacts/
            │   ├── modified files → copied to artifacts
            │   └── new files → moved to artifacts
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

**Artifact preservation**: On restore, files that would be overwritten or lost (modified since checkpoint, or newly created) are preserved in `.claude/vigil/artifacts/`. Nothing is ever deleted — you can always recover displaced work.

## skill

Optionally, install the skill to teach Claude when to proactively checkpoint before risky work:

```bash
npx skills add Vvkmnn/claude-vigil-mcp --skill vigil-checkpointing --global
```

## architecture

```
claude-vigil-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts       # MCP server, 5 tools
│   ├── types.ts       # TypeScript interfaces and discriminated unions
│   ├── store.ts       # CAS: hash, store, read, gc, disk usage
│   ├── snapshot.ts    # create, restore, diff, list, delete
│   └── worker.ts      # background snapshot process
├── hooks/
│   └── pre-bash.js    # PreToolUse: quicksave before destructive bash (CJS)
├── skills/
│   └── vigil-checkpointing/
│       └── SKILL.md   # optional skill for proactive checkpointing
└── test/
    └── index.test.ts  # 73 tests
```

**Design decisions:**
- **No git dependency** — pure Node.js built-ins (crypto, zlib, fs)
- **Perfect snapshots** — every file captured, no size/binary filtering
- **CAS + gzip** — 3.5x leaner than hard links, automatic dedup
- **Background execution** — Claude never blocks on snapshot creation
- **3-slot limit** — conservative default prevents runaway storage
- **Stateless server** — reads manifest from disk each call, no in-memory state to lose
- **Artifact preservation** — displaced files saved on restore, nothing ever lost
- **Cross-platform** — macOS, Linux, Windows. No shell dependencies

## disk usage

Vigil auto-skips derived directories (`node_modules/`, `dist/`, `target/`, `venv/`, etc.) detected from `.gitignore` and common patterns. Only source files are checkpointed.

| Project type | Raw size | Source only | First snapshot | Incremental |
|-------------|----------|-------------|---------------|-------------|
| Next.js app | 750 MB | ~2 MB | ~1 MB | ~50 KB |
| Rust project | 2.5 GB | ~5 MB | ~3 MB | ~100 KB |
| Python project | 350 MB | ~3 MB | ~2 MB | ~50 KB |

After restore, vigil reports which derived dirs exist but weren't restored — Claude rebuilds them (`npm install`, `cargo build`, etc.). Edit `.claude/vigil/.vigilignore` to adjust what gets skipped.

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
- **73 tests**, ~100ms

## alternatives

**[Claude Code /rewind](https://code.claude.com/docs/en/checkpointing)** - Built-in checkpoint system. Tracks Claude's own file edits only.

**[Rewind-MCP](https://github.com/khalilbalaree/Rewind-MCP)** - Third-party MCP server for checkpointing in Claude Code. Stack-based undo system.

**[claude-code-rewind](https://github.com/holasoymalva/claude-code-rewind)** - Python-based snapshot tool with SQLite metadata and visual diffs.

**[Checkpoints app](https://claude-checkpoints.com/)** - macOS desktop app that monitors Claude Code projects for file changes.

**[Cursor checkpoints](https://stevekinney.com/courses/ai-development/cursor-checkpoints)** - Built-in to Cursor. Zips project state before each AI edit.

| Feature | claude-vigil-mcp | /rewind | Rewind-MCP | claude-code-rewind | Checkpoints app | Cursor |
| --- | --- | --- | --- | --- | --- | --- |
| **Tracks external changes** | Yes (bash, scripts, builds) | No | No | No | No | No |
| **Named checkpoints** | Yes | No (timestamps) | Yes | Yes | Yes | No |
| **Content diffs** | Yes (unified diffs) | No | No | Yes (visual) | No | No |
| **Search across checkpoints** | Yes | No | No | No | No | No |
| **Artifact preservation** | Yes (nothing lost) | N/A | No | No | No | No |
| **Dedup storage** | CAS + gzip | None | Unknown | SQLite + diffs | Full copies | Zip per edit |
| **Background saves** | Yes (<5ms return) | Blocking | Blocking | Blocking | Background | Blocking |
| **Headless/programmatic** | Yes (MCP) | No ([#16976](https://github.com/anthropics/claude-code/issues/16976)) | Yes (MCP) | CLI | No | No |
| **Cross-platform** | Node.js | Built-in | Node.js | Python | macOS only | Built-in |
| **Dependencies** | 0 (Node built-ins) | N/A | Node.js | Python + SQLite | Desktop app | N/A |
| **Disk visibility** | Every response | Hidden | Manual | Manual | Manual | Hidden |
| **Active maintenance** | Yes | N/A | 13 stars | 23 stars | Commercial | N/A |

The core gap across all alternatives: none of them track file changes made outside the editor's own tools. When Claude runs `rm -rf dist/`, a Python script overwrites a config, or a build tool generates files, those changes are permanent and unrecoverable. Vigil is the only tool that checkpoints the full project state independent of how files were changed.

### approaches we evaluated and rejected

**Shadow git repo** (`git --git-dir=.claude/vigil/.git --work-tree=.`): Wraps git commands for dedup, diff, and restore. Elegant in theory, but has 6 high-severity failure modes:

1. Self-tracking recursion - `.claude/vigil/.git` inside the work tree it tracks
2. Binary bloat - every image/db/artifact stored in full, unbounded growth
3. Concurrent lock conflicts - parallel saves fight over `index.lock`
4. Overlay on restore - `git checkout tag -- .` doesn't delete files added after checkpoint (mixed state)
5. `git clean` danger - cleaning untracked files from shadow repo's perspective destroys project files
6. Env var interference - `GIT_DIR`/`GIT_WORK_TREE` from parent processes override CLI flags

**Hard-link Time Machine pattern**: Each snapshot is a real directory tree with unchanged files hard-linked (zero disk cost per file). Battle-tested pattern (macOS Time Machine uses it). Rejected because it creates full directory trees per checkpoint: 20 checkpoints of a 1000-file project = 20,000 directory entries. CAS + gzip is 3.5x leaner on disk.

**rsync --link-dest**: Similar to hard links but uses rsync for the copy. Preinstalled on macOS/Linux, ~30 lines. Rejected because it has no built-in diff capability, and you'd need to implement file comparison yourself.

## plugin

For hooks and commands, install from the [claude-emporium](https://github.com/Vvkmnn/claude-emporium) marketplace:

```bash
git clone https://github.com/Vvkmnn/claude-agora ~/.claude/plugins/claude-emporium
```

The **claude-vigil** plugin will provide:

**Hooks:**

- `PreToolUse (Bash)` - auto-quicksave before destructive commands (`rm`, `mv`, `sed -i`, `git checkout`, `git reset`)
- `PreCompact` - auto-checkpoint before context compaction, both manual (`/compact`) and automatic. Insurance against amnesia when Claude loses context
- `Stop` - auto-checkpoint after Claude finishes a response that included file edits. Captures stable states between interactions. With CAS dedup, incremental cost is near zero if nothing changed
- `PostToolUse (Write|Edit)` - checkpoint after file modifications. More granular than Stop, catches each edit individually
- `SessionEnd` - last-chance checkpoint when the session terminates. Insurance against losing unsaved work

**Command:** `/checkpoint <save|list|diff|restore|delete>`

**Planned features:**

- Session file history - parse `messages.jsonl` to show per-file edit timeline
- Global status CLI - `npx claude-vigil-mcp status --global` to see disk usage across all projects
- Configurable slot limit - `.vigilconfig` for per-project settings
- Age-based cleanup - `npx claude-vigil-mcp cleanup --older-than 7d` across projects

Requires the MCP server installed first. See the emporium for other Claude Code plugins and MCPs.

## research

Designed across sessions `snappy-wondering-sunbeam` and `temporal-pondering-nest` (2026-02-18/19). Key findings:

- **No tool tracks external file changes** - Claude Code, Cursor, and Windsurf all miss bash commands, scripts, and build tool output
- **Rewind reliability issues** - multiple GitHub issues report silent failures on multi-file restores
- **CAS + gzip is 3.5x leaner** than hard-link (Time Machine) approach for checkpoint storage
- **Shadow git repos have 6 high-severity failure modes** - self-tracking recursion, concurrent locks, overlay mode, env var interference, binary bloat, git clean danger

**Part of**: [claude-emporium](https://github.com/Vvkmnn/claude-emporium) - Claude Code plugins with a Roman theme.

## license

[MIT](LICENSE)

---

<!-- ![Vigiles](logo/vigil.jpg) -->

_The Vigiles Urbani — Rome's watchmen and fire brigade, who patrolled the city through the night_
