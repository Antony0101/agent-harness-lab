# Using the harness

[Documentation](README.md) · [Project home](../README.md)

The live harness opens a full-screen interface in an interactive terminal. For a traditional prompt, use `npm start -- --no-tui`. CLI options start with `--` and go after `npm start --`; slash commands are typed inside the running app.

The **Tasks view** manages workspace to-dos. The `/tasks` command instead lists records from the fixture workflow. They are separate stores.

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
| `/sessions` | Open workspace sessions in the TUI; line mode lists local records and damaged-record errors |
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
| `/tools` | Open all eleven tools in the TUI; line mode lists the five direct workspace tools |
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
--help                Show commands/options and exit without connecting to Codex
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

Successful commands show four lines of output; failed commands show ten. Ctrl+E expands live output. Use `/events --full` for saved output, or start with `--verbose` to expand it by default. The in-memory display is bounded to 250 blocks and 1,048,576 text characters in total, with 65,536 characters per block; older messages remain in the event log subject to its existing storage limits. These are character limits, not byte or token counts. The TUI is a view of execution, not a separate conversation store.

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
