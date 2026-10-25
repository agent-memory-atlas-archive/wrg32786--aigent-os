# Dialog readiness

The managed runner (`daemons/pty-runner.mjs`) is the sole writer to a Claude Code
child's PTY. It writes automatically, without an operator keystroke behind it, in
a small number of places. This document is about one hazard those writes share:
**a permission dialog on screen turns an automatic keystroke into an answer.**

Issue #104.

## The defect

`_writeCapsuleRequest`'s only write gate was `composer.knownEmpty`. The input
ownership tracker models the composer's **text line** -- what the operator may
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

While the host is waiting to run a tool -- which includes the entire time a
permission dialog is on screen -- the bound transcript holds a `tool_use` block
with **no matching `tool_result`**.

Measured on binary 2.1.309, capture `2026-10-23T16:09Z`:

| time | event |
|---|---|
| 16:09:55.083Z | `tool_use` written, id `toolu_016Dhtgz…`, name `Read` |
| 16:09:55.993Z | permission dialog on screen |
| 16:09:57.195Z | ESC sent |
| 16:09:57.250Z | `tool_result` for that id, `is_error: true`, *"The user doesn't want to proceed with this tool use…"* |

The pairing completes whichever way the dialog is answered -- approval,
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
host had not yet committed as the answer. Reproduced on the second 2.1.310 run
(session `e8cd53af`): offsets 451531 `assistant tool_use`, 453622
`api-request-blob tool_result`, 455857 `user tool_result` -- the blob again ahead
of the authoritative record.

**Paired by id.** One result settles its own call and no other. A cancellation or
error result settles its own call and authorizes nothing: readiness answers *may
an automatic write go out*, never *is a business action authorized*. The clear
stays gated on the cycle's capsule ack exactly as before.

**Anchored, so a bounded tail is enough.** The API cannot be called again while a
`tool_use` in the previous assistant message is unanswered. So a *new API
response* proves every call from earlier responses has been answered. That one
protocol fact lets a bounded tail read establish the whole outstanding set
without reading from byte zero, and it discharges both a restart's unknown prefix
and an oversize record stepped over.

**The anchor is a response, not a record**, and the difference is a fail-open.
One response is written as *several* top-level `assistant` records, one per
content block, sharing `message.id` / `requestId` and numbered by
`apiBlockIndex`. Measured in both captures:

```
blockIdx=0  reqId=req_011CgMaKpY…  msg.id=msg_011CgMaKpq…  thinking
blockIdx=1  reqId=req_011CgMaKpY…  msg.id=msg_011CgMaKpq…  tool_use
```

A response that issues **parallel** tool calls therefore lands as two records
carrying `tool_use` under one response id. A rule that cleared the set on every
`assistant` record would drop call A the moment call B's record arrived -- and
once B's own result settled B, the set would read *empty* with A's dialog still
on screen.

(The block splitting is measured. The parallel-call shape is *inferred* from it,
because both captures ran haiku issuing one tool at a time. `#104 D21` constructs
it from the measured record shape.)

So the anchor is scoped to the response identity, and that identity is **tagged
with the space it came from** -- `msg:<message.id>`, else `req:<requestId>`. A
record of a *different* response **in the same space** clears the set; a record
of the *same* response is a continuation block that adds its ids and clears
nothing; an unidentifiable record clears nothing either; and a record whose
space *differs* from the one currently held clears nothing either, because across
a space change the reader cannot tell one response from two.

That tag exists because the bare fallback was a fail-open on a **partial**
disappearance, not a total one: one response whose block 0 carried only
`requestId` and whose block 1 carried only `message.id` produced two different
strings, so block 1 read as a new response and cleared block 0's live call --
while nothing about the conversation had changed, only which field the host
happened to write. Latent (both fields were measured present on every assistant
record of both captures) but cheap to make impossible. `#104 D36`/`D37`.

The `unknownOpen` **discharge** needs more than that, because it claims calls the
window never saw are answered, and an earlier block of *this* response could have
opened one. Two independent proofs, either sufficient:

- `apiBlockIndex === 0` -- this record is the start of its response, so it has no
  earlier block;
- the **second** distinct response **since the unknown was raised** -- the first
  one's existence proved every call before it was answered, and the second proves
  every call of the first was answered. Together they cover the unknown prefix
  with no block index at all, which keeps the discharge working if that field
  ever changes.

**That second proof is only valid for the prefix of the count**, and getting
that wrong was a third fail-open. `responsesSeen` was a running total over the
whole scan and was never reset, so it was already ≥ 2 after the first few
records of any real tail -- the clause was effectively always satisfied. It is now
**reset whenever an unknown is raised mid-scan** (the oversize-record step
below), which restores the precondition the argument needs. `#104 D27`/`D28`,
with `D29`/`D30` holding the two liveness directions.

If both fields ever disappear from the format, the reader goes conservative
rather than permissive: no clear, no discharge, so a baseline reports
`tool-call-baseline-unanchored` -- loud and fail-closed. A *partial*
disappearance is covered by the space tag above, which is what makes that
sentence true rather than merely intended.

**A sidechain (subagent) response is not an anchor either**, and missing that is
the same fail-open by a second route. The anchor argument -- the API cannot be
called again while a call is unanswered -- holds only *within one conversation*. A
subagent is a different conversation driven by its own API calls, so its
responses prove nothing about the main conversation's outstanding calls. Measured
on a real `subagents/agent-*.jsonl` (2026-10-24), a sidechain assistant record
carries its **own** `message.id`, `requestId` *and* `apiBlockIndex`:

```
isSidechain=true  blockIdx=0  msg.id=msg_011CfyAoyz…  thinking
isSidechain=true  blockIdx=1  msg.id=msg_011CfyAoyz…  text
isSidechain=true  blockIdx=2  msg.id=msg_011CfyAoyz…  tool_use
```

So it satisfies **both** freshness and start-of-response, and an unscoped anchor
would clear -- and discharge the unknown prefix for -- a *main*-conversation call
whose dialog is on screen. Such a record therefore carries `response: null` and
`startsResponse: false`: it opens its ids and can neither clear nor discharge.
Its calls still **count**, deliberately, because a subagent's tool call raises the
same dialog on the same screen (`#104 D5`), and its own `tool_result` still
settles them by id. This is the same exclusion `isAckLine` and
`isCapsuleRequestRecord` already make, both added for #79.

On reachability, stated rather than implied: on binary 2.1.310 subagent records
are written to a **separate** `subagents/agent-*.jsonl` file and the bound
transcript holds none of them (0 `isSidechain:true` across six live main
transcripts), so this is defence for the **inline** shape rather than a live
defect fix. The inline shape is the one #79 had to exclude and the one `#104 D5`
asserts, so the reader does not get to assume it away.

