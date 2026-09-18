# 万龙控制面板 —— 架构说明

一个 Electron 桌面面板，用来管理**模拟器多实例**（默认 **MuMu**，也支持雷电），并在每个实例上跑**基于截图 + 模板匹配**的自动化脚本，服务于多账号并发挂机。

本文件是给后续开发者（人或 agent）的地图。所有结论都来自本机实地实测，不是推断。

---

## 1. 一句话数据流

```
mumutool info all ──► 实例注册表(adb_port 动态) ──► adb connect 127.0.0.1:<port> ──► 规范 serial
                                                                                        │
                                                                                        ▼
                    ┌────────────────── utilityProcess（每实例一个）──────────────────┐
                    │  adb exec-out screencap (raw RGBA, ~300ms)  ← 全管线 96% 的耗时 │
                    │        │                                                        │
                    │        ├─► 路A 预览: sharp resize720 + jpeg(~10ms/41KB) ────────┼──► MessagePort ──► 渲染进程 canvas
                    │        │                                                        │
                    │        └─► 路B 匹配: 灰度+降采样(2ms) → opencv matchTemplate(5ms)│
                    │                     │                                           │
                    │                     ▼                                           │
                    │            脚本引擎决策 → adb input tap/swipe/text ──────────────┤
                    │            日志批量(100ms 一批) ────────────────────────────────┼──► MessagePort ──► 渲染进程虚拟列表
                    └────────────────────────────────────────────────────────────────┘
                                          │ 状态回报 / 落盘请求
                                          ▼
                                   主进程（只做编排 + 窗口 + IPC）
```

**关键预算（每实例每周期）**：截图 ~300ms（720p 实例约 100ms） + 预处理 ~2-7ms + 4 个模板 ROI 匹配 ~5ms ≈ **330ms ≈ 3fps**。
想提速唯一有效的方向是截图，**不要再去优化匹配那 5ms**。

---

## 2. 进程模型

| 进程 | 跑什么 | 不许跑什么 |
|---|---|---|
| **主进程** `out/main/index.js` | 窗口、IPC 路由、设置/账号/模板/脚本的磁盘读写、mumutool 调用、实例状态轮询、utilityProcess 池编排、日志落盘 | ❌ 截图循环、❌ 模板匹配、❌ 脚本执行。实测主线程跑一次识别，事件循环最大卡顿 71.8ms，面板肉眼掉帧 |
| **utilityProcess** `out/main/runner.js`（每个正在跑脚本的实例一个） | 截图、sharp、opencv 匹配、脚本引擎、adb 输入注入 | ❌ DOM、❌ WebCodecs（纯 Node 环境） |
| **preload** `out/preload/index.cjs` | 暴露 `window.api`、转发 MessagePort | ❌ 任何业务逻辑 |
| **渲染进程** | React + antd 面板 UI | ❌ 直接调 adb / fs / child_process（sandbox 下也调不到） |

### 为什么是 utilityProcess 而不是 worker_threads
- 脚本崩溃/死循环只炸掉一个账号，不影响别的实例。
- 能被 `child.kill()` 硬停（跑飞的 worker thread 停不干净）。
- opencv 的 WASM 堆各自独立（每个约 100MB，只涨不缩）。
- `MessagePortMain` 转交渲染进程是 utilityProcess 的一等公民能力。

### 为什么日志/预览走 MessagePort 而不是 ipcRenderer
所有流量经主进程中转会让 main 变成瓶颈并卡住窗口。MessagePort 让 worker ↔ renderer **直连**，
支持 Transferable ArrayBuffer 零拷贝。实测 200 条消息 525ms（受 setInterval 下限限制，不是端口瓶颈）。

**★ 两个已实测的硬坑，改代码时别踩回去：**
1. `sandbox: true` 时 preload **必须是 CommonJS**。`electron.vite.config.ts` 里强制 `format:'cjs'` + `.cjs` 后缀，
   主进程的 preload 路径也必须写 `.cjs`。否则 `window.api === undefined`。
