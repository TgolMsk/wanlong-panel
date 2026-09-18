# CLAUDE.md —— 万龙控制面板 开发速查

Electron 面板，管理模拟器多实例（**Windows MuMu / 雷电**，macOS MuMu Pro）+ 截图/模板匹配自动化。详细架构见 `ARCHITECTURE.md`。

---

## ★ 当前主机：Windows 11 + MuMu 模拟器 6.6.4（2026-09-14 从雷电迁移，已真机验证）

工程最初在 macOS + MuMu Pro 上开发（下面「环境事实」一节保留了那台机器的数据），2026-09-14 上午移植到本机的雷电 14，
同日下午按用户要求**迁移到 MuMu**。模块 a 是驱动层（`src/main/mumu/driver.ts`），三个实现：
`ldplayer/`（雷电，Windows）、`mumuwin/`（MuMu，Windows，`MuMuManager.exe`）、`instances.ts`（MuMu Pro，macOS，`mumutool`）。
`AppSettings.emulator` 只有 `ldplayer` / `mumu` 两个值，`mumu` 在 Windows 上落到 `mumuwin/`。**本机现在用 `mumu`。**

| 项 | 值 |
|---|---|
| MuMu 安装目录 | `D:\tool\MuMuPlayer`（卸载注册表 `HKLM\...\Uninstall\MuMuPlayer\InstallLocation`；可执行文件在 `nx_main\`，MuMu 12 是 `shell\`） |
| MuMuManager / adb | `D:\tool\MuMuPlayer\nx_main\MuMuManager.exe`（版本 6.6.4.0）、`D:\tool\MuMuPlayer\nx_main\adb.exe`（adb 1.0.41 / **36.0.0**，比雷电的 34 新，两家 adb 混用会互相杀 server） |
| MuMu 实例 | **index 0「已登录」**（已装游戏、已登录，工作实例）；index 1「基础游戏包」= 复制用的基础实例；index 2「基础游戏包-1」是它的克隆 |
| adb 端口 | **由 `MuMuManager info` 动态给**（实例 0 = `127.0.0.1:16384`），只在实例启动后出现；绝不推算 |
| Android | **15**（SDK 35），型号 2201123C（小米 12 皮肤），2560×1440 @360（`resolution_mode` = tablet.1），`wm size` 报 1440x2560（竖屏物理尺寸，照旧只信 screencap 头部） |
| MuMuManager | JSON 输出（UTF-8）；`info -v all` ~75ms；业务错误 `{"errcode":-200,"errmsg":"player index not found"}` 且退出码 = errcode；命令拼错打用法文本、退出 -1 |
| 启动耗时 | `control -v 0 launch` 1.8s 返回，约 8s 后 `is_android_started` = true（Hyper-V 后端） |
| 配置 | `setting -v N -k 键 -val 值`（可多组，**读写都可用**）；分辨率要走 `resolution_mode=custom` + 三个 `*.custom` 键；`-aw` 列出可写键 |

```bat
:: MuMu 常用命令（PowerShell / cmd）
D:\tool\MuMuPlayer\nx_main\MuMuManager.exe info -v all                 :: JSON：{"0":{index,name,is_process_started,is_android_started,adb_port,pid,player_state,…},…}
D:\tool\MuMuPlayer\nx_main\MuMuManager.exe control -v 0 launch         :: 立刻返回；shutdown / restart 同
D:\tool\MuMuPlayer\nx_main\MuMuManager.exe setting -v 0 -k resolution_width -k resolution_height -k resolution_dpi
D:\tool\MuMuPlayer\nx_main\MuMuManager.exe clone -v 1                  :: 克隆基础实例，新实例名「基础游戏包-N」，不报新 index（用列表差集）
D:\tool\MuMuPlayer\nx_main\adb.exe connect 127.0.0.1:16384
```

命令行脚本**默认就是 mumu**，指定实例即可：`$env:WL_INSTANCE='0'; npm run live:probe`；要用雷电才设 `WL_EMULATOR=ldplayer`。
切换模拟器后实例序号的含义变了：调度器记账 / 告警暂停 / 采集状态都按序号存，切换时要清（README 1.2 末尾）。

## 上一台配置：Windows 11 + 雷电模拟器 14（2026-09-14 上午，仍可切回）

雷电驱动与以下事实原样保留，「设置」页把模拟器切回「雷电模拟器」并清空路径即可自动探测。

| 项 | 值 |
|---|---|
| 主机 | Windows 11 26200，i5-14600K / 48GB / RTX 5060，**Hyper-V/VBS 内核隔离开着**（雷电 14 兼容） |
| Node / npm | v22.23.2 / **10.9.8**（没有 npm 11 的 install-scripts，`npm ci` 直接可用；`npm run approve` 会自动跳过） |
| 雷电安装目录 | `D:\leidian\LDPlayer14`（注册表 `HKCU\SOFTWARE\leidian\LDPlayer14\InstallDir`，面板启动时自动探测并回填 settings.json） |
| ldconsole / adb | `D:\leidian\LDPlayer14\ldconsole.exe`、`D:\leidian\LDPlayer14\adb.exe`（adb 1.0.41 / 34.0.4，与 MuMu 同版本） |
| 目标实例 | **index 1「万龙1号」**（已装游戏、已登录）；index 0「万龙游戏」、index 2 停机 |
| adb 端口 | **5555 + 2·index**（实例 1 = `127.0.0.1:5557`）；adb 会顺手扫出 `emulator-5556`，照旧当它不存在 |
| Android | **14**（SDK 34），x86_64（abilist 含 arm64-v8a），型号 25019PNF3C，density 360 |
| screencap | **2560x1440**，format=1（RGBA_8888），16 字节头，**~360ms**（Mac MuMu 是 280ms） |
| `wm size` | `Physical size: 2560x1440`（雷电是横屏平板配置，没有 MuMu 那个 ROTATION_90 的坑，但代码照旧只信 screencap 头部） |
| ldconsole | `list2` 15ms；`getprop` 55ms；退出码不可靠（详见 `src/main/mumu/ldplayer/cli.ts` 文件头）；输出是 **GBK** |
| add / copy / remove | **`add` 与 `copy --from N` 的退出码 = 新实例 index**（建出 3 号就退出 3，不是错误！），`remove` 成功退出 0；都无输出。`add` 出来的实例默认 1280×720@280，面板新建时默认填 2560,1440,360 |
| 阵营 | 「万龙1号」是变体 A（法师）：`tpl_nav_city_toggle` 0.987、放大镜 0.978，Mac 上裁的 93 张模板**原样可用** |

真机验证结果（2026-09-14）：`live:probe` 7/7 符合；`live:panel` 队列 5/5、5 行倒计时与坐标全部读出（minScore 0.90~0.95）。
`live:run`（真派兵）**尚未跑过**，要跑之前先跟用户确认。

```bat
:: 雷电常用命令（PowerShell / cmd）
D:\leidian\LDPlayer14\ldconsole.exe list2                      :: index,title,top_hwnd,bind_hwnd,android_started,pid,vbox_pid,width,height,dpi
D:\leidian\LDPlayer14\ldconsole.exe launch --index 1           :: 立刻返回，Android 起来后 list2 的 android_started 才变 1
D:\leidian\LDPlayer14\ldconsole.exe quit --index 1
D:\leidian\LDPlayer14\ldconsole.exe modify --index 1 --resolution 2560,1440,360   :: 要重启实例才生效
D:\leidian\LDPlayer14\adb.exe connect 127.0.0.1:5557
D:\leidian\LDPlayer14\adb.exe -s 127.0.0.1:5557 exec-out screencap > f.raw
```

环境变量（命令行脚本用，面板不用）：`WL_EMULATOR=ldplayer|mumu`、`WL_LDPLAYER_DIR`、`WL_MUMU_DIR`、`WL_EMULATOR_CLI`、`WL_ADB`、`WL_INSTANCE=<index>`。

---

## 启动

```bash
npm ci               # 依赖（npm 10 直接可用；npm 11 再跑 npm run approve）
npm run dev          # 起 HMR + 拉起 Electron 窗口（用户点这一个就能看界面）
npm run typecheck    # tsc --noEmit（node + web 两套）
npm run build        # typecheck + electron-vite build
npm run dist:win     # electron-builder --win --x64（nsis + portable，未签名）
                     #   ★ GitHub 上也能打：推 v* 标签会触发 .github/workflows/release.yml 构建并建 Release（README「发布安装包」）