**Restart while a call is pending** is covered by that tail read, and needs no new
persisted state. A new process cannot start its cursor at the transcript's end --
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
| the path is not a regular file (directory, FIFO, socket) | `tool-call-transcript-not-a-file` |
| the file is absent, at a boundary not entitled to read that as "no records" | `tool-call-transcript-absent` |
| size is not a safe non-negative integer | `tool-call-transcript-size-invalid` |
| a window read throws | `tool-call-window-read-failed` |
| a marker-carrying line will not parse | `tool-call-record-unreadable` |
| a `tool_use` with no usable `id` | `tool-call-record-unreadable` |
| the bounded tail contained no anchor | `tool-call-baseline-unanchored` |
| a record larger than one window was stepped over | `tool-call-oversize-record-unread` |
| the cursor is short of the transcript end | `runner-tool-call-reader-behind` |
| one or more calls outstanding | `runner-tool-call-outstanding` |

A cursor short of the end covers both a record that is half-written *right now*
(it may be the `tool_use`) and a transcript that outgrew one bounded catch-up
pass.

**The oversize step has its own code on purpose.** "A record bigger than the
window went unread at offset N" and "the tail held no anchor" are different
situations with different operator answers, and the offset plus the unread byte
count are what make the first one actionable. They shared a name until `#104
D31`. The shape is ordinary rather than exotic: a `Write`/`Edit`/`MultiEdit`
whose `input.content` carries more than 256 KiB of file body is exactly the tool
that raises the dialog, and that record cannot be parsed in one window.

**Two residuals here are accepted rather than fixed, and both are liveness, not
safety:**

- a **degraded** reader holds every automatic write until the transcript grows by
  a further 256 KiB, because that is the condition for re-attempting the
  baseline. On a quiet seat a standing fault therefore holds automation for as
  long as the seat stays quiet. The alternative -- re-scanning the same megabytes
  every tick -- was the cost the growth gate was added to avoid, and the hold is
  named on every tick rather than silent.
- the **unreadable** branch stops at the offending record and advances the cursor
  to the end of the window it was reading, so the remaining complete records in
  that window are discarded unparsed. They are re-read only if the reader
  re-baselines. Conservative in the safety direction (the set is not updated from
  them), and the refusal is named.

**What this table does not cover, stated here rather than only in the residual
section:** a discharge is sound for the *main* conversation only. A
main-conversation anchor that discharges an unread region which held an inline
**sidechain** call is unsound, and is not blocked -- the mirror of the
sidechain-anchor exclusion. See residual (5); it is accepted because an unread
region's content is unknowable, not because it was overlooked.

**One case is positive evidence rather than ignorance:** a **zero-length**
transcript. The host has written no records, and a tool permission dialog cannot
exist without a `tool_use` record.

**ENOENT on a resolved path is positive evidence only at some boundaries**, and
treating it as universal was a sixth fail-open. Claude Code creates the
transcript with its first record, so "no file" does mean "no records" -- but
that is a fact about a **new** session. The capsule-request and clear boundaries
only fire for a session at ~80% context pressure, which provably **has** a
transcript, so absence there cannot mean "no records yet"; it means the path
mis-resolved (wrong session id, cwd or home). Answering ready wrote command text
plus a bare Enter into a session the runner could not see.

So the reader records the fact (`absent`) and each boundary decides whether it
is entitled to use it. `ABSENT_TRANSCRIPT_READY_AT` holds exactly one:
`wake-enter-retry`, whose window genuinely precedes the new session's first
record. Everything else, **including any boundary added later**, is strict, and
the refusal is `tool-call-transcript-absent`.

Strictness comes from the **boundary**, not from what the reader has observed.
The alternative -- permit absence until this binding has seen its first record
-- is boundary-agnostic and breaks on restart, where a fresh watch has seen
nothing and would permit exactly the mis-resolution case. A boundary survives a
restart; accumulated observation does not. `#104 D40`-`D44`.

Refusing the zero-length case would cost liveness and buy nothing. The one exposure they share
is a wrong `sessionId` pointing the reader at another seat's file; that is the
same exposure the ack scan already carries, bounded by the same boot/session
binding guard.

**A path that is not a regular file is neither of those**, and the distinction
was originally decided by a platform quirk rather than by the reader. Verified
on both: a directory stats as **size 0 on win32** and **40 on linux**. With 0,
the catch-up loop never runs, no read is attempted, no error is raised, and the
zero-length branch answers *ready* -- a fail-open. With 40 the read runs and
throws `EISDIR`. The reader now rejects the path for what it **is**, before
either outcome, so the two platforms agree and the permissive answer is gone.
ubuntu CI is what surfaced this; a Windows-only run cannot see the class at
all.

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
fail-closed property -- the jump sets `unknownOpen`, which only an anchor
discharges.

## The write paths, and how each is covered

Both mechanisms apply at every gated boundary and readiness requires **both**.
"transcript" is the #110 reader described above; "interlock" is the gate and
pending map described in *The bounded pre-permission interlock* below.

| path | what it writes | transcript | interlock |
|---|---|---|---|
| `_writeOperator` | the operator's own bytes | **not gated** | **not gated** -- see *The exemptions, re-examined* |
| `_fireCapsuleRequest` via `_writeCapsuleRequest` | `/context-capsule` | **gated.** Fresh read in `_writeCapsuleRequest`, immediately after the composer guard and *before* the ownership tally -- so a deferral does not spend the cycle_id latch. | **gate held** from after that read, across the ownership tally, to the text write. A refusal costs one tick and spends nothing. |
| `_writeCapsuleRequestEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time. On a hold, rescheduled (see below). | **gated.** The pending re-read and the keypress are one critical section. On a hold, rescheduled identically. |
| `_writeControl` via `commitClearSubmission` | `/clear` | **gated** at `_prepareSubmission`, after the ack gate and before the token is minted: nothing is spent, no hold taken, no intent persisted. Not re-read at commit. | **gate held** from `_prepareSubmission` across the `scheduleCommit` turn to the text write. This is what closes residual (3). |
| `_writeControlEnter` | `CONTROL_ENTER` | **gated.** Fresh read at fire time, after the existing submission-phase guard. On a hold, rescheduled. | **gated**, same critical section as the capsule Enter. |
| `_fireWake` | `WAKE_MESSAGE` | **not gated, structurally.** | **not gated, structurally.** See *The exemptions, re-examined*. |
| `_writeWakeEnter` | `CONTROL_ENTER` | **not gated, structurally.** | **not gated, structurally.** |
| `_tickWakeSubmission` retry | `CONTROL_ENTER` | **gated**, and the one boundary where an *absent* transcript still reads as "no records" (`ABSENT_TRANSCRIPT_READY_AT`). Fresh read after the settle and budget gates. A hold does *not* consume the retry budget, so the owed retry still happens. | **gated.** A refusal inside the critical section *gives the retry back* (`watch.retries -= 1`), so the owed retry stays owed. |
| `COMPOSER_KILL_LINE` (`commitClearSubmission`, `_flushQueuedInput`) | `Ctrl-U` | **not gated** | **not gated** -- see *The exemptions, re-examined*, where the claim is now measured rather than asserted |

### Why a digit in an automatic literal would be a dialog answer

The ungated automatic **text** writes are safe partly for a reason that used to
be only a comment: `/clear`, `/context-capsule` and `WAKE_MESSAGE` contain **no
digits**. At the dialog a digit selects that option *directly*, so a literal
carrying a `2` would answer "Yes, and switch to accept edits … for this session"
with no Enter involved at all -- the worst outcome in this issue, reachable
without touching any of the Enter machinery above. `WAKE_MESSAGE` is prose and
could acquire a numeral in an ordinary edit ("run step 2 of the procedure").

It is an assertion now, evaluated at module load as well as in the suite
(`automaticTextLiteralProblem`, `#104 M6`). These are compile-time constants, so
the check can only fail because somebody edited a literal -- which is exactly
when a hard stop is wanted, and it can never fire from an environmental cause.
Refusing to load is louder and safer than launching a runner that can answer a
dialog by typing.

