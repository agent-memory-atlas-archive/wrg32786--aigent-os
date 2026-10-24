# Dialog readiness

The managed runner (`daemons/pty-runner.mjs`) is the sole writer to a Claude Code
child's PTY. It writes automatically, without an operator keystroke behind it, in
a small number of places. This document is about one hazard those writes share:
**a permission dialog on screen turns an automatic keystroke into an answer.**

Issue #104.

## The defect

`_writeCapsuleRequest`'s only write gate was `composer.knownEmpty`. The input
ownership tracker models the composer's **text line** — what the operator may
have typed and not submitted. It knows nothing about a modal dialog.

With a permission dialog open and nothing typed, `knownEmpty` is `true`. So the
runner wrote `/context-capsule` and, 400 ms later, a `CONTROL_ENTER`.

A bare Enter at that dialog selects option 1, **Yes**:

```
Do you want to proceed?
❯ 1. Yes
  2. Yes, and switch to accept edits (auto-approve file edits and common
     file commands) for this session
  3. No
Esc to cancel · Tab to amend
```

Option 2 is one row down. An Enter that landed there would disable prompting for
the rest of the session.

## The signal

While the host is waiting to run a tool — which includes the entire time a
permission dialog is on screen — the bound transcript holds a `tool_use` block
with **no matching `tool_result`**.

Measured on binary 2.1.309, capture `2026-10-23T16:09Z`:

| time | event |
|---|---|
| 16:09:55.083Z | `tool_use` written, id `toolu_016Dhtgz…`, name `Read` |
| 16:09:55.993Z | permission dialog on screen |
| 16:09:57.195Z | ESC sent |
| 16:09:57.250Z | `tool_result` for that id, `is_error: true`, *"The user doesn't want to proceed with this tool use…"* |

The pairing completes whichever way the dialog is answered — approval,
cancellation, or error. **A post-hoc read of a finished transcript therefore
shows zero unanswered ids.** The signal exists only while it matters, which is
why it is read live at each write boundary rather than reconstructed afterwards.

### What is deliberately not used

The transcript records `"permissionMode":"default"` even when the child was
launched with `--permission-mode manual` (verified in the same capture). The
transcript's mode vocabulary is not the CLI's. Nothing here keys on that value.

## The reader

`toolCallRecord` plus `_noteToolCallWatch` / `_stepToolCallWindow` /
`_checkToolCalls` / `_automaticWriteReadiness`, all in `daemons/pty-runner.mjs`.
It reuses the existing bounded JSONL reader (`readCompleteLines`) and the
existing watch-object pattern.

**Carriers are measured, not guessed.** The only records carrying these blocks
in the captures were `assistant/tool_use`, `user/tool_result`, and
`api-request-blob/tool_result`. The blob is a replay of an API request payload,
not an event, so **settlement is read only from a top-level `"type":"user"`
record**.

That restriction is load-bearing, not tidiness. The blob's position relative to
the authoritative record is not stable. On 2.1.309 it followed. On 2.1.310 (live
run `2026-10-24T18:59Z`, session `a1b3a275`) it **preceded** it, by offset and by
0.76 s:

```
451495  assistant         18:59:02.114Z   tool_use     toolu_01Rhprv… (Glob)
453586  api-request-blob  (no timestamp)  tool_result  toolu_01Rhprv…
455821  user              18:59:02.870Z   tool_result  toolu_01Rhprv…
```

A reader that accepted the blob would release the call *early*, on a record the
host had not yet committed as the answer.

**Paired by id.** One result settles its own call and no other. A cancellation or
error result settles its own call and authorizes nothing: readiness answers *may
an automatic write go out*, never *is a business action authorized*. The clear
stays gated on the cycle's capsule ack exactly as before.

**Anchored, so a bounded tail is enough.** The API cannot be called again while a
`tool_use` in the previous assistant message is unanswered. So a *new* top-level
`assistant` record proves every call opened before it has been answered. That one
protocol fact lets a bounded tail read establish the whole outstanding set
without reading from byte zero, and it discharges both a restart's unknown prefix
and an oversize record stepped over.

