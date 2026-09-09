# CLAUDE.md —— 万龙控制面板 开发速查

Electron 面板，管理 MuMu 多实例 + 截图/模板匹配自动化。详细架构见 `ARCHITECTURE.md`。

---

## 启动

```bash
npm install          # 依赖
npm run dev          # 起 HMR + 拉起 Electron 窗口（用户点这一个就能看界面）
npm run typecheck    # tsc --noEmit（node + web 两套）
npm run build        # typecheck + electron-vite build
npm run dist:mac     # electron-builder --mac --arm64
```

**首次 clone 后的坑（npm 11.19 的 install-scripts 白名单）**：
`npm install` 之后 esbuild 的 postinstall 不会自动跑，只打 warn。执行：

```bash
npm run approve      # 等价于 npm install-scripts approve esbuild 等
```

electron@44 **不再用 postinstall 下载二进制**，改成首次 `require('electron')` 时懒下载。
如果 `npm run dev` 报 "Electron failed to install correctly"，手动补：

```bash
node node_modules/electron/install.js
```

---

## 环境事实（已实测，直接采信）

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
3. **serial 永远是 `127.0.0.1:<adb_port>`**，`adb_port` 每次从 `mumutool info all` 现读。
4. **分辨率只信 screencap 头部**，不信 `wm size`。
5. **截图用 `exec-out screencap`（raw），不用 `-p`**；Node 里必须 `spawn` + `Buffer.concat`，**禁止 `exec`/`execFile`**（utf8 解码会损坏图像）。
6. **主进程不跑重活**。截图/匹配/脚本一律进 utilityProcess（`out/main/runner.js`）。
7. **mumutool 的 `control` 子命令族在 Mac 版全坏**（errcode 42000）。所有 app/输入操作走 adb，不写 fallback。
8. **mumutool 业务错误时退出码仍是 0**，必须看 JSON 的 `errcode`。用 `parseMumuEnvelope()`。
9. **模板 std < 12 必须拒绝**（纯色模板会恒定返回 1.0000，让脚本乱点）。匹配 method 只能用 `TM_CCOEFF_NORMED`。
10. **每个 OpenCV Mat 必须 `.delete()`**，用 try/finally。
11. **preload 必须编译成 `.cjs`**（sandbox 要求），**MessagePort 不能穿 contextBridge**（用 `window.postMessage` 转发）。
12. **界面文案全部中文**，错误信息也要是能指导用户操作的中文。
13. **版本锁死**：`vite@^7`（electron-vite@5 不支持 vite 8）、`@vitejs/plugin-react@^5`、`typescript@^5.9`（TS 7 有 breaking change）。别升 latest。
14. 不引 Tailwind（会重置 antd 的基础样式）。UI 用 antd + 少量内联样式。

---

## 性能参考数字（别再重复测）

| 操作 | 耗时 |
|---|---|
| `exec-out screencap` raw @2560x1440 | **~280-300ms**（720p 实例约 100ms） |
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