2. **MessagePort 不能穿 contextBridge**（会被克隆成失去方法的代理，报 `port.start is not a function`）。
   preload 只能 `window.postMessage(..., e.ports)` 转发，渲染进程在主世界 `window.addEventListener('message')` 接。

---

## 3. 目录与模块职责

```
src/
├─ shared/          ★ 契约层。四端共用，唯一事实来源。不得有任何副作用（禁 import electron/fs/sharp）
│   ├─ constants.ts   路径、参考分辨率、阈值、目录约定、坐标换算函数
│   ├─ domain.ts      MumuInstance / DeviceInfo / Account / AppSettings / HealthReport
│   ├─ vision.ts      RawFrame / PreparedFrame / TemplateDef / TemplateSet / MatchResult
│   ├─ script.ts      脚本 DSL（Condition / ScriptStep / ScriptDef）+ 执行模型（RunSnapshot / LogEntry）
│   ├─ ipc.ts         ★ IPC 路由表 IpcRoutes + 推送事件 IpcEvents + window.api 形状
│   ├─ worker.ts      utilityProcess 三条链路的消息协议
│   ├─ errors.ts      ErrorCode 枚举 + AppError + 跨边界序列化
│   ├─ schemas.ts     zod 运行时校验（mumutool 信封、账号文件、脚本、模板、设置）
│   ├─ defaults.ts    默认设置、空脚本、makeId
│   ├─ alerts.ts      告警 / 推送模型、Telegram 配置（★ 含 token 的类型只在主进程用）、formatCst
│   ├─ scheduler.ts   ETA 调度状态与 scheduler:* 通道
│   ├─ bot.ts         Telegram 机器人：动作枚举、菜单按钮、回调数据、BotActionPort、bot:* 通道
│   ├─ stats.ts       数据统计：北京日期键 cstDateKey、DailyStats 日桶、StatsEvent、stats:* 通道
│   └─ resources.ts   资源统计快照 ResourceSnapshot、中文金额 parseCnAmount / formatCnAmount
│
├─ main/
│   ├─ index.ts       app 生命周期 + 窗口                            【模块 e】
│   ├─ ipc.ts         类型安全的 handle() / emit() 包装（已完成）     【模块 e】
│   ├─ config.ts      设置加载/保存、路径解析、环境自检              【模块 e】
│   ├─ mumu/          模拟器驱动层（driver.ts 契约）+ 实例注册表、状态轮询   【模块 a】
│   │    ├─ mumuwin/    MuMu 驱动（Windows，MuMuManager.exe）：cli.ts / parse.ts / detect.ts / index.ts ← **当前默认**
│   │    ├─ ldplayer/   雷电驱动（Windows）：cli.ts / parse.ts / detect.ts / index.ts
│   │    ├─ console.ts  两个 Windows 驱动共用的控制台工具（GBK/UTF-8 解码、退出码换算）
│   │    └─ instances.ts + cli.ts   MuMu Pro 驱动（macOS，原实现）
│   │    ★ 目录名 mumu 是历史遗留；按 AppSettings.emulator 选驱动（`mumu` 在 Windows 落到 mumuwin/、
│   │      在 macOS 落到 instances.ts），上层只认 EmulatorDriver
│   ├─ adb/           serial 管理、命令执行、截图、输入、应用管理    【模块 b】
│   ├─ store/         账号 / 模板库 / 脚本 / 日志的磁盘读写          【模块 d】
│   ├─ orchestrator/  utilityProcess 池、MessageChannel 编排         【模块 d】
│   ├─ game/          《万龙觉醒》自动采集：G0~G16 状态机 + 接线层   【功能块，见 README 第 6 节】
│   │    └─ launch.ts   冷启动恢复：游戏没在前台就用 **monkey** 拉起并等到前台（am start 对本游戏无效）
│   │    └─ resources/  「道具 → 资源统计」表：预检 → 导航 → 读表 → 还原   【见 README 第 11 节】
│   ├─ scheduler/     ETA 记账、定时唤醒、queueFreeHook、exclusive() 借锁、onAutoChanged【见 README 第 6 / 11 节】
│   │    └─ suspendForScript()  ★ 为脚本让路（先礼后兵）：任务计划器启动执行前调它
│   ├─ plan/          任务计划：账号勾选脚本 + 运行时间 → 到点入队 → 抢占 → 执行 → 记账【见 README 第 13 节】
│   │    ★ 只编排，不碰 adb / 不做视觉；执行仍然交给 orchestrator 的 utilityProcess
│   ├─ bot/           机器人动作层 createBotActions（Electron 无关，deps 注入）+ bot:* 通道【见 README 第 11 节】
│   ├─ stats/         数据统计：reduce（纯函数）/ store（日桶文件）/ StatsCenter 日切定时器【见 README 第 11 节】
│   ├─ ai/            AI 顾问：认不出界面时问视觉大模型（OpenAI 兼容）→ 白名单点击 → 复验 → 自学关闭按钮模板【README 第 12 节】
│   └─ alerts/        异常检测 → 自动暂停 → Telegram 推送 / 机器人通道 【功能块，见 README 第 7 节】
│        ├─ detect.ts   只数数（连续失败 / 采样失败 / 长时间停滞），不写盘不发通知不关调度
│        ├─ freeze.ts   卡死看门狗：帧指纹比对（纹丝不动）/ 截图连续失败 → 判定 + 重启熔断；不截图不重启【README 7.9】
│        ├─ freezeRecovery.ts 卡死恢复流程：重启实例 → 等 Android → 重连 adb → 等开机 → monkey 拉起 → 等主界面（纯逻辑，deps 注入）
│        ├─ kicked.ts   第二层顶号识别（预留；模板缺失时静默降级，绝不抛）
│        ├─ center.ts   只做动作：暂停实例 / 落盘暂停态 / 推给面板 / 交给推送
│        ├─ notifier.ts 配置 + 三道闸（开关/订阅/冷却）+ 多通道分发；**不认识「暂停」**
│        ├─ telegram.ts 一条通道（sendMessage / sendPhoto multipart）；**不认识「实例/调度器」**。★ 持含 token URL 的地方
│        ├─ telegramBot.ts getUpdates 长轮询、菜单键盘、命令 / 按钮 / 回调 → BotActionPort.perform
│        └─ store.ts    alerts.json 读写（★ 里面有凭据，报错信息只写路径不写内容）
│
├─ vision/           视觉引擎（纯计算，无 IO 依赖，主进程和 worker 都能 import）【模块 c】
├─ worker/           脚本执行器（跑在 utilityProcess 里）            【模块 d】
├─ scripts/          内置示例脚本（游戏装好后往这里加）             【模块 d】
├─ preload/          window.api + MessagePort 转发（已完成）         【模块 e】
└─ renderer/         React + antd 面板 UI                            【模块 f】
     └─ features/blocks/  可视化脚本编辑器：块卡片 + 「从画面截取 → 直接成块」【见 README 第 5 节】
        ★ 纯逻辑（块树操作 + DSL ⇄ 中文块目录）在 src/shared/blocks.ts，能被离线自检直接跑
```

