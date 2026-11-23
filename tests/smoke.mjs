// Smoke test for capability-safety-guard with a mocked host context.
// Run with the bundled node: node smoke.mjs
import { apply, parseGpuRows, parseAppRows, channelOf, buildNotice, isValidProducerSource, isValidProducerMessage } from '../index.js'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// Keep the version-channel check hermetic: point DSH_PROFILE_DIR at an
// empty temp dir for the default tests (test 12 overrides it again).
const SAVED_PROFILE_DIR = process.env.DSH_PROFILE_DIR
const EMPTY_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-profile-'))
process.env.DSH_PROFILE_DIR = EMPTY_PROFILE_DIR

function makeMockCtx({ plugins = [], agents = [], jobs = [], resolveNvidia = () => Promise.reject(new Error('not found')) } = {}) {
  const calls = { disabled: [], injected: [], spawned: [], events: {}, sections: [] }
  const handlers = {}
  const ctx = {
    tools: {
      register(def) {
        calls.tools = calls.tools || []
        calls.tools.push(def)
        // calls.tool keeps pointing at the FIRST registered tool (the
        // capability_safety_check used by tests 1-21); trial tests use
        // calls.tools.find by name.
        if (!calls.tool) calls.tool = def
        return () => { calls.toolDisposed = true }
      },
    },
    systemPrompt: {
      section(section) {
        calls.sections.push(section)
        return () => { calls.promptDisposed = true }
      },
    },
    pluginManager: {
      async listPlugins() { return plugins },
      async setPluginEnabled(id, enabled) { calls.disabled.push({ id, enabled }); return { application: 'applied', enabled } },
    },
    jobs: {
      async list() { return jobs },
      async kill(id) { calls.killed = calls.killed || []; calls.killed.push(id); return 'requested' },
    },
    agents: {
      list() { return agents },
    },
    subprocess: {
      async resolveExecutable(cmd) { return resolveNvidia(cmd) },
      spawn(spec) {
        calls.spawned.push(spec)
        const queued = calls.spawnResults?.length ? calls.spawnResults.shift() : null
        const exitCode = queued?.exitCode ?? spec.exitCode ?? 0
        const stdoutText = queued?.stdout ?? spec.stdoutText ?? ''
        const stderrText = queued?.stderr ?? spec.stderrText ?? ''
        const timer = { unref() {} }
        return {
          collected: { stdout: { readFrom: () => ({ text: stdoutText }) }, stderr: { readFrom: () => ({ text: stderrText }) } },
          done: Promise.resolve({ exitCode }),
          terminate() { calls.terminated = true },
          waitForExit: () => Promise.resolve({ exitCode }),
          timer,
        }
      },
    },
    on(name, handler) {
      (handlers[name] = handlers[name] || []).push(handler)
      calls.events[name] = (calls.events[name] || 0) + 1
      return () => { calls.offDisposed = true }
    },
    setInterval(fn) {
      calls.monitorTick = fn
      return () => { calls.monitorDisposed = true }
    },
  }
  return { ctx, calls, handlers }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. Basic apply + tool registration + clean check.
{
  const { ctx, calls } = makeMockCtx()
  const dispose = apply(ctx, {})
  assert.strictEqual(calls.tools?.length, 2, 'both tools registered')
  assert(calls.tools.some((t) => t.name === 'safe_trial_run'), 'safe_trial_run registered')
  const checkTool = calls.tools.find((t) => t.name === 'capability_safety_check')
  assert(checkTool, 'check tool registered')
  assert.strictEqual(checkTool.parameters?.type, 'object', 'parameters is a valid object schema')
  assert(checkTool.parameters?.properties?.gpu, 'gpu param declared')
  assert.strictEqual(checkTool.parameters?.additionalProperties, false, 'parameters closed')
  assert(calls.sections.some((s) => s.name === 'capability-safety-policy' && s.order === 550), 'prompt section registered at 550')
  assert.strictEqual(Object.keys(calls.events).length, 10, '9 change events + tools/result listened')

  const result = await checkTool.execute({})
  assert.strictEqual(result.ok, true, 'clean run ok')
  assert(result.checks.gpu.note.includes('nvidia-smi not found'), 'gpu skipped gracefully: ' + JSON.stringify(result.checks.gpu))
  const text = checkTool.output.render({}, result)
  assert(Array.isArray(text) && text[0].type === 'text' && text[0].text.includes(result.summary), 'render returns text block')

  dispose()
  assert(calls.toolDisposed && calls.promptDisposed && calls.offDisposed && calls.monitorDisposed, 'disposers ran')
  console.log('PASS 1: apply/register/render/dispose')
}

// 2. Failed plugin gets auto-disabled (non-destructive, no fix arg needed).
{
  const failed = [{ entryId: 'bad-plugin', moduleName: 'bad', enabled: true, fiberPhase: 'failed', diagnostic: 'boom' }]
  const { ctx, calls } = makeMockCtx({ plugins: failed })
  apply(ctx, {})
  const result = await calls.tool.execute({})
  assert.strictEqual(result.ok, true, 'issue was fixed so ok')
  const issue = result.issues.find((i) => i.kind === 'plugin')
  assert.strictEqual(issue.fixed, true, 'plugin auto-disabled')
  assert.deepStrictEqual(calls.disabled, [{ id: 'bad-plugin', enabled: false }], 'setPluginEnabled called')
  console.log('PASS 2: failed plugin auto-disabled')
}

// 3. Read-only failed plugin → unfixable with reason.
{
  const failed = [{ entryId: 'ro-plugin', moduleName: 'ro', enabled: true, fiberPhase: 'failed', diagnostic: 'boom', readOnlyReason: 'system-owned' }]
  const { ctx, calls } = makeMockCtx({ plugins: failed })
  apply(ctx, {})
  const result = await calls.tool.execute({})
  assert.strictEqual(result.ok, false, 'unfixable → not ok')
  const issue = result.issues.find((i) => i.kind === 'plugin')
  assert(issue.unfixableReason.includes('read-only'), 'reason explained')
  assert.strictEqual(calls.disabled.length, 0, 'nothing disabled')
  console.log('PASS 3: read-only plugin reported unfixable')
}

// 4. Stuck job: warn without kill, kill with fix+autoKill.
{
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const job = { id: 'j1', label: 'stuck job', status: 'running', startedAt: old }
  {
    const { ctx, calls } = makeMockCtx({ jobs: [job] })
    apply(ctx, {})
    const result = await calls.tool.execute({})
    const issue = result.issues.find((i) => i.kind === 'stuck')
    assert(issue && issue.severity === 'error' && issue.unfixableReason.includes('autoKill is off'), 'warns without killing')
    assert(!calls.killed, 'not killed')
  }
  {
    const { ctx, calls } = makeMockCtx({ jobs: [job] })
    apply(ctx, { stuckJobs: { autoKill: true } })
    const result = await calls.tool.execute({ fix: true })
    const issue = result.issues.find((i) => i.kind === 'stuck')
    assert(issue.fixed === true, 'killed with fix:true')
    assert.deepStrictEqual(calls.killed, ['j1'], 'jobs.kill called')
  }
  console.log('PASS 4: stuck job warn/kill paths')
}

// 5. GPU check with mocked nvidia-smi output: critical + autoKill off → unfixable.
{
  const stdoutText = '9800, 10240\n2000, 8192\n'
  const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, {})
  calls.spawned = [] // reset captured specs is messy; instead patch spawn per-call
  const origSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = (spec) => {
    calls.spawned.push(spec)
    return {
      collected: { stdout: { readFrom: () => ({ text: stdoutText }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const result = await calls.tool.execute({ gpu: true })
  const issue = result.issues.find((i) => i.kind === 'gpu' && i.title.includes('memory critical'))
  assert(issue, 'critical gpu issue reported')
  assert(issue.unfixableReason.includes('autoKill is off'), 'explains why not killed')
  assert.strictEqual(result.ok, false, 'unfixable critical → not ok')
  assert(calls.spawned.length > 0, 'nvidia-smi spawned')
  assert(Number.isFinite(calls.spawned[0].graceMs) && calls.spawned[0].graceMs > 0, 'spawn spec carries required graceMs: ' + JSON.stringify(calls.spawned[0]))
  ctx.subprocess.spawn = origSpawn
  console.log('PASS 5: GPU critical reported unfixable by default')
}

// 6. GPU critical + autoKill + fix:true → kills consumers.
{
  const memText = '9800, 10240\n'
  const appText = '111, 4000\n222, 100\n'
  const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, { gpu: { autoKill: true } })
  ctx.subprocess.spawn = (spec) => {
    calls.spawned.push(spec)
    const text = spec.argv[1] === '--query-gpu=memory.used,memory.total' ? memText : appText
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const result = await calls.tool.execute({ fix: true })
  const issue = result.issues.find((i) => i.kind === 'gpu' && i.title.includes('memory critical'))
  assert(issue.fixed === true, 'killed consumers')
  const killCall = calls.spawned.find((s) => s.argv[0] === 'taskkill' || s.argv[0] === 'kill')
  assert(killCall, 'kill command spawned')
  console.log('PASS 6: GPU consumer kill with fix:true+autoKill')
}

// 7. Silent check on change event → disables failed plugin and notifies agents.
{
  const failed = [{ entryId: 'bad-plugin', moduleName: 'bad', enabled: true, fiberPhase: 'failed', diagnostic: 'boom' }]
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ plugins: failed, agents })
  apply(ctx, { silentCheckDebounceMs: 10 })
  const change = handlers['plugin-manager/changed'][0]
  change({ change: { reason: 'plugin', target: 'x' } })
  await sleep(80)
  assert(calls.disabled.some((d) => d.id === 'bad-plugin'), 'silent check disabled failed plugin')
  assert.strictEqual(injected.length, 1, 'agent notified via inject')
  assert(injected[0].content[0].text.includes('bad-plugin'), 'note mentions plugin')
  assert(injected[0].source && injected[0].source.kind === 'capability-safety', 'injected message carries a producer-owned source (format v4 requirement)')
  assert(typeof injected[0].id === 'string' && injected[0].id.length > 0, 'injected message carries a non-empty id (identified-message requirement)')
  const result = await calls.tool.execute({})
  assert(result.recentChanges.length === 1, 'change recorded')
  console.log('PASS 7: event → record + silent check + notify')
}

// 8. parseGpuRows unit.
{
  assert.deepStrictEqual(parseGpuRows('9000, 10240\r\n2000, 8192\r\n'), [
    { used: 9000, total: 10240 },
    { used: 2000, total: 8192 },
  ])
  assert.deepStrictEqual(parseGpuRows('N/A, N/A\n'), [])
  // Per-process rows where the driver reports N/A for used_memory (WDDM
  // desktops) must be KEPT with usedKnown:false, so name-based checks
  // (ollama/llama) and holder lists still see the process.
  assert.deepStrictEqual(parseAppRows('25076, [N/A], C:\\Users\\x\\ollama\\llama-server.exe\n111, 4000, python\n'), [
    { pid: 25076, used: 0, usedKnown: false, name: 'C:\\Users\\x\\ollama\\llama-server.exe' },
    { pid: 111, used: 4000, usedKnown: true, name: 'python' },
  ])
  console.log('PASS 8: parseGpuRows')
}

// 9. Failed plugin whose disable needs a restart → fixed, pending restart.
{
  const failed = [{ entryId: 'restart-plugin', moduleName: 'rp', enabled: true, fiberPhase: 'failed', diagnostic: 'boom' }]
  const { ctx, calls } = makeMockCtx({ plugins: failed })
  ctx.pluginManager.setPluginEnabled = async (id, enabled) => {
    calls.disabled.push({ id, enabled })
    return { application: 'restart-required', enabled }
  }
  apply(ctx, {})
  const result = await calls.tool.execute({})
  const issue = result.issues.find((i) => i.kind === 'plugin')
  assert.strictEqual(issue.fixed, true, 'restart-required counts as fixed')
  assert(issue.detail.includes('restart'), 'explains restart pending')
  assert.strictEqual(result.ok, true, 'no open critical problem')
  console.log('PASS 9: restart-required disable handled')
}

// 10. Continuous monitor: only inside a deployment window, report-only, deduplicated.
{
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ agents, resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, {})
  const memText = '9800, 10240\n'
  ctx.subprocess.spawn = (spec) => ({
    collected: { stdout: { readFrom: () => ({ text: memText }) }, stderr: { readFrom: () => ({ text: '' }) } },
    done: Promise.resolve({ exitCode: 0 }),
    terminate() {},
  })
  // Outside the deploy window (no recent change, no running jobs): no alerts.
  calls.monitorTick()
  await sleep(30)
  assert.strictEqual(injected.length, 0, 'monitor silent outside deploy window')
  // A capability change opens the window; critical GPU gets reported.
  handlers['plugin-manager/changed'][0]({ change: { reason: 'plugin', target: 'x' } })
  calls.monitorTick()
  await sleep(30)
  assert.strictEqual(injected.length, 1, 'GPU alert injected during deploy window')
  assert(injected[0].content[0].text.includes('GPU alert'), 'alert mentions GPU')
  calls.monitorTick()
  await sleep(30)
  assert.strictEqual(injected.length, 1, 'same alert not re-injected (deduped)')
  console.log('PASS 10: continuous monitor window + dedupe')
}

// 11. Monitor cadence: GPU snapshot every tick, heavy scans only on heavy ticks.
{
  let pluginLists = 0
  let jobLists = 0
  const resolveNvidia = (cmd) => (cmd === 'nvidia-smi' ? Promise.resolve('C:/nvidia-smi.exe') : Promise.reject(new Error('not found')))
  const { ctx, calls, handlers } = makeMockCtx({ resolveNvidia })
  apply(ctx, { monitor: { intervalMs: 5000, deployWindowMs: 600000, heavyEveryNTicks: 6 } })
  const memText = '9800, 10240\\n'
  ctx.subprocess.spawn = (spec) => {
    calls.spawned.push(spec)
    return {
      collected: { stdout: { readFrom: () => ({ text: memText }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const listPlugins = ctx.pluginManager.listPlugins
  ctx.pluginManager.listPlugins = async () => { pluginLists += 1; return listPlugins() }
  const listJobs = ctx.jobs.list
  ctx.jobs.list = async (...a) => { jobLists += 1; return listJobs(...a) }
  handlers['plugin-manager/changed'][0]({ change: { reason: 'plugin', target: 'x' } })
  for (let i = 0; i < 7; i++) calls.monitorTick()
  await sleep(50)
  // 7 ticks: GPU sampled every tick (7 spawns); plugin health + core chain
  // (each does one listPlugins) only on heavy ticks 1 and 7.
  assert.strictEqual(calls.spawned.length, 7, 'GPU sampled every tick')
  assert.strictEqual(pluginLists, 4, 'plugin + core-chain listPlugins only on heavy ticks')
  // Window is open, so the watch probe short-circuits; jobs are scanned
  // only by the heavy stuck-job check, on ticks 1 and 7.
  assert.strictEqual(jobLists, 2, 'stuck-job scan only on heavy ticks')
  console.log('PASS 11: monitor cadence throttle')
}

// 12. Version-channel check: prerelease + mixed channels in profile node_modules.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-ver-'))
  const scope = path.join(dir, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(scope, { recursive: true })
  for (const [name, version] of [
    ['dsh-storage-domain', '0.2.2-alpha.2'],
    ['dsh-base', '0.2.2-rc.5'],
  ]) {
    fs.mkdirSync(path.join(scope, name), { recursive: true })
    fs.writeFileSync(path.join(scope, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }))
  }
  process.env.DSH_PROFILE_DIR = dir
  try {
    const { ctx, calls } = makeMockCtx()
    apply(ctx, {})
    const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: true, coreChain: false })
    const verIssues = result.issues.filter((i) => i.kind === 'version' && i.severity === 'error')
    assert.strictEqual(verIssues.length, 2, 'prerelease + mixed-channel both reported')
    assert(verIssues.some((i) => i.title.includes('Prerelease')), 'prerelease flagged')
    assert(verIssues.some((i) => i.title.includes('Mixed')), 'mixed channels flagged')
    assert(verIssues.every((i) => i.fixed === false && i.unfixableReason), 'version issues are never auto-fixed, always explained')
    assert(result.checks.versions.packages.includes('@deepseek-ai/dsh-storage-domain@0.2.2-alpha.2'), 'resolved versions listed')
    assert.strictEqual(result.ok, false, 'version hazard → not ok')
  } finally {
    process.env.DSH_PROFILE_DIR = EMPTY_PROFILE_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('PASS 12: version/channel hazards detected, never auto-fixed')
}

// 13. Core-chain check: disabled/failed core plugin, compatibility warning,
//     and disabled-without-diagnostic (info, never an alert).
{
  const corePlugins = [
    { entryId: 'include:dsh-storage-domain', moduleName: '@deepseek-ai/dsh-storage-domain', enabled: false, fiberPhase: 'active', diagnostic: 'disabled by compatibility precheck' },
    { entryId: 'include:dsh-workspace', moduleName: '@deepseek-ai/dsh-workspace', enabled: true, fiberPhase: 'active', diagnostic: 'disabled by compatibility precheck' },
    { entryId: 'include:dsh-tui-storage', moduleName: '@deepseek-ai/dsh-storage', enabled: false, fiberPhase: 'active' },
  ]
  const { ctx, calls } = makeMockCtx({ plugins: corePlugins })
  apply(ctx, {})
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: true })
  const coreIssues = result.issues.filter((i) => i.kind === 'core')
  assert.strictEqual(coreIssues.length, 3, 'all three core variants reported')
  const err = coreIssues.filter((i) => i.severity === 'error')
  const warn = coreIssues.filter((i) => i.severity === 'warn')
  const info = coreIssues.filter((i) => i.severity === 'info')
  assert.strictEqual(err.length, 1, 'disabled + compat diagnostic is an error')
  assert(err[0].title.includes('storage-domain'), 'error names the disabled core plugin')
  assert.strictEqual(warn.length, 1, 'enabled-but-compat-flavoured core is a warning')
  assert.strictEqual(info.length, 1, 'disabled without diagnostic is info, not an error')
  assert(info[0].title.includes('dsh-tui-storage'), 'info names the no-diagnostic disabled plugin')
  assert(!info[0].unfixableReason, 'info carries no unfixableReason (not a failure)')
  assert(err.every((i) => i.fixed === false && i.unfixableReason), 'error core issues never auto-fixed, always explained')
  assert.strictEqual(calls.disabled.length, 0, 'core plugins are never toggled automatically')
  assert.strictEqual(result.ok, false, 'broken core chain → not ok')
  console.log('PASS 13: core-chain breakage reported, never auto-toggled, no-diagnostic disables are info')
}

// 14. Restart-required change payload → pendingRestart state + notify + output.
{
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ agents })
  apply(ctx, {})
  handlers['plugin-manager/install-state'][0]({ stage: 'install', state: 'restart-required', application: 'restart-required' })
  assert.strictEqual(injected.length, 1, 'restart-required change notifies live agents')
  assert(injected[0].content[0].text.includes('restart'), 'note mentions the pending restart')
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false })
  assert(result.pendingRestart && result.pendingRestart.note.includes('restart-required'), 'pendingRestart surfaced in output')
  assert(result.issues.some((i) => i.kind === 'restart' && i.severity === 'warn'), 'pending restart listed as a warning')
  const rendered = calls.tool.output.render({}, result)[0].text
  assert(rendered.includes('Restart pending'), 'report renders the restart note')
  console.log('PASS 14: restart-required tracking')
}

