# Local tools for the learning harness

Status: implemented November 19, 2026. See [Tools and MCP](../docs/tools.md#local-workspace-tools) for executable examples and [development notes](../notes/development.md) for verification.

## Approved design

Add `workspace_search`, `git_inspect`, `project_check`, `todo_list`, and `todo_update` to the existing MCP server, retaining journal and memory tools. The parent owns execution, canonical workspace boundaries, authorization, and cancellation. The MCP child forwards operations over the authenticated local socket. Direct terminal and offline CLI access use the same handlers.

Use local `rg`, `git`, and npm executables with existing npm dependencies. Search is literal and bounded, respects ignore rules, and rejects hidden or escaping paths and symlinks. Git supports fixed status/diff/log operations restricted to the workspace, including subdirectories of larger repositories, without modifying the index or invoking external diff helpers.

Checks discover existing `test`, `typecheck`, `lint`, and `check` npm scripts. Empty calls list them; execution shows the command, workspace, script, and pre/post hooks. Revalidate definitions after approval. Permit one running check, with a sixty-second timeout and bounded output. Search/Git use ten-second deadlines. The local bridge deadline is 195 seconds and the runtime MCP deadline is 200 seconds.

Store tasks in `<data-dir>/todos/<workspace-key>.json`, separate from memory and workflow state. A schema version, canonical workspace, revision, UUID task IDs, titles, statuses, and timestamps provide a small inspectable format. Task statuses are pending, in progress, or completed. Batch add/edit/remove operations require a current revision and atomic file replacement. Preserve invalid files; reject partial batches, stale revisions, and external changes during approval. Limits are 200 characters per title, twenty changes per batch, and one hundred tasks.

Agent task updates and check execution require `--write`, an active turn, and interactive approval of the entire proposal. Direct terminal task updates express user intent without a second confirmation. Direct check execution additionally requires `--write`. An approved npm script runs with ordinary local-process permissions.

Expose `/tools`, `/tool <name> <JSON>`, offline `--tools`, and `--tool NAME --args JSON` before Codex discovery. Conflicting offline/live modes fail before process startup. Results remain valid JSON and report truncation. Reuse bounded event storage and rendering. Cancellation from the terminal, MCP request/socket, turn completion, or shutdown must stop pending approval or execution and terminate owned subprocess groups.

## Implementation sequence

1. Shared path validation and bounded subprocess execution.
2. Workspace search and Git inspection.
3. Revisioned JSON task storage and atomic batches.
4. npm script discovery, approval, revalidation, and execution.
5. Parent dispatcher, MCP adapters, terminal commands, and lifecycle cancellation.
6. Documentation and offline acceptance verification.

## Acceptance

Tests cover literal search and exclusions; Git scope and unchanged repository state; permitted npm scripts, hooks, failures and cancellation; task restart/isolation/revisions/atomicity; denied operations without effects; authenticated parent forwarding and eleven-tool discovery; offline CLI with nonexistent Codex; and bounded valid JSON. The complete existing suite must remain passing. Verification uses synthetic local fixtures, without model calls or network services.
