# Memory and storage

[Documentation](README.md) · [Project home](../README.md)

```text
.harness/sessions/<id>.json  Local ID → Codex thread and workspace
.harness/events/<id>.jsonl   Bounded, redacted protocol events
.harness/tasks/<id>.json     Workflow stages and check results
.harness/todos/<key>.json    Workspace task list and revision
.harness/memory.sqlite      Disposable index, scoped by canonical workspace path
<workspace>/memory/         Authoritative durable Markdown memories
notes/learning-journal.md   Legacy learning notes accessed through journal tools
```

Session IDs and thread IDs are distinct. Startup events before a session exists use a `connection-...` trace ID. `/status` shows the current trace ID. Default `.harness/` records are ignored by Git. This repository also ignores its root `memory/` and the sample workspace memory; notes in another workspace follow that repository's ignore rules. A custom `--data-dir` is not automatically ignored. Deliberate source notes under `notes/` are ordinary tracked project files.

Our event logs help inspect execution. They are not Codex's complete conversation store or an exact backup of model context. Credential-named fields are redacted, large text is truncated, and damaged lines are reported on reading. Logs can still contain code, prompts, and tool output.

### Workspace memory

One ordinary Markdown file stores each memory. The folder determines its kind; use the plural names:

```text
<workspace>/memory/
  facts/
  decisions/
  preferences/
  lessons/
  summaries/
```

Harness-created files use UUID names, a `# Title`, the body, and a trailing `<!-- harness-memory: {...} -->` JSON comment recording creation time and optional provenance. You can edit them normally or create your own `.md` files without metadata. An ID such as `facts/<uuid>.md` is relative to `memory/`. Edits preserve identity; renames are removal followed by addition. New memory directories appear when first needed.

Markdown owns the content. SQLite stores projects, copies of their memories, and an FTS5 index of titles/bodies. Every query filters by a project identity derived from the workspace's canonical path. Two workspaces sharing a data directory remain separate. Moving a workspace creates a new identity and reindexes its files.

Synchronization runs at startup and before retrieval, comparing content hashes. External additions, edits, renames, and deletions update search without a watcher. Symlinks, nonregular sources, and files over 64 KiB are rejected with diagnostics. A save writes a temporary Markdown file, renames it into place, then updates SQLite and FTS in one transaction. If indexing fails, the result says **“Markdown saved; index needs repair.”** The next successful sync repairs it. A damaged database is preserved as `memory.sqlite.corrupt-<uuid>` and rebuilt. If repair fails, coding continues with a warning and no recalled memory, rather than using stale indexed content.

Before each task, recall selects up to two recent preferences/decisions within 2,000 characters, then up to five relevant matches across all kinds. Search tokenizes the task into safely quoted FTS terms; it makes no model or embedding calls. Summaries appear only when they match. Notes are deduplicated, labeled as reference data, and truncated to a **6,000-character total budget**, including source metadata and the reference label. Submission shows IDs, paths, selection reasons (`core` or `match`), and character count. `/memory` inspects the last selection. `/memory off` and `--no-memory` control automatic inclusion; explicit commands and tools remain available.

Saving is always explicit. There is no automatic summarization, automatic forgetting, or background model call. Use `/memory add summaries ... :: ...` for an authored session summary. Direct terminal commands express your intent and need no additional approval. Agent tool saves use the interactive approval described above. Session JSON, workflow JSON, event JSONL, and Codex history retain their existing storage and roles.

Try the full storage path without Codex, API credits, or a network connection:

```bash
npm start -- --workspace "$PWD" --memory "add facts Empty arrays :: Empty arrays sum to zero."
npm start -- --workspace "$PWD" --memory "search arrays"
npm start -- --workspace "$PWD" --memory "list facts"
npm start -- --workspace "$PWD" --memory "read facts/ID-FROM-LIST.md"
npm start -- --workspace "$PWD" --memory "rebuild"
```

With the harness stopped, deleting `<data-dir>/memory.sqlite` is also safe; the next start rebuilds it from Markdown. The files remain readable in an editor while SQLite is absent. Back up or version the Markdown you want to retain; the search index is disposable. `/memory forget <id>` deliberately removes the file.

The old harness-wide `notes/project-decisions.md` is no longer included automatically. Import chosen notes explicitly into the selected workspace:

```bash
npm start -- --workspace ./fixtures/sample-project --memory "import decisions notes/project-decisions.md"
```

Import copies the content into a new memory and records the source path/hash; later changes to the original file do not update that copy. Relative import paths use the terminal's working directory. Existing journal content is never silently copied into every workspace.

Replay without creating a runtime connection:

```bash
npm start -- --replay LOCAL_SESSION_ID
```

Playback calls only the event renderer. It never invokes tools or resubmits turns. After a disconnect or lost acknowledgment, the application marks work uncertain and refuses blind retries. Restart and explicitly resume after inspecting history. Lost acknowledgment does not prove that an action did not happen.

## Data shared during live tasks

Local storage does not mean local model inference. The task, recalled memories, and requested tool results can become input to the remote Codex model. `--no-memory` stops automatic recall; it does not prevent the agent from requesting explicit tool reads. The offline toy and TUI preview do not contact Codex.

Treat event logs as potentially private even though credential-named fields are redacted. Before sharing a trace, inspect its prompts, code, tool output, and workspace paths. Codex manages its own credentials and conversation history outside these harness records. The harness does not read credential files directly.

If you want to version a saved memory, make that a deliberate decision and review its contents. In this repository an ignored memory can be added explicitly with `git add -f path/to/note.md`. In other workspaces, choose that repository's ignore rules before saving private notes.
