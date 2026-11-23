/**
 * capability-safety-guard — 能力安全卫士
 *
 * Host bundle. In every conversation, whenever a capability is added or
 * upgraded (plugin / bundle / tool / skill / MCP server / agent preset /
 * model / adapter), it:
 *   1. records the change,
 *   2. silently checks plugin activation health and auto-disables plugins that
 *      failed to activate (non-destructive fix), notifying live agents via
 *      inbox injection (does not wake them),
 *   3. registers a global system-prompt policy telling the model to run
 *      `capability_safety_check` right after any capability change,
 *   4. registers the `capability_safety_check` tool, which checks GPU memory
 *      pressure, temperature, per-process VRAM consumers and rising-memory
 *      trends (plus driver version), long-running background jobs, plugin
 *      health, installed @deepseek-ai version channels (prerelease /
 *      mixed-channel hazards), core plugin chain health
 *      (storage/workspace/session/...), pending-restart changes, system
 *      resources (RAM, CPU load, drive free space, heavyweight processes),
 *      recent tool-error fingerprints (OOM / port conflict / disk full /
 *      permission / missing module) and repeated-failure loops, and the
 *      guardian's own health; applies every non-destructive fix automatically
 *      and, with `fix: true`, also the destructive fixes the config
 *      explicitly allows (kill stuck jobs / GPU processes / heavyweight
 *      system processes). Anything it cannot fix is reported with a reason
 *      so the model can explain it to the user.
 *
 * Zero-dependency host plugin. Config comes from the bundle row config; the
 * defaults below are merged defensively.
 */

export const name = 'capability-safety-guard'

/** Host services required before this plugin can activate. */
export const inject = ['tools', 'systemPrompt', 'pluginManager', 'jobs', 'agents', 'subprocess', 'timer']

const DEFAULT_CONFIG = {
  gpu: { enabled: true, warnUsedPct: 85, criticalUsedPct:95, autoKill: false, tempWarnC: 85, tempCriticalC: 92, resident: { enabled: true, warnAtPct: 80, patterns: ['ollama', 'llama'], autoStopOnFix: false } },
  stuckJobs: { enabled: true, warnMs: 5 * 60 * 1000, killMs: 15 * 60 * 1000, autoKill: false },
  plugins: { enabled: true, autoDisableFailed: true },
  monitor: { enabled: true, intervalMs: 2 * 1000, deployWindowMs: 10 * 60 * 1000, heavyEveryNTicks: 15 },
  installGuard: { enabled: true, flagPrerelease: true, warnCoreChainDisabled: true, trackRestartPending: true },
  system: {
    enabled: true,
    ram: { warnUsedPct: 85, criticalUsedPct: 95 },
    cpu: { warnUsedPct: 85, criticalUsedPct: 95 },
    disk: { paths: ['C:', 'D:'], warnFreePct: 15, criticalFreePct: 8 },
    processes: { warnWorkingSetMb: 6144, criticalWorkingSetMb: 10240, allowedNames: [], autoKill: false },
  },
  errors: { enabled: true, notifyOnCritical: true, loopThreshold: 3 },
  trial: {
    enabled: true,
    sandboxRoot: '', // default: <temp>/dsh-trial-sandbox
    exportsRoot: '', // default: <temp>/dsh-trial-output
    defaultRuns: 3,
    runTimeoutSec: 180,
    installTimeoutSec: 600,
  },
  self: { enabled: true },
  deploy: { enabled: true, goFreePct: 25, stopFreePct: 10 },
  silentCheckDebounceMs: 2000,
  maxRecentChanges: 20,
}

/** Capability-change events that record a change and trigger a silent check. */
const CHANGE_EVENTS = [
  'plugin-manager/changed',
  'plugin-manager/install-state',
  'plugin-manager/install-log',
  'hmr/reload',
  'tools/change',
  'skills/change',
  'mcp-manager/status',
  'llm/adapters-updated',
  'agent-preset/selected',
]

const PROMPT_SECTION_NAME = 'capability-safety-policy'
/** Between PLAN_POLICY (500) and TEAM_POLICY (600). */
const PROMPT_SECTION_ORDER = 550

const PROMPT_TEXT = `Capability safety policy (enforced by the capability-safety-guard plugin):
- Right after you add or upgrade any capability in this session — install, upgrade, or enable a plugin or bundle, register a new tool or skill, add or change an MCP server, or change the agent preset, model, or adapter — call the capability_safety_check tool once the change has landed.
- The tool checks GPU memory pressure (including which processes hold VRAM, GPU temperature/throttling, and rising-memory trends), long-running background jobs, plugin activation health, installed @deepseek-ai package version channels, core plugin chain health, system resources (RAM, CPU, drives, heavyweight processes), recent tool-error fingerprints and repeated-failure loops, and the guardian's own health. It always applies the non-destructive fixes (for example disabling a plugin that failed to activate, when the config allows it). Pass fix: true to also apply destructive fixes the config allows (killing stuck jobs or GPU processes); never pass fix: true for GPU kills unless the user asked you to.
- If the tool reports a problem it cannot fix, explain to the user why it cannot be fixed automatically and what they can do.
- Install-guard lessons from a past outage: before relying on a freshly installed or upgraded bundle, verify the RESOLVED (actually installed) version and its release channel (stable/alpha/beta/rc) of every @deepseek-ai package in this profile, not just the version the catalog or directory label claimed — a version/channel mismatch can get core plugins auto-disabled at boot and take down the whole app. Keep quarantines and backups in place until the fix chain is fully verified; never undo a protection (e.g. renaming a quarantined copy back) before you have confirmed the removal path works. The tool surfaces prerelease/mixed-channel hazards and pending-restart changes.
- Software/program development on this machine carries extra hazards, and the tool also checks them: system RAM pressure, free space on the workspace/profile drives, and heavyweight processes (system check); and it watches tool results for error fingerprints such as out-of-memory (CUDA OOM), port conflicts (EADDRINUSE), disk-full, permission-denied, and missing-module errors (errors check). When writing or running software here: (1) install pip/npm/pnpm packages into an isolated project environment (venv / project node_modules) and NEVER into the DSH profile or runtime directories — the deepest past outage was caused by a profile-wide dependency drag; (2) before binding a port, check it is free (a taken port fails the server with EADDRINUSE); (3) run long tasks as background jobs with timeouts and clean them up; (4) keep quarantines/backups until the fix is verified, and free disk space if a drive runs low; (5) on Windows, system sleep can kill long-running jobs — check power settings when a job must run for hours.
 - Try-before-commit workflow: before installing anything new (a downloaded app, a local model, a package set) or running newly written software for real, stage it in a sandbox trial first with the safe_trial_run tool: action "create" (isolated sandbox dir; python trials get their own venv; cleaned HOME/TEMP/PIP/NPM env), then action "run" to install and execute the program several times (each run has a timeout and captured output), then action "analyze" to collect crashes and error fingerprints and get proposed fixes. Report every problem and the proposed fixes to the USER, let the USER decide which fixes to apply, then action "fix" with ONLY the approved fixes (all fixes stay inside the sandbox), "run" + "analyze" again until clean, and finally action "export" to copy the verified product out of the sandbox and present it as the final artifact. The sandbox isolates files, environment and processes — it is NOT a VM: the GPU and OS are shared, so watch capability_safety_check for VRAM pressure during GPU trials. Trial state is plugin memory (lost on restart); clean up finished trials with action "cleanup".
 - Pre-deploy VRAM cleanup (ANY local model or program, not only Ollama): when you learn a deploy is coming (image generation, another big model, a local server, training), first call capability_safety_check and read the "GPU deploy readiness" verdict plus any "Resident model process(es)" issue. GO = proceed. CAUTION/STOP = free VRAM before starting, without asking: for ollama/llama resident processes run \`ollama stop\` right away (or capability_safety_check with fix: true and gpu.resident.autoStopOnFix to do it via the tool). For ANY OTHER holder process (ComfyUI, python jobs, other servers), never kill silently — list the processes and ask the user before stopping them. Re-check afterwards and only start once the verdict is GO, because on this 8 GB card the display itself needs that VRAM and can black-screen. Prefer OLLAMA_KEEP_ALIVE settings so idle models unload on their own.
 - Deploy preflight for ANY model or program: before you deploy or run any local model or program (image generation, Ollama/llama, training jobs, local servers), call capability_safety_check and read the "GPU deploy readiness" line (checks.gpu.deploy). verdict GO = enough headroom; CAUTION = only a small workload will fit; STOP = do not deploy — free VRAM first (ollama stop, close GPU apps) and re-check, because on this card the display itself needs that VRAM and can black-screen. The trial sandbox (safe_trial_run with watchGpu) is the recommended way to stage the first real runs.`

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge base with override (override wins; both must be records). */
function mergeConfig(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isRecord(value) && isRecord(base[key]) ? mergeConfig(base[key], value) : value
  }
  return out
}

function truncate(text, max = 300) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

function describeChangeResult(res) {
  const parts = [`application: ${res?.application ?? 'unknown'}`]
  if (res?.error) parts.push(`error: ${truncate(res.error)}`)
  if (Array.isArray(res?.warnings) && res.warnings.length) parts.push(`warnings: ${truncate(res.warnings.join('; '))}`)
  return parts.join('; ')
}

function recordChange(state, eventName, payload, max) {
  let label = eventName
  try {
    if (eventName === 'plugin-manager/changed' && payload && isRecord(payload.change)) {
      const change = payload.change
      const target = change.target ?? change.id ?? ''
      label += target ? ` (${change.reason}, ${target})` : ` (${change.reason})`
    } else if (eventName === 'plugin-manager/install-state' && payload) {
      const stage = payload.stage ?? ''
      const stateName = payload.state ?? payload.status ?? ''
      label += ` (${stage}${stateName ? ': ' + stateName : ''})`
    } else if (eventName === 'mcp-manager/status' && payload) {
      label += ` (${payload.name ?? ''} ${payload.status ?? ''})`.trim()
    } else if (eventName === 'hmr/reload') {
      label += ' (hot reload)'
    } else if (eventName === 'agent-preset/selected' && payload) {
      label += ` (${payload.agentPreset ?? ''})`.trim()
    }
  } catch {
    /* payload shapes are best-effort */
  }
  state.recent.push({ at: new Date().toISOString(), event: truncate(label, 200) })
  if (state.recent.length > max) state.recent.shift()
}

/** Notify every live agent via inbox injection (target next-step, no wake). */
function notifyAgents(ctx, text, state) {
  let agents = []
  try {
    agents = ctx.agents.list()
  } catch {
    return
  }
  let delivered = false
  for (const agent of agents) {
    try {
      const message = buildNotice(text)
      // Self-guard: every durable injected message must carry a non-empty
      // id AND a producer-owned source (session format v4 hard-validates
      // both: source is checked on adoption, and the message must stay an
      // "identified message" when the runtime re-emits it as a
      // user/message event). Refuse to inject instead of writing a
      // session-corrupting row.
      if (!isValidProducerMessage(message)) {
        if (state) state.stats.injectBlocked += 1
        continue
      }
      agent.inject(message)
      delivered = true
    } catch {
      /* an agent may reject injection while stopping */
    }
  }
  if (delivered && state) state.stats.alertsSent += 1
}

