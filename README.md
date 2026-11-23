# dsh-capability-safety-guard

Capability safety guard for DeepSeek Harness: after every capability change (plugin/tool/skill/MCP/preset/model) it runs 14 multi-sampled safety checks — GPU, deploy headroom, stuck jobs, plugin health, version channels, core chain, pending restarts, system resources, ports, power plan, error fingerprints, and its own health — auto-fixes what is safely reversible, explains the rest, plus a `safe_trial_run` sandbox that rehearses new software before it touches the real machine.

[Install](#install) · [What it checks](#what-it-checks) · [中文说明](#中文说明) · [Config](#config) · [Safety notes](#safety-notes) · [License](#license)

## Install

```sh
dsh plugin --profile web add dsh-capability-safety-guard
```

Restart DSH, then the guard is active. Two agent tools are registered:

- `capability_safety_check` — on-demand full check. The plugin's own policy (injected into the system prompt) also asks the agent to call it right after installing, upgrading, or enabling any plugin, tool, skill, MCP server, or after changing the preset/model.
- `safe_trial_run` — try-before-commit sandbox: `create` an isolated trial (own dir, own venv for python, cleaned HOME/TEMP/PIP/NPM env), `run` install-and-execute several times (1–20, default 5) with timeouts and optional continuous GPU sampling, `analyze` crashes, error fingerprints, declared expectations (`spec.expect`) and a verdict, `fix` with only user-approved fixes, and `export` the verified product plus a `trial-report.json` manifest.

## What it checks

| Check | Watches | Thresholds / triggers |
| --- | --- | --- |
| GPU | used/total % (multi-sampled, judged by the worst sample), temperature, driver, per-process consumers, utilization/fan/power | warn 85% / critical 95%; temp warn 85 °C / critical 92 °C; fan 0 while hot; rising trend ≥ 2%/min over ≥ 60 s |
| Deploy readiness | free VRAM **and** free RAM, combined (worst of the two) | GO ≥ 25% GPU + 15% RAM; STOP < 10% GPU or < 8% RAM; else CAUTION |
| Resident model | Ollama / llama-server-style processes holding VRAM | GPU ≥ 80% and a resident process present; graceful unload only on opt-in `autoStopOnFix` |
| Stuck jobs | long-running background jobs | warn 5 min / kill 15 min (opt-in); `expectedLongLabels` allowlist (e.g. `serve`) |
| Plugin health | failed or stuck-activating plugins | auto-disable failed entries; `pending` warns only after a 60 s grace |
| Version channels | prerelease / mixed-channel `@deepseek-ai/*` packages | any -alpha/-beta/rc or mixed channels |
| Core chain | storage/workspace/session plugins disabled or failed | compat-flavoured diagnostics |
| Pending restart | `restart-required` plugin-manager changes | tracked until the host restarts |
| System | RAM, commit/pagefile, disks, CPU, top processes — double-sampled | warnings use the mean, errors need both samples beyond critical; disk warn 15% free / crit 8%; heavy process is an error only under RAM pressure |
| Ports | `netstat` listeners against `ports.watchPorts` | warns only when a watched port is already taken (EADDRINUSE) |
| Power plan | active scheme, standby/hibernate timeouts | warns when < 30 min **and** a background job is running |
| Error fingerprints | 10 fingerprints: OOM, port, disk, permission, dependency, timeout, TLS, DNS, encoding, file-not-found | failure loops counted since the tool's last success; per-fingerprint notify cooldown (10 min) |
| Self | uptime, ticks, events, alerts, auto-fixes, GPU sampling health | sampling keeps failing |

Monitoring: 2 s GPU sampling during the deploy window (10 min after the last capability change) with deeper checks every 20 s; outside the window a 5 min idle heartbeat patrols GPU + stuck jobs + system and alerts on errors only.

## 中文说明

**能力安全卫士**：装/升/启插件、加工具或技能、加 MCP、改预设或模型之后，自动做一轮安全体检；能安全修的自动修，修不了的说明原因。

### 检查什么

| 检查项 | 盯什么 |
| --- | --- |
| 显存 | 占用率（多次采样取最坏）、温度、大户进程、上升趋势 |
| 部署就绪度 | 部署本地模型前，显存 + 内存合并判级 GO / CAUTION / STOP |
| 常驻模型 | Ollama 等常驻进程占显存 |
| 卡死任务 | 长跑后台任务，白名单可豁免（如 serve） |
| 插件健康 | 启动失败自动禁用；激活中给 60 秒宽限 |
| 版本通道 | profile 里预发布 / 混通道包 |
| 核心插件链 | 存储 / 工作区 / 会话等核心插件是否失效 |
| 待重启变更 | 需重启才生效的变更 |
| 系统资源 | 内存（含提交内存）/ 磁盘 / CPU / 大户进程，双采样降误报 |
| 端口占用 | 监听端口是否被占（对照 watchPorts） |
| 电源计划 | 睡眠超时会不会杀死长任务 |
| 错误指纹 | 10 类错误指纹 + 失败死循环 + 通知冷却 |
| 自身健康 | 心跳、采样成功率、自动修复统计 |

### 试跑沙箱 safe_trial_run

新软件先在隔离目录里：安装 → 跑 N 遍（默认 5，可 1–20）→ 收集崩溃与错误指纹、核对声明预期 → 只修你批准的修复 → 导出成品（附 trial-report.json 验收清单）。

### 安装

```sh
dsh plugin --profile web add dsh-capability-safety-guard
```

重启 DSH 生效。

## Config

Patch in the profile (defaults shown are the built-ins):

```jsonc
{
  "gpu": { "enabled": true, "warnUsedPct": 85, "criticalUsedPct": 95, "autoKill": false,
           "tempWarnC": 85, "tempCriticalC": 92,
           "samples": 3, "sampleIntervalMs": 700,
           "trend": { "minSpanMs": 60000, "minSlopePerMin": 2 },
           "resident": { "enabled": true, "warnAtPct": 80, "patterns": ["ollama", "llama"], "autoStopOnFix": false } },
  "deploy": { "enabled": true, "goFreePct": 25, "stopFreePct": 10, "ramGoFreePct": 15, "ramStopFreePct": 8 },
  "stuckJobs": { "enabled": true, "warnMs": 300000, "killMs": 900000, "autoKill": false, "expectedLongLabels": [] },
  "plugins": { "enabled": true, "autoDisableFailed": true, "pendingGraceMs": 60000 },
  "installGuard": { "enabled": true, "flagPrerelease": true, "warnCoreChainDisabled": true, "trackRestartPending": true },
  "system": { "enabled": true, "samples": 2, "sampleIntervalMs": 1500,
              "ram": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "cpu": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "pagefile": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "disk": { "paths": ["C:", "D:"], "warnFreePct": 15, "criticalFreePct": 8 },
              "processes": { "warnWorkingSetMb": 6144, "criticalWorkingSetMb": 10240, "allowedNames": [], "autoKill": false } },
  "errors": { "enabled": true, "notifyOnCritical": true, "loopThreshold": 3, "windowMs": 1200000, "notifyCooldownMs": 600000 },
  "ports": { "enabled": true, "watchPorts": [] },
  "power": { "enabled": true, "minStandbyMin": 30, "minHibernateMin": 30 },
  "trial": { "enabled": true, "sandboxRoot": "", "exportsRoot": "",
             "defaultRuns": 5, "maxRuns": 20, "runTimeoutSec": 180, "installTimeoutSec": 600, "gpuLeakWarnMiB": 200 },
  "monitor": { "enabled": true, "intervalMs": 2000, "deployWindowMs": 600000,
               "heavyEveryNTicks": 10, "idleHeartbeatMs": 300000, "alertCooldownMs": 600000 },
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

## License

MIT
