# DSH安全卫士

新增/升级能力 → 自动体检 → 能修自动修,修不了附原因。部署前查显存,新东西先沙箱试跑。

- **自动体检**:14 项检查(显存、任务、插件、版本通道、系统资源、错误指纹、端口、电源计划……),见下表
- **部署盯梢**:部署窗口内每 2 秒采显存、每 20 秒深扫;窗口外每 5 分钟轻量心跳巡检,只提醒不动手
- **试跑沙箱**:`safe_trial_run` 把新装/新写的东西隔离跑几遍,只修你批准的修复,干净了才交付

## 检查项一览

| 检查 | 盯什么 | 阈值 / 触发 |
| --- | --- | --- |
| 显存 | `nvidia-smi` 占用率(多次采样,判据取最坏一次)、温度、驱动/显卡型号、利用率/风扇/功耗、按进程拆分的大户 | 占用 ≥85% 警告,≥95% 严重;温度 ≥92°C 严重;风扇转速 0 且高温 → 警告;线性回归斜率 ≥2%/分钟且持续 60 秒以上 → 报上升趋势 |
| 常驻模型进程 | 进程名单里的 ollama/llama 系列进程(可配 `patterns`) | 常驻且占用 ≥80% → 提醒先卸载(小卡桌面共享显存,再跑图可能黑屏);`fix:true`+`gpu.resident.autoStopOnFix` 代执行优雅卸载:ollama 系跑 `ollama stop`,其他同名进程优雅 taskkill(绝不强杀) |
| 部署就绪度 | 剩余显存与系统内存(两者取更差) | GO(两者都够)/ CAUTION / **STOP**(任一不足:禁止部署,先腾资源);其他持有者进程先列名单问用户再停 |
| 卡死任务 | 后台任务运行时长 | >`warnMs`(5 分钟)警告,>`killMs`(15 分钟)严重;`expectedLongLabels` 白名单里的长任务(如「build」)跳过不报 |
| 插件健康 | 激活状态 | `failed` 报问题;`pending` 超过 60 秒(`pendingGraceMs`)才提醒,刚开机的一时 pending 不打扰 |
| 版本通道 | profile 里实际解析出的 `@deepseek-ai` 包版本 | 任何 alpha/beta/rc 或混通道 → 严重(forge 事故指纹);只报告不动包 |
| 核心插件链 | storage / workspace / session / domain / gateway | failed 或"禁用+兼容性诊断" → 严重;仅禁用无诊断 → 视为你有意为之(info,不打扰) |
| 待重启变更 | 安装结果 `restart-required` | 记录并提醒:重启后复查,验证通过前别拆隔离/备份 |
| 系统资源 | PowerShell 双采样快照(间隔 1.5 秒):内存/CPU/提交内存(页面文件)/各盘剩余/大户进程 top15 | 均值 ≥85% 警告,**两次采样都** ≥95% 才严重(滤掉瞬时毛刺);盘剩余 <15% 警告 <8% 严重;大户进程只有系统内存同时吃紧才报严重,否则降级为警告;只报告,永不自动删文件/杀进程 |
| 错误指纹 | 最近 20 分钟工具失败记录 | 10 类指纹:OOM/端口/磁盘满/权限/缺依赖/超时/证书/DNS/编码/文件不存在;按结构化失败信号判定(成功但文本含"out of memory"不算);同一指纹的即时通知有 10 分钟冷却,不刷屏 |
| 失败死循环 | 同工具同指纹反复失败 | 自上次成功以来 ≥`loopThreshold`(3)次 → 判死循环;该工具一旦成功,计数窗口清零 |
| 端口占用 | `netstat` 监听列表 + `tasklist` 进程名,对照 `ports.watchPorts` | 被盯端口已被占用 → 警告(绑定该端口的服务会撞 EADDRINUSE),附持有者与处置建议;平时只展示信息 |
| 电源计划 | `powercfg` 活动方案与待机/休眠超时 | 待机/休眠超时短于 30 分钟且**正有后台任务在跑** → 警告(Windows 睡眠会挂起甚至杀死长任务);没有长任务时不打扰 |
| 卫士自健康 | 运行时长、tick/事件/提醒/自动修复计数、GPU 采样成功率、监测器是否武装 | 如实报告,异常时提示 |

没有 NVIDIA 显卡时显存检查自动跳过并说明;没有 PowerShell 时系统检查同样跳过。

## 自动修复原则

- **总在执行(非破坏性)**:激活失败的插件自动禁用,避免反复报错。
- **仅 `fix:true` 才执行(破坏性,默认全关)**:杀卡死任务、杀占显存进程、杀超阈值大户进程——可能毁掉进行中的工作,故默认不动手。
- **永不自动修**:内存/磁盘问题(不替你删文件)、版本通道、核心插件链——报原因,你决定。

## 配置

「设置 → 插件」中可改,默认值:

