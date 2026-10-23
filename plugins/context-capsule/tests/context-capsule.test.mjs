// node --test plugins/context-capsule/tests
// No network. Every run uses a temp HOME and a temp project; nothing touches the real ~/.claude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(PLUGIN, 'scripts');
const LIB = path.join(SCRIPTS, 'capsule-lib.mjs');
const lib = await import(pathToFileURL(LIB).href);

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'ccap-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  mkdirSync(home); mkdirSync(proj);
  return { root, home, proj, done: () => rmSync(root, { recursive: true, force: true }) };
}

function env(sb, extra = {}) {
  const e = { ...process.env, HOME: sb.home, USERPROFILE: sb.home, CLAUDE_PROJECT_DIR: sb.proj, CLAUDE_PLUGIN_ROOT: PLUGIN, ...extra };
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') && !(k in extra)) delete e[k];
  if (!('AIGENT_ROOT' in extra)) delete e.AIGENT_ROOT;
  return e;
}

function run(script, sb, payload, extra = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(payload), env: env(sb, extra), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function cap({ id = 'c1', created = new Date().toISOString(), status = 'active', objective = 'Ship the parser', waiting = 'review from owner', next = 'Run the parser tests', extra = '' } = {}) {
  return `---\nid: ${id}\nstatus: ${status}\nobjective: ${JSON.stringify(objective)}\nwaiting_on: ${JSON.stringify(waiting)}\nnext_valid_action: ${JSON.stringify(next)}\ncreated_at: ${created}\n${extra}---\n\n> [REFERENCE ONLY]\n`;
}

function put(sb, name, text, dir) {
  const d = dir || path.join(sb.proj, '.claude', 'capsules');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, name), text);
  return path.join(d, name);
}

// In-process detectAigentOs reads this process's env: pin it to the sandbox.
function detect(sb) {
  const keep = { p: process.env.CLAUDE_PROJECT_DIR, a: process.env.AIGENT_ROOT, h: process.env.HOME, u: process.env.USERPROFILE };
  process.env.CLAUDE_PROJECT_DIR = sb.proj; delete process.env.AIGENT_ROOT; process.env.HOME = sb.home; process.env.USERPROFILE = sb.home;
  try { return lib.detectAigentOs({ cwd: sb.proj }); } finally {
    if (keep.p === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = keep.p;
    if (keep.a !== undefined) process.env.AIGENT_ROOT = keep.a;
    process.env.HOME = keep.h; process.env.USERPROFILE = keep.u;
  }
}

function injection(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out.sort();
}

const aigentMarker = (sb) => {
  mkdirSync(path.join(sb.proj, '.aigent'), { recursive: true });
  writeFileSync(path.join(sb.proj, '.aigent', 'state.json'), JSON.stringify({ schemaVersion: 1, status: 'complete', completedAt: null }));
};
const aigentHooks = (sb) => {
  mkdirSync(path.join(sb.proj, '.claude'), { recursive: true });
  writeFileSync(path.join(sb.proj, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: 'clear', hooks: [{ type: 'command', command: 'node "/x/daemons/resume-verb.mjs"' }] }],
    PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/x/daemons/precompact-flush.mjs"' }] }],
  } }));
};

// ---------- (a) writer ----------

