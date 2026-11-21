# Documentation

[Project home](../README.md)

## Start with what you want to do

- **Try the idea:** follow the offline path in [Getting started](getting-started.md). No Codex account is needed.
- **Use the agent:** complete live setup, then read [Using the harness](usage.md).
- **Understand the code:** read [Architecture](architecture.md), then follow its source-reading order.
- **Change the project:** read [Contributing](../CONTRIBUTING.md) and the guide for the feature you are changing.

## Guides

| Guide | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Requirements, installation, offline examples, live setup, and fixture exercise |
| [Using the harness](usage.md) | Daily workflow, slash commands, CLI options, terminal views, and shortcuts |
| [Architecture](architecture.md) | Responsibilities, process boundaries, execution flow, and a source map |
| [Tools and MCP](tools.md) | Tool interfaces, permissions, npm checks, and revisioned task updates |
| [Memory and storage](memory-and-storage.md) | Markdown, SQLite, recall, sessions, logs, and recovery |
| [Troubleshooting](troubleshooting.md) | Common errors and specific recovery steps |
| [Publishing notes](publishing.md) | Local-data boundaries, license choice, and verification before sharing |

## Vocabulary

| Term | Meaning here |
| --- | --- |
| Harness | The application around the agent: its UI, state, tools, permissions, and workflows |
| Workspace | The directory selected with `--workspace`; the agent's project and memory boundary |
| Thread | Codex's saved conversation, identified by a runtime thread ID |
| Turn | One submitted task and the work it starts, ending in completion, failure, or interruption |
| Session | This harness's local record pointing to a thread and workspace |
| MCP | Model Context Protocol: a common interface for discovering and calling tools |
| Durable memory | Explicitly saved Markdown notes, searchable through a rebuildable SQLite index |
| Workflow | Application code coordinating turns and independent checks; separate from the to-do list |

## Design history

The [learning plan](../plans/learning-harness-plan.md) and [local-tools plan](../plans/local-tools-plan.md) explain implementation milestones. [Development notes](../notes/development.md) are a dated record of experiments, not the current installation guide.
