// Drives the real register.ts tick against temp directories with a fake engine.
// node --test plugins/fleet-delivery/tests/supervisor-hold.test.mjs  (needs a node that strips types)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const { register, logLine, UNLINK } = await import('../hooks/register.ts')

const SEAT = 'testseat'
const LEG = '[refresh-cycle] Run the fleet resume lifecycle verb now. Load the newest valid capsule.\nROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa'
const CAPSULE_REQUEST = '[refresh-cycle] Run the fleet capsule lifecycle verb now, the full contract in order. Only after the sync verifies, send yourself the locked line.\nROOM-LIFECYCLE capsule-done <capsule-id>'
const CAPSULE_NUDGE = '[refresh-cycle] The capsule announcement is missing after the seat stalled. Finish the fleet capsule lifecycle verb once.'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const ls = dir => (existsSync(dir) ? readdirSync(dir) : [])

function rig({ cycle = 'idle' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fd-hold-'))
  const root = join(base, 'install')
  const room = join(base, 'room')
  const memory = join(root, 'memory')
  const admit = join(room, 'state', 'admit', SEAT)
  const holdPath = join(room, 'state', 'holds', `${SEAT}.json`)
  for (const dir of [join(root, '.aigent'), join(memory, 'runtime'), join(room, 'inbox', SEAT), join(room, 'state', 'holds')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, '.aigent', 'delivery-owner.json'), JSON.stringify({ owner: { [SEAT]: 'mod' } }))
  writeFileSync(join(memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: cycle }))
  writeFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), `${logLine({ id: 'seed', source: 'seed', at: '', status: 'seed' })}\n`)
  const state = new Map()
  const submitted = []
  // One-shot hooks: preparation, the final hold's existence/clock await, and submit.
  const hooks = {}
  const fire = async name => { const f = hooks[name]; delete hooks[name]; if (f) await f() }
  const statuses = []
  const holdSamples = []
  const tickets = () => ls(admit)
  let holdLookups = 0
  let finalClock = false
  let now = Date.parse('2026-10-24T12:00:00Z')
  const $ = {
    clock: {
      now: async () => { if (finalClock) { finalClock = false; await fire('finalClock') } return now },
      after: (ms, fn) => { if (hooks.timeout) { delete hooks.timeout; queueMicrotask(fn) } return { cancel() {} } },
      every: () => ({ cancel() {} }),
    },
    env: { get: async () => undefined },
    session: { root: async () => root },
    fs: {
      exists: async p => {
        const present = existsSync(p)
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && ++holdLookups === 2) {
          holdSamples.push({ kind: 'exists', present, tickets: tickets() })
          finalClock = present
          await fire('finalLookup')
        }
        return present
      },
      read: async p => {
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && holdLookups === 2) holdSamples.push({ kind: 'read', tickets: tickets() })
        return readFileSync(p, 'utf8')
      },
      write: async (p, t) => { if (p.includes('mod-delivery-ledger') && t.includes('"status":"submitting"')) await fire('write'); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t) },
      stat: async p => ({ size: readFileSync(p).length, kind: 'file', isLink: false }),
      list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })),
    },
    process: {
      run: async argv => {
        if (argv.some(a => /inbox/.test(a))) await fire('run')
        if (argv[2] === UNLINK && hooks.failUnlink) {
          delete hooks.failUnlink
          return { exitCode: 1, stdout: '', stderr: 'EPERM' }
        }
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
      },
    },
    state: {
      get: async key => state.get(key.key) ?? { value: undefined, version: 0 },
      set: async (key, value, opt) => {
        const held = state.get(key.key) ?? { value: undefined, version: 0 }
        if (opt?.ifVersion !== undefined && opt.ifVersion !== held.version) return { isSet: false }
        state.set(key.key, { value, version: held.version + 1 })
        return { isSet: true }
      },
    },
    store: { get: async () => undefined, delete: async () => {} },
    prompt: {
      read: async () => { await fire('read'); return { text: '' } },
      submit: async ({ text }) => {
        await fire('submit')
        if (hooks.reject) { delete hooks.reject; throw new Error('transient') }
        submitted.push(text)
        if (hooks.pending) { const pending = hooks.pending; delete hooks.pending; return pending }
        return {}
      },
    },
    ui: { status: s => statuses.push(s), log() {} },
    command: { register: async () => {} },
  }
  const handlers = {}
  register((name, ...rest) => {
    handlers[name] = rest.at(-1)
    return { catch() {} }
  }, { installRoot: root, roomRoot: room, seat: SEAT })
  const tick = async () => {
    holdLookups = 0
    finalClock = false
    const before = statuses.length
    await handlers['turn.complete']($, { agentId: undefined }, async () => {})
    // The tick runs detached: wait for its first status, then for quiet.
    for (let i = 0; i < 300 && statuses.length === before; i++) await sleep(100)
    for (let seen = -1; seen !== statuses.length + submitted.length; ) {
      seen = statuses.length + submitted.length
      await sleep(700)
    }
  }
  const drop = (name, from, body, priority) =>
    writeFileSync(join(room, 'inbox', SEAT, `${name}.json`), JSON.stringify({ from, to: SEAT, ts: '2026-10-24T11:59:00Z', parts: [{ text: body }], ...(priority ? { priority } : {}) }))
  // `phase` is the newer supervisor's optional label; omitted, the file has the older shape.
  const freeze = (ts, phase) => writeFileSync(join(room, 'state', 'holds', `${SEAT}.json`), JSON.stringify({ version: 1, seat: SEAT, ts: new Date(ts ?? now).toISOString(), ...(phase ? { phase } : {}) }))
  const thaw = () => rmSync(join(room, 'state', 'holds', `${SEAT}.json`), { force: true })
  const ledger = () =>
    Object.fromEntries(
      readFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l.replace(/^\d+ /, ''))).filter(l => l.id.startsWith('room:')).map(l => [l.id, l.status]),
    )
  return {
    submitted, statuses, hooks, tick, drop, freeze, thaw, ledger, admit, tickets, holdSamples,
    ticket: file => JSON.parse(readFileSync(join(admit, file), 'utf8')),
    advance: ms => { now += ms },
    logText: () => readFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), 'utf8'),
    inbox: () => ls(join(room, 'inbox', SEAT)),
    claimed: () => ls(join(room, 'claimed', SEAT)),
    processed: () => ls(join(room, 'processed', SEAT)),
    last: () => statuses.at(-1),
    done: () => rmSync(base, { recursive: true, force: true }),
  }
}

