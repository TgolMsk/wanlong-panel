/**
 * MuMuManager.exe 输出的解析（纯函数，健康自检、离线自检与驱动共用，不 spawn、不 import electron）。
 *
 * `info -v all` 实测（6.6.4.0，2026-09-14）是「以 index 字符串为键」的对象：
 *   {
 *     "0": { "index": "0", "name": "已登录", "is_process_started": true, "is_android_started": true,
 *            "adb_host_ip": "127.0.0.1", "adb_port": 16384, "pid": 22488, "player_state": "start_finished",
 *            "launch_err_code": 0, "launch_err_msg": "", "android_version": "15.0", "disk_size_bytes": 3731167714,
 *            "error_code": 0, "hyperv_enabled": true, "vt_enabled": true, "main_wnd": "001F08AC", … },
 *     "1": { "index": "1", "name": "基础游戏包", "is_process_started": false, "is_android_started": false, … }
 *   }
 * `info -v N` 是单个对象（同样的字段）。停机实例**没有** adb_port / pid / player_state / launch_err_* 这些键。
 * player_state 实测见过 starting_rom / start_finished，按开放字符串处理。
 *
 * `setting -v all -k resolution_width -k resolution_height -k resolution_dpi` 也是按 index 键的对象，
 * 值是 "2560.000000" 这种带小数的字符串。
 */

import { serialOf } from '@shared/constants'
import type { MumuInstance, MumuWinInstanceRaw } from '@shared/domain'
import { AppError } from '@shared/errors'

export interface MumuWinResolution {
  width: number
  height: number
  dpi: number
}