/** Fresh, non-empty message id for a durable injected notice. */
function newMessageId() {
  try {
    const c = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') {
      const id = c.randomUUID()
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {
    /* fall through to the fallback */
  }
  return `csg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Build the durable notice injected into agents. The message MUST satisfy
 * every session-format v4 invariant:
 *   - a producer-owned source: an object whose `kind` is a non-empty string
 *     and not "plugin" (missing source / empty or "plugin" kind is a
 *     SessionFormatError) — this exact bug corrupted 7 sessions on
 *     2026-11-23;
 *   - a non-empty string `id`: when the runtime re-emits an inbox message as
 *     a `user/message` session event it must be an "identified message"
 *     (`session event at seq N lacks an identified message` otherwise) —
 *     this second bug made session-7b9d41ee unable to reopen on 2026-11-23
 *     after the source fix alone.
 * This builder centralizes both fixes so no future refactor can reintroduce
 * either corruption.
 */
export function buildNotice(text) {
  return {
    role: 'user',
    id: newMessageId(),
    source: { kind: 'capability-safety', form: 'notice' },
    content: [{ type: 'text', text }],
  }
}

/**
 * True when `source` satisfies the session-format v4 requirement:
 * an object whose `kind` is a non-empty string and not "plugin".
 */
export function isValidProducerSource(source) {
  return (
    isRecord(source) &&
    typeof source.kind === 'string' &&
    source.kind.length > 0 &&
    source.kind !== 'plugin'
  )
}

/**
 * True when a content block is a well-formed text block
 * ({type: 'text', text: non-empty string}) — the only block kind this
 * plugin's notices ever emit.
 */
function isValidTextBlock(block) {
  return (
    isRecord(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.length > 0
  )
}

/**
 * True when a built notice satisfies every session-format v4 invariant:
 * role/user, a non-empty string id (identified message — the field whose
 * absence broke session resume on 2026-11-23), a valid producer-owned
 * source, and a non-empty array of well-formed text blocks.
 */
export function isValidProducerMessage(message) {
  return (
    isRecord(message) &&
    message.role === 'user' &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    isValidProducerSource(message.source) &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(isValidTextBlock)
  )
}

/**
 * Detect whether a capability-change payload says the change is not live
 * yet (ChangeResult application === 'restart-required', a restartReason
 * field, or strings like "restart required"). Returns a note or null.
 */
function detectRestartSignal(payload) {
  try {
    if (isRecord(payload)) {
      if (payload.application === 'restart-required') {
        return `a change applied with application: restart-required${payload.restartReason ? ` (${truncate(payload.restartReason, 120)})` : ''}`
      }
      if (typeof payload.restartReason === 'string' && payload.restartReason) {
        return truncate(payload.restartReason, 200)
      }
      const text = JSON.stringify(payload)
      if (text && /restart[- ]?(required|needed|pending)/i.test(text)) {
        return truncate(text, 200)
      }
    } else if (typeof payload === 'string' && /restart[- ]?(required|needed|pending)/i.test(payload)) {
      return truncate(payload, 200)
    }
  } catch {
    /* payload shapes are best-effort */
  }
  return null
}

/* ------------------------------------------------------------------ */
/* subprocess helpers                                                  */
/* ------------------------------------------------------------------ */

function readCollected(col) {
  try {
    if (col && typeof col.readFrom === 'function') return col.readFrom(0).text ?? ''
  } catch {
    /* collected output unavailable */
  }
  return ''
}

/** Spawn argv, collect bounded stdout, reject on non-zero exit or timeout. */
function runCapture(ctx, argv, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd: process.cwd(),
        graceMs: 3000,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { handle.terminate() } catch { /* already gone */ }
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    handle.done.then(
      ({ exitCode }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (exitCode !== 0) {
          const stderr = readCollected(handle.collected?.stderr)
          reject(new Error(`exited with code ${exitCode}${stderr ? ': ' + truncate(stderr, 200) : ''}`))
          return
        }
        resolve(readCollected(handle.collected?.stdout))
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Kill one PID. Returns true when the kill command exited 0. */
async function killPid(ctx, pid) {
  const isWin = process.platform === 'win32'
  const argv = isWin
    ? ['taskkill', '/PID', String(pid), '/F']
    : ['kill', '-9', String(pid)]
  try {
    await runCapture(ctx, argv, 8000)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

/** Parse nvidia-smi csv rows "used, total" (MiB). */
export function parseGpuRows(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 2) continue
    const used = Number.parseInt(parts[0], 10)
    const total = Number.parseInt(parts[1], 10)
    if (Number.isNaN(used) || Number.isNaN(total) || total <= 0) continue
    rows.push({ used, total })
  }
  return rows
}

/** Parse nvidia-smi compute apps rows "pid, used_memory[, process_name]". */
export function parseAppRows(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 2) continue
    const pid = Number.parseInt(parts[0], 10)
    if (Number.isNaN(pid)) continue
    const usedRaw = parts[1]
    const used = /^\d+$/.test(String(usedRaw)) ? Number.parseInt(usedRaw, 10) : 0
    const usedKnown = /^\d+$/.test(String(usedRaw))
    rows.push({ pid, used, usedKnown, name: parts[2] || null })
  }
  return rows
}

async function checkGpu(ctx, cfg, fix, withDriverInfo = false, state = null, withProcesses = false) {
  const out = { checked: false, issues: [] }
  if (!cfg.gpu.enabled) {
    out.note = 'GPU check disabled in plugin config.'
    return out
  }
  let exe
  try {
    exe = await ctx.subprocess.resolveExecutable('nvidia-smi')
  } catch {
    out.checked = true
    out.note = 'nvidia-smi not found: no NVIDIA GPU, driver, or tools on this machine; GPU check skipped.'
    return out
  }
  let queryText
  try {
    queryText = await runCapture(ctx, [exe, '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'])
  } catch (error) {
    out.checked = true
    out.error = `nvidia-smi query failed: ${truncate(String(error?.message ?? error))}`
    if (state) state.stats.gpuSnapshotsFail += 1
    return out
  }
  out.checked = true
  const rows = parseGpuRows(queryText)
  if (!rows.length) {
    out.note = 'nvidia-smi returned no usable rows.'
    return out
  }
  out.rows = rows
  if (state) {
    state.gpuSamples.push({ at: new Date().toISOString(), pct: Math.round((100 * rows[0].used) / rows[0].total) })
    if (state.gpuSamples.length > 60) state.gpuSamples.shift()
    state.stats.gpuSnapshotsOk += 1
  }
  if (withDriverInfo) {
    try {
      const infoText = await runCapture(ctx, [exe, '--query-gpu=driver_version,name,temperature.gpu,pstate', '--format=csv,noheader,nounits'])
      const firstLine = String(infoText).split(/\r?\n/)[0] ?? ''
      const parts = firstLine.split(',').map((p) => p.trim())
      const driverVersion = parts[0] ?? ''
      if (driverVersion) {
        out.driverInfo = { version: driverVersion, gpuName: parts[1] ?? '', tempC: Number.parseInt(parts[2], 10), pstate: parts[3] ?? '' }
      }
      const tempC = Number.parseInt(parts[2], 10)
      if (Number.isFinite(tempC) && tempC > 0) {
        if (tempC >= cfg.gpu.tempCriticalC) {
          out.issues.push({
            severity: 'error',
            kind: 'gpu',
            title: 'GPU 0 temperature critical',
            detail: `${tempC}°C (critical ${cfg.gpu.tempCriticalC}°C)${parts[3] ? `, perf state ${parts[3]}` : ''} — the card may be thermal-throttling, which slows work and destabilizes long jobs.`,
            fixed: false,
            unfixableReason:
              'not auto-fixed: temperature is a cooling/power problem. Reduce load or batch size, check fans and ambient temperature, cap power draw (nvidia-smi -pl), then re-run.',
          })
        } else if (tempC >= cfg.gpu.tempWarnC) {
          out.issues.push({
            severity: 'warn',
            kind: 'gpu',
            title: 'GPU 0 temperature high',
            detail: `${tempC}°C (warn ${cfg.gpu.tempWarnC}°C)${parts[3] ? `, perf state ${parts[3]}` : ''} — watch for throttling.`,
            fixed: false,
          })
        }
      }
    } catch {
      /* driver info is best-effort */
    }
  }
  if (withProcesses) {
    try {
      const appsText = await runCapture(ctx, [exe, '--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader,nounits'])
      const apps = parseAppRows(appsText)
      out.appRows = apps
      const isLlama = (r) => /ollama|llama/i.test(String(r.name ?? ''))
      out.consumers = apps
        .sort((a, b) => (b.usedKnown - a.usedKnown) || (b.used - a.used) || (isLlama(b) - isLlama(a)))
        .slice(0, 5)
    } catch {
      /* consumer list is best-effort */
    }
  }
  // Deployment preflight (generalized from the Ollama lesson): before
  // running ANY new local model or program, report how much VRAM headroom
  // is left and who is holding it, with a go/caution/stop verdict. On a
  // small card the display shares the VRAM, so a full GPU can black-screen
  // the desktop the moment the next workload starts.
  if (cfg.deploy?.enabled !== false && withProcesses) {
    const row = rows[0]
    const freeMiB = Math.max(0, row.total - row.used)
    const freePct = Math.round((100 * freeMiB) / row.total)
    const holders = (out.consumers ?? []).map((c) => (c.name ? `${c.name} (${c.usedKnown ? `${c.used} MiB` : 'N/A MiB'})` : `pid ${c.pid} (${c.usedKnown ? `${c.used} MiB` : 'N/A MiB'})`))
    const holdersLabel = (out.consumers ?? []).some((c) => c.usedKnown) ? 'top holders' : 'GPU processes (per-process MiB N/A)'
    let verdict = 'go'
    if (freePct < (cfg.deploy.stopFreePct ?? 10)) verdict = 'stop'
    else if (freePct < (cfg.deploy.goFreePct ?? 25)) verdict = 'caution'
    out.deploy = {
      verdict,
      freeMiB,
      freePct,
      totalMiB: row.total,
      holders: holders.slice(0, 5),
      holdersLabel,
      advice:
        verdict === 'stop'
          ? `only ${freeMiB} MiB (${freePct}%) of ${row.total} MiB is free — do NOT start a new model or program now; the display shares this VRAM and can black-screen. Free memory first (ollama stop, close GPU apps) and re-run this check.`
          : verdict === 'caution'
            ? `${freeMiB} MiB (${freePct}%) free — a new model or program will only fit if it is small; free more VRAM first if you can (ollama stop, close GPU apps).`
            : `${freeMiB} MiB (${freePct}%) free — enough headroom to deploy a new workload.`,
    }
    if (verdict === 'stop') {
      out.issues.push({
        severity: 'error',
        kind: 'gpu',
        title: 'GPU 0 has almost no free VRAM — do not deploy a new model or program',
        detail: out.deploy.advice,
        fixed: false,
        unfixableReason:
          'not auto-fixed: freeing VRAM means stopping other GPU apps, which can destroy their work. Stop them yourself (ollama stop, close GPU apps), or enable gpu.autoKill and re-run with fix: true to kill the consumers.',
      })
    }
  }
  const residentCfg = cfg.gpu.resident ?? cfg.gpu.ollama ?? {}
  if (residentCfg.enabled !== false && withProcesses && Array.isArray(out.consumers)) {
    const patterns = Array.isArray(residentCfg.patterns) && residentCfg.patterns.length > 0 ? residentCfg.patterns : ['ollama', 'llama']
    const residentRe = new RegExp(patterns.map((p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
    const residentApps = (out.appRows ?? out.consumers ?? []).filter((c) => residentRe.test(String(c.name ?? '')))
    if (residentApps.length) {
      const knownMiB = residentApps.filter((c) => c.usedKnown).reduce((sum, c) => sum + c.used, 0)
      const anyKnown = residentApps.some((c) => c.usedKnown)
      const pct = Math.round((100 * rows[0].used) / rows[0].total)
      const warnAt = residentCfg.warnAtPct ?? 80
      if (pct >= warnAt) {
        const issue = {
          severity: pct >= cfg.gpu.criticalUsedPct ? 'error' : 'warn',
          kind: 'gpu',
          title: 'Resident model process(es) holding VRAM',
          detail: `resident model process(es) ${residentApps.map((c) => c.name ?? c.pid).join(', ')} are running${anyKnown ? ` and hold ~${knownMiB} MiB` : ' (per-process MiB is N/A on this driver)'} with the GPU at ${pct}% (warn ${warnAt}%). The display shares this VRAM on a small card: before starting image generation or another big model, unload them, or VRAM exhaustion can black-screen the display.`,
          fixed: false,
        }
        if (fix && residentCfg.autoStopOnFix) {
          const notes = []
          let allStopped = true
          for (const app of residentApps) {
            const name = String(app.name ?? '')
            try {
              if (/ollama/i.test(name)) {
                const ollamaExe = await ctx.subprocess.resolveExecutable('ollama')
                await runCapture(ctx, [ollamaExe, 'stop'], 15000)
                notes.push('ollama stop → ok')
              } else {
                const imageName = name.split(/[\\/]/).pop()
                const tkExe = await ctx.subprocess.resolveExecutable('taskkill')
                await runCapture(ctx, [tkExe, '/IM', imageName], 15000)
                notes.push(`graceful taskkill ${imageName} → ok`)
              }
            } catch (error) {
              allStopped = false
              notes.push(`stop failed: ${truncate(String(error?.message ?? error))}`)
            }
          }
          issue.fixed = allStopped
          issue.detail += ` — cleanup ran: ${notes.join('; ')}.`
          if (!allStopped) {
            issue.unfixableReason =
              'at least one graceful stop was refused (the process may be busy with in-flight work). Unload it manually ("ollama stop" or close the app), or ask the user before any forced kill.'
          }
        } else if (fix) {
          issue.unfixableReason =
            'gpu.resident.autoStopOnFix is off in the plugin config: enable it and re-run with fix: true, or unload the resident models yourself ("ollama stop" for Ollama, close the app for others) before launching image generation.'
        }
        out.issues.push(issue)
      }
    }
  }
  // Rising-memory trend across the sampled window (leak / growing workload).
  if (state && state.gpuSamples.length >= 3) {
    const samples = state.gpuSamples
    const first = samples[0]
    const last = samples[samples.length - 1]
    const spanMs = new Date(last.at).getTime() - new Date(first.at).getTime()
    const delta = last.pct - first.pct
    if (spanMs > 0 && delta >= 10 && last.pct >= cfg.gpu.warnUsedPct) {
      out.issues.push({
        severity: 'warn',
        kind: 'gpu',
        title: 'GPU 0 memory rising steadily',
        detail: `+${delta} percentage points over ${Math.max(1, Math.round(spanMs / 60000))} min (${first.pct}% → ${last.pct}%) — a memory leak or a growing workload`,
        fixed: false,
      })
    }
  }
  const critical = []
  rows.forEach((row, index) => {
    const pct = Math.round((100 * row.used) / row.total)
    if (pct >= cfg.gpu.criticalUsedPct) {
      const issue = {
        severity: 'error',
        kind: 'gpu',
        title: `GPU ${index} memory critical`,
        detail: `${pct}% used (${row.used}/${row.total} MiB), threshold ${cfg.gpu.criticalUsedPct}%`,
        fixed: false,
      }
      out.issues.push(issue)
      critical.push({ index, issue, ...row })
    } else if (pct >= cfg.gpu.warnUsedPct) {
      out.issues.push({
        severity: 'warn',
        kind: 'gpu',
        title: `GPU ${index} memory high`,
        detail: `${pct}% used (${row.used}/${row.total} MiB), threshold ${cfg.gpu.warnUsedPct}%`,
        fixed: false,
      })
    }
  })
  if (critical.length) {
    if (!cfg.gpu.autoKill) {
      for (const { issue } of critical) {
        issue.unfixableReason =
          'gpu.autoKill is off in the plugin config: killing GPU processes can destroy the user\'s running work (e.g. an image generation). Close GPU apps manually, or enable autoKill in the plugin config.'
      }
    } else if (!fix) {
      for (const { issue } of critical) {
        issue.unfixableReason = 'gpu.autoKill is on but this call did not pass fix: true; re-run with fix: true to kill the GPU consumers.'
      }
    } else {
      try {
        const { killed, freed } = await killGpuConsumers(ctx, exe, cfg.gpu.warnUsedPct, rows)
        for (const { issue } of critical) {
          if (killed.length) {
            issue.fixed = true
            issue.detail += ` — killed pids [${killed.join(', ')}] (freed ~${freed} MiB)`
          } else {
            issue.unfixableReason = 'no killable GPU compute processes were reported by nvidia-smi.'
          }
        }
      } catch (error) {
        for (const { issue } of critical) {
          issue.unfixableReason = `GPU consumer kill failed: ${truncate(String(error?.message ?? error))}`
        }
      }
    }
  }
  return out
}

async function killGpuConsumers(ctx, exe, targetPct, rows) {
  const appText = await runCapture(ctx, [exe, '--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader,nounits'])
  const apps = parseAppRows(appText).sort((a, b) => b.used - a.used)
  const totalUsed = rows.reduce((sum, row) => sum + row.used, 0)
  const totalMem = rows.reduce((sum, row) => sum + row.total, 0)
  const freedNeeded = totalUsed - Math.floor((totalMem * targetPct) / 100)
  const killed = []
  let freed = 0
  for (const app of apps) {
    if (freed >= freedNeeded) break
    if (app.pid === process.pid) continue
    if (await killPid(ctx, app.pid)) {
      killed.push(app.name ? `${app.pid} (${app.name})` : String(app.pid))
      freed += app.used
    }
  }
  return { killed, freed }
}

async function checkStuckJobs(ctx, cfg, fix) {
  const out = { checked: false, issues: [] }
  if (!cfg.stuckJobs.enabled) {
    out.note = 'Stuck-job check disabled in plugin config.'
    return out
  }
  const views = []
  const seen = new Set()
  const push = (list) => {
    for (const job of list) {
      if (job && job.id != null && !seen.has(job.id)) {
        seen.add(job.id)
        views.push(job)
      }
    }
  }
  try { push(await ctx.jobs.list()) } catch { /* jobs service unavailable */ }
  for (const agent of ctx.agents.list()) {
    try { push(await ctx.jobs.list(agent.id)) } catch { /* agent session gone */ }
  }
  out.checked = true
  const now = Date.now()
  for (const job of views) {
    if (job.status !== 'running' && job.status !== 'stopping') continue
    const startedAt = new Date(job.startedAt).getTime()
    if (Number.isNaN(startedAt)) continue
    const ageMs = now - startedAt
    if (ageMs > cfg.stuckJobs.killMs) {
      const issue = {
        severity: 'error',
        kind: 'stuck',
        title: `Background job "${job.label ?? job.id}" looks stuck`,
        detail: `running for ${Math.round(ageMs / 60000)} min (threshold ${Math.round(cfg.stuckJobs.killMs / 60000)} min)`,
        jobId: job.id,
        fixed: false,
      }
      if (!cfg.stuckJobs.autoKill) {
        issue.unfixableReason =
          'stuckJobs.autoKill is off in the plugin config: killing a background job can discard in-progress work. Kill it manually, or enable autoKill in the plugin config.'
      } else if (!fix) {
        issue.unfixableReason = 'stuckJobs.autoKill is on but this call did not pass fix: true; re-run with fix: true to kill it.'
      } else {
        try {
          const result = await ctx.jobs.kill(job.id, job.owner ?? undefined, 'capability-safety-guard: exceeded killMs')
          issue.fixed = result === 'requested' || result === 'already-finished'
          issue.detail += ` — kill result: ${result}`
        } catch (error) {
          issue.unfixableReason = `jobs.kill threw: ${truncate(String(error?.message ?? error))}`
        }
      }
      out.issues.push(issue)
    } else if (ageMs > cfg.stuckJobs.warnMs) {
      out.issues.push({
        severity: 'warn',
        kind: 'stuck',
        title: `Background job "${job.label ?? job.id}" running long`,
        detail: `running for ${Math.round(ageMs / 60000)} min (warn threshold ${Math.round(cfg.stuckJobs.warnMs / 60000)} min)`,
        jobId: job.id,
        fixed: false,
      })
    }
  }
  return out
}

async function checkPlugins(ctx, cfg, state) {
  const out = { checked: false, issues: [] }
  if (!cfg.plugins.enabled) {
    out.note = 'Plugin-health check disabled in plugin config.'
    return out
  }
  const plugins = await ctx.pluginManager.listPlugins()
  out.checked = true
  for (const plugin of plugins) {
    if (plugin.fiberPhase === 'failed') {
      const issue = {
        severity: 'error',
        kind: 'plugin',
        title: `Plugin "${plugin.entryId ?? plugin.moduleName}" failed to activate`,
        detail: plugin.diagnostic ? truncate(plugin.diagnostic) : 'no diagnostic available',
        entryId: plugin.entryId,
        fixed: false,
      }
      if (plugin.readOnlyReason) {
        issue.unfixableReason = `plugin is read-only: ${plugin.readOnlyReason}`
      } else if (!cfg.plugins.autoDisableFailed) {
        issue.unfixableReason =
          'plugins.autoDisableFailed is off in the plugin config; disable the plugin manually in Settings → Plugins, or enable autoDisableFailed.'
      } else if (state.disabledByUs.has(plugin.entryId)) {
        issue.fixed = true
        issue.detail += ' (already auto-disabled)'
      } else {
        try {
          const result = await ctx.pluginManager.setPluginEnabled(plugin.entryId, false)
          if (result?.application === 'applied') {
            issue.fixed = true
            state.disabledByUs.add(plugin.entryId)
            state.stats.autoFixes += 1
            issue.detail += ' — auto-disabled to stop the failure loop.'
          } else if (result?.application === 'restart-required') {
            issue.fixed = true
            state.disabledByUs.add(plugin.entryId)
            state.stats.autoFixes += 1
            issue.detail += ' — auto-disable recorded; it takes effect after the next DSH restart.'
          } else {
            issue.unfixableReason = `setPluginEnabled did not apply: ${describeChangeResult(result)}`
          }
        } catch (error) {
          issue.unfixableReason = `setPluginEnabled threw: ${truncate(String(error?.message ?? error))}`
        }
      }
      out.issues.push(issue)
    } else if (plugin.fiberPhase === 'pending' && plugin.enabled) {
      out.issues.push({
        severity: 'warn',
        kind: 'plugin',
        title: `Plugin "${plugin.entryId ?? plugin.moduleName}" is still activating`,
        detail: 'fiberPhase pending; if it stays pending, a restart may be required.',
        entryId: plugin.entryId,
        fixed: false,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* install guard: version channels + core chain                        */
/* ------------------------------------------------------------------ */

const CORE_CHAIN_RE = /storage|workspace|session|domain|gateway/i

const PRERELEASE_RE = /(?:^|-)(alpha|beta|rc|pre|dev|nightly|canary|next)(?:[.0-9-]|$)/i

/** 'stable' or the prerelease channel name ('alpha', 'beta', 'rc', ...). */
export function channelOf(version) {
  const match = String(version).match(PRERELEASE_RE)
  return match ? match[1].toLowerCase() : 'stable'
}

async function readProfilePackageVersions() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return { profileDir: null, error: 'DSH_PROFILE_DIR is not set in this runtime; version-channel check skipped.' }
  let fsMod
  try {
    fsMod = await import('node:fs')
  } catch {
    return { profileDir, error: 'node:fs is unavailable in this runtime; version-channel check skipped.' }
  }
  const pathMod = await import('node:path')
  const join = pathMod.join
  const scope = join(profileDir, 'node_modules', '@deepseek-ai')
  let entries = []
  try {
    entries = fsMod.readdirSync(scope, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch (error) {
    return { profileDir, error: `cannot scan ${scope}: ${truncate(String(error?.code ?? error?.message ?? error))}` }
  }
  const packages = []
  for (const entry of entries) {
    try {
      const raw = fsMod.readFileSync(join(scope, entry.name, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw)
      packages.push({ name: pkg.name ?? `@deepseek-ai/${entry.name}`, version: String(pkg.version ?? '?') })
    } catch {
      /* skip unreadable package.json */
    }
  }
  return { profileDir, packages }
}

/**
 * Version/channel consistency check. This is the lesson from the forge
 * incident: the catalog said 0.2.2-rc.5, the directory was labeled rc.5,
 * but the RESOLVED package was 0.2.2-alpha.2 — and the mismatch only
 * surfaced at boot, when the runtime's compatibility precheck auto-disabled
 * dsh-storage-domain and the storage → workspace → session chain collapsed.
 * We therefore scan what is actually installed (profile node_modules), not
 * what install UI said, and flag prerelease channels and mixed channels.
 * Never auto-fixed: removing/realigning packages can break the profile, so
 * the model must explain and the user must act (pnpm prune, verify, then
 * restart).
 */
async function checkBundleVersions(ctx, cfg) {
  const out = { checked: false, issues: [] }
  if (!cfg.installGuard.enabled || !cfg.installGuard.flagPrerelease) {
    out.note = 'Version-channel check disabled in plugin config.'
    return out
  }
  const { profileDir, packages, error } = await readProfilePackageVersions()
  out.profileDir = profileDir
  if (error) {
    out.checked = true
    out.note = error
    return out
  }
  out.checked = true
  out.packages = packages.map((p) => `${p.name}@${p.version}`)
  const channels = [...new Set(packages.map((p) => channelOf(p.version)))]
  out.channels = channels
  const prerelease = packages.filter((p) => channelOf(p.version) !== 'stable')
  if (prerelease.length) {
    out.issues.push({
      severity: 'error',
      kind: 'version',
      title: 'Prerelease @deepseek-ai package(s) resolved in this profile',
      detail: `${prerelease.map((p) => `${p.name}@${p.version}`).join(', ')}. A prerelease can drag core plugins onto an incompatible channel; the mismatch may only surface at boot when core plugins get auto-disabled.`,
      fixed: false,
      unfixableReason:
        'not auto-fixed: aligning versions means installing/removing packages and can break the profile. Verify whether the prerelease is intended; if not, remove it with a package-manager prune (pnpm), keep the backup/quarantine copy until the profile opens cleanly, then restart.',
    })
  }
  if (channels.length > 1) {
    out.issues.push({
      severity: 'error',
      kind: 'version',
      title: 'Mixed release channels among installed @deepseek-ai packages',
      detail: `channels present: ${channels.join(', ')}. Mixed channels (e.g. rc runtime with alpha packages) matched the exact failure signature of a past full outage.`,
      fixed: false,
      unfixableReason:
        'not auto-fixed: realigning channels means installing/removing packages and can break the profile. Reinstall every @deepseek-ai package on the intended channel, then verify the profile still opens before deleting any quarantine/backup.',
    })
  }
  try {
    if (typeof ctx.pluginManager.listVersionExemptions === 'function') {
      const exemptions = await ctx.pluginManager.listVersionExemptions()
      const warnings = Array.isArray(exemptions?.warnings) ? exemptions.warnings : []
      for (const warning of warnings.slice(0, 5)) {
        out.issues.push({ severity: 'warn', kind: 'version', title: 'Version exemption warning', detail: truncate(String(warning)), fixed: false })
      }
    }
  } catch {
    /* optional host capability */
  }
  return out
}

/**
 * Core plugin chain health. A disabled or failed storage / workspace /
 * session / domain / gateway plugin breaks everything above it. Also flags
 * compatibility-flavoured diagnostics on those plugins while they are still
 * enabled (the pre-outage warning state). Never auto-fixed: toggling core
 * plugins can make the situation worse; the model must explain instead.
 */
async function checkCoreChain(ctx, cfg) {
  const out = { checked: false, issues: [] }
  if (!cfg.installGuard.enabled || !cfg.installGuard.warnCoreChainDisabled) {
    out.note = 'Core-chain check disabled in plugin config.'
    return out
  }
  const plugins = await ctx.pluginManager.listPlugins()
  out.checked = true
  for (const plugin of plugins) {
    const id = `${plugin.entryId ?? ''} ${plugin.moduleName ?? ''}`
    if (!CORE_CHAIN_RE.test(id)) continue
    const disabled = plugin.enabled === false
    const failed = plugin.fiberPhase === 'failed'
    const diagnostic = `${plugin.diagnostic ?? ''} ${plugin.readOnlyReason ?? ''}`
    const compatFlavour = /compatib|incompat|version/i.test(diagnostic)
    if (!disabled && !failed && !compatFlavour) continue
    const title = disabled || failed
      ? `Core plugin "${plugin.entryId ?? plugin.moduleName}" is ${failed ? 'failed to activate' : 'disabled'}`
      : `Core plugin "${plugin.entryId ?? plugin.moduleName}" carries a compatibility warning`
    // failed → error; disabled WITH a compat-flavoured diagnostic → error
    // (the forge-incident fingerprint); disabled with no diagnostic → info
    // (treated as an intentional user choice, never injected as an alert).
    const severity = failed ? 'error' : disabled ? (compatFlavour ? 'error' : 'info') : 'warn'
    const issue = {
      severity,
      kind: 'core',
      title,
      entryId: plugin.entryId,
      fixed: false,
    }
    if (severity === 'info') {
      issue.detail = `${diagnostic.trim() || 'no diagnostic'} — a core-chain plugin disabled with no diagnostic is treated as an intentional user choice, not a failure. If this was not your choice, re-enable it in Settings.`
    } else {
      issue.detail = `${diagnostic.trim() || 'no diagnostic'} — the storage → workspace → session chain depends on it; a broken core chain can make the app unable to open conversations.`
      issue.unfixableReason =
        'not auto-fixed: re-enabling or toggling core plugins can compound the failure. Check recent installs and version channels first, keep quarantines/backups until the fix is verified, and only then restart.'
    }
    out.issues.push(issue)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* system resources (RAM / disks / heavyweight processes)              */
/* ------------------------------------------------------------------ */

const SYSTEM_PS_SCRIPT =
  "$cpu=[math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average);" +
  "$os=Get-CimInstance Win32_OperatingSystem;" +
  "$ram=[PSCustomObject]@{totalMb=[math]::Round($os.TotalVisibleMemorySize/1024);freeMb=[math]::Round($os.FreePhysicalMemory/1024)};" +
  "$disks=@(Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | ForEach-Object {[PSCustomObject]@{name=$_.Name;freeGb=[math]::Round($_.Free/1GB,2);totalGb=[math]::Round(($_.Used+$_.Free)/1GB,2)}});" +
  "$procs=@(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12) | ForEach-Object {[PSCustomObject]@{name=$_.ProcessName;pid=$_.Id;wsMb=[math]::Round($_.WorkingSet64/1MB)}};" +
  "[PSCustomObject]@{cpu=$cpu;ram=$ram;disks=$disks;processes=$procs} | ConvertTo-Json -Depth 3 -Compress"

async function powerShellSystemSnapshot(ctx) {
  let exe = null
  for (const candidate of ['powershell', 'pwsh']) {
    try {
      exe = await ctx.subprocess.resolveExecutable(candidate)
      if (exe) break
    } catch {
      /* try next */
    }
  }
  if (!exe) return { error: 'neither powershell nor pwsh was found; system check skipped.' }
  const text = await runCapture(ctx, [exe, '-NoProfile', '-NonInteractive', '-Command', SYSTEM_PS_SCRIPT], 15000)
  try {
    return { snapshot: JSON.parse(text) }
  } catch {
    return { error: `PowerShell output was not valid JSON: ${truncate(text, 200)}` }
  }
}

function normalizeDriveName(name) {
  return String(name).replace(/:$/, '').toUpperCase()
}

/**
 * System resource check for software/program development sessions: RAM
 * pressure (running models/builds eats RAM and Windows starts thrashing the
 * pagefile), free space on the drives that hold the workspace/profile
 * (models, caches and build artifacts can silently fill a drive and break
 * everything that writes there), and heavyweight processes (a training job
 * or a runaway server that should have been cleaned up). One PowerShell
 * call per check. Report-only by default; processes may be force-killed
 * when the config allows it and the call passes fix: true.
 */
async function checkSystem(ctx, cfg, fix) {
  const out = { checked: false, issues: [] }
  if (!cfg.system?.enabled) {
    out.note = 'System check disabled in plugin config.'
    return out
  }
  let snapshot
  try {
    const result = await powerShellSystemSnapshot(ctx)
    if (result.error) {
      out.checked = true
      out.note = result.error
      return out
    }
    snapshot = result.snapshot
  } catch (error) {
    out.checked = true
    out.error = `PowerShell system snapshot failed: ${truncate(String(error?.message ?? error))}`
    return out
  }
  out.checked = true
  out.snapshot = snapshot

  // RAM pressure.
  const ram = snapshot?.ram
  if (ram && Number.isFinite(ram.totalMb) && Number.isFinite(ram.freeMb) && ram.totalMb > 0) {
    const usedPct = Math.round((100 * (ram.totalMb - ram.freeMb)) / ram.totalMb)
    const title = `System RAM high (${usedPct}%)`
    const detail = `${usedPct}% used (${ram.freeMb} MB free of ${ram.totalMb} MB), threshold ${cfg.system.ram.warnUsedPct}%`
    if (usedPct >= cfg.system.ram.criticalUsedPct) {
      out.issues.push({
        severity: 'error',
        kind: 'system',
        title,
        detail: `${detail} (critical ${cfg.system.ram.criticalUsedPct}%)`,
        fixed: false,
        unfixableReason:
          'not auto-fixed: RAM cannot be freed safely by this plugin. Close the heavyweight processes listed by this check (or wait for running jobs to finish), then re-run.',
      })
    } else if (usedPct >= cfg.system.ram.warnUsedPct) {
      out.issues.push({ severity: 'warn', kind: 'system', title, detail, fixed: false })
    }
  }

  // CPU load.
  const cpu = snapshot?.cpu
  if (Number.isFinite(cpu)) {
    const cpuPct = Math.round(cpu)
    if (cpuPct >= cfg.system.cpu.criticalUsedPct) {
      out.issues.push({
        severity: 'error',
        kind: 'system',
        title: `System CPU load critical (${cpuPct}%)`,
        detail: `${cpuPct}% average load (critical ${cfg.system.cpu.criticalUsedPct}%) — builds, model runs or runaway processes are starving the machine.`,
        fixed: false,
        unfixableReason:
          'not auto-fixed: CPU load is not safely freeable by killing processes blindly. Stop or reduce the heavy jobs (see the heavyweight-process list), then re-run.',
      })
    } else if (cpuPct >= cfg.system.cpu.warnUsedPct) {
      out.issues.push({
        severity: 'warn',
        kind: 'system',
        title: `System CPU load high (${cpuPct}%)`,
        detail: `${cpuPct}% average load (warn ${cfg.system.cpu.warnUsedPct}%)`,
        fixed: false,
      })
    }
  }

  // Free space on the drives that matter (workspace + profile live there).
  const wanted = new Set((cfg.system.disk.paths ?? []).map((p) => normalizeDriveName(p)))
  for (const disk of snapshot?.disks ?? []) {
    const name = normalizeDriveName(disk.name)
    if (!wanted.has(name)) continue
    if (!Number.isFinite(disk.freeGb) || !Number.isFinite(disk.totalGb) || disk.totalGb <= 0) continue
    const freePct = Math.round((100 * disk.freeGb) / disk.totalGb)
    const detail = `${freePct}% free (${disk.freeGb} GB of ${disk.totalGb} GB) on ${name}:, warn threshold ${cfg.system.disk.warnFreePct}%`
    if (freePct <= cfg.system.disk.criticalFreePct) {
      out.issues.push({
        severity: 'error',
        kind: 'system',
        title: `Drive ${name}: critically low on space`,
        detail: `${detail} (critical ${cfg.system.disk.criticalFreePct}%). Models, caches and build artifacts can silently fill a drive and break everything that writes there.`,
        fixed: false,
        unfixableReason:
          'not auto-fixed: files are never deleted by this plugin. Clean temp/cache/build directories (and remember: keep quarantines and backups until fixes are verified).',
      })
    } else if (freePct <= cfg.system.disk.warnFreePct) {
      out.issues.push({ severity: 'warn', kind: 'system', title: `Drive ${name}: low on space`, detail, fixed: false })
    }
  }

  // Heavyweight processes.
  const allowed = new Set((cfg.system.processes.allowedNames ?? []).map((n) => String(n).toLowerCase()))
  for (const proc of snapshot?.processes ?? []) {
    if (!Number.isFinite(proc.wsMb)) continue
    const procName = String(proc.name ?? '?')
    if (allowed.has(procName.toLowerCase())) continue
    const detail = `${procName} (pid ${proc.pid}) working set ${proc.wsMb} MB`
    if (proc.wsMb >= cfg.system.processes.criticalWorkingSetMb) {
      const issue = {
        severity: 'error',
        kind: 'system',
        title: `Heavyweight process: ${procName}`,
        detail: `${detail} (critical ${cfg.system.processes.criticalWorkingSetMb} MB). A runaway server, training job or leaked worker can starve the machine.`,
        pid: proc.pid,
        fixed: false,
      }
      if (!cfg.system.processes.autoKill) {
        issue.unfixableReason =
          'system.processes.autoKill is off in the plugin config: force-killing a process destroys its work. Close it yourself, or enable autoKill in the plugin config.'
      } else if (!fix) {
        issue.unfixableReason = 'system.processes.autoKill is on but this call did not pass fix: true; re-run with fix: true to force-kill it.'
      } else {
        try {
          const exe = await ctx.subprocess.resolveExecutable('powershell')
          await runCapture(ctx, [exe, '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${Number(proc.pid)} -Force`], 15000)
          issue.fixed = true
          issue.detail += ' — force-killed.'
        } catch (error) {
          issue.unfixableReason = `Stop-Process failed: ${truncate(String(error?.message ?? error))}`
        }
      }
      out.issues.push(issue)
    } else if (proc.wsMb >= cfg.system.processes.warnWorkingSetMb) {
      out.issues.push({
        severity: 'warn',
        kind: 'system',
        title: `Heavy process: ${procName}`,
        detail: `${detail} (warn ${cfg.system.processes.warnWorkingSetMb} MB)`,
        pid: proc.pid,
        fixed: false,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* tool-error fingerprint watch                                        */
/* ------------------------------------------------------------------ */

const ERROR_FINGERPRINTS = [
  { key: 'oom', label: 'out-of-memory', re: /out of memory|cuda out|torch\.cuda\.outofmemory|killed|memoryerror/i },
  { key: 'port', label: 'port conflict', re: /eaddrinuse|address already in use|port \d+ (?:is already )?in use|port \d+ was already|端口.*已被占用|已被占用/i },
  { key: 'disk', label: 'disk full', re: /no space left|enospc|not enough space|磁盘空间不足|there is not enough space/i },
  { key: 'perm', label: 'permission denied', re: /access is denied|eacces|eperm|permission denied|拒绝访问/i },
  { key: 'dep', label: 'missing dependency', re: /modulenotfounderror|no module named|cannot find module|importerror/i },
]

const FINGERPRINT_GUIDANCE = {
  oom: 'free GPU/RAM first: stop heavy jobs or lower the batch/size, then retry.',
  port: 'the port is taken: pick another port, or find the process holding it (netstat -ano) and stop it.',
  disk: 'the drive is full: free space before continuing; never delete quarantines or backups to make room.',
  perm: 'the process lacks permission for that path/resource: fix the ACL or run with the right account.',
  dep: 'a module is missing: install it into the project venv / project node_modules, never into the DSH profile or runtime.',
}

/** Extract a fingerprint from one tools/result execution. Null when benign. */
export function extractToolError(execName, result) {
  if (execName === 'capability_safety_check') return null
  let text = ''
  try {
    if (typeof result === 'string') text = result
    else if (result !== null && result !== undefined) text = JSON.stringify(result)
  } catch {
    /* unstringifiable */
  }
  if (!text) return null
  const bounded = text.slice(0, 4000)
  // A run counts as failed only on structured failure signals. Matching
  // fingerprints against the text of a SUCCESSFUL run causes false alarms:
  // a read tool returning text that merely contains "out of memory" (like
  // this very source file) is not an OOM incident. Observed live on
  // 2026-11-23: two false OOM alerts from ops_inspect_local_file reads.
  const failed = isRecord(result)
    ? (Number.isFinite(result.exitCode) && result.exitCode !== 0) ||
      result.isError === true ||
      result.ok === false ||
      /^(error|failed|rejected)$/i.test(String(result.status ?? ''))
    : true
  if (!failed) return null
  let fingerprint = null
  for (const entry of ERROR_FINGERPRINTS) {
    if (entry.re.test(bounded)) {
      fingerprint = entry
      break
    }
  }
  return {
    at: new Date().toISOString(),
    tool: String(execName ?? 'unknown'),
    fingerprint: fingerprint?.key ?? null,
    label: fingerprint?.label ?? 'failed execution',
    snippet: truncate(bounded.replace(/\s+/g, ' '), 240),
  }
}

/**
 * Surface recent tool errors. The agent sees most command failures itself,
 * but error fingerprints across different tools (CUDA OOM in one command,
 * EADDRINUSE in another, disk-full elsewhere) reveal patterns a single
 * command result hides — and these are exactly the "totally unexpected"
 * problems the user wants caught. Critical fingerprints also notify the
 * live agents the moment they occur (via the tools/result listener).
 */
async function checkErrors(ctx, cfg, state) {
  const out = { checked: false, issues: [] }
  if (!cfg.errors?.enabled) {
    out.note = 'Tool-error check disabled in plugin config.'
    return out
  }
  out.checked = true
  const recent = state.recentToolErrors ?? []
  out.recent = recent.slice(-5).map((e) => `${e.at} ${e.tool}: ${e.label} — ${e.snippet}`)
  const windowMs = 15 * 60 * 1000
  const now = Date.now()
  for (const entry of recent) {
    if (!entry.fingerprint) continue
    const at = new Date(entry.at).getTime()
    if (Number.isNaN(at) || now - at > windowMs) continue
    out.issues.push({
      severity: 'error',
      kind: 'errors',
      title: `Recent tool error: ${entry.label}`,
      detail: `${entry.tool} failed with a ${entry.label} signature: ${entry.snippet}`,
      fixed: false,
      unfixableReason: `not auto-fixed: ${FINGERPRINT_GUIDANCE[entry.fingerprint] ?? 'inspect the failing command and retry.'}`,
    })
  }
  // Failure loops: the same tool failing with the same fingerprint
  // repeatedly is a loop, not a single error (e.g. an infinite retry on a
  // taken port or a broken dependency).
  const loopThreshold = Math.max(2, Number(cfg.errors.loopThreshold) || 3)
  const loopCounts = new Map()
  for (const entry of recent) {
    if (!entry.fingerprint) continue
    const at = new Date(entry.at).getTime()
    if (Number.isNaN(at) || now - at > windowMs) continue
    const key = `${entry.tool}|${entry.fingerprint}`
    loopCounts.set(key, (loopCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of loopCounts) {
    if (count < loopThreshold) continue
    const sep = key.indexOf('|')
    const tool = key.slice(0, sep)
    const fpKey = key.slice(sep + 1)
    const label = ERROR_FINGERPRINTS.find((f) => f.key === fpKey)?.label ?? fpKey
    out.issues.push({
      severity: 'error',
      kind: 'errors',
      title: `Failure loop: ${tool} keeps failing with ${label}`,
      detail: `${count} identical failures in the last 15 min — a retry loop or a broken dependency, not a one-off error.`,
      fixed: false,
      unfixableReason: `not auto-fixed: ${FINGERPRINT_GUIDANCE[fpKey] ?? 'inspect the failing command and break the loop.'}`,
    })
  }
  return out
}



/**
 * Guardian self-health: how long the plugin has been up, how many monitor
 * ticks / change events / alerts / auto-fixes it has handled, and whether
 * GPU sampling works. The checker checks itself.
 */
function checkSelf(ctx, cfg, state) {
  const out = { checked: false, issues: [] }
  if (!cfg.self?.enabled) {
    out.note = 'Self-health report disabled in plugin config.'
    return out
  }
  out.checked = true
  const stats = state.stats
  out.stats = {
    startedAt: new Date(stats.startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    ticks: stats.ticks,
    eventsSeen: stats.eventsSeen,
    alertsSent: stats.alertsSent,
    autoFixes: stats.autoFixes,
    gpuSnapshotsOk: stats.gpuSnapshotsOk,
    gpuSnapshotsFail: stats.gpuSnapshotsFail,
    injectBlocked: stats.injectBlocked,
    monitorArmed: stats.monitorArmed,
    trialsActive: state.trials.size,
  }
  if (stats.gpuSnapshotsOk === 0 && stats.gpuSnapshotsFail >= 3) {
    out.issues.push({
      severity: 'warn',
      kind: 'self',
      title: 'Guardian GPU sampling keeps failing',
      detail: `${stats.gpuSnapshotsFail} snapshot attempt(s) failed and none succeeded — nvidia-smi may be broken or unreachable; investigate manually.`,
      fixed: false,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* safe trial sandbox (try-before-commit)                              */
/* ------------------------------------------------------------------ */
/* The user's rule: before anything new is installed or newly written  */
/* software is used for real, run it a few times inside an isolated    */
/* sandbox first, analyze what breaks, report to the user, let the     */
/* user decide the fixes, apply only the approved fixes, and export    */
/* the verified product. Isolation level here = filesystem +           */
/* environment + process (separate dir, venv/project-local installs,   */
/* cleaned env, per-step timeouts); the GPU and OS kernel are shared,  */
/* which the tool description states explicitly. Trial metadata lives  */
/* in plugin memory only (lost on app restart); sandbox dirs persist   */
/* on disk until cleanup.                                              */
/* ------------------------------------------------------------------ */

let _fsCache = null
async function getFs() {
  if (_fsCache) return _fsCache
  _fsCache = await import('node:fs')
  return _fsCache
}
let _pathCache = null
async function getPath() {
  if (_pathCache) return _pathCache
  _pathCache = await import('node:path')
  return _pathCache
}

/** Split a command line on whitespace, honoring single/double quotes. */
function splitCommandLine(input) {
  const args = []
  let cur = ''
  let quote = null
  for (const ch of String(input ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur) { args.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur) args.push(cur)
  return args
}

/** Trial ids: short safe identifiers, or a generated timestamp id. */
function trialIdOf(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw) ? raw : null
}

/** True when `child` equals or lies below `parent` (both absolute). */
function isInside(child, parent) {
  const path = _pathCache
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveTrialRoots(cfg) {
  const path = _pathCache
  const tmp = process.env.TEMP || process.env.TMP || path.join('C:', 'Windows', 'Temp')
  const sandboxRoot = path.resolve(cfg.trial?.sandboxRoot || path.join(tmp, 'dsh-trial-sandbox'))
  const exportsRoot = path.resolve(cfg.trial?.exportsRoot || path.join(tmp, 'dsh-trial-output'))
  return { sandboxRoot, exportsRoot }
}

/** Isolated environment for every sandbox run: private HOME/TEMP/caches. */
function trialEnv(trialDir) {
  const env = { ...process.env }
  env.HOME = `${trialDir}/home`
  env.USERPROFILE = `${trialDir}/home`
  env.TEMP = `${trialDir}/tmp`
  env.TMP = `${trialDir}/tmp`
  env.PYTHONNOUSERSITE = '1'
  delete env.PYTHONPATH
  env.PIP_CACHE_DIR = `${trialDir}/pip-cache`
  env.NPM_CONFIG_CACHE = `${trialDir}/npm-cache`
  env.NO_COLOR = '1'
  return env
}

/** Spawn one sandbox command; always resolves with exit code + tails. */
function runTrialCommand(ctx, argv, opts) {
  const { cwd, env, timeoutMs } = opts
  return new Promise((resolve) => {
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd,
        env,
        graceMs: 3000,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: String(error?.message ?? error) })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { handle.terminate() } catch { /* already gone */ }
      resolve({ exitCode: null, stdout: readCollected(handle.collected?.stdout), stderr: readCollected(handle.collected?.stderr), timedOut: true })
    }, timeoutMs)
    handle.done.then(
      ({ exitCode }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode, stdout: readCollected(handle.collected?.stdout), stderr: readCollected(handle.collected?.stderr), timedOut: false })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode: null, stdout: readCollected(handle.collected?.stdout), stderr: readCollected(handle.collected?.stderr), timedOut: false, runError: String(error?.message ?? error) })
      },
    )
  })
}

async function queryGpuUsedMiB(ctx) {
  const exe = await ctx.subprocess.resolveExecutable('nvidia-smi')
  const text = await runCapture(ctx, [exe, '--query-gpu=memory.used', '--format=csv,noheader,nounits'], 8000)
  const value = Number(String(text).trim().split(/\s+/)[0])
  return Number.isFinite(value) ? value : null
}

async function trialCreate(ctx, cfg, state, args) {
  const out = { ok: false }
  if (cfg.trial?.enabled === false) {
    out.error = 'Trial sandbox disabled in plugin config (trial.enabled: false).'
    return out
  }
  const fs = await getFs()
  const path = await getPath()
  const spec = args.spec || {}
  if (!spec.runCmd || !String(spec.runCmd).trim()) {
    out.error = 'spec.runCmd is required: the command line to execute.'
    return out
  }
  const id = trialIdOf(args.trialId) || `trial-${Date.now().toString(36)}`
  if (state.trials.has(id)) {
    out.error = `trial "${id}" already exists; use a different trialId or action "cleanup" first.`
    return out
  }
  const { sandboxRoot } = resolveTrialRoots(cfg)
  const trialDir = path.resolve(sandboxRoot, id)
  const profileDir = process.env.DSH_PROFILE_DIR ? path.resolve(process.env.DSH_PROFILE_DIR) : null
  const installDir = process.env.DSH_INSTALL_DIR ? path.resolve(process.env.DSH_INSTALL_DIR) : null
  const sourceDir = spec.sourceDir ? path.resolve(String(spec.sourceDir)) : null
  if (sourceDir && (sourceDir === trialDir || isInside(trialDir, sourceDir))) {
    out.error = 'spec.sourceDir must not contain the sandbox itself.'
    return out
  }
  if (sourceDir && profileDir && (sourceDir === profileDir || isInside(sourceDir, profileDir))) {
    out.error = 'spec.sourceDir is inside the DSH profile — the profile itself must never be trialed.'
    return out
  }
  if (sourceDir && installDir && (sourceDir === installDir || isInside(sourceDir, installDir))) {
    out.error = 'spec.sourceDir is inside the DSH install directory — the app itself must never be trialed.'
    return out
  }
  try {
    fs.mkdirSync(trialDir, { recursive: true })
  } catch (error) {
    out.error = `cannot create sandbox dir: ${error.message}`
    return out
  }
  for (const sub of ['home', 'tmp', 'pip-cache', 'npm-cache']) {
    try { fs.mkdirSync(path.join(trialDir, sub), { recursive: true }) } catch { /* best effort */ }
  }
  const copied = []
  if (sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      out.error = `spec.sourceDir does not exist: ${sourceDir}`
      return out
    }
    try {
      fs.cpSync(sourceDir, path.join(trialDir, 'src'), { recursive: true })
      copied.push('src')
    } catch (error) {
      out.error = `cannot copy sourceDir into the sandbox: ${error.message}`
      return out
    }
  }
  const env = trialEnv(trialDir)
  let venvNote = null
  let python = 'python'
  if (spec.lang === 'python') {
    const venvDir = path.join(trialDir, 'venv')
    const res = await runTrialCommand(ctx, ['python', '-m', 'venv', venvDir], { cwd: trialDir, env, timeoutMs: 120000 })
    const venvPython = path.join(venvDir, 'Scripts', 'python.exe')
    if (res.exitCode === 0 && fs.existsSync(venvPython)) {
      python = venvPython
      env.PATH = `${path.join(venvDir, 'Scripts')};${process.env.PATH ?? ''}`
      venvNote = 'venv created; python/pip resolve to the sandbox venv.'
    } else {
      venvNote = `venv creation failed (${truncate(res.stderr || res.spawnError || 'unknown', 160)}); using system python with PYTHONNOUSERSITE=1 and a sandbox PYTHONPATH.`
      env.PYTHONPATH = path.join(trialDir, 'site-packages')
      try { fs.mkdirSync(env.PYTHONPATH, { recursive: true }) } catch { /* best effort */ }
    }
  }
  const runs = Number(spec.runs) > 0 ? Math.min(Math.floor(Number(spec.runs)), 10) : Number(cfg.trial?.defaultRuns ?? 3)
  const timeoutSec = Number(spec.timeoutSec) > 0 ? Number(spec.timeoutSec) : Number(cfg.trial?.runTimeoutSec ?? 180)
  const trial = {
    id,
    dir: trialDir,
    createdAt: new Date().toISOString(),
    spec: { ...spec, runs: Number.isFinite(runs) && runs > 0 ? runs : 3, timeoutSec: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 180, watchGpu: spec.watchGpu === true },
    env,
    python,
    venvNote,
    copied,
    steps: [],
    issues: [],
    proposedFixes: [],
    status: 'created',
    exportedTo: null,
  }
  state.trials.set(id, trial)
  out.ok = true
  out.trialId = id
  out.dir = trialDir
  out.status = 'created'
  out.note = venvNote ?? 'Sandbox created; next: action "run" to install and execute, then "analyze".'
  return out
}

async function trialRun(ctx, cfg, state, args) {
  const out = { ok: false }
  const trial = state.trials.get(String(args.trialId ?? ''))
  if (!trial) {
    out.error = `unknown trialId "${args.trialId}"`
    return out
  }
  const stepStart = trial.steps.length
  const timeoutMs = trial.spec.timeoutSec * 1000
  const installTimeoutMs = Number(cfg.trial?.installTimeoutSec ?? 600) * 1000
  const cwd = trial.spec.sourceDir ? `${trial.dir}/src` : trial.dir
  let gpuBefore = null
  if (trial.spec.watchGpu) {
    try { gpuBefore = await queryGpuUsedMiB(ctx) } catch { /* no nvidia-smi */ }
  }
  if (trial.spec.installCmd) {
    const argv = splitCommandLine(trial.spec.installCmd)
    const started = Date.now()
    const res = await runTrialCommand(ctx, argv, { cwd, env: trial.env, timeoutMs: installTimeoutMs })
    trial.steps.push({ at: new Date().toISOString(), kind: 'install', argv: truncate(trial.spec.installCmd, 200), exitCode: res.exitCode, timedOut: res.timedOut, durationMs: Date.now() - started, stdoutTail: truncate(res.stdout, 2000), stderrTail: truncate(res.stderr, 2000), spawnError: res.spawnError ?? null })
  }
  const runCmd = String(trial.spec.runCmd ?? '')
  const runArgv = splitCommandLine(runCmd)
  for (let i = 0; i < trial.spec.runs; i++) {
    const started = Date.now()
    const res = await runTrialCommand(ctx, runArgv, { cwd, env: trial.env, timeoutMs })
    trial.steps.push({ at: new Date().toISOString(), kind: 'run', runIndex: i + 1, argv: truncate(runCmd, 200), exitCode: res.exitCode, timedOut: res.timedOut, durationMs: Date.now() - started, stdoutTail: truncate(res.stdout, 2000), stderrTail: truncate(res.stderr, 2000), spawnError: res.spawnError ?? null })
  }
  trial.status = 'ran'
  const runs = trial.steps.slice(stepStart).filter((s) => s.kind === 'run')
  out.ok = true
  out.trialId = trial.id
  out.status = trial.status
  out.passCount = runs.filter((s) => s.exitCode === 0 && !s.timedOut).length
  out.failCount = runs.length - out.passCount
  out.steps = trial.steps.slice(stepStart).map(stepSummary)
  out.gpuBeforeMiB = gpuBefore
  if (trial.spec.watchGpu) {
    try { out.gpuAfterMiB = await queryGpuUsedMiB(ctx) } catch { /* no nvidia-smi */ }
  }
  return out
}

function stepSummary(step) {
  const tail = step.stderrTail ? step.stderrTail.slice(0, 600) : (step.stdoutTail ?? '').slice(0, 600)
  return { at: step.at, kind: step.kind, runIndex: step.runIndex ?? null, exitCode: step.exitCode, timedOut: step.timedOut === true, durationMs: step.durationMs, spawnError: step.spawnError ?? null, tail }
}

async function trialAnalyze(ctx, cfg, state, args) {
  const out = { ok: false }
  const trial = state.trials.get(String(args.trialId ?? ''))
  if (!trial) {
    out.error = `unknown trialId "${args.trialId}"`
    return out
  }
  // Analyze only the current attempt: runs after the most recent fix step.
  // Earlier failures were already reported and fixed; keeping them would
  // make the trial look permanently broken.
  let since = 0
  for (let i = trial.steps.length - 1; i >= 0; i--) {
    if (trial.steps[i].kind === 'fix-run' || trial.steps[i].kind === 'fix-file') { since = i + 1; break }
  }
  const runs = trial.steps.slice(since).filter((s) => s.kind === 'run')
  if (!runs.length) {
    out.error = 'no runs recorded yet; call action "run" first.'
    return out
  }
  const runText = (run) => `${run.stdoutTail ?? ''}\n${run.stderrTail ?? ''}`
  const failed = runs.filter((s) => s.exitCode !== 0 || s.timedOut)
  const passed = runs.length - failed.length
  const issues = []
  const seen = new Set()
  for (const run of failed) {
    const text = runText(run)
    let fp = null
    for (const entry of ERROR_FINGERPRINTS) {
      if (entry.re.test(text)) { fp = entry; break }
    }
    if (fp && !seen.has(fp.key)) {
      seen.add(fp.key)
      const count = failed.filter((r) => fp.re.test(runText(r))).length
      issues.push({
        severity: 'error',
        kind: 'trial',
        fingerprint: fp.key,
        title: `Trial failure: ${fp.label}`,
        detail: `${count} of ${failed.length} failed run(s) carry this signature (${passed}/${runs.length} runs passed).`,
        evidence: truncate((run.stderrTail || run.stdoutTail || '').replace(/\s+/g, ' '), 240),
        unfixableReason: FINGERPRINT_GUIDANCE[fp.key] ?? 'inspect the failing run output and fix accordingly.',
      })
    }
  }
  for (const run of failed) {
    const text = runText(run)
    if (!ERROR_FINGERPRINTS.some((entry) => entry.re.test(text))) {
      issues.push({
        severity: 'error',
        kind: 'trial',
        title: 'Trial run failed',
        detail: `exit code ${run.exitCode ?? 'timeout'} with no known fingerprint (${passed}/${runs.length} runs passed).`,
        evidence: truncate((run.stderrTail || run.stdoutTail || '').replace(/\s+/g, ' '), 240),
        unfixableReason: 'inspect the full output, fix the cause, then re-run.',
      })
      break
    }
  }
  if (passed > 0 && failed.length > 0) {
    issues.push({
      severity: 'warn',
      kind: 'trial',
      title: 'Flaky trial runs',
      detail: `${passed} run(s) passed but ${failed.length} failed — the failure may be intermittent (ports, timing, races).`,
      fixed: false,
    })
  }
  trial.issues = issues
  trial.proposedFixes = buildProposedFixes(trial, failed)
  trial.status = 'analyzed'
  out.ok = true
  out.trialId = trial.id
  out.status = 'analyzed'
  out.passCount = passed
  out.failCount = failed.length
  out.issues = issues
  out.proposedFixes = trial.proposedFixes
  out.note = issues.length
    ? 'Report the issues and proposed fixes to the USER and let the user decide which fixes to apply (action "fix"), then "run" and "analyze" again until clean.'
    : 'All runs passed — no problems found. You may export the verified product with action "export".'
  return out
}

function buildProposedFixes(trial, failed) {
  const fixes = []
  for (const run of failed) {
    const text = `${run.stdoutTail ?? ''}\n${run.stderrTail ?? ''}`
    for (const entry of ERROR_FINGERPRINTS) {
      if (!entry.re.test(text)) continue
      if (entry.key === 'dep') {
        const m =
          text.match(/no module named '([^']+)'/i) ||
          text.match(/cannot find module '([^']+)'/i) ||
          text.match(/no module named ([\w.]+)/i) ||
          text.match(/cannot find module '?([\w@./-]+)'?/i)
        const pip = `${trial.python || 'python'} -m pip install ${m ? m[1] : '<module-name>'}`
        fixes.push({ type: 'run', label: `install the missing module "${m ? m[1] : '?'}" into the sandbox`, cmd: pip })
      } else if (entry.key === 'port') {
        fixes.push({ type: 'note', label: 'port conflict', text: FINGERPRINT_GUIDANCE.port })
      } else {
        fixes.push({ type: 'note', label: entry.label, text: FINGERPRINT_GUIDANCE[entry.key] ?? 'inspect the failing run output and adjust.' })
      }
    }
  }
  const seenFix = new Set()
  const unique = []
  for (const fix of fixes) {
    const key = JSON.stringify(fix)
    if (!seenFix.has(key)) { seenFix.add(key); unique.push(fix) }
  }
  return unique.slice(0, 6)
}