---

## 4. 三条铁律（违反了整个系统就会坏）

### 铁律一：坐标只活在「参考分辨率」空间
所有模板像素、所有 ROI、脚本里写的每一个 x/y，都在 `REF_WIDTH × REF_HEIGHT`（默认 2560×1440）里。
只有真要 `adb input tap` 时才用 `refToDevice()` 换算到设备真实像素。

- 设备分辨率 == 参考分辨率时走自写整数降采样（**2.1ms**）；不等时退回 sharp cubic（**64ms**，慢 30 倍）。
  → **强烈建议把所有实例开成同一分辨率**，让快路永远命中。
- 反例实测：1920 下截的模板不做归一化直接丢到 2560 画面上，分数只有 0.62 且定位偏移；加归一化立刻回到 1.0000。

### 铁律二：分辨率只信 screencap 头部
`wm size` 实测报 `1440x2560`（物理竖屏），而实际画面是 `2560x1440`（`mRotation=ROTATION_90`）。
**照用 wm size 会让所有模板全错位。** 每帧都读 screencap 头部的 w/h。

### 铁律三：serial 永远是 `127.0.0.1:<adb_port>`，永远带 `-s`
- MuMu：`adb_port` 每次从 `MuMuManager info`（Windows）/ `mumutool info all`（macOS）现读，**绝不推算**
  （两个平台的实例 0 都是 16384，不是 5555，尽管 5555 也在监听；Windows 上停机实例根本没有这个键）。
