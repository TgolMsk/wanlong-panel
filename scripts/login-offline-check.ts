import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AccountLoginCoordinator, type LoginDeps } from '@main/login/coordinator'
import { parseNativeUi, byId, type NativeNode } from '@main/login/nativeUi'
import { executePhoneCommand, phoneScreen, type PhoneDriverIo } from '@main/login/phoneDriver'
import { instanceAccess } from '@main/instanceAccess'
import {
  prepareLoginAccount,
  completeLoginAccount,
  saveAccount,
  listAccounts,
  bindAccount
} from '@main/store/accounts'
import { GAME_PACKAGE } from '@main/game/gather/geometry'
import { AppError } from '@shared/errors'
import type { Account, DeviceInfo, MumuInstance } from '@shared/domain'
import type { LoginCommand } from '@shared/login'
import { getScheduler, type SchedulerDeps } from '@main/scheduler'

const root = await mkdtemp(join(tmpdir(), 'wl-login-check-'))
const coordinators: AccountLoginCoordinator[] = []
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  assert.fail('test did not reach expected state')
}
function instance(index: number): MumuInstance {
  return {
    index,
    name: `实例 ${index}`,
    identity: `test:${index}`,
    state: 'running',
    adbPort: 16000 + index,
    pid: 1,
    screenReady: true,
    bundlePath: null,
    serial: null,
    adb: 'disconnected',
    accountId: null,
    runId: null
  }
}
function harness(override: Partial<LoginDeps> = {}) {
  const records: string[] = []
  const deps: LoginDeps = {
    base: async () => null,
    instances: async () => [instance(20), instance(21), instance(22)],
    open: async () => {
      records.push('open')
    },
    device: async (index) => ({ serial: `test:${index}` }) as DeviceInfo,
    maxInstances: () => 4,
    pauseAuto: async () => {
      records.push('pause')
    },
    prepare: async (request, identity) => {
      records.push('prepare')
      return {
        id: request.accountId,
        name: '测试',
        instanceIndex: request.instanceIndex,
        setup: { status: 'pending', instanceIdentity: identity, verifiedAt: null },
        enabled: false
      } as Account
    },
    complete: async () => {
      records.push('complete')
      return {} as Account
    },
    launch: async () => {
      records.push('launch')
    },
    input: async () => {
      records.push('input')
    },
    verify: async () => true,
    command: async () => {
      records.push('command')
      return { step: 'code', message: '请输入验证码' }
    },
    changed: () => {},
    accountsChanged: () => {},
    ...override
  }
  const service = new AccountLoginCoordinator(deps)
  coordinators.push(service)
  return { service, deps, records }
}
async function ready(h: ReturnType<typeof harness>, index = 20, accountId = 'a') {
  const session = h.service.begin({ instanceIndex: index, accountId, newAccountName: '测试' })
  await until(() => h.service.session(index)?.phase === 'awaitingLogin')
  return session
}