**Restart while a call is pending** is covered by that tail read, and needs no new
persisted state. A new process cannot start its cursor at the transcript's end —
the pending `tool_use` would already be behind it and its answer would never be
seen either, so the set would read empty *forever*, not briefly. It also cannot
read from byte zero. It starts one bounded span back from the end and scans
forward. A persisted offset was considered and rejected: the persisted-offset
machinery exists for evidence that must not be re-read (re-reading an ack is an
authorization bug), whereas readiness is a live predicate re-derivable from the
tail. A persisted offset would only add a way for the record and the file it
indexes to disagree, which is #90 shape 1.

### No fail-open, by construction

Every one of these is a **named NOT-READY**, never an empty outstanding-call set:

| condition | code / reason |
|---|---|
| transcript path will not resolve | `tool-call-transcript-unresolved` |
| stat fails for any reason other than ENOENT | `tool-call-transcript-unreadable` |
| size is not a safe non-negative integer | `tool-call-transcript-size-invalid` |
| a window read throws | `tool-call-window-read-failed` |
| a marker-carrying line will not parse | `tool-call-record-unreadable` |
| a `tool_use` with no usable `id` | `tool-call-record-unreadable` |
| the bounded tail contained no anchor | `tool-call-baseline-unanchored` |
| the cursor is short of the transcript end | `runner-tool-call-reader-behind` |
| one or more calls outstanding | `runner-tool-call-outstanding` |

A cursor short of the end covers both a record that is half-written *right now*
(it may be the `tool_use`) and a transcript that outgrew one bounded catch-up
pass.

**The two cases that are positive evidence rather than ignorance**, and why:

- a **zero-length** transcript — the host has written no records, and a tool
  permission dialog cannot exist without a `tool_use` record;
- **ENOENT on a resolved path** — Claude Code creates the transcript with its
  first record, so an absent file means the same thing.

Refusing those would cost liveness and buy nothing. The one exposure they share
is a wrong `sessionId` pointing the reader at another seat's file; that is the
same exposure the ack scan already carries, bounded by the same boot/session
binding guard.

### Bounds

| bound | value | why |
|---|---|---|
| window | 256 KiB | the existing `CAPSULE_ACK_WINDOW_BYTES` |
| baseline span | 4 windows | the 2.1.309 capture's last anchor sat 177 KiB before the end of a 465 KiB file; 4× is headroom for an attachment-heavy tail |
| baseline reads | 8 | `readCompleteLines` consumes only to the last complete line, so 200 KiB records advance ~200 KiB per 256 KiB read; 4 reads covered only ~800 KiB of a 1 MiB span |
| catch-up reads | 4 per check | past that the verdict is `reader-behind`, not a stale answer |
| far-behind | > 4 windows | re-baseline from the tail rather than crawl |
| Enter deferrals | 150 | ≈ 1 minute at the default 400 ms delay |

**Far behind: jump, don't crawl.** Forward-only is load-bearing for the *ack*
reader. For readiness it is backwards: a position nearer the end is strictly
better evidence. A 2.5 MiB append arriving between two ticks left a crawling
reader at `reader-behind` for several ticks, holding writes with nothing to wait
for. Re-baselining converges in one tick at the same bounded cost, and keeps the
fail-closed property — the jump sets `unknownOpen`, which only an anchor
discharges.

## The write paths, and where each gets readiness