// 15. channelOf unit.
{
  assert.strictEqual(channelOf('0.2.2'), 'stable')
  assert.strictEqual(channelOf('0.2.2-alpha.2'), 'alpha')
  assert.strictEqual(channelOf('0.2.2-rc.5'), 'rc')
  assert.strictEqual(channelOf('1.0.0-beta.1'), 'beta')
  console.log('PASS 15: channelOf')
}

// 16. System check: RAM / disk / heavy processes from one PowerShell call.
{
  const psJson = JSON.stringify({
    cpu: 97,
    ram: { totalMb: 16384, freeMb: 512 },
    disks: [
      { name: 'C', freeGb: 20.5, totalGb: 1000 },
      { name: 'D', freeGb: 500, totalGb: 1000 },
    ],
    processes: [
      { name: 'python', pid: 123, wsMb: 12288 },
      { name: 'node', pid: 9, wsMb: 7000 },
    ],
  })
  {
    const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/powershell.exe') })
    apply(ctx, {})
    ctx.subprocess.spawn = (spec) => {
      calls.spawned.push(spec)
      return {
        collected: { stdout: { readFrom: () => ({ text: psJson }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: true, errors: false })
    const sys = result.issues.filter((i) => i.kind === 'system')
    assert(sys.some((i) => i.severity === 'error' && i.title.includes('RAM')), 'RAM critical reported')
    assert(sys.some((i) => i.severity === 'error' && i.title.includes('CPU')), 'CPU critical reported')
    assert(sys.some((i) => i.severity === 'error' && i.title.includes('Drive C:')), 'disk critical reported')
    const py = sys.find((i) => i.title.includes('python'))
    assert(py && py.severity === 'error' && py.unfixableReason.includes('autoKill is off'), 'heavy process reported, not killed by default')
    assert(sys.some((i) => i.severity === 'warn' && i.title.includes('node')), 'warn-level process reported')
    assert.strictEqual(calls.spawned.filter((s) => s.argv[4]?.includes('Stop-Process')).length, 0, 'nothing force-killed without autoKill')
    assert.strictEqual(result.ok, false, 'critical system problems → not ok')
    assert(result.checks.system.snapshot, 'raw snapshot exposed')
  }
  {
    const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/powershell.exe') })
    apply(ctx, { system: { processes: { autoKill: true } } })
    ctx.subprocess.spawn = (spec) => {
      calls.spawned.push(spec)
      const text = spec.argv[4]?.includes('Stop-Process') ? '' : psJson
      return {
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: true, errors: false, fix: true })
    const py = result.issues.find((i) => i.kind === 'system' && i.title.includes('python'))
    assert.strictEqual(py.fixed, true, 'heavy process force-killed with autoKill + fix:true')
    assert(calls.spawned.some((s) => s.argv[4]?.includes('Stop-Process -Id 123')), 'Stop-Process spawned for the offending pid')
  }
  console.log('PASS 16: system check RAM/disk/processes')
}

// 17. Tool-error fingerprints: critical notifies + surfaces; benign ignored.
{
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ agents })
  apply(ctx, {})
  const h = handlers['tools/result'][0]
  h({ name: 'ops_bash' }, { status: 'error', exitCode: 1, text: 'CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 8.00 GiB total capacity)' })
  assert.strictEqual(injected.length, 1, 'critical fingerprint notifies live agents')
  assert(injected[0].content[0].text.includes('out-of-memory'), 'note names the fingerprint')
  h({ name: 'ops_bash' }, { status: 'success', exitCode: 0, text: 'done' })
  assert.strictEqual(injected.length, 1, 'benign result does not notify')
  // A SUCCESSFUL read whose text merely contains the words "out of memory"
  // must not be treated as an OOM failure (regression: false alerts fired
  // when the guard read its own source code).
  h({ name: 'ops_inspect_local_file' }, { isError: false, content: [{ type: 'text', text: 'reading a file that mentions out of memory and CUDA OOM is not a failure' }] })
  assert.strictEqual(injected.length, 1, 'successful read containing OOM words does not notify')
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: true })
  const errIssue = result.issues.find((i) => i.kind === 'errors')
  assert(errIssue && errIssue.title.includes('out-of-memory'), 'fingerprint surfaced in the check output')
  assert(errIssue.unfixableReason.includes('free GPU/RAM'), 'per-fingerprint guidance attached')
  assert.strictEqual(result.ok, false, 'fingerprint error → not ok')
  console.log('PASS 17: tool-error fingerprint watch')
}

