---
description: Write a resume-ready capsule of this session now
---

Run the `context-capsule` skill now: reconcile from the live repo state, write a capsule with `node "${CLAUDE_PLUGIN_ROOT}/scripts/capsule-lib.mjs" write ... --dir '${user_config.capsuleDir}'` (from the project directory, no `cd`; drop `--dir` if that value is empty or still shows the placeholder), validate it, and reply with the capsule path in one line. Extra instructions from the user, if any: $ARGUMENTS
