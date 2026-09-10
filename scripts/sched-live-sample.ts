/**
 * 现场采样一次：对指定实例直接跑调度器的 sampleTroopPanel（不经过面板里的调度器），
 * 用来验证导航判据 / 模板改动在真机上的表现（城内→世界地图→部队管理面板→读数→关面板）。
 * 会真的点击，但**不会派兵**。
 *
 *   npm run live:sample -- <实例序号> <adb端口>      例：npm run live:sample -- 1 16416
 *
 * ⚠️ 面板若正在自动调度同一实例，两边会互相干扰；跑之前确认该实例已暂停或没到唤醒点。
 */

import { join } from 'node:path'
import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import { setTemplatesDir } from '@vision/index'
import { attach, captureRaw, initAdb, key, tap } from '@main/adb/index'
import { getTemplates } from '@main/scheduler/templates'
import { sampleTroopPanel, type SampleIo } from '@main/scheduler/troopPanel'

const index = Number(process.argv[2] ?? 0)
const port = Number(process.argv[3] ?? 16384)

async function main(): Promise<void> {
  setTemplatesDir(join(process.cwd(), '.wl-data', 'templates'))
  await initAdb({})
  const dev = await attach(index, port)
  const t = await getTemplates({ templateSetId: '', refWidth: REF_WIDTH })
  const io: SampleIo = {
    serial: dev.serial,
    capture: () => captureRaw(dev.serial, { throttle: false }),
    tapRef: (x, y) =>
      tap(
        dev.serial,
        Math.round((x * dev.screenWidth) / REF_WIDTH),
        Math.round((y * dev.screenHeight) / REF_HEIGHT)
      ),
    key: (k) => key(dev.serial, k),
    log: (level, message) => console.log(`[${level}] ${message}`),
    onUnrecognized: async () => {
      console.log('[probe] 采样器认不出界面，把帧交给了探针（本脚本不接告警中心，按未命中处理）')
      return false
    }
  }
  const t0 = Date.now()
  const s = await sampleTroopPanel(io, t, {
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    maxRows: 5,
    readOptionalFields: true,
    closePanelAfterSample: true,
    deadlineAt: Date.now() + 120_000
  })
  console.log(
    `\n实例 ${index}（${dev.serial}）采样完成，${Date.now() - t0}ms：队列 ${s.queueUsed ?? '?'}/${s.queueTotal ?? '?'}`
  )
  for (const r of s.rows) {
    console.log(
      `  #${r.slot} ${r.status.padEnd(14)} ${r.statusText} 倒计时=${r.remainingMs ?? '-'} 坐标=${r.targetCoord ?? '-'} 资源=${r.resourceType ?? '-'}`
    )
  }
  for (const w of s.warnings) console.log(`  ⚠ ${w}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
