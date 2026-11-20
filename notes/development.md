# Development baseline

Implemented on November 18, 2026 with Node.js `v22.17.0`, npm `10.9.2`, and Codex CLI `0.162.0-alpha.17.2`.

The available Codex executable came from an editor extension. Startup and protocol generation now discover compatible VS Code/WSL extension binaries when Codex is absent from PATH. Use `CODEX_BIN` to choose a specific executable. Matching generated protocol bindings and their version marker live in ignored `generated/`; recreate them with `npm run protocol`.

## Implementation and verification

- All eleven planned milestones have application code or an offline teaching exercise.
- TypeScript type checking passes.
- The original 49 deterministic tests passed, covering runtime discovery, terminal rendering, CLI start/resume/replay/stop against a fake runtime, real local MCP stdio calls, private-socket write approval, and the complete offline fixture workflow. Current memory verification is recorded below.
- A real read-only Codex turn completed using the existing ChatGPT sign-in. Its prompt requested only a fixed acknowledgment, with project memory disabled.
- A second process resumed that real conversation and completed a live `learning_journal.journal_search` call, returning the seeded codename Paper Kite. The user explicitly approved this test.
- A live writable workflow repaired the disposable sum implementation and ran its check successfully. Before the first agent turn completed, the runtime returned `usageLimitExceeded` with “Your workspace is out of credits.” The harness recorded an uncertain workflow outcome and stopped before scheduling further turns.
- An independent local check confirmed the repaired implementation passed. The fixture was then reset to its deliberately failing starting state for the learning exercise.
- The complete real-model implementation/review workflow and live human approval interaction remain unverified. Their component and integration paths are exercised with synthetic/local tests. No further model calls were attempted after the usage-limit response.

The normal execution sandbox disallowed Unix socket listeners and spawning the editor-provided Codex binary from Node. Deterministic socket/subprocess checks and the real acknowledgment smoke test passed outside that sandbox. The dependency download also required network access. These are restrictions of the execution environment, not requirements to deploy any service.

Automatic approval review initially blocked the live journal smoke test because it would transmit journal content to Codex. After explicit user approval, the live read-only test ran successfully. Local tool tests use temporary synthetic journals and do not contact an external service.

## First journal exercise

Expected: the scripted model requests a note, receives an observation, and returns a final answer.

Observed: success uses two decisions, invalid arguments become an error observation, and an endlessly repeating script stops after five iterations. Tool validation and permission decisions belong to the harness; there is no model inference in this exercise.

Next experiment: run the read-only client, inspect the trace with `/events`, and identify request acknowledgment, turn start, message items, and terminal completion.

## Terminal presentation

The default view now uses a compact banner, distinct assistant and tool sections, command previews, status colors, and elapsed times. Successful output is limited to four preview rows and failed output to ten. `/events --full`, `--verbose`, `--plain`, and the offline `npm run preview` are documented in the README. Command and model output is sanitized before styling. Approval operations remain fully visible, and streamed text is flushed when a turn is interrupted.

Interactive prompt redraw was checked against the fake runtime, including typing part of a command while a turn was running. No external model calls were needed for the presentation work.

## Markdown and SQLite memory

Added November 19, 2026. The minimum Node version is now 22.17.0, matching the verified built-in `node:sqlite` runtime and FTS5 support. No new package, database service, embeddings, or API credentials are needed. Node 22.17 emits its normal SQLite experimental-feature warning.

Markdown under the selected workspace's `memory/<kind>/` folders owns durable content. The parent process synchronizes a disposable `<data-dir>/memory.sqlite` index and filters every query by canonical workspace identity. The MCP subprocess proxies memory operations through the existing authenticated Unix socket. Session, workflow, and event storage retain their original JSON/JSONL formats. The old global project note is available for explicit import and is no longer automatically recalled.

Offline acceptance checks cover restart and deleted-index rebuild, damaged-database recovery, manual Markdown, content-hash refresh despite restored modification time, rename/delete, canonical-path isolation, punctuation-safe FTS, limits and recall budgets, explicit import/forget, symlink/oversized/nonregular rejection, and recovery after a simulated post-file indexing failure. Denied saves leave the Markdown and database unchanged. Session tests inspect the actual submitted fake-runtime prompt in a fresh conversation and exercise writable/interactive/active-turn approval gates. A real local MCP subprocess tests parent-owned search/read/save and complete Markdown reads. `--memory` CLI commands also run with an intentionally nonexistent Codex executable.

