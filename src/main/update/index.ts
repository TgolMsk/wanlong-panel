/**
 * 应用内更新中心：查 GitHub Release → 下载 → 退出安装。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【分层】本模块**只做编排**，真正的下载与安装交给 electron-updater：
 *   · 什么时候能装   —— busy() 钩子（有脚本在跑 / 有实例开着自动采集 / 登录向导中）
 *   · 支不支持       —— 开发模式、免安装版直接短路
 *   · 状态往哪推     —— 一份 UpdateState，改了就推给面板
 *
 * electron-updater 被关在 UpdaterPort 后面（本文件底部有真实实现），
 * 所以离线自检可以塞一个假的进来，把整条状态机跑一遍而不碰网络。
 *
 * 【四条铁律】见 src/shared/update.ts 的头注释，这里只重复最要紧的一条：
 *   ★ **绝不自作主张装。** autoDownload / autoInstallOnAppQuit 全关，
 *     检查可以自动，下载和安装必须用户点。挂机工具半夜自己重启 = 把活儿干断。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { AppError } from '@shared/errors'
import type { UnsupportedReason, UpdateProgress, UpdateState } from '@shared/update'
import { initialUpdateState, isNewer } from '@shared/update'

/** electron-updater 的窄接口。真实实现在 electron.ts，自检塞假的。 */
export interface UpdaterPort {
  /** 查一次。返回 null 表示「没查到更新信息」（限流 / 没有 Release）。 */
  check(): Promise<{
    version: string
    releaseNotes: string | null
    releaseUrl: string | null
  } | null>
  /** 开始下载。完成后 resolve。 */
  download(): Promise<void>
  /** 退出并安装。正常情况下这个函数不会返回（进程没了）。 */
  quitAndInstall(): void
  /** 订阅下载进度。 */
  onProgress(cb: (p: UpdateProgress) => void): void
  /** 订阅出错。electron-updater 的错误会从这里来，而不是 reject。 */
  onError(cb: (e: Error) => void): void
}

export interface UpdateDeps {
  /** 当前应用版本（app.getVersion()）。 */
  currentVersion(): string
  /** 打包了没有（app.isPackaged）。开发模式不检查。 */
  packaged(): boolean
  /** 是不是免安装版（Windows 上 electron-builder 会设 PORTABLE_EXECUTABLE_DIR）。 */
  portable(): boolean
  /** 现在有没有正忙的事，有就返回中文原因。安装前要靠它拦住。 */
  busy(): string | null
  /** Release 页面地址（打不开自动更新时让用户手动下）。 */
  releasePageUrl(): string
  /** 在系统浏览器里打开一个地址。 */
  openExternal(url: string): Promise<void>
  updater(): UpdaterPort
  /** 状态变化推给面板。 */
  publish(state: UpdateState): void
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

export class UpdateCenter {
  private state: UpdateState
  private deps: UpdateDeps | null = null
  private wired = false

  constructor(currentVersion = '0.0.0') {
    this.state = initialUpdateState(currentVersion)
  }

  init(deps: UpdateDeps): void {
    this.deps = deps
    this.state = initialUpdateState(deps.currentVersion())
    const unsupported = this.unsupportedReason()
    if (unsupported) {
      this.patch({ phase: 'unsupported', unsupportedReason: unsupported })
      this.log(
        'info',
        `当前环境不支持自动更新（${unsupported === 'dev' ? '开发模式' : '免安装版'}）。`
      )
      return
    }
    // 进度与错误是 electron-updater 主动推的，只挂一次。
    if (!this.wired) {
      this.wired = true
      const u = deps.updater()
      u.onProgress((p) => {
        if (this.state.phase === 'downloading') this.patch({ progress: p })
      })
      u.onError((e) => {
        // 下载中途断网之类：回到 available，让用户能重试，而不是卡在 downloading。
        this.patch({
          phase: this.state.phase === 'downloading' ? 'available' : 'error',
          error: describe(e),
          progress: null
        })
        this.log('warn', `更新出错：${describe(e)}`)
      })
    }
  }

  getState(): UpdateState {
    return { ...this.state, ...this.busyFields() }
  }

  /** 查一次。任何失败都落到 phase='error' + 中文原因，绝不抛给调用方。 */
  async check(): Promise<UpdateState> {
    const deps = this.requireDeps()
    const unsupported = this.unsupportedReason()
    if (unsupported) {
      this.patch({ phase: 'unsupported', unsupportedReason: unsupported })
      return this.getState()
    }
    if (this.state.phase === 'checking' || this.state.phase === 'downloading')
      return this.getState()

    this.patch({ phase: 'checking', error: null })
    try {
      const info = await deps.updater().check()
      const now = Date.now()
      if (!info) {
        this.patch({ phase: 'latest', checkedAt: now, latestVersion: null })
        return this.getState()
      }
      const newer = isNewer(info.version, this.state.currentVersion)
      this.patch({
        phase: newer ? 'available' : 'latest',
        latestVersion: info.version,
        releaseNotes: info.releaseNotes,
        releaseUrl: info.releaseUrl ?? deps.releasePageUrl(),
        checkedAt: now,
        error: null
      })
      this.log(
        'info',
        newer
          ? `发现新版本 ${info.version}（当前 ${this.state.currentVersion}）。`
          : `已是最新版 ${this.state.currentVersion}。`
      )
    } catch (e) {
      this.patch({ phase: 'error', error: describe(e), checkedAt: Date.now() })
      this.log('warn', `检查更新失败：${describe(e)}`)
    }
    return this.getState()
  }

