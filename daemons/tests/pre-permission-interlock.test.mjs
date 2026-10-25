// pre-permission-interlock.test.mjs -- the MECHANISM, as opposed to the
// runner's use of it (#104 I vectors in pty-runner.test.mjs).
//
// Everything here is about the three properties the interlock rests on, and
// each one is a thing that has to be true of the FILESYSTEM rather than of the
// code: the gate excludes, a dead holder's gate can be taken without two
// takers both believing they have it, and every wait is bounded with a
// fail-closed fallback.
//
// The primitives were measured on both platforms before being relied on -- see
// docs/dialog-readiness.md, "Platform semantics". A Windows-only run cannot see
// the POSIX branch of an open/stat distinction, which is the lesson #110 paid
// for with a Linux-only regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  GATE_NAME,
  GATE_STALE_MS,
  HOOK_GATE_BUDGET_MS,
  INTERLOCK_DRAIN_MS,
  PENDING_MAX,
  PROOF_NAME,
  STATE_NAME,
  acquireGate,
  emptyState,
  interlockEvidence,
  pendingProblem,
  readState,
  releaseGate,
  runHook,
  sessionDir,
  sweepSessionDirs,
  writeProof,
  writeState,
} from '../pre-permission-interlock.mjs';

const HOOK_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'pre-permission-interlock.mjs');
const SESSION = 'session-interlock-test';
const NONCE = 'nonce-for-this-binding';

function scratch(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `interlock-${name}-`));
  const memRoot = path.join(base, 'project', 'vault', 'memory');
  fs.mkdirSync(memRoot, { recursive: true });
  const env = { AIGENT_INTERLOCK_DIR: path.join(memRoot, 'runtime', 'interlock') };
  const dir = sessionDir({ memRoot, sessionId: SESSION, env });
  fs.mkdirSync(dir, { recursive: true });
  return { base, memRoot, env, dir };
}

function bind(fixture, { nonce = NONCE, pid = 4242 } = {}) {
  writeProof({
    dir: fixture.dir,
    proof: {
      nonce,
      session_id: SESSION,
      runner_pid: pid,
      hook_path: HOOK_PATH,
      hook_sha256: 'unused-by-the-hook-side',
      created_at: new Date(0).toISOString(),
    },
  });
  return nonce;
}

function hookPayload(extra = {}) {
  return {
    session_id: SESSION,
    transcript_path: path.join(os.tmpdir(), 'no-such-transcript.jsonl'),
    cwd: path.join(os.tmpdir(), 'no-such-cwd'),
    ...extra,
  };
}

function withScratch(name, fn) {
  const fixture = scratch(name);
  try { fn(fixture); } finally {
    try { fs.rmSync(fixture.base, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// ─── THE GATE EXCLUDES ──────────────────────────────────────────────────────

test('#104 G1 the gate is exclusive: a second acquisition fails rather than succeeding twice', () => {
  withScratch('g1', (fx) => {
    const first = acquireGate({ dir: fx.dir, side: 'runner', nonce: NONCE, pid: 101, processLike: { kill: () => true } });
    assert.equal(first.ok, true, 'the first taker gets it');
    const second = acquireGate({ dir: fx.dir, side: 'hook', nonce: NONCE, pid: 102, processLike: { kill: () => true } });
    assert.equal(second.ok, false,
      'THE WHOLE MECHANISM: if this ever succeeds, the runner and the hook can both '
      + 'believe they own the composer and the interlock is decoration');
    assert.equal(second.code, 'interlock-gate-busy');
    assert.equal(releaseGate(first.handle), true);
    const third = acquireGate({ dir: fx.dir, side: 'hook', nonce: NONCE, pid: 103, processLike: { kill: () => true } });
    assert.equal(third.ok, true, 'and it is a lock, not a latch');
    releaseGate(third.handle);
  });
});

test('#104 G2 a gate is NOT stolen from a live young holder, and IS stolen from a dead one', () => {
  withScratch('g2', (fx) => {
    const held = acquireGate({ dir: fx.dir, side: 'runner', nonce: NONCE, pid: 201, processLike: { kill: () => true } });
    assert.equal(held.ok, true);

    // Alive and young: not stealable. Stealing here would break the exclusion
    // for the process that legitimately holds it.
    const refused = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 202,
      processLike: { kill: () => true },
    });
    assert.equal(refused.ok, false, 'a live holder keeps its gate');

    // The holder's process is gone. A gate nobody will ever release is a
    // liveness hazard in the fail-closed direction -- every tool call in the
    // session would be denied -- so it is stealable at once.
    const stolen = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 203,
      processLike: { kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } },
    });
    assert.equal(stolen.ok, true, 'a dead holder does not keep it');
    // AND THE ORIGINAL HOLDER CANNOT RELEASE WHAT IT NO LONGER HOLDS. Its
    // unlink would free the new holder's gate, which is the exclusion broken by
    // a different route.
    assert.equal(releaseGate(held.handle), false, 'the stale handle releases nothing');
    assert.ok(fs.existsSync(path.join(fx.dir, GATE_NAME)), 'the new holder still holds it');
    releaseGate(stolen.handle);
  });
});