test('(a) capsule writer: expected frontmatter in the default and the configured dir', () => {
  const sb = sandbox();
  try {
    const args = ['write', '--objective', 'Ship the parser', '--waiting-on', 'review from owner', '--next-action', 'Run the parser tests', '--slug', 'parser'];
    let r = spawnSync(process.execPath, [LIB, ...args], { env: env(sb), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const file = r.stdout.trim();
    assert.ok(file.startsWith(path.join(sb.proj, '.claude', 'capsules')), file);
    const text = readFileSync(file, 'utf8');
    assert.equal(lib.scalar(text, 'status'), 'active');
    assert.equal(lib.scalar(text, 'objective'), 'Ship the parser');
    assert.equal(lib.scalar(text, 'waiting_on'), 'review from owner');
    assert.equal(lib.scalar(text, 'next_valid_action'), 'Run the parser tests');
    assert.ok(lib.scalar(text, 'id').includes('parser'));
    assert.ok(Number.isFinite(Date.parse(lib.scalar(text, 'created_at'))));
    assert.match(lib.scalar(text, 'created_at'), /[+-]\d\d:\d\d$/, 'ISO-8601 with offset');
    for (const k of ['parent_capsule_id', 'resume_trigger', 'expires', 'trigger', 'success_criteria', 'tags', 'resolved_at']) assert.match(text, new RegExp(`^${k}:`, 'm'));
    assert.deepEqual(lib.validateCapsuleText(text).problems, []);

    r = spawnSync(process.execPath, [LIB, ...args], { env: env(sb, { CLAUDE_PLUGIN_OPTION_capsuleDir: 'custom/caps' }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().startsWith(path.join(sb.proj, 'custom', 'caps')));
  } finally { sb.done(); }
});

test('(a) writer refuses invalid input and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = spawnSync(process.execPath, [LIB, 'write', '--objective', 'x', '--waiting-on', 'y', '--next-action', 'RESUME-ACK now'], { env: env(sb), encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing/);
    assert.deepEqual(listFiles(sb.proj), []);
  } finally { sb.done(); }
});

// ---------- ported validation / selection ----------

test('validation: inline comment, unquoted null waiting_on, injection echo, ceremony all rejected', () => {
  const bad = (t) => lib.validateCapsuleText(t).problems.length > 0;
  assert.ok(bad('no frontmatter'));
  assert.ok(bad(cap().replace('objective: "Ship the parser"', 'objective: "Ship" # note')));
  assert.ok(bad(cap().replace('waiting_on: "review from owner"', 'waiting_on: null')));
  assert.ok(bad(cap({ objective: '[supervisor-resume] do the thing' })));
  assert.ok(bad(cap({ next: 'RESUME-ACK' })));
  assert.ok(!bad(cap()));
});

test('selection: newest created_at wins; consumed and non-active are skipped', () => {
  const sb = sandbox();
  try {
    put(sb, 'old.md', cap({ id: 'old', created: new Date(Date.now() - 3600e3).toISOString() }));
    put(sb, 'new.md', cap({ id: 'new', created: new Date(Date.now() - 60e3).toISOString() }));
    put(sb, 'spent.md', cap({ id: 'spent', status: 'resumed' }));
    const { capsule, rejected } = lib.selectCapsule(path.join(sb.proj, '.claude', 'capsules'));
    assert.equal(capsule.id, 'new');
    assert.ok(rejected.some((r) => r.name === 'spent.md' && r.reason === 'already-consumed'));
  } finally { sb.done(); }
});

// ---------- (b) SessionStart ----------

test('(b) SessionStart clear: small pointer to the newest valid capsule, capsule marked resumed', () => {
  const sb = sandbox();
  try {
    const f = put(sb, 'a.md', cap({ id: 'cap-b' }));
    const r = run('session-start-resume.mjs', sb, { hook_event_name: 'SessionStart', source: 'clear', cwd: sb.proj });
    assert.equal(r.status, 0);
    const text = injection(r.stdout);
    assert.ok(text.includes('cap-b') && text.includes('Ship the parser') && text.includes('Run the parser tests'));
    assert.ok(text.length <= lib.INJECTION_BUDGET, `injection ${text.length} chars`);
    assert.equal(lib.scalar(readFileSync(f, 'utf8'), 'status'), 'resumed');
    // a second clear does not silently replay the spent capsule
    const r2 = run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj });
    assert.ok(!injection(r2.stdout).includes('Resuming after'));
  } finally { sb.done(); }
});

test('(b) SessionStart compact: pointer injected, capsule stays active; other sources are silent', () => {
  const sb = sandbox();
  try {
    const f = put(sb, 'a.md', cap({ id: 'cap-c' }));
    const r = run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj });
    assert.ok(injection(r.stdout).includes('cap-c'));
    assert.equal(lib.scalar(readFileSync(f, 'utf8'), 'status'), 'active');
    for (const source of ['startup', 'resume', undefined]) {
      const q = run('session-start-resume.mjs', sb, { source, cwd: sb.proj });
      assert.equal(q.status, 0); assert.equal(q.stdout, '');
    }
  } finally { sb.done(); }
});