npm run dist:mac     # electron-builder --mac --arm64

npm run smoke        # 端到端冒烟（真机，只按 HOME/APP_SWITCH + 点一次空白处）
npm run check        # 全部离线自检（不碰模拟器、不发真实网络请求，801 项断言，约 1 分钟）
                     #   = check:ld(41) + check:mumu(65) + check:launch(22) + check:freeze(65) + check:level(64) + check:ai(76)
                     #   + check:sched(24) + check:gather(28，60 张真机截图回放)
                     #   + check:alerts(174) + check:bot(76) + check:stats(73) + check:resources(93)
                     #   ★ check:sched / check:gather 需要 gitignore 掉的 .tplkit/frames 真机截图，本机没有会报「找不到帧目录」
npm run check:mumu   # MuMu 驱动纯函数（Windows）：info JSON 解析 / 状态映射 / errcode 判定 / setting 参数 / 安装目录探测
npm run check:launch # ★ 冷启动恢复：游戏已在前台就绝不乱拉 / 没跑就 monkey 拉起并等前台 / 失败不抛（虚拟时钟）
npm run check:freeze # ★ 卡死看门狗 + 自动重启：帧指纹 / 阈值与熔断（虚拟时钟）/ 恢复流程每一步的成败 / 与真·调度器的接线不死锁
npm run check:level  # ★ 搜索等级记忆 + 下限状态机：滑杆上限按资源缓存 / 搜不出卡片立刻放宽 / 「F 级搜不到」跨轮记忆与作废 / 落盘往返（不需要真机截图）
npm run check:ld     # 雷电驱动纯函数：list2 解析 / 状态映射 / GBK 解码 / 成败判定 / modify 参数
npm run check:ai     # AI 顾问：配置三态 / 请求形状 / 失败分类 / ★ Key 泄露实测 / 限频 / ★ 端到端自学模板闭环（假 fetch + 假 IO + 合成帧）
npm run check:alerts # 异常检测/自动暂停/Telegram 推送 + 机器人通道（含 ★ token 泄露实测、sendPhoto 走 FormData）
npm run check:bot    # 机器人动作层（账号列表 / 截图 / 资源 / 暂停恢复 / bot:* 通道）
npm run check:stats  # 数据统计（北京日切三种宿主时区一致、暂停跨日切分、落盘读回）
npm run check:resources  # 资源统计识别（res_04_stats.png 8 格与真值逐格对照、假 IO 完整流程）
npm run live:probe   # 真机单帧模板打分（含负样本对照），不点任何东西
npm run live:panel   # 真机读一次「部队管理」面板
npm run live:run     # ★ 真机跑一整轮自动采集 —— 会真的派出一支采集队
npm run live:recheck -- 150   # 采样→等 150s→再采样，校验本地 ETA 递推
npm run live:sample -- 1        # 对某个实例现场跑一次调度器采样（会切界面开关面板，不派兵），看导航判据命中哪张模板
                                #   雷电不用给端口（按 5555+2·序号 自动算）；MuMu 要给：npm run live:sample -- 1 16416