| path | what it writes | readiness source |
|---|---|---|
| `_writeOperator` | the operator's own bytes | **not gated.** These are the operator's keystrokes. Their Enter at a dialog is their decision, and gating it would make the runner swallow operator input. |
| `_fireCapsuleRequest` via `_writeCapsuleRequest` | `/context-capsule` | **gated.** Fresh read in `_writeCapsuleRequest`, immediately after the composer guard and *before* the ownership tally — so a deferral does not spend the cycle_id latch. |
| `_writeCapsuleRequestEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time. On a hold, rescheduled (see below). |
| `_writeControl` via `commitClearSubmission` | `/clear` | **gated** at `_prepareSubmission`, after the ack gate and before the token is minted: nothing is spent, no hold taken, no intent persisted. *Not* re-gated in `commitClearSubmission` — see below. |
| `_writeControlEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time, after the existing submission-phase guard. On a hold, rescheduled. |
| `_fireWake` | `WAKE_MESSAGE` | **not gated, structurally.** See below. |
| `_writeWakeEnter` | `CONTROL_ENTER` | **not gated, structurally.** See below. |
| `_tickWakeSubmission` retry | `CONTROL_ENTER` | **gated.** Fresh read after the settle and budget gates. A hold does *not* consume the retry budget, so the owed retry still happens. |
| `COMPOSER_KILL_LINE` (`commitClearSubmission`, `_flushQueuedInput`) | `Ctrl-U` | **not gated.** `Ctrl-U` is not a selection key and cannot answer the dialog. Gating it would break the stranded-text protection, which exists precisely to stop operator bytes concatenating onto stranded command text — the kill-line is the *protection*, not a hazard. |

### Why the clear is not re-gated at commit

The only refusal mechanism available in `commitClearSubmission` is
`_abortPrepared`, which is **terminal** (`automationEnabled = false`,
`phase = 'abandoned'`). It would kill automation for the rest of the session over
a dialog that resolves in seconds. The prepare-to-commit gap is one scheduler
turn, and it is reported in the residual window below rather than closed with a
guard whose only available outcome is worse than the hazard. The clear's *Enter*
— the keypress — is gated.

### Why the wake text and its first Enter are not gated

Both fire inside `_rebindAfterClear`, onto a context the host has just torn down
and rebuilt. Nothing has been submitted to that context, so no `tool_use` can
exist and no tool dialog can be open. The hazard is structurally absent.

That window also precedes the new session's *first* transcript record — the
deterministic suite asserts exactly that (`fs.existsSync(wakeTranscriptPath(h))`
is `false` at the wake Enter). ENOENT is read as the positive answer it is, so
the reader would not hold them either way, but the structural argument is the
load-bearing one.

The **retry** is different, and is gated. It fires on later ticks, after the first
Enter released the input hold and queued operator bytes went in behind it. The
operator's own prompt can be running by then, with a dialog up, while the wake's
record still has not appeared — which is precisely the state the retry exists
for.

## The deferred Enter

The dangerous ordering: the text write has already placed command text in the
composer, and the dialog appears in the 400 ms gap **before** the Enter.

The Enter must not be written. It must also not be *dropped*, because dropping it
strands the line silently and then releases queued operator bytes onto it. So
`_deferAutomaticEnter` **reschedules** it: same token, same handle slot. Every
protection the two-phase write already had stays intact for as long as the
deferral lasts:

- `composerMayHoldControlText` stays **true**, so a later queued-input flush
  leads with a kill-line instead of concatenating onto the stranded text;
- `enterHandle` stays **non-null**, so `_flushQueuedInput` keeps queued operator
  chunks *behind* the pending Enter and nothing interleaves;
- the token is unchanged, so a clear submission beginning meanwhile still bumps
  it and the callback still becomes the no-op it should be.

At the bound (150 reschedules, ≈ 1 minute at the default delay) the Enter is
**not** written: the line is declared stranded by name
(`runner-automatic-enter-stranded`), the handle slot is released, and the flag
stays up so the kill-line protection fires on the next queued-input release.
Stranding loudly is the correct outcome, because the Enter is the defect. A
scheduler that throws or returns no handle during a reschedule is treated
identically.

## The residual window

**A last-moment transcript read is not an atomic lock.** It proves no call was
outstanding *at the moment of the stat*. Between that stat and the `pty.write`,
the child may issue a `tool_use` and raise a dialog. No transcript evidence can
make that read atomic, and this document does not claim it is.

Precisely characterised, the residual is:

1. **The read-to-write race.** Sub-millisecond to a few milliseconds of
   synchronous work (stat, bounded read, parse, write). A call issued inside it
   is invisible to that write. `#104 D20` in
   `daemons/tests/pty-runner.test.mjs` exercises exactly this and asserts the
   write *does* go out — the gap is in the suite as a fact, not a claim.

   What the design still buys in that race: the two-phase shape means the
   *keypress* re-reads 400 ms later. D20 asserts that the text lost the race and
   the Enter was still held.

