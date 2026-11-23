# 能力安全卫士

新增/升级能力 → 自动体检 → 能修自动修,修不了附原因。部署前查显存,新东西先沙箱试跑。

- **自动体检**:12 项检查(显存、任务、插件、版本通道、系统资源、错误指纹……),见下表
- **部署盯梢**:部署窗口内每 2 秒采显存、每 30 秒深扫,只提醒不动手
- **试跑沙箱**:`safe_trial_run` 把新装/新写的东西隔离跑几遍,只修你批准的修复,干净了才交付

## 检查项一览

| 检查 | 盯什么 | 阈值 / 触发 |
| --- | --- | --- |
| 显存 | `nvidia-smi` 占用率、温度、驱动/显卡型号、按进程拆分的大户 | 占用 ≥85% 警告,≥95% 严重;温度 ≥92°C 严重;采样持续上涨 ≥10 个百分点报泄漏/负载趋势 |
| 常驻模型进程 | 进程名单里的 ollama/llama 系列进程(可配 `patterns`) | 常驻且占用 ≥80% → 提醒先卸载(小卡桌面共享显存,再跑图可能黑屏);`fix:true`+`gpu.resident.autoStopOnFix` 代执行优雅卸载:ollama 系跑 `ollama stop`,其他同名进程优雅 taskkill(绝不强杀) |
| 部署就绪度 | 剩余显存与当前占用进程(任意模型/程序) | GO(空闲 ≥25%)/ CAUTION(10–25%)/ **STOP**(<10%:禁止部署,先腾显存);其他持有者进程先列名单问用户再停 |
| 卡死任务 | 后台任务运行时长 | >`warnMs`(5 分钟)警告,>`killMs`(15 分钟)严重 |
| 插件健康 | 激活状态 | `failed` 或长期 `pending` 报问题 |
| 版本通道 | profile 里实际解析出的 `@deepseek-ai` 包版本 | 任何 alpha/beta/rc 或混通道 → 严重(forge 事故指纹);只报告不动包 |
| 核心插件链 | storage / workspace / session / domain / gateway | failed 或"禁用+兼容性诊断" → 严重;仅禁用无诊断 → 视为你有意为之(info,不打扰) |
| 待重启变更 | 安装结果 `restart-required` | 记录并提醒:重启后复查,验证通过前别拆隔离/备份 |
| 系统资源 | PowerShell 快照:内存/CPU/各盘剩余/大户进程 | 内存 CPU ≥85% 警告 ≥95% 严重;盘剩余 <15% 警告 <8% 严重;只报告,永不自动删文件/杀进程 |
| 错误指纹 | 最近 15 分钟工具失败记录 | 跨命令识别 OOM/端口冲突/磁盘满/权限/缺依赖;按结构化失败信号判定(成功但文本含"out of memory"不算) |
| 失败死循环 | 同工具同指纹反复失败 | ≥`loopThreshold`(3)次 → 判死循环,附处置建议 |
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

`capability_safety_check` 参数:`gpu / stuck / plugins / versions / coreChain / system / errors / self`(传 false 跳过)+ `fix`(true 才启用破坏性修复)。

## 试跑沙箱(先试后信)

`safe_trial_run` 五步流水线,由插件自己跑完:

1. **create** — 沙箱独立目录;python 项目自动建 venv;环境清洗(私有 HOME/TEMP/PIP/NPM 缓存,清 `PYTHONPATH`);`sourceDir` 复制为沙箱内 `src/`(位于 DSH profile 内的会被拒绝)。
2. **run** — 先跑一次 `installCmd`,再把 `runCmd` 跑 `runs` 遍(1–10,默认 3),每步超时+留证;可选 `watchGpu` 记录显存前后。
3. **analyze** — 按指纹分类失败(缺模块/端口/OOM/磁盘/权限),给出证据与拟修复方案,**汇报给你**。
4. **fix** — 只执行**你批准**的修复(run/file/note 三型,file 逃逸路径被拒绝)。
5. 回到 run → analyze 循环直到干净,最后 **export** 把验证过的成品复制到沙箱外的真实目录交付。

隔离边界:**隔离的是文件、环境与进程,不是虚拟机**——GPU 与操作系统共享。`status` 查看、`cleanup` 删除沙箱;试跑元数据存内存,应用重启即失(磁盘目录仍在)。

## 注入安全(事故教训)

会话持久化对注入消息做硬性校验。两次事故分别由注入消息缺 `source`、缺 `id` 引起,各写坏 7 个会话。现在所有注入都由 `buildNotice()` 统一构造(合法 source + 每次随机的 `id` + 文本块),注入前 `isValidProducerMessage()` 做完整形状自检,任何一项不过就**拒绝注入并计数**——宁可静默,绝不写坏会话(测试 22–24 覆盖)。

## 限制

- 显存检查依赖 `nvidia-smi`、系统检查依赖 PowerShell,缺失时跳过并说明。
- 卡死判断只按运行时长;错误指纹只覆盖常见类别。
- 最近变更/错误/试跑元数据存内存,主机重启后清空。
- 监测提醒走收件箱注入,没有活跃对话时不弹出。