- 雷电：端口是固定公式 **`5555 + 2·index`**（`list2` 不报端口；实测实例 1 由 Ld9BoxHeadless 监听 5557，
  ldconsole 对不存在的 index 99 也报 `emulator-5752` = 5554+2·99）。驱动按公式给，adb connect + get-state 验证。
- 两家模拟器 adb 都会自动扫出一个 `emulator-XXXX`（MuMu 是 5554，雷电实例 1 是 5556），与 `127.0.0.1:<port>`
  是同一台机器的两个 transport。`adb disconnect` 清不掉（3 秒内自动扫回）。
- 结论：代码里把 `emulator-*` 当作不存在，所有命令强制带 `-s 127.0.0.1:<port>`。

---

## 5. 各层的关键实测约束

### 5.1 模拟器驱动层（模块 a）：MuMuManager / ldconsole（Windows）、mumutool（macOS）

驱动契约在 `src/main/mumu/driver.ts`：list / open / close / restart / create / clone / remove / config / rename / waitReady。
主进程按 `AppSettings.emulator` 调 `configureEmulator()` 切换，注册表与 IPC handler 只认这个接口。
**默认驱动是 `mumu`**（`defaultEmulatorKind()` 两个平台都返回它）；雷电要用户在「设置」页显式选。

**MuMu（`src/main/mumu/mumuwin/`，Windows，2026-09-14 真机实测 6.6.4.0）**
- 安装目录靠探测：`WL_MUMU_DIR` → 卸载注册表 `HKLM/HKCU\...\Uninstall\MuMuPlayer[-12.0]\InstallLocation`
  → 常见目录 → 正在跑的 MuMu 进程路径往上一级。可执行文件在 `nx_main\`（新一代 6.x）或 `shell\`（MuMu 12）。
  探到后回填 settings.json（`src/main/config.ts` 的 `autofillEmulatorPaths`，**每次保存设置也会跑**，
  所以在设置页切换模拟器种类后路径会自动换成对应那一家的）。
- **输出是 JSON（UTF-8）**：`info -v all` 是「以 index 字符串为键」的对象，`info -v N` 是单个对象。
  停机实例**没有** `adb_port` / `pid` / `player_state` / `launch_err_*` 这些键。
- **错误语义比雷电干净**：业务错误 `{"errcode":-200,"errmsg":"player index not found"}` 且**退出码 = errcode**；
  命令拼错打整段用法文本、退出 -1。`judgeMumuWinOutput()` 一个函数收口：用法文本 → MUMU_CLI_USAGE，
  errcode -200 / “player index not …” → MUMU_INSTANCE_MISSING，其余 errcode → MUMU_API_ERROR。
- 状态映射：`is_process_started` + `is_android_started` 两个布尔量 →
  没起 + `error_code`/`launch_err_code` 非 0 = error；没起 = stopped；起了没就绪 = starting；都真 = running。
- 端口由 info 动态给（铁律三）。分辨率靠 `setting -v all -k resolution_*` 另读一次，带 30 秒缓存，
  读失败不影响列表（只是没有「与参考分辨率不一致」的提示）。
- **配置读写都可用**：`setting -v N -k 键 -val 值`（可多组）。面板的友好键与雷电同名
  （resolution / cpu / memory / …），另允许直接写原始键；★ 分辨率必须同时把 `resolution_mode` 设成 `custom`，
  只改三个 `*.custom` 值不生效。内存按 GB 存（面板填 MB，驱动换算）。
- create / clone / delete 用「列表差集」确认结果（`clone` 成功只回 `{"errcode":0}`，不报新 index）。
  `control -v N launch` 1.8s 返回，约 8s 后 `is_android_started` 变 true。

**雷电（`src/main/mumu/ldplayer/`，2026-09-14 真机实测 14.0.26.1）**
- 安装目录靠探测：`WL_LDPLAYER_DIR` → 注册表 `HKCU/HKLM\SOFTWARE\leidian\LDPlayer*\InstallDir` → 常见目录；
  同级的 `ldmultiplay` / `wujie` 键不是模拟器本体，按键名过滤。探到后回填 settings.json（`src/main/config.ts`）。
- `list2` 是 CSV（10 列：index,title,top_hwnd,bind_hwnd,android_started,pid,vbox_pid,width,height,dpi；雷电 9 只有 7 列），
  标题可含逗号，解析器从两端切。状态映射：pid 有效 + android_started → running；pid 有效但没起 → starting；否则 stopped。
- **退出码不可靠**：`quit/reboot/rename` 不存在的实例打 `player don't exist!` 退出码 -1001，`runapp` 打同样的话退出码却是 0，
  `modify` 不存在的实例**静默成功**，`launch` 不存在的实例打整段用法文本。所以成败看「退出码 + 错误文本」两路，
  针对实例的命令先 `list2` 确认存在。
