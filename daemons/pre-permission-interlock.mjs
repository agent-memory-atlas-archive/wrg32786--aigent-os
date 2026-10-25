#!/usr/bin/env node
// pre-permission-interlock.mjs -- the bounded pre-permission interlock (#104).
//
// ONE FILE, TWO CALLERS, ONE IMPLEMENTATION. Run directly it is the
// PreToolUse / PostToolUse / Stop hook; imported it is the library the managed
// runner (daemons/pty-runner.mjs) uses for the same gate and the same state
// file. That is deliberate rather than tidy: a mutual-exclusion protocol with
// two implementations has two chances to disagree about what "held" means, and
// the whole point of this unit is that the two sides cannot both think the
// composer is theirs.
//
// ─── WHY A HOOK AT ALL, WHEN #110 ALREADY READ THE TRANSCRIPT ───────────────
//
// #110 gated every automatic write on "the bound transcript holds a tool_use
// with no matching tool_result". MEASURED on binary 2.1.310 (run 2026-10-24
// 21:07Z, session 529aa897) that signal WAS NOT READABLE while the dialog was
// on screen: the tool_use record occupied bytes 286521-288638 while the file
// was 283263 bytes at all three samples taken during the dialog -- not
// partially written, NOT FLUSHED AT ALL. Readiness answered `ready: true` with
// a real permission prompt up. The 163,968-byte flush carrying both the call
// and its answer landed only after the cancellation. Creation to readability
// was >= 2.44 s (interval 2.436-4.641 s; both ends fenced by the driver's
// 400 ms screen poll). One run in four.
//
// The host's transcript writes are buffered and the flush is unannounced. No
// amount of care in a reader produces a signal that is not on disk. So the
// evidence has to come from somewhere CAUSAL instead of somewhere concurrent,
// and `PreToolUse` is the smallest supported host mechanism that is causal:
// Claude Code runs it, synchronously, BEFORE the permission check, and waits
// for it. A marker written there precedes the dialog rather than racing it.
//
// ─── WHY THIS IS NOT ANOTHER FILE TO POLL ───────────────────────────────────
//
// A second file the runner polls would have the identical defect, one layer
// over: the runner reads "nothing pending", the hook then writes the marker,
// and the runner writes its Enter into the dialog that follows. A check
// followed by a write is not exclusion.
//
// So this is a MUTEX, not a flag. Both sides take the same gate:
//
//   runner:  acquire gate -> read pending -> pty.write(...) -> release gate
//   hook:    acquire gate -> (drain) -> record pending -> release gate -> the
//            host's permission check proceeds
//
// Whichever side holds it first, the other cannot interleave:
//   * hook first  -> the marker is on disk and fsynced before it releases, so
//                    the runner's read inside its own critical section sees it
//                    and the write never happens;
//   * runner first -> pty.write has already RETURNED before the hook can
//                    acquire, and the hook then waits out INTERLOCK_DRAIN_MS
//                    (see below) before letting the permission check start.
//
// There is no interval in which the runner can observe "nothing pending" and
// then have a marker appear before its own write, because the observation and
// the write are inside the same critical section the marker creation needs.
//
// ─── THE DRAIN, AND WHY THE WAIT BELONGS IN THE HOOK ────────────────────────
//
// `pty.write()` returning is not the child having CONSUMED the byte. So the
// runner's write is causally before the marker while the byte may still be in
// flight. The hook is a throwaway process, so a bounded synchronous wait costs
// nothing there and costs the runner nothing at all: holding the gate, the
// hook sleeps out the remainder of INTERLOCK_DRAIN_MS since the runner's last
// write before it records the pending call and returns. The runner cannot
// write during that sleep -- the hook holds the gate.
//
// ─── BOUNDED, AND WHICH WAY THE FALLBACK FAILS ──────────────────────────────
//
// An unbounded hook wait hangs the agent, so every wait here has a budget:
//   * HOOK_GATE_BUDGET_MS to acquire the gate,
//   * INTERLOCK_DRAIN_MS for the drain,
// and the configured hook `timeout` in .claude/settings.json is set well above
// their sum, because a hook the HOST times out is a fail-open (the tool call
// proceeds) and this unit must never rely on that.
//
// THE FALLBACK FAILS CLOSED: if the gate cannot be taken inside the budget,
// PreToolUse returns `permissionDecision: "deny"` with a named reason. The
// tool call does not run, so no dialog appears, so there is nothing for an
// automatic Enter to answer. A denial is recoverable -- the model is told why
// and can retry -- whereas an automatic "Yes, and switch to accept edits ...
// for this session" is not. The same choice is made for an internal error
// AFTER a managed runner has been proven present: at that instant the hook
// cannot mark, so it must not let the check proceed.
//
// A gate nobody released is a liveness hazard in exactly that direction, so it
// is STEALABLE: a holder whose pid is gone, or whose nonce belongs to a
// previous binding, or that is older than GATE_STALE_MS, is renamed away
// (rename(2) / MoveFile -- atomic, measured on both platforms: exactly one of
// four racing stealers wins, the losers get ENOENT) and the gate re-created.
// A legitimate holder never holds for GATE_STALE_MS: the runner's critical
// section is a stat, a small read and a pty write.
//
// ─── NO MANAGED RUNNER MEANS NO OPINION ─────────────────────────────────────
//
// If there is no `proof.json` for this session, no runner is managing this
// seat's composer, so the hook exits 0 and marks nothing. That is not a
// fail-open: the runner's side REQUIRES the proof it writes itself, so absence
// holds automatic writes on one side and silences the hook on the other. The
// two refusals are the same fact seen from both ends.
//
// ─── THE LIVENESS PROOF IS THE WHOLE POINT ──────────────────────────────────
//
// Keying readiness on a marker is only sound if the runner can prove the hook
// is live FOR THE BOUND SESSION. Otherwise "no marker" means both "no tool
// call" and "the hook is not installed", and the second reading is a worse,
// silent fail-open than the gap being closed. `interlockEvidence()` below is
// that proof and it is all-or-nothing: see its header for the four legs and
// the named refusal each one produces.
//
// AIGENT_INTERLOCK=off disables the hook AND makes the runner's side report
// NOT READY (`interlock-disabled`). The switch therefore cannot create a
// fail-open in either direction -- turning it off stops automatic writes, it
// does not permit them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { memRoot as resolveMemoryRoot, readStdin, logErr, inert } from './lifecycle-common.mjs';

