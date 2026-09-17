import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { BaseInstanceSelection, CreateInstanceOptions, MumuInstance } from '@shared/domain'
import type { MumuPort } from './handlers'
import { instanceAccess } from './instanceAccess'

const selectionSchema = z.object({
  version: z.literal(1),
  base: z
    .object({
      index: z.number().int().nonnegative(),
      name: z.string(),
      identity: z.string().nullable()
    })
    .nullable()
})

function validIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new AppError('INVALID_ARGUMENT', '实例编号无效。')
}

function identityOf(instance: MumuInstance): string | null {
  return instance.identity ?? instance.bundlePath ?? null
}

/** 面板内创建/克隆/删除串行占用，避免各驱动使用列表差集时把另一批实例算进来。 */
export class InstanceProvisioner {
  private busy = false
  private writeChain: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly mumu: Pick<MumuPort, 'refresh' | 'create' | 'clone' | 'remove'>,
    private readonly dataDir: () => string
  ) {}

  async getBase(): Promise<BaseInstanceSelection | null> {
    await this.writeChain
    let raw: string
    try {
      raw = await readFile(join(this.dataDir(), 'instance-defaults.json'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new AppError('IO_ERROR', '无法读取基础实例设置，请检查数据目录权限。')
    }
    try {
      return selectionSchema.parse(JSON.parse(raw)).base
    } catch {
      throw new AppError('IO_ERROR', '基础实例设置文件损坏，已保留原文件，请恢复备份。')
    }
  }

  private writeBase(base: BaseInstanceSelection | null): Promise<void> {
    const dir = this.dataDir()
    const file = join(dir, 'instance-defaults.json')
    const next = this.writeChain.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(tmp, JSON.stringify({ version: 1, base }, null, 2) + '\n')
        await rename(tmp, file)
      } catch {
        await unlink(tmp).catch(() => undefined)
        throw new AppError('IO_ERROR', '基础实例设置保存失败，原设置未覆盖。')
      }
    })
    this.writeChain = next.catch(() => undefined)
    return next
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new AppError('CONCURRENCY_LIMIT', '正在创建、克隆或删除实例，请等待完成后再试。')
    this.busy = true
    try {
      return await fn()
    } finally {
      this.busy = false
    }
  }

  /** 与脚本、自动采集共享同一占用表，在第一处 await 之前锁定实例。 */
  async withInstance<T>(index: number, label: string, fn: () => Promise<T>): Promise<T> {
    validIndex(index)
    const release = instanceAccess.acquire(index, label)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  setBase(index: number | null): Promise<BaseInstanceSelection | null> {
    return this.exclusive(async () => {
      // 损坏文件不能被一次设置动作静默覆盖。
      await this.getBase()
      let selected: BaseInstanceSelection | null = null
      if (index !== null) {
        validIndex(index)
        const instance = (await this.mumu.refresh()).find((i) => i.index === index)
        if (!instance)
          throw new AppError('MUMU_INSTANCE_MISSING', `实例 ${index} 不存在，请刷新列表。`)
        selected = { index, name: instance.name, identity: identityOf(instance) }
      }
      await this.writeBase(selected)
      return selected
    })
  }

  create(opts: CreateInstanceOptions): Promise<number[]> {
    return this.exclusive(async () => {
      if (!opts || typeof opts !== 'object' || Array.isArray(opts))
        throw new AppError('INVALID_ARGUMENT', '创建参数无效。')
      const count = opts.count ?? 1
      if (!Number.isInteger(count) || count < 1 || count > 8)
        throw new AppError('INVALID_ARGUMENT', '创建数量必须是 1–8 的整数。')
      if (opts.source !== undefined && opts.source !== 'base' && opts.source !== 'blank')
        throw new AppError('INVALID_ARGUMENT', '创建方式无效。')
      const base = await this.getBase()
      const source = opts.source ?? (base ? 'base' : 'blank')
      if (source === 'blank') {
        // 面板专用字段不透传给模拟器 CLI。
        return this.mumu.create({ count, type: opts.type, settings: opts.settings })
      }
      if (!base)
        throw new AppError('INVALID_ARGUMENT', '尚未设置基础实例，请先设置或选择空白新建。')
      if (opts.expectedBaseIndex !== undefined && opts.expectedBaseIndex !== base.index) {
        throw new AppError('INVALID_ARGUMENT', '基础实例已改变，请重新打开新建窗口确认。')
      }
      if (opts.settings && Object.keys(opts.settings).length)
        throw new AppError('INVALID_ARGUMENT', '克隆沿用基础实例配置；自定义配置请在克隆后调整。')
      return this.cloneBatch(base.index, count, base)
    })
  }

  clone(index: number): Promise<number[]> {
    return this.exclusive(() => this.cloneBatch(index, 1))
  }

  private cloneBatch(
    index: number,
    count: number,
    expected?: BaseInstanceSelection
  ): Promise<number[]> {
    return this.withInstance(index, '克隆实例', async () => {
      const list = await this.mumu.refresh()
      const source = list.find((i) => i.index === index)
      if (!source)
        throw new AppError(
          'MUMU_INSTANCE_MISSING',
          `源实例 ${index} 已不存在，请重新设置基础实例或选择空白新建。`
        )
      if (expected?.identity && expected.identity !== identityOf(source)) {
        throw new AppError(
          'INVALID_ARGUMENT',
          `实例 ${index} 已被替换，请重新设置基础实例后再创建。`
        )
      }
      if (source.state !== 'stopped')
        throw new AppError(
          'INVALID_ARGUMENT',
          `请先关闭源实例 ${index}「${source.name}」再克隆，确保磁盘数据完整。`
        )
      const created: number[] = []
      const before = new Set(list.map((i) => i.index))
      try {
        for (let i = 0; i < count; i++) {
          // 每份始终来自同一个源，不以刚克隆出的实例为源。
          const ids = await this.mumu.clone(index)
          if (
            ids.length !== 1 ||
            ids.some(
              (id) => !Number.isSafeInteger(id) || id < 0 || before.has(id) || created.includes(id)
            )
          ) {
            throw new AppError('MUMU_BAD_OUTPUT', '模拟器未返回唯一的新实例编号，请刷新列表检查。')
          }
          created.push(...ids)
        }
        return created
      } catch (e) {
        const cause = AppError.from(e)
        // 包括 CLI 已复制但返回错误的情况；只报告差集，不删除任何已创建的数据。
        const fresh = await this.mumu.refresh().catch(() => null)
        const observed = fresh?.filter((i) => !before.has(i.index)).map((i) => i.index) ?? []
        const partial = [...new Set([...created, ...observed])]
        throw new AppError(
          cause.code,
          `${cause.message}${partial.length ? ` 已发现新增实例：${partial.join('、')}；请检查列表，仅补建缺少的数量。` : ' 请刷新实例列表确认是否已产生副本，再决定是否重试。'}`,
          { created: partial, requested: count }
        )
      }
    })
  }

  remove(index: number, beforeRemove: () => Promise<void>): Promise<void> {
    return this.exclusive(() =>
      this.withInstance(index, '删除实例', async () => {
        const base = await this.getBase()
        await beforeRemove()
        await this.mumu.remove(index)
        if (base?.index === index) {
          try {
            await this.writeBase(null)
          } catch {
            throw new AppError(
              'IO_ERROR',
              `实例 ${index} 已删除，但清除基础实例设置失败，请手动取消基础实例。`
            )
          }
        }
      })
    )
  }
}
