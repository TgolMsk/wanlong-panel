/**
 * `ldconsole list2` 输出的解析（纯函数，健康自检与驱动共用，不 spawn、不 import electron）。
 *
 * 实测一行长这样（雷电 14.0.26.1）：
 *   1,万龙1号,3148512,1837642,1,20204,29052,2560,1440,360
 *   ^  ^      ^       ^       ^ ^     ^     ^    ^    ^
 *   |  |      |       |       | |     |     宽   高   dpi
 *   |  |      |       |       | pid   vbox_pid
 *   |  |      |       |       android_started
 *   |  |      top_hwnd bind_hwnd
 *   |  title（用户可改，**可能含逗号**，所以不能简单 split 取第二列）
 *   index
 * 未运行的实例：`0,万龙游戏,0,0,0,-1,-1,2560,1440,360`（pid / vbox_pid 是 -1）。
 * 雷电 9 的 list2 只有前 7 列（没有分辨率三列）。
 */

import { ldAdbPort, serialOf } from '@shared/constants'
import type { LdInstanceRaw, MumuInstance } from '@shared/domain'

/** 标题之后的数值列数：雷电 14 是 8 列，雷电 9 是 5 列。 */
const TAIL_COLUMNS_V14 = 8
const TAIL_COLUMNS_V9 = 5

const INT_RE = /^-?\d+$/

export function parseLdList2(text: string): LdInstanceRaw[] {
  const out: LdInstanceRaw[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(',')
    if (parts.length < 1 + TAIL_COLUMNS_V9) continue
    const index = Number.parseInt(parts[0]!.trim(), 10)
    if (!Number.isInteger(index) || index < 0) continue

    // 先按 14 版的 8 列数值尾巴切，尾巴不全是整数再退回 9 版的 5 列。标题 = 中间剩下的全部（还原逗号）。
    let tailLen = TAIL_COLUMNS_V14
    if (parts.length < 1 + 1 + tailLen || !allInts(parts.slice(parts.length - tailLen))) {
      tailLen = TAIL_COLUMNS_V9
      if (!allInts(parts.slice(parts.length - tailLen))) continue
    }
    const tail = parts.slice(parts.length - tailLen).map((s) => Number.parseInt(s.trim(), 10))
    const title = parts
      .slice(1, parts.length - tailLen)
      .join(',')
      .trim()

    const [topHwnd, bindHwnd, androidStarted, pid, vboxPid, width, height, dpi] = tail
    out.push({
      index,
      title,
      topHwnd: topHwnd ?? 0,
      bindHwnd: bindHwnd ?? 0,
      androidStarted: androidStarted === 1,
      pid: normPid(pid),
      vboxPid: normPid(vboxPid),
      width: normPositive(width),
      height: normPositive(height),
      dpi: normPositive(dpi)
    })
  }
  return out
}

/**
 * LdInstanceRaw -> 面板视图。
 *
 * 状态映射（雷电只给两个布尔量，没有 error 态）：
 *   pid 有效 + android_started=1 -> running（画面已就绪，可以截图）
 *   pid 有效 + android_started=0 -> starting（进程起了、Android 还在开机，screencap 会是黑帧）
 *   pid 无效                      -> stopped
 * adb 端口按雷电公式 5555 + 2·index 推算（见 constants.ts 的说明），只在进程已起来时给出；
 * 停机实例 adbPort = null，与 MuMu 驱动的语义一致（ensureDevice 用它判断「实例没开」）。
 */
export function ldRawToInstance(raw: LdInstanceRaw): MumuInstance {
  const up = raw.pid !== null
  const adbPort = up ? ldAdbPort(raw.index) : null
  return {
    index: raw.index,
    name: raw.title || `雷电实例 ${raw.index}`,
    state: !up ? 'stopped' : raw.androidStarted ? 'running' : 'starting',
    adbPort,
    pid: raw.pid,
    screenReady: up && raw.androidStarted,
    bundlePath: null,
    serial: adbPort === null ? null : serialOf(adbPort),
    adb: 'disconnected',
    accountId: null,
    runId: null,
    resolution:
      raw.width !== null && raw.height !== null
        ? { width: raw.width, height: raw.height, dpi: raw.dpi ?? 0 }
        : null
  }
}

function allInts(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => INT_RE.test(p.trim()))
}

function normPid(v: number | undefined): number | null {
  return v !== undefined && Number.isInteger(v) && v > 0 ? v : null
}

function normPositive(v: number | undefined): number | null {
  return v !== undefined && Number.isInteger(v) && v > 0 ? v : null
}
