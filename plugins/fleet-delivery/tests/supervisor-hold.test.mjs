// Drives the real register.ts tick against temp directories with a fake engine.
// node --test plugins/fleet-delivery/tests/supervisor-hold.test.mjs  (needs a node that strips types)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const { logLine, UNLINK, MOVE, WRITE, OWNER_PID, PID_DEAD, safeName } = await import('../hooks/register.ts')

const SEAT = 'testseat'
const LEG = '[refresh-cycle] Run the fleet resume lifecycle verb now. Load the newest valid capsule.\nROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa'
const CAPSULE_REQUEST = '[refresh-cycle] Run the fleet capsule lifecycle verb now, the full contract in order. Only after the sync verifies, send yourself the locked line.\nROOM-LIFECYCLE capsule-done <capsule-id>'
const CAPSULE_NUDGE = '[refresh-cycle] The capsule announcement is missing after the seat stalled. Finish the fleet capsule lifecycle verb once.'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const ls = dir => (existsSync(dir) ? readdirSync(dir) : [])
const ticketName = (base, ticket) => `${base.startsWith('job-') ? base.slice(0, -5) : base}.${ticket.attempt}.json`
const ticketMatches = (path, base) => path.replaceAll('\\', '/').split('/').at(-1).startsWith(`${base.startsWith('job-') ? base.slice(0, -5) : base}.`) && path.endsWith('.json')