### Why the clear is not re-gated at commit, and what changed

The only refusal mechanism available in `commitClearSubmission` is
`_abortPrepared`, which is **terminal** (`automationEnabled = false`,
`phase = 'abandoned'`). It would kill automation for the rest of the session over
a dialog that resolves in seconds. So the transcript read is **not** repeated
there, and in #110 the one-scheduler-turn prepare-to-commit gap was reported as
residual (3) rather than closed with a guard whose only available outcome was
worse than the hazard.

**The interlock closes it without needing an outcome at commit time at all.**
The gate is taken in `_prepareSubmission`, before anything is spent, and **held**
across the `scheduleCommit` turn: no permission marker can be recorded while the
runner holds it, so there is nothing to re-test. Arriving at
`commitClearSubmission` *without* the gate means the premise is gone rather than
unnecessary, and that single case does abort -- the alternative is writing
`/clear` plus an Enter with the exclusion unproven, which is the defect. The
gate is released from every exit of that span, `_abortPrepared` included. See
*The bounded pre-permission interlock* below; residual (3) is closed.

### Why the wake text and its first Enter are not gated

Both fire inside `_rebindAfterClear`, onto a context the host has just torn down
and rebuilt. Nothing has been submitted to that context, so no `tool_use` can
exist and no tool dialog can be open. The hazard is structurally absent.

That window also precedes the new session's *first* transcript record -- the
deterministic suite asserts exactly that (`fs.existsSync(wakeTranscriptPath(h))`
is `false` at the wake Enter). ENOENT is read as the positive answer it is, so
the reader would not hold them either way, but the structural argument is the
load-bearing one.

The **retry** is different, and is gated. It fires on later ticks, after the first
Enter released the input hold and queued operator bytes went in behind it. The
operator's own prompt can be running by then, with a dialog up, while the wake's
record still has not appeared -- which is precisely the state the retry exists
for.

#### What gating the retry changed, and why that trade was taken

Gating it is a **contract change**, not just a new guard. An unreadable
transcript used to buy bounded retries and a `retry-cap` close; it now buys
none. The alternative was considered and rejected on its merits: letting the
retry proceed when the transcript cannot be read means treating *cannot read* as
*no tool call outstanding*, which is the substitution this whole document
exists to prevent. `EACCES` on a real file takes the identical code path as
`EISDIR` on a directory, so the permissive reading could not have been confined
to the harmless case.

Two things bound what that costs, and `W6`'s `unreadable` case asserts both
rather than leaving them to reasoning:

- **the first wake Enter stays structurally exempt**, so an unreadable
  transcript costs only the retries and never the post-clear resume itself;
- **the watch still closes by name.** `watch.ticks` increments at the top of
  `_tickWakeSubmission` on every tick regardless of the gate, so the close is
  `watch-budget` with `retries: 0` -- bounded at `WAKE_SUBMIT_WATCH_TICKS`
  (1200 ticks, about 120 s at the default interval), visible, and released. A
  silently parked watch would be a worse outcome than the one being prevented.

The suppressed retries are visible rather than inferred: each one logs an
`automatic-write-held` event at the `wake-enter-retry` boundary carrying the
reason, so the log says *why* the count stopped moving.

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

### Operator input takes over a deferred Enter

Holding `enterHandle` non-null is how the deferral keeps queued operator bytes
from concatenating onto the stranded text -- and on its own that was **a mutual
wait**. `handleOperatorData` queues whenever `inputHold || wakeEnterHandle !==
null || enterHandle !== null || composerMayHoldControlText`, and
`_flushQueuedInput` returns early on `enterHandle !== null`. So in the dialog
case the deferral's only termination condition was the operator answering the
dialog, while the operator's answer was exactly what was being withheld.

It was never an indefinite lockout -- the tick path (`!inputHold &&
queuedInput.length > 0 && !_flushQueuedInput()`) flushes once the budget strands
the Enter, and the kill-line branch destroys the stranded text before releasing
the bytes -- but a bounded **≈ 60 s operator blackout at the one moment the human
must act** is not an acceptable price. Before this change that handle was
non-null for the 400 ms two-phase gap and the hold was imperceptible.

So operator bytes arriving while an Enter is **deferred** mean the operator is
taking over. That Enter is abandoned immediately: timer cancelled, token bumped
(a cleared-but-still-firing scheduler callback becomes a no-op), slot released,
cause named `runner-automatic-enter-operator-takeover` rather than left looking
like a budget expiry.

Four things that rule does **not** do, each one pinned by a vector:

- it does **not** hand the bytes to the child directly.
  `composerMayHoldControlText` is deliberately left up, so they go through the
  ordinary queue and `_flushQueuedInput` leads with the kill-line that destroys
  the stranded automatic text. `#104 D32` asserts the kill-line *index* precedes
  the operator bytes, so "delivered" cannot be satisfied by concatenation.
- it does **not** touch a **normally** pending Enter -- one that lands in 400 ms
  with no dialog involved. The no-concatenation invariant is correct there and
  the bytes still queue behind it (`D33`). Testing `enterHandle` alone would
  have broken this, which is why `enterDeferredAt` is separate state.
- it does **not** override an `inputHold` or a pending **wake** Enter: those are
  other automatic transactions owning the composer (`D34`).
- it does **not** skip `_abortPrepared`. An operator byte in the prepared window
  is still the #78 named halt.

The flush happens in the same call rather than on the next tick, because waiting
a tick is what made this a blackout.

## The residual window of the transcript reader

**A last-moment transcript read is not an atomic lock.** It proves no call was
outstanding *at the moment of the stat*. Between that stat and the `pty.write`,
the child may issue a `tool_use` and raise a dialog. No transcript evidence can
make that read atomic, and this document does not claim it is.

> **Read this section as the case for the interlock, not as the shipped
> residual.** (1) and (3) below are **closed** by the gate described in *The
> bounded pre-permission interlock*, and (2) is narrowed to the window before the
> hook process has taken that gate. The list is kept in full because it is the
> measurement that justified the second mechanism, and because every item is
> still exactly what the transcript leg *on its own* can and cannot do. The
> residual that actually ships is in *Residual, after the interlock*.

Precisely characterised, the transcript reader's residual is:

1. **The read-to-write race.** Sub-millisecond to a few milliseconds of
   synchronous work (stat, bounded read, parse, write). A call issued inside it
   is invisible to that write.

   **CLOSED by the interlock.** The decision and the write are now inside the
   same gate the hook must take to record a permission check, so a check that
   begins in that window is seen. `#104 D20` used to assert that the write went
   out and now asserts that it does not -- including in the shape the transcript
   reader cannot see at all, where the hook has recorded the check and the
   transcript holds nothing. The old concession survives as `#104 D20b`, moved
   to the one window that genuinely remains (residual (6) below).

