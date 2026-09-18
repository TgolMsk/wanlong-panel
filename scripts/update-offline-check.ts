/**
 * 应用内更新（GitHub Release）的**离线**自检。
 *
 * ★★ 全程不联网、不打包、不碰 electron-updater：UpdaterPort 是假的，
 *     整条状态机（检查 → 下载 → 安装）都在内存里跑完。
 *
 * 跑法（工程根目录）：
 *     npm run check:update
 *
 * 覆盖的东西：
 *   一、版本比较（含预发布后缀与垃圾输入）
 *   二、不支持的环境：开发模式 / 免安装版
 *   三、检查：有新版 / 已最新 / 各类错误的中文化
 *   四、下载：进度推送、中途出错不能卡在「正在下载」
 *   五、★ 安装闸门：有任务在跑时必须拒绝，且**绝不能**调到 quitAndInstall
 */

import { AppError } from '@shared/errors'
import {
  compareVersions,
  isNewer,
  formatBytes,
  formatSpeed,
  type UpdateProgress,
  type UpdateState
} from '@shared/update'
import { createUpdateCenter, type UpdaterPort } from '@main/update/index'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`)
}

/** 手动控制何时完成的 Promise（TS 追不到回调里的赋值，所以封一层）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function throwsWith(fn: () => unknown, code: string, contains?: string): boolean {
  try {
    fn()
    return false
  } catch (e) {
    const err = AppError.from(e)
    return err.code === code && (!contains || err.message.includes(contains))
  }
}

// ── 假的 UpdaterPort ──────────────────────────────────────────────────────

interface World {
  port: UpdaterPort
  installs: number
  /** 手动触发一次进度推送。 */
  emitProgress(p: UpdateProgress): void
  /** 手动触发一次 error 事件（electron-updater 的错误走事件，不走 reject）。 */
  emitError(e: Error): void
  setCheck(fn: UpdaterPort['check']): void
  setDownload(fn: UpdaterPort['download']): void
}

function makeWorld(): World {
  let progressCb: ((p: UpdateProgress) => void) | null = null
  let errorCb: ((e: Error) => void) | null = null
  let check: UpdaterPort['check'] = async () => null
  let download: UpdaterPort['download'] = async () => undefined
  const w: World = {
    installs: 0,
    emitProgress: (p) => progressCb?.(p),
    emitError: (e) => errorCb?.(e),
    setCheck: (fn) => {
      check = fn
    },
    setDownload: (fn) => {
      download = fn
    },
    port: {
      check: () => check(),
      download: () => download(),
      quitAndInstall: () => {
        w.installs += 1
      },
      onProgress: (cb) => {
        progressCb = cb
      },
      onError: (cb) => {
        errorCb = cb
      }
    }
  }
  return w
}

interface Env {
  packaged?: boolean
  portable?: boolean
  busy?: string | null
  version?: string
}

function makeCenter(w: World, env: Env = {}) {
  const published: UpdateState[] = []
  const center = createUpdateCenter()
  center.init({
    currentVersion: () => env.version ?? '0.2.1',
    packaged: () => env.packaged ?? true,
    portable: () => env.portable ?? false,
    busy: () => env.busy ?? null,
    releasePageUrl: () => 'https://github.com/TgolMsk/wanlong-panel/releases/latest',
    openExternal: async () => undefined,
    updater: () => w.port,
    publish: (s) => published.push(s),
    log: () => undefined
  })
  return { center, published }
}

// ── 一、版本比较 ───────────────────────────────────────────────────────────

function checkVersions(): void {
  section('一、版本比较')
  ok('补丁号更大', compareVersions('0.2.2', '0.2.1') > 0)
  ok('次版本号更大', compareVersions('0.3.0', '0.2.9') > 0)
  ok('主版本号更大', compareVersions('1.0.0', '0.99.99') > 0)
  ok('相等', compareVersions('0.2.1', '0.2.1') === 0)
  ok('带 v 前缀也认', compareVersions('v0.2.2', '0.2.1') > 0)
  ok(
    '★ 预发布版小于同号正式版（别把人从 1.2.3 反向「更新」到 1.2.3-beta）',
    compareVersions('1.2.3-beta.1', '1.2.3') < 0
  )
  ok('预发布之间按字典序', compareVersions('1.2.3-beta.2', '1.2.3-beta.1') > 0)
  ok('垃圾输入当 0.0.0，不猜', compareVersions('不是版本号', '0.0.1') < 0)
  ok('isNewer 只在真的更新时为 true', isNewer('0.2.2', '0.2.1') && !isNewer('0.2.1', '0.2.1'))

  ok('字节格式化', formatBytes(135_400_000) === '135.4 MB' && formatBytes(0) === '0 MB')
  ok('速度格式化', formatSpeed(2_500_000) === '2.5 MB/s' && formatSpeed(0) === '—')
}

// ── 二、不支持的环境 ───────────────────────────────────────────────────────

async function checkUnsupported(): Promise<void> {
  section('二、不支持的环境')
  {
    const w = makeWorld()
    const { center } = makeCenter(w, { packaged: false })
    ok('开发模式直接短路', center.getState().phase === 'unsupported')
    ok('原因是 dev', center.getState().unsupportedReason === 'dev')
    let called = false
    w.setCheck(async () => {
      called = true
      return null
    })
    await center.check()
    ok('★ 开发模式不会真去查（省得报 dev-app-update.yml 的错）', !called)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w, { portable: true })
    ok('免安装版也不支持', center.getState().unsupportedReason === 'portable')
  }
}

// ── 三、检查 ───────────────────────────────────────────────────────────────

async function checkCheck(): Promise<void> {
  section('三、检查更新')
  {
    const w = makeWorld()
    const { center, published } = makeCenter(w)
    w.setCheck(async () => ({
      version: '0.3.0',
      releaseNotes: '修了几个 bug',
      releaseUrl: 'https://example.invalid/tag/v0.3.0'
    }))
    const s = await center.check()
    ok('发现新版本', s.phase === 'available', s.phase)
    ok('记下版本号与更新说明', s.latestVersion === '0.3.0' && s.releaseNotes === '修了几个 bug')
    ok('记下 Release 地址', s.releaseUrl === 'https://example.invalid/tag/v0.3.0')
    ok('记下检查时刻', typeof s.checkedAt === 'number' && s.checkedAt > 0)
    ok('★ 每次状态变化都推给了面板', published.length >= 2, `推了 ${published.length} 次`)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w, { version: '0.3.0' })
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    const s = await center.check()
    ok('版本相同 = 已是最新', s.phase === 'latest')
    ok(
      '没给 Release 地址时退回默认的 releases/latest',
      s.releaseUrl?.endsWith('/releases/latest') === true
    )
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w, { version: '0.9.0' })
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    ok('线上比本地旧也算最新（不往回装）', (await center.check()).phase === 'latest')
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    })
    const s = await center.check()
    ok('网络不通 → error', s.phase === 'error')
    ok('★ 错误翻成人话，不是 ENOTFOUND', s.error?.includes('连不上 GitHub') === true, s.error ?? '')
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => {
      throw new Error('HttpError: 403 rate limit exceeded')
    })
    ok('限流也有中文说法', (await center.check()).error?.includes('限流') === true)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => null)
    ok('查不到发布信息按「已是最新」处理，不报错', (await center.check()).phase === 'latest')
  }
}

// ── 四、下载 ───────────────────────────────────────────────────────────────

async function checkDownload(): Promise<void> {
  section('四、下载')
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    let msg = ''
    try {
      await center.download()
    } catch (e) {
      msg = AppError.from(e).message
    }
    ok('没检查就下载会被拒绝并说清楚怎么做', msg.includes('先点「检查更新」'), msg)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    await center.check()

    const d = deferred()
    w.setDownload(() => d.promise)
    const p = center.download()
    await new Promise((r) => setTimeout(r, 10))
    ok('进入下载中', center.getState().phase === 'downloading')

    w.emitProgress({ percent: 42, transferred: 5e7, total: 1.2e8, bytesPerSecond: 3e6 })
    ok('进度推上来了', center.getState().progress?.percent === 42)

    d.resolve()
    await p
    ok('下载完停在「待安装」，不自动装', center.getState().phase === 'downloaded')
    ok('进度已清空', center.getState().progress === null)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    await center.check()
    w.setDownload(async () => {
      throw new Error('ECONNRESET')
    })
    await center.download()
    const s = center.getState()
    ok('★ 下载失败回到「有新版本」，不卡在「正在下载」', s.phase === 'available', s.phase)
    ok('失败原因是中文的', s.error?.includes('连不上 GitHub') === true)
  }
  {
    // electron-updater 的错误走事件而不是 reject —— 下载中途断网要能自己收回来。
    const w = makeWorld()
    const { center } = makeCenter(w)
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    await center.check()
    w.setDownload(() => new Promise<void>(() => undefined))
    void center.download()
    await new Promise((r) => setTimeout(r, 10))
    w.emitError(new Error('net::ERR_CONNECTION_RESET'))
    ok(
      '★ error 事件也能把状态收回 available',
      center.getState().phase === 'available',
      center.getState().phase
    )
  }
}

// ── 五、安装闸门 ───────────────────────────────────────────────────────────

async function checkInstall(): Promise<void> {
  section('五、安装闸门（最要紧的一节）')
  const ready = async (env: Env = {}) => {
    const w = makeWorld()
    const { center } = makeCenter(w, env)
    w.setCheck(async () => ({ version: '0.3.0', releaseNotes: null, releaseUrl: null }))
    await center.check()
    await center.download()
    return { w, center }
  }
  {
    const { w, center } = await ready()
    ok('下载完了就能装', center.getState().phase === 'downloaded' && center.getState().installable)
    center.install()
    ok('调到了 quitAndInstall', w.installs === 1)
  }
  {
    const { w, center } = await ready({ busy: '实例 0 正在运行脚本。' })
    ok('有任务在跑时 installable=false', !center.getState().installable)
    ok('busyReason 说清是谁占着', center.getState().busyReason?.includes('实例 0') === true)
    ok(
      '★ 强行调 install 会被拒绝（不靠 UI 自觉）',
      throwsWith(() => center.install(), 'CONCURRENCY_LIMIT', '掐断')
    )
    ok('★★ 绝对没有调到 quitAndInstall', w.installs === 0)
  }
  {
    const w = makeWorld()
    const { center } = makeCenter(w)
    ok(
      '还没下载就点安装会被拒绝并指路',
      throwsWith(() => center.install(), 'INVALID_ARGUMENT', '先点「下载更新」')
    )
    ok('同样没有调到 quitAndInstall', w.installs === 0)
  }
}

async function main(): Promise<void> {
  console.log('===== 应用内更新离线自检（不联网、不打包）=====')
  checkVersions()
  await checkUnsupported()
  await checkCheck()
  await checkDownload()
  await checkInstall()
  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
