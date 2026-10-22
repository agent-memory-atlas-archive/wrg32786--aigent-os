# Changelog

## 0.1.0 - unreleased

First cut of the standalone context-capsule plugin.

- `/capsule`, `/refresh`, `/resume`, `/autorefresh-setup`.
- `PreCompact` hook: capsule pointer or `/capsule` nudge before compaction.
- `SessionStart` hook for `clear` and `compact`: small pointer to the newest valid capsule; marks it `resumed` on `clear`.
- Corrupt, incomplete, spent and stale (older than 7 days) capsules are refused with a stated reason.
- Hooks defer silently when a full aigent-os install is detected.
- Capsule format and selection logic ported from aigent-os; capsules are interchangeable with a full install.
- Zero npm dependencies, no network, writes only to the capsule directory.
