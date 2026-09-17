/**
 * 领域模型：模拟器实例、adb 设备、应用、账号、面板设置。
 * 视觉相关的类型在 vision.ts，脚本/执行相关的在 script.ts。
 */

// ── 模拟器实例 ────────────────────────────────────────────────────────────
//
// 历史说明：模块 a 最初只对接 macOS 上 MuMu Pro 的 mumutool，所以类型名都带 Mumu。
// 2026-09 移植到 Windows + 雷电模拟器后，模块 a 变成了「模拟器驱动层」（src/main/mumu/driver.ts），
// 雷电与 MuMu 各一个驱动，都产出同一个 MumuInstance 视图。类型名保留，避免全工程改名。

/**
 * 模拟器驱动种类：
 *   · ldplayer —— 雷电模拟器（Windows），CLI 是安装目录下的 ldconsole.exe
 *   · mumu     —— MuMu 模拟器：Windows 上是 MuMuManager.exe（src/main/mumu/mumuwin/），macOS 上是 MuMu Pro 的 mumutool
 */
export type EmulatorKind = 'ldplayer' | 'mumu'

/** 实例状态。mumutool 的取值空间未探全，务必按开放字符串处理；雷电驱动只会产出前三种。 */
export type MumuState = 'running' | 'stopped' | 'starting' | 'error' | (string & {})

/**
 * `ldconsole list2` 一行的原样字段（顺序由雷电定，实测 14.0.26.1 有 10 列）：
 *   index, title, top_hwnd, bind_hwnd, android_started, pid, vbox_pid, width, height, dpi
 * 雷电 9 只有前 7 列，后三列缺省为 null。
 */
export interface LdInstanceRaw {
  index: number
  title: string
  topHwnd: number
  bindHwnd: number
  /** Android 是否已启动完成（1/0）。这是雷电给出的唯一「就绪」信号。 */
  androidStarted: boolean
  /** 主进程 pid；未运行时雷电给 -1，这里归一成 null。 */
  pid: number | null
  vboxPid: number | null
  width: number | null
  height: number | null
  dpi: number | null
}

/** `mumutool info all` 的 return.results[i] 原样结构（字段名是 MuMu 定的，不要改）。 */
export interface MumuInstanceRaw {
  index: number
  name: string
  /** ★ 每个实例的 adb 端口由 info 动态返回（实例 0 = 16384），绝不能推算或缓存。 */
  adb_port?: number
  pid?: number
  state: MumuState
  state_detail?: { enableScreen?: boolean }
  bundle_path?: string
}

/**
 * Windows 版 MuMuManager.exe `info -v all` 里一个实例的字段，已驼峰化并补齐缺省
 * （原始 JSON 的键是 snake_case，index 是字符串；停机实例没有 adb_port / pid / player_state / launch_err_* 这几个键）。
 */
export interface MumuWinInstanceRaw {
  index: number
  name: string
  /** 进程是否已起（is_process_started）。false = 停机。 */
  processStarted: boolean
  /** Android 是否已启动完成（is_android_started）。这是「可以截图」的信号。 */
  androidStarted: boolean
  /** 只有进程起来后才有；★ 每次从 info 现读，不推算。实例 0 实测 16384。 */
  adbPort: number | null
  adbHostIp: string | null
  pid: number | null
  /** 实测见过 starting_rom / start_finished；停机时没有这个键。按开放字符串处理。 */
  playerState: string | null
  /** error_code / launch_err_code 非 0 = 实例坏了或上次启动失败。 */
  errorCode: number
  launchErrCode: number
  launchErrMsg: string
  androidVersion: string | null
  diskSizeBytes: number | null
  /** MuMu 创建时间戳，用于区分删除后复用同一编号的实例。 */
  createdTimestamp?: string | null
}

/** 面板内部使用的实例视图（驼峰化 + 附加派生字段）。 */
export interface MumuInstance {
  index: number
  /** 驱动能提供时用于识别实例本身，不随改名变化。 */
  identity?: string | null
  name: string
  state: MumuState
  /** null 表示实例未运行或 info 没给出端口。 */
  adbPort: number | null
  pid: number | null
  /** 屏幕是否已可用（state_detail.enableScreen）。 */
  screenReady: boolean
  bundlePath: string | null
  /** 规范 serial = `127.0.0.1:<adbPort>`；未运行时为 null。永不使用 `emulator-XXXX`。 */
  serial: string | null
  /** adb 侧的连接状态，由 adb 层填充，mumu 层不负责。 */
  adb: AdbLinkState
  /** 绑定的账号 id；未绑定为 null。 */
  accountId: string | null
  /** 当前正在这个实例上跑的执行 id；空闲为 null。 */
  runId: string | null
  /**
   * 实例**配置**的分辨率（雷电 list2 直接给出；MuMu 拿不到时为 null / 缺省）。
   * 只用于面板提示「与参考分辨率不一致」，坐标换算仍然只信 screencap 头部（铁律二）。
   */
  resolution?: { width: number; height: number; dpi: number } | null
}

export type AdbLinkState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error'

/**
 * 创建实例的参数。
 *   · MuMu：count -> `--count`，type -> `--type`，settings 透传给 `-s <json>`（例如 { vmCpuCount: 4 }）
 *   · 雷电：count 次 `ldconsole add`，type 忽略，settings 交给 `ldconsole modify`
 *     （支持的键见 src/main/mumu/ldplayer/index.ts 的 LD_MODIFY_KEYS，例如 { resolution: "2560,1440,360", cpu: 4, memory: 4096 }）
 */
