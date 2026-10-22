#!/usr/bin/env node
// precompact-flush.mjs - PreCompact: right before compaction, report the capsule state.
// Port of the ToC half of aigent-os daemons/precompact-flush.mjs.
//
// The plugin has no background transcript writer (that stays in aigent-os), so it cannot
// author a capsule by itself. What it does:
//   - newest valid capsule exists  -> print a short pointer (id, path, age, objective,
//     next_valid_action) so the compaction summary carries it, and the post-compact
//     SessionStart hook points back to it.
//   - none, or only stale/corrupt  -> print a NUDGE telling the model/user to run /capsule
//     now (and why anything was rejected). Nothing is written.
// A full aigent-os install owns this: exit 0, print nothing.
// Never blocks compaction: any error exits 0. No network, no file writes.

import {
  readPayload, detectAigentOs, capsuleDir, selectCapsule, maxAgeDays, inert, rejectionLines,
} from './capsule-lib.mjs';

try {
  const payload = readPayload();
  if (detectAigentOs(payload).detected) process.exit(0);

  const dir = capsuleDir(payload);
  const { capsule, rejected } = selectCapsule(dir, { maxAgeDays: maxAgeDays() });
  const out = [];
  if (capsule) {
    const hours = Math.max(0, Math.round((Date.now() - capsule.created) / 3600000));
    out.push(`[context-capsule:precompact] Newest valid capsule (${hours}h old) survives this compaction: ${inert(capsule.id, 120)} at ${inert(capsule.path, 260)}`);
    out.push(`objective: ${inert(capsule.objective, 300)}`);
    out.push(`next_valid_action: ${inert(capsule.next_valid_action, 300)}`);
    out.push(`If the work has moved on since then, run /capsule after compaction to refresh it.`);
  } else {
    out.push(`[context-capsule:precompact] NUDGE: no valid capsule in ${inert(dir, 200)} and compaction is about to run. Run /capsule now (or right after) so a clear or the next compaction can resume from it.`);
    const why = rejectionLines(rejected);
    if (why.length) { out.push('Rejected, not usable:'); out.push(...why); }
  }
  process.stdout.write(`${out.join('\n').slice(0, 3000)}\n`);
} catch (e) {
  try { process.stderr.write(`context-capsule precompact-flush: ${e?.message || e}\n`); } catch { /* nothing more to do */ }
}
process.exit(0);