- **输出是 GBK**（系统 ANSI 代码页），先 utf8 严格解码失败再 gbk（`decodeConsoleText`）。
- 就绪只有 `android_started` 一个信号；`launch` 立刻返回，画面要等它变 1。
- 端口 `5555 + 2·index`（铁律三）。分辨率 `list2` 直接给，面板据此标出「与参考分辨率不一致」。
- create / clone / remove（`add` / `copy --from` / `remove`）按「列表差集」确认结果。**真机实测（2026-09-14）：
  `add` / `copy` 的退出码是新实例的 index**（copy --from 0 退出 3、add 退出 4，输出为空），所以这两条只按文本判错
  （`assertLdTextOk`），退出码只用来在差集里挑出新实例；`remove` 成功退出 0。源实例正在运行时 `copy` 也能复制。
  `add` 出来的实例默认 1280×720@280。

**MuMu Pro（`src/main/mumu/instances.ts`，macOS 的 mumutool，与上面那套完全是两回事）**
- **只能用于实例生命周期**：`info / open / close / restart / create / clone / delete / export / import / move / show / hide / port`，以及 `config -s`（写入端）。
- **`control` 子命令族在 Mac 版整体是坏的**：`open_app / close_app / install_apk / uninstall_app / app_status / run_cmd / run_tool` 全部返回 `errcode 42000 invalidApi("/app")` 或 `invalidApi("/cmd")`。
  → **所有应用与输入操作一律走 adb，不要为 control 写任何 fallback 分支。**
- `config <device>` 的**读取端**也是坏的（errcode 42000 invalidApi("/setting")）。
- **错误语义**：业务错误时**退出码仍为 0**，必须解析 JSON 的 `errcode`；只有 CLI 用法错误才 exit 64 且输出非 JSON 到 stderr。
  → 用 `parseMumuEnvelope()`（`src/shared/schemas.ts`）统一处理。
- mumutool 的 HTTP 服务绑在 `0.0.0.0:21000`，局域网内任何人都能调。这是 MuMu 自身的问题，文档里提醒用户即可。