// ─── BOUNDS ─────────────────────────────────────────────────────────────────
// Every one of these is a bound on a WAIT or on a FILE SIZE. None of them is a
// timeout after which something unsafe is permitted.
export const INTERLOCK_DIR_NAME = 'interlock';
export const GATE_NAME = 'gate';
export const STATE_NAME = 'state.json';
export const PROOF_NAME = 'proof.json';
// How long the HOOK may wait for the gate before denying the tool call. The
// runner's critical section is a stat, a bounded small read and one pty write,
// so this is three orders of magnitude of headroom over the contended case; it
// is sized for a loaded host (this seat carries ~130 node processes at steady
// state), not for the mechanism.
export const HOOK_GATE_BUDGET_MS = 1200;
// Sleep between gate attempts. Atomics.wait, not a spin: a busy loop in a hook
// competes with the very child process it is blocking.
export const GATE_SLEEP_MS = 5;
// When a gate may be STOLEN on age alone. A legitimate holder cannot reach it.
export const GATE_STALE_MS = 5000;
// How long the hook waits out a pty write that may still be in flight to the
// child. See "THE DRAIN" above.
export const INTERLOCK_DRAIN_MS = 120;
// The runner never WAITS on the gate -- a gate held by a hook means a
// permission check is starting, and deferring is the right answer, not
// blocking the runner's event loop. It does take two attempts, because the
// first may be spent stealing a dead holder's gate.
export const RUNNER_GATE_ATTEMPTS = 2;
// A cap on the pending map so a pathological session cannot grow the state
// file without bound. Hitting it is itself a named refusal, never a discard:
// dropping a pending call is the fail-open this file exists to prevent.
export const PENDING_MAX = 64;
// Session directories older than this are swept when a new one is created.
export const SESSION_DIR_TTL_MS = 6 * 60 * 60 * 1000;
export const SESSION_DIR_SWEEP_MAX = 32;
// Session ids are uuids. Anything else does not get to name a directory.
const SESSION_ID_OK = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL_USE_ID_OK = /^[A-Za-z0-9._:-]{1,200}$/;

export function interlockEnabled(env = process.env) {
  const value = String(env.AIGENT_INTERLOCK ?? '').trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false' || value === 'no');
}

// ─── WHERE THE STATE LIVES ──────────────────────────────────────────────────
// Under the memory root both sides already resolve the same way, beside the
// boot receipt the runner reads every tick. AIGENT_INTERLOCK_DIR is an
// explicit override honoured by BOTH sides, so a test or an operator can pin
// the path rather than depend on two independent root resolutions agreeing.
export function interlockRoot({ memRoot, env = process.env } = {}) {
  const pinned = typeof env.AIGENT_INTERLOCK_DIR === 'string' && env.AIGENT_INTERLOCK_DIR.length > 0
    ? env.AIGENT_INTERLOCK_DIR
    : null;
  if (pinned) return path.resolve(pinned);
  if (typeof memRoot !== 'string' || memRoot.length === 0) return null;
  return path.join(memRoot, 'runtime', INTERLOCK_DIR_NAME);
}