npm run live:freeze -- 0        # ★ 真机验证卡死恢复链路：会真的重启实例 0 → 重连 adb → monkey 拉起 → 等主界面（5 秒倒计时可 Ctrl+C）
npm run tplkit -- alpha ...     # 多帧差分去底预览（透明底模板），save 作业写 diffFrames/diffTolerance
npm run icons                   # resources/icons/raw/{wood,gold,iron,mana}.* 白底原画 → 透明底 assets/resources/<type>.png（面板资源徽章）
```

**改了识别/采集/告警相关代码，提交前至少跑一遍 `npm run check`**（不碰模拟器，几秒钟）。
它在历史上抓出过 5 个「照着设计文档写就会踩」的真 bug，其中一个会让整条链路 100% 跑不起来。

**首次 clone 后的坑（npm 11.19 的 install-scripts 白名单）**：
npm 11 下 `npm install` 之后 esbuild 的 postinstall 不会自动跑，只打 warn。执行：

```bash
npm run approve      # scripts/approve.mjs：npm ≥ 11 才真的 install-scripts approve，npm 10 直接跳过
```

electron@44 **不再用 postinstall 下载二进制**，改成首次 `require('electron')` 时懒下载。
如果 `npm run dev` 报 "Electron failed to install correctly"，手动补：

```bash
node node_modules/electron/install.js
```

---

## 环境事实（macOS + MuMu Pro 时代，已实测，直接采信；Windows 主机见最上面那节）

主机 macOS darwin 25.6.0 / Apple Silicon，Node v26.8.1，npm 11.19.0。

### 可执行文件路径（PATH 里没有 adb，必须用绝对路径）

```
adb      = /Applications/MuMuPlayer.app/Contents/MacOS/MuMuEmulator.app/Contents/MacOS/tools/adb
mumutool = /Applications/MuMuPlayer.app/Contents/MacOS/mumutool     # 与同目录 mumu-cli 内容一致
```
adb server 已在 `127.0.0.1:5037` 运行。这两个路径的常量在 `src/shared/constants.ts`，可被设置覆盖。

### 设备参数（MuMu 实例 0）

| 项 | 值 |
|---|---|
| adb_port | **16384**（动态，每次从 `mumutool info all` 读，**绝不推算**） |
| 规范 serial | `127.0.0.1:16384` |
| Android | 12，arm64-v8a |
| `wm size` 报的 | 1440x2560（**竖屏，是错的，别用**） |
| **screencap 实际输出** | **2560x1440**（横屏，`mRotation=ROTATION_90`，**只信这个**） |
| density | 360 |
| 型号 | VER-AN00 |
| 已装游戏 | `com.lilithgames.samo.android.cn`（万龙觉醒，Unity SurfaceView，控件树不可用） |

⚠️ adb 会把实例的 5555 端口自动扫描成 `emulator-5554`，与 `127.0.0.1:16384` 是**同一台设备的两个 transport**。
不带 `-s` 的命令会报 `more than one device`。`adb disconnect` 清不掉（3 秒内自动扫回）。
**所有 adb 调用强制带 `-s 127.0.0.1:<adb_port>`，把 `emulator-*` 当作不存在。**

---

## 常用命令

```bash
ADB=/Applications/MuMuPlayer.app/Contents/MacOS/MuMuEmulator.app/Contents/MacOS/tools/adb
MUMU=/Applications/MuMuPlayer.app/Contents/MacOS/mumutool
S=127.0.0.1:16384

# 实例
$MUMU info all                  # {errcode, message, return:{count, results:[...]}}
$MUMU open 0 / close 0 / restart 0
$MUMU create --count 1 --type phone -s '{"vmCpuCount":4}'
$MUMU clone 0 / delete 1

# 连接
$ADB connect $S                 # 幂等；失败时退出码仍是 0，要匹配文本 /connected to/
$ADB -s $S shell getprop sys.boot_completed   # == 1 才算就绪

# 截图（★ 绝不加 -p）
$ADB -s $S exec-out screencap > /tmp/f.raw    # ~280ms, 14.7MB, 16 字节头 + RGBA8888
# $ADB -s $S exec-out screencap -p            # ✗ 1100ms，慢 4 倍，禁用

# 输入
$ADB -s $S shell "input tap 1893 1329"
$ADB -s $S shell "input tap 100 200; input tap 300 400"          # 合并省往返
$ADB -s $S shell "input motionevent DOWN 100 200; sleep 0.6; input motionevent UP 100 200"  # 长按
$ADB -s $S shell "am broadcast -a ADB_INPUT_B64 --es msg $(echo -n '中文' | base64)"        # 需 ADBKeyboard

