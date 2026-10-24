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
host had not yet committed as the answer. Reproduced on the second 2.1.310 run
(session `e8cd53af`): offsets 451531 `assistant tool_use`, 453622
`api-request-blob tool_result`, 455857 `user tool_result` — the blob again ahead
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
`assistant` record would drop call A the moment call B's record arrived — and
once B's own result settled B, the set would read *empty* with A's dialog still
on screen.

(The block splitting is measured. The parallel-call shape is *inferred* from it,
because both captures ran haiku issuing one tool at a time. `#104 D21` constructs
it from the measured record shape.)

So the anchor is scoped to the response identity, and that identity is **tagged
with the space it came from** — `msg:<message.id>`, else `req:<requestId>`. A
record of a *different* response **in the same space** clears the set; a record
of the *same* response is a continuation block that adds its ids and clears
nothing; an unidentifiable record clears nothing either; and a record whose
space *differs* from the one currently held clears nothing either, because across
a space change the reader cannot tell one response from two.

That tag exists because the bare fallback was a fail-open on a **partial**
disappearance, not a total one: one response whose block 0 carried only
`requestId` and whose block 1 carried only `message.id` produced two different
strings, so block 1 read as a new response and cleared block 0's live call —
while nothing about the conversation had changed, only which field the host
happened to write. Latent (both fields were measured present on every assistant
record of both captures) but cheap to make impossible. `#104 D36`/`D37`.

The `unknownOpen` **discharge** needs more than that, because it claims calls the
window never saw are answered, and an earlier block of *this* response could have
opened one. Two independent proofs, either sufficient:

- `apiBlockIndex === 0` — this record is the start of its response, so it has no
  earlier block;
- the **second** distinct response **since the unknown was raised** — the first
  one's existence proved every call before it was answered, and the second proves
  every call of the first was answered. Together they cover the unknown prefix
  with no block index at all, which keeps the discharge working if that field
  ever changes.

**That second proof is only valid for the prefix of the count**, and getting
that wrong was a third fail-open. `responsesSeen` was a running total over the
whole scan and was never reset, so it was already ≥ 2 after the first few
records of any real tail — the clause was effectively always satisfied. It is now
**reset whenever an unknown is raised mid-scan** (the oversize-record step
below), which restores the precondition the argument needs. `#104 D27`/`D28`,
with `D29`/`D30` holding the two liveness directions.

If both fields ever disappear from the format, the reader goes conservative
rather than permissive: no clear, no discharge, so a baseline reports
`tool-call-baseline-unanchored` — loud and fail-closed. A *partial*
disappearance is covered by the space tag above, which is what makes that
sentence true rather than merely intended.

**A sidechain (subagent) response is not an anchor either**, and missing that is
the same fail-open by a second route. The anchor argument — the API cannot be
called again while a call is unanswered — holds only *within one conversation*. A
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
would clear — and discharge the unknown prefix for — a *main*-conversation call
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
  long as the seat stays quiet. The alternative — re-scanning the same megabytes
  every tick — was the cost the growth gate was added to avoid, and the hold is
  named on every tick rather than silent.
- the **unreadable** branch stops at the offending record and advances the cursor
  to the end of the window it was reading, so the remaining complete records in
  that window are discarded unparsed. They are re-read only if the reader
  re-baselines. Conservative in the safety direction (the set is not updated from
  them), and the refusal is named.

**What this table does not cover, stated here rather than only in the residual
section:** a discharge is sound for the *main* conversation only. A
main-conversation anchor that discharges an unread region which held an inline
**sidechain** call is unsound, and is not blocked — the mirror of the
sidechain-anchor exclusion. See residual (5); it is accepted because an unread
region's content is unknowable, not because it was overlooked.

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

### Why a digit in an automatic literal would be a dialog answer

The ungated automatic **text** writes are safe partly for a reason that used to
be only a comment: `/clear`, `/context-capsule` and `WAKE_MESSAGE` contain **no
digits**. At the dialog a digit selects that option *directly*, so a literal
carrying a `2` would answer "Yes, and switch to accept edits … for this session"
with no Enter involved at all — the worst outcome in this issue, reachable
without touching any of the Enter machinery above. `WAKE_MESSAGE` is prose and
could acquire a numeral in an ordinary edit ("run step 2 of the procedure").

It is an assertion now, evaluated at module load as well as in the suite
(`automaticTextLiteralProblem`, `#104 M6`). These are compile-time constants, so
the check can only fail because somebody edited a literal — which is exactly
when a hard stop is wanted, and it can never fire from an environmental cause.
Refusing to load is louder and safer than launching a runner that can answer a
dialog by typing.

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

### Operator input takes over a deferred Enter