### 5.2 adb（模块 b）
- **截图必须用 `adb -s <serial> exec-out screencap`（裸 RGBA）**。
  - `screencap -p`（PNG）实测 **1087~1184ms**，设备端 PNG 编码就占 1000ms —— **慢 4 倍，绝对不要用**。
  - 裸格式：头部 16 字节（Android 10+；Android 9- 是 12 字节）= `uint32LE × 4: width, height, format, colorspace`，随后 `w*h*4` 的 RGBA8888。
    **用 `总长度 - w*h*4` 反推头长，别写死 16。**
  - 字节序实测就是 R,G,B,A，不需要 BGRA 交换。
  - 设备端 `gzip -1` 在游戏画面上反而更慢（302ms vs 277ms），默认不用。
- **Node 里必须 `spawn` + `Buffer.concat`，禁止 `exec`/`execFile`**：
  实测 exec 按 utf8 解码把 14,745,616 字节膨胀成 26,421,018 字节，**图像彻底损坏且不报错**。
- **退出码语义不统一**：`adb connect` 死端口时退出码仍为 0（要匹配文本 `/connected to/`）；
  `exec-out` 不透传远端退出码，`shell` 才透传。
- 单设备 screencap 吞吐被模拟器锁死在 **≈4.3 帧/秒**，并发不提速（但并发安全无损坏）。
- 输入注入约 17-20ms，其中 ~14ms 是 adb 进程启动开销 → **能合并进一次 shell 就合并**（5 次分开 103ms，合并 34ms）。
- **长按不要用 `input swipe`**（全程阻塞，duration=500 占 532ms）。用
  `input motionevent DOWN x y; sleep N; input motionevent UP x y` 塞进**同一次** shell。
- **`input text` 对中文是静默丢弃**（80 个汉字耗时 = 0 事件基线）。中文必须装 ADBKeyboard 走
  `am broadcast -a ADB_INPUT_B64 --es msg <base64>`。`cmd clipboard` 在这台 Android 12 上不存在。
- 并发调度：每设备一条 `concurrency=1` 的串行队列，设备之间并行，全局再加一个上限。

### 5.3 视觉引擎（模块 c）
- 库：`@techstark/opencv-js@5.0.0-release.1`（WASM，零原生编译）+ `sharp@0.35.4`（N-API，Electron 免 rebuild）。
- **三级流水线，不要写成 `findTemplate(screenshot, template)` 每次重新解码**：
  `prepareTemplate()` 启动时一次 → `prepareFrame()` 每帧一次 → `matchIn()` 每模板一次（ROI 下 0.1~1.5ms）。
- **唯一可用的 method 是 `TM_CCOEFF_NORMED`**。`TM_CCORR_NORMED` 实测对负样本给 0.986~0.9998，
  `TM_SQDIFF_NORMED` 给 0.967~0.992，**都毫无判别力**。
- **必须做模板方差守卫（std < 12 直接拒绝）**。这是最危险的坑：
  实测两个纯白模板对任意画面**恒定返回 1.0000 @ (0,0)**，天空渐变块（std=7.5）对完全不同的界面返回 0.9601。
  拦不住的话脚本会在完全错误的位置疯狂点击。真实游戏图标 std 在 40~43。
- **必须灰度**（彩色 3 通道 219ms vs 灰度 87ms）。**不需要边缘匹配**（TM_CCOEFF_NORMED 本身抗光照：
  压暗到 60% 分数仍 0.9998）。**不需要多尺度金字塔**（参考分辨率已消除尺度差异）。
- 热路径用**自写融合「灰度 + 整数点采样降采样」**（2560×1440→1280×720 只要 **2.1ms**），
  不要用 `sharp.resize().greyscale()`（64.1ms，慢 30 倍）。
- **sharp 陷阱**：raw 单通道 buffer 经 `.resize()` 会被静默提升成 3 通道，
  随后 `cv.Mat.data.set()` 抛 `RangeError: offset is out of bounds`。必须补 `.greyscale().toColourspace('b-w')`。