# 应用
$ADB -s $S shell "pm list packages -3"
$ADB -s $S shell "dumpsys window displays | grep -m1 mCurrentFocus"    # 前台包名
$ADB -s $S shell "cmd package resolve-activity --brief <pkg> | tail -1"
$ADB -s $S shell "am force-stop <pkg>"
```

**zsh 陷阱**：`S="-s 127.0.0.1:16384"; $ADB $S shell ...` 在 zsh 下不做单词拆分，
adb 会报 `-s requires an argument`。Node 的 `spawn` 用数组传参不受影响。

---

## 项目约定（写代码前必读）

1. **`src/shared/` 是契约层**，四端共用。**不得 import electron / node:fs / sharp / opencv** —— 任何副作用都会污染渲染进程。
2. **坐标只活在参考分辨率空间**（`REF_WIDTH × REF_HEIGHT` = 2560×1440）。只有 `adb input tap` 前才用 `refToDevice()` 换算。
3. **serial 永远是 `127.0.0.1:<adb_port>`**。端口由驱动给：MuMu 每次从 `mumutool info all` 现读（绝不推算）；
   雷电按它自己的固定公式 `5555 + 2·index` 算（`ldAdbPort()`），并由 adb connect + get-state 验证。
4. **分辨率只信 screencap 头部**，不信 `wm size`。
5. **截图用 `exec-out screencap`（raw），不用 `-p`**；Node 里必须 `spawn` + `Buffer.concat`，**禁止 `exec`/`execFile`**（utf8 解码会损坏图像）。
6. **主进程不跑重活**。截图/匹配/脚本一律进 utilityProcess（`out/main/runner.js`）。
7. **实例管理只走驱动层的 CLI，其余一切走 adb。** MuMu 的 `control` 子命令族在 Mac 版全坏（errcode 42000）；
   雷电虽有 runapp / installapp / adb 子命令，但输出编码与退出码都不可靠，同样不用，不写 fallback。
8. **两家 CLI 的成败都不能只看退出码。** mumutool 业务错误时退出码仍是 0，看 JSON 的 `errcode`（`parseMumuEnvelope()`）；
   ldconsole 退出码时 0 时 -1001、还会静默成功，看「退出码 + `player don't exist!` + 用法文本」三条（`assertLdOk()`），
   且针对实例的命令先 `list2` 确认实例存在。子进程一律 `windowsHide: true`（否则 Windows 上每次轮询闪一个黑窗）。
9. **模板 std < 12 必须拒绝**（纯色模板会恒定返回 1.0000，让脚本乱点）。匹配 method 只能用 `TM_CCOEFF_NORMED`。
10. **每个 OpenCV Mat 必须 `.delete()`**，用 try/finally。
11. **preload 必须编译成 `.cjs`**（sandbox 要求），**MessagePort 不能穿 contextBridge**（用 `window.postMessage` 转发）。
12. **界面文案全部中文**，错误信息也要是能指导用户操作的中文。
13. **版本锁死**：`vite@^7`（electron-vite@5 不支持 vite 8）、`@vitejs/plugin-react@^5`、`typescript@^5.9`（TS 7 有 breaking change）。别升 latest。
14. 不引 Tailwind（会重置 antd 的基础样式）。UI 用 antd + 少量内联样式。
15. **★★ Telegram Bot Token 是凭据。** 它长在请求 URL 里（`https://api.telegram.org/bot<TOKEN>/sendMessage`），
    所以任何把 URL 带出去的动作都是一次泄漏。铁律：只存 `<dataDir>/alerts.json`；
    过 IPC 只送 `toAlertsConfigView()`（类型上就没有 `botToken` 键）；写日志只写 `redactAlertsConfig()`；
    每一处 `catch` 的第一件事是 `scrubSecret(describeThrown(e), token)`；抓异常**只取 message + cause，不取 stack**。
    改完推送相关代码必须跑 `npm run check:alerts`。

---

## 性能参考数字（别再重复测）

| 操作 | 耗时 |
|---|---|
| `exec-out screencap` raw @2560x1440 | **~280-300ms**（720p 实例约 100ms）；雷电 14 实测 **~360ms** |
| `ldconsole list2` / `adb devices` 往返（Windows） | 15ms / 21ms |
| `exec-out screencap -p` PNG | ~1100ms（禁用） |
| 自写 灰度+点采样降采样 1/2 | **2.1ms**（sharp.resize 要 64ms） |
| opencv matchTemplate 全屏灰度 1/2 | 22ms |
| opencv matchTemplate ROI（单键） | **1.45ms** |
| sharp resize720 + jpeg q70 | ~10ms / 41KB |
| adb input tap 单次往返 | 17-20ms（14ms 是进程启动） |
| 单实例一个完整周期 | **~330ms ≈ 3fps** |
| 单设备 screencap 吞吐上限 | ≈4.3 帧/秒（并发不提速） |
| 单实例跑 Unity 游戏 | 45.7% CPU + 1.2GB RSS + 3.6GB 磁盘 |
| 实例并发上限建议 | **3~4** |

---

## 自动采集功能块（`src/main/game/`）