export function sessionDir({ memRoot, sessionId, env = process.env } = {}) {
  const root = interlockRoot({ memRoot, env });
  if (root === null) return null;
  if (typeof sessionId !== 'string' || !SESSION_ID_OK.test(sessionId)) return null;
  return path.join(root, sessionId);
}

function sleepMs(milliseconds) {
  if (!(milliseconds > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // SharedArrayBuffer unavailable: a bounded busy wait is still bounded.
    const until = Date.now() + milliseconds;
    while (Date.now() < until) { /* bounded */ }
  }
}

function pidAlive(pid, processLike = process) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { processLike.kill(pid, 0); return true; } catch (error) {
    // EPERM means a live process this user may not signal -- alive, not gone.
    return error?.code === 'EPERM';
  }
}

// ─── THE GATE ───────────────────────────────────────────────────────────────
// O_CREAT|O_EXCL on a plain file. Measured exclusive on win32 (second open
// EEXIST) and it is POSIX-guaranteed; the file's EXISTENCE is the lock, so the
// descriptor is closed immediately and nothing depends on holding it open.
//
// A path that is a DIRECTORY also answers EEXIST, which would read as "held"
// for ever. #110 lost a day to `statSync(dir).size` differing by platform, so
// that case is named here rather than left to look like contention.
function gateHolder(gatePath, fsImpl) {
  let raw;
  try { raw = fsImpl.readFileSync(gatePath, 'utf8'); } catch (error) {
    if (error?.code === 'EISDIR' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      return { kind: 'unusable', code: error.code };
    }
    if (error?.code === 'ENOENT') return { kind: 'gone' };
    return { kind: 'unreadable', code: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch { return { kind: 'unparsed' }; }
  if (!record || typeof record !== 'object') return { kind: 'unparsed' };
  return { kind: 'held', record };
}

function stealable(holder, { nonce, now, processLike }) {
  if (holder.kind === 'gone') return true;
  if (holder.kind === 'unparsed' || holder.kind === 'unreadable') return true;
  if (holder.kind === 'unusable') return false;
  const record = holder.record;
  // A gate stamped with a DIFFERENT binding's nonce cannot be protecting
  // anything in this one: its session is over.
  if (typeof nonce === 'string' && nonce.length > 0
    && typeof record.nonce === 'string' && record.nonce !== nonce) return true;
  if (!pidAlive(record.pid, processLike)) return true;
  const ts = Number(record.ts);
  return Number.isFinite(ts) && (now - ts) > GATE_STALE_MS;
}

// Rename-away, then re-create. The rename is the atomic step: exactly one of N
// concurrent stealers can move the same source (measured 20/20 rounds with 4
// racers on win32, losers ENOENT), so two stealers cannot both believe they
// took it.
function stealGate(gatePath, fsImpl, pid, now) {
  const aside = `${gatePath}.stolen-${pid}-${now}-${Math.floor(Math.random() * 1e6)}`;
  try { fsImpl.renameSync(gatePath, aside); } catch { return false; }
  try { fsImpl.unlinkSync(aside); } catch { /* the steal already succeeded */ }
  return true;
}

/**
 * Take the gate, or say exactly why not.
 *
 * `budgetMs: 0` (the runner) never sleeps: one attempt, one steal, one more
 * attempt. A hook passes HOOK_GATE_BUDGET_MS and waits.
 *
 * Returns {ok:true, handle} or {ok:false, code, detail}. `handle` must be
 * passed to releaseGate on EVERY exit path -- a leaked gate denies this
 * session's tool calls until it goes stale.
 */
export function acquireGate({
  dir,
  side,
  nonce = null,
  budgetMs = 0,
  fsImpl = fs,
  now = () => Date.now(),
  processLike = process,
  pid = process.pid,
  sleep = sleepMs,
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-gate-no-dir', detail: null };
  }
  const gatePath = path.join(dir, GATE_NAME);
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (error) {
    return { ok: false, code: 'interlock-gate-dir-failed', detail: error?.code ?? String(error) };
  }
  const deadline = now() + Math.max(0, budgetMs);
  // TWO INDEPENDENT BOUNDS, and the second one is not belt-and-braces. "No
  // unbounded hook wait" must not be contingent on the clock advancing: a
  // frozen or non-monotonic clock would make the deadline unreachable and the
  // loop infinite, which is the agent hanging on a hook. An attempt ceiling
  // holds whatever the clock does. (Found by a vector that injected a constant
  // clock -- it looped instead of denying.)
  const attemptCeiling = Math.max(
    RUNNER_GATE_ATTEMPTS,
    Math.ceil(Math.max(0, budgetMs) / GATE_SLEEP_MS) + 2,
  );
  let stole = false;
  let attempts = 0;
  let lastCode = null;
  for (;;) {
    attempts += 1;
    const stamp = {
      side: String(side ?? 'unknown'),
      pid,
      ts: now(),
      nonce: nonce ?? null,
      token: crypto.randomUUID(),
    };
    let fd = null;
    try {
      fd = fsImpl.openSync(gatePath, 'wx');
      fsImpl.writeFileSync(fd, JSON.stringify(stamp));
      try { fsImpl.fsyncSync(fd); } catch { /* content is advisory; existence is the lock */ }
      fsImpl.closeSync(fd);
      return { ok: true, handle: { gatePath, token: stamp.token, fsImpl, dir }, attempts };
    } catch (error) {
      if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
      if (error?.code !== 'EEXIST') {
        return { ok: false, code: 'interlock-gate-open-failed', detail: error?.code ?? String(error) };
      }
    }
    const holder = gateHolder(gatePath, fsImpl);
    if (holder.kind === 'unusable') {
      // The gate path is a directory, or unreadable by this user. This is NOT
      // contention and waiting cannot fix it.
      return { ok: false, code: 'interlock-gate-path-unusable', detail: holder.code ?? null };
    }
    if (!stole && stealable(holder, { nonce, now: now(), processLike })) {
      stole = true;
      if (stealGate(gatePath, fsImpl, pid, now())) continue;
    }
    lastCode = holder.kind === 'held' ? 'held' : holder.kind;
    if (attempts >= RUNNER_GATE_ATTEMPTS && budgetMs <= 0) break;
    if (attempts >= attemptCeiling) break;
    if (now() >= deadline) break;
    sleep(Math.min(GATE_SLEEP_MS, Math.max(1, deadline - now())));
  }
  return {
    ok: false,
    code: 'interlock-gate-busy',
    detail: { attempts, holder: lastCode, budget_ms: budgetMs },
  };
}

export function releaseGate(handle) {
  if (!handle || typeof handle.gatePath !== 'string') return false;
  const fsImpl = handle.fsImpl ?? fs;
  // Only release OUR gate. If it was stolen out from under us (a wedge long
  // enough to go stale), unlinking the new holder's gate would break the
  // exclusion for somebody else.
  const holder = gateHolder(handle.gatePath, fsImpl);
  if (holder.kind === 'held' && holder.record?.token !== handle.token) return false;
  try { fsImpl.unlinkSync(handle.gatePath); return true; } catch { return false; }
}

// ─── THE STATE FILE ─────────────────────────────────────────────────────────
// Written only under the gate, by either side. Shape:
//   { nonce, pre_runs, post_runs, stop_runs, last_event, last_event_at,
//     last_write_at, pending: { <tool_use_id>: {tool, ts, transcript_size} } }
//
// Replaced through a temp file plus rename so a torn file is impossible; a
// state file that will not parse is a NAMED refusal on the runner's side, not
// an empty pending map.
export function emptyState(nonce) {
  return {
    nonce: nonce ?? null,
    pre_runs: 0,
    post_runs: 0,
    stop_runs: 0,
    last_event: null,
    last_event_at: null,
    last_write_at: null,
    pending: {},
  };
}

export function readState({ dir, fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-state-no-dir', state: null };
  }
  let raw;
  try { raw = fsImpl.readFileSync(path.join(dir, STATE_NAME), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'interlock-state-missing', state: null };
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: 'parse' };
  }
  if (!record || typeof record !== 'object' || record.pending === null
    || typeof record.pending !== 'object' || Array.isArray(record.pending)) {
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: 'shape' };
  }
  return { ok: true, code: null, state: record };
}