Memory baseline verification passed TypeScript checking and all **68 deterministic tests**. `git diff --check` also passed. No model calls were made for memory implementation or verification. These tests demonstrate local storage and context composition; model behavior on recalled content remains a live learning exercise.

## Local workspace tools

Added November 19, 2026. The MCP server now exposes eleven tools, including five parent-owned workspace tools. Search uses local ripgrep, Git inspection uses fixed local Git operations, checks discover named npm scripts, and tasks use revisioned JSON under the data directory. New tools require no additional npm package or external service. The existing memory/journal handlers remain available.

Handlers validate paths and inputs at the parent boundary. Agent checks and task updates use active-turn interactive approval; direct terminal operations express user intent, with `--write` additionally required for check execution. The process runner is shared with the existing fixture workflow, retaining its frozen acceptance program. Cancellation propagates through MCP requests/sockets, session completion, `/stop`, Ctrl+C, and shutdown. Complete results are bounded before transport, and errors remain valid JSON.

Local checks cover ignore rules and excluded paths, literal punctuation, symlinks/traversal, Git subtree scope and unchanged index bytes, external Git helper suppression, npm hooks and approval-time definition changes, task restart/canonical identity/isolation, revision and batch atomicity, denied saves without task files, corrupted-file preservation, missing executables, authenticated MCP forwarding, request cancellation, and offline CLI execution with a nonexistent Codex executable. A synthetic live-terminal test starts an actual npm subprocess and interrupts it through `/stop`. No model calls were made.

Final verification: `npm run check` passes TypeScript checking and all **88 deterministic tests**. Descendant cleanup is tested with a child process that ignores SIGTERM, and offline trace playback renders saved local-tool outcomes without executing tools. `git diff --check` passes. Real-model tool selection remains a live learning exercise; local execution, authorization, and transport paths are verified offline.

## Full-screen terminal interface

Interactive live sessions now default to an alternate-screen TUI, built with Node's existing terminal and stream APIs. No UI framework or npm dependency was added. `src/tui/` separates Unicode text editing, input decoding, screen state, rendering, terminal lifecycle, the existing output adapter, and tool metadata. EventRenderer can forward structured notifications directly into the screen state; the existing line renderer remains available with `--no-tui`, `--plain`, piped input/output, and offline/one-shot modes.

The five views cover conversation, all eleven tools, workspace memories, revisioned tasks, and workspace sessions. A persistent multiline composer, slash completion, command palette, scroll/follow controls, expandable activity, contextual shortcuts, and explicit save forms provide the interaction layer. The UI calls the existing parent-owned services; no authorization origin comes from agent input. Memory/task forms express direct user intent. Agent actions continue through existing write, active-turn, and approval gates. Saved traces hydrate resumed conversations without executing historical requests.

Approval dialogs show complete scrollable details, default to denial, display the actual deadline, and require the currently displayed request before accepting input. Replacing a prompt, including one with a reused ID, invalidates the previous display. Dismissed dialogs cannot turn a queued Enter into a draft submission. Bracketed paste never submits or approves, and a terminal below 44 × 17 blocks hidden interactions. Normal exit and handled input/render errors restore raw mode, cursor visibility, bracketed paste, line wrapping, and the original screen. Display history is bounded independently of the existing event log.

`npm run tui:preview` provides an interactive, in-memory-only demo; `--snapshot` prints a plain frame for inspection. `npm run check` passes typechecking and **105 deterministic tests**, including 17 focused TUI tests. An additional real pseudo-terminal check against the fake Codex executable verified synthetic turns, pasted approval text, denial, task persistence, Markdown saves, resize, interruption, new/resume, hidden-dialog protection, and terminal restoration. The fake runtime now uses distinct IDs for successive turns. Verification made no model calls. `git diff --check` passes.

### Navigation compatibility

November 20, 2026: Alt+number navigation originally recognized only ESC-prefixed digits. It now also accepts CSI-u press events and xterm modifyOtherKeys encodings. Complete unsupported CSI events, including key releases, are consumed without leaking their parameters into drafts. A terminal/editor may capture Alt shortcuts before the harness receives them, so visible hints and the offline demo now lead with Tab / Shift+Tab navigation. Tab completes slash commands when applicable; Shift+Tab changes views while preserving any draft. Forms and permission dialogs keep their own input handling.

`npm run check` passes typechecking and all **108 tests**, including raw-input navigation across encodings, fragmented unsupported events, draft preservation, completion, and modal boundaries. Interactive preview checks exercised Tab, Shift+Tab, and CSI-u navigation in a real pseudo-terminal. No model calls were made.
