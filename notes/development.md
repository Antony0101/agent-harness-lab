# Development baseline

Implemented on November 18, 2026 with Node.js `v22.17.0`, npm `10.9.2`, and Codex CLI `0.162.0-alpha.17.2`.

The available Codex executable came from an editor extension. Startup and protocol generation now discover compatible VS Code/WSL extension binaries when Codex is absent from PATH. Use `CODEX_BIN` to choose a specific executable. Matching generated protocol bindings and their version marker live in ignored `generated/`; recreate them with `npm run protocol`.

## Implementation and verification

- All eleven planned milestones have application code or an offline teaching exercise.
- TypeScript type checking passes.
- All 49 deterministic tests pass, covering runtime discovery, terminal rendering, CLI start/resume/replay/stop against a fake runtime, real local MCP stdio calls, private-socket write approval, and the complete offline fixture workflow.
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