// ---------- (c) corrupt / stale ----------

test('(c) corrupt, incomplete and stale capsules are refused with a clear message', () => {
  const sb = sandbox();
  try {
    put(sb, 'corrupt.md', 'this is not a capsule');
    put(sb, 'incomplete.md', cap({ id: 'inc', next: '' }));
    put(sb, 'stale.md', cap({ id: 'stale', created: new Date(Date.now() - 30 * 86400e3).toISOString() }));
    const r = run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj });
    const text = injection(r.stdout);
    assert.match(text, /REFUSED/);
    assert.match(text, /no-frontmatter/);
    assert.match(text, /invalid/);
    assert.match(text, /stale/);
    assert.ok(!text.includes('Resuming after'));
    assert.match(text, /Do not resume from them/);
  } finally { sb.done(); }
});

test('(c) no capsule at all: short notice, no failure', () => {
  const sb = sandbox();
  try {
    const r = run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj });
    assert.equal(r.status, 0);
    assert.match(injection(r.stdout), /No capsule found/);
  } finally { sb.done(); }
});

// ---------- (d) PreCompact ----------

test('(d) PreCompact prints nothing; with no valid capsule it leaves a marker that SessionStart(compact) turns into a nudge and deletes', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.proj, '.claude', 'capsules');
    const marker = path.join(dir, '.precompact-marker.json');
    let r = run('precompact-flush.mjs', sb, { hook_event_name: 'PreCompact', cwd: sb.proj });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'PreCompact output never reaches the model, so it prints nothing');
    assert.ok(existsSync(marker));
    r = run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj });
    const text = injection(r.stdout);
    assert.match(text, /compacted and no valid capsule/);
    assert.match(text, /\/capsule/);
    assert.ok(!existsSync(marker), 'marker cleared');
    r = run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj });
    assert.ok(!/just compacted/.test(injection(r.stdout)), 'no repeat nudge');
  } finally { sb.done(); }
});

test('(d) PreCompact with a valid capsule leaves no marker and clears a stale one; the compact SessionStart points at the capsule', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.proj, '.claude', 'capsules');
    put(sb, 'a.md', cap({ id: 'cap-d' }));
    writeFileSync(path.join(dir, '.precompact-marker.json'), '{}');
    const r = run('precompact-flush.mjs', sb, { cwd: sb.proj });
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(path.join(dir, '.precompact-marker.json')));
    assert.match(injection(run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }).stdout), /cap-d/);
  } finally { sb.done(); }
});

test('(d) PreCompact with only a stale capsule leaves a marker; the compact SessionStart says why', () => {
  const sb = sandbox();
  try {
    put(sb, 's.md', cap({ created: new Date(Date.now() - 20 * 86400e3).toISOString() }));
    run('precompact-flush.mjs', sb, { cwd: sb.proj });
    const text = injection(run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }).stdout);
    assert.match(text, /compacted and no valid capsule/);
    assert.match(text, /stale/);
  } finally { sb.done(); }
});

// ---------- (e) standalone ----------

test('(e) STANDALONE: hooks.json commands, run as declared, fire in a project with no aigent-os', () => {
  const sb = sandbox();
  try {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PreCompact', 'SessionStart']);
    assert.equal(hooks.SessionStart[0].matcher, 'clear|compact');
    put(sb, 'a.md', cap({ id: 'cap-e' }));
    for (const [event, payload, expect] of [
      ['PreCompact', { hook_event_name: 'PreCompact', cwd: sb.proj }, /^$/],
      ['SessionStart', { hook_event_name: 'SessionStart', source: 'compact', cwd: sb.proj }, /cap-e/],
    ]) {
      const cmd = hooks[event][0].hooks[0].command;
      assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}'));
      const [, rel] = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/);
      const r = spawnSync(process.execPath, [path.join(PLUGIN, rel)], { input: JSON.stringify(payload), env: env(sb), encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, expect);
    }
    // PreCompact fired as declared: with a valid capsule it left no marker.
    assert.ok(!existsSync(path.join(sb.proj, '.claude', 'capsules', '.precompact-marker.json')));
  } finally { sb.done(); }
});

