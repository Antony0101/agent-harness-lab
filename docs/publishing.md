# Publishing notes

[Documentation](README.md) · [Project home](../README.md)

Making the Git repository public shares source and its Git history. Running the application still uses each user's own local records and Codex sign-in. There is no shared account or hosted backend to deploy.

## Decide what belongs in the repository

| Content | Treatment |
| --- | --- |
| Source, tests, lockfile, guides, plans | Commit as project material |
| `notes/` | Tracked example/development notes; review edits before sharing |
| `.harness/` | Ignored local session, task, event, and SQLite data |
| Root `memory/` and sample-workspace memory | Ignored personal knowledge; version individual notes only deliberately |
| `generated/` and `node_modules/` | Ignored, recreated locally |
| `fixtures/sample-project/sum.mjs` | Ignored disposable exercise; created by reset |
| `.env` files and credential material | Keep private; no such file is needed for ordinary setup |
| A custom `--data-dir` or external workspace | Review its location and its own ignore rules |

`.gitignore` does not remove a file that was already committed. Review both tracked files and earlier commits when checking for accidental credentials or personal logs. If a real credential has been exposed, remove it from shared material and revoke/rotate it with its issuer; editing the current file alone does not revoke it.

The sample codename “Paper Kite” and seeded learning notes are fictional teaching material. Local event logs can contain real code, prompts, and paths even though credential-named fields are redacted. Do not include those logs or credential caches in screenshots or issue attachments without reviewing them.

## License

The project uses **GPL-3.0-or-later**: GNU GPL version 3 or, at the recipient's option, any later version published by the Free Software Foundation. The complete text is in [LICENSE](../LICENSE), the README states the grant, and the package metadata records the SPDX identifier. Keep third-party license notices with their dependencies.

The package currently has `private: true`. That prevents accidental publication to the npm registry. It has no effect on the visibility of the Git repository and need not be removed to share source.

## Verify what a new reader receives

Test the README's offline commands from a checkout without `generated/`, `.harness/`, or the disposable sum implementation. Only `npm ci` should be required for the toy and TUI preview. For development, generate protocol bindings, reset the sample, and run `npm run check`; see [Contributing](../CONTRIBUTING.md).

Keep the distinction visible: local tests and the demo do not use a model, while live `npm start` does. A successful demo does not establish that an account, runtime version, or live approval path works. The [development record](../notes/development.md) states what has actually been verified.

Check relative documentation links, expected failure examples, supported operating systems, and the workspace used by every command. Avoid claiming a continuous-integration status or security audit that has not been performed.

No repository visibility, remote configuration, or publication is changed by these local documentation updates.