- **每个 Mat 必须 `.delete()`**（src / template / dst 三个，用 try/finally 包）。全屏结果 Mat 是 12.3MB，漏一个就稳定泄漏。
- **ROI 是最划算的加速**：全屏 62.33ms → 导航条 5.24ms → 单键 1.45ms（43 倍）。每个 step 都该带 ROI。
- worker 内务必 `sharp.concurrency(1)` + `sharp.cache(false)`，否则多进程之间 libvips 线程池抢核。

### 5.4 脚本引擎（模块 d）
- 脚本是**纯数据**（`ScriptDef`，可 JSON 序列化），不是代码。这样能可视化编辑、存盘、跨账号复用。
- 判定节奏按 **3fps** 设计。不要写需要 10fps 反应的逻辑。
- 每实例的抓图间隔加抖动错峰，单实例最小间隔 400ms。
- 实例并发上限 3~4（单实例实测 45.7% CPU + 1.2GB RSS，本机 10 核 24GB）。
- worker 池：如果将来改用 worker_threads 做识别，**固定 4 个共享池，绝不每实例一个**（每个约 100MB WASM 堆）。

---

## 6. 磁盘布局

运行数据根目录：生产 = `app.getPath('userData')`，开发 = `<工程根>/.wl-data`（已 gitignore）。

```
<dataDir>/
├─ settings.json                     面板设置（AppSettings）
├─ accounts/accounts.json            账号列表
├─ scripts/<scriptId>.json           用户自建脚本（ScriptDef）
├─ templates/<setId>/
│    ├─ manifest.json                TemplateSet（含每个模板的 bounds / defaultRoi / std）
│    └─ <templateId>.png             模板原图
├─ scheduler.json                    ETA 调度记账（每实例 auto 开关、队列占用、在途队伍）
├─ gather-state.json                 采集运行期状态（等级上限缓存 / 在途记账 / 退避档位）
├─ alerts.json                       ★ 告警配置（含明文 Telegram Bot Token）+ 推送冷却快照
├─ alerts-pauses.json                每实例暂停态（原因 / 时刻 / 现场截图路径 / 推送结果）
├─ stats/<YYYY-MM-DD>.json           数据统计日桶（北京日期切；保留 90 天；空桶不落盘）
├─ shots/alerts/inst<N>-<label>-<ts>.jpg  告警现场截图
├─ shots/bot/inst<N>-<date>-<time>.jpg    机器人「截图」留痕（shotPolicy = never 时不存）
├─ shots/<runId>/<seq>-<stepId>.jpg  截图留痕
└─ logs/
     ├─ app.ndjson                   面板级日志
     └─ <runId>.ndjson               每次执行的日志（每行一个 LogEntry）
```

随包分发的静态资源在 `resources/`（`apk/ADBKeyboard.apk`、`game-update/` 更新弹窗模板、品牌图等）。
`resources/templates/` 在仓库里是空的：打包时 electron-builder 把 `.wl-data/templates/`（已进 git 的模板集）复制进去，
首次启动由 `main/store/builtinTemplates.ts` 补进 `<dataDir>/templates/`（只增不改，用户改过的与 AI 自学的模板都不动）。

★ **`alerts.json` 是凭据文件**（Telegram Bot Token 存在里面）。整个 `<dataDir>` 已被 `.gitignore`
覆盖，`.gitignore` 里另外还单独兜了一道 `alerts.json` / `alerts-pauses.json`。
token 绝不过 IPC 桥、绝不进日志、绝不进报错 —— 出口纪律见 `CLAUDE.md` 项目约定第 15 条。

---

## 7. 扩展指引：游戏装好后，如何新增一个游戏脚本

假设要给「万龙觉醒」（`com.lilithgames.samo.android.cn`，Unity SurfaceView，控件树不可用）做「每日自动采集」。