test('manifest: plugin.json and marketplace entry are consistent', () => {
  const pj = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pj.name, 'context-capsule');
  assert.equal(pj.version, '0.1.0');
  assert.equal(pj.userConfig.capsuleDir.type, 'string');
  const mpFile = path.resolve(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json');
  if (!existsSync(mpFile)) return; // plugin extracted from the monorepo
  const mp = JSON.parse(readFileSync(mpFile, 'utf8'));
  const e = mp.plugins.find((p) => p.name === 'context-capsule');
  assert.deepEqual(e, { name: 'context-capsule', source: './plugins/context-capsule' });
});

// ---------- (f) coexistence ----------

for (const [label, arm] of [['install marker .aigent/state.json', aigentMarker], ['aigent-os hooks in .claude/settings.json', aigentHooks], ['both', (sb) => { aigentMarker(sb); aigentHooks(sb); }]]) {
  test(`(f) COEXISTENCE (${label}): plugin hooks emit nothing, write nothing, exactly one resume injection overall`, () => {
    const sb = sandbox();
    try {
      arm(sb);
      const f = put(sb, 'a.md', cap({ id: 'cap-f' }));
      const before = readFileSync(f, 'utf8');
      const filesBefore = listFiles(sb.proj);
      assert.equal(detect(sb).detected, true);

      const start = run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj });
      const pre = run('precompact-flush.mjs', sb, { cwd: sb.proj });
      for (const r of [start, pre]) { assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); }
      assert.equal(readFileSync(f, 'utf8'), before, 'capsule untouched (still active, not consumed by the plugin)');
      assert.deepEqual(listFiles(sb.proj), filesBefore, 'no second capsule');

      // Stand-in for aigent-os's own carrier, which injects exactly one procedure.
      const aigentInjection = '[AIGENT-RESUME] procedure for cap-f';
      const combined = [aigentInjection, start.stdout, pre.stdout].join('\n');
      const injections = combined.match(/\[AIGENT-RESUME\]|\[context-capsule/g) || [];
      assert.equal(injections.length, 1);
    } finally { sb.done(); }
  });
}

test('(f) AIGENT_ROOT pointing at an aigent-os install also silences the plugin', () => {
  const sb = sandbox();
  try {
    const other = path.join(sb.root, 'aigent');
    mkdirSync(path.join(other, '.aigent'), { recursive: true });
    writeFileSync(path.join(other, '.aigent', 'state.json'), '{"schemaVersion":1}');
    put(sb, 'a.md', cap());
    const r = run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj }, { AIGENT_ROOT: other });
    assert.equal(r.stdout, '');
  } finally { sb.done(); }
});

test('(f) a settings.json with unrelated hooks is NOT mistaken for aigent-os', () => {
  const sb = sandbox();
  try {
    mkdirSync(path.join(sb.proj, '.claude'));
    writeFileSync(path.join(sb.proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    assert.equal(detect(sb).detected, false);
  } finally { sb.done(); }
});

// ---------- (g) containment, no network ----------

test('(g) nothing is written outside the capsule dir; temp HOME stays empty', () => {
  const sb = sandbox();
  try {
    put(sb, 'a.md', cap({ id: 'cap-g' }));
    const capDir = path.join(sb.proj, '.claude', 'capsules');
    const homeBefore = listFiles(sb.home);
    const projBefore = listFiles(sb.proj).filter((p) => !p.startsWith(capDir));
    run('precompact-flush.mjs', sb, { cwd: sb.proj });
    run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj });
    run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj });
    spawnSync(process.execPath, [LIB, 'write', '--objective', 'o', '--waiting-on', 'w', '--next-action', 'n'], { env: env(sb), encoding: 'utf8' });
    assert.deepEqual(listFiles(sb.home), homeBefore);
    assert.deepEqual(listFiles(sb.proj).filter((p) => !p.startsWith(capDir)), projBefore);
    assert.ok(listFiles(capDir).length >= 2);
    assert.ok(listFiles(capDir).every((p) => p.endsWith('.md') || p.endsWith('.precompact-marker.json')), 'no temp files left behind');
  } finally { sb.done(); }
});

