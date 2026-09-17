/**
 * 内置模板集的播种：把随安装包分发的模板集（<resourcesDir>/templates/<setId>/）补进用户的模板库
 * （<templatesDir>/<setId>/）。
 *
 * 为什么需要它：模板库的唯一真相在 <dataDir>/templates —— 面板「模板库」页、脚本、采集流程、调度器采样
 * 都只认这一个目录；而安装包里的模板落在 resources/templates（electron-builder 的 extraResources，
 * 打包时从仓库的 .wl-data/templates 复制），新装的机器上前者是空的。没有这一步，装完的面板一张模板都没有，
 * 自动采集根本跑不起来。开发期 resources/templates 只有一个 .gitkeep，这里自然什么都不做。
 *
 * 规则（全部是「只增不改」，用户的东西永远优先）：
 *   · 用户目录里没有这个模板集 → 整个目录原样复制（先 png 后 manifest，中途断电不会留下指向缺图的 manifest）。
 *   · 已有这个模板集 → 只补用户 manifest 里**没有**的模板 id：复制它的 png、把 TemplateDef 追加进用户 manifest。
 *     已存在的模板（哪怕用户改过阈值 / ROI / 重裁了图）一个字节都不动，png 一律 COPYFILE_EXCL。
 *   · 用户 manifest 损坏 → 跳过这个集并给中文原因，绝不用内置版本覆盖（那会把用户 AI 自学的模板一起抹掉）。
 *   · 内置目录不存在 / 内置 manifest 不合法 → 跳过，不影响启动。
 * 幂等：跑多少次结果一样，第二次不会再复制任何文件。
 *
 * ⚠️ 纯 Node，不 import electron：路径由调用方传入，离线自检直接喂临时目录。
 */

import { constants as fsConstants, type Dirent } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TEMPLATE_MANIFEST_FILE } from '@shared/constants'
import { parseOrThrow, templateSetSchema } from '@shared/schemas'
import type { TemplateDef, TemplateSet } from '@shared/vision'

export type SeedLog = (level: 'info' | 'warn', message: string) => void

export interface SeedResult {
  /** 整个复制过来的模板集：setId → 复制的文件数（含 manifest）。 */
  copiedSets: Record<string, number>
  /** 已有模板集里补进去的模板 id。 */
  addedTemplates: Record<string, string[]>
  /** 跳过的模板集及中文原因。 */
  skipped: Record<string, string>
}

export interface SeedOptions {
  /** 内置模板根目录（安装包里的 resources/templates）。 */
  builtinDir: string
  /** 用户模板库根目录（<dataDir>/templates）。 */
  templatesDir: string
  log?: SeedLog
}

/** 文件名 / 模板集 id 会被拼进路径：只放行字母、数字、点、下划线、短横线，挡住 `..` 与分隔符。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

function isSafeSegment(seg: string): boolean {
  return SAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === code
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (e) {
    if (isCode(e, 'ENOENT')) return false
    throw e
  }
}

async function readManifest(dir: string, what: string): Promise<TemplateSet> {
  const raw: unknown = JSON.parse(await readFile(join(dir, TEMPLATE_MANIFEST_FILE), 'utf8'))
  return parseOrThrow(templateSetSchema, raw, what)
}

/** 与 vision/store 的 writeManifest 同一套原子写：先写临时文件再 rename。 */
async function writeManifest(dir: string, set: TemplateSet): Promise<void> {
  const target = join(dir, TEMPLATE_MANIFEST_FILE)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(set, null, 2), 'utf8')
  await rename(tmp, target)
}

/** 只在目标不存在时复制；已存在就当没事（返回 false）。 */
async function copyIfMissing(src: string, dst: string): Promise<boolean> {
  try {
    await copyFile(src, dst, fsConstants.COPYFILE_EXCL)
    return true
  } catch (e) {
    if (isCode(e, 'EEXIST')) return false
    throw e
  }
}