### 第 1 步：统一实例分辨率
把所有实例开成同一分辨率（默认 2560×1440）。这样视觉引擎的快路（2.1ms 降采样）永远命中。
若要提速截图，可整体降到 1280×720（`adb shell wm size 1280x720` + `wm density 180`，
`wm size reset` 可完整还原），截图从 300ms 降到 100ms —— 但**所有实例必须一致**。

### 第 2 步：建模板集
面板 → 模板工具 → 新建模板集（绑定包名 `com.lilithgames.samo.android.cn`）。

### 第 3 步：截模板
1. 在面板里选中实例，点「抓一帧」。
2. 在画布上框选一个**纹理丰富**的小区域（游戏图标、带文字的按钮）。
3. 保存。**如果提示「方差过低」就换一块**——纯色块、渐变背景、半透明遮罩都会让匹配退化到必然误命中。
   实测可用的例子：底部导航栏按钮（半透明背景 + 会动的游戏世界 + 红点角标），正样本 0.975~0.985，负样本 0.45~0.53。
4. **给每个模板填 `defaultRoi`**（它出现的大致区域）。这是 43 倍的免费加速。

### 第 4 步：写脚本（纯 JSON，或用面板的脚本编辑器）
```jsonc
{
  "id": "samo_daily",
  "name": "万龙-每日采集",
  "version": "0.1.0",
  "packageName": "com.lilithgames.samo.android.cn",
  "templateSetId": "samo",
  "refWidth": 2560, "refHeight": 1440,
  "loop": true, "loopIntervalMs": 60000,
  "steps": [
    { "id": "s1", "kind": "launchApp", "cold": false, "name": "确保游戏在前台" },
    { "id": "s2", "kind": "waitFor", "waitMs": 60000, "pollMs": 1000,
      "cond": { "kind": "template", "templateId": "nav_alliance",
                "roi": { "x": 1200, "y": 1150, "w": 1360, "h": 290 } },
      "name": "等主界面加载" },
    // 关闭可能出现的弹窗：找不到也不算失败
    { "id": "s3", "kind": "tapTemplate", "templateId": "btn_close",
      "waitMs": 0, "onFail": { "kind": "continue" }, "name": "关弹窗" },
    { "id": "s4", "kind": "tapTemplate", "templateId": "nav_world",
      "roi": { "x": 1200, "y": 1150, "w": 1360, "h": 290 },
      "waitMs": 5000, "afterDelayMs": 1500, "name": "进世界地图" }
  ]
}
```

### 第 5 步：单实例试跑 → 看实时日志和预览 → 调 ROI/阈值
- 分数在 0.85 附近晃动 → 换更有纹理的模板，或缩小 ROI。
- 定位偏了 → 检查模板是不是在别的分辨率下截的（`authoredWidth` 是否正确）。
- 每步都要留痕时把 `shotPolicy` 临时设成 `always`，调完改回 `onFail`。

### 第 6 步：绑账号 → 多实例并发
账号页里把账号绑到实例，然后批量启动。注意实例数上限 3~4。

### 什么时候需要改代码而不是加脚本
- 需要读**动态数字**（资源量、倒计时）→ 模板匹配做不到。推荐做「0-9 十个小模板逐位切分匹配」
  （游戏是等宽字体，比 OCR 快得多且更准），而不是引 tesseract。这属于给模块 c 加能力。
- 需要看**动画/做快速时序判定** → 3fps 不够，届时再上 `@yume-chan/scrcpy`（纯 JS，只需随包带 scrcpy-server.jar）
  + 渲染进程 WebCodecs 硬解。**注意：scrcpy 流只能用于预览**（utilityProcess 没有 WebCodecs），
  模板匹配仍走 screencap —— 这正是预览管线和匹配管线从一开始就解耦的原因。
- 需要新的**动作原语**（多指手势等）→ 给 `ScriptStep` 加 kind，同时改 `schemas.ts` 和执行器。
  **不要为某一个游戏往 DSL 里加特化 step。**
