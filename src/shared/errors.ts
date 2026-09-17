/**
 * 统一错误模型。
 *
 * IPC / MessagePort 边界只能传结构化克隆得到的普通对象，Error 实例过去会丢掉 name/code/stack，
 * 所以所有跨边界的错误都必须先 toSerializable() 变成 SerializedError。
 */

export const ERROR_CODES = [
  // ── 通用 ──
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'TIMEOUT',
  'CANCELLED',
  'NOT_FOUND',
  'IO_ERROR',

  // ── mumutool ──
  /** mumutool 退出码非 0（CLI 用法错误，stderr 是非 JSON 文本） */
  'MUMU_CLI_USAGE',
  /** mumutool 退出码 0 但 JSON 里 errcode != 0（业务错误） */
  'MUMU_API_ERROR',
  /** mumutool 输出不是合法 JSON / 结构与 schema 不符 */
  'MUMU_BAD_OUTPUT',
  /** 请求的实例 index 不存在 */
  'MUMU_INSTANCE_MISSING',
  /** control 子命令族在 Mac 版整体不可用（errcode 42000 invalidApi），不要重试 */
  'MUMU_API_UNSUPPORTED',

  // ── adb ──
  'ADB_NOT_FOUND',
  'ADB_CONNECT_FAILED',
  'ADB_DEVICE_OFFLINE',
  'ADB_COMMAND_FAILED',
  'ADB_TIMEOUT',
  /** screencap 返回的数据长度/头部无法解析 */
  'CAPTURE_BAD_FRAME',
  /** 设备尚未开机完成（sys.boot_completed != 1） */
  'DEVICE_NOT_READY',
  /** 游戏资源更新未完成或遇到未校准的更新提示，需要人工处理。 */
  'GAME_UPDATE_REQUIRED',
  'AI_RISK_BLOCKED',

  // ── 视觉 ──
  /** 模板方差过低，TM_CCOEFF_NORMED 会退化，必须拒绝 */
  'TEMPLATE_LOW_VARIANCE',
  'TEMPLATE_TOO_LARGE',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_DECODE_FAILED',
  'CV_INIT_FAILED',

  // ── 脚本 ──
  'SCRIPT_NOT_FOUND',
  'SCRIPT_INVALID',
  'STEP_FAILED',
  'RUN_NOT_FOUND',
  'RUN_ABORTED',
  'CONCURRENCY_LIMIT'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 跨 IPC / MessagePort 传输用的纯数据错误。 */
export interface SerializedError {
  readonly __wlError: true
  code: ErrorCode
  /** 面向用户的中文说明。 */
  message: string
  /** 排障用的补充上下文，例如 { serial, argv, stderr }。必须可结构化克隆。 */
  detail?: Record<string, unknown>
  stack?: string
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  toSerializable(): SerializedError {
    return {
      __wlError: true,
      code: this.code,
      message: this.message,
      detail: this.detail,
      stack: this.stack
    }
  }

  static from(e: unknown, fallback: ErrorCode = 'UNKNOWN'): AppError {
    if (e instanceof AppError) return e
    if (isSerializedError(e)) return new AppError(e.code, e.message, e.detail)
    if (e instanceof Error) return new AppError(fallback, e.message, { name: e.name })
    return new AppError(fallback, String(e))
  }
}

export function isSerializedError(v: unknown): v is SerializedError {
  return typeof v === 'object' && v !== null && (v as { __wlError?: unknown }).__wlError === true
}

/** 任意 throw 值 -> 可跨边界的纯数据。所有 ipcMain.handle 和 worker 的 catch 都该走它。 */
export function serializeError(e: unknown, fallback: ErrorCode = 'UNKNOWN'): SerializedError {
  return AppError.from(e, fallback).toSerializable()
}
