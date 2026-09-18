/** 使用临时数据目录和受控模拟器驱动，不创建/删除真实模拟器。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ipcMain } from 'electron'
import { InstanceProvisioner } from '@main/instanceProvisioner'
import { instanceAccess } from '@main/instanceAccess'
import { registerInstanceHandlers } from '@main/handlers/instance'
import { resetIpc } from '@main/ipc'
import type { MainDeps, MumuPort } from '@main/handlers'
import type { CreateInstanceOptions, MumuInstance } from '@shared/domain'
import { AppError } from '@shared/errors'
import { mumuWinRawToInstance, parseMumuWinInfo } from '@main/mumu/mumuwin/parse'

const root = await mkdtemp(join(tmpdir(), 'wl-instances-check-'))
function instance(index: number): MumuInstance {
  return {
    index,
    name: `实例 ${index}`,
    identity: `test:${index}`,
    state: 'stopped',
    adbPort: null,
    pid: null,
    screenReady: false,
    bundlePath: null,
    serial: null,
    adb: 'disconnected',
    accountId: null,
    runId: null
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
let list = [instance(0), instance(1)]
let nextIndex = 10
let clones: number[] = []
let blank: CreateInstanceOptions[] = []
let failAt = 0
let ambiguous = false
let beforeClone = async () => {}
let beforeRefresh = async () => {}
/** 假驱动不支持摆窗口 —— 正好顺带验证「不支持时面板该拿到 false」。 */
const windowCalls: string[] = []
const driver: MumuPort = {
  windowSupported: () => false,
  window: async (index, action) => {
    windowCalls.push(`${index}:${action}`)
  },
  list: () => list,
  get: (i) => list.find((v) => v.index === i),
  refresh: async () => {
    await beforeRefresh()
    return [...list]
  },
  create: async (opts) => {
    blank.push(opts)
    const i = nextIndex++
    list.push(instance(i))
    return [i]
  },
  clone: async (from) => {
    clones.push(from)
    await beforeClone()
    if (failAt === clones.length) throw new AppError('IO_ERROR', '模拟磁盘不足')
    const i = nextIndex++
    list.push(instance(i))
    if (ambiguous) throw new AppError('MUMU_BAD_OUTPUT', '模拟复制成功但 CLI 返回异常')
    return [i]
  },
  remove: async (i) => {
    list = list.filter((v) => v.index !== i)
  },
  open: async () => {},
  close: async () => {},
  restart: async () => {},
  config: async () => {},
  patch: () => {}
}
const dirA = join(root, 'a')
const dirB = join(root, 'b')
const service = new InstanceProvisioner(driver, () => dirA)
try {
  assert.equal(await service.getBase(), null)
  await service.create({ count: 1, settings: { cpu: 4 } })
  assert.equal(blank.length, 1)
  assert.deepEqual(blank[0], { count: 1, type: undefined, settings: { cpu: 4 } })
  assert.equal((await service.setBase(0))?.index, 0)
  assert.equal((await new InstanceProvisioner(driver, () => dirA).getBase())?.index, 0)
  assert.equal(await new InstanceProvisioner(driver, () => dirB).getBase(), null)
  const saved = await readFile(join(dirA, 'instance-defaults.json'), 'utf8')
  await assert.rejects(service.setBase(-1), /实例编号无效/)
  await assert.rejects(service.setBase(404), /不存在/)
  assert.equal(await readFile(join(dirA, 'instance-defaults.json'), 'utf8'), saved)
  console.log('PASS 基础实例 0、重启持久化、上下文隔离与无效输入')

  const created = await service.create({ count: 3, expectedBaseIndex: 0 })
  assert.equal(created.length, 3)
  assert.equal(new Set(created).size, 3)
  assert.deepEqual(clones, [0, 0, 0])
  assert.equal(blank.length, 1)
  await service.create({ source: 'blank', count: 1 })
  assert.equal(blank.length, 2)
  await assert.rejects(service.create({ source: 'base', expectedBaseIndex: 1 }), /基础实例已改变/)
  await assert.rejects(service.create({ source: 'base', settings: { cpu: 4 } }), /沿用基础实例配置/)
  for (const count of [0, -1, 1.5, 9, NaN])
    await assert.rejects(service.create({ count }), /创建数量/)
  await assert.rejects(service.create({ source: 'other' as 'base' }), /创建方式无效/)
  console.log('PASS 默认克隆、明确空白新建、同源批量、数量及源变化校验')

  const base = list.find((i) => i.index === 0)!
  base.name = '改名仍是原实例'
  await service.create({ source: 'base' })
  base.state = 'running'
  const attempts = clones.length
  await assert.rejects(service.create({}), /请先关闭源实例/)
  await assert.rejects(service.clone(0), /请先关闭源实例/)
  assert.equal(clones.length, attempts)
  base.state = 'stopped'
  base.identity = 'test:replaced'
  await assert.rejects(service.create({}), /已被替换/)
  await service.setBase(0)
  await service.create({})
  list = list.filter((i) => i.index !== 0)
  await assert.rejects(service.create({}), /源实例 0 已不存在/)
  list.unshift(base)
  console.log('PASS 运行状态、改名、编号复用及源实例消失保护')

  const held = instanceAccess.acquire(0, '自动采集')
  await assert.rejects(service.create({}), /自动采集/)
  held()
  const entered = gate(),
    finish = gate()
  beforeClone = async () => {
    entered.release()
    await finish.promise
  }
  const pending = service.create({ count: 2 })
  await entered.promise
  await assert.rejects(service.create({ source: 'blank' }), /正在创建/)
  await assert.rejects(service.clone(1), /正在创建/)
  await assert.rejects(service.setBase(1), /正在创建/)
  await assert.rejects(
    service.remove(0, async () => {}),
    /正在创建/
  )
  assert.throws(() => instanceAccess.acquire(0, '启动脚本'), /克隆实例/)
  await assert.rejects(
    service.withInstance(0, '启动实例', async () => {}),
    /克隆实例/
  )
  finish.release()
  await pending
  beforeClone = async () => {}
  const release = instanceAccess.acquire(0, '检查释放')
  release()
  // 第一处异步读盘尚未完成时也已预留创建位置。
  const waiting = service.create({ source: 'blank' })
  await assert.rejects(service.clone(0), /正在创建/)
  await waiting
  console.log('PASS 克隆与脚本/采集/生命周期互斥，首个 await 前占用及完成释放')

  failAt = clones.length + 2
  const firstPartial = nextIndex
  await assert.rejects(service.create({ count: 3 }), (e: unknown) => {
    assert(e instanceof AppError)
    assert.deepEqual(e.detail?.created, [firstPartial])
    assert.match(e.message, /仅补建缺少的数量/)
    return true
  })
  assert(list.some((i) => i.index === firstPartial))
  failAt = 0
  ambiguous = true
  const uncertain = nextIndex
  await assert.rejects(service.create({}), (e: unknown) => {
    assert(e instanceof AppError)
    assert.deepEqual(e.detail?.created, [uncertain])
    return true
  })
  ambiguous = false
  await service.create({})
  console.log('PASS 中途失败保留副本、CLI 成功后报错的差集提示、失败后可继续')

  const readEntered = gate(),
    readFinish = gate()
  beforeRefresh = async () => {
    readEntered.release()
    await readFinish.promise
  }
  const deletion = service.clone(1)
  await readEntered.promise
  await assert.rejects(
    service.withInstance(1, '修改配置', async () => {}),
    /克隆实例/
  )
  readFinish.release()
  await deletion
  beforeRefresh = async () => {}
  await service.remove(1, async () => {})
  assert.equal((await service.getBase())?.index, 0)
  await service.remove(0, async () => {})
  assert.equal(await service.getBase(), null)
  console.log('PASS 读取实例列表期间已锁源，删除普通实例不改基础设置，删除基础实例自动清除')

  await writeFile(join(dirA, 'instance-defaults.json'), '{broken')
  await assert.rejects(service.getBase(), /文件损坏/)
  await assert.rejects(service.setBase(null), /文件损坏/)
  await assert.rejects(service.create({}), /文件损坏/)
  assert.equal(await readFile(join(dirA, 'instance-defaults.json'), 'utf8'), '{broken')
  await writeFile(join(dirA, 'instance-defaults.json'), saved)
  await service.setBase(null)
  console.log('PASS 损坏设置不覆盖，修复文件后恢复正常')

  const raw = parseMumuWinInfo({
    index: '0',
    name: 'base',
    created_timestamp: 1789360564667697
  })[0]!
  assert.equal(mumuWinRawToInstance(raw).identity, 'mumu:1789360564667697')
  assert.equal(
    mumuWinRawToInstance(parseMumuWinInfo({ index: '0', name: 'legacy' })[0]!).identity,
    null
  )
  console.log('PASS MuMu 稳定身份解析及旧版本字段兼容')

  const main = {
    mumu: driver,
    paths: () => ({ dataDir: dirB }),
    adb: { detach: async () => {} }
  } as unknown as MainDeps
  main.provisioner = new InstanceProvisioner(driver, () => dirB)
  registerInstanceHandlers(main)
  const invoke = (
    ipcMain as unknown as { _invoke(ch: string, ...args: unknown[]): Promise<unknown> }
  )._invoke
  const sourceIndex = list[0]!.index
  assert.equal(await invoke('instance:base'), null)
  await invoke('instance:setBase', sourceIndex)
  assert.equal(((await invoke('instance:base')) as { index: number }).index, sourceIndex)
  const ipcCreated = (await invoke('instance:create', { count: 1 })) as number[]
  assert.equal(ipcCreated.length, 1)
  await invoke('instance:delete', sourceIndex)
  assert.equal(await invoke('instance:base'), null)
  console.log('PASS IPC 设置 → 默认克隆 → 删除后清除基础实例')
} finally {
  resetIpc()
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert(basename(root).startsWith('wl-instances-check-'))
  await rm(root, { recursive: true, force: true })
}