async function trialFix(ctx, cfg, state, args) {
  const out = { ok: false }
  const trial = state.trials.get(String(args.trialId ?? ''))
  if (!trial) {
    out.error = `unknown trialId "${args.trialId}"`
    return out
  }
  const fixes = Array.isArray(args.fixes) ? args.fixes : []
  if (!fixes.length) {
    out.error = 'fixes is required: only the fixes the USER approved, e.g. [{type:"run",cmd:"..."}] or [{type:"file",path:"src/a.py",content:"..."}].'
    return out
  }
  const fs = await getFs()
  const path = await getPath()
  const applied = []
  for (const fix of fixes) {
    try {
      if (fix.type === 'run') {
        const cmd = String(fix.cmd ?? '').trim()
        if (!cmd) throw new Error('run fix missing cmd')
        const argv = splitCommandLine(cmd)
        const cwd = trial.spec.sourceDir ? `${trial.dir}/src` : trial.dir
        const started = Date.now()
        const res = await runTrialCommand(ctx, argv, { cwd, env: trial.env, timeoutMs: trial.spec.timeoutSec * 1000 })
        trial.steps.push({ at: new Date().toISOString(), kind: 'fix-run', argv: truncate(cmd, 200), exitCode: res.exitCode, timedOut: res.timedOut, durationMs: Date.now() - started, stdoutTail: truncate(res.stdout, 2000), stderrTail: truncate(res.stderr, 2000), spawnError: res.spawnError ?? null })
        applied.push({ type: 'run', cmd, exitCode: res.exitCode, timedOut: res.timedOut === true })
      } else if (fix.type === 'file') {
        const rel = String(fix.path ?? '').replace(/^[/\\]+/, '')
        if (!rel) throw new Error('file fix missing path')
        // File fixes are relative to the PRODUCT the program actually runs
        // in: src/ for source-dir trials (the run cwd), the trial root
        // otherwise — and must stay inside that product dir.
        const base = trial.spec.sourceDir ? `${trial.dir}/src` : trial.dir
        const abs = path.resolve(base, rel)
        if (!isInside(abs, base)) throw new Error(`file fix path escapes the product directory: ${rel}`)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, String(fix.content ?? ''), 'utf8')
        trial.steps.push({ at: new Date().toISOString(), kind: 'fix-file', argv: truncate(`write ${rel}`, 200), exitCode: 0, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', spawnError: null })
        applied.push({ type: 'file', path: rel, bytes: String(fix.content ?? '').length })
      } else if (fix.type === 'note') {
        applied.push({ type: 'note', label: String(fix.label ?? fix.text ?? 'note') })
      } else {
        throw new Error(`unknown fix type "${fix.type}" (use run, file, or note)`)
      }
    } catch (error) {
      applied.push({ type: fix?.type ?? 'unknown', error: String(error?.message ?? error) })
    }
  }
  trial.status = 'fixed'
  out.ok = applied.some((a) => !a.error)
  out.trialId = trial.id
  out.status = trial.status
  out.applied = applied
  if (applied.some((a) => a.error)) out.note = 'Some fixes failed — review "applied", fix the plan, then "run" and "analyze" again.'
  return out
}

async function trialExport(ctx, cfg, state, args) {
  const out = { ok: false }
  const trial = state.trials.get(String(args.trialId ?? ''))
  if (!trial) {
    out.error = `unknown trialId "${args.trialId}"`
    return out
  }
  const fs = await getFs()
  const path = await getPath()
  const { sandboxRoot, exportsRoot } = resolveTrialRoots(cfg)
  const name = trialIdOf(trial.spec.name ?? '') || trial.id
  const destRaw = String(args.outputDir ?? '').trim() ? path.resolve(String(args.outputDir)) : path.resolve(exportsRoot, name)
  if (isInside(destRaw, path.resolve(sandboxRoot))) {
    out.error = 'outputDir must be OUTSIDE the sandbox — export the product to a real directory (e.g. the workspace).'
    return out
  }
  if (destRaw === trial.dir || isInside(trial.dir, destRaw)) {
    out.error = 'outputDir must not contain the sandbox itself.'
    return out
  }
  if (fs.existsSync(destRaw) && fs.readdirSync(destRaw).length > 0 && args.overwrite !== true) {
    out.error = `outputDir already exists and is not empty: ${destRaw} — pass overwrite: true to replace it.`
    return out
  }
  const src = trial.spec.sourceDir ? path.join(trial.dir, 'src') : trial.dir
  if (!fs.existsSync(src)) {
    out.error = 'nothing to export (the sandbox has no content yet).'
    return out
  }
  const EXCLUDE = new Set(['venv', 'home', 'tmp', 'pip-cache', 'npm-cache'])
  try {
    fs.rmSync(destRaw, { recursive: true, force: true })
    fs.mkdirSync(destRaw, { recursive: true })
    if (trial.spec.sourceDir) {
      fs.cpSync(src, destRaw, { recursive: true })
    } else {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (EXCLUDE.has(entry.name)) continue
        fs.cpSync(path.join(src, entry.name), path.join(destRaw, entry.name), { recursive: true })
      }
    }
  } catch (error) {
    out.error = `export failed: ${error.message}`
    return out
  }
  trial.exportedTo = destRaw
  trial.status = 'exported'
  out.ok = true
  out.trialId = trial.id
  out.exportedTo = destRaw
  out.status = 'exported'
  out.note = 'The verified product is now at the exported path — present it to the user as the final artifact.'
  return out
}