Holding `enterHandle` non-null is how the deferral keeps queued operator bytes
from concatenating onto the stranded text — and on its own that was **a mutual
wait**. `handleOperatorData` queues whenever `inputHold || wakeEnterHandle !==
null || enterHandle !== null || composerMayHoldControlText`, and
`_flushQueuedInput` returns early on `enterHandle !== null`. So in the dialog
case the deferral's only termination condition was the operator answering the
dialog, while the operator's answer was exactly what was being withheld.

It was never an indefinite lockout — the tick path (`!inputHold &&
queuedInput.length > 0 && !_flushQueuedInput()`) flushes once the budget strands
the Enter, and the kill-line branch destroys the stranded text before releasing
the bytes — but a bounded **≈ 60 s operator blackout at the one moment the human
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
- it does **not** touch a **normally** pending Enter — one that lands in 400 ms
  with no dialog involved. The no-concatenation invariant is correct there and
  the bytes still queue behind it (`D33`). Testing `enterHandle` alone would
  have broken this, which is why `enterDeferredAt` is separate state.
- it does **not** override an `inputHold` or a pending **wake** Enter: those are
  other automatic transactions owning the composer (`D34`).
- it does **not** skip `_abortPrepared`. An operator byte in the prepared window
  is still the #78 named halt.

The flush happens in the same call rather than on the next tick, because waiting
a tick is what made this a blackout.

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
   | 2026-10-24T19:56Z | 2.1.310 | 42.352Z | ≤ 43.571Z (400 ms poll) | 0.82–1.22 s |

   Three samples with the same sign are **not** a guarantee. The ordering is not
   contractual, nothing in the host documents it, and a future build could flush
   the record after painting the dialog. It is not bounded below by anything the
   runner can observe, and the dialog times are upper bounds set by the driver's
   400 ms poll rather than the paint itself.

3. **The clear's prepare-to-commit gap.** One scheduler turn between the gate in
   `_prepareSubmission` and the `/clear` text write in `commitClearSubmission`.
   Not closed, for the reason given above; the clear's Enter is gated.

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
   D25`/`D26`) precisely because it proves nothing about the main conversation —
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

`daemons/tests/pty-runner.test.mjs`, vectors `#104 D1`–`D38` plus `#104 M6`. 17 of the first 20
are red before the fix; `D1` is the first red and is the reported defect with
nothing else wrong (the vector asserts the composer is clean in setup, so the old
guard permits the write). `D21`, `D23` and `D24` are red against a *record*-scoped
anchor — `D21` holds 1 outstanding call where it must hold 2, which is the
parallel-call fail-open — and `D22` is green either way, because it pins the
liveness half the scoping must not break.

`D25` and `D26` are red against an anchor that admitted sidechain responses, both
reporting `ready: true` with a main-conversation call still outstanding: `D25`
that such a record cannot clear the set, `D26` that it cannot discharge an
unanchored baseline either. Each then asserts the liveness half — a real answer,
and a real main-conversation anchor, still release — so the exclusion is narrow.
`D27`–`D31` cover the oversize-record step, which had **zero** coverage before
this round — nothing in `D1`–`D26` produced a record larger than one window, and
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

### Host evidence

`scratchpad/p104/driver2.cjs` — bounded, isolated, cancel-only, never approves.
It runs a real `claude.exe` against an authenticated disposable profile with
`permissions.ask: ["Read"]`, and drives the **shipped** reader and the **shipped**
`_writeControlEnter` (methods borrowed from `ManagedPtyRunner.prototype`, so the
code under test is the code that ships) against the **live** transcript, with a
spy PTY so nothing can reach the child.

Run twice: `2026-10-24T18:58Z` (session `a1b3a275`, against the text-write and
delayed-Enter guards) and `2026-10-24T19:56Z` (session `e8cd53af`, re-run against
the final response-scoped reader). Both on binary **2.1.310**, both `ok: true`.
Figures below are the second run:

- **No automatic answer.** Three samples while a real dialog was on screen:
  `ready=false`, `runner-tool-call-outstanding`, outstanding id
  `Read:toolu_01SR8oPZs7…`. The shipped Enter boundary wrote **0** Enters,
  rescheduled once, and kept the stranded-text flag up.
- **Cancellation recovers.** ESC only. Within 1.5 s readiness returned and the
  boundary wrote exactly one Enter — not wedged. The cancellation settled its
  own call (`Read`, `is_error: true`).
- **Ordinary success does not stick.** `Glob` (in `permissions.allow`, so no
  dialog at all) executed with `is_error: false`. The reader held the boundary
  across three consecutive samples while it ran, then released; three
  post-execution samples all ready, all writing. That is the signal working on a
  tool call with no dialog behind it at all — it tracks the call's lifetime, not
  the dialog's.

Raw artifacts: `scratchpad/p104/run2/` (`driver2.log`, `samples.json`,
`screen.log`, `PROMPT.txt`, `CANCELLED.txt`).