export function writeState({ dir, state, fsImpl = fs, pid = process.pid } = {}) {
  const target = path.join(dir, STATE_NAME);
  const temp = `${target}.tmp-${pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    const fd = fsImpl.openSync(temp, 'w');
    fsImpl.writeFileSync(fd, JSON.stringify(state));
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
    fsImpl.closeSync(fd);
    fsImpl.renameSync(temp, target);
    return { ok: true, code: null };
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch { /* ignore */ }
    return { ok: false, code: 'interlock-state-write-failed', detail: error?.code ?? String(error) };
  }
}

export function readProof({ dir, fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-proof-no-dir', proof: null };
  }
  let raw;
  try { raw = fsImpl.readFileSync(path.join(dir, PROOF_NAME), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'interlock-proof-missing', proof: null };
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: 'parse' };
  }
  if (!record || typeof record !== 'object' || typeof record.nonce !== 'string'
    || record.nonce.length === 0) {
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: 'shape' };
  }
  return { ok: true, code: null, proof: record };
}

export function writeProof({ dir, proof, fsImpl = fs, pid = process.pid } = {}) {
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (error) {
    return { ok: false, code: 'interlock-proof-dir-failed', detail: error?.code ?? String(error) };
  }
  const target = path.join(dir, PROOF_NAME);
  const temp = `${target}.tmp-${pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    const fd = fsImpl.openSync(temp, 'w');
    fsImpl.writeFileSync(fd, JSON.stringify(proof));
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
    fsImpl.closeSync(fd);
    fsImpl.renameSync(temp, target);
    return { ok: true, code: null };
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch { /* ignore */ }
    return { ok: false, code: 'interlock-proof-write-failed', detail: error?.code ?? String(error) };
  }
}

