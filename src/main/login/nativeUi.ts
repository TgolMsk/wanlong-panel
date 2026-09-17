import { AppError } from '@shared/errors'
import { shell, shellRaw } from '@main/adb/exec'
import { enqueue } from '@main/adb/queue'
import { tap } from '@main/adb/input'
import { foregroundPackage } from '@main/adb/apps'
import { GAME_PACKAGE } from '@main/game/gather/geometry'

export interface NativeNode {
  id: string
  text: string
  hint: string
  className: string
  checked: boolean
  enabled: boolean
  x: number
  y: number
  width: number
  height: number
}
function decode(value: string): string {
  return value.replace(
    /&(quot|apos|lt|gt|amp);/g,
    (_, key: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[key]!
  )
}
/** 只解析 UIAutomator 输出的节点属性，不执行 XML 或加载外部实体。 */
export function parseNativeUi(xml: string): NativeNode[] {
  const nodes: NativeNode[] = []
  for (const match of xml.matchAll(/<node\s+([^>]+)>/g)) {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])
    )
    if (attrs.package !== GAME_PACKAGE) continue
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '')
    if (!b) continue
    const [x1, y1, x2, y2] = b.slice(1).map(Number)
    if (x2 <= x1 || y2 <= y1) continue
    nodes.push({
      id: attrs['resource-id'] ?? '',
      text: attrs.text ?? '',
      hint: attrs.hint ?? '',
      className: attrs.class ?? '',
      checked: attrs.checked === 'true',
      enabled: attrs.enabled === 'true',
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      width: x2 - x1,
      height: y2 - y1
    })
  }
  return nodes
}

export async function readLoginUi(serial: string): Promise<NativeNode[]> {
  if ((await foregroundPackage(serial)) !== GAME_PACKAGE)
    throw new AppError('DEVICE_NOT_READY', '请先让《万龙觉醒》显示在前台。')
  return enqueue(serial, async () => {
    const path = '/sdcard/wanlong-login-ui.xml'
    try {
      await shellRaw(serial, `rm -f ${path}`)
      const result = await shellRaw(serial, `uiautomator dump ${path}`, 15_000)
      if (!result.text.includes('dumped to:')) throw new Error('dump failed')
      const xml = await shell(serial, `cat ${path}`)
      if (!xml.includes('<hierarchy')) throw new Error('invalid dump')
      return parseNativeUi(xml)
    } catch {
      throw new AppError(
        'DEVICE_NOT_READY',
        '当前登录页面还不能读取，请等待画面稳定或使用下方画面继续。'
      )
    } finally {
      await shellRaw(serial, `rm -f ${path}`).catch(() => undefined)
    }
  })
}

export function byId(nodes: NativeNode[], id: string): NativeNode | undefined {
  const matches = nodes.filter((n) => n.id === `${GAME_PACKAGE}:id/${id}` && n.enabled)
  return matches.length === 1 ? matches[0] : undefined
}

export async function clickNode(
  serial: string,
  node: NativeNode,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await tap(serial, node.x, node.y)
  signal.throwIfAborted()
}

export async function fillNode(
  serial: string,
  node: NativeNode,
  value: string,
  signal: AbortSignal
): Promise<void> {
  if (!/^\d{1,32}$/.test(value))
    throw new AppError('INVALID_ARGUMENT', '请输入数字格式的手机号或验证码。')
  await clickNode(serial, node, signal)
  // KEYCODE_MOVE_END + 足量退格只作用于刚识别的输入框；文本只允许手机号／验证码。
  await enqueue(serial, () =>
    shell(serial, `input keyevent KEYCODE_MOVE_END ${Array(32).fill('KEYCODE_DEL').join(' ')}`)
  )
  signal.throwIfAborted()
  await inputLoginDigits(serial, value)
  signal.throwIfAborted()
}

/** 手机号和验证码直接用 Android 数字按键输入，兼容禁止切换第三方输入法的 MuMu。 */
export async function inputLoginDigits(serial: string, value: string): Promise<void> {
  if (!/^\d{1,32}$/.test(value))
    throw new AppError('INVALID_ARGUMENT', '登录输入仅支持数字手机号或验证码。')
  try {
    await enqueue(serial, () => shell(serial, `input text ${value}`))
  } catch {
    throw new AppError('ADB_COMMAND_FAILED', '登录数字输入失败，请检查设备连接后重试。')
  }
}