function trialView(trial) {
  const runs = trial.steps.filter((s) => s.kind === 'run')
  return {
    trialId: trial.id,
    status: trial.status,
    createdAt: trial.createdAt,
    dir: trial.dir,
    exportedTo: trial.exportedTo,
    runs: runs.length,
    failures: runs.filter((s) => s.exitCode !== 0 || s.timedOut).length,
    issues: (trial.issues ?? []).length,
    steps: trial.steps.length,
  }
}

function trialStatus(state, args) {
  const out = { ok: true }
  const id = String(args.trialId ?? '').trim()
  if (id) {
    const trial = state.trials.get(id)
    if (!trial) {
      out.ok = false
      out.error = `unknown trialId "${id}"`
      return out
    }
    out.trials = [trialView(trial)]
  } else {
    out.trials = [...state.trials.values()].map(trialView)
  }
  out.note = 'Trial state lives in plugin memory and is lost when the app restarts. Sandbox directories on disk can be re-inspected or removed with action "cleanup".'
  return out
}

async function trialCleanup(state, args) {
  const out = { ok: false }
  const id = String(args.trialId ?? '').trim()
  const trial = state.trials.get(id)
  if (!trial) {
    out.error = `unknown trialId "${id}"`
    return out
  }
  const fs = await getFs()
  try {
    fs.rmSync(trial.dir, { recursive: true, force: true })
  } catch (error) {
    out.error = `cannot remove sandbox dir: ${error.message}`
    return out
  }
  state.trials.delete(id)
  out.ok = true
  out.trialId = id
  out.removed = trial.dir
  out.note = 'Sandbox removed. If the product was exported, the exported copy is untouched.'
  return out
}