```json
{
  "gpu":    { "enabled": true, "warnUsedPct": 85, "criticalUsedPct": 95, "tempWarnC": 85, "tempCriticalC": 92, "autoKill": false,
              "samples": 3, "sampleIntervalMs": 700,
              "trend": { "minSpanMs": 60000, "minSlopePerMin": 2 },
              "resident": { "enabled": true, "warnAtPct": 80, "patterns": ["ollama", "llama"], "autoStopOnFix": false } },
  "deploy": { "enabled": true, "goFreePct": 25, "stopFreePct": 10, "ramGoFreePct": 15, "ramStopFreePct": 8 },
  "stuckJobs": { "enabled": true, "warnMs": 300000, "killMs": 900000, "autoKill": false, "expectedLongLabels": [] },
  "plugins": { "enabled": true, "autoDisableFailed": true, "pendingGraceMs": 60000 },
  "monitor": { "enabled": true, "intervalMs": 2000, "deployWindowMs": 600000, "heavyEveryNTicks": 10,
               "idleHeartbeatMs": 300000, "alertCooldownMs": 600000 },
  "installGuard": { "enabled": true, "flagPrerelease": true, "warnCoreChainDisabled": true, "trackRestartPending": true },
  "system": { "enabled": true, "samples": 2, "sampleIntervalMs": 1500,
              "ram": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "cpu": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "pagefile": { "warnUsedPct": 85, "criticalUsedPct": 95 },
              "disk": { "paths": ["C:", "D:"], "warnFreePct": 15, "criticalFreePct": 8 },
              "processes": { "warnWorkingSetMb": 6144, "criticalWorkingSetMb": 10240, "allowedNames": [], "autoKill": false } },
  "errors": { "enabled": true, "notifyOnCritical": true, "loopThreshold": 3,
              "windowMs": 1200000, "notifyCooldownMs": 600000 },
  "ports": { "enabled": true, "watchPorts": [] },
  "power": { "enabled": true, "minStandbyMin": 30, "minHibernateMin": 30 },
  "trial":  { "enabled": true, "sandboxRoot": "", "exportsRoot": "", "defaultRuns": 5, "maxRuns": 20,
              "runTimeoutSec": 180, "installTimeoutSec": 600, "gpuLeakWarnMiB": 200 },
  "self":   { "enabled": true }
}
```

`capability_safety_check` 参数:`gpu / stuck / plugins / versions / coreChain / system / errors / self / ports / power`(传 false 跳过)+ `fix`(true 才启用破坏性修复)。

## 试跑沙箱(先试后信)

`safe_trial_run` 五步流水线,由插件自己跑完:

1. **create** — 沙箱独立目录;python 项目自动建 venv;环境清洗(私有 HOME/TEMP/PIP/NPM 缓存,清 `PYTHONPATH`);`sourceDir` 复制为沙箱内 `src/`(位于 DSH profile 内的会被拒绝)。
2. **run** — 先跑一次 `installCmd`,再把 `runCmd` 跑 `runs` 遍(1–20,默认 5),每步超时+留证;可选 `watchGpu`:每个阶段(前后/每次运行)连续采样显存,峰值+结束时比开始多 >200 MiB 报疑似泄漏。
3. **analyze** — 按指纹分类失败(缺模块/端口/OOM/磁盘/权限/超时/证书……),给出证据与拟修复方案,**汇报给你**;`spec.expect` 可声明退出码/必须出现/不得出现的输出,不满足直接判失败;附每遍时长统计与总判定(clean / flaky / failed)。
4. **fix** — 只执行**你批准**的修复(run/file/note 三型,file 逃逸路径被拒绝)。
5. 回到 run → analyze 循环直到干净,最后 **export** 把验证过的成品复制到沙箱外的真实目录交付,同时写一份 `trial-report.json` 验收清单(判定、时长、逐遍结果)。

隔离边界:**隔离的是文件、环境与进程,不是虚拟机**——GPU 与操作系统共享。`status` 查看、`cleanup` 删除沙箱;试跑元数据存内存,应用重启即失(磁盘目录仍在)。

## 注入安全(事故教训)

会话持久化对注入消息做硬性校验。两次事故分别由注入消息缺 `source`、缺 `id` 引起,各写坏 7 个会话。现在所有注入都由 `buildNotice()` 统一构造(合法 source + 每次随机的 `id` + 文本块),注入前 `isValidProducerMessage()` 做完整形状自检,任何一项不过就**拒绝注入并计数**——宁可静默,绝不写坏会话(测试 22–24 覆盖)。

## 限制

- 显存检查依赖 `nvidia-smi`、系统检查依赖 PowerShell、端口检查依赖 netstat/tasklist、电源检查依赖 powercfg,缺失时跳过并说明。
- 卡死判断只按运行时长(可用 `expectedLongLabels` 豁免);错误指纹覆盖 10 个常见类别,无法穷尽。
- 最近变更/错误/试跑元数据存内存,主机重启后清空。
- 监测提醒走收件箱注入,没有活跃对话时不弹出。
