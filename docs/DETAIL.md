# Capability safety guard

Capability change → automatic health check → auto-fix what is safe, explain the rest. Pre-deploy VRAM checks, trial sandbox for new things.

- **Automatic health check**: 12 checks (GPU, jobs, plugins, version channels, system resources, error fingerprints…), table below
- **Deployment watch**: every 2 s VRAM sampling / 30 s deep scans inside a deployment window — report only, never acts
- **Trial sandbox**: `safe_trial_run` runs new installs/programs in isolation, applies only the fixes you approve, exports the verified product

## Checks at a glance

| Check | Watches | Threshold / trigger |
| --- | --- | --- |
| GPU memory | `nvidia-smi` usage, temperature, driver/GPU name, per-process consumers | ≥85% warn, ≥95% critical; temp ≥92°C critical; rising ≥10 points across samples reports a leak/load trend |
| Resident model processes | ollama/llama-family processes in the consumer list (configurable `patterns`) | resident and usage ≥80% → advise unloading first (small cards share VRAM with the display; image gen on top can black-screen); `fix:true` + `gpu.resident.autoStopOnFix` unloads gracefully for you: `ollama stop` for ollama apps, graceful taskkill (never forced) for other matched names |
| Deploy preflight | free VRAM and current holders (any model or program) | GO (free ≥25%) / CAUTION (10–25%) / **STOP** (<10%: error "do not deploy" — free VRAM first); other holders: list and ask the user before stopping |
| Stuck jobs | background job age | >`warnMs` (5 min) warn, >`killMs` (15 min) critical |
| Plugin health | activation state | `failed` or long-`pending` reported |
| Version channels | `@deepseek-ai` package versions actually resolved in the profile | any prerelease (alpha/beta/rc) or mixed channels → critical (the forge-incident fingerprint); report only |
| Core plugin chain | storage / workspace / session / domain / gateway | failed or "disabled + compatibility diagnostic" → critical; disabled with no diagnostic → treated as intentional (info, never injected) |
| Pending-restart changes | install results reporting `restart-required` | recorded and flagged: re-verify after restart; keep quarantines/backups until the fix chain is verified |
| System resources | one PowerShell snapshot: RAM / CPU / drive free space / heavyweight processes | RAM & CPU ≥85% warn ≥95% critical; disk free <15% warn <8% critical; report only — never deletes files or kills processes |
| Error fingerprints | tool failures from the last 15 minutes | cross-command patterns: OOM / port in use / disk full / permission / missing module; structured failure signals only (a successful run whose text says "out of memory" is not a failure) |
| Failure loops | same tool + same fingerprint failing repeatedly | ≥`loopThreshold` (3) → flagged as a retry loop / broken dependency, with guidance |
| Guardian self-health | uptime, ticks, events, alerts, auto-fixes, GPU snapshot success, monitor armed | reported honestly; a guard that cannot sample the GPU says so |

The GPU check skips (and says so) without an NVIDIA GPU; the system check skips without PowerShell.

## Auto-fix policy

- **Always applied (non-destructive):** a plugin that failed to activate is disabled, stopping failure loops.
- **Only with `fix: true` (destructive, all off by default):** killing stuck jobs, GPU consumers, or heavyweight processes — these can destroy in-progress work.
- **Never auto-fixed:** RAM/disk issues (it will not delete files for you), version channels, and the core chain — reported with reasons for you to decide.

## Configuration

Edit in Settings → Plugins. Defaults:

```json
{
  "gpu":    { "enabled": true, "warnUsedPct": 85, "criticalUsedPct": 95, "tempWarnC": 85, "tempCriticalC": 92, "autoKill": false,
              "resident": { "enabled": true, "warnAtPct": 80, "patterns": ["ollama", "llama"], "autoStopOnFix": false } },
  "deploy": { "enabled": true, "goFreePct": 25, "stopFreePct": 10 },
  "stuckJobs": { "enabled": true, "warnMs": 300000, "killMs": 900000, "autoKill": false },
  "plugins": { "enabled": true, "autoDisableFailed": true },
  "monitor": { "enabled": true, "intervalMs": 2000, "deployWindowMs": 600000, "heavyEveryNTicks": 15 },
  "installGuard": { "enabled": true, "flagPrerelease": true, "warnCoreChainDisabled": true, "trackRestartPending": true },
  "system": { "enabled": true,
              "ram": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "cpu": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "disk": { "paths": ["C:", "D:"], "warnFreePct": 15, "criticalFreePct": 8 },
              "processes": { "warnWorkingSetMb": 6144, "criticalWorkingSetMb": 10240, "allowedNames": [], "autoKill": false } },
  "errors": { "enabled": true, "notifyOnCritical": true, "loopThreshold": 3 },
  "trial":  { "enabled": true, "sandboxRoot": "", "exportsRoot": "", "defaultRuns": 3, "runTimeoutSec": 180, "installTimeoutSec": 600 },
  "self":   { "enabled": true }
}
```

`capability_safety_check` args: `gpu / stuck / plugins / versions / coreChain / system / errors / self` (pass `false` to skip one) and `fix` (`true` enables destructive fixes).

## Trial sandbox (try before you trust)

The `safe_trial_run` pipeline, run by the plugin itself:

1. **create** — an isolated dir under the sandbox root; python trials get their own venv; cleaned environment (private HOME/TEMP/PIP/NPM caches, no `PYTHONPATH`); `sourceDir` copied in as `src/` (paths inside the DSH profile are refused).
2. **run** — `installCmd` once, then `runCmd` `runs` times (1–10, default 3), each step timed with tailed stdout/stderr evidence; optional `watchGpu` snapshots VRAM.
3. **analyze** — failures classified by fingerprint (missing module / port / OOM / disk / permission) with evidence and proposed fixes, **reported to you**.
4. **fix** — only the fixes **you approved** (run/file/note; file paths escaping the sandbox are refused).
5. Loop back to run → analyze until clean, then **export** the verified product to a real directory outside the sandbox.

Isolation boundary, stated plainly: **the sandbox isolates files, environment and processes — it is not a VM**; the GPU and OS are shared. `status` lists trials; `cleanup` deletes a sandbox; trial metadata lives in plugin memory (the on-disk dirs remain after a restart).

## Injection safety (incident lessons)

Session persistence hard-validates every message re-emitted as a `user/message` event. Two incidents corrupted sessions because an injected notice was missing `source` first and `id` second. Every notice is now built by `buildNotice()` (valid producer-owned source + a fresh `id` + text blocks) and must pass the full `isValidProducerMessage()` shape check before injection — anything invalid is refused and counted as `injectBlocked`, never written to the session (tests 22–24 cover source, id, and block-level guards). The monitor prefers the host `ctx.setInterval` and falls back to the Node global `setInterval` when the host API never fires (`monitorArmed` shows which one is active).

## Limitations

- The GPU check needs `nvidia-smi` and the system check needs PowerShell; each skips (and says so) when missing.
- Stuck jobs are detected by age only; error fingerprints cover the common categories only.
- Recent changes / errors / trial metadata live in memory and reset on host restart.
- Monitor alerts are delivered to live agents via inbox injection; with no active conversation nothing pops up.