面向《万龙觉醒》的原生流程，**不走脚本 DSL**。使用方式与完整踩坑清单见 `README.md` 第 6 节，
这里只列写代码时最容易踩回去的几条。

| 目录 | 职责 |
|---|---|
| `src/main/game/gather/` | G0~G16 主状态机。**端口化**：所有设备操作走 `GatherIo` 接口，不 import electron，能离线回放 |
| `src/main/game/vision/` | 采集专用的三个通用视觉能力：`matchAllInCrop`（多峰+NMS）/ `grayCropRef` / `sampleRgb` |
| `src/main/game/gatherRunner.ts` | 接线层：取 serial/模板/配置、`GatherRuntimeState` 落盘、派兵后回调 `noteDispatch` |
| `src/main/scheduler/` | ETA 记账、定时唤醒、`scheduler:*` IPC。队列有空位时调 `QueueFreeHook` 交给上面那条流程 |

### 十条铁律（每一条都是真机上踩出来的）

1. **卡片等级判据是 `>=` 不是 `==`。** 游戏返回「等级 ≥ 搜索值」的点。写成 `==` 会一直搜、永远不派兵。
2. **搜索面板会随分类整体左右平移**（搜索按钮中心 x = 464/855/1269/1697/2115）。
   面板内一切坐标必须由 `tpl_btn_search` 的命中中心推出来，换分类后**必须重新定位锚点**。
3. **「等级 N」标签随滑杆手柄移动**（每级 55.3px）。先用宽带 ROI 定位标签，再取它右侧的窄条读数字。
4. **「采集」按钮是编成模式下拉框，不是一键编成。** 弹出的菜单是模态的，会把下一次点击整个吃掉。
   G14 必须「点完复验、按钮还在就再点一次」，且复验是硬前置（确认按钮消失才算成功，绝不会派出两支队）。
5. **世界地图判据不能只用放大镜。** 它的镜片半透明，分数随地形漂移（0.981 → 0.794）。
   用 `navigation.ts` 的 `WORLD_MAP_TEMPLATES`（城堡 A/B + 放大镜）；城内判据用 `CITY_TEMPLATES`（地图钮 A/B）。
   ★ 阵营变体：法师=主号（A）、兽族=huadong（B）、精灵暂不适配。接新阵营号先补两态导航按钮的变体模板。
   ★ 透明底模板（用户规矩：类似素材一律去底再匹配）：圆环/镂空/半透明/压在地形上的控件，用 2~3 帧差分去底
     （`vision/alpha.ts` buildDiffAlpha → PNG 带 α → `prepareTemplate` 生成掩码 → `matchIn` 带 mask 匹配）。
     tplkit save 作业写 `diffFrames` + `diffTolerance`（默认 24）；面板「模板」页有「再抓一帧去底」（`template:alphaPreview`）。
     整块实心控件不用（会退化成普通模板）。
   ★ 活动弹窗：采样器/流程认不出界面时先在右上半屏找 `tpl_btn_close_popup`（可选模板，待裁），再盲按一次 BACK + 取消退出框。
6. **世界地图上按 BACK 会弹「确定要退出游戏吗」，误点确定就退出游戏了。**
   关面板一律优先「点面板外空地」或左上角返回箭头；盲按 BACK 之后**必须**紧跟 `dismissNoticeDialog()`。
7. **字形集缺字时读数会「说谎」而不是报错。** 逐字位 argmax 会挑个最像的顶上，
   产出格式合法但值是错的串，正则拦不住。会污染下游记账的字段（坐标）必须调高 `readNumberField` 的
   `minScore`（现为 `COORD_MIN_SCORE = 0.9`），宁可判「读不出」。
8. **别让业务判断只依赖一条识别链路。** 「这支队是我派的、采的什么」原本全靠行内坐标对账，
   坐标一读不出就整个失效并导致重复派兵。现在本轮 `dispatched` 无条件计入配额，
   且「坐标读不出」的行一律当成自己的（少派而非多派）。
9. **两套数字字形集绝不可互换。** 采集态是白字压进度条（`dig_light16`），
   行军/返回态是深灰字压行底（`dig_dark20`）。TM_CCOEFF_NORMED 跨极性是强负相关，一个都打不中。
   进度条上的白字还有绿/灰边界问题：`readNumberText` 对深底浅字集「劈开黏连段」+「原样读不可信再压平背景重读」（别改成硬二值化或一律压平，实测都更差）。
   行内资源类型按缩略图识别（`tpl_row_res_*`，铁矿待裁）；「采集中」菱形图标是转圈高光动画，只框中间白镐、阈值 0.7。
10. **模板集只编译一次。** 93 张、两档 shrink，`gatherRunner.ts` 按模板目录缓存；
    改了模板库调 `invalidateGatherTemplates()`，**绝不能每轮重编**。
11. **滑杆上限 ≠ 附近真有的最高等级，「搜不出卡片」≠「这个点不合适」。**（2026-09-18 真机：魔水池滑杆到 10、附近只有 8 级，
    下限 9 一直搜不到，原来按「点不合适」在同一下限白等 4 次，截图熔断先到，魔水永远派不出去。）
    现在：① 上限**按资源**缓存在 `state.levelByResource[type]`（旧的共用 `maxLevel` 读到即丢）；② 搜不出卡片**立刻放宽**下限、不计入
    `occupiedRetryLimit`；③ 「下限 F 搜不到」在更低下限出卡片或本次放弃时写进 `noResultFloor`，下一轮从 F−1 起步，
    与上限探测同寿命、探测值一变即作废。决策全在 `gather/levelMemory.ts`（纯函数），`flow.ts` 只按 `FloorStep` 执行；改它跑 `npm run check:level`。

