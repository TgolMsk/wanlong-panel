import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import type { AppSettings } from '@shared/domain'

export function deviceContextId(settings: Pick<AppSettings, 'emulator' | 'mumutoolPath'>): string {
  const path = resolve(settings.mumutoolPath)
  const identity = `${settings.emulator}:${process.platform === 'win32' ? path.toLowerCase() : path}`
  return `${settings.emulator}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
}

/** 第一次升级沿用现有数据；另一套模拟器使用独立目录，切回时恢复各自的数据。 */
export async function selectDataContext(
  settings: Pick<AppSettings, 'emulator' | 'mumutoolPath' | 'dataDir'>
): Promise<string> {
  const root = resolve(settings.dataDir)
  const id = deviceContextId(settings)
  const file = join(root, 'device-context.json')
  await mkdir(root, { recursive: true })
  try {
    await writeFile(file, JSON.stringify({ version: 1, primary: id }, null, 2) + '\n', {
      flag: 'wx'
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  let primary: unknown
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data.version === 1) primary = data.primary
  } catch {
    /* 拒绝覆盖损坏的身份标记，避免误用旧账号。 */
  }
  if (typeof primary !== 'string' || !/^(mumu|ldplayer)-[a-f0-9]{16}$/.test(primary)) {
    throw new AppError('IO_ERROR', `设备数据标记损坏，已停止加载以保护账号和任务：${file}`)
  }
  return primary === id ? root : join(root, 'emulators', id)
}