// 18. System check skips gracefully when no PowerShell is available.
{
  const { ctx, calls } = makeMockCtx()
  apply(ctx, {})
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: true, errors: false })
  assert(result.checks.system.note?.includes('neither powershell'), 'graceful note: ' + JSON.stringify(result.checks.system))
  assert.strictEqual(result.ok, true, 'skipped check does not fail the run')
  console.log('PASS 18: system check skips gracefully without powershell')
}

// 19. GPU temperature, per-process VRAM consumers, and rising-memory trend.
{
  const memByCall = ['8500, 10240\n', '8500, 10240\n', '8500, 10240\n', '9000, 10240\n', '9000, 10240\n', '9000, 10240\n', '9600, 10240\n', '9600, 10240\n', '9600, 10240\n']
  let memCalls = 0
  const driverText = '572.70, NVIDIA GeForce RTX 4090, 94, P0\n'
  const appsText = '111, 4000, python\n222, 100, dsh\n'
  const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  // The default trend span (60 s) is deliberately strict for real sessions;
  // the unit test compresses the span so 3 consecutive rising samples warn.
  apply(ctx, { gpu: { trend: { minSpanMs: 0, minSlopePerMin: 2 } } })
  ctx.subprocess.spawn = (spec) => {
    calls.spawned.push(spec)
    let text
    if (spec.argv[1] === '--query-gpu=memory.used,memory.total') {
      text = memByCall[Math.min(memCalls++, memByCall.length - 1)]
    } else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') {
      text = driverText
    } else {
      text = appsText
    }
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  let result
  for (let i = 0; i < 3; i++) {
    result = await calls.tool.execute({ gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false })
    await sleep(3) // give consecutive GPU samples distinct timestamps so the rising-trend span is non-zero
  }
  const tempIssue = result.issues.find((i) => i.title.includes('temperature'))
  assert(tempIssue && tempIssue.severity === 'error', 'GPU temperature critical reported')
  assert(tempIssue.unfixableReason.includes('cooling'), 'temperature explained as cooling/power problem')
  assert.strictEqual(result.checks.gpu.driverInfo.tempC, 94, 'driverInfo carries temperature')
  assert.strictEqual(result.checks.gpu.driverInfo.version, '572.70', 'driver version parsed')
  assert.deepStrictEqual(result.checks.gpu.consumers[0], { pid: 111, used: 4000, usedKnown: true, name: 'python' }, 'per-process VRAM consumers listed')
  const trend = result.issues.find((i) => i.title.includes('rising'))
  assert(trend && trend.severity === 'warn', 'rising-memory trend warned')
  console.log('PASS 19: GPU temp / consumers / trend')
}