test('(a) frozen seat: an ordinary message is deferred, not acked, still queued', async () => {
  const r = rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-aaaa', 'peer', 'hello there')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-aaaa.json'], 'deferred:supervisor-hold')
    assert.equal(r.inbox().length, 1)
    assert.equal(r.claimed().length + r.processed().length, 0)
    assert.match(r.last(), /supervisor-hold, 1 deferred/)
  } finally { r.done() }
})

test('(b) frozen seat: the supervisor resume leg is delivered', async () => {
  const r = rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-bbbb', `${SEAT}-supervisor`, LEG)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /Run the fleet resume lifecycle verb/)
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-bbbb.json'], 'submitted')
  } finally { r.done() }
})

test('(c) an ordinary sender imitating a lifecycle line is still deferred; so is the supervisor with another body', async () => {
  const r = rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-cccc', 'peer', LEG)
    r.drop('2026-10-24T11-59-01-dddd', `${SEAT}-supervisor`, 'ordinary text from the supervisor name')
    r.drop('2026-10-24T11-59-02-eeee', 'otherseat-supervisor', LEG)
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.inbox().length, 3)
    assert.deepEqual(Object.values(r.ledger()), Array(3).fill('deferred:supervisor-hold'))
  } finally { r.done() }
})

test('(d) after release the deferred message delivers once with exactly one ack', async () => {
  const r = rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-ffff', 'peer', 'hold this')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /hold this/)
    const acks = r.logText().split(String.fromCharCode(10)).filter(l => l.includes('"status":"submitted"') && l.includes('ffff'))
    assert.equal(acks.length, 1)
    assert.equal(r.processed().length, 1)
    assert.equal(r.inbox().length + r.claimed().length, 0)
  } finally { r.done() }
})

test('stale or unreadable freeze fails closed for everything, with a named reason', async () => {
  const r = rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000)
    r.drop('2026-10-24T11-59-00-1111', `${SEAT}-supervisor`, LEG)
    r.drop('2026-10-24T11-59-01-2222', 'peer', 'plain')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(Object.values(r.ledger()), Array(2).fill('deferred:supervisor-hold-stale'))
    assert.match(r.last(), /supervisor-hold-stale/)
  } finally { r.done() }
})