test('(g) scripts use no network or process-spawning APIs', () => {
  const banned = [/node:(http|https|http2|net|dns|tls|dgram|child_process|worker_threads)/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\brequire\s*\(/];
  for (const f of readdirSync(SCRIPTS)) {
    const src = readFileSync(path.join(SCRIPTS, f), 'utf8');
    for (const re of banned) assert.ok(!re.test(src), `${f} matches ${re}`);
    for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('node:') || m[1].startsWith('./'), `${f} imports ${m[1]}`);
  }
  assert.equal(existsSync(path.join(PLUGIN, 'package.json')), false, 'zero npm deps: no package.json');
});

// ---------- (h) runner absent ----------

test('(h) PTY runner absent: nothing under the plugin references the runner or its native dep', () => {
  // Patterns are assembled so this file does not match itself.
  const needles = [['pty', 'runner'].join('-'), ['auto', 'clear', 'transport'].join('-'), ['node', 'pty'].join('-')];
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(PLUGIN)) {
    const src = readFileSync(f, 'utf8');
    for (const n of needles) assert.ok(!src.includes(n), `${path.relative(PLUGIN, f)} mentions ${n}`);
  }
});

// ---------- compatibility with the full aigent-os selector ----------

test('compat: aigent-os selectCapsule and validateCapsuleText accept a plugin-written capsule (skipped outside the monorepo)', async (t) => {
  const daemons = path.resolve(PLUGIN, '..', '..', 'daemons');
  if (!existsSync(path.join(daemons, 'lifecycle-common.mjs'))) return t.skip('not inside the aigent-os monorepo');
  const sb = sandbox();
  try {
    const capsules = path.join(sb.proj, 'memory', 'capsules');
    const r = spawnSync(process.execPath, [LIB, 'write', '--objective', 'Ship the parser', '--waiting-on', 'review', '--next-action', 'Run tests', '--slug', 'compat'], { env: env(sb, { CLAUDE_PLUGIN_OPTION_capsuleDir: capsules }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const common = await import(pathToFileURL(path.join(daemons, 'lifecycle-common.mjs')).href);
    const verb = await import(pathToFileURL(path.join(daemons, 'capsule-verb.mjs')).href);
    const { capsule } = common.selectCapsule(path.join(sb.proj, 'memory'));
    assert.ok(capsule, 'aigent-os selector picked it');
    assert.deepEqual(verb.validateCapsuleText(readFileSync(r.stdout.trim(), 'utf8')).problems, []);
  } finally { sb.done(); }
});

// ---------- (f) real aigent-os daemon ----------

test('(f) COEXISTENCE with the REAL aigent-os sessionstart-reinject daemon: exactly one resume injection (skipped outside the monorepo)', (t) => {
  const daemon = path.resolve(PLUGIN, '..', '..', 'daemons', 'sessionstart-reinject.mjs');
  if (!existsSync(daemon)) return t.skip('not inside the aigent-os monorepo');
  const sb = sandbox();
  try {
    aigentMarker(sb);
    put(sb, 'z1.md', cap({ id: 'cap-real' }), path.join(sb.proj, 'memory', 'capsules'));
    put(sb, 'p1.md', cap({ id: 'cap-plugin' })); // plugin-side capsule dir also has one
    const payload = { source: 'clear', session_id: 'sess-1', cwd: sb.proj };
    const real = spawnSync(process.execPath, [daemon], { input: JSON.stringify(payload), env: env(sb), encoding: 'utf8' });
    assert.match(real.stdout, /\[RESUME VERB\]/, real.stderr);
    const plug = run('session-start-resume.mjs', sb, payload);
    const pre = run('precompact-flush.mjs', sb, payload);
    assert.equal(plug.stdout, ''); assert.equal(pre.stdout, '');
    const combined = [real.stdout, plug.stdout, pre.stdout].join('\n');
    assert.equal((combined.match(/\[RESUME VERB\]|\[context-capsule/g) || []).length, 1);
  } finally { sb.done(); }
});

test('(f) aigent-os hooks in USER-scope ~/.claude/settings.json silence the plugin (temp HOME)', () => {
  const sb = sandbox();
  try {
    const dotclaude = path.join(sb.home, '.claude');
    mkdirSync(dotclaude);
    writeFileSync(path.join(dotclaude, 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/x/daemons/sessionstart-reinject.mjs"' }] }] } }));
    put(sb, 'a.md', cap());
    assert.equal(detect(sb).detected, true);
    assert.equal(run('session-start-resume.mjs', sb, { source: 'clear', cwd: sb.proj }).stdout, '');
    assert.equal(run('precompact-flush.mjs', sb, { cwd: sb.proj }).stdout, '');
    assert.equal(existsSync(path.join(sb.proj, '.claude', 'capsules', '.precompact-marker.json')), false);
  } finally { sb.done(); }
});

// ---------- config: capsuleDir env name, maxAgeDays ----------

test('config: the documented uppercase env var CLAUDE_PLUGIN_OPTION_CAPSULEDIR sets the capsule dir', () => {
  const sb = sandbox();
  try {
    const custom = path.join(sb.root, 'elsewhere');
    put(sb, 'a.md', cap({ id: 'cap-upper' }), custom);
    const r = run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }, { CLAUDE_PLUGIN_OPTION_CAPSULEDIR: custom });
    assert.ok(injection(r.stdout).includes('cap-upper'));
  } finally { sb.done(); }
});

test('config: default stale limit is 14 days; maxAgeDays option and env override change it', () => {
  const sb = sandbox();
  try {
    const old = (days) => cap({ id: 'aged', created: new Date(Date.now() - days * 86400e3).toISOString() });
    const ask = (extra) => injection(run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }, extra).stdout);
    put(sb, 'a.md', old(10));
    assert.match(ask({}), /Resuming after/, '10d is inside the 14d default');
    put(sb, 'a.md', old(20));
    assert.match(ask({}), /stale/, '20d is outside the default');
    assert.match(ask({ CLAUDE_PLUGIN_OPTION_MAXAGEDAYS: '30' }), /Resuming after/, 'userConfig widens it');
    assert.match(ask({ CLAUDE_PLUGIN_OPTION_maxAgeDays: '30' }), /Resuming after/);
    assert.match(ask({ CLAUDE_PLUGIN_OPTION_maxAgeDays: '30', CONTEXT_CAPSULE_MAX_AGE_DAYS: '5' }), /stale/, 'env wins over the option');
    put(sb, 'a.md', old(10));
    assert.match(ask({ CLAUDE_PLUGIN_OPTION_maxAgeDays: '3' }), /stale/, 'userConfig narrows it');
    assert.equal(JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.maxAgeDays.default, 14);
  } finally { sb.done(); }
});

test('resume pointer reports age in minutes under an hour, hours under a day, days after', () => {
  const sb = sandbox();
  try {
    const ageLine = (ms) => {
      const dir = path.join(sb.proj, '.claude', 'capsules');
      rmSync(dir, { recursive: true, force: true });
      put(sb, 'a.md', cap({ created: new Date(Date.now() - ms).toISOString() }));
      return injection(run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }).stdout).match(/\(([^)]*old)\)/)[1];
    };
    assert.equal(ageLine(20 * 1000), 'under 1m old');
    assert.equal(ageLine(5 * 60000), '5m old');
    assert.equal(ageLine(3 * 3600000), '3h old');
    assert.equal(ageLine(2 * 86400000), '2d old');
  } finally { sb.done(); }
});