// Old bindings' directories. Bounded both in age and in how many one pass may
// remove, so a sweep can never become the expensive thing on a tick.
export function sweepSessionDirs({ memRoot, keepSessionId, fsImpl = fs, env = process.env, now = Date.now() } = {}) {
  const root = interlockRoot({ memRoot, env });
  if (root === null) return 0;
  let entries;
  try { entries = fsImpl.readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    if (removed >= SESSION_DIR_SWEEP_MAX) break;
    if (name === keepSessionId) continue;
    const dir = path.join(root, name);
    let stat;
    try { stat = fsImpl.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if ((now - stat.mtimeMs) <= SESSION_DIR_TTL_MS) continue;
    try { fsImpl.rmSync(dir, { recursive: true, force: true }); removed += 1; } catch { /* next pass */ }
  }
  return removed;
}

// ─── THE LIVENESS PROOF ─────────────────────────────────────────────────────
// FOUR LEGS, ALL REQUIRED. Each one answers a different way the interlock
// could be absent while looking like "no tool call is pending", and each has
// its own refusal name so the log says which:
//
//   1. BOUND      proof.json exists for THIS session dir and its nonce, session
//                 id and runner pid match the binding in memory. A proof from a
//                 previous binding is stale, not evidence.
//                 -> interlock-proof-missing / -unreadable / -mismatch
//   2. INSTALLED  the hook file is where the proof recorded it and its sha256
//                 still matches. An edited or replaced hook voids the proof.
//                 -> interlock-hook-missing / -changed
//   3. OBSERVED   the HOST has run the hook at least once for this nonce. This
//                 is the strong leg and the only one that is empirical: it is
//                 direct evidence that this binary, with this configuration,
//                 invokes this file for this session. Any of PreToolUse,
//                 PostToolUse or Stop counts -- Stop fires at the end of every
//                 assistant turn, measured, so a session that has had a turn
//                 satisfies it even with no tool call in it.
//                 -> interlock-hook-not-observed
//   4. CURRENT    the hook has seen every tool call the transcript reader has.
//                 Since the last point at which both counters agreed, the hook
//                 must have run (pre_runs) at least as many times as the reader
//                 has parsed new tool_use records. This is POSITIVE DETECTION
//                 OF A DEAD HOOK rather than a timeout: if the configuration is
//                 changed mid-session, or the hook starts failing, the next tool
//                 call makes the counters disagree and the gate closes. Idle
//                 time proves nothing and is deliberately NOT used -- a quiet
//                 session makes no tool calls, so an idle-staleness rule would
//                 hold automation on a healthy seat and would be a liveness bug
//                 dressed as a safety check.
//                 -> interlock-hook-missed-tool-calls
//
//                 The comparison is a DELTA against a checkpoint, not a running
//                 total, because the reader's absolute count is not comparable
//                 to the hook's: the reader's baseline walk parses up to a
//                 megabyte of HISTORY whose calls the hook may have handled
//                 before the state file existed. The checkpoint is discarded on
//                 every re-baseline (see the runner's _noteToolCallWatch) --
//                 after a re-baseline the reader has re-read records it had
//                 already counted, so it has no claim about what the hook owed.
//                 That forgiveness is not a hole: a re-baseline also raises
//                 `unknownOpen`, which holds every automatic write until an
//                 anchor discharges it, so the two legs cover each other.
//
// WHAT IS NOT A LEG, AND WHY. A runner-side probe (spawn the hook with a
// synthetic payload and check it stamps) was considered and dropped: it proves
// the FILE works when the RUNNER runs it, which leg 3 already subsumes with
// better evidence (the HOST ran it), and it would cost a subprocess per bind on
// a host that carries ~130 node processes at steady state. Earlier diagnosis
// was the only thing it bought.
//
// Then, and only then, the pending map must be empty. An expired pending entry
// is NOT released on age: a human may be looking at that dialog for minutes,
// and age cannot tell that from an orphan. See `pendingProblem`.
export function interlockEvidence({
  dir,
  nonce,
  sessionId,
  runnerPid,
  hookPath,
  hookSha256,
  toolUsesObserved = 0,
  checkpoint = null,
  fsImpl = fs,
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-dir-unresolved', detail: null };
  }
  const proofRead = readProof({ dir, fsImpl });
  if (!proofRead.ok) {
    return { ok: false, code: proofRead.code, detail: proofRead.detail ?? null };
  }
  const proof = proofRead.proof;
  const mismatch = [];
  if (proof.nonce !== nonce) mismatch.push('nonce');
  if (proof.session_id !== sessionId) mismatch.push('session_id');
  if (proof.runner_pid !== runnerPid) mismatch.push('runner_pid');
  if (mismatch.length > 0) {
    return { ok: false, code: 'interlock-proof-mismatch', detail: { fields: mismatch } };
  }
  // Leg 2. The hook the proof was written about must still be that file.
  let digest = null;
  try {
    digest = crypto.createHash('sha256').update(fsImpl.readFileSync(hookPath)).digest('hex');
  } catch (error) {
    return {
      ok: false,
      code: 'interlock-hook-missing',
      detail: { path: hookPath, error: error?.code ?? null },
    };
  }
  if (digest !== hookSha256) {
    return { ok: false, code: 'interlock-hook-changed', detail: { path: hookPath } };
  }
  const stateRead = readState({ dir, fsImpl });
  if (!stateRead.ok) {
    return { ok: false, code: stateRead.code, detail: stateRead.detail ?? null };
  }
  const state = stateRead.state;
  if (state.nonce !== nonce) {
    return { ok: false, code: 'interlock-state-stale', detail: { nonce: inert(String(state.nonce), 80) } };
  }
  const pre = Number(state.pre_runs) || 0;
  const post = Number(state.post_runs) || 0;
  const stop = Number(state.stop_runs) || 0;
  // Leg 3.
  if (pre + post + stop < 1) {
    return { ok: false, code: 'interlock-hook-not-observed', detail: null };
  }
  // Leg 4. A delta against the last point at which both sides agreed; see the
  // header for why an absolute comparison would be wrong.
  const observed = Number(toolUsesObserved) || 0;
  const base = checkpoint === null
    ? { observed, preRuns: pre }
    : { observed: Number(checkpoint.observed) || 0, preRuns: Number(checkpoint.preRuns) || 0 };
  const owed = Math.max(0, observed - base.observed);
  const ran = Math.max(0, pre - base.preRuns);
  if (ran < owed) {
    return {
      ok: false,
      code: 'interlock-hook-missed-tool-calls',
      detail: { hook_runs_since: ran, tool_uses_since: owed },
    };
  }
  return {
    ok: true,
    code: null,
    detail: null,
    state,
    // The caller stores this and passes it back, so the next comparison starts
    // from the fact that these two agreed here.
    nextCheckpoint: { observed, preRuns: pre },
  };
}

// A pending map that is not empty, or that cannot be trusted to be complete.
// AGE NEVER RELEASES. A marker older than any bound still means a permission
// check was started and not seen to finish; a human may be reading that dialog.
// The honest answer is a differently NAMED hold, so the operator can tell "a
// dialog is up" from "something was never cleared", and both hold.
//
// ─── `settled` AND WHY IT WAS ADDED AFTER A HOST RUN ────────────────────────
// The clearing paths started as PostToolUse (an allowed call) plus the turn's
// Stop sweep (everything else). MEASURED on binary 2.1.310 (2026-10-25 run 3,
// session ee986519) that was not enough: an ESC-CANCELLED turn produced NO
// Stop hook invocation at all. `stop_runs` stayed at 1 from before the dialog,
// through the cancellation, and through the whole of the NEXT turn's tool call,
// reaching 2 only when that later turn ended -- so the marker was held for 48 s
// (17:09:50 to 17:10:38) with no dialog on screen, and an operator who simply
// walked away would have held automation indefinitely. Fail-closed, but a real
// liveness cost and the exact recovery case this work has to get right.
//
// The fix reuses the evidence the runner already has. The marker is keyed by
// the host's own `tool_use_id`, and the #110 reader pairs on that same id; a
// `tool_result` is written whichever way the dialog is answered -- approval,
// cancellation or error (measured in #110). So an id the reader has seen
// SETTLED is positive evidence that its permission check is over, and the
// marker for it is discounted.
//
// The direction is the safe one. Buffered transcript writes only make this
// clear LATER, never earlier, so the failure mode of the thing that bit #110 is
// a longer hold here rather than a release. And it is still the ID that
// releases: one result settles its own call and no other, exactly as in the
// transcript reader.
//
// An `anon:` marker (a call the host gave no usable id for) can never be
// settled this way, so only a Stop sweep clears it. That is deliberate -- a
// call that cannot be named is a call that cannot be paired.
export function pendingProblem(state, { now = Date.now(), staleMs = 120000, settled = null } = {}) {
  const all = Object.keys(state?.pending ?? {});
  const ids = settled === null ? all : all.filter((id) => !settled.has(id));
  if (ids.length === 0) return null;
  if (ids.length > PENDING_MAX) {
    return { code: 'interlock-pending-overflow', detail: { pending: ids.length, max: PENDING_MAX } };
  }
  let oldest = null;
  for (const id of ids) {
    const ts = Number(state.pending[id]?.ts);
    if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts;
  }
  const ageMs = oldest === null ? null : now - oldest;
  if (ageMs !== null && ageMs > staleMs) {
    return {
      code: 'interlock-pending-stale',
      detail: { pending: ids.length, oldest_age_ms: ageMs, tool_use_ids: ids.slice(0, 8) },
    };
  }
  return {
    code: 'interlock-permission-pending',
    detail: { pending: ids.length, tool_use_ids: ids.slice(0, 8) },
  };
}

// ─── THE HOOK ───────────────────────────────────────────────────────────────

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch { /* the call would then proceed -- see hookMain's last resort */ }
}