test('#104 G3 a gate stamped with ANOTHER binding nonce is always stealable', () => {
  withScratch('g3', (fx) => {
    const old = acquireGate({
      dir: fx.dir, side: 'runner', nonce: 'a-previous-binding', pid: 301,
      processLike: { kill: () => true },
    });
    assert.equal(old.ok, true);
    // The session rebound. Whatever that gate was protecting belongs to a
    // conversation that no longer exists, and its holder may well still be
    // alive (the same runner process, now on a new binding).
    const next = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 301,
      processLike: { kill: () => true },
    });
    assert.equal(next.ok, true, 'a new binding is not blocked by the old one');
    releaseGate(next.handle);
  });
});

test('#104 G4 a gate path that is a DIRECTORY is named, not read as contention', () => {
  withScratch('g4', (fx) => {
    // #110's lesson, applied before it could bite: an O_EXCL open answers
    // EEXIST for a directory too, so without this branch the gate would read as
    // permanently held and every tool call in the session would be denied
    // forever -- fail-closed, but a wedge, and nameless.
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    const verdict = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 401,
      budgetMs: 50,
      processLike: { kill: () => true },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'interlock-gate-path-unusable',
      'named for what it IS, not for whichever error the platform happens to raise');
  });
});

// ─── THE HOOK'S WAITS ARE BOUNDED AND FAIL CLOSED ───────────────────────────

test('#104 G5 PreToolUse: the gate wait is BOUNDED and the fallback is a DENIAL', () => {
  withScratch('g5', (fx) => {
    bind(fx);
    const blocker = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 501,
      processLike: { kill: () => true },
    });
    assert.equal(blocker.ok, true, 'setup: the runner is mid-write');

    let clock = 1_000_000;
    const slept = [];
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      pid: 502,
      processLike: { kill: () => true },
      now: () => clock,
      sleep: (ms) => { slept.push(ms); clock += ms; },
      gateBudgetMs: HOOK_GATE_BUDGET_MS,
    });

    // BOUNDED: a hook that blocks forever hangs the agent, so the wait has a
    // budget and the budget is spent in bounded sleeps.
    assert.ok(slept.length > 0, 'it waited');
    const total = slept.reduce((a, b) => a + b, 0);
    assert.ok(total <= HOOK_GATE_BUDGET_MS,
      `the total wait is bounded by HOOK_GATE_BUDGET_MS, got ${total}`);
    assert.ok(total >= HOOK_GATE_BUDGET_MS - 10, 'and it actually used its budget before giving up');
    // BOUNDED EVEN IF THE CLOCK DOES NOT MOVE. An earlier draft bounded the wait
    // only by a deadline, so a constant clock -- injected by the very next
    // assertion -- looped forever instead of denying, which is the agent hanging
    // on a hook. Two independent bounds now: the deadline and an attempt
    // ceiling.
    const frozen = [];
    const frozenVerdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      pid: 503,
      processLike: { kill: () => true },
      now: () => 7,
      sleep: (ms) => frozen.push(ms),
      gateBudgetMs: HOOK_GATE_BUDGET_MS,
    });
    assert.equal(frozenVerdict.action, 'deny', 'a frozen clock still terminates, fail-closed');
    assert.ok(frozen.length <= Math.ceil(HOOK_GATE_BUDGET_MS / 5) + 2,
      `and the attempt ceiling holds it, got ${frozen.length} attempts`);

    // FAIL CLOSED: the tool call does not reach the permission check, so no
    // dialog appears, so there is nothing for an automatic keystroke to answer.
    // A denial is recoverable; an automatic "Yes, and switch to accept edits
    // for this session" is not.
    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.code, 'interlock-gate-busy');
    // AND IT RECORDS NOTHING. A denied call never reaches a dialog, so a marker
    // for it would hold automation for a check that cannot happen.
    const state = readState({ dir: fx.dir });
    assert.equal(state.ok, false, 'nothing was written');
    releaseGate(blocker.handle);
  });
});

