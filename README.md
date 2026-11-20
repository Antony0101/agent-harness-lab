# Learning Harness

A small TypeScript terminal harness built to make agent execution inspectable. It uses a local Codex App Server with ChatGPT subscription sign-in. The offline toy loop runs without Codex or a network connection.

The application owns its terminal, workflow transitions, workspace memory, journal tools, approval UI, and JSON records. Memory is ordinary Markdown with a disposable SQLite search index. Codex owns the real model/tool execution loop. The implementation follows [the learning plan](plans/learning-harness-plan.md).

## Get started

Requirements: Node.js 22.17 or newer, npm, and a working Codex CLI for the live exercises. Memory uses built-in `node:sqlite` and FTS5, requiring no database package or service. Node 22.17 prints an experimental-feature warning for SQLite. The tested runtime is recorded in [the development notes](notes/development.md).

Local workspace tools use `git`, `rg` (ripgrep), and `npm` from `PATH`. A missing executable produces setup guidance for its tool; task tracking and the remaining tools still work. No additional npm packages are required.

```bash
npm install
npm run protocol
npm run fixture:reset
npm run check
```

`npm run protocol` generates bindings from your installed executable into the ignored `generated/` directory. Regenerate them when changing Codex versions. The live client checks the recorded runtime version before starting.