let moduleId = 0
async function rig({ cycle = 'idle', noPid = false, entries = [], jobs = [], submitTimeoutMinutes } = {}) {
  const { register } = await import(`../hooks/register.ts?rig=${++moduleId}`)
  const base = mkdtempSync(join(tmpdir(), 'fd-hold-'))
  const root = join(base, 'install')
  const room = join(base, 'room')
  const memory = join(root, 'memory')
  const admit = join(room, 'state', 'admit', SEAT)
  const holdPath = join(room, 'state', 'holds', `${SEAT}.json`)
  for (const dir of [join(root, '.aigent'), join(memory, 'runtime'), join(room, 'inbox', SEAT), join(room, 'state', 'holds')]) mkdirSync(dir, { recursive: true })
  if (jobs.length) {
    mkdirSync(join(root, 'daemons'))
    writeFileSync(join(root, 'daemons', 'job-results.mjs'), '')
  }
  writeFileSync(join(root, '.aigent', 'delivery-owner.json'), JSON.stringify({ owner: { [SEAT]: 'mod' } }))
  writeFileSync(join(memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: cycle }))
  writeFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), `${logLine({ id: 'seed', source: 'seed', at: '', status: 'seed' })}\n`)
  const logPath = join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`)
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + entries.map(e => `${logLine(e)}\n`).join(''))
  const state = new Map()
  const submitted = []
  // One-shot hooks: preparation, the final hold's existence/read await, and submit.
  const hooks = {}
  const fire = async name => { const f = hooks[name]; delete hooks[name]; if (f) await f() }
  const statuses = []
  const holdSamples = []
  const tickets = () => ls(admit)
  const ticketFile = file => {
    const matches = tickets().filter(name => ticketMatches(name, file))
    assert.equal(matches.length, 1, `one attempt for ${file}`)
    return matches[0]
  }
  let holdLookups = 0
  const runs = []
  const order = []
  const writes = []
  const logs = []
  let now = Date.parse('2026-10-24T12:00:00Z')
  const $ = {
    clock: {
      now: async () => now,
      after: (ms, fn) => { if (hooks.timeout) { delete hooks.timeout; queueMicrotask(fn) } return { cancel() {} } },
      every: () => ({ cancel() {} }),
    },
    env: { get: async () => undefined },
    session: { root: async () => root },
    fs: {
      exists: async p => {
        if (hooks.ticketExistsThrows && p.endsWith('.json') && p.replaceAll('\\', '/').includes('/state/admit/')) throw new Error('EIO')
        const present = existsSync(p)
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && ++holdLookups === 2) {
          holdSamples.push({ kind: 'exists', present, tickets: tickets() })
          await fire('finalLookup')
        }
        return present
      },
      read: async p => {
        if (hooks.ticketUnreadable && p.replaceAll('\\', '/').includes('/state/admit/')) throw new Error('EACCES')
        if (p.replaceAll('\\', '/').includes('/state/admit/')) await fire('ticketRead')
        if (p.replaceAll('\\', '/') === holdPath.replaceAll('\\', '/') && holdLookups === 2) {
          holdSamples.push({ kind: 'read', tickets: tickets() })
          await fire('finalRead')
        }
        return readFileSync(p, 'utf8')
      },
      write: async (p, t) => { writes.push(p); if (p.includes('mod-delivery-ledger') && t.includes('"status":"submitting"')) await fire('write'); writeFileSync(p, t) },
      stat: async p => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, kind: s.isDirectory() ? 'dir' : 'file', isLink: false } },
      list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })),
    },
    process: {
      run: async argv => {
        runs.push(argv)
        order.push({ kind: 'run', argv })
        if (argv[2] === WRITE && hooks.writeHost) {
          const answer = await hooks.writeHost(argv)
          if (answer) return answer
        }
        if (argv[1]?.endsWith('/daemons/job-results.mjs')) return { exitCode: 0, stdout: JSON.stringify(jobs), stderr: '' }
        if (argv[2] === OWNER_PID && hooks.ownerProbe) return hooks.ownerProbe()
        if (argv[2] === OWNER_PID && noPid) return { exitCode: 1, stdout: '', stderr: 'unavailable' }
        if (argv[2] === PID_DEAD && hooks.pidProbe) return hooks.pidProbe(argv.at(-1))
        if (argv.some(a => /inbox/.test(a))) await fire('run')
        if (argv[2] === UNLINK) await fire('beforeUnlink')
        if (argv[2] === UNLINK && hooks.failUnlink) {
          delete hooks.failUnlink
          return { exitCode: 1, stdout: '', stderr: 'EPERM' }
        }
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
        if (r.status === 0 && argv[2] === WRITE && argv[4].endsWith('.json')) await fire('published')
        if (r.status === 0 && argv.at(-1).replaceAll('\\', '/') === logPath.replaceAll('\\', '/')) {
          order.push({ kind: 'ledger', entry: JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1).replace(/^\d+ /, '')) })
        }
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
      },
    },
    state: {
      get: async key => state.get(key.key) ?? { value: undefined, version: 0 },
      set: async (key, value, opt) => {
        const held = state.get(key.key) ?? { value: undefined, version: 0 }
        if (opt?.ifVersion !== undefined && opt.ifVersion !== held.version) return { isSet: false }
        state.set(key.key, { value, version: held.version + 1 })
        if (hooks.stateSet) await hooks.stateSet(key, value)
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
    ui: { status: s => statuses.push(s), log: s => logs.push(s) },
    command: { register: async () => {} },
  }
  const handlers = {}
  const install = register => register((name, ...rest) => {
    handlers[name] = rest.at(-1)
    return { catch() {} }
  }, { installRoot: root, roomRoot: room, seat: SEAT, submitTimeoutMinutes, ...(jobs.length ? { jobSeat: SEAT } : {}) })
  install(register)
  const tick = async () => {
    holdLookups = 0
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
    submitted, statuses, hooks, tick, drop, freeze, thaw, ledger, admit, tickets, ticketFile,
    recoverPid: () => { noPid = false },
    reconcile: args => handlers['command.run']($, { args }), holdSamples, runs, order, writes, logs,
    reload: async () => install((await import(`../hooks/register.ts?rig=${++moduleId}`)).register),
    held: id => state.get('ledger')?.value?.[SEAT]?.[id],
    supersede: () => {
      const held = state.get('generation')
      state.set('generation', { value: held.value + 1, version: held.version + 1 })
    },
    ticket: file => JSON.parse(readFileSync(join(admit, ticketFile(file)), 'utf8')),
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
  const r = await rig()
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
  const r = await rig()
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
  const r = await rig()
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
  const r = await rig()
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
  const r = await rig()
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
  const r = await rig({ cycle: 'CLEAR_PENDING' })
  try {
    r.drop('2026-10-24T11-59-00-3333', `${SEAT}-supervisor`, LEG)
    r.drop('2026-10-24T11-59-01-4444', 'peer', 'plain')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(Object.values(r.ledger()), Array(2).fill('deferred:refresh-hold'))
  } finally { r.done() }
})

test('a control self-line stays skipped:control during a freeze', async () => {
  const r = await rig()
  try {
    r.freeze()
    r.drop('2026-10-24T11-59-00-5555', SEAT, 'ROOM-LIFECYCLE resume-done 20260101-0000-aaaaaaaa')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()['room:testseat:2026-10-24T11-59-00-5555.json'], 'skipped:control')
  } finally { r.done() }
})

test('capsule window to resume-done: ordinary item queued and unacked throughout, delivered once at release', async () => {
  const r = await rig()
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
  const r = await rig()
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
    const r = await rig()
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
  const r = await rig()
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
    const r = await rig()
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
  const r = await rig()
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
  const r = await rig()
  try {
    r.freeze(undefined, 'capsule')
    r.drop('2026-10-24T11-59-00-p003', 'peer', 'urgent ok', 'urgent')
    r.hooks.read = () => r.freeze(undefined, 'capsule')
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('recheck deferrals do not count against the retry cap: a later transient rejection is still retried', async () => {
  const r = await rig()
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

test('urgent capsule item sees resume published during the final hold read await, then delivers once after thaw', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a001.json'
    const id = `room:${SEAT}:${file}`
    r.freeze(undefined, 'capsule')
    r.drop(file.slice(0, -5), 'peer', 'urgent boundary', 'urgent')
    let ticketAtTransition
    r.hooks.finalRead = async () => {
      ticketAtTransition = r.ticket(file)
      r.freeze(undefined, 'resume')
    }
    await r.tick()
    assert.equal(ticketAtTransition.item, id)
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.ledger()[id], 'deferred:supervisor-hold')
    assert.deepEqual(r.inbox(), [file])
    assert.equal(r.claimed().length + r.processed().length, 0)
    assert.deepEqual(r.holdSamples.find(s => s.kind === 'read').tickets, [ticketName(file, ticketAtTransition)])
    r.thaw()
    await r.tick()
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.processed(), [file])
    assert.equal(r.logText().split('\n').filter(l => l.includes(id) && l.includes('"status":"submitted"')).length, 1)
  } finally { r.done() }
})

test('hold published after the final absence sample admits the already ticketed ordinary submit', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a002.json'
    r.drop(file.slice(0, -5), 'peer', 'ordinary boundary')
    let ticketBeforeHold
    r.hooks.finalLookup = async () => {
      ticketBeforeHold = r.ticket(file)
      r.freeze(undefined, 'capsule')
    }
    await r.tick()
    assert.equal(ticketBeforeHold.item, `room:${SEAT}:${file}`)
    assert.deepEqual(r.holdSamples, [{ kind: 'exists', present: false, tickets: [ticketName(file, ticketBeforeHold)] }])
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [])
    await r.tick()
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

for (const outcome of ['resolve', 'reject', 'timeout']) {
  test(`admission ticket is present during submit and ${outcome === 'timeout' ? 'retained after timeout' : `removed after ${outcome}`}`, async () => {
    const r = await rig()
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
      assert.deepEqual(during, { version: 1, seat: SEAT, item: id, attempt: during.attempt, pid: process.pid, ts: '2026-10-24T12:00:00.000Z' })
      assert.match(during.attempt, new RegExp(`^${process.pid}-[0-9]+-[0-9]+-[0-9]+-[0-9a-f]{6}$`))
      assert.deepEqual(r.tickets(), outcome === 'timeout' ? [ticketName(file, during)] : [])
      const status = { resolve: 'submitted', reject: 'deferred:submit-rejected', timeout: 'submitting:unresolved' }[outcome]
      assert.equal(r.ledger()[id], status)
      const recorded = r.order.findIndex(e => e.kind === 'ledger' && e.entry.id === id && e.entry.status === status)
      const unlinked = r.order.findIndex(e => e.kind === 'run' && e.argv[2] === UNLINK && ticketMatches(e.argv.at(-1), file))
      if (outcome === 'timeout') assert.equal(unlinked, -1, 'timeout is not settlement evidence')
      else assert.ok(recorded >= 0 && unlinked > recorded, 'settlement ledger line precedes ticket UNLINK')
      if (outcome === 'resolve') {
        const finished = r.order.findIndex(e => e.kind === 'run' && e.argv[2] === MOVE && e.argv.at(-1).includes('/processed/'))
        assert.ok(finished > recorded && unlinked > finished, 'finishRoomFile precedes ticket UNLINK')
      }
      if (outcome === 'timeout') {
        r.advance(31 * 60_000)
        await r.tick()
        assert.deepEqual(r.tickets(), [ticketName(file, during)], 'age and a later sweep do not release an unresolved submit')
        assert.equal(r.submitted.length, 1, 'unknown outcome is never retried')
        finish({})
        for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
        assert.equal(r.ledger()[id], 'submitted', 'late start still settles the ledger')
        assert.deepEqual(r.processed(), [file])
        assert.deepEqual(r.tickets(), [])
      }
    } finally { r.done() }
  })
}

test('the first ticket atomically creates an absent admission directory and submits', async () => {
  const r = await rig()
  try {
    assert.equal(existsSync(r.admit), false)
    r.drop('first-ticket', 'peer', 'create admission directory')
    r.hooks.submit = () => {
      assert.equal(r.ticket('first-ticket.json').item, `room:${SEAT}:first-ticket.json`)
      assert.deepEqual(r.tickets(), [r.ticketFile('first-ticket.json')], 'no temporary file remains after publication')
    }
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, 1)
    assert.equal(r.writes.some(p => p.includes('/state/admit/')), false)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('an item-specific admission failure consumes retries and lets the next item submit in the same tick', async () => {
  const r = await rig()
  try {
    const file = 'a-bad-ticket.json'
    const id = `room:${SEAT}:${file}`
    // Only this ticket's write fails permanently. The directory accepts the probe.
    r.hooks.writeHost = argv => ticketMatches(argv[4], file) ? { exitCode: 1, stdout: '', stderr: 'EACCES' } : null
    r.drop(file.slice(0, -5), 'peer', 'bad ticket destination')
    r.drop('b-good-ticket', 'peer', 'good ticket destination')
    await r.tick()
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    assert.equal(r.submitted.length, 1)
    assert.match(r.submitted[0], /good ticket destination/)
    assert.deepEqual(r.inbox(), [file])
    assert.deepEqual(r.processed(), ['b-good-ticket.json'])
    const lines = () => r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.equal(lines().at(-1).attempts, 1)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[4].includes('/.probe-')).length, 1)
    assert.deepEqual(r.tickets(), [], 'no ticket lands and the successful probe is removed')
    await r.tick()
    assert.equal(lines().at(-1).attempts, 2)
    assert.equal(r.ledger()[id], 'deferred:admission-unwritable')
    await r.tick()
    assert.equal(lines().at(-1).attempts, 3)
    assert.equal(r.ledger()[id], 'error:admission-unwritable')
    assert.deepEqual(r.inbox(), [file])
    const writes = r.runs.filter(argv => argv[2] === WRITE).length
    await r.tick()
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, writes, 'retry cap stops attempts')
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('job admission filenames sanitize colons and distinguish ids with the same sanitized text', async () => {
  const id = 'nightly:2026-10-27'
  assert.match(safeName(id), /^nightly_2026-10-27-[0-9a-f]{8}$/)
  assert.notEqual(safeName(id), safeName('nightly_2026-10-27'))
  assert.match(safeName('a:/\\?* b'), /^a______b-[0-9a-f]{8}$/)
  const r = await rig({ jobs: [{ id, job: 'nightly' }] })
  try {
    const file = `job-${safeName(id)}.json`
    r.hooks.submit = () => {
      assert.deepEqual(r.tickets(), [r.ticketFile(file)])
      assert.equal(r.ticket(file).item, `job:${id}`)
    }
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.match(r.logText(), /"status":"submitted"/)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('tick start removes all probe leftovers and leaves other non-ticket names untouched', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    const foreign = `.probe-${process.pid + 1}`
    writeFileSync(join(r.admit, `.probe-${process.pid}`), '')
    writeFileSync(join(r.admit, '.probe-null'), '')
    writeFileSync(join(r.admit, foreign), '')
    writeFileSync(join(r.admit, 'other.tmp'), JSON.stringify({ pid: process.pid, id: 'job:other' }))
    r.drop('after-probe', 'peer', 'probe swept before submit')
    r.hooks.submit = () => assert.deepEqual(r.tickets(), [r.ticketFile('after-probe.json'), 'other.tmp'].sort())
    await r.tick()
    assert.deepEqual(r.tickets(), ['other.tmp'])
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('an unwritable admission directory defers, restores the Room file, and does not consume retries', async () => {
  const r = await rig()
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
    assert.deepEqual(lines.map(l => l.status), ['deferred:admission-unwritable'])
    assert.equal(lines.at(-1).attempts ?? 0, 0)
    assert.match(lines.at(-1).detail, /EEXIST|ENOTDIR/)
    assert.ok(lines.at(-1).detail.length <= 160)
    // Once the failure is known, even new items defer without a claim move.
    const other = '2026-10-24T11-59-01-a004.json'
    const otherId = `room:${SEAT}:${other}`
    r.drop(other.slice(0, -5), 'peer', 'also waiting')
    const moves = () => r.runs.filter(argv => argv[2] === MOVE).length
    const probes = () => r.runs.filter(argv => argv[2] === WRITE && argv[4].includes('/.probe-')).length
    const beforeMoves = moves()
    assert.equal(probes(), 1, 'directory failure probes immediately')
    await r.tick()
    assert.equal(moves(), beforeMoves)
    assert.equal(probes(), 2)
    assert.equal(r.ledger()[otherId], 'deferred:admission-unwritable')
    for (const queuedId of [id, otherId]) {
      assert.equal(r.logText().split('\n').filter(l => l.includes(queuedId) && l.includes('deferred:admission-unwritable')).length, 1)
    }
    const heldLog = r.logText()
    await r.tick()
    assert.equal(probes(), 3)
    assert.equal(moves(), beforeMoves)
    assert.equal(r.logText(), heldLog)
    assert.deepEqual(r.submitted, [])
    rmSync(r.admit)
    await r.tick()
    assert.equal(probes(), 4)
    assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv.at(-1).includes('/.probe-')).length, 1)
    await r.tick()
    assert.equal(r.submitted.length, 2)
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('tick start preserves own and live foreign tickets and removes only dead owners', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid + 2 ? 0 : 1 })
    for (const [file, pid] of [['own.json', process.pid], ['foreign.json', process.pid + 1], ['dead.json', process.pid + 2]]) {
      writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: `room:${SEAT}:${file}`, pid, ts: '2026-10-24T12:00:00.000Z' }))
    }
    await r.tick()
    assert.deepEqual(r.tickets(), ['foreign.json', 'own.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('a failed own-ticket removal logs one note and later sweeps preserve the leak without resending', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a005.json'
    r.drop(file.slice(0, -5), 'peer', 'unlink failure')
    r.hooks.failUnlink = true
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:${file}`], 'submitted')
    assert.deepEqual(r.tickets(), [r.ticketFile(file)])
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission removal failed: exit 1 EPERM')).length, 1)
    await r.tick()
    assert.deepEqual(r.tickets(), [r.ticketFile(file)])
    assert.equal(r.submitted.length, 1)
  } finally { r.done() }
})