// 20. Failure loop: same tool + same fingerprint repeated → loop error.
{
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ agents })
  apply(ctx, { errors: { loopThreshold: 2 } })
  const h = handlers['tools/result'][0]
  h({ name: 'ops_bash' }, { status: 'error', exitCode: 1, text: 'listen EADDRINUSE: address already in use 127.0.0.1:8000' })
  h({ name: 'ops_bash' }, { status: 'error', exitCode: 1, text: 'listen EADDRINUSE: address already in use 127.0.0.1:8000' })
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: true })
  const loop = result.issues.find((i) => i.title.includes('Failure loop'))
  assert(loop && loop.severity === 'error', 'failure loop flagged as error')
  assert(loop.detail.includes('2 identical failures'), 'loop count in detail')
  assert(loop.unfixableReason.includes('port'), 'loop guidance attached')
  console.log('PASS 20: repeated-failure loop detection')
}

// 21. Guardian self-health after monitor activity.
{
  const injected = []
  const agents = [{ id: 's1', inject: (msg) => injected.push(msg) }]
  const { ctx, calls, handlers } = makeMockCtx({ agents, resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, {})
  ctx.subprocess.spawn = (spec) => ({
    collected: { stdout: { readFrom: () => ({ text: '9800, 10240\n' }) }, stderr: { readFrom: () => ({ text: '' }) } },
    done: Promise.resolve({ exitCode: 0 }),
    terminate() {},
  })
  handlers['plugin-manager/changed'][0]({ change: { reason: 'plugin', target: 'x' } })
  for (let i = 0; i < 3; i++) calls.monitorTick()
  await sleep(50)
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: true })
  const s = result.checks.self.stats
  assert.strictEqual(s.monitorArmed, true, 'monitor armed via host setInterval')
  assert.strictEqual(s.ticks, 3, 'monitor ticks counted')
  assert(s.eventsSeen >= 1, 'change events counted')
  assert.strictEqual(s.gpuSnapshotsOk, 3, 'GPU snapshots counted')
  assert(s.alertsSent >= 1, 'alerts counted')
  const rendered = calls.tool.output.render({}, result)[0].text
  assert(rendered.includes('Guardian health'), 'report renders guardian health line')
  console.log('PASS 21: guardian self-health')
}

// 22. Injection safety: notices always carry a valid producer-owned source.
{
  const msg = buildNotice('hello')
  assert(isValidProducerSource(msg.source), 'buildNotice output carries a valid producer-owned source')
  assert.strictEqual(msg.source.kind, 'capability-safety', 'kind is the guard-owned producer')
  assert.strictEqual(isValidProducerSource({ kind: 'plugin' }), false, 'kind "plugin" rejected (format v4 forbids it)')
  assert.strictEqual(isValidProducerSource({}), false, 'missing kind rejected')
  assert.strictEqual(isValidProducerSource({ kind: '' }), false, 'empty kind rejected')
  assert.strictEqual(isValidProducerSource(null), false, 'non-object rejected')
  console.log('PASS 22: injected notices always carry a valid producer-owned source')
}

// 23. Injection safety: notices are fully "identified messages" (id + source
//     + role + content). A notice without an id is exactly what made
//     session-7b9d41ee unable to reopen on 2026-11-23 (seq 2082 user/message
//     "lacks an identified message").
{
  const msg = buildNotice('hello')
  assert(isValidProducerMessage(msg), 'buildNotice output passes the full format-v4 message check')
  assert(typeof msg.id === 'string' && msg.id.length > 0, 'notice id is a non-empty string')
  assert.strictEqual(msg.role, 'user', 'notice role is user')
  assert(Array.isArray(msg.content), 'notice content is an array')
  assert.strictEqual(isValidProducerMessage({ ...msg, id: '' }), false, 'empty id rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, id: undefined }), false, 'missing id rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, source: undefined }), false, 'missing source rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, role: 'assistant' }), false, 'wrong role rejected')
  assert.strictEqual(isValidProducerMessage(null), false, 'non-object rejected')
  // Two notices get distinct ids (no accidental reuse).
  const a = buildNotice('a')
  const b = buildNotice('b')
  assert.notStrictEqual(a.id, b.id, 'each notice gets its own id')
  console.log('PASS 23: injected notices are fully identified messages (id required)')
}

// 24. Content-block-level guard: every block must be a well-formed text
//     block. Matches the app validator's per-block rules for the only kind
//     this plugin emits (assertContentBlock in dsh-session-persistence).
{
  const msg = buildNotice('hello')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [] }), false, 'empty content rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [{}] }), false, 'block without type rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [{ type: 'text' }] }), false, 'text block without text rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [{ type: 'text', text: '' }] }), false, 'text block with empty text rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [{ type: 'image', text: 'x' }] }), false, 'non-text block rejected')
  assert.strictEqual(isValidProducerMessage({ ...msg, content: [{ type: 'text', text: 'x' }] }), true, 'well-formed text block accepted')
  console.log('PASS 24: content blocks are validated at block level')
}