/** `info -v all` / `info -v N` 的 JSON -> 原样结构数组（按 index 升序）。errcode 非 0 的信封在 cli.ts 已经拦下。 */
export function parseMumuWinInfo(json: unknown): MumuWinInstanceRaw[] {
  if (!isRecord(json)) {
    throw new AppError('MUMU_BAD_OUTPUT', 'MuMuManager info 返回的不是 JSON 对象', {
      got: json === null ? 'null' : typeof json
    })
  }
  const out: MumuWinInstanceRaw[] = []
  if ('index' in json && looksLikeInstance(json)) {
    // info -v N：单个实例对象
    out.push(toRaw(json, null))
  } else {
    // info -v all：以 index 字符串为键；键与对象里的 index 一致，对象里缺 index 时用键
    for (const [key, value] of Object.entries(json)) {
      if (!isRecord(value) || !looksLikeInstance(value)) continue
      out.push(toRaw(value, key))
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/**
 * 原样结构 -> 面板视图。状态映射：
 *   进程没起 + error_code / launch_err_code 非 0 -> error（实例坏了或上次启动失败）
 *   进程没起                                   -> stopped
 *   进程起了 + is_android_started=false        -> starting（adb 可能已能连，但 screencap 是黑帧）
 *   进程起了 + is_android_started=true         -> running
 * adb 端口只在进程起来后取 info 现读的值；停机实例 adbPort = null（ensureDevice 用它判断「实例没开」）。
 * `adb` / `accountId` / `runId` 一律填初始值，由上层回填（三条共同约定之一）。
 */
export function mumuWinRawToInstance(
  raw: MumuWinInstanceRaw,
  resolution: MumuWinResolution | null = null
): MumuInstance {
  const up = raw.processStarted
  const adbPort = up ? raw.adbPort : null
  const broken = !up && (raw.errorCode !== 0 || raw.launchErrCode !== 0)
  return {
    index: raw.index,
    identity: raw.createdTimestamp ? `mumu:${raw.createdTimestamp}` : null,
    name: raw.name || `MuMu 实例 ${raw.index}`,
    state: broken ? 'error' : !up ? 'stopped' : raw.androidStarted ? 'running' : 'starting',
    adbPort,
    pid: up ? raw.pid : null,
    screenReady: up && raw.androidStarted,
    bundlePath: null,
    serial: adbPort === null ? null : serialOf(adbPort),
    adb: 'disconnected',
    accountId: null,
    runId: null,
    resolution
  }
}

/**
 * `setting -v all -k resolution_width -k resolution_height -k resolution_dpi` 的 JSON -> Map<index, 分辨率>。
 * `-v N` 单实例时输出是扁平对象（没有 index），要把 index 传进 singleIndex 才能归到实例上。
 * 解析不出来就给空 Map：分辨率只是提示信息，不该让列表失败。
 */
export function parseMumuWinResolutions(
  json: unknown,
  singleIndex?: number
): Map<number, MumuWinResolution> {
  const map = new Map<number, MumuWinResolution>()
  if (!isRecord(json) || 'errcode' in json) return map
  if ('resolution_width' in json) {
    const r = readResolution(json)
    if (r && singleIndex !== undefined) map.set(singleIndex, r)
    return map
  }
  for (const [key, value] of Object.entries(json)) {
    const idx = toInt(key)
    if (idx === null || idx < 0 || !isRecord(value)) continue
    const r = readResolution(value)
    if (r) map.set(idx, r)
  }
  return map
}

// ── 内部 ─────────────────────────────────────────────────────────────────

/** 带任何一个实例特有字段就当实例；info_source 这种顶层杂项键的值不是对象，自然被跳过。 */
function looksLikeInstance(o: Record<string, unknown>): boolean {
  return 'name' in o || 'is_process_started' in o || 'is_android_started' in o || 'index' in o
}

function toRaw(o: Record<string, unknown>, keyHint: string | null): MumuWinInstanceRaw {
  const index = toInt(o['index']) ?? (keyHint === null ? null : toInt(keyHint))
  if (index === null || index < 0) {
    throw new AppError('MUMU_BAD_OUTPUT', 'MuMuManager info 里有一条实例没有合法的 index', {
      index: o['index'],
      key: keyHint
    })
  }
  return {
    index,
    name: typeof o['name'] === 'string' ? o['name'] : '',
    processStarted: o['is_process_started'] === true,
    androidStarted: o['is_android_started'] === true,
    adbPort: toPosInt(o['adb_port']),
    adbHostIp: typeof o['adb_host_ip'] === 'string' && o['adb_host_ip'] ? o['adb_host_ip'] : null,
    pid: toPosInt(o['pid']),
    playerState: typeof o['player_state'] === 'string' ? o['player_state'] : null,
    errorCode: toInt(o['error_code']) ?? 0,
    launchErrCode: toInt(o['launch_err_code']) ?? 0,
    launchErrMsg: typeof o['launch_err_msg'] === 'string' ? o['launch_err_msg'] : '',
    androidVersion: typeof o['android_version'] === 'string' ? o['android_version'] : null,
    diskSizeBytes: toPosInt(o['disk_size_bytes']),
    createdTimestamp:
      typeof o['created_timestamp'] === 'string' && /^\d+$/.test(o['created_timestamp'])
        ? o['created_timestamp']
        : typeof o['created_timestamp'] === 'number' &&
            Number.isSafeInteger(o['created_timestamp']) &&
            o['created_timestamp'] > 0
          ? String(o['created_timestamp'])
          : null
  }
}

function readResolution(o: Record<string, unknown>): MumuWinResolution | null {
  const width = toDim(o['resolution_width'])
  const height = toDim(o['resolution_height'])
  const dpi = toDim(o['resolution_dpi'])
  if (width === null || height === null) return null
  return { width, height, dpi: dpi ?? 0 }
}

/** "2560.000000" / 2560 -> 2560；非正数 / 非数字 -> null。 */
function toDim(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

/** "0" / 0 -> 0；"abc" / 1.5 / null -> null。 */
function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10)
  return null
}

function toPosInt(v: unknown): number | null {
  const n = toInt(v)
  return n !== null && n > 0 ? n : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