async function safeTrialRun(ctx, cfg, state, args) {
  const action = String(args?.action ?? '').trim()
  switch (action) {
    case 'create': return trialCreate(ctx, cfg, state, args)
    case 'run': return trialRun(ctx, cfg, state, args)
    case 'analyze': return trialAnalyze(ctx, cfg, state, args)
    case 'fix': return trialFix(ctx, cfg, state, args)
    case 'export': return trialExport(ctx, cfg, state, args)
    case 'status': return trialStatus(state, args)
    case 'cleanup': return trialCleanup(state, args)
    default: return { ok: false, error: `unknown action "${action}" — use create / run / analyze / fix / export / status / cleanup.` }
  }
}

function renderTrial(value) {
  if (!value || typeof value !== 'object') return 'Trial finished.'
  if (value.error) return `safe_trial_run failed: ${value.error}`
  const lines = []
  if (value.note) lines.push(value.note)
  if (value.trialId) lines.push(`Trial: ${value.trialId} [${value.status}]${value.dir ? ' @ ' + value.dir : ''}`)
  if (value.exportedTo) lines.push(`Exported to: ${value.exportedTo}`)
  if (value.passCount != null && !(value.issues?.length)) lines.push(`${value.passCount} run(s) passed, ${value.failCount} failed.`)
  if (Array.isArray(value.issues) && value.issues.length) {
    for (const issue of value.issues) {
      lines.push(`- [${issue.severity}] ${issue.title}: ${issue.detail ?? ''}${issue.evidence ? ' — ' + issue.evidence : ''}`)
    }
  }
  if (Array.isArray(value.proposedFixes) && value.proposedFixes.length) {
    lines.push('Proposed fixes (the USER must approve them before action "fix"):')
    for (const fix of value.proposedFixes) lines.push(`  ${fix.type}: ${fix.cmd ?? fix.text ?? fix.label ?? ''}`)
  }
  if (Array.isArray(value.applied)) {
    for (const a of value.applied) {
      lines.push(`  applied ${a.type}: ${a.error ? 'FAILED — ' + a.error : (a.cmd ?? a.path ?? a.label ?? 'ok')}`)
    }
  }
  if (Array.isArray(value.steps)) {
    lines.push('Steps:')
    for (const s of value.steps.slice(-8)) lines.push(`  ${s.kind}${s.runIndex != null ? '#' + s.runIndex : ''} exit=${s.exitCode}${s.timedOut ? ' (timeout)' : ''} ${s.durationMs}ms${s.tail ? ' — ' + truncate(s.tail, 160) : ''}`)
  }
  if (Array.isArray(value.trials)) {
    lines.push('Trials:')
    for (const t of value.trials) lines.push(`  ${t.trialId} [${t.status}] runs=${t.runs} failures=${t.failures} issues=${t.issues}`)
  }
  return lines.join('\n') || 'Trial finished.'
}