// 25. Trial sandbox: create -> run (2 identical failures) -> analyze proposes
//     fixes; nothing is auto-applied, status reflects the trial, cleanup works.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export-'))
  const { ctx, calls } = makeMockCtx()
  calls.spawnResults = [
    { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'numpy'" },
    { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'numpy'" },
  ]
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  const created = await tool.execute({ action: 'create', trialId: 't25', spec: { name: 'demo', runCmd: 'python app.py', runs: 2 } })
  assert(created.ok && created.status === 'created', 'trial created')
  const run = await tool.execute({ action: 'run', trialId: 't25' })
  assert(run.ok && run.failCount === 2 && run.passCount === 0, 'both runs failed: ' + JSON.stringify(run))
  assert(run.steps.length === 2 && run.steps.every((s) => s.kind === 'run'), 'two run steps recorded')
  const analyzed = await tool.execute({ action: 'analyze', trialId: 't25' })
  assert(analyzed.ok === true && analyzed.failCount === 2, 'analyze ran')
  const dep = analyzed.issues.find((i) => i.fingerprint === 'dep')
  assert(dep && dep.severity === 'error', 'missing-dep fingerprint found')
  assert(dep.unfixableReason.includes('missing'), 'guidance attached')
  assert(analyzed.proposedFixes.some((f) => f.type === 'run' && f.cmd.includes('pip install numpy')), 'proposed fix installs numpy: ' + JSON.stringify(analyzed.proposedFixes))
  const status = await tool.execute({ action: 'status', trialId: 't25' })
  assert(status.trials[0].failures === 2 && status.trials[0].status === 'analyzed', 'status reflects analyzed trial')
  await tool.execute({ action: 'cleanup', trialId: 't25' })
  assert(!fs.existsSync(path.join(sandbox, 't25')), 'cleanup removed sandbox dir')
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  console.log('PASS 25: trial create/run/analyze/status/cleanup')
}

// 26. Trial sandbox: user-approved file fix inside the sandbox, re-run passes,
//     export delivers the final product to a real directory.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export-'))
  const output = path.join(exportsDir, 'final-app')
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-src-'))
  fs.writeFileSync(path.join(src, 'run.js'), "const fs = require('fs'); if (!fs.existsSync('flag.txt')) { console.error('missing flag'); process.exit(1) } console.log('ok')")
  const node = process.execPath
  const { ctx, calls } = makeMockCtx()
  calls.spawnResults = [{ exitCode: 1, stderr: 'missing flag' }]
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  const created = await tool.execute({ action: 'create', trialId: 't26', spec: { name: 'flag-app', sourceDir: src, lang: 'node', runCmd: `"${node}" run.js`, runs: 1 } })
  assert(created.ok, 'created with source copy')
  let run = await tool.execute({ action: 'run', trialId: 't26' })
  assert(run.failCount === 1, 'first run fails')
  const analyzed = await tool.execute({ action: 'analyze', trialId: 't26' })
  assert(analyzed.failCount === 1 && analyzed.issues.length >= 1, 'analyze reports the failure')
  const fixed = await tool.execute({ action: 'fix', trialId: 't26', fixes: [{ type: 'file', path: 'flag.txt', content: 'ok' }] })
  assert(fixed.ok && fixed.applied[0].type === 'file' && !fixed.applied[0].error, 'file fix applied')
  assert(fs.existsSync(path.join(sandbox, 't26', 'src', 'flag.txt')), 'flag written inside sandbox src')
  calls.spawnResults = [{ exitCode: 0, stdout: 'ok' }]
  run = await tool.execute({ action: 'run', trialId: 't26' })
  assert(run.passCount === 1 && run.failCount === 0, 're-run passes')
  const clean = await tool.execute({ action: 'analyze', trialId: 't26' })
  assert(clean.issues.length === 0, 'clean analysis after fix')
  const exported = await tool.execute({ action: 'export', trialId: 't26', outputDir: output })
  assert(exported.ok && exported.exportedTo === output, 'exported: ' + JSON.stringify(exported))
  assert(fs.existsSync(path.join(output, 'run.js')), 'product file delivered')
  assert(fs.existsSync(path.join(output, 'flag.txt')), 'approved fix included in the product')
  await tool.execute({ action: 'cleanup', trialId: 't26' })
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  console.log('PASS 26: trial fix -> re-run -> export')
}

// 27. Trial guards: escaping file fix refused, export into the sandbox refused,
//     sourceDir inside the DSH profile refused.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export-'))
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-src-'))
  const { ctx, calls } = makeMockCtx()
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  await tool.execute({ action: 'create', trialId: 't27', spec: { sourceDir: src, runCmd: 'node x.js', runs: 1 } })
  const badFix = await tool.execute({ action: 'fix', trialId: 't27', fixes: [{ type: 'file', path: '../evil.txt', content: 'x' }] })
  assert(badFix.applied[0].error && /escapes/.test(badFix.applied[0].error), 'escaping fix refused')
  assert(!fs.existsSync(path.join(sandbox, 'evil.txt')), 'nothing written outside the trial dir')
  const badExport = await tool.execute({ action: 'export', trialId: 't27', outputDir: path.join(sandbox, 'out') })
  assert(badExport.ok === false && /OUTSIDE/.test(badExport.error), 'export into sandbox refused')
  const profileSource = await tool.execute({ action: 'create', trialId: 't27b', spec: { sourceDir: EMPTY_PROFILE_DIR, runCmd: 'node x.js', runs: 1 } })
  assert(profileSource.ok === false && /profile/.test(profileSource.error), 'sourceDir inside profile refused')
  await tool.execute({ action: 'cleanup', trialId: 't27' })
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  console.log('PASS 27: sandbox escape guards')
}

// 28. Trial sandbox: quoted command-line splitting and a clean all-pass flow.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export-'))
  const node = process.execPath
  const { ctx, calls } = makeMockCtx()
  calls.spawnResults = [
    { exitCode: 0, stdout: 'hello world' },
    { exitCode: 0, stdout: 'hello world' },
  ]
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  const created = await tool.execute({ action: 'create', trialId: 't28', spec: { runCmd: `"${node}" -e "console.log('hello world')"`, runs: 2 } })
  assert(created.ok, 'created')
  const run = await tool.execute({ action: 'run', trialId: 't28' })
  assert(run.ok && run.passCount === 2, 'both runs passed')
  const spec = calls.spawned.find((s) => s.argv && s.argv[0] === node)
  assert(spec && spec.argv[1] === '-e' && spec.argv[2] === "console.log('hello world')", 'quoted args split correctly: ' + JSON.stringify(spec?.argv))
  const analyzed = await tool.execute({ action: 'analyze', trialId: 't28' })
  assert(analyzed.issues.length === 0 && analyzed.note.includes('All runs passed'), 'clean analysis')
  await tool.execute({ action: 'cleanup', trialId: 't28' })
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  console.log('PASS 28: command splitting + clean pass')
}

