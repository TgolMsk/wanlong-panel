import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { Account, BaseInstanceSelection, DeviceInfo, MumuInstance } from '@shared/domain'
import {
  isLoginActive,
  type LoginCommand,
  type LoginInput,
  type LoginRequest,
  type LoginScreen,
  type LoginSession
} from '@shared/login'
import { instanceAccess } from '@main/instanceAccess'

export interface LoginDeps {
  base(): Promise<BaseInstanceSelection | null>
  instances(): Promise<MumuInstance[]>
  open(index: number): Promise<void>
  device(index: number): Promise<DeviceInfo>
  maxInstances(): number
  pauseAuto(index: number): Promise<unknown>
  prepare(input: LoginRequest, identity: string | null): Promise<Account>
  complete(id: string, index: number, identity: string | null): Promise<Account>
  launch(serial: string): Promise<void>
  input(device: DeviceInfo, input: LoginInput): Promise<void>
  command?(serial: string, command: LoginCommand, signal: AbortSignal): Promise<LoginScreen>
  verify(serial: string): Promise<boolean>
  changed(session: LoginSession): void
  accountsChanged(): void
  wait?(ms: number, signal: AbortSignal): Promise<void>
}

interface Task {
  view: LoginSession
  controller: AbortController
  release: () => void
  tail: Promise<unknown>
  identity: string | null
  device?: DeviceInfo
  commands: Map<string, { fingerprint: string; result: Promise<LoginSession> }>
  committing?: boolean
}
const requestSchema = z.object({
  instanceIndex: z.number().int().nonnegative(),
  accountId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/),
  newAccountName: z.string().trim().min(1).max(100).optional()
})
const point = z.object({
  x: z.number().finite().min(0).max(2560),
  y: z.number().finite().min(0).max(1440)
})
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), at: point }),
  z.object({
    kind: z.literal('swipe'),
    at: point,
    to: point,
    durationMs: z.number().int().min(50).max(2000)
  }),
  z.object({
    kind: z.literal('key'),
    key: z.enum([
      'BACK',
      'HOME',
      'ENTER',
      'MENU',
      'APP_SWITCH',
      'DEL',
      'ESCAPE',
      'VOLUME_UP',
      'VOLUME_DOWN'
    ])
  }),
  z.object({
    kind: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(256)
      .refine((v) => !/[\0\r\n]/.test(v))
  })
])
const commandId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/)
const commandSchema = z.discriminatedUnion('action', [
  z.object({ requestId: commandId, action: z.literal('inspect') }),
  z.object({
    requestId: commandId,
    action: z.literal('requestSms'),
    phone: z.string().regex(/^1[3-9]\d{9}$/),
    agreementAccepted: z.literal(true)
  }),
  z.object({
    requestId: commandId,
    action: z.literal('submitCode'),
    code: z.string().regex(/^\d{6}$/)
  }),
  z.object({ requestId: commandId, action: z.literal('resendCode') })
])

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AppError('CANCELLED', '登录向导已结束。'))
    const abort = (): void => {
      clearTimeout(timer)
      reject(new AppError('CANCELLED', '登录向导已结束。'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 登录期间持有实例占用，输入按序执行；取消等最后一次 I/O 结束后才释放。 */
export class AccountLoginCoordinator {
  private tasks = new Map<number, Task>()
  private starting = new Set<number>()
  private closing = false
  constructor(private readonly deps: LoginDeps) {}

  session(index: number): LoginSession | null {
    const task = this.tasks.get(index)
    return task ? structuredClone(task.view) : null
  }

  assertEditable(accountId: string, indices: (number | null | undefined)[] = []): void {
    if (
      [...this.tasks.values()].some(
        (t) =>
          isLoginActive(t.view.phase) &&
          (t.view.accountId === accountId || indices.includes(t.view.instanceIndex))
      )
    ) {
      throw new AppError('CONCURRENCY_LIMIT', '该账号或实例正在登录，请先结束登录向导再修改。')
    }
  }

  begin(input: LoginRequest): LoginSession {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new AppError('INVALID_ARGUMENT', '请检查实例、账号名称和账号编号。')
    input = parsed.data
    if (this.closing) throw new AppError('CANCELLED', '面板正在退出。')
    const current = this.tasks.get(input.instanceIndex)
    if (current && isLoginActive(current.view.phase)) {
      if (current.view.accountId === input.accountId) return structuredClone(current.view)
      throw new AppError('CONCURRENCY_LIMIT', '该实例已有登录向导。')
    }
    this.assertEditable(input.accountId)
    const release = instanceAccess.acquire(input.instanceIndex, '进行账号登录')
    const task: Task = {
      view: {
        id: randomUUID(),
        instanceIndex: input.instanceIndex,
        accountId: input.accountId,
        accountName: input.newAccountName ?? '',
        phase: 'preparing',
        message: '正在检查基础实例和账号绑定…',
        updatedAt: Date.now()
      },
      controller: new AbortController(),
      release,
      tail: Promise.resolve(),
      identity: null,
      commands: new Map()
    }
    this.tasks.set(input.instanceIndex, task)
    task.tail = this.prepare(task, input).catch((e: unknown) => {
      if (task.controller.signal.aborted) return
      this.update(task, 'failed', AppError.from(e).message)
      this.release(task)
    })
    this.deps.changed(structuredClone(task.view))
    return structuredClone(task.view)
  }

  private check(task: Task): void {
    if (task.controller.signal.aborted) throw new AppError('CANCELLED', '登录向导已结束。')
  }

  private update(task: Task, phase: LoginSession['phase'], message: string): void {
    task.view = {
      ...task.view,
      phase,
      message,
      updatedAt: Math.max(Date.now(), task.view.updatedAt + 1)
    }
    this.deps.changed(structuredClone(task.view))
  }

  private release(task: Task): void {
    this.starting.delete(task.view.instanceIndex)
    task.release()
  }

  private async prepare(task: Task, input: LoginRequest): Promise<void> {
    const base = await this.deps.base()
    this.check(task)
    if (base?.index === input.instanceIndex)
      throw new AppError('INVALID_ARGUMENT', '这是基础实例，请先克隆副本，再在副本中登录账号。')
    const instances = await this.deps.instances()
    this.check(task)
    const instance = instances.find((i) => i.index === input.instanceIndex)
    if (!instance) throw new AppError('MUMU_INSTANCE_MISSING', '实例不存在，请刷新列表。')
    task.identity = instance.identity ?? instance.bundlePath ?? null
    const up = instance.state === 'running' || instance.state === 'starting'
    if (!up) {
      const occupied = new Set([
        ...instances
          .filter((i) => i.state === 'running' || i.state === 'starting')
          .map((i) => i.index),
        ...this.starting
      ])
      if (occupied.size >= this.deps.maxInstances())
        throw new AppError('CONCURRENCY_LIMIT', '已达到开机实例上限，请先关闭一个实例再继续登录。')
      this.starting.add(input.instanceIndex)
    }
    await this.deps.pauseAuto(input.instanceIndex)
    this.check(task)
    const account = await this.deps.prepare(input, task.identity)
    task.view.accountName = account.name
    this.deps.accountsChanged()
    this.check(task)
    this.update(task, 'starting', '正在启动模拟器并连接游戏…')
    if (!up) {
      await this.deps.open(input.instanceIndex)
      this.check(task)
    }
    const deadline = Date.now() + 120_000
    for (;;) {
      const next = (await this.deps.instances()).find((i) => i.index === input.instanceIndex)
      this.check(task)
      if (!next) throw new AppError('MUMU_INSTANCE_MISSING', '实例已被删除。')
      if (task.identity && task.identity !== (next.identity ?? next.bundlePath ?? null))
        throw new AppError('INVALID_ARGUMENT', '实例已被替换，请重新开始登录。')
      if (next.state === 'running' && next.screenReady && next.adbPort) break
      if (next.state === 'error')
        throw new AppError('DEVICE_NOT_READY', '模拟器启动失败，请在多开器中检查。')
      if (Date.now() > deadline)
        throw new AppError('TIMEOUT', '等待模拟器启动超时。实例和账号已保留，可稍后继续登录。')
      await (this.deps.wait ?? sleep)(800, task.controller.signal)
    }
    task.device = await this.deps.device(input.instanceIndex)
    this.check(task)
    await this.deps.launch(task.device.serial)
    this.check(task)
    this.starting.delete(input.instanceIndex)
    this.update(
      task,
      'awaitingLogin',
      '请在游戏画面中完成登录、选择服务器与角色，再回到城内或世界地图检查。'
    )
  }

  private require(id: string): Task {
    const task = [...this.tasks.values()].find((t) => t.view.id === id)
    if (!task || !isLoginActive(task.view.phase))
      throw new AppError('NOT_FOUND', '登录向导已结束，请重新打开。')
    return task
  }

  private async currentDevice(task: Task): Promise<DeviceInfo> {
    const next = (await this.deps.instances()).find((i) => i.index === task.view.instanceIndex)
    this.check(task)
    if (
      !next ||
      next.state !== 'running' ||
      (task.identity && task.identity !== (next.identity ?? next.bundlePath ?? null))
    ) {
      throw new AppError('DEVICE_NOT_READY', '实例已关闭或被替换，请重新打开登录向导。')
    }
    const dev = await this.deps.device(task.view.instanceIndex)
    this.check(task)
    return dev
  }

  input(id: string, input: LoginInput): Promise<boolean> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new AppError('INVALID_ARGUMENT', '输入无效，文本不能含换行且最多 256 字符。')
      )
    const task = this.require(id)
    const operation = task.tail.then(async () => {
      this.check(task)
      if (task.view.phase !== 'awaitingLogin')
        throw new AppError('DEVICE_NOT_READY', '请等待游戏启动完成再操作。')
      const dev = await this.currentDevice(task)
      try {
        await this.deps.input(dev, parsed.data)
      } catch {
        throw new AppError('ADB_COMMAND_FAILED', '登录输入未完成，请检查设备连接与输入法后重试。')
      }
      this.check(task)
      return true
    })
    task.tail = operation.catch(() => undefined)
    return operation
  }

  command(id: string, input: LoginCommand): Promise<LoginSession> {
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new AppError('INVALID_ARGUMENT', '请检查手机号、6 位验证码、协议确认及请求编号。')
      )
    const task = this.require(id)
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const old = task.commands.get(parsed.data.requestId)
    if (old) {
      if (old.fingerprint !== fingerprint)
        return Promise.reject(new AppError('INVALID_ARGUMENT', '同一请求编号不能用于不同操作。'))
      return old.result
    }
    if (task.commands.size >= 200)
      return Promise.reject(
        new AppError('CONCURRENCY_LIMIT', '本次向导操作较多，请关闭后重新继续登录。')
      )
    const operation = task.tail.then(async () => {
      this.check(task)
      if (task.view.phase !== 'awaitingLogin' || !this.deps.command)
        throw new AppError('DEVICE_NOT_READY', '请等待游戏启动完成。')
      const device = await this.currentDevice(task)
      const screen = await this.deps.command(device.serial, parsed.data, task.controller.signal)
      this.check(task)
      task.view.screen = screen
      this.update(task, 'awaitingLogin', screen.message)
      return structuredClone(task.view)
    })
    task.commands.set(parsed.data.requestId, { fingerprint, result: operation })
    task.tail = operation.catch(() => undefined)
    return operation
  }

  verify(id: string, identityConfirmed: boolean): Promise<LoginSession> {
    if (identityConfirmed !== true)
      return Promise.reject(
        new AppError('INVALID_ARGUMENT', '请先确认游戏中的账号、服务器与角色正确。')
      )
    const task = this.require(id)
    const operation = task.tail.then(async () => {
      this.check(task)
      if (task.view.phase !== 'awaitingLogin')
        throw new AppError('DEVICE_NOT_READY', '请先完成游戏登录。')
      this.update(task, 'verifying', '正在检查是否已进入城内或世界地图…')
      try {
        const dev = await this.currentDevice(task)
        const ok = await this.deps.verify(dev.serial)
        this.check(task)
        if (!ok)
          throw new AppError(
            'DEVICE_NOT_READY',
            '尚未识别到游戏主界面。请完成登录并关闭公告、角色选择或其他面板后再检查。'
          )
        // 主界面已验证，写入开始后视为提交阶段。取消要等待提交结果，不能留下“已启用但显示取消”。
        task.committing = true
        try {
          await this.deps.complete(task.view.accountId, task.view.instanceIndex, task.identity)
        } finally {
          task.committing = false
        }
        this.deps.accountsChanged()
        this.update(task, 'completed', '已检查游戏主界面并启用账号。可前往采集配置设置自动任务。')
        this.release(task)
      } catch (e) {
        if (!task.controller.signal.aborted)
          this.update(task, 'awaitingLogin', AppError.from(e).message)
        throw e
      }
      return structuredClone(task.view)
    })
    task.tail = operation.catch(() => undefined)
    return operation
  }

  async cancel(id: string): Promise<void> {
    const task = [...this.tasks.values()].find((t) => t.view.id === id)
    if (!task || !isLoginActive(task.view.phase)) return
    if (task.committing) {
      await task.tail
      if (!isLoginActive(task.view.phase)) return
    }
    task.controller.abort()
    await task.tail
    this.update(task, 'cancelled', '登录向导已结束，账号和实例已保留，可稍后继续。')
    this.release(task)
  }

  async shutdown(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.tasks.values()].map((t) => this.cancel(t.view.id)))
  }
}