export async function seedBuiltinTemplates(opts: SeedOptions): Promise<SeedResult> {
  const log: SeedLog = opts.log ?? (() => undefined)
  const result: SeedResult = { copiedSets: {}, addedTemplates: {}, skipped: {} }

  let entries: Dirent[]
  try {
    entries = await readdir(opts.builtinDir, { withFileTypes: true })
  } catch (e) {
    if (isCode(e, 'ENOENT')) return result
    throw e
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const setId = entry.name
    const src = join(opts.builtinDir, setId)
    if (!(await exists(join(src, TEMPLATE_MANIFEST_FILE)))) continue // 不是模板集目录
    if (!isSafeSegment(setId)) {
      result.skipped[setId] = '模板集目录名含有不安全字符'
      log('warn', `内置模板集「${setId}」目录名不合法，跳过。`)
      continue
    }

    let builtin: TemplateSet
    try {
      builtin = await readManifest(src, `内置模板集「${setId}」`)
    } catch (e) {
      result.skipped[setId] = `内置 manifest 不合法：${errMsg(e)}`
      log('warn', `内置模板集「${setId}」的 manifest 不合法，跳过：${errMsg(e)}`)
      continue
    }

    const dst = join(opts.templatesDir, setId)
    try {
      if (!(await exists(join(dst, TEMPLATE_MANIFEST_FILE)))) {
        const n = await copyWholeSet(src, dst, builtin, log)
        result.copiedSets[setId] = n
        log(
          'info',
          `已内置模板集「${builtin.name}」（${setId}）：${builtin.templates.length} 张模板、${n} 个文件。`
        )
      } else {
        const added = await mergeMissing(src, dst, builtin, setId, log)
        if (added.length > 0) {
          result.addedTemplates[setId] = added
          log(
            'info',
            `模板集「${builtin.name}」（${setId}）补进 ${added.length} 张内置模板：${added.join('、')}。`
          )
        }
      }
    } catch (e) {
      // 用户 manifest 损坏、磁盘满、权限……都只记原因，绝不挡启动，更不覆盖用户目录。
      result.skipped[setId] = errMsg(e)
      log('warn', `内置模板集「${setId}」播种失败，已跳过：${errMsg(e)}`)
    }
  }
  return result
}

/**
 * 整个模板集复制：png 先、manifest 最后。返回复制的文件数。
 * 文件名不合法或内置目录里缺图的模板会被跳过，**并且不写进 manifest**（manifest 是唯一真相，
 * 写一条指向不存在的 png 的记录只会让运行期报「模板读不到」）。
 */
async function copyWholeSet(
  src: string,
  dst: string,
  builtin: TemplateSet,
  log: SeedLog
): Promise<number> {
  await mkdir(dst, { recursive: true })
  let copied = 0
  const kept: TemplateDef[] = []
  for (const t of builtin.templates) {
    if (!isSafeSegment(t.file)) {
      log('warn', `内置模板「${t.id}」的文件名「${t.file}」不合法，跳过这张。`)
      continue
    }
    if (!(await exists(join(src, t.file)))) {
      log('warn', `内置模板「${t.id}」缺图（${t.file}），跳过这张。`)
      continue
    }
    if (await copyIfMissing(join(src, t.file), join(dst, t.file))) copied += 1
    kept.push(t)
  }
  await writeManifest(dst, { ...builtin, templates: kept })
  return copied + 1
}

/** 已有模板集：只补 manifest 里没有的模板 id。返回补进去的 id 列表。 */
async function mergeMissing(
  src: string,
  dst: string,
  builtin: TemplateSet,
  setId: string,
  log: SeedLog
): Promise<string[]> {
  const user = await readManifest(dst, `模板集「${setId}」`)
  const have = new Set(user.templates.map((t) => t.id))
  const added: TemplateDef[] = []
  for (const t of builtin.templates) {
    if (have.has(t.id)) continue
    if (!isSafeSegment(t.file)) {
      log('warn', `内置模板「${t.id}」的文件名「${t.file}」不合法，跳过这张。`)
      continue
    }
    if (!(await exists(join(src, t.file)))) {
      log('warn', `内置模板「${t.id}」缺图（${t.file}），跳过这张。`)
      continue
    }
    await copyIfMissing(join(src, t.file), join(dst, t.file))
    added.push(t)
  }
  if (added.length === 0) return []
  await writeManifest(dst, {
    ...user,
    templates: [...user.templates, ...added],
    updatedAt: Date.now()
  })
  return added.map((t) => t.id)
}
