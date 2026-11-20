# Project decisions

- This is a personal learning harness using a local Codex process and ChatGPT subscription sign-in.
- Persist session/workflow records as JSON and events as JSONL. Durable memory lives in workspace Markdown with a disposable SQLite FTS5 search index; no database or queue service is required.
- Save memory explicitly through terminal commands or approved agent tools. Automatically recall relevant workspace notes within a 6,000-character budget.
- Keep this legacy note available for explicit import; it is no longer automatically supplied to tasks.
- The sample project's sum function must return zero for an empty array.
- The application verifies code with a fixed check; an agent's success message is not verification.