test('an admission ticket already removed at submit settlement is successful cleanup', async () => {
  const r = await rig()
  try {
    const file = '2026-10-24T11-59-00-a006.json'
    r.drop(file.slice(0, -5), 'peer', 'already removed ticket')
    let existed = false
    r.hooks.submit = () => { existed = r.tickets().includes(r.ticketFile(file)); rmSync(join(r.admit, r.ticketFile(file))) }
    await r.tick()
    assert.equal(existed, true)
    assert.equal(r.submitted.length, 1)
    assert.deepEqual(r.tickets(), [])
    assert.doesNotMatch(r.logText(), /admission removal failed/)
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission ticket already gone')).length, 1)
    await r.tick()
    assert.equal(r.logText().split('\n').filter(l => l.includes('note: admission ticket already gone')).length, 1)
  } finally { r.done() }
})

for (const status of ['submitting', 'submitting:unresolved']) {
  test(`sweep preserves an old generation's ${status} and final own-pid tickets`, async () => {
    const liveId = `room:${SEAT}:live.json`
    const finalId = `room:${SEAT}:final.json`
    const r = await rig({ entries: [
      { id: liveId, source: 'room', status, at: '2026-10-24T12:00:00.000Z', pid: String(process.pid), gen: 0, attempts: 1 },
      { id: finalId, source: 'room', status: 'submitted', at: '2026-10-24T12:00:00.000Z', pid: String(process.pid), gen: 0, attempts: 1 },
    ] })
    try {
      mkdirSync(r.admit, { recursive: true })
      for (const [file, id] of [['live.json', liveId], ['final.json', finalId]]) {
        writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid, ts: '2026-10-24T12:00:00.000Z' }))
      }
      await r.tick()
      await r.tick()
      assert.deepEqual(r.tickets(), ['final.json', 'live.json'])
      assert.equal(r.ledger()[liveId], 'submitting:unresolved')
      assert.equal(r.runs.some(argv => argv[2] === UNLINK && argv.at(-1).endsWith('/live.json')), false)
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  })
}