2. **The transcript-versus-screen ordering.** The guard assumes the `tool_use`
   record becomes readable before the dialog can accept a keystroke. Two
   independent observations, both transcript-first:

   **This was measured the wrong way at first, and the correction matters more
   than the original figures.** A record's `timestamp` field is when the host
   *created* it, not when its bytes reached the file. The guard reads bytes. So
   the quantity that matters is **readability** versus screen, and these are the
   timestamp-versus-screen figures:

   | run | binary | `tool_use` timestamp | dialog on screen | timestamp lead |
   |---|---|---|---|---|
   | 2026-10-23T16:09Z | 2.1.309 | 55.083Z | 55.993Z | 0.91 s |
   | 2026-10-24T18:58Z | 2.1.310 | 49.439Z | ≤ 52.058Z (400 ms poll) | ≈ 2.2 s |
   | 2026-10-24T19:56Z | 2.1.310 | 42.352Z | ≤ 43.571Z (400 ms poll) | 0.82–1.22 s |
   | 2026-10-24T21:07Z | 2.1.310 | 34.987Z | ≤ 36.010Z (400 ms poll) | ≈ 1.0 s |

   On the first three runs the bytes *were* readable while the dialog was up --
   the driver's independent parser named the unpaired id at every sample, so
   readability and timestamp agreed. **On the fourth run they did not.** The
   `tool_use` record sits at offset 286521; the transcript was 283263 bytes at
   all three samples taken while the dialog was on screen, so the record was
   **not readable at any of them**. The file jumped to 447231 only after the
   cancellation, carrying the `tool_use` and its `tool_result` together. Created
   at 34.987Z, readable no earlier than 37.423Z and present by 39.628Z: a flush
   lag of **≥ 2.44 s** -- strictly, an interval of 2.436 s to 4.641 s, because
   both ends are fenced by the driver's 400 ms screen poll. The one-sided figure
   is a **bound**, not a measurement, and the upper end of that interval is not
   a lower end. The signal was absent for the entire time it mattered.

   So residual (2) is not a sub-millisecond race. The host's transcript writes
   are **buffered**, the flush is not announced, and its timing is not the
   record timestamp -- which makes this a window of **seconds** during which the
   evidence the guard depends on can simply not exist yet. One run in four,
   under ordinary load, on the binary this work was built against.

   The ordering is not contractual, nothing in the host documents it, and the
   dialog times are upper bounds set by the driver's 400 ms poll rather than the
   paint. Three samples with the same sign were never a guarantee; a fourth with
   the opposite sign settles it.

3. **The clear's prepare-to-commit gap.** One scheduler turn between the gate in
   `_prepareSubmission` and the `/clear` text write in `commitClearSubmission`.
   The transcript read was not repeated there, for the reason given above (the
   only refusal available is terminal), and the clear's Enter was gated.

   **CLOSED by the interlock**, and not by adding the guard that was rejected:
   the gate is taken in `_prepareSubmission` and **held** across that turn, so
   nothing can become pending inside it and there is nothing to re-test.
   `#104 I3` asserts it from inside the span -- a hook that arrives there is
   denied.

4. **A transcript that goes away or shrinks under a live session with a dialog
   up.** ENOENT is read as "no records", which would be wrong in that
   pathological case. The same item covers a *truncate-and-regrow in place*:
   `_checkToolCalls` re-baselines when `size < watch.from`, but a file truncated
   and then regrown **past** the old cursor before the next check is never seen
   to have shrunk, so the reader keeps a cursor that indexes different bytes
   than it did. No observation of either; stated because neither is detected.

5. **A main-conversation anchor can discharge an unread region that held a
   sidechain call.** This is the mirror of the sidechain-anchor exclusion, and it
   is open. A subagent response is excluded from *being* an anchor (`#104
   D25`/`D26`) precisely because it proves nothing about the main conversation --
   but the converse also holds and is not blocked: a main-conversation response
   proves nothing about an outstanding *subagent* call, so when it discharges an
   unknown region that happened to contain one, the discharge is unsound.

   Accepted rather than fixed, because an unread region's content is by
   definition unknowable: the reader cannot tell whether the bytes it stepped
   over held a sidechain call, so there is no evidence on which to refuse
   specifically. Refusing *every* discharge instead would hold automation
   permanently on any transcript carrying one oversize record. The exposure is
   also narrower than it reads: on the measured binary (2.1.310) subagent records
   go to a separate `subagents/agent-*.jsonl` file and the bound transcript holds
   none of them, so this needs the inline sidechain shape that `#79` had to
   exclude and that `D5` asserts. Named here rather than left implied, since the
   leg that added `D25`/`D26` exists specifically to defend that shape.

### What would close (1) and (2) -- and what this change then did

Transcript evidence cannot close them: the transcript is a record of what the
child *did*, written concurrently with the dialog, not a lock taken before it.
Run 4 above makes that concrete rather than theoretical -- the record existed and
was simply not on disk yet, so no amount of care in the reader would have
produced the signal.

That raises the value of the alternative considerably. The flush lag bound
(≥ 2.44 s) is larger than the entire deferral window the guard relies on for its
second leg, so for that run the transcript route offered no protection at all.

The smallest **supported** host mechanism that would close them causally is a
`PreToolUse` hook. Claude Code runs `PreToolUse` before the tool call and before
the permission check, synchronously -- so a marker written there is *causally*
before the dialog rather than concurrent with it. This repository already uses
that mechanism (`daemons/gateguard.mjs`, `daemons/memory-budget-guard.mjs`,
`daemons/model-tier-guard.mjs`, wired in `.claude/settings.json.template`), so it
would be reuse rather than invention.

It was **not** in #110, deliberately, because keying readiness on a hook
marker is only sound if the runner can prove the hook is live in the bound
session. Absence of a marker would otherwise mean "no tool call" and "the hook
is not installed" -- indistinguishable, and the second reading is a fail-open
worse than the gap it closes. Establishing and verifying that installation
per-session was a larger change than a bounded repair, and shipping half of it
would have replaced a named residual with a silent one.

**It is in this change, with that proof built first.** The four evidence legs in
*Proving the hook is live for this bound session* are the answer to the paragraph
above, and the property they exist for is stated as plainly as it can be:
missing, stale or failed hook evidence makes automatic input stay **held**, and
never reads as "no tool call is pending".

## The bounded pre-permission interlock

Everything above reads the transcript. **Measured on binary 2.1.310, that signal
is not reliably on disk while the dialog is on screen** -- see residual (2) and
the run-4 figures. So the second mechanism does not read a record of what the
child *did*; it takes a lock the child's own permission check has to take too.

`daemons/pre-permission-interlock.mjs` is one file with two callers: run
directly it is the `PreToolUse` / `PostToolUse` / `Stop` hook, imported it is
the library the runner uses for the same gate and the same state file. That is
deliberate rather than tidy -- a mutual-exclusion protocol with two
implementations has two chances to disagree about what *held* means.