test('(e) the runner cycle hold still holds everything, supervisor legs included', async () => {
  const r = rig({ cycle: 'CLEAR_PENDING' })
  try {
    r.drop('2026-10-24T11-59-00-3333', `${SEAT}-supervisor`, LEG)
    r.drop('2026-10-24T11-59-01-4444', 'peer', 'plain')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(Object.values(r.ledger()), Array(2).fill('deferred:refresh-hold'))
  } finally { r.done() }
})

test('a control self-line stays skipped:control during a freeze', async () => {
  const r = rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-5555', SEAT, 'ROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-5555.json'], 'skipped:control')
  } finally { r.done() }
})

test('capsule window to resume-done: ordinary item queued and unacked throughout, delivered once at release', async () => {
  const r = rig()
  try {
    const ORD = 'room:testseat:2026-10-24T11-59-00-9999.json'
    // Capsule request goes out: the supervisor has written the hold (phase capsule) first.
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-9999', 'peer', 'ordinary mid-capsule message')
    r.drop('2026-10-24T11-59-01-c0c0', `${SEAT}-supervisor`, CAPSULE_REQUEST)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /Run the fleet capsule lifecycle verb/)
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-01-c0c0.json'], 'submitted')
    assert.equal(r.ledger()[ORD], 'deferred:supervisor-hold')
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'], 'ordinary item still in inbox/')
    assert.equal(r.processed().includes('2026-10-24T11-59-00-9999.json'), false, 'ordinary item not processed')
    assert.equal(r.claimed().length, 0)

    // A stalled seat gets the nudge: also a lifecycle leg, also delivered. Still holding the ordinary item.
    r.advance(10 * 60_000)
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-02-c1c1', `${SEAT}-supervisor`, CAPSULE_NUDGE)
    await r.tick()
    assert.equal(r.submitted.length, 2)
    assert.match(r.submitted[1], /capsule announcement is missing/)
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'])

    // Clear submitted: the supervisor re-stamps (phase resume). A capsule phase longer than the fuse
    // measured from the first stamp must not fail the resume leg closed.
    r.advance(25 * 60_000)
    r.freeze(undefined, 'resume')
    r.drop('2026-10-24T11-59-03-c2c2', `${SEAT}-supervisor`, LEG)
    await r.tick()
    assert.equal(r.submitted.length, 3)
    assert.match(r.submitted[2], /Run the fleet resume lifecycle verb/)
    assert.equal(r.ledger()[ORD], 'deferred:supervisor-hold', 'still the fresh hold, not stale')
    assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-9999.json'])

    // resume-done: the supervisor removes the file. The ordinary item delivers once; a re-tick adds nothing.
    r.thaw()
    await r.tick()
    assert.equal(r.submitted.length, 4)
    assert.match(r.submitted[3], /ordinary mid-capsule message/)
    await r.tick()
    assert.equal(r.submitted.length, 4, 'a re-tick delivers nothing more')
    const acks = r.logText().split(String.fromCharCode(10)).filter(l => l.includes('"status":"submitted"') && l.includes('9999'))
    assert.equal(acks.length, 1, 'exactly one ack')
    assert.equal(r.processed().filter(n => n.includes('9999')).length, 1)
    assert.equal(r.inbox().length + r.claimed().length, 0)
  } finally { r.done() }
})

test('a capsule-phase hold the supervisor stopped re-stamping goes stale and fails closed, legs included', async () => {
  const r = rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000, 'capsule')
    r.drop('2026-10-24T11-59-00-7777', `${SEAT}-supervisor`, CAPSULE_NUDGE)
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-7777.json'], 'deferred:supervisor-hold-stale')
  } finally { r.done() }
})

// Urgent mail was delivered before the capsule window was held, so it still passes pre-submit only.
for (const [label, phase, urgentDelivered] of [['phase capsule', 'capsule', true], ['phase resume', 'resume', false], ['no phase (older supervisor)', undefined, false]]) {
  test(`urgent vs ordinary under ${label}`, async () => {
    const r = rig()
    try {
      r.freeze(undefined, phase)
      r.drop('2026-10-24T11-59-00-u001', 'peer', 'urgent text', 'urgent')
      r.drop('2026-10-24T11-59-01-o002', 'peer', 'ordinary text')
      await r.tick()
      const U = 'room:testseat:2026-10-24T11-59-00-u001.json'
      const O = 'room:testseat:2026-10-24T11-59-01-o002.json'
      assert.equal(r.ledger()[O], 'deferred:supervisor-hold', 'ordinary is held in every phase')
      assert.deepEqual(r.inbox().filter(n => n.includes('o002')).length, 1)
      if (urgentDelivered) {
        assert.equal(r.ledger()[U], 'submitted')
        assert.equal(r.submitted.length, 1)
        assert.match(r.submitted[0], /urgent text/)
      } else {
        assert.equal(r.ledger()[U], 'deferred:supervisor-hold')
        assert.deepEqual(r.submitted, [])
      }
    } finally { r.done() }
  })
}