/* ------------------------------------------------------------------ */
/* continuous monitor (deployment watch, report-only)                  */
/* ------------------------------------------------------------------ */

/** True while a capability change happened recently (deploy window). */
function withinDeployWindow(state, cfg) {
  if (!state.recent.length) return false
  const last = state.recent[state.recent.length - 1]
  const at = new Date(last.at).getTime()
  if (Number.isNaN(at)) return false
  return Date.now() - at <= cfg.monitor.deployWindowMs
}

/** True when any agent has a running/stopping background job. */
async function hasRunningJobs(ctx) {
  try {
    const seen = new Set()
    const views = []
    const push = (list) => {
      for (const job of list) {
        if (job && job.id != null && !seen.has(job.id)) {
          seen.add(job.id)
          views.push(job)
        }
      }
    }
    try { push(await ctx.jobs.list()) } catch { /* jobs unavailable */ }
    for (const agent of ctx.agents.list()) {
      try { push(await ctx.jobs.list(agent.id)) } catch { /* agent gone */ }
    }
    return views.some((job) => job.status === 'running' || job.status === 'stopping')
  } catch {
    return false
  }
}

/**
 * One monitor tick. Runs only inside a deployment window (recent capability
 * change or a running background job). GPU / stuck-job findings are
 * REPORT-ONLY: they notify the live agents and never change anything.
 * Plugin health keeps its existing auto-disable strategy.
 *
 * Cadence is split: the cheap GPU snapshot runs every tick, while the
 * heavier scans (stuck jobs, plugin health) run on the first tick and then
 * every `heavyEveryNTicks` ticks, so the default 2s interval does not
 * hammer the host with full plugin-list / job-list scans.
 */