Startup and protocol generation use the same discovery order: an explicit `CODEX_BIN`, the `codex` command on `PATH`, then compatible Codex binaries bundled with VS Code extensions (including WSL's `~/.vscode-server/extensions`). The chosen path is printed. An invalid explicit override produces an error; unset it to restore discovery.

If discovery finds no runtime, install the [official Codex CLI](https://learn.chatgpt.com/docs/cli), or point at an existing executable:

```bash
export CODEX_BIN="/absolute/path/to/codex"
npm run protocol
npm start
```

No global installation or shell-profile change is needed when editor discovery succeeds. Extension-bundled executables can move during editor updates, so rerun protocol generation if the selected runtime version changes.

Start with the offline teaching exercise:

```bash
npm run toy
npm run toy -- invalid
npm run toy -- unknown
npm run toy -- denied
npm run toy -- error
npm run toy -- limit
```

Watch an action become a validated tool call, an observation, and another decision. The model in this exercise is a scripted function. `limit` deliberately repeats until the five-iteration cap.

Try the full-screen interface with sample data and no Codex process:

```bash
npm run tui:preview
```

For real Codex tasks, sign in through the official CLI first:

```bash
codex login status
codex login
npm start
```

Only run `codex login` if sign-in is needed. The harness requires ChatGPT sign-in, does not read token files, and does not switch to API-key billing. Subscription usage limits still apply. The model service needs an internet connection even though App Server runs locally. See [official authentication guidance](https://learn.chatgpt.com/docs/auth).

## First live exercises

The default workspace is `fixtures/sample-project` with read-only access. Initial application setup still writes its own records under `.harness/`; read-only describes the requested Codex execution policy.

Try these prompts, one at a time:

```text
Inspect sum.mjs and check.mjs. Explain the failing assertion without editing files.
Use the learning_journal journal_search tool to look up the seeded project codename.
```

Journal tool results and recalled workspace memories become model input. Keep the initial seeded notes for experiments; consider what you include before replacing them with personal content.

Inspect `/status`, `/memory`, and `/history`. Save the local session ID from `/status`, exit, then resume:

```bash
npm start -- --resume LOCAL_SESSION_ID
```

Ask a follow-up question. Resume uses Codex's saved history, while our local JSON record indexes the thread. Both the local record and the original Codex history need to remain available.

For a single task:

```bash
npm start -- --prompt "Explain what an agent turn is" --no-memory
```

A one-shot or piped-input session declines approval requests automatically. It never treats absent terminal input as permission.

## CLI commands

| Command | Behavior |
| --- | --- |
| `/new` | Start a fresh runtime conversation |
| `/status` | Show state, IDs, workspace, permission mode, and runtime version |
| `/stop` | Interrupt the active turn and stop further workflow stages |
| `/sessions` | List local records, including any damaged record errors |
| `/resume <id>` | Resume a local session against its runtime history |
| `/events [--full] [id]` | Render saved events; `--full` expands saved command output |
| `/history` | Fetch the ten most recent runtime turns, including items |
| `/memory` | Show memory configuration and the last recall's IDs, sources, reasons, and size |
| `/memory on` or `/memory off` | Enable or disable automatic recall for subsequent prompts in this session |
| `/memory list [kind]` | List this workspace's saved memories |
| `/memory search <query>` | Full-text search of current workspace memory |
| `/memory read <id>` | Display the complete Markdown source |
| `/memory add <kind> <title> :: <body>` | Explicitly save a memory without a second confirmation |
| `/memory forget <id>` | Remove its Markdown source and indexed copy |
| `/memory rebuild` | Reindex this workspace from Markdown |
| `/memory import <kind> <file>` | Explicitly copy an existing note into workspace memory |
| `/fix <task>` | Run the bounded fixture implementation/check/review workflow |
| `/tasks` | List persisted workflow record filenames |
| `/tools` | List the five workspace tools, their effects, and JSON inputs |
| `/tool <name> <JSON>` | Run a workspace tool directly; executing checks requires `--write` |
| `/approve <request-id> <number>` | Answer the current approval using its exact displayed ID |
| `/help` | Show commands and options |
| `/exit` | Shut down owned processes and close local records |

Ctrl+C first interrupts active work. Another Ctrl+C during interruption/shutdown exits. Interrupting an action does not roll back changes already made. Ordinary prompts are refused while work is active; control commands remain responsive.

CLI options:

```text
--workspace PATH      Agent working directory (default: sample fixture)
--write               Request workspace-write instead of read-only
--model NAME          Select a model available to your signed-in account
--prompt TEXT         Submit one prompt, wait, and exit
--resume LOCAL_ID     Resume rather than starting a conversation
--replay LOCAL_ID     Offline rendering of a saved trace; no Codex process
--memory COMMAND      Run one memory command offline, without Codex or sign-in
--tools               List the five workspace tools offline
--tool NAME           Run one workspace tool offline, without Codex or sign-in
--args JSON           Arguments for --tool (default: {})
--no-memory           Omit automatic workspace memory recall
--verbose             Expand command output instead of compact previews
--plain               Disable colors, Unicode decorations, and input redraw
--no-tui              Use the traditional line interface in an interactive terminal
--debug               Show additional event names and runtime stderr
--data-dir PATH       Records and memory.sqlite location (default: .harness/)
```

Choose one offline mode or a live session: `--replay`, `--memory`, `--tools`, and `--tool` are mutually exclusive and cannot be combined with live `--prompt`/`--resume`. Live resume and prompt may be combined.

Use one running harness per workspace and data directory. This learning implementation serializes memory and task updates within the parent process; simultaneous editing through multiple harness instances is outside this version.

## Terminal view

Interactive `npm start` opens a full-screen TUI. A conversation view separates your messages, streamed replies, tool activity, and results. The screen resizes with the terminal; wider windows add workspace, access, model, session, and recall information in a sidebar. The multiline composer keeps your draft while output streams or an approval is shown. `NO_COLOR` gives a monochrome TUI.

Use **Tab** for the next view and **Shift+Tab** for the previous view: Conversation, Tools, Memory, Tasks, and Sessions. Switching preserves your draft. Tab completes a partial slash command; Shift+Tab always changes views outside dialogs and forms. **Alt+1–5** can jump directly to a view when your terminal passes those shortcuts through. Tools exposes all eleven MCP tool descriptions and schemas. Memory supports browsing, searching, reading, and explicit saves. Tasks supports additions and status changes. Sessions shows conversations belonging to the selected workspace and resumes the selected conversation from its saved trace; inspecting that trace never reruns its operations.

| Key | Action |
| --- | --- |
| Enter | Send a message, or open a selected item when the composer is empty |
| Alt+Enter / Ctrl+J | Insert a newline |
| Ctrl+P | Search commands and insert one into the composer |
| Tab / Shift+Tab | Complete a slash command or go to the next view / go to the previous view |
| ↑ / ↓ | Select panel items, edit multiline drafts, or browse sent-message history |
| PgUp / PgDn | Scroll conversation or open details |
| Ctrl+Home / Ctrl+End | Jump to the beginning / follow live output |
| Ctrl+E | Expand or collapse tool output |
| Ctrl+F / Ctrl+T | Search memories / toggle recall in Memory |
| Ctrl+N | New memory, task, or conversation, depending on the view |
| Ctrl+X | Open the selected task's status form |
| Ctrl+S | Save a form; arrows change a choice, Tab moves between fields |
| Ctrl+R | Refresh the current panel |
| F1 | Keyboard help |
| Ctrl+C / Ctrl+Q | Stop active work (exit when idle) / quit |

Permission dialogs show the complete scrollable proposal and remaining approval time. Use left/right to select, Enter to confirm, or Esc to deny. Deny is the initial choice. Bracketed paste inserts text without sending messages or answering approvals. An approval must be visible before it can be answered. Forms for direct memory/task saves express your intent; agent saves retain their existing `--write` and approval checks.

The TUI uses Node's terminal APIs with no new runtime dependencies. It restores raw mode, the cursor, paste handling, and the original terminal screen on normal exit. At least 44 columns and 17 rows are needed; a larger terminal provides more reading space. Keyboard navigation is supported; mouse interaction is left to the terminal. Some terminals or editors capture Alt+number before the application receives it. Use Tab / Shift+Tab in that case; Ctrl+J also avoids relying on Alt+Enter. The decoder accepts legacy ESC-prefixed, CSI-u, and xterm modifyOtherKeys Alt+number formats.

Successful commands show four lines of output; failed commands show ten. Ctrl+E expands live output. Use `/events --full` for saved output, or start with `--verbose` to expand it by default. The in-memory display is bounded to 250 blocks / approximately 1 MiB, with 64 KiB per block; older messages remain in the event log subject to its existing storage limits. The TUI is a view of execution, not a separate conversation store.

Try the interactive UI without signing in, invoking a model, or writing files. Its forms modify sample data in RAM, and sending `approval` demonstrates the permission dialog:

```bash
npm run tui:preview
npm run tui:preview -- --snapshot --columns 112 --rows 34
```

`--no-tui` keeps the styled line interface. `--plain`, `TERM=dumb`, redirected output, one-shot prompts, and offline commands use ordinary line output. No alternate screen or raw input is enabled for these modes. The original static line-layout preview is also available:

```bash
npm run preview
npm run preview -- --plain
```

Line mode redraws the prompt while preserving partially typed input; assistant text is emitted at line and word boundaries.

## Permissions and application tools

The live client requests `on-request` approvals with human review. Effective behavior also depends on the installed runtime, managed policy, and inherited Codex configuration. A request to use read-only mode is not a new application-defined operating-system sandbox. No global Codex configuration is rewritten.

The application handles command/file decisions and additional-permission requests separately. Unknown server requests receive an error. Form/URL elicitations are declined, and unimplemented interactive agent questions receive no answers. These cases stay visible in event logs instead of leaving a turn waiting forever.

The journal tools are supplied by a local MCP server:

- `journal_read`: bounded excerpt of `notes/learning-journal.md`.
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

Within a live terminal session, use the same JSON with `/tool`, for example `/tool git_inspect {"operation":"log","limit":5}`. `/tools` describes these five tools; memory keeps its dedicated `/memory` commands. Direct user task updates need no second confirmation. Direct check execution requires `--write` and prints the resolved command before running. Agent calls retain interactive approval; noninteractive agent execution cannot approve them.

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

## Run the fixture workflow

Reset and inspect the deliberately failing example:

```bash
npm run fixture:reset
npm run fixture:check
```

The initial check is expected to fail: `sum([])` incorrectly returns `1`. Keep this failure separate from `npm run check`, which verifies the harness itself.

Start a writable fixture session:

```bash
npm start -- --write
```

Then enter:

```text
/fix Make sum return zero for an empty array and correctly sum positive and negative numbers.
```

The workflow requests implementation, independently runs the acceptance check, allows at most one repair, and requests review when the check passes. A final check runs after review. There are at most three agent turns. Any interrupted or uncertain turn stops progression. The fixture workflow refuses other workspaces.

The executable and check are selected by application code. The acceptance program is frozen before work begins, so changing `check.mjs` during a turn cannot forge a passing result. Model-provided shell text is never used to choose the check command. Individual checks have a timeout and capped output.

The result is saved to `.harness/tasks/<id>.json`, including stage, attempts, related turns, and actual check results. No workflow resumes automatically after restart. Inspect the record, runtime history, and files before deciding what to do next.

## Persistence, memory, and recovery

```text
.harness/sessions/<id>.json  Local ID → Codex thread and workspace
.harness/events/<id>.jsonl   Bounded, redacted protocol events
.harness/tasks/<id>.json     Workflow stages and check results
.harness/todos/<key>.json    Workspace task list and revision
.harness/memory.sqlite      Disposable index, scoped by canonical workspace path
<workspace>/memory/         Authoritative durable Markdown memories
notes/learning-journal.md   Legacy learning notes accessed through journal tools
```

Session IDs and thread IDs are distinct. Startup events before a session exists use a `connection-...` trace ID. `/status` shows the current trace ID. Runtime data is ignored by Git; deliberate source notes remain ordinary project files.

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

## Read the code in learning order

1. [Toy loop](examples/toy-loop.ts): actions, tool dispatch, observations, and stopping.
2. [Transport](src/transport.ts) and [RPC](src/rpc.ts): JSON framing and request correlation.
3. [Codex client](src/codex.ts): the small typed boundary with the real runtime.
4. [Session](src/session.ts) and [events](src/events.ts): state, completion, and rendering.
5. [Store](src/store.ts): atomic records and append-only event history.
6. [Approvals](src/approvals.ts): decisions, IDs, cancellation, and EOF handling.
7. [Tool registry](src/tools/registry.ts), [journal](src/tools/journal.ts), and [MCP server](src/tools/server.ts): application-owned tool execution.
   [Workspace service](src/workspace-tools/service.ts), [task store](src/workspace-tools/todos.ts), and [process runner](src/workspace-tools/process.ts) implement the five local tools behind the forwarding adapter.
8. [Memory files](src/memory/files.ts), [service](src/memory/service.ts), and [context](src/context.ts): Markdown ownership, disposable search, and bounded recall.
9. [Workflow](src/workflow.ts): deterministic transitions around real agent turns.
10. [CLI](src/cli.ts): terminal input, live execution, controls, and shutdown.

Tests cover protocol chunking, acknowledgment races, disconnects, stale approvals, write denial, symlink rejection, MCP discovery/calls, subprocess cleanup, persistence, playback, and bounded workflow behavior. Memory checks exercise restart/rebuild, external edits, workspace isolation, punctuation-safe search, recall budgets, index failure recovery, parent-owned MCP operations, and fresh-conversation context. CLI tests use a clearly synthetic runtime and do not invoke a model. Socket/process tests require a local environment that permits Unix sockets and subprocesses.

Workspace-tool tests additionally cover ignored paths, Git subtree filtering and unchanged index bytes, npm hook execution and changed definitions, task limits/revisions/atomicity, MCP cancellation, invalid credentials, missing executables, offline command execution, and direct-terminal interruption of a running check.

This is a learning implementation: sequential execution, local files with a SQLite search index, and a visible protocol boundary. Follow the milestone experiments in the plan to understand the choices and their limits.