test('#104 G6 PostToolUse and Stop ALLOW when they cannot take the gate: failing to CLEAR is already safe', () => {
  withScratch('g6', (fx) => {
    bind(fx);
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, pending: { toolu_A: { tool: 'Read', ts: 0 } } } });
    const blocker = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 601,
      processLike: { kill: () => true },
    });
    for (const event of ['PostToolUse', 'Stop']) {
      const verdict = runHook({
        payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
        event,
        env: fx.env,
        pid: 602,
        processLike: { kill: () => true },
        now: () => 0,
        sleep: () => {},
        gateBudgetMs: 0,
      });
      assert.equal(verdict.action, 'allow',
        `${event} must not deny: its failure mode is that the marker is not cleared, `
        + 'which HOLDS automatic writes -- already the safe direction. Denying there '
        + 'would cost liveness and buy nothing.');
      assert.equal(verdict.code, 'interlock-gate-busy', 'and it says so');
    }
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), ['toolu_A'],
      'the marker is still pending, which is what holds the write');
    releaseGate(blocker.handle);
  });
});

test('#104 G7 NO MANAGED RUNNER MEANS NO OPINION: with no proof the hook is inert, never a denial', () => {
  withScratch('g7', (fx) => {
    // The symmetry that makes this not a fail-open: the RUNNER's side requires
    // the proof it writes itself, so absence holds automatic writes on one side
    // and silences the hook on the other. Two views of one fact.
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'inert',
      'an unmanaged seat must not have its tool calls denied by a runner that is not there');
    assert.equal(verdict.code, 'interlock-proof-missing');
    assert.equal(fs.existsSync(path.join(fx.dir, STATE_NAME)), false, 'and nothing is written');

    // The runner's half of the same absence.
    const evidence = interlockEvidence({
      dir: fx.dir,
      nonce: NONCE,
      sessionId: SESSION,
      runnerPid: 701,
      hookPath: HOOK_PATH,
      hookSha256: 'whatever',
    });
    assert.equal(evidence.ok, false, 'the runner refuses on the same file being absent');
    assert.equal(evidence.code, 'interlock-proof-missing');
  });
});

test('#104 G8 a permission check with no usable tool_use_id is RECORDED, never dropped', () => {
  withScratch('g8', (fx) => {
    bind(fx);
    // A call that cannot be named is still a call that raises a dialog. The
    // asymmetry is the safety property: missing an OPEN is a fail-open, so an
    // unnameable one gets a synthetic key that only a Stop sweep clears.
    const verdict = runHook({
      payload: hookPayload({ tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 5,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'allow');
    const ids = Object.keys(readState({ dir: fx.dir }).state.pending);
    assert.equal(ids.length, 1, 'it is pending');
    assert.match(ids[0], /^anon:/, 'under a synthetic key, so it cannot collide with a real id');

    // A PostToolUse for a DIFFERENT id cannot clear it -- pairing is by id.
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_OTHER' }),
      event: 'PostToolUse',
      env: fx.env,
      now: () => 6,
      sleep: () => {},
    });
    assert.equal(Object.keys(readState({ dir: fx.dir }).state.pending).length, 1,
      'one result settles its own call and no other');

    // The turn ends. THAT is what clears it.
    runHook({ payload: hookPayload(), event: 'Stop', env: fx.env, now: () => 7, sleep: () => {} });
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), []);
  });
});

test('#104 G9 a pending map at its cap DENIES rather than discarding a call or growing without bound', () => {
  withScratch('g9', (fx) => {
    bind(fx);
    const pending = {};
    for (let i = 0; i < PENDING_MAX; i += 1) pending[`toolu_${i}`] = { tool: 'Read', ts: 0 };
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, pending } });
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_ONE_TOO_MANY', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'deny',
      'the two alternatives are discarding a pending call (the fail-open) and an '
      + 'unbounded file; a denial is neither');
    assert.equal(verdict.code, 'interlock-pending-overflow');
  });
});

