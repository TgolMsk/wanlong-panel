/**
 * 全局常量与默认配置。
 *
 * 约定：这里只放「纯常量 + 纯函数」，不得 import electron / node:fs 等任何有副作用的模块，
 * 因为本文件会被主进程、utilityProcess、preload、渲染进程四端同时引用。
 * 运行时可写的配置由 src/main/config.ts 负责加载并覆盖这里的默认值。
 */

// ── 可执行文件路径（实测有效，均可被用户配置覆盖）──────────────────────────

/** MuMu 自带的 adb（实测 v1.0.41 / 34.0.4）。系统 PATH 里没有 adb，必须用这个绝对路径。 */
export const DEFAULT_ADB_PATH =
  '/Applications/MuMuPlayer.app/Contents/MacOS/MuMuEmulator.app/Contents/MacOS/tools/adb'

/** MuMu 多实例管理 CLI。与同目录的 mumu-cli 内容一致，用哪个都行。 */
export const DEFAULT_MUMUTOOL_PATH = '/Applications/MuMuPlayer.app/Contents/MacOS/mumutool'

/** adb server 固定端口。面板启动时会先 `adb start-server` 保证它在。 */
export const ADB_SERVER_HOST = '127.0.0.1'
export const ADB_SERVER_PORT = 5037

// ── 目录约定 ──────────────────────────────────────────────────────────────
/**
 * 运行时数据根目录由主进程决定：
 *   生产 = app.getPath('userData')
 *   开发 = <工程根>/.wl-data
 * 下面这些是相对于该根目录的子目录名，四端共用，禁止各写各的。
 */
export const DATA_DIRS = {
  /** 模板库：<root>/templates/<templateSetId>/<templateId>.png + manifest.json */
  templates: 'templates',
  /** 截图留痕：<root>/shots/<runId>/<seq>-<step>.jpg */
  shots: 'shots',
  /** 运行日志：<root>/logs/<runId>.ndjson，另有 <root>/logs/app.ndjson */
  logs: 'logs',
  /** 账号配置：<root>/accounts/accounts.json */
  accounts: 'accounts',
  /** 脚本定义（用户自建）：<root>/scripts/<scriptId>.json */
  scripts: 'scripts',
  /** 面板自身设置：<root>/settings.json */
  settings: ''
} as const

export const ACCOUNTS_FILE = 'accounts.json'
export const SETTINGS_FILE = 'settings.json'
export const TEMPLATE_MANIFEST_FILE = 'manifest.json'

// ── 视觉引擎默认参数（全部来自实测）────────────────────────────────────────

/**
 * 参考分辨率。所有模板像素、所有 ROI、所有脚本里写的坐标都活在这个空间里，
 * 与具体实例的真实分辨率解耦。prepareFrame 负责把设备帧归一化到这里。
 * 选 2560x1440 是因为 MuMu 默认实例就是这个尺寸（横屏），能命中自写降采样快路。
 */
export const REF_WIDTH = 2560
export const REF_HEIGHT = 1440

/**
 * 匹配前的整数降采样倍率。实测 2560x1440 全屏匹配 87ms，1/2 降采样 22ms，
 * 而抗混叠余量仍有 0.927（远高于 0.85 阈值）。
 */
export const DEFAULT_SHRINK = 2

/**
 * 默认命中阈值。实测真实游戏 UI：正样本 0.975~0.985，负样本 0.452~0.535，
 * 判别间隔 [0.535, 0.975]，0.85 正好落中间。
 */
export const DEFAULT_MATCH_THRESHOLD = 0.85

/**
 * 模板标准差下限。★这是最危险的坑★
 * 低方差（纯色/渐变）模板会让 TM_CCOEFF_NORMED 彻底退化：
 * 实测两个纯白模板对任意画面恒定返回 1.0000 @ (0,0)。
 * 必须在 prepareTemplate 阶段硬性拒绝，否则脚本会在完全错误的位置疯狂点击。
 */
export const MIN_TEMPLATE_STD = 12

/**
 * 透明底模板的掩码下限：不透明像素占比低于它、或总数少于 MIN_MASK_PIXELS 就拒绝——
 * 只剩几十个像素的模板和低方差模板一样没有判别力。
 */
export const MIN_MASK_COVERAGE = 0.1
export const MIN_MASK_PIXELS = 64

/**
 * 多帧差分去底的默认容差：RGB 任一通道差值 ≤ 容差视为「没变」。
 * 实测（兽族城内按钮，3 帧不同地形）：16→覆盖 56%，24→60%，32→66%，48→81%；
 * 24 时正样本 0.97~0.98、负样本 ≤0.63，再放宽会把恰好没变的背景也留下来。
 */