export interface CreateInstanceOptions {
  /** 未指定时：已设基础实例则克隆，否则空白新建。 */
  source?: 'base' | 'blank'
  /** 面板确认的基础实例编号，防止打开弹窗后源实例被改动。 */
  expectedBaseIndex?: number
  count?: number
  type?: 'phone' | 'tablet'
  settings?: Record<string, unknown>
}

/** 按模拟器安装位置和数据目录分别保存。index 0 是合法基础实例。 */
export interface BaseInstanceSelection {
  index: number
  name: string
  identity: string | null
}

// ── adb 设备 ──────────────────────────────────────────────────────────────

/** 一台已连接设备的运行时信息。 */
export interface DeviceInfo {
  /** 规范 serial：`127.0.0.1:<adbPort>`。 */
  serial: string
  /** 对应的 MuMu 实例 index；外部设备为 null。 */
  instanceIndex: number | null
  model: string
  androidVersion: string
  sdkInt: number
  abi: string
  /**
   * ★ 画面真实宽高，唯一可信来源是 screencap 头部。
   * 不要用 `wm size`：实测它报 1440x2560（物理竖屏），而实际画面是 2560x1440（ROTATION_90）。
   */
  screenWidth: number
  screenHeight: number
  density: number
  /** sys.boot_completed === '1' */
  booted: boolean
  /** 当前前台包名，可能为 null。 */
  foregroundPackage: string | null
}

export interface AppInfo {
  packageName: string
  /** 冷启动用的 `pkg/Activity`，来自 `cmd package resolve-activity --brief`。 */
  launchComponent?: string
  label?: string
  versionName?: string
  running: boolean
}

/** adb 子进程执行结果。★ 必须是 Buffer/Uint8Array，绝不能是 string：
 *  实测 exec() 按 utf8 解码会把 14,745,616 字节的截图膨胀成 26,421,018 字节并彻底损坏。 */
export interface AdbResult {
  stdout: Uint8Array
  stderr: string
  code: number
  /** 实测耗时，用于面板显示与性能排查。 */
  elapsedMs: number
}

// ── 账号 ─────────────────────────────────────────────────────────────────

export interface Account {
  /** 登录向导写入；旧账号无此字段，保持原有行为。 */
  setup?: import('./login').AccountSetup
  id: string
  /** 展示名，例如「主号-王朝A区」。 */
  name: string
  /** 归属的游戏包名，用于筛选可用脚本。 */
  packageName?: string
  /** 绑定到哪个 MuMu 实例 index；null 表示未绑定。一个实例同时只绑一个账号。 */
  instanceIndex: number | null
  /** 备注/服务器/角色名等自由字段。 */
  note?: string
  /** 该账号默认跑的脚本 id。 */
  defaultScriptId?: string
  /** 脚本参数覆盖：scriptId -> 参数键值。 */
  scriptParams?: Record<string, Record<string, string | number | boolean>>
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// ── 面板设置 ──────────────────────────────────────────────────────────────

export interface AppSettings {
  /** 只读运行状态，不写入配置文件。 */
  restartRequired?: boolean
  runtimeEmulator?: EmulatorKind
  /**
   * 用哪个模拟器驱动。**默认 mumu**（Windows 落到 MuMuManager.exe，macOS 落到 mumutool）；雷电要显式选。
   * 设置文件里没有这个键时（Mac 时代的旧 settings.json）由 defaultSettings 按平台补。
   */
  emulator: EmulatorKind
  /**
   * adb 可执行文件。空串表示「尚未配置」：Windows 上主进程启动时会按雷电安装目录自动探测并回填。
   * macOS 默认 DEFAULT_ADB_PATH。
   */
  adbPath: string
  /**
   * 模拟器管理 CLI：雷电 = `<安装目录>\ldconsole.exe`，MuMu = mumutool。
   * 键名沿用历史（改名要动设置文件、IPC、界面三处，不值得）。空串同样表示「尚未配置」。
   */
  mumutoolPath: string
  /** 运行数据根目录（模板/日志/截图/账号）。 */
  dataDir: string
  /** 参考分辨率，所有模板与坐标的公共空间。 */
  refWidth: number
  refHeight: number
  /** 匹配降采样倍率。 */
  shrink: number
  /** 默认命中阈值。 */
  matchThreshold: number
  /** 同时运行的实例数上限。 */
  maxConcurrentInstances: number
  /** 单实例两次截图的最小间隔（ms）。 */
  minCaptureIntervalMs: number
  /** 是否保存每步截图留痕（占磁盘，默认只在失败时存）。 */
  shotPolicy: 'never' | 'onFail' | 'always'
  /** 实例状态轮询间隔（ms）。 */
  instancePollIntervalMs: number
  /** 界面语言，目前只有 zh-CN。 */
  locale: 'zh-CN'
}

/** 主进程解析出的绝对路径集合，渲染进程用它做「打开文件夹」等操作。 */
export interface ResolvedPaths {
  dataDir: string
  templatesDir: string
  shotsDir: string
  logsDir: string
  accountsDir: string
  scriptsDir: string
  /** 打包后的 resources 目录（模板/apk 随包资源）。 */
  resourcesDir: string
  adbPath: string
  /** 模拟器管理 CLI（雷电 ldconsole.exe / MuMu mumutool）。 */
  mumutoolPath: string
}

// ── 环境自检 ──────────────────────────────────────────────────────────────

export interface HealthCheckItem {
  key:
    | 'adbBinary'
    | 'adbServer'
    | 'mumutoolBinary'
    | 'mumuService'
    | 'dataDir'
    | 'opencv'
    | 'sharp'
    | 'diskSpace'
  label: string
  ok: boolean
  /** 中文说明；失败时给出可操作的修复建议。 */
  detail: string
}

export interface HealthReport {
  ok: boolean
  checkedAt: number
  items: HealthCheckItem[]
}
