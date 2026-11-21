# Tools and MCP

[Documentation](README.md) · [Project home](../README.md)

## What MCP means here

MCP stands for Model Context Protocol. It gives an agent a standard way to discover tools, read their input schemas, and request a call. A tool is an operation such as searching files or saving a memory; the application still validates and authorizes its execution.

This repository starts its own local MCP server for Codex. You do not need a hosted MCP service or a separate server deployment. App Server carries conversation events between Codex and the harness; MCP carries tool calls between Codex and the tool server. The protocols serve different roles.

## Permissions and application tools

The live client requests `on-request` approvals with human review. Effective behavior also depends on the installed runtime, managed policy, and inherited Codex configuration. A request to use read-only mode is not a new application-defined operating-system sandbox. No global Codex configuration is rewritten.

The application handles command/file decisions and additional-permission requests separately. Unknown server requests receive an error. Form/URL elicitations are declined, and unimplemented interactive agent questions receive no answers. These cases stay visible in event logs instead of leaving a turn waiting forever.

The journal tools are supplied by a local MCP server:

- `journal_read`: bounded excerpt of `notes/learning-journal.md` in the harness repository.
- `journal_search`: case-insensitive literal search, with bounded results.
- `journal_append`: short append that needs application approval.

Tool handlers validate arguments and use a fixed journal path. They reject symlink targets and nonregular files. A private Unix socket connects an append request back to the terminal application. The handler writes only after that application decision. `--write`, an active turn, and an interactive approval are required; a standalone tool server without the bridge denies appends.

The same MCP server provides `memory_search`, `memory_read`, and `memory_save`. These call the parent-owned memory service over that authenticated socket. The child never opens SQLite or independently synchronizes Markdown. `memory_save` proposes a kind, title, and body; the terminal shows the complete content and exact destination. Saving requires `--write`, an active turn, and an interactive approval. The parent supplies session/turn provenance. Standalone memory tools fail without their parent service. Legacy journal tools remain available during migration.

Five additional workspace tools use the same parent-owned execution path, bringing MCP discovery to eleven tools. The parent validates inputs again and supplies workspace identity and authorization origin. Caller arguments cannot select another workspace or impersonate a direct user command. Agent requests to run checks or update tasks require `--write`, an active turn, and interactive approval of the complete operation. The MCP child contains only forwarding adapters for these tools.

The Unix socket makes this version suitable for Linux/macOS. Windows named-pipe support is not implemented. The application itself uses the official [App Server protocol](https://learn.chatgpt.com/docs/app-server), and the tool server uses [MCP](https://learn.chatgpt.com/docs/extend/mcp). Inherited MCP servers or plugins may also appear in your runtime; use debug output to understand what was loaded.

## Local workspace tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `workspace_search` | `query`; optional `path`, `limit`, `caseInsensitive` | Relative filenames, line numbers, excerpts, elapsed time, and truncation |
| `git_inspect` | `operation: "status"`, `"diff"`, or `"log"`; `staged` only for diff, `limit` only for log | Workspace-scoped status entries, patch text, or commit records |
| `project_check` | Optional `script: "test"`, `"typecheck"`, `"lint"`, or `"check"` | Available scripts, or actual execution status, code, output, timing, and truncation |
| `todo_list` | `{}` | Current workspace task list and revision |
| `todo_update` | `revision` and a `changes` array | The complete updated task list and new revision |

Try these without Codex, sign-in, API credits, or a model call:

```bash
npm start -- --workspace "$PWD" --tools
npm start -- --workspace "$PWD" --tool workspace_search --args '{"query":"recall","path":"src","limit":10}'
npm start -- --workspace "$PWD" --tool git_inspect --args '{"operation":"status"}'
npm start -- --workspace "$PWD" --tool git_inspect --args '{"operation":"diff","staged":true}'
npm start -- --workspace "$PWD" --tool project_check
npm start -- --workspace "$PWD" --write --tool project_check --args '{"script":"typecheck"}'
```

Within a live terminal session, use the same JSON with `/tool`, for example `/tool git_inspect {"operation":"log","limit":5}`. In line mode, `/tools` describes these five tools; the TUI Tools view also includes memory and journal tools; memory keeps its dedicated `/memory` commands. Direct user task updates need no second confirmation. Direct check execution requires `--write` and prints the resolved command before running. Agent calls retain interactive approval; noninteractive agent execution cannot approve them.

Search uses literal matching, defaults to case-insensitive matching and 20 results, and permits at most 100. It honors repository ignore rules and skips hidden, binary, and symlinked files. Dependencies, generated bindings, common build directories (`dist`, `build`, `out`, `target`, `coverage`), and harness data are excluded. Explicit paths must remain inside the canonical workspace without symlink components. Files larger than 1 MiB are skipped. A requested file/directory filters results from a root traversal so it cannot bypass ignore rules. Raw search output is capped at 256 KiB, excerpts at 400 characters, and results carry `truncated` when a budget is reached; a limited search may therefore be incomplete. No matches is a successful empty result.

Git inspection uses fixed arguments, no shell, disabled external diff/text-conversion helpers, and no optional index locking. Subdirectory workspaces return only their status, relative diffs, and commits affecting that subtree. History defaults to ten commits, capped at fifty; patches default to unstaged tracked-file changes. Search and Git inspection have ten-second deadlines. They do not modify project or Git state.

Checks discover only the permitted scripts present in the workspace's own `package.json`. An empty call lists them without approval. Execution shows the main script and applicable npm pre/post hooks; changes to package definitions during approval invalidate the proposal. Only one check runs at a time, with a sixty-second timeout. Approved npm scripts run with normal local-process permissions and can modify files; selecting a working directory is not an operating-system sandbox. The existing fixture workflow continues to use its independently frozen acceptance program.

`/stop`, Ctrl+C, socket/request cancellation, turn completion, and shutdown cancel owned operations. Process groups receive termination followed by forced cleanup when needed. The local socket has a 195-second deadline and the runtime MCP configuration allows 200 seconds, covering the two-minute approval window and check execution. Operations are not retried automatically.

Results remain valid JSON when bounded. If a complete result exceeds a tool's final output limit, the tool returns a structured error rather than cutting the JSON in the middle. Offline commands print a `tools-...` trace ID; replay it with `--replay`, or inspect its bounded local event records. A failed direct check produces a nonzero CLI exit code.

### Workspace task tracking

Task lists live at `<data-dir>/todos/<workspace-key>.json`. They use the same canonical workspace identity as memory, with separate storage from memories and workflow records. There are no automatic task-generation or memory-saving steps.

```bash
npm start -- --workspace "$PWD" --tool todo_list
npm start -- --workspace "$PWD" --tool todo_update --args '{"revision":0,"changes":[{"operation":"add","title":"Understand tool validation"}]}'
```

Use the revision from the latest list or update. New tasks receive a UUID and default to `pending`. Edits and removals reference that ID:

```json
{
  "revision": 1,
  "changes": [
    {"operation":"edit","id":"UUID-FROM-TODO-LIST","status":"completed"}
  ]
}
```

An edit may change `title` and/or `status`; removal uses `{"operation":"remove","id":"UUID-FROM-TODO-LIST"}`. Statuses are `pending`, `in_progress`, and `completed`, with multiple tasks allowed in progress. Titles are single-line text up to 200 characters, batches contain at most twenty changes, and a workspace holds at most one hundred tasks. Updates validate the entire batch, check its revision, show agent proposals with before/after records, and atomically rename a temporary JSON file into place. Stale revisions and external edits during approval are rejected. Invalid or corrupted task files remain intact for repair.