export const DEFAULT_ALPHA_DIFF_TOLERANCE = 24

/** 唯一可用的匹配算法。TM_CCORR_NORMED / TM_SQDIFF_NORMED 实测对负样本无判别力，禁用。 */
export const MATCH_METHOD = 'TM_CCOEFF_NORMED' as const

// ── 截图 / adb 管线默认参数 ───────────────────────────────────────────────

/** 一次 raw screencap 的实测耗时（2560x1440 ≈ 280ms；720p ≈ 100ms），用于超时估算。 */
export const CAPTURE_TIMEOUT_MS = 30_000
/** 普通 adb shell 命令超时。 */
export const ADB_TIMEOUT_MS = 15_000
/** 单实例两次截图之间的最小间隔。模拟器 screencap 吞吐硬上限 ≈4.3 帧/秒，别更快。 */
export const MIN_CAPTURE_INTERVAL_MS = 400
/** 脚本主循环默认 tick 间隔。 */
export const DEFAULT_TICK_INTERVAL_MS = 800

/** screencap raw 头部：Android 10+ 是 16 字节，Android 9- 是 12 字节。用长度反推，别写死。 */
export const SCREENCAP_HEADER_LENS = [16, 12] as const
/** screencap format 字段值 1 = RGBA_8888（实测 MuMu 就是这个，字节序即 R,G,B,A）。 */
export const PIXEL_FORMAT_RGBA_8888 = 1

// ── 并发上限 ──────────────────────────────────────────────────────────────

/**
 * 同时运行的模拟器实例上限。实测单实例跑 Unity 游戏 45.7% CPU + 1.2GB RSS，
 * 本机 10 核 24GB，超过 4 个会把 CPU 打满。
 */
export const MAX_CONCURRENT_INSTANCES = 4
/** 全局 adb 调用并发。同设备内部另有 concurrency=1 的串行队列。 */
export const GLOBAL_ADB_CONCURRENCY = 6
/** 每 clone 一个实例约需 3.6GB 磁盘，创建前检查余量。 */
export const INSTANCE_DISK_COST_BYTES = 4 * 1024 * 1024 * 1024

// ── 预览管线 ──────────────────────────────────────────────────────────────
/** 预览帧的目标宽度（sharp resize + jpeg，实测 ~10ms / 41KB）。 */
export const PREVIEW_WIDTH = 720
export const PREVIEW_JPEG_QUALITY = 70
/** 预览帧率上限，被 screencap 卡在 3fps 左右，别设更高。 */
export const PREVIEW_MAX_FPS = 3

// ── 日志 ──────────────────────────────────────────────────────────────────
/** worker 侧日志批量合并窗口，避免每行一次 postMessage。 */
export const LOG_FLUSH_INTERVAL_MS = 100
/** renderer 侧 ring buffer 保留行数，超出丢弃最旧的。 */
export const LOG_RING_CAPACITY = 2000

// ── 中文输入 ──────────────────────────────────────────────────────────────
/**
 * `input text` 对中文是**静默丢弃**（实测 80 个汉字耗时等同 0 事件基线），
 * 中文必须走 ADBKeyboard 的 broadcast。
 */
export const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard'
export const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'
export const ADB_KEYBOARD_BROADCAST = 'ADB_INPUT_B64'
/** 随包分发的 apk 相对 resources 的路径。 */
export const ADB_KEYBOARD_APK_REL = 'apk/ADBKeyboard.apk'

// ── 工具函数 ──────────────────────────────────────────────────────────────

/** adb_port -> 规范 serial。永远用这个形式，永远不接受 adb 自动发现的 `emulator-XXXX`。 */
export function serialOf(adbPort: number): string {
  return `${ADB_SERVER_HOST}:${adbPort}`
}

/** 参考坐标 -> 设备真实像素。 */
export function refToDevice(
  x: number,
  y: number,
  deviceW: number,
  deviceH: number
): { x: number; y: number } {
  return {
    x: Math.round((x * deviceW) / REF_WIDTH),
    y: Math.round((y * deviceH) / REF_HEIGHT)
  }
}

/** 设备真实像素 -> 参考坐标（模板截取工具用）。 */
export function deviceToRef(
  x: number,
  y: number,
  deviceW: number,
  deviceH: number
): { x: number; y: number } {
  return {
    x: Math.round((x * REF_WIDTH) / deviceW),
    y: Math.round((y * REF_HEIGHT) / deviceH)
  }
}
