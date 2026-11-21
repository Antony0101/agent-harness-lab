# Documentation review

Reviewed November 21, 2026, before the planned public release.

## What changed

The original README held setup, operation, implementation details, and storage rules in one long page. The replacement introduces the learning goal, gives an account-free quick start, separates live setup, and links to focused guides. A documentation index offers reading paths and a glossary. The architecture guide maps process boundaries and source files; other guides cover commands, tools, memory, troubleshooting, and publishing. Contributing instructions explain the development prerequisites.

The review corrected the TUI/line-mode differences for `/tools` and `/sessions`, distinguished workspace to-dos from workflow records, documented the intentionally failing fixture, and explained that full development checks require generated protocol files even though the offline demos do not. Historical development notes are explicitly marked as a dated record.

Codex installation, authentication, and version-specific schema generation were checked against the [official CLI guide](https://learn.chatgpt.com/docs/codex/cli), [authentication guide](https://learn.chatgpt.com/docs/auth), and [App Server guide](https://learn.chatgpt.com/docs/app-server). This checks documentation, not compatibility with every newer Codex release. The last verified runtime remains recorded in the development notes.

## Local data and repository checks

- No default runtime data, generated bindings, dependencies, or credential-file paths were tracked.
- A limited pattern scan of 70 tracked files and 93 reachable Git blob versions found no matches for private keys, OpenAI/GitHub/AWS key formats, or JWT-shaped values. This is not a comprehensive security audit or a guarantee that all sensitive information is absent; ignored files, remote repositories, and unreachable history were outside that scan.
- The seeded journal contains generic learning notes and the fictional codename Paper Kite.
- Added ignore rules for root/sample-workspace memory, `.env` variants, and common local artifacts. Source files under `src/memory/`, documentation, and `.env.example` remain available to Git. A custom data directory or another workspace still needs its own ignore rules.

## Verification

Relative file links and heading anchors were checked across the README, guides, plans, and notes. `git diff --check` and `npm run check` passed, including TypeScript and all 108 deterministic tests. Documented offline commands were exercised in a temporary export with no `generated/`, `.harness/`, or sample sum implementation:

- Toy loop, plain TUI snapshot, and CLI help.
- Tool discovery and workspace task listing.
- Explicit memory save and search with an intentionally nonexistent `CODEX_BIN`.
- Fixture reset followed by the expected failing acceptance check.

The export reused the checkout's installed `node_modules`; dependency download/install was not repeated. The original workspace's sample implementation and local data were not reset. No model tasks or sign-in changes were performed.

## License decision

The owner selected **GPL-3.0-or-later** on November 21, 2026. Added the complete, unmodified GNU GPL version 3 text from the system's standard license copy at `/usr/share/common-licenses/GPL-3`, declared the “or later” grant in the README, and set the SPDX identifier in both package manifests. The publishing guide now reflects that choice. No remote configuration, push, or repository visibility change was performed.
