# dsh-capability-safety-guard

Capability safety guard for DeepSeek Harness: automatically runs safety checks (GPU/VRAM, stuck jobs, plugin health, version channels, core chain, system resources, error fingerprints, guardian self-health) after every capability change, auto-fixes what it safely can and explains what it cannot; plus a `safe_trial_run` sandbox that rehearses new software before it touches the real machine.

[中文说明](#中文说明) · [Config](#config) · [Safety notes](#safety-notes) · [License](#license)

## Install

```sh
dsh plugin --profile web add dsh-capability-safety-guard
```

Restart DSH, then the guard is active. Two agent tools are registered:

- `capability_safety_check` — on-demand full check. The plugin's own policy (injected into the system prompt) also asks the agent to call it right after installing, upgrading, or enabling any plugin, tool, skill, MCP server, or after changing the preset/model.
- `safe_trial_run` — try-before-commit sandbox: `create` an isolated trial (own dir, own venv for python, cleaned HOME/TEMP/PIP/NPM env), `run` install-and-execute several times with timeouts, `analyze` to collect crashes and error fingerprints with proposed fixes, `fix` with only user-approved fixes, and `export` the verified product out of the sandbox.

## What it checks

| Check | Watches | Thresholds / triggers |
| --- | --- | --- |
| GPU | used/total %, driver, temperature, per-process consumers, rising trend | warn 85% / critical 95%, temp warn 85 °C / critical 92 °C |
| Resident model | Ollama / llama-server-style processes holding VRAM | GPU ≥ 80% and a resident process present |
| Deploy readiness | free VRAM before deploying any local model or program | GO ≥ 25%, CAUTION 10–25%, STOP < 10% |
| Stuck jobs | long-running background jobs | warn 5 min / kill 15 min (opt-in) |
| Plugin health | failed plugins | auto-disable failed entries (non-destructive) |
| Version channels | prerelease / mixed-channel `@deepseek-ai/*` packages in the profile | any -alpha/-beta, mixed channels |
| Core chain | storage/workspace/session plugins disabled or failed | compat-flavoured diagnostics |
| Pending restart | `restart-required` plugin-manager changes | tracked until the host restarts |
| System | RAM, drive free space, heavy processes, CPU | RAM warn 85% / crit 95%, disk warn 15% free / crit 8%, CPU warn 85% / crit 95% |
| Error fingerprints | OOM, port-in-use, disk-full, permission, missing-module errors from tool runs | failure loops (same tool + fingerprint) |
| Self | guardian uptime, monitor ticks, alerts, auto-fixes, GPU sampling health | sampling keeps failing |

It also keeps a 2 s GPU monitor running during the deploy window (10 min after the last capability change), reporting only.

## Config

Patch in the profile (defaults shown are the built-ins):

```jsonc
{
  "gpu": { "enabled": true, "warnUsedPct": 85, "criticalUsedPct": 95,
           "tempWarnC": 85, "tempCriticalC": 92,
           "resident": { "enabled": true, "warnAtPct": 80, "patterns": ["ollama", "llama"], "autoStopOnFix": false } },
  "deploy": { "enabled": true, "goFreePct": 25, "stopFreePct": 10 },
  "stuckJobs": { "enabled": true, "warnMs": 300000, "killMs": 900000, "autoKill": false },
  "plugins": { "enabled": true, "autoDisableFailed": true },
  "installGuard": { "enabled": true, "flagPrerelease": true, "warnCoreChainDisabled": true, "trackRestartPending": true },
  "system": { "enabled": true, "ram": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "disk": { "paths": ["C:", "D:"], "warnFreePct": 15, "criticalFreePct": 8 },
              "processes": { "warnWorkingSetMb": 6144, "criticalWorkingSetMb": 10240, "allowedNames": [], "autoKill": false } },
  "errors": { "enabled": true, "notifyOnCritical": true, "loopThreshold": 3 },
  "trial": { "enabled": true, "sandboxRoot": "", "exportsRoot": "", "defaultRuns": 3, "runTimeoutSec": 180, "installTimeoutSec": 600 },
  "monitor": { "enabled": true, "intervalMs": 2000, "deployWindowMs": 600000, "heavyEveryNTicks": 15 },
  "self": { "enabled": true },
  "silentCheckDebounceMs": 2000,
  "maxRecentChanges": 20
}
```

See `docs/DETAIL.md` for the full manual.

## Safety notes

- The guard only auto-fixes what is reversible and non-destructive (disabling a failed plugin). Kills (GPU processes, stuck jobs, heavy processes) and resident-model unloads run only with `fix: true` plus the matching `autoKill`/`autoStopOnFix` switches.
- RAM, disk and version-channel findings are report-only — the guard never frees memory, deletes files, or rewrites the profile on its own.
- Notices injected into conversations are validated against the host's message format before injection (a missing `id`/`source`/content-block shape would be rejected, never written).
- This plugin is not a security review of anything else. It checks health, not malice.

## 中文说明

能力安全卫士：每次新增或升级能力（装/升/启插件、加工具或技能、加 MCP、改预设或模型）后自动做安全检查——显存（用量/温度/进程级占用/上升趋势）、常驻模型、部署就绪度、卡死任务、插件健康、版本通道、核心插件链、待重启变更、系统资源（内存/磁盘/CPU/大户进程）、工具错误指纹与失败死循环，以及卫士自身健康。能安全修的自动修（如禁用启动失败的插件），不能修的向你解释原因。另带 `safe_trial_run` 试跑沙箱：新软件先在隔离目录里安装、跑几遍、收集崩溃与错误指纹，你批准修复后再把成品导出来。

```sh
dsh plugin --profile web add dsh-capability-safety-guard
```

## License

MIT