### Why a hook, and why it is causal rather than concurrent

Claude Code runs `PreToolUse` **before the permission check**, synchronously,
and waits for it. A marker written there therefore precedes the dialog instead
of racing it, and it does not depend on a flush the host never announces. The
repository already used this mechanism three times (`gateguard.mjs`,
`memory-budget-guard.mjs`, `model-tier-guard.mjs`, wired in
`.claude/settings.json.template`), so this is reuse.

The payload shape is **measured, not assumed** (2026-10-25, binary 2.1.310,
authenticated disposable profile, project-level `.claude/settings.json`):

| event | fields |
|---|---|
| `PreToolUse` | `session_id` `transcript_path` `cwd` `prompt_id` `permission_mode` `effort` `hook_event_name` `tool_name` `tool_input` **`tool_use_id`** |
| `PostToolUse` | the above plus `tool_response` `tool_use_id` `duration_ms` |
| `Stop` | `session_id` `transcript_path` `cwd` `prompt_id` `permission_mode` `effort` `hook_event_name` `stop_hook_active` `last_assistant_message` |

Two facts from that capture decided the design:

- **`PreToolUse` carries `tool_use_id`**, the same id the transcript reader
  pairs on. So a marker is keyed by the host's own identity for the call.
- **a DENIED tool call produces no `PostToolUse` at all.** The denied `Read`
  produced `PreToolUse` and nothing else; the allowed `Glob` produced both. So
  `PostToolUse` cannot be the clearing path for a cancelled dialog, which is
  exactly the case that has to recover. The turn's `Stop` is.

One more measured fact about the *wiring*: **project-level hooks are silently
ignored in an untrusted workspace** (`Ignoring 1 permissions.allow entry from
.claude/settings.json: this workspace has not been trusted`), and hooks supplied
through `--settings` did not run at all. The installed seat is a trusted
workspace with a rendered `.claude/settings.json`, which is the shape that works
and the shape the runner's wiring leg checks.

### Why this is a mutex and not a second file to poll

A second file the runner polls would have the identical defect one layer over:
the runner reads *nothing pending*, the hook then writes the marker, and the
runner writes its Enter into the dialog that follows. **A check followed by a
write is not exclusion.**

So both sides take the same gate:

```
runner:  acquire gate -> read pending -> pty.write(...) -> release gate
hook:    acquire gate -> (drain) -> record pending -> release gate
                                 -> the host's permission check proceeds
```

Whichever side holds it first, the other cannot interleave:

- **hook first** -- its marker is on disk and `fsync`ed before it releases, so
  the runner's `pending` read *inside its own critical section* sees it and the
  write never happens;
- **runner first** -- `pty.write` has already **returned** before the hook can
  acquire.

