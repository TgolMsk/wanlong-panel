/**
 * 挂机预置脚本 —— 为「实例 0」建好账号并写入一份可直接挂机的采集配置。
 *
 * 走的是工程自己的 saveAccount / normalizeGatherConfig，所以会经过完整 schema 校验：
 * 宁可在这里报错，也不要写出一份面板下次启动读不回来的文件。
 *
 * 只做数据预置，不碰模拟器、不打开自动调度 —— 是否开始真正派兵由用户在面板上决定。
 */
import { listAccounts, saveAccount } from '@main/store/accounts'
import { join } from 'node:path'
import { DEFAULT_GATHER_CONFIG, normalizeGatherConfig } from '@main/game/gather/config'
import type { Account } from '@shared/domain'

const GAME_PACKAGE = 'com.lilithgames.samo.android.cn'
const INSTANCE = Number(process.env.WL_INSTANCE ?? '0')
const NAME = process.env.WL_NAME ?? `主号 · 实例${INSTANCE}`

async function main(): Promise<void> {
  // 不走 @main/paths（它 import electron 的 app，脚本外跑不了）。
  // 开发模式的数据目录就是 <工程根>/.wl-data，见 src/main/paths.ts:38。
  const accountsDir = join(process.cwd(), '.wl-data', 'accounts')
  const existing = await listAccounts(accountsDir)
  console.log(`现有账号 ${existing.length} 个`)

  // 采集配置：默认值基础上开启采集。资源沿用默认（木2/金1/铁1，魔水关闭）。
  const gather = normalizeGatherConfig({
    ...DEFAULT_GATHER_CONFIG,
    enabled: true
  })

  const bound = existing.find((a) => a.instanceIndex === INSTANCE)
  const now = Date.now()
  const account: Account = bound
    ? { ...bound, enabled: true }
    : {
        id: `acc_wanlong_${INSTANCE}`,
        name: NAME,
        packageName: GAME_PACKAGE,
        instanceIndex: INSTANCE,
        note: '万龙觉醒挂机测试账号（由 seed-afk 预置）',
        enabled: true,
        createdAt: now,
        updatedAt: now
      }

  account.scriptParams = {
    ...(account.scriptParams ?? {}),
    gather: { configJson: JSON.stringify(gather) }
  }

  const saved = await saveAccount(accountsDir, account)
  console.log(`✅ 账号已保存：${saved.name}（id=${saved.id}，绑定实例 ${saved.instanceIndex}）`)

  // 读回来验证：确保面板下次启动能正确解析
  const back = (await listAccounts(accountsDir)).find((a) => a.id === saved.id)
  if (!back) throw new Error('读回失败：账号不在列表里')
  const raw = back.scriptParams?.gather?.configJson
  if (typeof raw !== 'string') throw new Error('读回失败：采集配置不是字符串')
  const parsed = normalizeGatherConfig(JSON.parse(raw))
  console.log('✅ 读回校验通过：')
  console.log(`   采集开关 enabled = ${parsed.enabled}`)
  console.log(`   联盟策略 = ${parsed.thresholds.allianceTerritory}（应为 any）`)
  console.log(
    `   资源 = ${parsed.resources.filter((r) => r.enabled).map((r) => `${r.type}×${r.queues}`).join(', ')}`
  )
  const lp = parsed.levelPolicy
  console.log(
    lp.mode === 'relative'
      ? `   等级策略 = 相对（上限 ${lp.offset}），搜索下限不低于 ${lp.minLevel}`
      : `   等级策略 = 绝对等级 ${lp.level}，下限不低于 ${lp.minLevel}`
  )
  console.log(`   最小储量 = ${parsed.thresholds.minStorage}，单程上限 = ${parsed.thresholds.maxTravelSeconds}s`)
  console.log(`   账号文件：${accountsDir}/accounts.json`)
}

main().catch((e) => {
  console.error('❌ 预置失败：', e)
  process.exit(1)
})