test('urgent mail does not pass a stale capsule-phase hold', async () => {
  const r = rig()
  try {
    r.freeze(Date.parse('2026-10-24T12:00:00Z') - 31 * 60_000, 'capsule')
    r.drop('2026-10-24T11-59-00-u003', 'peer', 'urgent text', 'urgent')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-u003.json'], 'deferred:supervisor-hold-stale')
  } finally { r.done() }
})

// The hold is read at the start of the tick; these change it during preparation, at each await before
// the submit. The recheck must catch each one, leave the item in inbox/, and a thaw must deliver once.
for (const point of ['read', 'run', 'write']) {
  test(`hold appears during preparation (${point}): ordinary item not submitted, stays queued, delivered once after thaw`, async () => {
    const r = rig()
    try {
      const ID = 'room:testseat:2026-10-24T11-59-00-p001.json'
      r.drop('2026-10-24T11-59-00-p001', 'peer', 'prepared text')
      r.hooks[point] = () => r.freeze(undefined, 'capsule')
      await r.tick()
      assert.deepEqual(r.submitted, [], 'not submitted')
      assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
      assert.deepEqual(r.inbox(), ['2026-10-24T11-59-00-p001.json'], 'back in inbox/')
      assert.equal(r.claimed().length + r.processed().length, 0)
      r.thaw()
      await r.tick()
      await r.tick()
      assert.equal(r.submitted.length, 1)
      assert.match(r.submitted[0], /prepared text/)
      assert.equal(r.processed().length, 1)
      assert.equal(r.ledger()[ID], 'submitted')
    } finally { r.done() }
  })
}

test('urgent admitted under phase capsule, hold flips to resume during preparation: not submitted, delivered once after thaw', async () => {
  const r = rig()
  try {
    const ID = 'room:testseat:2026-10-24T11-59-00-p002.json'
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-p002', 'peer', 'urgent prepared', 'urgent')
    r.hooks.read = () => r.freeze(undefined, 'resume')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
    assert.equal(r.inbox().length, 1)
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.processed().length, 1)
  } finally { r.done() }
})

test('a hold that stays unchanged through preparation does not block delivery (recheck control)', async () => {
  const r = rig()
  try {
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-p003', 'peer', 'urgent ok', 'urgent')
    r.hooks.read = () => r.freeze(undefined, 'capsule')
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('recheck deferrals do not count against the retry cap: a later transient rejection is still retried', async () => {
  const r = rig()
  try {
    const ID = 'room:testseat:2026-10-24T11-59-00-p004.json'
    r.drop('2026-10-24T11-59-00-p004', 'peer', 'cap text')
    for (let i = 0; i < 3; i++) {
      r.hooks.read = () => r.freeze(undefined, 'capsule')
      await r.tick()
      assert.equal(r.ledger()[ID], 'deferred:supervisor-hold')
      r.thaw()
    }
    assert.deepEqual(r.submitted, [])
    r.hooks.reject = true
    await r.tick()
    assert.equal(r.ledger()[ID], 'deferred:submit-rejected', 'retried, not terminal')
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[ID], 'submitted')
  } finally { r.done() }
})

test('urgent capsule item sees resume published during the final clock await, then delivers once after thaw', async () => {
  const r = rig()
  try {
    const file = '2026-10-24T11-59-00-a001.json'
    const id = `room:${SEAT}:${file}`
    r.freeze(undefined, 'capsule')
    r.drop(file.slice(0, -5), 'peer', 'urgent boundary', 'urgent')
    let ticketAtTransition
    r.hooks.finalClock = async () => {
      ticketAtTransition = r.ticket(file)
      r.freeze(undefined, 'resume')
    }
    await r.tick()
    assert.equal(ticketAtTransition.id, id)
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.ledger()[id], 'deferred:supervisor-hold')
    assert.deepEqual(r.inbox(), [file])
    assert.equal(r.claimed().length + r.processed().length, 0)
    assert.deepEqual(r.holdSamples.find(s => s.kind === 'read').tickets, [file])
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.processed(), [file])
    assert.equal(r.logText().split('\n').filter(l => l.includes(id) && l.includes('"status":"submitted"')).length, 1)
  } finally { r.done() }
})