// The root the hook resolves state from. AIGENT_ROOT is what the installed
// .claude/settings.json sets; CLAUDE_PROJECT_DIR is the host's own; the
// payload's cwd is the runner's cwd and the last resort. memRoot() itself
// honours AIGENT_STATE_HOME_DIR, so a relocated state home follows both sides.
export function hookMemRoot(payload, env = process.env) {
  for (const candidate of [env.AIGENT_ROOT, env.CLAUDE_PROJECT_DIR, payload?.cwd]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      const resolved = resolveMemoryRoot(candidate);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * One hook invocation, as a function so the suite can drive the SHIPPED code
 * without a subprocess per vector.
 *
 * Returns {action:'allow'|'deny'|'inert', code, detail}. 'inert' means no
 * managed runner is present for this session, which is not a decision about
 * the tool call at all.
 */
export function runHook({
  payload,
  event,
  env = process.env,
  fsImpl = fs,
  now = () => Date.now(),
  processLike = process,
  pid = process.pid,
  sleep = sleepMs,
  gateBudgetMs = HOOK_GATE_BUDGET_MS,
} = {}) {
  if (!interlockEnabled(env)) return { action: 'inert', code: 'interlock-disabled', detail: null };
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
  if (sessionId === null || !SESSION_ID_OK.test(sessionId)) {
    return { action: 'inert', code: 'interlock-no-session-id', detail: null };
  }
  const memRoot = hookMemRoot(payload, env);
  const dir = sessionDir({ memRoot, sessionId, env });
  if (dir === null) return { action: 'inert', code: 'interlock-dir-unresolved', detail: null };
  // NO MANAGED RUNNER MEANS NO OPINION. The runner writes this file; without it
  // nothing is writing to this composer automatically, and the runner's own
  // side refuses for the same reason.
  const proofRead = readProof({ dir, fsImpl });
  if (!proofRead.ok) {
    return { action: 'inert', code: proofRead.code, detail: null };
  }
  const nonce = proofRead.proof.nonce;

  const gate = acquireGate({
    dir,
    side: `hook:${event}`,
    nonce,
    budgetMs: event === 'PreToolUse' ? gateBudgetMs : Math.min(gateBudgetMs, 300),
    fsImpl,
    now,
    processLike,
    pid,
    sleep,
  });
  if (!gate.ok) {
    // FAIL CLOSED, and only for the event that precedes the dialog. A
    // PostToolUse or Stop that cannot take the gate merely fails to CLEAR,
    // which holds automatic writes -- already the safe direction -- so denying
    // there would cost liveness and buy nothing.
    if (event !== 'PreToolUse') {
      return { action: 'allow', code: gate.code, detail: gate.detail ?? null };
    }
    return { action: 'deny', code: gate.code, detail: gate.detail ?? null };
  }
  try {
    const stateRead = readState({ dir, fsImpl });
    const state = stateRead.ok && stateRead.state?.nonce === nonce
      ? stateRead.state
      : emptyState(nonce);
    if (!state.pending || typeof state.pending !== 'object') state.pending = {};

    if (event === 'PreToolUse') {
      // THE DRAIN. A pty write may still be travelling to the child; hold the
      // gate until it cannot be, then let the permission check start.
      const since = Number(state.last_write_at);
      if (Number.isFinite(since)) {
        const remaining = INTERLOCK_DRAIN_MS - (now() - since);
        if (remaining > 0) sleep(Math.min(remaining, INTERLOCK_DRAIN_MS));
      }
      const toolUseId = typeof payload.tool_use_id === 'string' && TOOL_USE_ID_OK.test(payload.tool_use_id)
        ? payload.tool_use_id
        // A call with no usable id still raises a dialog, so it is still
        // recorded -- under a synthetic key, which only a Stop sweep clears.
        // Never dropped: an unnameable call is a call that cannot be paired.
        : `anon:${crypto.randomUUID()}`;
      if (Object.keys(state.pending).length >= PENDING_MAX
        && !Object.hasOwn(state.pending, toolUseId)) {
        // The map is full. Denying is the only answer that does not either
        // discard a pending call or grow the file without bound.
        return { action: 'deny', code: 'interlock-pending-overflow', detail: { max: PENDING_MAX } };
      }
      let transcriptSize = null;
      try {
        transcriptSize = typeof payload.transcript_path === 'string'
          ? fsImpl.statSync(payload.transcript_path).size
          : null;
      } catch { transcriptSize = null; }
      state.pending[toolUseId] = {
        tool: typeof payload.tool_name === 'string' ? inert(payload.tool_name, 80) : null,
        ts: now(),
        transcript_size: transcriptSize,
      };
      state.pre_runs = (Number(state.pre_runs) || 0) + 1;
    } else if (event === 'PostToolUse') {
      const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null;
      if (toolUseId !== null) delete state.pending[toolUseId];
      state.post_runs = (Number(state.post_runs) || 0) + 1;
    } else if (event === 'Stop') {
      // THE SWEEP, and the reason it is sound: Stop fires when the assistant
      // has finished responding. A permission dialog cannot be on screen then
      // -- the turn it belongs to has ended. This is what bounds an orphaned
      // marker (a cancelled call gets no PostToolUse: measured) to the turn it
      // was raised in.
      state.pending = {};
      state.stop_runs = (Number(state.stop_runs) || 0) + 1;
    } else {
      return { action: 'inert', code: 'interlock-unknown-event', detail: { event: inert(String(event), 40) } };
    }
    state.nonce = nonce;
    state.last_event = String(event);
    state.last_event_at = now();
    const written = writeState({ dir, state, fsImpl, pid });
    if (!written.ok) {
      // Could not record. For PreToolUse that is the fail-open case: the
      // runner would see an empty pending map and write.
      if (event === 'PreToolUse') {
        return { action: 'deny', code: written.code, detail: written.detail ?? null };
      }
      return { action: 'allow', code: written.code, detail: written.detail ?? null };
    }
    return { action: 'allow', code: null, detail: null };
  } finally {
    releaseGate(gate.handle);
  }
}

const DENY_PREFIX = '[PRE-PERMISSION INTERLOCK]';

export function denyReasonFor(code, detail) {
  return `${DENY_PREFIX} refused to let this tool call reach the permission check: `
    + `${inert(String(code), 80)}${detail === null || detail === undefined ? '' : ` ${inert(JSON.stringify(detail), 200)}`}. `
    + 'A managed runner owns this seat\'s composer and the interlock could not record that a '
    + 'permission check is starting, so allowing it could let an automatic keystroke answer the '
    + 'dialog. Retry the tool call; if this repeats, the runner or the interlock state under '
    + '<memory root>/runtime/interlock needs an operator.';
}

function hookMain() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  const event = typeof payload.hook_event_name === 'string' && payload.hook_event_name.length > 0
    ? payload.hook_event_name
    : (process.argv[2] || '');
  let verdict;
  try {
    verdict = runHook({ payload, event });
  } catch (error) {
    logErr(
      process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload?.cwd || '',
      'pre-permission-interlock',
      `outer: ${error?.stack || error}`,
    );
    // AN INTERNAL ERROR IS NOT AN ALL-CLEAR. Unlike every other PreToolUse hook
    // in this repo, this one cannot fail open: its whole job is to be the reason
    // an automatic keystroke is held, and a throw means it did not do it. Only
    // the event that precedes the dialog denies -- and only when a managed
    // runner was proven present, which is why the proof lookup is inside
    // runHook's own try and an inert verdict never reaches here.
    verdict = { action: event === 'PreToolUse' ? 'deny' : 'allow', code: 'interlock-hook-threw', detail: null };
  }
  if (verdict.action === 'deny') {
    const reason = denyReasonFor(verdict.code, verdict.detail);
    deny(reason);
    try { process.stderr.write(`${reason}\n`); } catch { /* stdout carried it */ }
    // Exit 2 as well as the JSON decision: if stdout could not be written, the
    // exit code is what still blocks. gateguard.mjs and model-tier-guard.mjs
    // use the same belt-and-braces pair.
    process.exit(2);
  }
  process.exit(0);
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) hookMain();
