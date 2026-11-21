# Contributing

Small, understandable changes suit this project's purpose: learning how an agent harness works. Keep the code and examples easy to trace, and explain the behavior a change adds or fixes.

## Set up a development checkout

Use Node.js 22.17+ on Linux/macOS or inside WSL2. Install `git`, `rg` (ripgrep), and a compatible Codex CLI. Follow [Getting started](docs/getting-started.md) for runtime discovery and installation.

From the repository root:

```bash
npm ci
npm run protocol
npm run fixture:reset
npm run check
```

`generated/` and the disposable `fixtures/sample-project/sum.mjs` are deliberately not committed. A fresh clone needs both preparation commands before the full development check. Protocol generation runs a local Codex schema command; it does not call a model or require ChatGPT sign-in. It does require a compatible executable. Regenerate when changing runtime versions.

The tests use synthetic runtime responses, temporary files, Unix sockets, and local subprocesses. They do not make model calls or consume API credits. The environment must permit local sockets and child processes. The historical test environment and actual live-test limits are recorded in [development notes](notes/development.md).

To explore the toy or preview only, `npm ci` is enough; neither needs generated types. See the [offline setup path](docs/getting-started.md#2-explore-without-codex).

## Verify the change

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check TypeScript, including generated protocol imports |
| `npm test` | Run deterministic tests without model calls |
| `npm run check` | Run both of the above |
| `npm run tui:preview` | Manually exercise terminal layout and interactions |
| `npm run tui:preview -- --snapshot` | Print a plain, noninteractive UI frame |
| `git diff --check` | Catch whitespace errors |

`npm run fixture:check` checks the intentionally buggy exercise, not the harness. It should fail immediately after reset and pass only after the sample implementation is repaired.

For code changes, run checks relevant to the behavior and add regression coverage where it protects an important boundary. For documentation changes, verify commands and links. Do not run live model experiments as part of ordinary tests.

## Find the right module

Start with the [architecture map](docs/architecture.md). Input and rendering belong in `src/tui/`; business operations belong in the parent services. The terminal preview should remain usable without a Codex process or filesystem writes.

When adding a tool, keep its schema, operation allowlist, parent validation, permissions, cancellation, and bounded output consistent. The MCP adapter forwards requests; it must not invent a workspace or trust an agent-supplied authorization origin. Read [Tools and MCP](docs/tools.md) and the existing tests before changing that boundary.

Memory Markdown remains authoritative. Session/workflow logs, workspace to-dos, and durable memory serve different purposes. Document any storage-format change and how existing records are handled.

## Report a problem or propose a change

Include the expected behavior, observed behavior, reproduction steps, operating system, Node version, and relevant command. For runtime issues, include the Codex version and whether the problem occurs with the offline preview or synthetic tests.

Share only the relevant, reviewed output. Prompts, traces, Markdown memories, and screenshots can contain private project information. Do not post credentials or unreviewed event logs. Keep an issue or pull request focused on one problem and explain how it was verified.

This repository is currently distributed as source for local use. `private: true` in `package.json` prevents accidental npm publication and can remain set when the Git repository is public.