There is **no interval in which the runner can observe an empty pending map and
then have a marker appear before its own write**, because the observation and
the write are inside the same critical section the marker creation needs. That
is the whole of "no check-then-write race", and it is the property `#104 D20`
asserts (recorded after the readiness read, still held) and `D20c` asserts from
the other side (the hook cannot start a check inside the runner's span).

The gate is held across **more than one scheduler turn** in exactly one place:
the clear's `_prepareSubmission` to `commitClearSubmission` span. That is what
closes residual (3) -- not by re-testing at commit, but by making the window
one in which nothing can change. Re-testing an invariant you are holding is not
a guard; it is a second chance to be wrong.

### The drain, and why the wait belongs in the hook

`pty.write()` returning is not the child having **consumed** the byte. So the
runner's write is causally before the marker while the byte may still be
travelling. The runner records `last_write_at` **inside the gate and before the
write** (that order matters: a crash between the two leaves the hook draining
for a write that never happened, which is harmless, where the other order would
leave a written byte with no drain, which is the hazard). A `PreToolUse` that
acquires the gate within `INTERLOCK_DRAIN_MS` of that stamp sleeps out the
remainder before recording and returning.

The wait is the **hook's**, never the runner's. The hook is a throwaway process,
so a bounded synchronous sleep there costs nothing; a sleep in the runner would
stop it pumping the child's output.

### Bounded waits, and which direction the fallback fails

| bound | value | what it bounds |
|---|---|---|
| `HOOK_GATE_BUDGET_MS` | 1200 ms | how long `PreToolUse` waits for the gate |
| `GATE_SLEEP_MS` | 5 ms | one wait step (`Atomics.wait`, not a spin) |
| attempt ceiling | `budget / 5 + 2` | the **second, independent** bound -- see below |
| `INTERLOCK_DRAIN_MS` | 120 ms | the drain |
| `GATE_STALE_MS` | 5000 ms | when a gate may be stolen on age alone |
| `PENDING_MAX` | 64 | entries in the pending map |
| runner gate attempts | 2 | the runner never *waits*; one attempt, one steal, one retry |
| hook `timeout` in the template | 8000 ms | well above the sum, because a hook the **host** times out is a fail-open |

**There are two independent bounds on the gate wait, and the second is not
belt-and-braces.** A deadline alone makes "no unbounded hook wait" contingent on
the clock advancing: a frozen or non-monotonic clock makes the deadline
unreachable and the loop infinite, which is the agent hanging on a hook. A
vector that injected a constant clock found exactly that (it looped instead of
denying), so an attempt ceiling now holds whatever the clock does. `#104 G5`.

**The fallback fails closed.** If `PreToolUse` cannot take the gate inside its
budget, or cannot write the marker, or throws after finding a managed runner, it
returns `permissionDecision: "deny"` with a named reason and exits 2. The tool
call does not run, so **no dialog appears**, so there is nothing for an
automatic keystroke to answer. A denial is recoverable -- the model is told why
and can retry -- whereas an automatic *"Yes, and switch to accept edits … for
this session"* is not. This is the one `PreToolUse` hook in the repository that
does **not** fail open, and the reason is that its entire job is to be why an
automatic keystroke was held; a throw means it did not do it.

`PostToolUse` and `Stop` do **not** deny. Their failure mode is that a marker is
not cleared, which *holds* automatic writes -- already the safe direction -- so
denying there would cost liveness and buy nothing. `#104 G6`.

A gate nobody released is a liveness hazard in that same closed direction, so it
is **stealable**: a holder whose pid is gone, whose nonce belongs to a previous
binding, or that is older than `GATE_STALE_MS`. A legitimate holder cannot reach
that age -- the runner's critical section is a stat, a small read and a
`pty.write`. The steal is a **rename-away**, because that is the atomic step:
exactly one of several concurrent stealers can move the same source. Unlink then
create is not atomic and would let two stealers both believe they hold it.

### Platform semantics, measured on both sides

The #110 round lost a day to a Linux-only regression because `statSync(dir).size`
is 0 on win32 and 40 on linux. A Windows-only run cannot see the POSIX branch of
an `open`/`stat` distinction, so every primitive this unit depends on was
measured on both. WSL has no native node (only `/mnt/c`'s `node.exe`, which runs
as a Windows process and so could not see this branch at all), so the POSIX side
was measured at the **syscall** level with python3 -- which is what node's `fs`
maps onto: `'wx'` → `open(O_WRONLY|O_CREAT|O_EXCL)`, `renameSync` → `rename(2)`,
`process.kill(pid,0)` → `kill(pid,0)`.

| primitive | win32 (node 24.15.0) | linux (WSL2 6.18.33.2, python 3.14.4) |
|---|---|---|
| second `O_CREAT\|O_EXCL` open | `EEXIST` | `EEXIST` |
| `O_CREAT\|O_EXCL` on a **directory** | `EEXIST` | `EEXIST` |
| `stat(dir).size` | 0 | 40 |
| read of a directory | `EISDIR` | `EISDIR` |
| unlink while another process holds the fd | ok | ok |
| 4 processes racing to `rename` one source, 20 rounds | 20 wins total, losers `ENOENT` | 20 wins total, losers `ENOENT` |
| `kill(pid, 0)` on a dead pid | `ESRCH` | `ESRCH` |
| small file written + `fsync`, read from another process | immediate | immediate |

The two platforms agree on every primitive the gate uses. The one place they
differ -- `stat(dir).size` -- is **not** used: a gate path that is a directory is
rejected for what it *is* (`interlock-gate-path-unusable`), before either
platform's size or error can decide it. Without that branch the gate would read
as permanently held and every tool call in the session would be denied for ever:
fail-closed, but a nameless wedge. `#104 G4`.

### Proving the hook is live for *this* bound session

This is the property the whole unit rests on, and the reason #110 did not take
this route. Keying readiness on a marker is sound **only** if the runner can
prove the hook is running for the bound session. Otherwise "no marker" means
both *no tool call* and *the hook is not installed*, and the second reading is a
worse, silent fail-open than the gap being closed.

Four legs, **all required**, each with its own refusal:

| leg | what it proves | how | refusal |
|---|---|---|---|
| 1 **bound** | the evidence belongs to *this* binding | `proof.json` exists in this session's directory and its `nonce`, `session_id` and `runner_pid` match the binding in memory | `interlock-proof-missing` / `-unreadable` / `-mismatch` |
| 2 **installed** | the hook is the file the proof was written about | the recorded path still exists and its sha256 still matches | `interlock-hook-missing` / `interlock-hook-changed` |
| 3 **observed** | the **host** has actually invoked the hook for this nonce | `state.json` carries this nonce and at least one of `pre_runs` / `post_runs` / `stop_runs` | `interlock-hook-not-observed` |
| 4 **current** | the hook has not stopped running | since the last point at which both counters agreed, `pre_runs` has advanced at least as far as the transcript reader's `tool_use` count | `interlock-hook-missed-tool-calls` |

Plus `interlock-hook-not-wired`: the hook must appear under `PreToolUse`,
`PostToolUse` **and** `Stop` with a matcher that matches every tool (`""`, `"*"`
or `".*"`), in a settings file the runner can read -- `<cwd>/.claude/settings.json`,
`<cwd>/.claude/settings.local.json` or `<home>/.claude/settings.json`.

**Leg 3 is the strong one and the only empirical one.** It is direct evidence
that this binary, with this configuration, invokes this file for this session.
`Stop` fires at the end of every assistant turn (measured), so a session that
has had a turn satisfies it even with no tool call in it -- which matters,
because a session can reach ~80% context pressure on a single pasted document.

**Leg 4 is staleness detection without a timeout, and that is deliberate.** Idle
time proves nothing: a quiet session makes no tool calls, so an idle-staleness
rule would hold automation on a perfectly healthy seat -- a liveness bug dressed
as a safety check. What *is* proof is a `tool_use` the reader has parsed that the
hook never ran for, because on a wired seat every tool call runs `PreToolUse`
first. If the configuration is changed mid-session, or the hook starts failing,
the next tool call makes the counters disagree and the gate closes. `#104 I5`.

The comparison is a **delta against a checkpoint**, not an absolute total,
because the two counters are not comparable in absolute terms: the reader's
baseline walk parses up to a megabyte of *history* whose calls the hook handled
before `state.json` existed. The checkpoint is advanced every time all four legs
pass, and **discarded on every re-baseline** -- after a re-baseline the reader
has re-read records it already counted, so it has no claim about what the hook
owed. That forgiveness is not a hole: a re-baseline also raises `unknownOpen`,
which holds every automatic write until an anchor discharges it, so the two legs
cover each other.

**What is NOT a leg.** A runner-side probe -- spawn the hook with a synthetic
payload and check it stamps -- was considered and dropped. It proves the file
works when the **runner** runs it, which leg 3 already subsumes with strictly
better evidence (the **host** ran it), and it would cost a subprocess per bind
on a host that carries ~130 node processes at steady state. Earlier diagnosis
was the only thing it bought.

### The one absence that is not a fail-open

If there is no `proof.json`, the hook exits 0 and marks nothing. That is not a
hole, because the runner's side **requires the proof it writes itself**: absence
holds automatic writes on one side and silences the hook on the other. The two
refusals are the same fact seen from both ends, and an unmanaged seat does not
get its tool calls denied by a runner that is not there. `#104 G7` asserts both
halves together.

`AIGENT_INTERLOCK=off` works the same way: the hook goes inert **and** the
runner's side reports `interlock-disabled`, a refusal. The switch cannot create
a fail-open in either direction -- turning the interlock off stops automatic
writes, it does not permit them. `#104 I4c`.

### Clearing a marker, and why age never releases one

| path | covers | measured |
|---|---|---|
| `PostToolUse` for the id | an allowed call that ran | yes -- the allowed `Glob` produced one |
| `Stop` sweep | **every** other outcome: denied, cancelled, errored, abandoned | yes -- the denied `Read` produced **no** `PostToolUse`, so this is the load-bearing path for the case that has to recover |
| nonce rotation | a rebind, a relaunch | the new binding ignores the old directory entirely |

The `Stop` sweep is sound because `Stop` fires when the assistant has finished
responding, and a permission dialog cannot be on screen then -- the turn it
belongs to has ended. That is what bounds an orphaned marker to the turn it was
raised in.

**Age never releases a marker.** A human can read a dialog for minutes, and age
cannot tell that from a marker nothing ever cleared, so past
`INTERLOCK_PENDING_STALE_MS` (120 s) only the **name** changes --
`interlock-permission-pending` becomes `interlock-pending-stale` -- and both
hold. The rename exists so an operator can tell the two apart in the log. An
age-based release would be this entire issue with a timer on it. `#104 I9`,
`G13`.

### The exemptions, re-examined

#110's three exemptions were inherited rather than assumed, and each was
re-decided against the new mechanism.

**The operator's own bytes (`_writeOperator`): still exempt, and now for a
second reason.** They are the operator's keystrokes; their Enter at a dialog is
their decision. Gating them would make the runner swallow operator input -- and
under the interlock it would do worse, because a pending marker is cleared by
the operator answering the dialog, so gating their bytes would be the mutual
wait #110 already shipped once and had to fix. `#104 I7` drives the operator's
byte through with a check pending and asserts it reaches the child **in the same
call**.

**Both `Ctrl-U` kill-lines: still exempt, and the claim is now measured rather
than asserted.** #110 said "`Ctrl-U` is not a selection key and cannot answer the
dialog". That was an assertion about a host UI. The host driver now sends a real
`Ctrl-U` at a real permission dialog and records whether the dialog survives it
(see *Host evidence*). The structural reasons stand too: the kill-line *is* the
stranded-text protection, and it is written on the operator-release path, so
gating it would make the human wait.

**The post-clear wake text and its first Enter: still exempt, structurally, and
the claim is now testable.** They fire inside `_rebindAfterClear`, onto a context
the host has just torn down and rebuilt, so no `tool_use` can exist. What is new
is that the interlock gives that claim an observable: the new binding's pending
map is the host's own record of whether a check is in flight, and at that moment
the directory does not exist at all. `#104 I8` asserts exactly that.

And the exemption is **not a hole**, which is the part #110 left to reasoning.
The only route to the wake is a clear whose Enter went out, and that Enter is
interlocked: a check pending there means no submitted clear, which means no
rebind, which means no wake. `#104 I8b` constructs that chain.

The reason the wake pair could not simply be gated as well: the observed leg
cannot be satisfied by a session that has not had a turn yet, and `_fireWake`'s
only failure mode is terminal disablement. Holding the post-clear resume on
missing evidence would cost the seat its recovery for a hazard that is
structurally absent. The **retry** is different and is gated, exactly as in #110.

### Residual, after the interlock

Residual (1) and (3) from the list above are closed; (2) is narrowed, not
removed. What remains, stated as a fact rather than claimed away:

6. **The window before the hook has taken the gate.** The gate makes "the runner
   decided and wrote" atomic with respect to "the hook recorded a check". It
   cannot cover the interval between the host *deciding* to call a tool and the
   hook **process** reaching the gate -- a node spawn. In that interval neither
   mechanism can see the call: the hook has not marked it and the host may not
   have flushed the record either.

   This is a much smaller and much better-behaved window than residual (2)'s
   buffered flush: it is bounded by a local process start rather than by an
   unannounced flush of unknown duration, and it is bounded *below* the dialog,
   because the host does not render the permission prompt until the whole
   `PreToolUse` chain has returned. Two things still apply inside it: the
   delayed Enter re-reads inside its own gate 400 ms later, and the drain makes
   a hook that arrives just after a write wait out the bytes in flight.
   `#104 D20b` exercises it and asserts the write **does** go out -- the gap is
   in the suite as a fact.

7. **An inline sidechain tool call would be charged to the main session's
   counter.** Leg 4 counts every `tool_use` the reader parses, including an
   inline sidechain one. If a subagent's `PreToolUse` fires with a *different*
   `session_id`, `pre_runs` for this binding would not advance and automation
   would be held by name. Fail-closed and named, so not a safety hole; recorded
   because it is a liveness cost. On the measured binary (2.1.310) subagent
   records go to a separate `subagents/agent-*.jsonl` file and the bound
   transcript holds none of them, so this needs the inline shape `#79` had to
   exclude.

8. **A gate leaked by a hard kill is recovered on a timer, not instantly.** Every
   ordinary path releases the gate where it takes it, and `_abortPrepared`,
   `_disableAutomation`, the rebind and teardown all release it as a net. A
   `SIGKILL` inside the held span leaves it until a waiter finds the pid dead --
   immediate in practice, since the steal checks pid liveness first -- or until
   `GATE_STALE_MS`. The failure direction is denied tool calls, not permitted
   keystrokes.

9. **An exotic install that wires the hook somewhere the runner cannot read**
   (managed enterprise settings, for instance) reads as `interlock-hook-not-wired`
   and holds automation. `install.sh` renders the file the wiring leg checks, so
   a correct aigent-OS install always passes; a different layout fails closed
   and loudly rather than being assumed fine.

## Verification

### Deterministic

`daemons/tests/pty-runner.test.mjs`, vectors `#104 D1`–`D44` plus `#104 M6`. 17 of the first 20
are red before the fix; `D1` is the first red and is the reported defect with
nothing else wrong (the vector asserts the composer is clean in setup, so the old
guard permits the write). `D21`, `D23` and `D24` are red against a *record*-scoped
anchor -- `D21` holds 1 outstanding call where it must hold 2, which is the
parallel-call fail-open -- and `D22` is green either way, because it pins the
liveness half the scoping must not break.

`D25` and `D26` are red against an anchor that admitted sidechain responses, both
reporting `ready: true` with a main-conversation call still outstanding: `D25`
that such a record cannot clear the set, `D26` that it cannot discharge an
unanchored baseline either. Each then asserts the liveness half -- a real answer,
and a real main-conversation anchor, still release -- so the exclusion is narrow.
`D27`–`D31` cover the oversize-record step, which had **zero** coverage before
this round -- nothing in `D1`–`D26` produced a record larger than one window, and
the `D10`/`D23`/`D26` fillers are 200 KiB lines, deliberately under it. `D27`
and `D28` are red against the unreset `responsesSeen` counter, `D31` against the
shared refusal name; `D29`/`D30` hold the two liveness directions.
`D32`–`D35` cover the operator-takeover rule, `D36`–`D38` the identity-space
tag.

Note that the suite could not have caught the sidechain anchor before:
`openToolCall()` omits `message.id`, so `D5`'s sidechain record was
anchor-neutral *by accident rather
than by rule*, and every response-scoped vector was written with
`isSidechain:false`.

#### The interlock's vectors

`#104 I1`-`I10` in `daemons/tests/pty-runner.test.mjs` (the runner's use of the
interlock) and `#104 G1`-`G17` in
`daemons/tests/pre-permission-interlock.test.mjs` (the mechanism itself).

The I series drives the **shipped hook function** in-process -- `runHook`, the
same entry point the hook's own `main()` calls -- against the **shipped runner**,
through the real files. Nothing is modelled.

**The whole D series now runs with a LIVE interlock**, which is why
`makeFixture` renders a `.claude/settings.json` in the fixture's project root
and the harness primes a `Stop`. Without that, every D vector would have become
a test of the held case. Two couplings were added to `openToolCall` /
`settleToolCall` and they are the honest shape rather than convenience: a
`tool_use` record means the host decided to call a tool, and on a wired seat
that decision ran `PreToolUse` first -- so the helpers run it, and
`hook: false` opts into modelling a seat whose hook has *stopped*, which is what
`I5` uses.

Red-before, against the **pre-#110-merge runner** (`git archive 80064d76`, the
runner `cmp`-verified byte-identical to `80064d76:daemons/pty-runner.mjs`, sha256
`a16ae63f…`, with only the new hook module and the new test files copied in):
**20 of 21** new/rewritten vectors red. The first red of each is in the PR
description. `I8` is green either way, deliberately -- it pins behaviour the
interlock must *not* change.