async function monitorTick(ctx, cfg, state) {
  state.tickCount += 1
  state.stats.ticks += 1
  const watching = withinDeployWindow(state, cfg) || (await hasRunningJobs(ctx))
  if (!watching) {
    state.alertedKeys.clear()
    state.tickCount = 0
    return
  }
  const heavyEvery = Math.max(1, Math.floor(Number(cfg.monitor.heavyEveryNTicks) || 6))
  const heavy = state.tickCount === 1 || state.tickCount % heavyEvery === 0
  const alerts = []
  const pushAlert = (key, line) => {
    if (state.alertedKeys.has(key)) return
    state.alertedKeys.add(key)
    alerts.push(line)
  }
  if (cfg.gpu.enabled) {
    const gpu = await checkGpu(ctx, cfg, false, false, state)
    for (const issue of gpu.issues ?? []) {
      pushAlert(`gpu:${issue.title}`, `GPU alert: ${issue.title} — ${issue.detail}.`)
    }
  }
  if (heavy && cfg.stuckJobs.enabled) {
    const stuck = await checkStuckJobs(ctx, cfg, false)
    for (const issue of stuck.issues ?? []) {
      pushAlert(`job:${issue.jobId ?? issue.title}`, `Stuck job alert: ${issue.title} — ${issue.detail}.`)
    }
  }
  if (heavy) {
    await checkPlugins(ctx, cfg, state)
    if (cfg.installGuard?.enabled) {
      try {
        const versions = await checkBundleVersions(ctx, cfg)
        for (const issue of versions.issues ?? []) {
          pushAlert(`ver:${issue.title}`, `Version alert: ${issue.title} — ${issue.detail}.`)
        }
      } catch { /* version scan best-effort */ }
      try {
        const core = await checkCoreChain(ctx, cfg)
        for (const issue of core.issues ?? []) {
          if (issue.severity !== 'error') continue
          pushAlert(`core:${issue.title}`, `Core-chain alert: ${issue.title} — ${issue.detail}.`)
        }
      } catch { /* core scan best-effort */ }
    }
    if (cfg.system?.enabled) {
      try {
        const system = await checkSystem(ctx, cfg, false)
        for (const issue of system.issues ?? []) {
          pushAlert(`sys:${issue.title}`, `System alert: ${issue.title} — ${issue.detail}.`)
        }
      } catch { /* system scan best-effort */ }
    }
  }
  if (alerts.length) {
    notifyAgents(ctx, 'Capability safety monitor: ' + alerts.join(' '), state)
  }
}

/* ------------------------------------------------------------------ */
/* silent background check                                             */
/* ------------------------------------------------------------------ */

function scheduleSilentCheck(ctx, cfg, state) {
  if (state.disposed || state.debounceTimer) return
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    if (state.disposed) return
    silentCheck(ctx, cfg, state).catch(() => { /* silent */ })
  }, cfg.silentCheckDebounceMs)
}

async function silentCheck(ctx, cfg, state) {
  const result = await checkPlugins(ctx, cfg, state)
  const notes = []
  for (const issue of result.issues ?? []) {
    if (issue.kind !== 'plugin') continue
    if (issue.fixed === true) {
      notes.push(`plugin "${issue.entryId}" failed to activate and was auto-disabled.`)
    } else if (issue.severity === 'error') {
      notes.push(`plugin "${issue.entryId}" failed to activate; cannot auto-fix: ${issue.unfixableReason}`)
    }
  }
  if (cfg.installGuard?.enabled) {
    try {
      const core = await checkCoreChain(ctx, cfg)
      for (const issue of core.issues ?? []) {
        if (issue.kind !== 'core' || issue.severity !== 'error') continue
        notes.push(`core chain: ${issue.title} — ${issue.detail}`)
      }
    } catch { /* core scan best-effort */ }
  }
  if (notes.length) notifyAgents(ctx, 'Capability safety: ' + notes.join(' '), state)
}

/* ------------------------------------------------------------------ */
/* tool                                                                */
/* ------------------------------------------------------------------ */

async function runChecks(ctx, cfg, state, args) {
  const wantGpu = args.gpu !== false
  const wantStuck = args.stuck !== false
  const wantPlugins = args.plugins !== false
  const wantVersions = args.versions !== false
  const wantCoreChain = args.coreChain !== false
  const wantSystem = args.system !== false
  const wantErrors = args.errors !== false
  const wantSelf = args.self !== false
  const fix = args.fix === true

  const checks = {}
  const results = await Promise.allSettled([
    wantGpu ? checkGpu(ctx, cfg, fix, true, state, true) : null,
    wantStuck ? checkStuckJobs(ctx, cfg, fix) : null,
    wantPlugins ? checkPlugins(ctx, cfg, state) : null,
    wantVersions ? checkBundleVersions(ctx, cfg) : null,
    wantCoreChain ? checkCoreChain(ctx, cfg) : null,
    wantSystem ? checkSystem(ctx, cfg, fix) : null,
    wantErrors ? checkErrors(ctx, cfg, state) : null,
    wantSelf ? checkSelf(ctx, cfg, state) : null,
  ])
  const names = ['gpu', 'stuckJobs', 'plugins', 'versions', 'coreChain', 'system', 'errors', 'self']
  const issues = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) {
      checks[names[index]] = result.value
      if (Array.isArray(result.value.issues)) issues.push(...result.value.issues)
    } else if (result.status === 'rejected') {
      checks[names[index]] = { checked: false, error: truncate(String(result.reason?.message ?? result.reason)) }
      issues.push({
        severity: 'warn',
        kind: 'internal',
        title: `${names[index]} check crashed`,
        detail: truncate(String(result.reason?.message ?? result.reason)),
        fixed: false,
      })
    }
  })
  if (state.pendingRestart) {
    issues.push({
      severity: 'warn',
      kind: 'restart',
      title: 'A pending change requires a DSH restart',
      detail: `${state.pendingRestart.note} (since ${state.pendingRestart.at}) — the change is not live until the next restart; re-run this check after restarting to confirm.`,
      fixed: false,
    })
  }

  const openErrors = issues.filter((issue) => issue.severity === 'error' && issue.fixed !== true)
  const ok = openErrors.length === 0
  const warnings = issues.filter((issue) => issue.severity !== 'error')
  const fixed = issues.filter((issue) => issue.fixed === true).length
  const unfixed = issues.filter((issue) => issue.fixed !== true).length

  let summary
  if (!issues.length) {
    summary = 'All checks passed; no safety problems found.'
  } else if (ok) {
    summary = `No open critical problems. ${fixed} problem(s) fixed automatically, ${unfixed} note(s)/warning(s) remain.`
  } else {
    summary = `${openErrors.length} critical problem(s) remain unfixed; ${fixed} problem(s) were fixed automatically.`
  }

  return {
    ok,
    checkedAt: new Date().toISOString(),
    checks,
    issues,
    pendingRestart: state.pendingRestart ?? null,
    recentChanges: state.recent.slice(-cfg.maxRecentChanges),
    summary,
  }
}