test('hold published after the final absence sample admits the already ticketed ordinary submit', async () => {
  const r = rig()
  try {
    const file = '2026-10-24T11-59-00-a002.json'
    r.drop(file.slice(0, -5), 'peer', 'ordinary boundary')
    let ticketBeforeHold
    r.hooks.finalLookup = async () => {
      ticketBeforeHold = r.ticket(file)
      r.freeze(undefined, 'capsule')
    }
    await r.tick()
    assert.equal(ticketBeforeHold.id, `room:${SEAT}:${file}`)
    assert.deepEqual(r.holdSamples, [{ kind: 'exists', present: false, tickets: [file] }])
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [])
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

for (const outcome of ['resolve', 'reject', 'timeout']) {
  test(`admission ticket is present during submit and removed after ${outcome}`, async () => {
    const r = rig()
    try {
      const file = '2026-10-24T11-59-00-a003.json'
      const id = `room:${SEAT}:${file}`
      r.drop(file.slice(0, -5), 'peer', 'ticket lifetime')
      let during
      r.hooks.submit = () => { during = r.ticket(file) }
      if (outcome === 'reject') r.hooks.reject = true
      let finish
      if (outcome === 'timeout') {
        r.hooks.pending = new Promise(resolve => { finish = resolve })
        r.hooks.timeout = true
      }
      await r.tick()
      assert.deepEqual(during, { version: 1, seat: SEAT, id, pid: process.pid, ts: '2026-10-24T12:00:00.000Z' })
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.ledger()[id], { resolve: 'submitted', reject: 'deferred:submit-rejected', timeout: 'submitting:unresolved' }[outcome])
      if (outcome === 'timeout') {
        await r.tick()
        assert.equal(r.submitted.length, 1, 'unknown outcome is never retried')
        finish({})
        for (let i = 0; i < 100 && !r.processed().includes(file); i++) await sleep(100)
        assert.equal(r.ledger()[id], 'submitted', 'late start still settles the ledger')
        assert.deepEqual(r.processed(), [file])
        assert.deepEqual(r.tickets(), [])
      }
    } finally { r.done() }
  })
}

test('an unwritable admission directory defers, restores the Room file, and does not consume retries', async () => {
  const r = rig()
  try {
    const file = '2026-10-24T11-59-00-a004.json'
    const id = `room:${SEAT}:${file}`
    mkdirSync(dirname(r.admit), { recursive: true })
    writeFileSync(r.admit, 'not a directory')
    r.drop(file.slice(0, -5), 'peer', 'unwritable ticket')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    assert.deepEqual(r.inbox(), [file])
    assert.equal(r.claimed().length + r.processed().length, 0)
    const lines = r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.deepEqual(lines.map(l => l.status), ['submitting', 'deferred:admission-unwritable'])
    assert.equal(lines.at(-1).attempts ?? 0, 0)
    rmSync(r.admit)
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('tick start removes this process tickets and leaves other pids alone', async () => {
  const r = rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    for (const [file, pid] of [['own.json', process.pid], ['foreign.json', process.pid + 1]]) {
      writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, id: `room:${SEAT}:${file}`, pid, ts: '2026-10-24T12:00:00.000Z' }))
    }
    await r.tick()
    assert.deepEqual(r.tickets(), ['foreign.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('a failed ticket removal logs one note and the next tick cleans the leak without resending', async () => {
  const r = rig()
  try {
    const file = '2026-10-24T11-59-00-a005.json'
    r.drop(file.slice(0, -5), 'peer', 'unlink failure')
    r.hooks.failUnlink = true
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [file])
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission removal failed: exit 1 EPERM')).length, 1)
    await r.tick()
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('an admission ticket already removed at submit settlement is successful cleanup', async () => {
  const r = rig()
  try {
    const file = '2026-10-24T11-59-00-a006.json'
    r.drop(file.slice(0, -5), 'peer', 'already removed ticket')
    let existed = false
    r.hooks.submit = () => { existed = r.tickets().includes(file); rmSync(join(r.admit, file)) }
    await r.tick()
    assert.equal(existed, true)
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.tickets(), [])
    assert.doesNotMatch(r.logText(), /admission removal failed/)
  } finally { r.done() }
})