// ---------- the CLI honours --dir (a Bash tool call does not carry CLAUDE_PLUGIN_OPTION_*) ----------

function cliWrite(sb, dirArgs) {
  const r = spawnSync(process.execPath, [LIB, 'write', '--objective', 'o', '--waiting-on', 'w', '--next-action', 'n', ...dirArgs], { cwd: sb.proj, env: env(sb), encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('cli: write --dir <absolute> writes there, not into the project default', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.root, 'elsewhere');
    const r = cliWrite(sb, ['--dir', dir]);
    assert.equal(r.status, 0, r.err);
    assert.equal(path.dirname(r.out), dir);
    assert.equal(existsSync(path.join(sb.proj, '.claude', 'capsules')), false);
  } finally { sb.done(); }
});

test('cli: write --dir <relative> resolves against the project, like the hooks do', () => {
  const sb = sandbox();
  try {
    const r = cliWrite(sb, ['--dir', 'notes/caps']);
    assert.equal(r.status, 0, r.err);
    assert.equal(path.dirname(r.out), path.join(sb.proj, 'notes', 'caps'));
  } finally { sb.done(); }
});

test('cli: an empty --dir, or an unsubstituted ${user_config...} placeholder, keeps the project default', () => {
  const sb = sandbox();
  try {
    for (const v of ['', '${user_config.capsuleDir}']) {
      const r = cliWrite(sb, ['--dir', v]);
      assert.equal(r.status, 0, r.err);
      assert.equal(path.dirname(r.out), path.join(sb.proj, '.claude', 'capsules'));
    }
  } finally { sb.done(); }
});

