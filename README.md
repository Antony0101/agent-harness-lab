# Learning Harness

A small TypeScript terminal harness built to make agent execution inspectable. It uses a local Codex App Server with ChatGPT subscription sign-in. The offline toy loop runs without Codex or a network connection.

The application owns its terminal, workflow transitions, project notes, journal tools, approval UI, and JSON records. Codex owns the real model/tool execution loop. The implementation follows [the learning plan](plans/learning-harness-plan.md).

## Get started

Requirements: Node.js 22 or newer, npm, and a working Codex CLI for the live exercises. The tested runtime is recorded in [the development notes](notes/development.md).

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

Journal tool results and selected project notes become model input. Keep the initial seeded notes for experiments; consider what you include before replacing them with personal content.

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
| `/memory` | Show the selected project note, size, and truncation status |
| `/memory on` or `/memory off` | Enable or disable note inclusion for subsequent prompts |
| `/fix <task>` | Run the bounded fixture implementation/check/review workflow |
| `/tasks` | List persisted workflow record filenames |
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
--no-memory           Omit selected project notes
--verbose             Expand command output instead of compact previews
--plain               Disable colors, Unicode decorations, and input redraw
--debug               Show additional event names and runtime stderr
--data-dir PATH       Application record location (default: .harness/)
```

Use one running harness per data directory. This learning implementation serializes writes within one process; it does not implement cross-process locking.

## Terminal view

The terminal separates assistant messages, commands, tools, and turn results. Colors are enabled in a terminal unless `NO_COLOR` is set or `TERM=dumb`. Redirected output contains no color escapes. Long lines wrap to the terminal width, and elapsed times appear beside command and turn results.

Successful commands show four lines of output; failed commands show ten. This keeps documentation and file reads from flooding the conversation. Use `/events --full` to expand saved output, or start with `--verbose` to display full live command output. Saved logs still have the storage limits described below. Approval panels show the full operation details before a decision.

Preview the layout without signing in, invoking a model, or changing files:

```bash
npm run preview
npm run preview -- --plain
```

While output arrives, the interactive prompt is redrawn with the partially typed input preserved. Assistant text is emitted at line and word boundaries so the prompt cannot split a streamed word.

## Permissions and journal tools

The live client requests `on-request` approvals with human review. Effective behavior also depends on the installed runtime, managed policy, and inherited Codex configuration. A request to use read-only mode is not a new application-defined operating-system sandbox. No global Codex configuration is rewritten.

The application handles command/file decisions and additional-permission requests separately. Unknown server requests receive an error. Form/URL elicitations are declined, and unimplemented interactive agent questions receive no answers. These cases stay visible in event logs instead of leaving a turn waiting forever.

The journal tools are supplied by a local MCP server:

- `journal_read`: bounded excerpt of `notes/learning-journal.md`.
- `journal_search`: case-insensitive literal search, with bounded results.
- `journal_append`: short append that needs application approval.

Tool handlers validate arguments and use a fixed journal path. They reject symlink targets and nonregular files. A private Unix socket connects an append request back to the terminal application. The handler writes only after that application decision. `--write`, an active turn, and an interactive approval are required; a standalone tool server without the bridge denies appends.

The Unix socket makes this version suitable for Linux/macOS. Windows named-pipe support is not implemented. The application itself uses the official [App Server protocol](https://learn.chatgpt.com/docs/app-server), and the tool server uses [MCP](https://learn.chatgpt.com/docs/extend/mcp). Inherited MCP servers or plugins may also appear in your runtime; use debug output to understand what was loaded.

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
notes/project-decisions.md  Explicit cross-conversation reference data
notes/learning-journal.md   Learning notes accessed through custom tools
```

Session IDs and thread IDs are distinct. Startup events before a session exists use a `connection-...` trace ID. `/status` shows the current trace ID. Runtime data is ignored by Git; deliberate source notes remain ordinary project files.

Our event logs help inspect execution. They are not Codex's complete conversation store or an exact backup of model context. Credential-named fields are redacted, large text is truncated, and damaged lines are reported on reading. Logs can still contain code, prompts, and tool output.

Project memory is the first 6,000 characters of `notes/project-decisions.md`, with its source and size shown at submission. It is labeled as reference data. There is no embedding service, automatic summarizer, or invisible memory write.

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
8. [Context](src/context.ts): explicit bounded project notes.
9. [Workflow](src/workflow.ts): deterministic transitions around real agent turns.
10. [CLI](src/cli.ts): terminal input, live execution, controls, and shutdown.

Tests cover protocol chunking, acknowledgment races, disconnects, stale approvals, write denial, symlink rejection, MCP discovery/calls, subprocess cleanup, persistence, playback, and bounded workflow behavior. CLI tests use a clearly synthetic runtime and do not invoke a model. Socket/process tests require a local environment that permits Unix sockets and subprocesses.

This is a learning implementation: sequential execution, file storage, and a visible protocol boundary. Follow the milestone experiments in the plan to understand the choices and their limits.
