/**
 * 实例生命周期通道 —— 全部转发给模块 a（mumutool 封装）。
 *
 * 推送策略：不在这里手动 emit('instance:changed')。
 * 注册表内部做内容 diff 并在真正变化时触发 onChange，由 src/main/index.ts 统一转成 IPC 推送。
 * 这里只负责「操作完立刻 refresh 一次」，让用户点完按钮马上看到结果，而不是等下一轮轮询（3 秒）。
 */

import { CH } from '@shared/ipc'
import { emit, handle } from '@main/ipc'
import type { MainDeps } from './index'

export function registerInstanceHandlers(deps: MainDeps): void {
  const provisioner = deps.provisioner
  handle(CH.instanceBase, () => provisioner.getBase())
  handle(CH.instanceSetBase, async (index) => {
    const base = await provisioner.setBase(index)
    emit('instance:baseChanged', base)
    return base
  })
  handle(CH.instanceList, () => deps.mumu.list())

  handle(CH.instanceRefresh, () => deps.mumu.refresh())

  handle(CH.instanceOpen, (index) =>
    provisioner.withInstance(index, '启动实例', async () => {
      await deps.mumu.open(index)
      await refreshQuietly(deps)
    })
  )

  handle(CH.instanceClose, (index) =>
    provisioner.withInstance(index, '关闭实例', async () => {
      await deps.mumu.close(index)
      // 实例都关了，adb 那边的 serial 与设备信息全部作废，必须清掉；
      // 否则下次开机端口变了，缓存里的旧 serial 会让所有命令打空。
      await dropDevice(deps, index)
      await refreshQuietly(deps)
    })
  )

  handle(CH.instanceRestart, (index) =>
    provisioner.withInstance(index, '重启实例', async () => {
      await deps.mumu.restart(index)
      await dropDevice(deps, index)
      await refreshQuietly(deps)
    })
  )

  handle(CH.instanceCreate, async (opts) => {
    try {
      return await provisioner.create(opts)
    } finally {
      await refreshQuietly(deps)
    }
  })

  handle(CH.instanceClone, async (index) => {
    try {
      return await provisioner.clone(index)
    } finally {
      await refreshQuietly(deps)
    }
  })

  handle(CH.instanceDelete, async (index) => {
    try {
      await provisioner.remove(index, () => dropDevice(deps, index))
      emit('instance:baseChanged', await provisioner.getBase())
    } finally {
      await refreshQuietly(deps)
    }
  })

  handle(CH.instanceConfig, (index, settings) =>
    provisioner.withInstance(index, '写入实例配置', async () => {
      await deps.mumu.config(index, settings)
      // 配置里很可能改了分辨率，而坐标换算依赖缓存的 screenWidth/Height，
      // 这里必须断开，强制下次使用时重新采集设备信息。
      await dropDevice(deps, index)
      await refreshQuietly(deps)
    })
  )
}

// ── 内部 ─────────────────────────────────────────────────────────────────

/** 断开 adb 并把连接态写回注册表。没连过也安全（模块 b 内部会静默返回）。 */
async function dropDevice(deps: MainDeps, index: number): Promise<void> {
  try {
    await deps.adb.detach(index)
  } catch {
    // 实例都关了，disconnect 失败无所谓，缓存已经清了。
  }
  deps.mumu.patch(index, { adb: 'disconnected' })
}

/**
 * 刷新失败不该让「关闭实例」这类操作整体报错 —— 操作本身已经成功了，
 * 拿不到最新列表只是显示滞后，下一轮轮询会自己补上。
 */
async function refreshQuietly(deps: MainDeps): Promise<void> {
  try {
    await deps.mumu.refresh()
  } catch (e) {
    console.warn('[instance] 操作已下发，但刷新实例列表失败：', e)
  }
}