try {
  const dir = join(root, 'accounts')
  const request = {
    accountId: 'a',
    name: '测试账号',
    instanceIndex: 20,
    identity: 'test:20',
    packageName: GAME_PACKAGE
  }
  const account = await prepareLoginAccount(dir, request)
  assert.equal(account.enabled, false)
  assert.equal(account.setup?.status, 'pending')
  await prepareLoginAccount(dir, request)
  assert.equal((await listAccounts(dir)).length, 1)
  await assert.rejects(prepareLoginAccount(dir, { ...request, accountId: 'b' }), /已绑定/)
  await assert.rejects(prepareLoginAccount(dir, { ...request, instanceIndex: 21 }), /其他实例/)
  await assert.rejects(completeLoginAccount(dir, 'a', 20, 'replaced'), /绑定已改变/)
  const spoof = await saveAccount(dir, {
    ...account,
    enabled: true,
    setup: { status: 'ready', instanceIdentity: 'test:20', verifiedAt: 1 }
  })
  assert.equal(spoof.enabled, false)
  assert.equal(spoof.setup?.status, 'pending')
  const completed = await completeLoginAccount(dir, 'a', 20, 'test:20')
  assert.equal(completed.enabled, true)
  assert.ok(completed.setup?.verifiedAt)
  await saveAccount(dir, { ...completed, setup: undefined, note: '修改普通字段' })
  assert.equal((await listAccounts(dir))[0].setup?.status, 'ready')
  await bindAccount(dir, 'a', 20)
  assert.equal((await listAccounts(dir))[0].setup?.status, 'ready')
  await bindAccount(dir, 'a', 21)
  assert.equal((await listAccounts(dir))[0].setup?.status, 'pending')
  assert.equal((await listAccounts(dir))[0].enabled, false)
  console.log(
    'PASS 登录账号原子绑定、幂等创建、禁止抢绑、校验后启用、普通编辑保留状态、改绑重新检查'
  )

  const initial = gate()
  const h = harness({
    base: async () => {
      await initial.promise
      return null
    }
  })
  const first = h.service.begin({ instanceIndex: 20, accountId: 'a', newAccountName: '测试' })
  assert.equal(h.service.begin({ instanceIndex: 20, accountId: 'a' }).id, first.id)
  assert.throws(() => h.service.begin({ instanceIndex: 21, accountId: 'a' }), /正在登录/)
  assert.throws(() => instanceAccess.acquire(20, '测试互斥'), /登录/)
  const cancel = h.service.cancel(first.id)
  assert.throws(() => instanceAccess.acquire(20, '取消尚未收尾'), /登录/)
  initial.release()
  await cancel
  assert.equal(h.service.session(20)?.phase, 'cancelled')
  assert.deepEqual(h.records, [])
  instanceAccess.acquire(20, '取消后释放')()
  console.log('PASS 第一个 await 前锁定实例与账号、重复开始复用会话、取消等待 I/O 后释放')

  const base = harness({ base: async () => ({ index: 20, name: '基础', identity: 'test:20' }) })
  base.service.begin({ instanceIndex: 20, accountId: 'base' })
  await until(() => base.service.session(20)?.phase === 'failed')
  assert.match(base.service.session(20)!.message, /基础实例/)
  assert.deepEqual(base.records, [])
  const bootFailure = harness({
    launch: async () => {
      throw new Error('游戏未安装')
    }
  })
  bootFailure.service.begin({ instanceIndex: 20, accountId: 'a' })
  await until(() => bootFailure.service.session(20)?.phase === 'failed')
  assert.deepEqual(bootFailure.records, ['pause', 'prepare'])
  instanceAccess.acquire(20, '启动失败释放')()

  const startWait = gate()
  const startEntered = gate()
  const limit = harness({
    maxInstances: () => 1,
    instances: async () => [20, 21].map((i) => ({ ...instance(i), state: 'stopped' })),
    open: async () => {
      startEntered.release()
      await startWait.promise
    }
  })
  const start = limit.service.begin({ instanceIndex: 20, accountId: 'a' })
  await startEntered.promise
  limit.service.begin({ instanceIndex: 21, accountId: 'b' })
  await until(() => limit.service.session(21)?.phase === 'failed')
  assert.match(limit.service.session(21)!.message, /上限/)
  const stopStart = limit.service.cancel(start.id)
  startWait.release()
  await stopStart
  console.log('PASS 基础实例保护、启动失败保留待登录账号、并发启动预留名额')

  const inputEntered = gate(),
    inputEnd = gate()
  const queued = harness({
    input: async () => {
      queued.records.push('input')
      inputEntered.release()
      await inputEnd.promise
    }
  })
  const queuedSession = await ready(queued)
  const p1 = queued.service
    .input(queuedSession.id, { kind: 'text', text: '123456' })
    .catch((e) => e)
  await inputEntered.promise
  const p2 = queued.service.input(queuedSession.id, { kind: 'key', key: 'ENTER' }).catch((e) => e)
  const stopQueued = queued.service.cancel(queuedSession.id)
  assert.throws(() => instanceAccess.acquire(20, '输入仍在收尾'), /登录/)
  inputEnd.release()
  await Promise.all([p1, p2, stopQueued])
  assert.equal(queued.records.filter((r) => r === 'input').length, 1)
  const secretError = harness({
    input: async () => {
      throw new Error('sensitive 123456 base64 MTIzNDU2')
    }
  })
  const secretSession = await ready(secretError)
  await assert.rejects(
    secretError.service.input(secretSession.id, { kind: 'text', text: '123456' }),
    (e: AppError) => {
      assert.ok(!JSON.stringify(e.toSerializable()).match(/123456|MTIzNDU2/))
      return true
    }
  )
  await secretError.service.cancel(secretSession.id)
  console.log('PASS 取消后丢弃排队输入、设备 I/O 收尾期间保持互斥、输入异常不回传敏感内容')

  const commandEnd = gate(),
    commandEntered = gate()
  const commands = harness({
    command: async () => {
      commands.records.push('command')
      commandEntered.release()
      await commandEnd.promise
      return { step: 'code', message: '验证码' }
    }
  })
  const commandSession = await ready(commands)
  const sms: LoginCommand = {
    requestId: 'request-1',
    action: 'requestSms',
    phone: '13800000000',
    agreementAccepted: true
  }
  const c1 = commands.service.command(commandSession.id, sms)
  await commandEntered.promise
  const c2 = commands.service.command(commandSession.id, sms)
  await assert.rejects(
    commands.service.command(commandSession.id, { ...sms, phone: '13900000000' }),
    /同一请求编号/
  )
  commandEnd.release()
  const commandResult = await c1
  assert.deepEqual(await c2, commandResult)
  assert.equal(commands.records.filter((v) => v === 'command').length, 1)
  const snapshot = commands.service.session(20)!
  snapshot.screen!.message = '外部修改'
  assert.notEqual(commands.service.session(20)!.screen!.message, '外部修改')
  await assert.rejects(commands.service.verify(commandSession.id, false), /先确认/)
  commands.deps.verify = async () => false
  await assert.rejects(commands.service.verify(commandSession.id, true), /尚未识别/)
  assert.equal(commands.service.session(20)?.phase, 'awaitingLogin')
  assert.equal(commands.records.includes('complete'), false)
  commands.deps.verify = async () => true
  assert.equal((await commands.service.verify(commandSession.id, true)).phase, 'completed')
  assert.equal(commands.records.filter((v) => v === 'complete').length, 1)
  assert.equal(commands.records.filter((v) => v === 'pause').length, 1)
  instanceAccess.acquire(20, '完成释放')()
  console.log(
    'PASS API 操作幂等、冲突请求拒绝、快照隔离、用户确认与画面双重检查、失败不启用、不自动恢复采集'
  )

  const commitEntered = gate(),
    commitEnd = gate()
  const committing = harness({
    complete: async () => {
      commitEntered.release()
      await commitEnd.promise
      return {} as Account
    }
  })
  const commitSession = await ready(committing)
  const commit = committing.service.verify(commitSession.id, true)
  await commitEntered.promise
  const closeDuringCommit = committing.service.cancel(commitSession.id)
  assert.throws(() => instanceAccess.acquire(20, '提交期间仍占用'), /登录/)
  commitEnd.release()
  await Promise.all([commit, closeDuringCommit])
  assert.equal(committing.service.session(20)?.phase, 'completed')
  instanceAccess.acquire(20, '提交结束释放')()
  console.log('PASS 账号完成写入期间关闭向导，等待提交结果并保持状态一致')

  const phoneXml = await readFile(resolve('resources/login/fixtures/phone.xml'), 'utf8')
  const codeXml = await readFile(resolve('resources/login/fixtures/code.xml'), 'utf8')
  const gameXml = await readFile(resolve('resources/login/fixtures/game.xml'), 'utf8')
  const phoneNodes = parseNativeUi(phoneXml),
    codeNodes = parseNativeUi(codeXml),
    gameNodes = parseNativeUi(gameXml)
  assert.equal(phoneScreen(phoneNodes).step, 'phone')
  assert.equal(phoneScreen(codeNodes).step, 'code')
  assert.equal(phoneScreen(codeNodes).phoneMasked, '138****0000')
  assert.equal(phoneScreen(gameNodes).step, 'game')
  assert.equal(byId([...phoneNodes, ...phoneNodes], 'phoneEditText'), undefined)
  assert.equal(parseNativeUi(phoneXml.replaceAll(GAME_PACKAGE, 'other.package')).length, 0)
  const phoneEvents: string[] = []
  let page: NativeNode[] = structuredClone(phoneNodes)
  byId(page, 'agreementCheckBox')!.checked = false
  const io: PhoneDriverIo = {
    read: async () => structuredClone(page),
    fill: async (_serial, node, value) => {
      phoneEvents.push('fill')
      if (node.id.endsWith('phoneEditText')) byId(page, 'phoneEditText')!.text = value
      else page = gameNodes
    },
    key: async () => {
      phoneEvents.push('key')
    },
    click: async (_serial, node) => {
      phoneEvents.push(node.id.split('/').at(-1)!)
      if (node.id.endsWith('agreementCheckBox')) byId(page, 'agreementCheckBox')!.checked = true
      if (node.id.endsWith('submitButton')) page = codeNodes
    }
  }
  const signal = new AbortController().signal
  assert.equal((await executePhoneCommand('fake', sms, signal, io)).step, 'code')
  assert.deepEqual(phoneEvents, ['fill', 'key', 'agreementCheckBox', 'submitButton'])
  await assert.rejects(
    executePhoneCommand('fake', { requestId: 'resend', action: 'resendCode' }, signal, io),
    /倒计时/
  )
  assert.equal(
    (
      await executePhoneCommand(
        'fake',
        { requestId: 'code', action: 'submitCode', code: '123456' },
        signal,
        io
      )
    ).step,
    'game'
  )
  await assert.rejects(executePhoneCommand('fake', sms, signal, io), /页面与操作不符/)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(executePhoneCommand('fake', sms, abort.signal, io))
  console.log(
    'PASS 实测控件素材回放、脱敏、重复控件拒绝、跨应用过滤、手机号→协议→验证码→游戏、倒计时及取消保护'
  )

  const scheduler = getScheduler()
  const internals = scheduler as unknown as {
    deps: SchedulerDeps
    persist(): Promise<void>
    sample(): Promise<void>
  }
  const approval = gate()
  internals.deps = {
    ensureAutomationReady: async () => approval.promise
  } as unknown as SchedulerDeps
  internals.persist = async () => {}
  let samples = 0
  internals.sample = async () => {
    samples++
  }
  const enable = scheduler.setAuto(777, true)
  await scheduler.setAuto(777, false)
  approval.release()
  assert.equal((await enable).auto, false)
  assert.equal(samples, 0)
  internals.deps.ensureAutomationReady = async () => {
    throw new Error('待登录')
  }
  await assert.rejects(scheduler.setAuto(777, true), /待登录/)
  assert.equal(samples, 0)
  console.log('PASS 登录资格检查期间暂停仍优先、待登录账号无法开启自动采集')
} finally {
  await Promise.all(coordinators.map((c) => c.shutdown()))
  // 删除前校验临时目录范围，不接触真实实例与项目账号数据。
  assert.ok(
    resolve(root).startsWith(resolve(tmpdir()) + '\\') ||
      resolve(root).startsWith(resolve(tmpdir()) + '/')
  )
  await rm(root, { recursive: true, force: true })
}
