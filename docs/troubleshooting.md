# Troubleshooting

[Documentation](README.md) · [Project home](../README.md)

## I only want to see the interface

From the repository root:

```bash
npm ci
npm run tui:preview
```

This is a demo with sample data, not a live agent. A demo reply does not mean your Codex connection is working. To use the real agent, complete [live setup](getting-started.md#3-set-up-live-codex-access) and run `npm start`.

## Codex executable not found or `spawn codex ENOENT`

The runtime is separate from this npm project. Install it using the [official CLI guide](https://learn.chatgpt.com/docs/codex/cli), or select an existing executable:

```bash
export CODEX_BIN="/absolute/path/to/codex"
npm run protocol
npm start
```

An invalid `CODEX_BIN` takes precedence over automatic discovery. Run `unset CODEX_BIN` to let the harness search `PATH` and VS Code/WSL extension directories. Extension updates can move the executable.

## Run protocol generation / runtime version mismatch

```bash
npm run protocol
```

Run generation and startup with the same `CODEX_BIN`/`PATH`. Generated bindings belong to the selected executable's version. If typechecking then reports changed App Server fields, that runtime may need client changes; matching a version marker is not a guarantee of API compatibility. See the last verified runtime in [development notes](../notes/development.md).

## Typechecking cannot find `generated/codex/...`

`generated/` is ignored by Git. It is absent in a fresh clone until you run `npm run protocol` with a compatible Codex CLI. The full tests also need the runtime-version marker. Offline toy and preview commands do not need these files.

## SQLite module or feature errors

Check `node --version`. The declared minimum is Node 22.17, and the memory service needs built-in `node:sqlite` with FTS5. Node 22.17's experimental SQLite warning is expected. SQLite runs inside Node; there is no database server to start.

## ChatGPT sign-in required

Check `codex login status` and run `codex login` if needed, choosing ChatGPT sign-in. API-key sign-in is not accepted by this client. The [official authentication guide](https://learn.chatgpt.com/docs/auth) explains the available Codex authentication methods; this project deliberately uses the ChatGPT path.

## Account usage limit or disconnected turn

Offline demos and local tools remain available. A live task needs account access and an available usage allowance. The harness does not automatically purchase API credits or switch authentication methods.

After a disconnect or lost acknowledgment, inspect `/status`, saved events, runtime history, and the workspace before retrying. Restart and explicitly resume with the local session ID. A task may have changed files before the connection was lost. Stop, failure, and interruption do not imply rollback.

## Alt+number does not switch tabs

Some terminals or editors capture Alt shortcuts. Use **Tab** for the next view and **Shift+Tab** for the previous view. Your draft is preserved. Tab completes a partial slash command; Shift+Tab still changes views. Inside a form, these keys move between fields instead.

Restart the running TUI after updating its code. `npm start` does not hot-reload. Use Ctrl+J for a newline if Alt+Enter is also intercepted.

## No full-screen TUI appears

Both input and output must be interactive terminals. `--plain`, `--no-tui`, `TERM=dumb`, one-shot prompts, offline operations, and redirected input/output use line mode. Resize to at least 44 columns by 17 rows. Wider windows add the context sidebar.

If a process is forcibly killed before it restores the terminal, run `reset` from your shell. Normal exit through Ctrl+Q restores the previous screen, cursor, and input mode.

## My message is refused while the agent works

Only one turn runs at a time. Keep the draft or press Ctrl+C to interrupt. `/stop`, `/status`, and other control commands remain available. A pending approval uses its own controls; Enter confirms the selected response and the initial response is Deny.

## A tool is unavailable or an operation is denied

`workspace_search` needs local `rg`; `git_inspect` needs Git and a Git workspace; `project_check` needs npm and a permitted script in that workspace's `package.json`. A missing executable affects its tool, not the offline toy or task storage.

Agent writes and check execution require `--write`, an active turn, and an interactive approval. A one-shot or piped-input agent cannot approve them. Direct memory/task commands express user intent; direct check execution still requires `--write`. An empty `project_check` call only lists available scripts. See [tool permissions](tools.md#permissions-and-application-tools).

If the MCP bridge is missing, authenticated parent operations fail closed. Start them through the harness instead of launching a standalone tool server and expecting it to grant writes.

## A task update reports a stale revision

List tasks again with `todo_list` or refresh the Tasks view, then submit the intended update against that revision. Invalid batches do not partially apply. Corrupted task files are preserved and reported; the harness does not silently reset them.

## A saved memory is not recalled

Confirm the selected workspace, `/memory on`, and the kind/path of the note. Recall selects a bounded set of relevant notes, not every saved file. `/memory search <query>` checks retrieval and `/memory` explains the last selection.

If the message says “Markdown saved; index needs repair,” preserve the Markdown and run `/memory rebuild` or the offline equivalent:

```bash
npm start -- --workspace /absolute/path/to/your/project --memory "rebuild"
```

Search does not use a known-stale index after synchronization fails. See [memory recovery](memory-and-storage.md#workspace-memory) for file-size, symlink, and rebuild rules.

## The fixture check fails

Immediately after `npm run fixture:reset`, failure is intentional. The exercise starts with a buggy sum implementation. `npm run check` verifies the harness and is a different command. A missing `sum.mjs` means the fixture has not been reset yet.

## Local tests fail on socket or process creation

The suite needs a machine that permits Unix sockets and child processes. A restricted execution environment can block those operations before the code under test runs. Run the deterministic checks in a suitable local development environment; no model connection is needed.
