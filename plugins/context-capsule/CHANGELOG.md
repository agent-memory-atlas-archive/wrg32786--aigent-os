# Changelog

## 0.1.0 - unreleased

First cut of the standalone context-capsule plugin.

- `/capsule`, `/refresh`, `/resume`, `/autorefresh-setup`.
- `PreCompact` hook: side effect only (PreCompact output never reaches the model). With no valid capsule it leaves a marker; the next `SessionStart(compact)` turns it into a `/capsule` nudge and deletes it.
- `SessionStart` hook for `clear` and `compact`: small pointer to the newest valid capsule; marks it `resumed` on `clear`.
- Corrupt, incomplete, spent and stale (older than 14 days by default; `maxAgeDays` option) capsules are refused with a stated reason.
- Hooks defer silently when a full aigent-os install is detected (project or user-scope settings, or the install marker).
- Capsule format and selection logic ported from aigent-os; capsules are interchangeable with a full install.
- `/capsule` and the resume skill now honour the `capsuleDir` option. The helper takes `--dir`, and the command and skill text pass the configured value, because a Bash tool call does not receive the plugin options that hooks do.
- Zero npm dependencies, no network, writes only to the capsule directory.
- Safety: linked capsule or marker files are never read, selected or written through, and every write stays inside the capsule directory.
- `write` fails without a capsule or receipt when a required flag is missing or its value is another flag.
- Two saves in the same second no longer overwrite each other (the second gets a numeric suffix).
- A capsule older than one already resumed is never auto-injected, so a later compact cannot roll back to older work.
