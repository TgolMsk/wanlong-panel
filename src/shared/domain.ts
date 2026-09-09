/**
 * 领域模型：模拟器实例、adb 设备、应用、账号、面板设置。
 * 视觉相关的类型在 vision.ts，脚本/执行相关的在 script.ts。
 */

// ── MuMu 实例 ─────────────────────────────────────────────────────────────

/** mumutool info 返回的实例状态。取值空间未探全，务必按开放字符串处理。 */
export type MumuState = 'running' | 'stopped' | 'starting' | 'error' | (string & {})

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

/** 面板内部使用的实例视图（驼峰化 + 附加派生字段）。 */
export interface MumuInstance {
  index: number
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
}

export type AdbLinkState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error'

/** 创建实例的参数（mumutool create）。 */
export interface CreateInstanceOptions {
  count?: number
  type?: 'phone' | 'tablet'
  /** 透传给 `-s` 的 JSON 配置，例如 { vmCpuCount: 4 }。 */
  settings?: Record<string, unknown>
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
  /** 覆盖 DEFAULT_ADB_PATH。 */
  adbPath: string
  /** 覆盖 DEFAULT_MUMUTOOL_PATH。 */
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
