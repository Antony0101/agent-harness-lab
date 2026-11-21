# Getting started

[Documentation](README.md) · [Project home](../README.md)

## Requirements

| Component | Needed for |
| --- | --- |
| Node.js 22.17+ and npm | All examples; this version includes the SQLite features used here |
| Linux/macOS, or a Linux environment in WSL2 | The complete harness, which uses Unix sockets and process groups |
| Codex CLI with compatible App Server support | Live execution and generation of TypeScript protocol bindings |
| ChatGPT sign-in with Codex access, and internet | Live model tasks |
| `git` and `rg` (ripgrep) on `PATH` | Git inspection and workspace search |

The commands below run from the repository root. The project was verified with Node 22.17.0 and an editor-bundled Codex 0.162.0-alpha.17.2; see the [dated record](../notes/development.md). Other Codex versions may need client changes as well as regenerated bindings. No specific npm release is pinned by this repository.

## 1. Install dependencies

Clone the repository and change into its directory, then:

```bash
node --version
npm ci
```

Dependency installation downloads npm packages. Once installed, the offline examples use only local processes and files. There is no database service, Redis, or API key to configure. Node 22.17 may print an experimental SQLite warning.

## 2. Explore without Codex

```bash
npm run toy
npm run tui:preview
```

The toy loop uses a scripted model substitute. Expect a tool call, an observation, and a final answer. The UI preview uses sample data; it never starts Codex or saves files. Use Tab / Shift+Tab to move between views and Ctrl+Q to leave.

Try the toy's failure paths individually:

```bash
npm run toy -- invalid
npm run toy -- unknown
npm run toy -- denied
npm run toy -- error
npm run toy -- limit
```

The `limit` example intentionally repeats until the five-iteration cap. To inspect the UI in a noninteractive terminal:

```bash
npm run tui:preview -- --snapshot --columns 112 --rows 34
```

You can stop here. Neither protocol generation nor sign-in is needed for these demos. The full development check has separate prerequisites in [Contributing](../CONTRIBUTING.md).

## 3. Set up live Codex access

If Codex is not installed, follow the [official installation guide](https://learn.chatgpt.com/docs/codex/cli). Its npm installation option is:

```bash
npm install -g @openai/codex
```

Check your sign-in and use the ChatGPT flow if needed:

```bash
codex login status
codex login
```

Skip the second command when you are already signed in with ChatGPT. This harness accepts ChatGPT authentication and does not select API-key billing. Account eligibility and usage limits still apply. See the [official authentication guide](https://learn.chatgpt.com/docs/auth).

The harness discovers Codex using `CODEX_BIN`, then `PATH`, then compatible binaries inside VS Code/WSL extension directories. A working editor-provided binary does not need a second installation. To choose a particular executable:

```bash
export CODEX_BIN="/absolute/path/to/codex"
```

An invalid explicit override stops discovery. Run `unset CODEX_BIN` to restore the default search.

## 4. Generate protocol types and prepare the sample

```bash
npm run protocol
npm run fixture:reset
```

Protocol generation invokes your local executable's schema generator; it does not submit a model task. It creates ignored files under `generated/` and records the runtime version. Startup compares the version marker with the selected executable. Regenerate after changing Codex versions. The [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes this version-specific generation.

Reset creates `fixtures/sample-project/sum.mjs` from a deliberately buggy template. The file is ignored by Git because it is a disposable exercise. To observe its starting failure:

```bash
npm run fixture:check
```

**That check is expected to fail:** `sum([])` returns `1` instead of `0`. It is separate from `npm run check`, which verifies the harness.

## 5. Run a first task

```bash
npm start
```

This opens the TUI against the sample workspace in read-only Codex mode. Ask:

```text
Inspect sum.mjs and check.mjs. Explain the failing assertion without editing files.
```

Use Tab / Shift+Tab to change views. Enter sends a message, Ctrl+J inserts a newline, and Ctrl+Q exits. Ctrl+C interrupts active work first. Harness records are saved locally even when agent access is read-only.

For a single task without the TUI:

```bash
npm start -- --prompt "Explain what an agent turn is" --no-memory
```

One-shot and piped-input sessions decline agent approval requests automatically.

## 6. Choose your own workspace

```bash
npm start -- --workspace /absolute/path/to/your/project
```

Add `--write` when you want to allow agent edits:

```bash
npm start -- --workspace /absolute/path/to/your/project --write
```

Workspace memory follows the chosen directory. The default `.harness/` data directory stays in the harness repository unless you set `--data-dir`. Use one harness process per workspace/data directory. Read the [permissions guide](tools.md#permissions-and-application-tools) before running checks or approving writes.

## Optional: run the fixture workflow

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