### 唤醒时刻

```
etaAt  = 采样时刻 + 面板剩余秒数
freeAt = etaAt + 单程行军秒数          ← 采集完自动回城，队列要等它到家才释放
wakeAt = freeAt + slackSeconds(60) + jitter(0~20s)     ★宁晚勿早
```

单程行军秒数**只有派兵那一刻**能从行军按钮上读到，必须随本次派兵一起记账。
唤醒到点只代表「该去看一眼」—— 机器休眠会让定时器滞后，**必须重新读面板校验**。

---

## 异常检测 / 自动暂停 / 推送（`src/main/alerts/`）

用户诉求原话：「设备被顶号了就暂停任务并且推送到 telegram」。使用说明见 `README.md` 第 7 节，
这里只列写代码时的边界与最容易踩回去的几条。

| 文件 | 职责 | 边界 |
|---|---|---|
| `detect.ts` | `FailureTracker`：**只数数**，把事实攒成结论 | 不写盘、不发通知、不关调度 |
| `freeze.ts` | `FreezeGuard`：卡死看门狗 —— 帧指纹比对（纹丝不动）/ 截图连续失败 → 判定 + 重启熔断 | 不截图、不重启、不发通知；帧由调度器 `onFrameCaptured` 喂进来 |
| `freezeRecovery.ts` | `recoverFrozenInstance`：重启实例 → 等 Android → 重连 adb → 等开机 → monkey 拉起 → 等主界面 | 纯逻辑 + deps 注入；只在 `scheduler.exclusive()` 内跑；只有中止才抛（RUN_ABORTED） |
| `kicked.ts` | 第二层顶号识别（预留） | 模板缺失 → `return null`，**静默降级，绝不抛** |
| `center.ts` | `AlertCenter`：**只做动作**（暂停 / 落盘 / 推给面板 / 交给推送） | 不认识 Telegram，通道走结构化端口 `AlertNotifyPort` |
| `notifier.ts` | `NotifyHub`：配置 + 三道闸 + 冷却去重 | **不认识「暂停」这件事** |
| `telegram.ts` | 一条通道 | 不认识「实例 / 调度器」 |
| `store.ts` / `ipc.ts` | `alerts.json` 读写 / `alerts:*` 通道包装 | — |

### 六条铁律

1. **`queueFull` / `noResourceWanted` / `giveUp` / `staminaLow` / `circuitBroken` 不是失败，还要清零计数。**
   队列 5/5 是挂机稳态。拿 `backoffStep` 判故障必然误报 —— 所以 `detect.ts` 另造了一套只数真失败的计数器。
2. **暂停 = `scheduler.setAuto(i, false)`，不要再手搓。** 它内部已经 `cancelWake` + 清 `nextWakeAt` +
   落盘 + 推 `scheduler:changed`，而 `planNextWake`/`rearm`/`onWake` 三处都有 `!auto` 早退。
   **绝不允许**在暂停之后再调一次 `rearm`。
3. **先暂停，再推送。** 顺序不能换 —— 先把游戏停下来，再去发那个可能要等 15 秒的网络请求。
   推送的一切异常都要吞掉：**推送失败绝不影响暂停**。
4. **`raise()` 在调度器的实例锁内跑。** `setAuto(false)` 不抢锁，安全；
   `setAuto(true)` 会 await 一次采样（要抢锁），所以 **`resume()` 只能从 IPC handler 调，绝不能从锁内调**，否则死锁。
5. **`onCycleResult` 必须在 `throw` 之前调用。** `outcome === 'error'` 那条路是往上抛的，
   抛出去之后 `detail.step`（`'G0'` = 恢复阶梯用尽）会被调度器那层重新包掉，再判就来不及了。
   `createQueueFreeHook` 里另有一个 `try/catch`，把「这一轮压根没跑起来」（模板/serial/配置读不出）
   也补报一次 —— 少了它，设备一直坏着就会永远只在调度器里退避，连续失败计数一次都不涨。
6. **默认值只有一份权威：`defaultAlertsConfig()`。** 本工程有过「三镜像默认值打架」的教训，
   主进程 / 渲染进程 / 离线自检一律 import 它，任何地方都不许再写 `600` / `2` 这类字面量。
7. **卡死 ≠ 掉线：画面纹丝不动 / 截图一直超时、但驱动说实例还在运行 → 先重启，不暂停**（README 7.9）。
   两条触发路都在调度器的**实例锁内**：健康探针（`onHealthProbe` / `onHealthProbeFailed`，完整阈值 `freezeMinutes`）
   与「连续采样失败、马上要按掉线暂停」（`onSampleResult` 现在是异步的、被调度器 await；降档门槛）。
   `tryFreezeRecovery()`（index.ts）里用 `scheduler.exclusive()` 重入放行，**绝不能**在里面调 `setAuto(true)`。
   重启命令一下发就 `noteRestart()` 计数（失败的重启更该计），窗口内超过 `freezeRestartLimit` 次 → 转 `deviceOffline` 暂停。
   恢复流程要接 AbortSignal（自动调度关掉 / 面板退出 `freezeShutdown.abort()`），否则 `scheduler.stop()` 会等它跑完。

