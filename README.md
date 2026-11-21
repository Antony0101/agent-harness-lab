# Learning Harness

Learn how a coding-agent harness works by building and inspecting one.

Learning Harness is a small TypeScript terminal app around a local Codex App Server. It owns the interface, approvals, workspace tools, memory, and workflow state. Codex supplies the real coding-agent loop and connects to OpenAI's model service.

There are two ways to explore it: an offline teaching loop with a scripted model, and a working terminal client using your own ChatGPT sign-in. This is an independent learning project, not an official OpenAI product.

## Try it without an account

You need **Node.js 22.17+ and npm**. Clone this repository, open a terminal in its root, then run:

```bash
npm ci
npm run toy
npm run tui:preview
```

`toy` demonstrates tool calls, observations, and stopping conditions. `tui:preview` opens the interface with sample data; its forms only change data in RAM. After dependency installation, neither needs Codex, sign-in, a model call, or a network connection.

In the preview, use **Tab / Shift+Tab** to switch screens, **Enter** to send a demo message, and **Ctrl+Q** to quit. Send `approval` to try the permission dialog.

## Run the real agent

The live harness is designed for Linux/macOS; use WSL2 on Windows. Native Windows is not implemented. You need a Codex CLI compatible with this client's App Server calls and a ChatGPT account with Codex access. The real model uses your account's usage limits and requires internet access. This project does not require an OpenAI API key or switch to API-key billing.

Once Codex is installed, run these from the repository root:

```bash
codex login status
# If you are not signed in with ChatGPT:
codex login

npm run protocol
npm run fixture:reset
npm start
```

The default workspace is a disposable sample project, with read-only Codex access. To work on another project, replace the path below:

```bash
npm start -- --workspace /absolute/path/to/your/project
```

Add `--write` when you want to allow agent changes. A read-only agent session still writes harness records to `.harness/`; direct memory/task commands are explicit user actions. See the [setup guide](docs/getting-started.md) for installation, runtime compatibility, and a first task.

## What you can explore

| Feature | What it teaches |
| --- | --- |
| Scripted offline loop | How decisions, tools, observations, and limits fit together |
| Full-screen terminal interface | How to display streaming work and keep controls responsive |
| Session resume and event replay | How runtime history differs from application records |
| Eleven local MCP tools | How an agent discovers tools and the application controls execution |
| Markdown + SQLite memory | How to save readable knowledge and retrieve relevant context |
| Bounded repair workflow | How independent checks drive a sequence of agent turns |

The terminal has **Conversation, Tools, Memory, Tasks, and Sessions** views. Tab moves forward; Shift+Tab moves backward. Your draft is preserved. Tab completes a partial slash command, and Shift+Tab still changes views. Alt+number also works when your terminal passes it through. Press **F1** for keyboard help.

Memory and tasks work without model calls too:

```bash
npm start -- --workspace "$PWD" --memory "add facts Learning goal :: Keep the harness small and understandable."
npm start -- --workspace "$PWD" --memory "search harness"
npm start -- --workspace "$PWD" --tool todo_list
```

These commands create local files. The separate [memory guide](docs/memory-and-storage.md) explains where they go and what can be safely rebuilt.

## Read the documentation

| I want to… | Read |
| --- | --- |
| Install and run my first task | [Getting started](docs/getting-started.md) |
| Find commands, flags, or keyboard shortcuts | [Using the harness](docs/usage.md) |
| Understand the execution loop and source files | [Architecture](docs/architecture.md) |
| Use workspace tools or add a tool | [Tools and MCP](docs/tools.md) |
| Understand saved notes, tasks, and history | [Memory and storage](docs/memory-and-storage.md) |
| Fix setup or terminal problems | [Troubleshooting](docs/troubleshooting.md) |
| Develop and verify a change | [Contributing](CONTRIBUTING.md) |
| Prepare a public repository | [Publishing notes](docs/publishing.md) |

Start at the [documentation index](docs/README.md) for a suggested reading order and short glossary. The original [learning plan](plans/learning-harness-plan.md) explains the experiments; [development notes](notes/development.md) record historical verification.

## Scope and limits

This is a personal learning implementation with one active turn and one harness process per workspace/data directory. It uses local files and SQLite, with no database server, queue, or web service to deploy. The harness borrows Codex's real agent loop; the offline toy makes the simpler loop visible.

Approval behavior also depends on Codex's effective configuration. Approved npm checks run with normal local-process permissions; a working directory is not an operating-system sandbox. Recalled notes and tool results become model input during live tasks. Keep private content out of shared logs and public memory files. See [permissions](docs/tools.md#permissions-and-application-tools) and [storage](docs/memory-and-storage.md).

## License

Copyright (C) 2026 Learning Harness contributors.

Learning Harness is free software licensed under the GNU General Public License, either version 3 or, at your option, any later version published by the Free Software Foundation (**GPL-3.0-or-later**). See [LICENSE](LICENSE) for the complete terms.

The software is provided without warranty. Third-party dependencies retain their own license notices. The repository's `private: true` npm setting prevents npm publication; it does not prevent making the Git repository public.