test('#104 G10 THE DRAIN: a hook arriving just after a runner write waits out the bytes in flight', () => {
  withScratch('g10', (fx) => {
    bind(fx);
    // pty.write() RETURNING is not the child having CONSUMED the byte, so the
    // runner's write is causally before the marker while the byte may still be
    // travelling. The wait belongs in the hook: it is a throwaway process, so a
    // bounded synchronous wait there costs the runner nothing and cannot stall
    // the runner's event loop.
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, last_write_at: 10_000 } });
    const slept = [];
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 10_030,
      sleep: (ms) => slept.push(ms),
    });
    assert.deepEqual(slept, [INTERLOCK_DRAIN_MS - 30], 'exactly the remainder, no more');

    // A write long past: no drain at all.
    const later = [];
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 10_000 + INTERLOCK_DRAIN_MS + 1,
      sleep: (ms) => later.push(ms),
    });
    assert.deepEqual(later, [], 'and it is not an unconditional delay on every tool call');
  });
});

test('#104 G11 a PreToolUse that cannot RECORD the check denies; a PostToolUse that cannot does not', () => {
  withScratch('g11', (fx) => {
    bind(fx);
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1 } });
    // Everything readable, nothing writable: the one case where the hook has
    // found a managed runner and still cannot do its job.
    const fsImpl = {
      ...fs,
      openSync: (target, flags) => {
        if (String(target).endsWith(`${STATE_NAME}`) || String(target).includes(`${STATE_NAME}.tmp-`)) {
          const e = new Error('read-only'); e.code = 'EROFS'; throw e;
        }
        return fs.openSync(target, flags);
      },
    };
    const denied = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      fsImpl,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(denied.action, 'deny',
      'it could not record the check, so the runner would read an empty pending map '
      + 'and write -- the fail-open. At that instant a denial is the only closed answer.');
    assert.equal(denied.code, 'interlock-state-write-failed');

    const allowed = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PostToolUse',
      env: fx.env,
      fsImpl,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(allowed.action, 'allow', 'a failure to CLEAR only holds automation');
  });
});

// ─── THE RUNNER'S EVIDENCE LEGS ─────────────────────────────────────────────

test('#104 G12 the four evidence legs each refuse by their own name, and all four are required', () => {
  withScratch('g12', (fx) => {
    const nonce = bind(fx, { pid: 1201 });
    const good = {
      dir: fx.dir,
      nonce,
      sessionId: SESSION,
      runnerPid: 1201,
      hookPath: HOOK_PATH,
      hookSha256: null,
    };
    // Compute the real digest so leg 2 can pass.
    good.hookSha256 = crypto.createHash('sha256').update(fs.readFileSync(HOOK_PATH)).digest('hex');

    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1 } });
    assert.equal(interlockEvidence(good).ok, true, 'setup: all four legs pass');

    assert.equal(interlockEvidence({ ...good, nonce: 'other' }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, sessionId: 'other' }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, runnerPid: 9 }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, hookPath: path.join(fx.base, 'nope.mjs') }).code, 'interlock-hook-missing');
    assert.equal(interlockEvidence({ ...good, hookSha256: 'f'.repeat(64) }).code, 'interlock-hook-changed');

    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 0 } });
    assert.equal(interlockEvidence(good).code, 'interlock-hook-not-observed',
      'leg 3 is the EMPIRICAL one: the host must actually have run the hook');

    // Leg 4 is a DELTA against the last agreement point, not an absolute
    // comparison -- the reader's baseline walk parses up to a megabyte of
    // history whose calls the hook handled before the state file existed.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 3 } });
    assert.equal(interlockEvidence({ ...good, toolUsesObserved: 500 }).ok, true,
      'with no checkpoint, history is absorbed rather than charged to the hook');
    const first = interlockEvidence({ ...good, toolUsesObserved: 500 });
    assert.deepEqual(first.nextCheckpoint, { observed: 500, preRuns: 3 });
    // Two more tool calls the reader saw; the hook ran for neither.
    const stale = interlockEvidence({ ...good, toolUsesObserved: 502, checkpoint: first.nextCheckpoint });
    assert.equal(stale.ok, false, 'a hook that stopped running is detected on the next call');
    assert.equal(stale.code, 'interlock-hook-missed-tool-calls');
    assert.deepEqual(stale.detail, { hook_runs_since: 0, tool_uses_since: 2 });
    // The hook catches up.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 5 } });
    assert.equal(interlockEvidence({ ...good, toolUsesObserved: 502, checkpoint: first.nextCheckpoint }).ok, true,
      'and the hold lifts: it is a comparison, not a latch');
  });
});