The red run needs one shim, and it is named in the harness: against a pre-fix
runner there is no `_ensureInterlockProof`, so nothing would write the proof the
hook keys on, the hook would be inert, and every I vector would fail on its own
*setup* rather than on the defect. The harness writes the proof itself in that
case, so the red result is "the runner could not see a permission check that was
recorded for it" -- the actual fail-open -- rather than "the fixture could not be
arranged".

`I10` could not be red that way, because it is about a path *inside* the new
mechanism. It was proved red against a **mutant** of the fixed tree with the
settled-id discount -- one line -- removed and the runner `cmp`-verified
identical to the shipped one: `0` Enters where `1` is required, and it is the
only semantic failure in that tree.

### Host evidence

`scratchpad/p104/driver2.cjs` -- bounded, isolated, cancel-only, never approves.
It runs a real `claude.exe` against an authenticated disposable profile with
`permissions.ask: ["Read"]`, and drives the **shipped** reader and the **shipped**
`_writeControlEnter` (methods borrowed from `ManagedPtyRunner.prototype`, so the
code under test is the code that ships) against the **live** transcript, with a
spy PTY so nothing can reach the child.

Run three times on binary **2.1.310**: `18:58Z` (session `a1b3a275`, against the
text-write and delayed-Enter guards), `19:56Z` (session `e8cd53af`, against the
response-scoped reader) and `21:07Z` (session `529aa897`, against the final
reader after the B1 and S2 fixes). The first two reported `ok: true`; **the third
reported `P1: false`, and that result is kept rather than re-rolled** -- see
below. Figures are from run 2 unless stated:

- **No automatic answer.** Three samples while a real dialog was on screen:
  `ready=false`, `runner-tool-call-outstanding`, outstanding id
  `Read:toolu_01SR8oPZs7…`. The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up.
- **Cancellation recovers.** ESC only. Within 1.5 s readiness returned and the
  boundary wrote exactly one Enter -- not wedged. The cancellation settled its
  own call (`Read`, `is_error: true`).
- **Ordinary success does not stick.** `Glob` (in `permissions.allow`, so no
  dialog at all) executed with `is_error: false`. The reader held the boundary
  across three consecutive samples while it ran, then released; three
  post-execution samples all ready, all writing. That is the signal working on a
  tool call with no dialog behind it at all -- it tracks the call's lifetime, not
  the dialog's.

**Run 3 and the negative result.** Same driver, same settings, final code. P2
and P3 passed. P1 reported **false**: all three samples taken while a real
dialog was on screen read `ready: true` with an empty outstanding set, and the
driver's *independent* parser agreed -- because the `tool_use` record was not yet
on disk (offset 286521, file 283263 bytes). The reader was not wrong about the
bytes; the bytes were not there. See residual (2), which this run is the evidence
for.

This is reported rather than re-run to a pass, because re-running until P1 goes
green would be selecting the observation that flatters the design. The honest
summary of the host evidence is: **on 3 of 4 observations of a real dialog the
signal was readable in time and the guard held; on 1 of 4 it was not, and the
guard would not have held.** The deterministic coverage is unaffected -- it
exercises the reader against transcripts that *do* contain the signal, which is
the half of the problem the reader owns.

Raw artifacts: `scratchpad/p104/run2/` (`driver2.log`, `samples.json`,
`screen.log`, `PROMPT.txt`, `CANCELLED.txt`) -- overwritten per run, so the
figures above are the durable record.

#### The interlock's host evidence

`scratchpad/p104b/driver3.cjs` -- same isolation, same authenticated disposable
profile (`CLAUDE_CONFIG_DIR` pointed at the existing `p104/cfg`; no credential
was copied and no live configuration was touched), same **cancel-only**
discipline: it never writes `` while a dialog is up, and the only keys it
sends at a dialog are ESC and one measured `Ctrl-U`. It never approves anything,
and the scratch settings are *stricter* than the profile's (`ask: ["Read"]`).

What it drives is the **real hook, run by the real host** -- wired at
`PreToolUse`, `PostToolUse` and `Stop` in a project-level `.claude/settings.json`
in a trusted workspace, the shape `install.sh` renders -- plus the **shipped**
runner methods borrowed from `ManagedPtyRunner.prototype`, against a **real**
permission dialog, with a spy PTY so nothing reaches the child.

Run on binary **2.1.310**, `2026-10-25T17:22Z`, session `b6971e0a`:

- **The marker precedes the dialog.** Polled every 25 ms from the prompt's Enter
  onwards: 92 polls, of which **3 saw the marker with no dialog on screen** and
  **0 saw the dialog with no marker**. The marker led the dialog by **75 ms**.
  This is the measurement the whole mechanism depends on, and the earlier
  attempts at it were *not* this: polling at 120 ms, and only after a 4 s
  re-press window, produced a timeline with a single sample in which both were
  already up -- which could not resolve the ordering at all and was reported as
  unresolved rather than as a lead.
- **The interlock held on its own.** `_interlockReadiness` alone answered
  `ready: false` / `interlock-permission-pending` at **every** sample while the
  dialog was up. That is the leg that has to work when the transcript says
  nothing, and on this run the transcript *did* see the call (it was flushed in
  time), so the composed verdict named `runner-tool-call-outstanding` -- both
  refusals are correct, and the interlock-only number is what shows it would
  have held either way. **The unflushed case did not recur on this run** (0 of 3
  dialog samples had the call missing from disk); it is covered deterministically
  by `#104 I1`, which constructs exactly that state.
- **No automatic answer.** The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up, at every dialog sample.
- **The liveness proof is not decoration.** The sample taken *after* the runner
  wrote its proof but *before* the host had run the hook answered
  `ready: false` / `interlock-state-missing`. One turn later, with
  `stop_runs: 1`, it answered ready. An unobserved interlock holds, on a real
  host, by name.
- **`Ctrl-U` at a real dialog selected nothing.** The dialog was still on screen
  after it. #110's exemption is now measured rather than asserted.
- **Cancellation recovers with no further operator keystroke.** ESC only.
  Readiness returned at the first sample after the cancellation (~1.5 s after
  the ESC, which is the driver's own settle sleep, not a measured latency) and
  the boundary wrote exactly one Enter -- **with the marker still in the file**,
  because the transcript had settled its id. That is the clearing path that was
  added *because of* run 3's earlier failure, and this is it working.
- **An ordinary successful call does not stick.** `Glob` (in
  `permissions.allow`, so no dialog at all) left a marker while it ran and the
  marker was gone afterwards; three post-execution samples all ready, all
  writing.

Raw artifacts: `scratchpad/p104b/run3/` (`driver3.log`, `samples.json`,
`timeline.json`, `screen.log`, `PROMPT.txt`, `CTRL-U.txt`, `CANCELLED.txt`) --
overwritten per run, so the figures above are the durable record.

#### The run that changed the design

The **first** completed interlock run (`17:09Z`, session `ee986519`) is kept
here because it found a defect rather than confirming one. Its clearing paths
were `PostToolUse` for the id plus the turn's `Stop` sweep. **An ESC-cancelled
turn fired no `Stop` at all**: `stop_runs` stayed at 1 from before the dialog,
through the cancellation, and through the whole of the *next* turn's tool call,
reaching 2 only when that later turn ended. The marker was therefore held for
**48 s** (17:09:50 to 17:10:38) with no dialog on screen, and an operator who
walked away would have held automation indefinitely -- fail-closed, but the
exact recovery case this work exists to get right. That is what added the
settled-id clearing path and `#104 I10`. The run is reported rather than
discarded, for the same reason #110's P1 failure was.