function renderReport(value) {
  const lines = [value?.summary ?? 'Check finished.']
  const issues = value?.issues ?? []
  if (!issues.length) lines.push('No problems found.')
  for (const issue of issues) {
    const flag = issue.fixed === true ? '[fixed]' : issue.severity === 'error' ? '[unfixed]' : ''
    let line = `- ${flag} ${issue.title}: ${issue.detail ?? ''}`
    if (issue.fixed === true) line += ' (fixed automatically)'
    if (issue.unfixableReason) line += ` — cannot auto-fix: ${issue.unfixableReason}`
    lines.push(line)
  }
  const changes = value?.recentChanges ?? []
  const deploy = value?.checks?.gpu?.deploy
  if (deploy?.verdict) {
    const upper = deploy.verdict.toUpperCase()
    lines.push(`GPU deploy readiness: ${upper} — ${deploy.freeMiB} MiB free (${deploy.freePct}%)${deploy.holders?.length ? `; ${deploy.holdersLabel ?? 'top holders'}: ` + deploy.holders.join(', ') : ''}`)
  }
  const selfStats = value?.checks?.self?.stats
  if (selfStats) {
    lines.push(
      `Guardian health: up ${Math.max(0, Math.round(selfStats.uptimeSec / 60))} min, ${selfStats.ticks} monitor ticks, ${selfStats.eventsSeen} change events, ${selfStats.alertsSent} alerts sent, ${selfStats.autoFixes} auto-fixes, GPU snapshots ${selfStats.gpuSnapshotsOk} ok / ${selfStats.gpuSnapshotsFail} failed, ${selfStats.injectBlocked} injections blocked, monitor ${selfStats.monitorArmed ? 'armed' : 'NOT armed'}, ${selfStats.trialsActive ?? 0} active trials`,
    )
  }
  if (value?.pendingRestart) {
    lines.push(`Restart pending: ${value.pendingRestart.note} (since ${value.pendingRestart.at})`)
  }
  if (changes.length) {
    lines.push(`Recent capability changes (${changes.length}):`)
    for (const change of changes.slice(-5)) lines.push(`  ${change.at} ${change.event}`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* plugin apply                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const cfg = mergeConfig(DEFAULT_CONFIG, config || {})
  const state = {
    recent: [],
    debounceTimer: null,
    disposed: false,
    disabledByUs: new Set(),
    alertedKeys: new Set(),
    tickCount: 0,
    pendingRestart: null,
    restartNotified: false,
    recentToolErrors: [],
    gpuSamples: [],
    trials: new Map(),
    stats: {
      startedAt: Date.now(),
      ticks: 0,
      eventsSeen: 0,
      alertsSent: 0,
      autoFixes: 0,
      gpuSnapshotsOk: 0,
      gpuSnapshotsFail: 0,
      injectBlocked: 0,
      monitorArmed: false,
    },
  }

  // 1. Global system-prompt policy for every conversation.
  const disposePrompt = ctx.systemPrompt.section({
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    text: () => PROMPT_TEXT,
  })

  // 2. The safety tool.
  const disposeTool = ctx.tools.register({
    name: 'capability_safety_check',
    description:
      'Run a capability safety check. Call this right after you add or upgrade any capability in this session: installing, upgrading, or enabling a plugin or bundle, registering a new tool or skill, adding or changing an MCP server, or changing the agent preset, model, or adapter. Checks GPU memory pressure (per-GPU usage, driver version, temperature/throttling, per-process VRAM consumers, rising-memory trends), long-running background jobs, plugin activation health, installed @deepseek-ai version channels, core plugin chain health, pending-restart changes, system resources (RAM, CPU load, drive free space, heavyweight processes), recent tool-error fingerprints (OOM, port conflict, disk full, permission, missing module) and repeated-failure loops, and the guardian\'s own health. Non-destructive fixes are always applied (e.g. disabling a plugin that failed to activate). Pass fix: true to also apply destructive fixes the plugin config allows (killing stuck jobs, GPU processes, or heavyweight system processes). If the result reports an unfixable problem, explain to the user why it cannot be fixed automatically and what they can do.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gpu: { type: 'boolean', description: 'Check GPU memory usage (default true).' },
        stuck: { type: 'boolean', description: 'Check background jobs that have been running suspiciously long (default true).' },
        plugins: { type: 'boolean', description: 'Check plugin activation health (default true).' },
        versions: { type: 'boolean', description: 'Check installed @deepseek-ai package versions/channels for prerelease or mixed-channel hazards (default true).' },
        coreChain: { type: 'boolean', description: 'Check whether core plugins (storage/workspace/session/domain/gateway) are disabled, failed, or carry compatibility warnings (default true).' },
        system: { type: 'boolean', description: 'Check system resources: RAM pressure, free space on the workspace/profile drives, heavyweight processes (default true).' },
        errors: { type: 'boolean', description: 'Report recent tool-error fingerprints from this session (OOM, port conflict, disk full, permission, missing module) and repeated-failure loops (default true).' },
        self: { type: 'boolean', description: 'Report the guardian\'s own health: uptime, monitor ticks, change events, alerts sent, auto-fixes, and GPU sampling success/failure (default true).' },
        fix: { type: 'boolean', description: 'Also apply destructive fixes the plugin config allows: killing stuck background jobs, GPU processes, and heavyweight system processes (default false).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          checkedAt: { type: 'string' },
          summary: { type: 'string' },
          issues: { type: 'array' },
          recentChanges: { type: 'array' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    async execute(args) {
      return runChecks(ctx, cfg, state, args || {})
    },
  })

  // 2b. The try-before-commit sandbox tool.
  const disposeTrialTool = ctx.tools.register({
    name: 'safe_trial_run',
    description:
      'Run new software (or newly installed packages/tools) inside an isolated sandbox before it touches anything real: create a trial, install and execute it several times, analyze crashes and error fingerprints, propose fixes, apply only user-approved fixes, and export the verified product. Workflow: action "create" (spec: {name?, sourceDir?, lang?: "python"|"node"|"none", installCmd?, runCmd, runs?, timeoutSec?, watchGpu?}) -> action "run" -> action "analyze" -> report issues + proposedFixes to the USER -> action "fix" with ONLY the fixes the user approved (fixes: [{type:"run",cmd} | {type:"file",path,content} | {type:"note",label}], all applied strictly inside the sandbox) -> "run" + "analyze" until clean -> action "export" (outputDir must be outside the sandbox) -> present the exported path as the final artifact. Isolation is files/environment/process level (own dir, venv for python, cleaned HOME/TEMP/PIP/NPM env, per-run timeouts); it is NOT a VM — GPU and OS are shared. The tool never touches the DSH profile or install dirs, and trial metadata lives only in plugin memory (lost on restart); use action "status" to list trials and "cleanup" to remove a sandbox.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'One of: create, run, analyze, fix, export, status, cleanup (required).' },
        trialId: { type: 'string', description: 'Trial id (lowercase letters/digits/-/_). Required for run/analyze/fix/export/cleanup; optional for create (auto-generated).' },
        spec: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Display/export name for the trial.' },
            sourceDir: { type: 'string', description: 'Optional absolute directory to copy into the sandbox as src/ (a written program to trial). Refused when inside the DSH profile or install dir.' },
            lang: { type: 'string', description: 'Runtime language: "python" (creates a sandbox venv), "node", or "none" (default none).' },
            installCmd: { type: 'string', description: 'Optional install command run once before the runs, e.g. "pip install -r requirements.txt" (in a python trial use plain pip; the venv is on PATH).' },
            runCmd: { type: 'string', description: 'REQUIRED for create: the command line to execute each run, e.g. "python app.py" or "node server.js". Split on spaces with quote support; no pipes/redirection — wrap such commands in cmd /c "..." when needed.' },
            runs: { type: 'number', description: 'How many times to run runCmd (1-10, default 3).' },
            timeoutSec: { type: 'number', description: 'Per-run timeout in seconds (default 180).' },
            watchGpu: { type: 'boolean', description: 'Also snapshot GPU VRAM usage before/after the runs (default false).' },
          },
        },
        fixes: { type: 'array', description: 'For action "fix": only the fixes the USER approved. Entries: {type:"run",cmd} runs a command in the sandbox; {type:"file",path,content} writes a file inside the sandbox (path is sandbox-relative, escaping paths are refused); {type:"note",label} records a note.' },
        outputDir: { type: 'string', description: 'For action "export": absolute destination directory for the verified product (must be OUTSIDE the sandbox, e.g. a workspace folder). Default: exportsRoot/<name>.' },
        overwrite: { type: 'boolean', description: 'For action "export": replace a non-empty outputDir (default false).' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderTrial(value) }],
    },
    async execute(args) {
      return safeTrialRun(ctx, cfg, state, args || {})
    },
  })

  // 3. Capability-change listeners: record + restart tracking + silent check.
  const offs = []
  for (const eventName of CHANGE_EVENTS) {
    const off = ctx.on(eventName, (payload) => {
      if (state.disposed) return
      state.stats.eventsSeen += 1
      recordChange(state, eventName, payload, cfg.maxRecentChanges)
      if (cfg.installGuard?.trackRestartPending) {
        const note = detectRestartSignal(payload)
        if (note) {
          state.pendingRestart = { at: new Date().toISOString(), note }
          if (!state.restartNotified) {
            state.restartNotified = true
            notifyAgents(
              ctx,
              `Capability safety: ${note}. The change is not live until the next DSH restart — re-run capability_safety_check after restarting and keep any quarantine/backup in place until then.`,
              state,
            )
          }
        }
      }
      scheduleSilentCheck(ctx, cfg, state)
    })
    offs.push(off)
  }

  // 3b. Tool-error fingerprint watch: record every failing tool result and
  //     notify live agents on critical fingerprints (OOM / port / disk /
  //     permission / missing module). Non-waking inbox injection.
  if (cfg.errors?.enabled) {
    const offErrors = ctx.on('tools/result', (exec, result) => {
      if (state.disposed) return
      try {
        const entry = extractToolError(exec?.name, result)
        if (!entry) return
        state.recentToolErrors.push(entry)
        if (state.recentToolErrors.length > cfg.maxRecentChanges * 2) state.recentToolErrors.shift()
        if (entry.fingerprint && cfg.errors?.notifyOnCritical) {
          notifyAgents(
            ctx,
            `Capability safety: a tool run just failed with a ${entry.label} signature (${entry.tool}): ${entry.snippet}. ${FINGERPRINT_GUIDANCE[entry.fingerprint] ?? ''}`.trim(),
            state,
          )
        }
      } catch {
        /* result shapes are best-effort */
      }
    })
    offs.push(offErrors)
  }

  // 4. Continuous deployment monitor (report-only, interval based).
  let disposeMonitor = null
  if (cfg.monitor?.enabled) {
    const intervalMs = Number(cfg.monitor.intervalMs)
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      const tick = () => {
        if (state.disposed) return
        monitorTick(ctx, cfg, state).catch(() => { /* silent */ })
      }
      // Prefer the host's dispose-aware setInterval; fall back to the raw
      // Node global when the host exposes none. (Observed live on
      // 2026-11-23: the host API silently never ticked — 0 ticks in 6
      // minutes — so the fallback keeps the monitor actually working.)
      if (typeof ctx.setInterval === 'function') {
        try {
          disposeMonitor = ctx.setInterval(tick, intervalMs)
          state.stats.monitorArmed = true
        } catch {
          /* fall through to the global */
        }
      }
      if (!disposeMonitor) {
        const handle = globalThis.setInterval(tick, intervalMs)
        disposeMonitor = () => globalThis.clearInterval(handle)
        state.stats.monitorArmed = true
      }
    }
  }

  return () => {
    state.disposed = true
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    if (disposeMonitor) {
      try { disposeMonitor() } catch { /* already disposed */ }
    }
    for (const off of offs) {
      try { off() } catch { /* already disposed */ }
    }
    try { disposePrompt() } catch { /* already disposed */ }
    try { disposeTool() } catch { /* already disposed */ }
    try { disposeTrialTool() } catch { /* already disposed */ }
  }
}