test('pid unavailable defers once without admission or retry cost, retries discovery, and resumes', async () => {
  const r = await rig({ noPid: true })
  try {
    r.drop('no-pid', 'peer', 'deliver without pid')
    let during
    r.hooks.submit = () => { during = r.ticket('no-pid.json') }
    await r.tick()
    const id = `room:${SEAT}:no-pid.json`
    const heldLog = r.logText()
    await r.tick()
    await r.tick()
    assert.equal(r.logText(), heldLog)
    assert.equal(heldLog.split('\n').filter(l => l.includes('deferred:admission-no-pid')).length, 1)
    assert.equal(r.held(id).attempts ?? 0, 0)
    assert.equal(r.held(id).status, 'deferred:admission-no-pid')
    assert.match(r.last(), /admission-no-pid, 1 deferred/)
    assert.equal(r.runs.filter(argv => argv[2] === OWNER_PID).length, 3)
    assert.equal(r.runs.some(argv => argv[2] === WRITE), false)
    assert.deepEqual(r.tickets(), [])
    assert.deepEqual(r.submitted, [])
    assert.deepEqual(r.inbox(), ['no-pid.json'])
    assert.deepEqual(r.claimed(), [])
    r.recoverPid()
    await r.tick()
    assert.equal(during.pid, process.pid)
    assert.equal(during.ts, '2026-10-24T12:00:00.000Z')
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:no-pid.json`], 'submitted')
    assert.equal(r.held(id).attempts, 1)
    await r.tick()
    assert.equal(r.runs.filter(argv => argv[2] === OWNER_PID).length, 4, 'known pid is cached')
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

test('a dead-owner ticket without a ledger entry logs an unlink failure only to the UI', async () => {
  const r = await rig()
  try {
    const id = `room:${SEAT}:leaked.json`
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'leaked.json'), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    r.hooks.failUnlink = true
    await r.tick()
    assert.deepEqual(r.tickets(), ['leaked.json'])
    assert.equal(r.logText().split('\n').some(l => l.includes(id)), false)
    assert.equal(r.ledger()[id], undefined)
    assert.equal(r.logs.filter(l => l.includes('admission removal failed: exit 1 EPERM')).length, 1)
    // The Room file can still arrive and deliver on a later tick.
    r.drop('leaked', 'peer', 'not hidden by a cleanup note')
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[id], 'submitted')
  } finally { r.done() }
})

test('a swept ticket unlink failure preserves the current final ledger status', async () => {
  const id = `room:${SEAT}:finished.json`
  const r = await rig({ entries: [{ id, source: 'room', status: 'submitted', attempts: 2, at: '2026-10-24T12:00:00.000Z' }] })
  try {
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'finished.json'), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    r.hooks.failUnlink = true
    await r.tick()
    const lines = r.logText().split('\n').filter(l => l.includes(id)).map(l => JSON.parse(l.replace(/^\d+ /, '')))
    assert.equal(lines.at(-1).status, 'submitted')
    assert.equal(lines.at(-1).attempts, 2)
    assert.match(lines.at(-1).detail, /admission removal failed/)
    await r.tick()
    assert.deepEqual(r.tickets(), [])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('a WRITE timeout after publication proceeds with the landed ticket', async () => {
  const r = await rig()
  try {
    r.drop('landed', 'peer', 'landed before timeout')
    r.hooks.writeHost = argv => {
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
      assert.equal(result.status, 0)
      throw Object.assign(new Error('host timeout'), { name: 'TimeoutError' })
    }
    r.hooks.submit = () => assert.equal(r.ticket('landed.json').item, `room:${SEAT}:landed.json`)
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.ledger()[`room:${SEAT}:landed.json`], 'submitted')
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, 1, 'no probe for a landed write')
    assert.deepEqual(r.tickets(), [])
  } finally { r.done() }
})

for (const failure of ['TimeoutError', 'run failed', 'EBUSY', 'EPERM', 'EIO', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EINVAL', 'ENAMETOOLONG', 'exists-unreadable']) {
  test(`admission WRITE ${failure} charges only confirmed permanent item failures`, async () => {
    const id = `room:${SEAT}:write-failure.json`
    const r = await rig({ entries: [{ id, source: 'room', status: 'deferred:submit-rejected', attempts: 2, at: '2026-10-24T12:00:00.000Z' }] })
    try {
      r.drop('write-failure', 'peer', 'retry accounting')
      r.hooks.ticketExistsThrows = failure === 'exists-unreadable'
      r.hooks.writeHost = argv => {
        if (!argv[4].endsWith('.json')) return null
        if (failure === 'TimeoutError') throw Object.assign(new Error(), { name: failure })
        if (failure === 'run failed') throw {}
        return { exitCode: 1, stdout: '', stderr: failure === 'exists-unreadable' ? 'EACCES' : failure }
      }
      await r.tick()
      const permanent = ['EISDIR', 'ENOTDIR', 'EACCES', 'EINVAL', 'ENAMETOOLONG'].includes(failure)
      const last = r.logText().trim().split('\n').map(l => JSON.parse(l.replace(/^\d+ /, ''))).filter(l => l.id === id).at(-1)
      assert.equal(last.status, `${permanent ? 'error' : 'deferred'}:admission-unwritable`)
      assert.equal(last.attempts, permanent ? 3 : 2)
      assert.match(last.detail, new RegExp(failure === 'exists-unreadable' ? 'EACCES' : failure))
      assert.deepEqual(r.submitted, [])
      assert.deepEqual(r.inbox(), ['write-failure.json'])
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[5] === '').length, 1)
    } finally { r.done() }
  })
}

for (const failure of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`admission deferrals bound a tick to three failing jobs (${failure})`, async () => {
    const r = await rig({ jobs: Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, job: 'nightly' })) })
    try {
      r.hooks.writeHost = argv => argv[4].endsWith('.json') ? { exitCode: 1, stdout: '', stderr: failure } : null
      await r.tick()
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[4].endsWith('.json')).length, 3)
      assert.equal(r.runs.filter(argv => argv[2] === WRITE && argv[5] === '').length, 3)
      assert.equal(r.logText().split('\n').filter(l => l.includes('"status":"deferred:admission-unwritable"')).length, 3)
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  })
}

test('unknown pid preserves all legacy null-pid tickets and removes probe leftovers', async () => {
  const entries = ['submitting', 'submitting:unresolved', 'submitted'].map(status => ({
    id: `job:${status}`, source: 'job-results', status, attempts: 1, at: '2026-10-24T12:00:00.000Z',
  }))
  const r = await rig({ noPid: true, entries })
  try {
    mkdirSync(r.admit, { recursive: true })
    for (const [file, id, pid] of [
      ['submitting.json', 'job:submitting', null],
      ['unresolved.json', 'job:submitting:unresolved', null],
      ['final.json', 'job:submitted', null],
      ['leaked.json', 'job:leaked', null],
      ['foreign.json', 'job:foreign', process.pid],
    ]) writeFileSync(join(r.admit, file), JSON.stringify({ version: 1, seat: SEAT, item: id, pid, ts: '2026-10-24T12:00:00.000Z' }))
    writeFileSync(join(r.admit, '.probe-null'), '')
    writeFileSync(join(r.admit, `.probe-${process.pid}`), '')
    await r.tick()
    assert.deepEqual(r.tickets(), ['final.json', 'foreign.json', 'leaked.json', 'submitting.json', 'unresolved.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

for (const minutes of [undefined, 10, 10.5]) {
  test(`submit timeout ${minutes ?? 'default'} warns once about unresolved lifecycle deferral only above 10`, async () => {
    const r = await rig({ submitTimeoutMinutes: minutes })
    try {
      await r.tick()
      await r.tick()
      const warnings = r.logs.filter(line => line.includes('an unresolved submit defers lifecycle transitions'))
      assert.equal(warnings.length, minutes > 10 ? 1 : 0)
      if (warnings.length) assert.match(warnings[0], /warning: submitTimeoutMinutes exceeds 10/)
      if (warnings.length) assert.match(warnings[0], /until its own promise settles or its owning process ends/)
      assert.equal(r.logs.some(line => line.includes('11-minute fuse')), false)
    } finally { r.done() }
  })
}


test('a directory squatting the ticket path exhausts the admission retry cap', async () => {
  const r = await rig()
  try {
    r.hooks.writeHost = argv => {
      if (ticketMatches(argv[4], 'blocked.json')) mkdirSync(argv[4], { recursive: true })
      return null
    }
    r.drop('blocked', 'peer', 'must wait for a real ticket')
    await r.tick()
    assert.deepEqual(r.submitted, [])
    assert.equal(r.ledger()[`room:${SEAT}:blocked.json`], 'deferred:admission-unwritable')
    assert.deepEqual(r.inbox(), ['blocked.json'])
    assert.equal(r.tickets().length, 1, 'failed write cleans up its temporary file and successful probe')
    assert.ok(r.tickets().every(file => ticketMatches(file, 'blocked.json')))
    await r.tick()
    await r.tick()
    assert.equal(r.ledger()[`room:${SEAT}:blocked.json`], 'error:admission-unwritable')
    const log = r.logText()
    const writes = r.runs.filter(argv => argv[2] === WRITE).length
    await r.tick()
    assert.equal(r.logText(), log)
    assert.equal(r.runs.filter(argv => argv[2] === WRITE).length, writes, 'the cap stops retrying')
    assert.deepEqual(r.submitted, [])
    assert.equal(r.tickets().length, 3)
    assert.ok(r.tickets().every(file => ticketMatches(file, 'blocked.json')))
  } finally { r.done() }
})

test('Superseded at the durable claim leaves the successor generation ticket in place', async () => {
  const r = await rig()
  const id = `room:${SEAT}:generation.json`
  const successorReady = Promise.withResolvers()
  let first, successor
  try {
    r.drop('generation', 'peer', 'reload during admission')
    r.hooks.published = () => {
      first = r.ticket('generation.json')
      r.supersede()
      r.hooks.stateSet = async (key, value) => {
        if (key.key !== 'ledger' || value[SEAT]?.[id]?.status === 'submitting') return
        delete r.hooks.stateSet
        try {
          await r.reload()
          r.hooks.pending = new Promise(() => {})
          await r.tick()
          assert.equal(r.tickets().length, 2, 'the successor sweep leaves the old attempt for its own undo cleanup')
          successor = JSON.parse(readFileSync(join(r.admit, r.tickets().find(file => file !== ticketName('generation.json', first))), 'utf8'))
          successorReady.resolve()
        } catch (error) { successorReady.reject(error) }
      }
    }
    await r.tick()
    await successorReady.promise
    await sleep(700) // Let G1 resume its cleanup after the successor tick.
    assert.ok(successor, 'the successor published while G1 undid its reservation')
    assert.equal(first.ts, successor.ts, 'both attempts publish within the same clock tick')
    assert.notEqual(first.attempt, successor.attempt)
    assert.equal(first.pid, successor.pid)
    assert.deepEqual(r.ticket('generation.json'), successor)
    assert.equal(r.held(id).status, 'submitting')
    assert.equal(r.submitted.length, 1, 'only the successor submitted')
    assert.deepEqual(r.tickets(), [ticketName('generation.json', successor)])
    assert.ok(r.runs.filter(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'generation.json')).every(argv => argv.at(-1).endsWith(ticketName('generation.json', first))), 'cleanup can only address the old attempt')
  } finally { r.done() }
})

for (const mismatch of ['ts', 'pid']) {
  for (const outcome of ['resolve', 'reject', 'timeout']) {
    test(`${outcome} cleanup preserves a successor attempt with a different ${mismatch}`, async () => {
      const r = await rig()
      let replacement
      try {
        r.drop('replacement', 'peer', 'ownership must survive settlement')
        r.hooks.submit = () => {
          replacement = r.ticket('replacement.json')
          replacement.attempt += '-successor'
          replacement[mismatch] = mismatch === 'pid' ? process.pid + 1 : '2026-10-24T12:00:01.000Z'
          writeFileSync(join(r.admit, ticketName('replacement.json', replacement)), JSON.stringify(replacement))
        }
        if (outcome === 'reject') r.hooks.reject = true
        if (outcome === 'timeout') {
          r.hooks.pending = new Promise(() => {})
          r.hooks.timeout = true
        }
        await r.tick()
        assert.deepEqual(JSON.parse(readFileSync(join(r.admit, ticketName('replacement.json', replacement)), 'utf8')), replacement)
        assert.equal(r.runs.some(argv => argv[2] === UNLINK && argv.at(-1).endsWith(ticketName('replacement.json', replacement))), false)
      } finally { r.done() }
    })
  }
}

for (const outcome of ['resolve', 'reject', 'timeout']) {
  test(`Superseded during ${outcome} ${outcome === 'timeout' ? 'keeps the unknown admission' : 'still unlinks the admission'}`, async () => {
    const r = await rig()
    try {
      r.drop('superseded', 'peer', 'settlement throws after submit')
      r.hooks.submit = () => {
        assert.equal(r.ticket('superseded.json').pid, process.pid)
        r.supersede()
      }
      if (outcome === 'reject') r.hooks.reject = true
      if (outcome === 'timeout') {
        r.hooks.pending = new Promise(() => {})
        r.hooks.timeout = true
      }
      await r.tick()
      assert.equal(r.ledger()[`room:${SEAT}:superseded.json`], 'submitting', 'Superseded prevents settlement recording')
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'superseded.json')).length, outcome === 'timeout' ? 0 : 1)
      assert.equal(r.tickets().length, outcome === 'timeout' ? 1 : 0)
    } finally { r.done() }
  })
}

for (const mismatch of ['pid', 'item', 'ts', 'attempt']) {
  test(`a failed WRITE preserves a ticket with a foreign ${mismatch}`, async () => {
    const r = await rig()
    try {
      r.drop('foreign', 'peer', 'must not use a foreign ticket')
      let body
      r.hooks.writeHost = argv => {
        if (!ticketMatches(argv[4], 'foreign.json')) return null
        const ticket = JSON.parse(argv[5])
        ticket[mismatch] = { pid: process.pid + 1, item: 'room:testseat:other.json', attempt: 'foreign-attempt', ts: '2026-10-24T11:59:00.000Z' }[mismatch]
        body = JSON.stringify(ticket)
        mkdirSync(r.admit, { recursive: true })
        writeFileSync(argv[4], body)
        return { exitCode: 1, stdout: '', stderr: 'EPERM' }
      }
      await r.tick()
      assert.deepEqual(r.submitted, [])
      assert.equal(r.ledger()[`room:${SEAT}:foreign.json`], 'deferred:admission-unwritable')
      assert.equal(readFileSync(join(r.admit, r.ticketFile('foreign.json')), 'utf8'), body)
      assert.equal(r.runs.some(argv => argv[2] === UNLINK && ticketMatches(argv.at(-1), 'foreign.json')), false)
      const entry = r.logText().trim().split('\n').map(l => JSON.parse(l.replace(/^\d+ /, ''))).at(-1)
      assert.equal(entry.attempts ?? 0, 0)
    } finally { r.done() }
  })
}

test('admission sweep removes abandoned WRITE temps only after the 11-minute mtime fuse', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    const now = Date.parse('2026-10-24T12:00:00Z')
    for (const [name, age] of [
      ['old.json.tmp-123', 11 * 60_000 + 1],
      ['.probe-null.tmp-456', 12 * 60_000],
      ['boundary.json.tmp-789', 11 * 60_000],
      ['fresh.json.tmp-123', 60_000],
      ['unrelated.tmp', 12 * 60_000],
    ]) {
      const path = join(r.admit, name)
      writeFileSync(path, 'partial write')
      utimesSync(path, new Date(now - age), new Date(now - age))
    }
    await r.tick()
    assert.deepEqual(r.tickets(), ['boundary.json.tmp-789', 'fresh.json.tmp-123', 'unrelated.tmp'])
    r.advance(11 * 60_000)
    await r.tick()
    assert.deepEqual(r.tickets(), ['unrelated.tmp'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

for (const failure of ['TimeoutError', 'run failed', 'EBUSY', 'EPERM']) {
  test(`unchanged admission ${failure} deferrals log once and recover with one submit`, async () => {
    const r = await rig()
    try {
      r.drop('dedupe', 'peer', 'retry without ledger churn')
      const reservations = []
      r.hooks.writeHost = argv => {
        if (!argv[4].endsWith('.json')) return null
        reservations.push({ status: r.held(`room:${SEAT}:dedupe.json`)?.status, log: r.logText() })
        if (failure === 'TimeoutError') throw Object.assign(new Error(), { name: failure })
        if (failure !== 'run failed') return { exitCode: 1, stdout: '', stderr: failure }
        throw {}
      }
      await r.tick()
      const log = r.logText()
      await r.tick()
      await r.tick()
      assert.deepEqual(reservations.map(r => r.status), ['submitting', 'submitting', 'submitting'], 'shared state reserves admission before every WRITE')
      for (const r of reservations) assert.doesNotMatch(r.log, /"status":"submitting"/, 'no durable submit claim before publication')
      assert.equal(r.logText(), log, 'unchanged status and attempts add no ledger lines')
      assert.equal(log.split('\n').filter(l => l.includes('deferred:admission-unwritable')).length, 1)
      assert.deepEqual(r.inbox(), ['dedupe.json'])
      assert.deepEqual(r.submitted, [])
      delete r.hooks.writeHost
      await r.tick()
      assert.equal(r.submitted.length, 1)
      assert.equal(r.ledger()[`room:${SEAT}:dedupe.json`], 'submitted')
      assert.deepEqual(r.tickets(), [])
      const claim = r.order.findIndex(e => e.kind === 'ledger' && e.entry.status === 'submitting')
      const publication = r.order.findLastIndex(e => e.kind === 'run' && e.argv[2] === WRITE && ticketMatches(e.argv[4], 'dedupe.json'))
      assert.ok(claim > publication, 'the durable claim follows successful admission publication')
    } finally { r.done() }
  })
}

for (const outcome of ['resolve', 'reject']) {
  test(`successor published immediately before old ${outcome} unlink survives without an identity read`, async () => {
    const r = await rig()
    try {
      r.drop('unlink-race', 'peer', 'cleanup race')
      let old, successor, successorFile, reads = 0
      r.hooks.submit = () => {
        old = r.ticket('unlink-race.json')
        r.hooks.ticketRead = () => { reads++ }
        r.hooks.beforeUnlink = () => {
          successor = { ...old, attempt: `${old.attempt}-successor` }
          successorFile = ticketName('unlink-race.json', successor)
          writeFileSync(join(r.admit, successorFile), JSON.stringify(successor))
        }
      }
      if (outcome === 'reject') r.hooks.reject = true
      await r.tick()
      assert.equal(reads, 0, 'cleanup never reads admission identity before unlink')
      assert.deepEqual(r.tickets(), [successorFile])
      assert.deepEqual(JSON.parse(readFileSync(join(r.admit, successorFile), 'utf8')), successor)
      assert.equal(r.runs.filter(argv => argv[2] === UNLINK && argv.at(-1).endsWith(ticketName('unlink-race.json', old))).length, 1)
    } finally { r.done() }
  })
}

for (const superseded of [false, true]) {
  test(`late rejection removes a timed-out ticket${superseded ? ' even when settlement throws after reload' : ''}`, async () => {
    const r = await rig()
    const pending = Promise.withResolvers()
    try {
      const id = `room:${SEAT}:late-reject.json`
      r.drop('late-reject', 'peer', 'unknown until host rejects')
      r.hooks.pending = pending.promise
      r.hooks.timeout = true
      await r.tick()
      assert.equal(r.held(id).status, 'submitting:unresolved')
      assert.equal(r.tickets().length, 1)
      if (superseded) r.supersede()
      pending.reject(new Error('late host rejection'))
      for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.held(id).status, superseded ? 'submitting:unresolved' : 'deferred:submit-rejected')
      assert.equal(r.held(id).attempts, 1)
    } finally { r.done() }
  })
}

for (const verdict of ['', ' delivered']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`reconcile${verdict || ' not-delivered'} preserves pending tickets until their own ${outcome}`, async () => {
      const r = await rig()
      const pending = Promise.withResolvers()
      try {
        const id = `room:${SEAT}:reconcile.json`
        r.drop('reconcile', 'peer', 'operator reconciliation')
        r.hooks.pending = pending.promise
        r.hooks.timeout = true
        await r.tick()
        const first = r.ticket('reconcile.json')
        r.hooks.pidProbe = () => ({ exitCode: 1 })
        for (const pid of [process.pid + 1, null]) {
          const other = { ...first, pid, attempt: `${first.attempt}-${pid}` }
          writeFileSync(join(r.admit, ticketName('reconcile.json', other)), JSON.stringify(other))
        }
        const unrelated = { ...first, item: 'job:unrelated', attempt: 'unrelated', pid: process.pid + 1 }
        writeFileSync(join(r.admit, 'unrelated.json'), JSON.stringify(unrelated))
        const outstanding = r.tickets()
        r.freeze() // Keep not-delivered retry queued while inspecting reconciliation.
        const answer = await r.reconcile(id + verdict)
        assert.match(answer.text, new RegExp(`is reconciled:${verdict ? 'delivered' : 'not-delivered'}`))
        assert.deepEqual(r.tickets(), outstanding)
        assert.equal(r.held(id).attempts, 1)
        await r.tick()
        assert.deepEqual(r.tickets(), outstanding, 'automatic sweep cannot release reconciled admissions')
        if (outcome === 'resolve') pending.resolve({})
        else pending.reject(new Error('late rejection after reconcile'))
        const ownFile = ticketName('reconcile.json', first)
        for (let i = 0; i < 100 && r.tickets().includes(ownFile); i++) await sleep(100)
        assert.deepEqual(r.tickets(), outstanding.filter(file => file !== ownFile), 'late settlement removes only its own admission')
        assert.equal(r.submitted.length, 1)
      } finally { r.done() }
    })
  }
}

test('late settlement after reconcile cannot remove a retry ticket or overwrite its attempt', async () => {
  const r = await rig()
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  try {
    const id = `room:${SEAT}:retry.json`
    r.drop('retry', 'peer', 'two attempts')
    r.hooks.pending = first.promise
    r.hooks.timeout = true
    await r.tick()
    const old = r.ticket('retry.json')
    r.hooks.pending = second.promise
    await r.reconcile(id)
    for (let i = 0; i < 100 && r.submitted.length < 2; i++) await sleep(100)
    assert.equal(r.tickets().length, 2, 'the first submit still owns its ticket after reconciliation')
    const current = JSON.parse(readFileSync(join(r.admit, r.tickets().find(file => file !== ticketName('retry.json', old))), 'utf8'))
    assert.notEqual(current.attempt, old.attempt)
    assert.equal(current.ts, old.ts, 'nonce uniqueness does not depend on advancing time')
    first.resolve({})
    await sleep(300)
    assert.deepEqual(r.ticket('retry.json'), current)
    assert.equal(r.held(id).status, 'submitting')
    assert.equal(r.held(id).attempts, 2)
    assert.match(r.logText(), /late start from attempt 1/)
    second.resolve({})
    for (let i = 0; i < 100 && r.tickets().length; i++) await sleep(100)
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.held(id).status, 'submitted')
    assert.equal(r.held(id).attempts, 2)
  } finally { r.done() }
})

test('sweep preserves all live-owner attempts regardless of ledger status and all corrupt tickets', async () => {
  const entries = [
    { id: 'job:held', source: 'job-results', status: 'submitting:unresolved', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
    { id: 'job:done', source: 'job-results', status: 'submitted', attempts: 1, at: '2026-10-24T12:00:00.000Z' },
  ]
  const r = await rig({ entries })
  try {
    r.hooks.pidProbe = () => ({ exitCode: 1 })
    mkdirSync(r.admit, { recursive: true })
    for (const [name, item, pid, seat] of [
      ['held-a.json', 'job:held', process.pid, SEAT],
      ['held-b.json', 'job:held', null, SEAT],
      ['done-a.json', 'job:done', process.pid, SEAT],
      ['done-b.json', 'job:done', null, SEAT],
      ['foreign-pid.json', 'job:done', process.pid + 1, SEAT],
      ['foreign-seat.json', 'job:done', null, 'another-seat'],
    ]) writeFileSync(join(r.admit, name), JSON.stringify({ item, pid, seat, attempt: name }))
    writeFileSync(join(r.admit, 'malformed.json'), '{')
    writeFileSync(join(r.admit, 'missing-item.json'), JSON.stringify({ pid: process.pid, seat: SEAT }))
    await r.tick()
    assert.deepEqual(r.tickets(), ['done-a.json', 'done-b.json', 'foreign-pid.json', 'foreign-seat.json', 'held-a.json', 'held-b.json', 'malformed.json', 'missing-item.json'])
    assert.deepEqual(r.submitted, [])
  } finally { r.done() }
})

test('legacy null-pid tickets survive sweeps with either known or unknown owner pid', async () => {
  for (const noPid of [false, true]) {
    const id = 'job:null-pid-sibling'
    const entries = noPid ? [{ id, source: 'job-results', status: 'submitted', attempts: 1, at: '2026-10-24T12:00:00.000Z' }] : []
    const r = await rig({ noPid, entries })
    try {
      mkdirSync(r.admit, { recursive: true })
      writeFileSync(join(r.admit, 'null-pid.json'), JSON.stringify({ version: 1, seat: SEAT, item: id, pid: null, ts: '2026-10-24T12:00:00.000Z' }))
      await r.tick()
      assert.equal(r.held(id)?.status, noPid ? 'submitted' : undefined)
      assert.deepEqual(r.tickets(), ['null-pid.json'])
      assert.deepEqual(r.submitted, [])
    } finally { r.done() }
  }
})

for (const failure of ['EPERM', 'timeout', 'throw']) {
  test(`sweep retains foreign tickets when the owner probe reports ${failure}`, async () => {
    const r = await rig()
    try {
      await r.tick() // Discover this process before faulting the foreign probe.
      mkdirSync(r.admit, { recursive: true })
      writeFileSync(join(r.admit, 'foreign.json'), JSON.stringify({ item: 'job:foreign', pid: process.pid + 1, ts: '2000-01-01T00:00:00Z' }))
      r.hooks.pidProbe = () => {
        if (failure === 'throw') throw new Error('spawn failed')
        return { exitCode: failure === 'EPERM' ? 2 : null, stderr: failure }
      }
      await r.tick()
      assert.deepEqual(r.tickets(), ['foreign.json'])
      assert.equal(r.runs.some(argv => argv[2] === UNLINK), false)
    } finally { r.done() }
  })
}

test('dead-owner sweep removes an unresolved admission regardless of age or ledger verdict', async () => {
  const id = 'job:dead'
  const r = await rig({ entries: [{ id, source: 'job-results', status: 'submitting:unresolved', at: '2026-10-24T12:00:00.000Z', attempts: 1 }] })
  try {
    r.hooks.pidProbe = pid => ({ exitCode: Number(pid) === process.pid ? 1 : 0 })
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'dead.json'), JSON.stringify({ item: id, pid: process.pid + 1, ts: '2026-10-24T12:00:00.000Z' }))
    await r.tick()
    assert.deepEqual(r.tickets(), [])
    assert.equal(r.held(id).status, 'submitting:unresolved')
  } finally { r.done() }
})

test('unreadable admission survives repeated sweeps beyond any age fuse', async () => {
  const r = await rig()
  try {
    mkdirSync(r.admit, { recursive: true })
    writeFileSync(join(r.admit, 'unreadable.json'), JSON.stringify({ item: 'job:unreadable', pid: process.pid + 1, ts: '2000-01-01T00:00:00Z' }))
    r.hooks.ticketUnreadable = true
    await r.tick()
    r.advance(24 * 60 * 60_000)
    await r.tick()
    assert.deepEqual(r.tickets(), ['unreadable.json'])
    assert.equal(r.runs.some(argv => argv[2] === UNLINK), false)
  } finally { r.done() }
})

test('invalid owner pid results never admit, and a later valid probe resumes delivery', async () => {
  const r = await rig()
  try {
    r.drop('invalid-pid', 'peer', 'wait for an actual process id')
    for (const pid of ['0', '9007199254740992', 'not-a-pid']) {
      r.hooks.ownerProbe = () => ({ exitCode: 0, stdout: pid })
      await r.tick()
      assert.deepEqual(r.submitted, [])
      assert.deepEqual(r.tickets(), [])
      assert.equal(r.held(`room:${SEAT}:invalid-pid.json`).status, 'deferred:admission-no-pid')
    }
    assert.equal(r.runs.some(argv => argv[2] === PID_DEAD || argv[2] === WRITE), false)
    delete r.hooks.ownerProbe
    await r.tick()
    assert.equal(r.submitted.length, 1)
    assert.equal(r.held(`room:${SEAT}:invalid-pid.json`).attempts, 1)
  } finally { r.done() }
})