  /** 下载。只有 available 时能调；下载完停在 downloaded 等用户点安装。 */
  async download(): Promise<UpdateState> {
    const deps = this.requireDeps()
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded')
      return this.getState()
    if (this.state.phase !== 'available') {
      throw new AppError('INVALID_ARGUMENT', '现在没有可下载的新版本，先点「检查更新」。')
    }
    this.patch({ phase: 'downloading', error: null, progress: null })
    try {
      await deps.updater().download()
      this.patch({ phase: 'downloaded', progress: null })
      this.log('info', `新版本 ${this.state.latestVersion ?? ''} 已下载完成，等待用户重启安装。`)
    } catch (e) {
      this.patch({ phase: 'available', error: describe(e), progress: null })
      this.log('warn', `下载更新失败：${describe(e)}`)
    }
    return this.getState()
  }

  /**
   * 退出并安装。
   * ★ 铁律二：有脚本在跑 / 有实例开着自动采集 / 登录向导没走完时**直接拒绝**，
   *   带中文原因抛出来，让面板照原样显示 —— 不靠 UI 自觉禁按钮。
   */
  install(): void {
    const deps = this.requireDeps()
    if (this.state.phase !== 'downloaded') {
      throw new AppError('INVALID_ARGUMENT', '安装包还没下载完，先点「下载更新」。')
    }
    const reason = deps.busy()
    if (reason) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `${reason}安装要先退出应用，现在装会把正在跑的活儿掐断。等它结束、或先手动停掉再装。`
      )
    }
    this.log('info', '用户确认安装，正在退出并运行安装程序。')
    deps.updater().quitAndInstall()
  }

  /** 打开 Release 页面（免安装版、开发模式、或者用户就想自己下）。 */
  async openReleasePage(): Promise<void> {
    const deps = this.requireDeps()
    await deps.openExternal(this.state.releaseUrl ?? deps.releasePageUrl())
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private unsupportedReason(): UnsupportedReason | null {
    const deps = this.requireDeps()
    if (!deps.packaged()) return 'dev'
    if (deps.portable()) return 'portable'
    return null
  }

  /** installable / busyReason 每次现算：任务状态随时在变，存下来必然过期。 */
  private busyFields(): Pick<UpdateState, 'installable' | 'busyReason'> {
    const reason = this.deps?.busy() ?? null
    return { installable: reason === null, busyReason: reason }
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    try {
      this.deps?.publish(this.getState())
    } catch (e) {
      this.log('warn', `推送更新状态失败（已忽略）：${describe(e)}`)
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const fn = this.deps?.log
    if (fn) fn(level, message)
    else if (level === 'warn' || level === 'error') console.warn(`[update] ${message}`)
    else console.log(`[update] ${message}`)
  }

  private requireDeps(): UpdateDeps {
    if (!this.deps) throw new AppError('UNKNOWN', '更新中心还没初始化。')
    return this.deps
  }
}

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // electron-updater 的原始错误对中文用户没意义，翻译最常见的几种。
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network/i.test(msg)) {
    return '连不上 GitHub（网络不通或被墙），稍后再试，或到 Release 页手动下载。'
  }
  if (/rate limit/i.test(msg)) return 'GitHub API 限流了，过一会儿再试。'
  if (/404/.test(msg)) return '没找到发布信息（仓库还没有 Release？）。'
  // 直接跑 win-unpacked/ 或自己拷出来的目录时会缺这个文件 —— 它只有正式安装包里才有。
  if (/app-update\.yml/.test(msg)) {
    return '这份程序不是从安装包装的（缺 app-update.yml），没法自动更新。到 Release 页下载安装版即可。'
  }
  if (/sha512|checksum/i.test(msg)) return '下载的文件校验没通过，已丢弃，请重试。'
  return msg
}

let singleton: UpdateCenter | null = null

/** 主进程只有一个更新中心。 */
export function getUpdateCenter(): UpdateCenter {
  if (!singleton) singleton = new UpdateCenter()
  return singleton
}

/** 新开一个独立实例。**只给离线自检用**（单例跑不了多组剧本）。 */
export function createUpdateCenter(): UpdateCenter {
  return new UpdateCenter()
}