### 落盘

```
<dataDir>/alerts.json          配置（★ 含明文 token）+ 推送冷却快照（跨重启有效）
<dataDir>/alerts-pauses.json   每实例暂停态：原因 / 时刻 / 现场截图路径 / 推送结果
<dataDir>/shots/alerts/        告警现场截图（跟随 AppSettings.shotPolicy，默认只在失败时存）
```

### IPC 分工（`ipc.ts` 有重复注册检查，划错会在启动时立刻抛）

```
NotifyHub    alerts:config / alerts:saveConfig / alerts:test
AlertCenter  alerts:pauses / alerts:resume / alerts:history
推送         alerts:pauseChanged / alerts:raised / alerts:configChanged
```

### 时间

推送正文里的时间戳一律是**北京时间**（`formatCst()`，显式按 UTC+8 算）。
**绝不能用 `toLocaleString()`** —— 游戏按北京时间跑，而宿主机时区不一定是北京（实测本机是 `America/Los_Angeles`）。

### 自检

```bash
npm run check:alerts    # 174 项断言，不碰模拟器、不发真实网络请求
```

---

## 机器人菜单 / 截图 / 资源统计 / 数据统计（速查）

使用说明见 `README.md` 第 11 节。分层只有一条边界：`BotActionPort`（`src/shared/bot.ts`）。

| 文件 | 职责 |
|---|---|
| `src/shared/bot.ts` | 动作枚举 `BOT_ACTIONS`、菜单按钮字面量 `BOT_MENU_BUTTON`（★ 不可改字）、回调 `shot:<i>` / `res:<i>`、`BotActionPort`、账号列表 / 截图 caption 渲染、`bot:*` 通道 |
| `src/shared/stats.ts` | `cstDateKey` 等北京日期键（★ 唯一实现，主进程不许再写一份）、`DailyStats` 日桶、七种 `StatsEvent`、`stats:*` 通道、`renderDailyStatsText` |
| `src/shared/resources.ts` | `ResourceSnapshot`、`parseCnAmount` / `formatCnAmount`、`PANEL_AMOUNT_PRECISION = 1000 万` |
| `src/main/alerts/telegramBot.ts` | 通道：getUpdates 长轮询 → 鉴权（只认配置 chatId）→ 菜单按钮文本 / 命令 / 回调 → `perform` → sendMessage / sendPhoto |
| `src/main/alerts/telegram.ts` | `FetchBody = string \| FormData`；`TelegramNotifier.sendPhoto`（告警通道级发图，带重试）。★ FormData 时**绝不**手设 content-type |
| `src/main/bot/actions.ts` | `createBotActions(deps)`：九个动作。碰模拟器的（shot / resources / relaunch）**必须**包在 `deps.exclusive()` 里 |
| `src/main/bot/ipc.ts` | `bot:perform` / `bot:instances`（面板「在面板内测试动作」卡走这里，与手机同一条路） |
| `src/main/scheduler/index.ts` | `exclusive(i, what, fn)`：有脚本在跑抛 `CONCURRENCY_LIMIT`，否则 `withLock`；`SchedulerDeps.onAutoChanged` = 暂停/恢复统计事件的**唯一来源** |
| `src/main/game/resources/` | 「道具 → 资源统计」表：`layout.ts` 坐标、`templates.ts` 单位字 / seed、`read.ts` 预检 → 导航 → 读表 → 还原 |
| `src/main/stats/` | `StatsCenter`：`record()` 同步绝不抛、日切定时器、`<dataDir>/stats/<日期>.json`、`stats:*` IPC |
| `src/renderer/src/features/stats/` | 「数据统计」页；`features/bot/BotTestCard.tsx` 设置页测试卡 |

### 七条铁律

1. **机器人动作凡要碰模拟器，必须走 `scheduler.exclusive()`**，与采样 / 派遣抢同一把实例锁；绝不能裸点。
   `exclusive` 内**不得**调 `setAuto(true)`（会 await 采样 → 死锁）—— `relaunch` 是「锁内 recoverGame，锁外 resume」。
2. **读资源统计前先预检，不在主界面就一个动作都不发**；读完必须用 `tpl_nav_city_toggle` / `tpl_nav_map_toggle` 校验还原。
3. **资源统计表精度只有 0.1 亿，不能拿来算日采集量差值**。日采集量 = 派兵记账的储量之和。
4. **日切一律用 `@shared/stats` 的 `cstDateKey`**（UTC+8 位移后取 UTC 字段），绝不用本机小时 —— 宿主是 `America/Los_Angeles`。
5. **暂停 / 恢复统计事件只从 `SchedulerDeps.onAutoChanged` 进**（开关真的翻转才通报）。告警中心、机器人、面板开关都不许再各记一份。
6. **sendPhoto 走 FormData，不手设 content-type**；每次重试重新构造 FormData（流只能消费一次）；>10MB 直接退化成文字。
7. **字形集缺字（现缺 5 / 8 / 逗号，单位缺「万」）时读数置 null 并把原文回给用户，绝不给错值。** 补字形用 tplkit，json 已标 `missing`。

## AI 顾问：认不出界面时问视觉大模型 + 模板自学习（`src/main/ai/`）

