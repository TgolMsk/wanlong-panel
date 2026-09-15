/**
 * 两个 Windows 驱动（雷电 ldconsole / MuMu MuMuManager）共用的控制台小工具：
 * 输出解码、换行归一、退出码换算、取首行。纯函数，不 spawn、不 import electron。
 */

/**
 * 控制台输出解码：先按 UTF-8 严格解码，失败再按 GBK（中文 Windows 的 ANSI 代码页）。
 * 两种都失败（几乎不可能）退回 latin1，至少保证不抛。
 * 雷电 ldconsole 输出 GBK，MuMuManager 输出 UTF-8，走同一个函数都对。
 */
export function decodeConsoleText(buf: Buffer): string {
  if (buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    // 不是合法 UTF-8，多半是 GBK
  }
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** Windows 的退出码是无符号 32 位：-200 在 Node 里是 4294967096，换算回有符号数。 */
export function toSigned32(n: number): number {
  return n > 0x7fffffff ? n - 0x100000000 : n
}

export function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? ''
}