test('cli: newest and dir take --dir, so resume reads where write wrote', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.root, 'elsewhere');
    const w = cliWrite(sb, ['--dir', dir]);
    const n = spawnSync(process.execPath, [LIB, 'newest', '--dir', dir], { cwd: sb.proj, env: env(sb), encoding: 'utf8' });
    assert.equal(n.stdout.trim(), w.out);
    const d = spawnSync(process.execPath, [LIB, 'dir', '--dir', dir], { cwd: sb.proj, env: env(sb), encoding: 'utf8' });
    assert.equal(d.stdout.trim(), dir);
  } finally { sb.done(); }
});

test('cli: commands and skills pass the configured dir to every capsule-lib call', () => {
  const read = (p) => readFileSync(path.join(PLUGIN, p), 'utf8');
  assert.match(read('commands/capsule.md'), /--dir '\$\{user_config\.capsuleDir\}'/);
  assert.match(read('skills/context-capsule/SKILL.md'), /--dir '\$\{user_config\.capsuleDir\}'/);
  assert.match(read('skills/resume/SKILL.md'), /newest --dir '\$\{user_config\.capsuleDir\}'/);
  for (const p of ['commands/capsule.md', 'skills/context-capsule/SKILL.md', 'skills/resume/SKILL.md']) {
    assert.doesNotMatch(read(p), /--dir "\$\{/, `${p}: a double-quoted placeholder fails or expands to empty in the shell`);
  }
});

test('cli: a real path that contains ${ is honoured; only the bare placeholder counts as unset', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.root, 'a${b}c');
    const r = cliWrite(sb, ['--dir', dir]);
    assert.equal(r.status, 0, r.err);
    assert.equal(path.dirname(r.out), dir);
  } finally { sb.done(); }
});

test('resume pointer floors hours and days (23h30m is 23h, 36h is 1d)', () => {
  const sb = sandbox();
  try {
    const ageLine = (ms) => {
      rmSync(path.join(sb.proj, '.claude', 'capsules'), { recursive: true, force: true });
      put(sb, 'a.md', cap({ created: new Date(Date.now() - ms).toISOString() }));
      return injection(run('session-start-resume.mjs', sb, { source: 'compact', cwd: sb.proj }).stdout).match(/\(([^)]*old)\)/)[1];
    };
    assert.equal(ageLine(23.5 * 3600000), '23h old');
    assert.equal(ageLine(36 * 3600000), '1d old');
    assert.equal(ageLine(2.9 * 86400000), '2d old');
  } finally { sb.done(); }
});

test('manifest: the description names the post-compact reminder, not a PreCompact nudge', () => {
  const pj = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match(pj.description, /post-compact reminder/);
  assert.doesNotMatch(pj.description, /nudge/i);
});