使用说明见 `README.md` 第 12 节。分层：`advisor.ts` 只出主意（配置 / 限频 / 两阶段问询 / 记录），
`recover.ts` 只动手（白名单点击 / 复验 / 自学模板），`client.ts` 是 OpenAI 兼容视觉接口，`harvest.ts` 裁模板入库。
接入点：`gather/navigation.ts` 的 `ensureWorldMap`（`s.advisor`，盲按 BACK 之前）与 `scheduler/troopPanel.ts` 的
`ensurePanelOpen`（`onUnrecognized` 返回 `'recovered'`）。契约在 `src/shared/ai.ts`。

### 六条铁律

1. **动作白名单只有 tap_close / tap_cancel / back / none，且只执行前两种。** back / none 交回调用方自己的 BACK 阶梯 ——
   「BACK 之后必须取消退出框」这条安全逻辑只能写一份。绝不给白名单加「确定」「派兵」之类的动作。
2. **点完必须复验。** 画面没变（shrink=4 平均绝对差 < 6）当没发生；变了但 `recognize()` 认不出只算 `applied`；
   只有回到已知界面（`isRecognizableScreen`）才算 `verified`、才允许自学模板。
3. **自学模板走 `@vision/store.saveTemplate`**（方差守卫 / 原子写），id 是 `tpl_btn_close_popup` 或 `_ai<N>`（≤ 8 张），
   两条链路都按前缀扫描；学完调 `templateHarvested()` 让采集与调度器两份模板缓存失效。已有模板能认出的 × 不重复学。
4. **限频是熔断不是优化**：`maxCallsPerHour`（全局）+ `cooldownSeconds`（每实例），只算真正发出的请求；未启用时连 skipped 都不记。
5. **★★ apiKey 是凭据**，纪律与 Telegram token 完全一致：只存 `<dataDir>/ai.json`；过 IPC 只送 `toAiConfigView()`
   （类型上没有 apiKey）；`chatVision()` 绝不抛异常、每处 catch 先 `scrubAiSecret()`；`note()` 落记录前再洗一次。
6. **默认值只有一份权威：`defaultAiConfig()`**（默认模型 `qwen3.8-flash`，百炼兼容模式地址）。设置页的 min/max 来自 `AI_RANGE`。

### 提示词与坐标

模型收到的是缩到 `imageWidth`（默认 1280）宽的 JPEG，边界框是**那张图的像素**，`consult()` 按比例换算到参考坐标；
`refine` 开着时再从裸帧裁出目标周围一块（<480 宽就放大 2 倍）以 PNG 问一次精确框，精修框跑出外扩区就沿用整帧框。
回复解析宽容：剥 ```json 围栏、接受 `{x,y,w,h}` / `{bbox:[x1,y1,x2,y2]}` / `{x1,y1,x2,y2}` 三种写法。

## 冷启动恢复：模拟器刚开机、游戏没跑（`src/main/game/launch.ts`）

这是「采集自己救不回来」最常见的一类，2026-09-15 补上。两条铁则：

1. **《万龙觉醒》只能用 monkey 拉起。** `am start -n <组件>` 返回成功但进程根本起不来
   （`adb/apps.ts` 的 `launchViaMonkey` 文件头有实测记录）。凡是「把游戏拉起来」的地方一律用它，
   `launch()` / `coldStart()` 只能用于别的普通应用。
2. **拉起 ≠ 能用。** monkey 返回后窗口约 10s 到前台，冷启动真正进到城内**实测 90s 以上**，
   而且加载完常常压着一张活动弹窗。所以 `ensureGameForeground()` 只负责把**前台**等到游戏，
   「等到能识别的界面」由调用方拿模板轮询。

接入的两处（都在「认不出界面」的兜底阶梯里，**排在探针与盲按 BACK 之前** ——
在 Android 桌面上按 BACK 毫无意义，只会把采样判成掉线、三次后暂停实例）：

| 位置 | 做法 |
|---|---|
| 调度器采样 `scheduler/troopPanel.ts` 的 `ensurePanelOpen` | 第 2 轮认不出时调 `io.ensureGameForeground()`；返回 `'launched'` 就**就地给 `opts.deadlineAt` 加时** 180s、多给 6 轮尝试，然后「只看不点」地轮询到已知界面出现（默认 60s 的采样预算连加载都不够） |
| 采集流程 `game/gather/navigation.ts` 的 `ensureWorldMap` | 前台不是游戏就调 `s.io.ensureGameForeground()`，再按 150s 等世界地图 |

★ `openTroopPanel`（gather 模块）**假定已经在世界地图**，调用前必须先 `ensureWorldMap`。
少这一步的话，游戏没跑时会在 Android 桌面上匹配，然后误报「没有队伍在野外」返回空队列
（`scripts/gather-live.ts` 原来就漏了这一步，2026-09-15 修）。

## UI 坑：antd 6 表格固定列
- antd 6 底层是 `@rc-component/table`，固定单元格类名是 `ant-table-cell-fix-start` / `-fix-end`（**不是** v5 的 `-fix-left` / `-fix-right`）。
- 本主题表格底色是毛玻璃透明色，固定列会把相邻列透出来看起来像"重叠"；tokens.css 已全局把固定单元格设为 `--wl-bg-elevated` 实心色。
- `scroll.x` 不要写死大于各列宽度之和的数（会把相邻列拉伸到固定列下面），用 `'max-content'`。