// 29. Resident model processes (ollama/llama): detect, explain, and on
//     fix:true + autoStopOnFix unload them gracefully — `ollama stop` for
//     ollama apps, graceful taskkill (no /F) for other matched apps.
{
  const resolveTools = (cmd) =>
    Promise.resolve(cmd === 'ollama' ? 'C:/ollama.exe' : cmd === 'taskkill' ? 'C:/Windows/System32/taskkill.exe' : 'C:/nvidia-smi.exe')
  const { ctx, calls } = makeMockCtx({ resolveNvidia: resolveTools })
  apply(ctx, {})
  const makeSpawn = (callsObj) => (spec) => {
    callsObj.spawned.push(spec)
    let text
    if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = '7400, 8151\n'
    else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '\n'
    else text = '111, 4000, ollama.exe\n222, 300, python\n'
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  ctx.subprocess.spawn = makeSpawn(calls)
  const args = { gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false }
  let result = await calls.tool.execute(args)
  let issue = result.issues.find((i) => i.title.includes('Resident model process'))
  assert(issue, 'resident model flagged: ' + JSON.stringify(result.issues))
  assert.strictEqual(issue.severity, 'warn', 'warn at 90.8% (below critical)')
  assert(issue.detail.includes('unload them'), 'advice says unload: ' + issue.detail)

  // fix: true without autoStopOnFix → explain, don't touch.
  result = await calls.tool.execute({ ...args, fix: true })
  issue = result.issues.find((i) => i.title.includes('Resident model process'))
  assert(!issue.fixed && issue.unfixableReason.includes('autoStopOnFix'), 'no auto-stop without config opt-in')

  // fix: true with autoStopOnFix → graceful `ollama stop`.
  const { ctx: ctx2, calls: calls2 } = makeMockCtx({ resolveNvidia: resolveTools })
  apply(ctx2, { gpu: { resident: { autoStopOnFix: true } } })
  ctx2.subprocess.spawn = makeSpawn(calls2)
  result = await calls2.tool.execute({ ...args, fix: true })
  issue = result.issues.find((i) => i.title.includes('Resident model process'))
  assert(issue.fixed, 'resident model unloaded on fix')
  const stopSpec = calls2.spawned.find((s) => s.argv?.[1] === 'stop')
  assert(stopSpec && stopSpec.argv[0] === 'C:/ollama.exe', 'ran `ollama stop` via resolved executable')

  // llama-server without an ollama CLI → graceful taskkill /IM (never /F).
  const { ctx: ctx3, calls: calls3 } = makeMockCtx({ resolveNvidia: resolveTools })
  apply(ctx3, { gpu: { resident: { autoStopOnFix: true } } })
  ctx3.subprocess.spawn = (spec) => {
    calls3.spawned.push(spec)
    let text
    if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = '7400, 8151\n'
    else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '\n'
    else text = '111, 4000, llama-server.exe\n'
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  result = await calls3.tool.execute({ ...args, fix: true })
  issue = result.issues.find((i) => i.title.includes('Resident model process'))
  assert(issue.fixed, 'llama-server gracefully stopped on fix: ' + JSON.stringify(issue))
  const tkSpec = calls3.spawned.find((s) => s.argv?.[1] === '/IM')
  assert(tkSpec && tkSpec.argv[2] === 'llama-server.exe', 'graceful taskkill /IM llama-server.exe')
  assert(!calls3.spawned.some((s) => (s.argv ?? []).includes('/F')), 'never a forced kill')
  console.log('PASS 29: resident model processes detected + graceful unload (ollama stop / taskkill, never forced)')
}

// 30. Deploy preflight: go / caution / stop verdicts from free VRAM.
{
  const run = async (memText, cfg = {}, extra = {}) => {
    const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
    apply(ctx, cfg)
    ctx.subprocess.spawn = (spec) => {
      calls.spawned.push(spec)
      let text
      if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = memText
      else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '\n'
      else text = '111, 3000, python\n'
      return {
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    const result = await calls.tool.execute({ gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, ...extra })
    return { result, calls }
  }
  const args = {}
  let calls
  // ~40% free → GO, no deploy issue
  let { result } = await run('4900, 8151\n')
  assert.strictEqual(result.checks.gpu.deploy.verdict, 'go', 'verdict go at ~40% free')
  assert(!result.issues.find((i) => i.title.includes('deploy')), 'no deploy issue when GO')
  // ~15% free → CAUTION, still no blocking issue
  ;({ result } = await run('6900, 8151\n'))
  assert.strictEqual(result.checks.gpu.deploy.verdict, 'caution', 'verdict caution at ~15% free')
  assert(result.checks.gpu.deploy.advice.includes('only fit if it is small'), 'caution advice attached')
  // ~3% free → STOP + error issue + unfixableReason + rendered line
  ;({ result, calls } = await run('7900, 8151\n'))
  assert.strictEqual(result.checks.gpu.deploy.verdict, 'stop', 'verdict stop at ~3% free')
  const stopIssue = result.issues.find((i) => i.title.includes('do not deploy'))
  assert(stopIssue && stopIssue.severity === 'error', 'stop raised as error')
  assert(stopIssue.unfixableReason.includes('autoKill'), 'explains how to free VRAM')
  const rendered = calls.tool.output.render({}, result)[0].text
  assert(rendered.includes('GPU deploy readiness: STOP'), 'render shows the stop verdict')
  console.log('PASS 30: deploy preflight go/caution/stop')
}

// 31. GPU multi-sample: judgment uses the WORST sample, report keeps all.
{
  const memQueue = ['8500, 10240\n', '9600, 10240\n', '8200, 10240\n']
  const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, { gpu: { samples: 3, sampleIntervalMs: 0 } })
  ctx.subprocess.spawn = (spec) => {
    calls.spawned.push(spec)
    let text
    if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = memQueue.length ? memQueue.shift() : '0, 10240\n'
    else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '572.70, RTX, 40, P0\n'
    else if (spec.argv[1] === '--query-gpu=utilization.gpu,fan.speed,power.draw,power.limit') text = '50, 30, 150, 250\n'
    else text = '111, 3000, python\n'
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const result = await calls.tool.execute({ gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: false, ports: false, power: false })
  assert.strictEqual(result.checks.gpu.samples.length, 3, '3 samples collected')
  const memoryHigh = result.issues.find((i) => i.title.includes('GPU 0 memory high'))
  assert(memoryHigh && memoryHigh.severity === 'warn', 'worst sample (94%) drives the verdict, not the last (80%)')
  assert.strictEqual(result.checks.gpu.deploy.verdict, 'stop', 'worst sample also drives the deploy verdict')
  assert(result.checks.gpu.driverInfo.extras && result.checks.gpu.driverInfo.extras.utilPct === 50, 'extras (util/fan/power) recorded')
  console.log('PASS 31: GPU multi-sample uses worst sample')
}

// 32. GPU extras + fan-not-spinning warning at high temperature.
{
  const { ctx, calls } = makeMockCtx({ resolveNvidia: () => Promise.resolve('C:/nvidia-smi.exe') })
  apply(ctx, { gpu: { samples: 1, sampleIntervalMs: 0 } })
  ctx.subprocess.spawn = (spec) => {
    let text
    if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = '4000, 10240\n'
    else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '572.70, GPU, 90, P0\n'
    else if (spec.argv[1] === '--query-gpu=utilization.gpu,fan.speed,power.draw,power.limit') text = '95, 0, 220, 250\n'
    else text = '111, 3000, python\n'
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const result = await calls.tool.execute({ gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: false, ports: false, power: false })
  const tempWarn = result.issues.find((i) => i.title.includes('temperature'))
  assert(tempWarn && tempWarn.severity === 'warn', '90C raises temperature warning')
  const fanWarn = result.issues.find((i) => i.title.includes('fan not spinning'))
  assert(fanWarn && fanWarn.severity === 'warn', 'fan 0 + hot GPU raises fan warning')
  assert.strictEqual(result.checks.gpu.driverInfo.extras.utilPct, 95, 'extras util recorded')
  console.log('PASS 32: GPU extras + fan-not-spinning warning')
}

// 33. System double-sample: mean warns, all-over errors, pagefile, pressure gate.
{
  const snap = (ramUsedPct, pagefileUsedPct = 50, wsMb = 12000) => {
    const ramTotal = 32768
    const pfTotal = 49152
    return JSON.stringify({
      cpu: 30,
      ram: { totalMb: ramTotal, freeMb: Math.round((ramTotal * (100 - ramUsedPct)) / 100) },
      pagefile: { totalMb: pfTotal, freeMb: Math.round((pfTotal * (100 - pagefileUsedPct)) / 100) },
      disks: [{ name: 'C:', freeGb: 200, totalGb: 500 }],
      processes: [{ name: 'python', pid: 123, wsMb }],
    })
  }
  const runSys = async (snaps) => {
    const queue = [...snaps]
    const { ctx, calls } = makeMockCtx({ resolveNvidia: (cmd) => (cmd === 'powershell' ? Promise.resolve('C:/powershell.exe') : Promise.reject(new Error('nf'))) })
    apply(ctx, { system: { samples: 2, sampleIntervalMs: 0 } })
    ctx.subprocess.spawn = (spec) => {
      calls.spawned.push(spec)
      const text = spec.argv?.[1] === '-NoProfile' ? (queue.length ? queue.shift() : snap(50)) : ''
      return {
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    return calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: true, errors: false, self: false, ports: false, power: false })
  }
  // (a) mean 92.5% → warn only (not all-over); heavy process under pressure → error
  let r = await runSys([snap(88), snap(97)])
  let issue = r.issues.find((i) => i.title.includes('System RAM high'))
  assert(issue && issue.severity === 'warn', 'mean RAM pressure is a warning, not an error')
  issue = r.issues.find((i) => i.title === 'Heavyweight process: python')
  assert(issue && issue.severity === 'error', 'heavyweight process is an error under RAM pressure')
  // (b) both samples beyond critical → error; pagefile too
  r = await runSys([snap(97, 96), snap(97, 96)])
  issue = r.issues.find((i) => i.title.includes('System RAM high'))
  assert(issue && issue.severity === 'error', 'both samples critical → error')
  issue = r.issues.find((i) => i.title.includes('Pagefile/commit high'))
  assert(issue && issue.severity === 'error', 'pagefile double-sample critical → error')
  // (c) no RAM pressure → heavyweight stays a warning
  r = await runSys([snap(50), snap(50)])
  issue = r.issues.find((i) => i.title.includes('Heavyweight process (no RAM pressure)'))
  assert(issue && issue.severity === 'warn', 'heavyweight without RAM pressure stays a warning')
  assert(!r.issues.find((i) => i.title.includes('System RAM high')), 'no RAM issue at 50%')
  console.log('PASS 33: system double-sample mean/all-over + pagefile + pressure downgrade')
}

// 34. New error fingerprints + notify cooldown + failure-loop reset on success.
{
  const injected = []
  const { ctx, calls, handlers } = makeMockCtx({ agents: [{ id: 'a1', inject: (msg) => injected.push(msg) }] })
  apply(ctx, { errors: { notifyOnCritical: true, notifyCooldownMs: 60000, loopThreshold: 3 } })
  const onResult = handlers['tools/result'][0]
  const failing = (stderr) => onResult({ name: 'ops_bash' }, { exitCode: 1, stderr })
  failing('connection timed out')
  assert.strictEqual(injected.length, 1, 'timeout fingerprint notifies immediately')
  failing('connection timed out again')
  assert.strictEqual(injected.length, 1, 'same fingerprint respects cooldown')
  onResult({ name: 'ops_bash' }, { exitCode: 0, stdout: 'ok' })
  await sleep(5)
  for (let k = 0; k < 3; k += 1) failing('ENOENT: no such file or directory')
  assert.strictEqual(injected.length, 2, 'new fingerprint notifies once, then cooldown')
  const errorsOnly = { gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: true, self: false, ports: false, power: false }
  let result = await calls.tool.execute(errorsOnly)
  let loop = result.issues.find((i) => i.title.includes('Failure loop') && i.title.includes('ops_bash'))
  assert(loop && loop.severity === 'error', '3 identical failures since last success → failure loop')
  onResult({ name: 'ops_bash' }, { exitCode: 0, stdout: 'ok' })
  result = await calls.tool.execute(errorsOnly)
  loop = result.issues.find((i) => i.title.includes('Failure loop'))
  assert(!loop, 'success clears the loop window')
  console.log('PASS 34: new fingerprints + notify cooldown + loop reset on success')
}

// 35. Port watch: EADDRINUSE-before-it-happens via netstat + tasklist.
{
  const { ctx, calls } = makeMockCtx({ resolveNvidia: (cmd) => (cmd === 'netstat' || cmd === 'tasklist' ? Promise.resolve('C:/' + cmd + '.exe') : Promise.reject(new Error('nf'))) })
  apply(ctx, { ports: { enabled: true, watchPorts: [8080] } })
  ctx.subprocess.spawn = (spec) => {
    let text
    if (spec.argv[1] === '-ano') text = '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234\n'
    else if (spec.argv[1] === '/FO') text = '"node.exe","1234","Console","1","100,000 K"\n'
    else text = ''
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  const result = await calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: false, ports: true, power: false })
  const issue = result.issues.find((i) => i.title.includes('Port 8080 is already in use'))
  assert(issue && issue.severity === 'warn', 'watched port in use raises warning')
  assert.strictEqual(result.checks.ports.listening[0].name, 'node.exe', 'port owner resolved via tasklist')
  console.log('PASS 35: port watch catches EADDRINUSE-before-it-happens')
}

// 36. Power plan: short standby + running job → warn; no job → silent.
{
  const runPower = async (jobs) => {
    const { ctx, calls } = makeMockCtx({ jobs, resolveNvidia: (cmd) => (cmd === 'powercfg' ? Promise.resolve('C:/powercfg.exe') : Promise.reject(new Error('nf'))) })
    apply(ctx, {})
    ctx.subprocess.spawn = (spec) => {
      let text
      if (spec.argv[1] === '/getactivescheme') text = 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\n'
      else if (spec.argv[1] === '/query') text = 'Current AC Power Setting Index: 0x00000384\n'
      else text = ''
      return {
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    return calls.tool.execute({ gpu: false, stuck: false, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: false, ports: false, power: true })
  }
  const running = [{ id: 'j1', label: 'build', status: 'running', startedAt: new Date().toISOString() }]
  let r = await runPower(running)
  let issue = r.issues.find((i) => i.title.includes('System sleep can kill long-running jobs'))
  assert(issue && issue.severity === 'warn', 'short standby + running job → warning')
  assert.strictEqual(r.checks.power.standbySec, 900, 'standby parsed from hex (0x384 = 900s)')
  r = await runPower([])
  issue = r.issues.find((i) => i.title.includes('System sleep'))
  assert(!issue, 'no running job → no warning')
  console.log('PASS 36: power-plan sleep check only warns with running jobs')
}

// 37. stuckJobs expectedLongLabels allowlist.
{
  const jobs = [
    { id: 'j1', label: 'npm build', status: 'running', startedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
    { id: 'j2', label: 'ffmpeg encode', status: 'running', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
  ]
  const { ctx, calls } = makeMockCtx({ jobs })
  apply(ctx, { stuckJobs: { expectedLongLabels: ['build'] } })
  const result = await calls.tool.execute({ gpu: false, stuck: true, plugins: false, versions: false, coreChain: false, system: false, errors: false, self: false, ports: false, power: false })
  assert(!result.issues.find((i) => i.title.includes('npm build')), 'expected-long job is not flagged')
  assert(result.issues.find((i) => i.title.includes('ffmpeg encode')), 'other long job still flagged')
  assert(result.checks.stuckJobs.expected.includes('npm build'), 'expected list recorded')
  console.log('PASS 37: stuckJobs expectedLongLabels allowlist')
}

// 38. Plugin pending grace: quiet inside grace, warns after.
{
  const runPending = async (pendingGraceMs) => {
    const plugins = [{ entryId: 'p1', moduleName: 'p', enabled: true, fiberPhase: 'pending' }]
    const { ctx, calls } = makeMockCtx({ plugins })
    apply(ctx, { plugins: { pendingGraceMs } })
    return calls.tool.execute({ gpu: false, stuck: false, plugins: true, versions: false, coreChain: false, system: false, errors: false, self: false, ports: false, power: false })
  }
  let r = await runPending(60000)
  assert(!r.issues.find((i) => i.title.includes('still activating')), 'pending within grace → no warning')
  r = await runPending(0)
  assert(r.issues.find((i) => i.title.includes('still activating')), 'pending beyond grace → warning')
  console.log('PASS 38: plugin pending grace period')
}

// 39. Idle heartbeat outside the deploy window: error-only alerts.
{
  const injected = []
  const { ctx, calls } = makeMockCtx({
    agents: [{ id: 'a1', inject: (msg) => injected.push(msg) }],
    resolveNvidia: (cmd) => (cmd === 'nvidia-smi' ? Promise.resolve('C:/nvidia-smi.exe') : Promise.reject(new Error('nf'))),
  })
  apply(ctx, { monitor: { enabled: true, intervalMs: 50, idleHeartbeatMs: 1000, alertCooldownMs: 0 }, gpu: { samples: 1, sampleIntervalMs: 0 } })
  ctx.subprocess.spawn = (spec) => {
    const text = spec.argv[1] === '--query-gpu=memory.used,memory.total' ? '9900, 10240\n' : ''
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  }
  await calls.monitorTick()
  assert.strictEqual(injected.length, 0, 'idle heartbeat not due yet → no alert')
  await sleep(1100)
  await calls.monitorTick()
  assert.strictEqual(injected.length, 1, 'idle heartbeat fires after due')
  assert(injected[0].content[0].text.includes('GPU alert') && injected[0].content[0].text.includes('memory critical'), 'alert carries the GPU critical error')
  console.log('PASS 39: idle heartbeat outside deploy window (error-only)')
}

// 40. Deploy readiness merges GPU free% and RAM free% (worst wins).
{
  const snap = (ramUsedPct) => {
    const total = 32768
    return JSON.stringify({
      cpu: 30,
      ram: { totalMb: total, freeMb: Math.round((total * (100 - ramUsedPct)) / 100) },
      pagefile: { totalMb: 49152, freeMb: 24576 },
      disks: [{ name: 'C:', freeGb: 200, totalGb: 500 }],
      processes: [],
    })
  }
  const runMerge = async (ramUsedPct) => {
    const { ctx, calls } = makeMockCtx({ resolveNvidia: (cmd) => (cmd === 'nvidia-smi' || cmd === 'powershell' ? Promise.resolve('C:/' + cmd + '.exe') : Promise.reject(new Error('nf'))) })
    apply(ctx, { system: { samples: 1, sampleIntervalMs: 0 }, gpu: { samples: 1, sampleIntervalMs: 0 } })
    ctx.subprocess.spawn = (spec) => {
      let text
      if (spec.argv[1] === '--query-gpu=memory.used,memory.total') text = '4900, 8151\n'
      else if (spec.argv[1] === '--query-gpu=driver_version,name,temperature.gpu,pstate') text = '\n'
      else if (spec.argv[1] === '--query-gpu=utilization.gpu,fan.speed,power.draw,power.limit') text = '30, 30, 100, 250\n'
      else if (spec.argv[1] === '-NoProfile') text = snap(ramUsedPct)
      else text = '111, 3000, python\n'
      return {
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    }
    return calls.tool.execute({ gpu: true, stuck: false, plugins: false, versions: false, coreChain: false, system: true, errors: false, self: false, ports: false, power: false })
  }
  let r = await runMerge(90)
  assert.strictEqual(r.checks.gpu.deploy.verdict, 'caution', 'RAM 90% used drags combined verdict to caution')
  assert.strictEqual(r.checks.gpu.deploy.ramFreePct, 10, 'ramFreePct exposed')
  assert.strictEqual(r.checks.gpu.deploy.combinedFreePct, 10, 'combined = min(GPU 40%, RAM 10%)')
  r = await runMerge(95)
  assert.strictEqual(r.checks.gpu.deploy.verdict, 'stop', 'RAM 95% used → stop')
  console.log('PASS 40: deploy readiness merges GPU + RAM free space')
}

// 41. Trial expect assertions (exitCode / outputMatches / outputNotMatches) + verdict + durations.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial41-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export41-'))
  const { ctx, calls } = makeMockCtx()
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  // wrong exit code
  let create = await tool.execute({ action: 'create', spec: { name: 't41', runCmd: 'node app.js', runs: 2, expect: { exitCode: 0, outputMatches: 'ok' } } })
  calls.spawnResults = [{ exitCode: 0, stdout: 'ok' }, { exitCode: 1, stdout: 'boom' }]
  const ran = await tool.execute({ action: 'run', trialId: create.trialId })
  assert.strictEqual(ran.passCount, 1, 'one run passed')
  const analyzed = await tool.execute({ action: 'analyze', trialId: create.trialId })
  assert(analyzed.issues.find((i) => i.title.includes('Unexpected exit code')), 'wrong exit code flagged')
  assert.strictEqual(analyzed.verdict, 'failed', 'verdict failed')
  assert(Number.isFinite(analyzed.durationsMs.total), 'durations reported')
  // forbidden output
  create = await tool.execute({ action: 'create', spec: { name: 't41b', runCmd: 'node app.js', runs: 1, expect: { exitCode: 0, outputMatches: 'hello', outputNotMatches: 'forbidden' } } })
  calls.spawnResults = [{ exitCode: 0, stdout: 'hello forbidden' }]
  await tool.execute({ action: 'run', trialId: create.trialId })
  const b = await tool.execute({ action: 'analyze', trialId: create.trialId })
  assert(b.issues.find((i) => i.title.includes('Forbidden output present')), 'forbidden output flagged')
  // missing expected output
  create = await tool.execute({ action: 'create', spec: { name: 't41c', runCmd: 'node app.js', runs: 1, expect: { exitCode: 0, outputMatches: 'hello' } } })
  calls.spawnResults = [{ exitCode: 0, stdout: 'bye' }]
  await tool.execute({ action: 'run', trialId: create.trialId })
  const c = await tool.execute({ action: 'analyze', trialId: create.trialId })
  assert(c.issues.find((i) => i.title.includes('Expected output missing')), 'missing output flagged')
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  console.log('PASS 41: trial expect assertions + verdict + durations')
}

// 42. Trial watchGpu leak detection + export manifest + cleanup all.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-trial42-'))
  const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-export42-'))
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-src42-'))
  fs.writeFileSync(path.join(srcDir, 'run.js'), 'console.log(1)\n')
  const { ctx, calls } = makeMockCtx({ resolveNvidia: (cmd) => (cmd === 'nvidia-smi' ? Promise.resolve('C:/nvidia-smi.exe') : Promise.reject(new Error('nf'))) })
  apply(ctx, { trial: { sandboxRoot: sandbox, exportsRoot: exportsDir } })
  const tool = calls.tools.find((t) => t.name === 'safe_trial_run')
  const create = await tool.execute({ action: 'create', spec: { name: 't42', sourceDir: srcDir, runCmd: 'node run.js', runs: 2, watchGpu: true } })
  const gpuQueue = ['2000\n', '2100\n', '2500\n']
  const runQueue = [{ exitCode: 0, stdout: 'ok' }, { exitCode: 0, stdout: 'ok' }]
  ctx.subprocess.spawn = (spec) => {
    let text = ''
    let exitCode = 0
    if (spec.argv[1] === '--query-gpu=memory.used') text = gpuQueue.length ? gpuQueue.shift() : '2000\n'
    else {
      const q = runQueue.shift()
      text = q.stdout
      exitCode = q.exitCode
    }
    return {
      collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode }),
      terminate() {},
    }
  }
  const ran = await tool.execute({ action: 'run', trialId: create.trialId })
  assert.strictEqual(ran.gpu.beforeMiB, 2000, 'before sample')
  assert.strictEqual(ran.gpu.afterMiB, 2500, 'after sample')
  assert.strictEqual(ran.gpu.peakMiB, 2500, 'peak sample')
  assert.strictEqual(ran.gpuLeakMiB, 500, 'leak detected between runs')
  assert(ran.gpuLeakWarning, 'leak warning text present')
  const analyzed = await tool.execute({ action: 'analyze', trialId: create.trialId })
  assert(analyzed.issues.find((i) => i.title.includes('GPU memory leak suspected')), 'leak warning survives analysis')
  assert.strictEqual(analyzed.verdict, 'clean', 'clean runs → clean verdict (leak stays a warning)')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-out42-'))
  await tool.execute({ action: 'export', trialId: create.trialId, outputDir: outDir })
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'trial-report.json'), 'utf8'))
  assert.strictEqual(manifest.verdict, 'flaky', 'warn issue → flaky manifest verdict')
  assert.strictEqual(manifest.fileCount, 1, 'one source file exported')
  assert(manifest.issues.find((i) => i.title.includes('GPU memory leak suspected')), 'manifest carries the issues')
  const cleaned = await tool.execute({ action: 'cleanup', trialId: 'all' })
  assert.strictEqual(cleaned.removed.length, 1, 'all trials removed')
  assert(!fs.existsSync(create.dir), 'sandbox dir removed')
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.rmSync(exportsDir, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.rmSync(outDir, { recursive: true, force: true })
  console.log('PASS 42: trial watchGpu leak + export manifest + cleanup all')
}

console.log('ALL SMOKE TESTS PASSED')