test('#104 G13 AGE NEVER RELEASES a pending marker: it renames the hold', () => {
  const state = { ...emptyState(NONCE), pending: { toolu_A: { tool: 'Read', ts: 1000 } } };
  assert.equal(pendingProblem(state, { now: 1500, staleMs: 120000 }).code, 'interlock-permission-pending');
  const old = pendingProblem(state, { now: 1000 + 10 * 60 * 1000, staleMs: 120000 });
  assert.equal(old.code, 'interlock-pending-stale',
    'A HUMAN CAN READ A DIALOG FOR MINUTES. Age cannot tell that from a marker nothing '
    + 'cleared, so it changes the NAME -- which is what lets an operator tell them apart '
    + '-- and both HOLD. An age-based release would be this issue by a timer.');
  assert.equal(pendingProblem({ ...emptyState(NONCE) }), null, 'an empty map is not a problem');
});

test('#104 G14 old binding directories are swept, bounded in age and in count', () => {
  withScratch('g14', (fx) => {
    const root = fx.env.AIGENT_INTERLOCK_DIR;
    const old = path.join(root, 'session-long-gone');
    fs.mkdirSync(old, { recursive: true });
    const ancient = Date.now() - (GATE_STALE_MS + 7 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, ancient / 1000, ancient / 1000);
    const fresh = path.join(root, 'session-recent');
    fs.mkdirSync(fresh, { recursive: true });

    const removed = sweepSessionDirs({
      memRoot: fx.memRoot, keepSessionId: SESSION, env: fx.env, now: Date.now(),
    });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false, 'the old binding is collected');
    assert.equal(fs.existsSync(fresh), true, 'a recent one is not');
    assert.equal(fs.existsSync(fx.dir), true, 'and never the current binding');
  });
});

test('#104 G15 a state file that will not parse is a refusal, never an empty pending map', () => {
  withScratch('g15', (fx) => {
    const nonce = bind(fx, { pid: 1501 });
    fs.writeFileSync(path.join(fx.dir, STATE_NAME), '{"pending": "not an object"}');
    const read = readState({ dir: fx.dir });
    assert.equal(read.ok, false);
    assert.equal(read.code, 'interlock-state-unreadable');
    assert.equal(read.state, null,
      'the shape check matters as much as the parse: a `pending` that is not an object '
      + 'would enumerate to zero keys, which reads as "no permission check"');
    // And the hook, finding the state unusable, REPLACES it rather than
    // appending to a shape it cannot trust -- its own write is the recovery.
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'allow');
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), ['toolu_A']);
    assert.equal(readState({ dir: fx.dir }).state.nonce, nonce);
  });
});

test('#104 G16 a session id that could escape the interlock root resolves to nothing', () => {
  withScratch('g16', (fx) => {
    for (const hostile of ['../..', 'a/b', 'a\\b', '', '.'.repeat(200)]) {
      const resolved = sessionDir({ memRoot: fx.memRoot, sessionId: hostile, env: fx.env });
      assert.equal(resolved, null, `a session id of ${JSON.stringify(hostile)} names no directory`);
    }
    assert.notEqual(sessionDir({ memRoot: fx.memRoot, sessionId: SESSION, env: fx.env }), null);
  });
});

test('#104 G17 the proof file is written atomically and is readable by the other side', () => {
  withScratch('g17', (fx) => {
    bind(fx, { pid: 1701 });
    const raw = fs.readFileSync(path.join(fx.dir, PROOF_NAME), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),
      ['created_at', 'hook_path', 'hook_sha256', 'nonce', 'runner_pid', 'session_id']);
    assert.deepEqual(fs.readdirSync(fx.dir).filter((f) => f.includes('.tmp-')), [],
      'no temp file is left behind -- the rename is the commit');
  });
});