2. **The transcript-versus-screen ordering.** The guard assumes the `tool_use`
   record becomes readable before the dialog can accept a keystroke. Two
   independent observations, both transcript-first:

   | run | binary | `tool_use` | dialog on screen | notice |
   |---|---|---|---|---|
   | 2026-10-23T16:09Z | 2.1.309 | 55.083Z | 55.993Z | 0.91 s |
   | 2026-10-24T18:58Z | 2.1.310 | 49.439Z | ≤ 52.058Z (400 ms poll) | ≈ 2.2 s |

   Two samples with the same sign is **not** a guarantee. The ordering is not
   contractual, nothing in the host documents it, and a future build could flush
   the record after painting the dialog. It is not bounded below by anything the
   runner can observe.

3. **The clear's prepare-to-commit gap.** One scheduler turn between the gate in
   `_prepareSubmission` and the `/clear` text write in `commitClearSubmission`.
   Not closed, for the reason given above; the clear's Enter is gated.

4. **A rotated or deleted transcript on a live session with a dialog up.** ENOENT
   is read as "no records", which would be wrong in that pathological case. No
   observation of it; stated for completeness.

### What would close (1) and (2), and why it is not in this change

Transcript evidence cannot close them: the transcript is a record of what the
child *did*, written concurrently with the dialog, not a lock taken before it.

The smallest **supported** host mechanism that would close them causally is a
`PreToolUse` hook. Claude Code runs `PreToolUse` before the tool call and before
the permission check, synchronously — so a marker written there is *causally*
before the dialog rather than concurrent with it. This repository already uses
that mechanism (`daemons/gateguard.mjs`, `daemons/memory-budget-guard.mjs`,
`daemons/model-tier-guard.mjs`, wired in `.claude/settings.json.template`), so it
would be reuse rather than invention.

It is **not** in this change, deliberately, because keying readiness on a hook
marker is only sound if the runner can prove the hook is live in the bound
session. Absence of a marker would otherwise mean "no tool call" and "the hook
is not installed" — indistinguishable, and the second reading is a fail-open
worse than the gap it closes. Establishing and verifying that installation
per-session is a larger change than a bounded repair, and shipping half of it
would replace a named residual with a silent one.

## Verification

### Deterministic

`daemons/tests/pty-runner.test.mjs`, vectors `#104 D1`–`D20`. 17 of 20 are red
before the fix; `D1` is the first red and is the reported defect with nothing
else wrong (the vector asserts the composer is clean in setup, so the old guard
permits the write).

### Host evidence

`scratchpad/p104/driver2.cjs` — bounded, isolated, cancel-only, never approves.
It runs a real `claude.exe` against an authenticated disposable profile with
`permissions.ask: ["Read"]`, and drives the **shipped** reader and the **shipped**
`_writeControlEnter` (methods borrowed from `ManagedPtyRunner.prototype`, so the
code under test is the code that ships) against the **live** transcript, with a
spy PTY so nothing can reach the child.

Live run `2026-10-24T18:58Z`, binary **2.1.310**, session `a1b3a275`:

- **No automatic answer.** Three samples while a real dialog was on screen:
  `ready=false`, `runner-tool-call-outstanding`, outstanding id
  `Read:toolu_01B8HSba9Dtj…`. The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up.
- **Cancellation recovers.** ESC only. Within 1.5 s readiness returned and the
  boundary wrote exactly one Enter — not wedged. The cancellation settled its
  own call (`Read`, `is_error: true`).
- **Ordinary success does not stick.** `Glob` (in `permissions.allow`, so no
  dialog at all) executed with `is_error: false`. The reader observed the call
  outstanding while it ran, then released; three post-execution samples all
  ready, all writing.

Raw artifacts: `scratchpad/p104/run2/` (`driver2.log`, `samples.json`,
`screen.log`, `PROMPT.txt`, `CANCELLED.txt`).
