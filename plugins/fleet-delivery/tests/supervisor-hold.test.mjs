// Drives the real register.ts tick against temp directories with a fake engine.
// node --test plugins/fleet-delivery/tests/supervisor-hold.test.mjs  (needs a node that strips types)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { register, logLine } = await import('../hooks/register.ts')

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
  for (const dir of [join(root, '.aigent'), join(memory, 'runtime'), join(room, 'inbox', SEAT), join(room, 'state', 'holds')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, '.aigent', 'delivery-owner.json'), JSON.stringify({ owner: { [SEAT]: 'mod' } }))
  writeFileSync(join(memory, 'runtime', 'auto-clear-cycle.json'), JSON.stringify({ state: cycle }))
  writeFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), `${logLine({ id: 'seed', source: 'seed', at: '', status: 'seed' })}\n`)
  const state = new Map()
  const submitted = []
  const statuses = []
  let now = Date.parse('2026-10-24T12:00:00Z')
  const $ = {
    clock: { now: async () => now, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
    env: { get: async () => undefined },
    session: { root: async () => root },
    fs: {
      exists: async p => existsSync(p),
      read: async p => readFileSync(p, 'utf8'),
      write: async (p, t) => writeFileSync(p, t),
      stat: async p => ({ size: readFileSync(p).length, kind: 'file', isLink: false }),
      list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })),
    },
    process: {
      run: async argv => {
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
    prompt: { read: async () => ({ text: '' }), submit: async ({ text }) => (submitted.push(text), {}) },
    ui: { status: s => statuses.push(s), log() {} },
    command: { register: async () => {} },
  }
  const handlers = {}
  register((name, ...rest) => {
    handlers[name] = rest.at(-1)
    return { catch() {} }
  }, { installRoot: root, roomRoot: room, seat: SEAT })
  const tick = async () => {
    const before = statuses.length
    await handlers['turn.complete']($, { agentId: undefined }, async () => {})
    // The tick runs detached: wait for its first status, then for quiet.
    for (let i = 0; i < 300 && statuses.length === before; i++) await sleep(100)
    for (let seen = -1; seen !== statuses.length + submitted.length; ) {
      seen = statuses.length + submitted.length
      await sleep(700)
    }
  }
  const drop = (name, from, body) =>
    writeFileSync(join(room, 'inbox', SEAT, `${name}.json`), JSON.stringify({ from, to: SEAT, ts: '2026-10-24T11:59:00Z', parts: [{ text: body }] }))
  // `phase` is the newer supervisor's optional label; omitted, the file has the older shape.
  const freeze = (ts, phase) => writeFileSync(join(room, 'state', 'holds', `${SEAT}.json`), JSON.stringify({ version: 1, seat: SEAT, ts: new Date(ts ?? now).toISOString(), ...(phase ? { phase } : {}) }))
  const thaw = () => rmSync(join(room, 'state', 'holds', `${SEAT}.json`), { force: true })
  const ledger = () =>
    Object.fromEntries(
      readFileSync(join(memory, 'runtime', `mod-delivery-ledger.${SEAT}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l.replace(/^\d+ /, ''))).filter(l => l.id.startsWith('room:')).map(l => [l.id, l.status]),
    )
  return {
    submitted, statuses, tick, drop, freeze, thaw, ledger,
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
