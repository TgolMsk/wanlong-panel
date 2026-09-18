/**
 * UpdaterPort 的真实实现：把 electron-updater 包成一个窄接口。
 *
 * 这是**全工程唯一** import electron-updater 的地方 —— 更新中心（index.ts）只认 UpdaterPort，
 * 所以离线自检能塞个假的把整条状态机跑完，不碰网络也不需要打包环境。
 *
 * ★ 两个开关必须关掉，原因见 shared/update.ts 的铁律一：
 *   autoDownload=false        查到新版本不偷偷下
 *   autoInstallOnAppQuit=false 退出时不偷偷装（这是个挂机工具，退出往往是意外退出）
 *
 * ★ electron-updater 的错误**不走 reject**，走 'error' 事件 —— 所以 onError 必须接上，
 *   否则下载中途断网会永远停在「正在下载」。
 *
 * ★ 打包后它读 `<Resources>/app-update.yml`，那个文件由 electron-builder 按
 *   electron-builder.yml 的 `publish` 段生成。没有 publish 段 = 运行时报「找不到 app-update.yml」。
 */

// ★★ 必须是**默认导入再解构**，不能写 `import { autoUpdater } from 'electron-updater'`。
//    electron-updater 是 CJS（exports 用 Object.defineProperty 定义 getter），而本工程是 ESM
//    （package.json 的 "type": "module"）。具名导入会在**模块加载期**抛
//    `SyntaxError: Named export 'autoUpdater' not found`，主进程一行代码都没跑就死了 ——
//    打包后的表现是「窗口标题 Error、用户数据目录空的」，开发模式则是起不来。
//    2026-09-18 真机踩过一次，别改回去。
import electronUpdaterPkg from 'electron-updater'
import type { UpdateProgress } from '@shared/update'
import type { UpdaterPort } from './index'

const { autoUpdater } = electronUpdaterPkg

/** GitHub 上的仓库，拼 Release 页地址用。与 electron-builder.yml 的 publish 段保持一致。 */
export const GITHUB_OWNER = 'TgolMsk'
export const GITHUB_REPO = 'wanlong-panel'

export function releasePageUrl(version?: string | null): string {
  const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
  return version ? `${base}/tag/v${version.replace(/^v/, '')}` : `${base}/latest`
}

/** electron-updater 的 releaseNotes 可能是字符串，也可能是一串 {version, note}。 */
function normalizeNotes(notes: unknown): string | null {
  if (typeof notes === 'string') return notes.trim() || null
  if (Array.isArray(notes)) {
    const text = notes
      .map((n) => (typeof n === 'string' ? n : String((n as { note?: string })?.note ?? '')))
      .filter(Boolean)
      .join('\n\n')
    return text.trim() || null
  }
  return null
}

export function createElectronUpdater(
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
): UpdaterPort {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // electron-updater 自带的 logger 默认往 console 打英文，接到面板自己的日志上。
  autoUpdater.logger = {
    info: (m: unknown) => log('debug', `[electron-updater] ${String(m)}`),
    warn: (m: unknown) => log('warn', `[electron-updater] ${String(m)}`),
    error: (m: unknown) => log('warn', `[electron-updater] ${String(m)}`),
    debug: (m: unknown) => log('debug', `[electron-updater] ${String(m)}`)
  }

  return {
    check: async () => {
      const r = await autoUpdater.checkForUpdates()
      if (!r?.updateInfo?.version) return null
      return {
        version: r.updateInfo.version,
        releaseNotes: normalizeNotes(r.updateInfo.releaseNotes),
        releaseUrl: releasePageUrl(r.updateInfo.version)
      }
    },
    download: async () => {
      await autoUpdater.downloadUpdate()
    },
    // isSilent=true：装的时候不弹 NSIS 界面；isForceRunAfter=true：装完自动把面板拉起来。
    quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
    onProgress: (cb) => {
      autoUpdater.on('download-progress', (p) => {
        const progress: UpdateProgress = {
          percent: Math.max(0, Math.min(100, Math.round(p.percent))),
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond
        }
        cb(progress)
      })
    },
    onError: (cb) => {
      autoUpdater.on('error', (e) => cb(e instanceof Error ? e : new Error(String(e))))
    }
  }
}
