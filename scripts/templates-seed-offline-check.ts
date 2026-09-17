/**
 * 内置模板播种（src/main/store/builtinTemplates.ts）的离线自检：全部在临时目录里跑，不碰真实数据目录。
 *
 * 覆盖：整集复制 / 幂等 / 只补缺失模板且不动用户改过的 / 用户 manifest 损坏时跳过不覆盖 /
 *       内置目录不存在 / 内置 manifest 不合法 / 不安全文件名 / 内置缺图。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { seedBuiltinTemplates } from '@main/store/builtinTemplates'
import type { TemplateDef, TemplateSet } from '@shared/vision'

const root = await mkdtemp(join(tmpdir(), 'wanlong-tplseed-check-'))
let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ✅ ${name}`)
}

function def(id: string, extra: Partial<TemplateDef> = {}): TemplateDef {
  return {
    id,
    name: `模板 ${id}`,
    file: `${id}.png`,
    authoredWidth: 2560,
    authoredHeight: 1440,
    bounds: { x: 10, y: 10, w: 40, h: 40 },
    threshold: 0.9,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function set(id: string, templates: TemplateDef[]): TemplateSet {
  return {
    id,
    name: `集 ${id}`,
    packageName: 'com.example.game',
    refWidth: 2560,
    refHeight: 1440,
    templates,
    updatedAt: 1
  }
}

async function writeSet(
  dir: string,
  s: TemplateSet,
  pngBytes: (id: string) => string
): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const t of s.templates) await writeFile(join(dir, t.file), pngBytes(t.id))
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(s, null, 2))
}

async function readSet(dir: string): Promise<TemplateSet> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as TemplateSet
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const warns: string[] = []
const log = (level: 'info' | 'warn', message: string): void => {
  if (level === 'warn') warns.push(message)
}

try {
  const builtin = join(root, 'resources', 'templates')
  const user = join(root, 'data', 'templates')
  const SET = 'tset_builtin1'
  await writeSet(
    join(builtin, SET),
    set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c')]),
    (id) => `PNG:${id}`
  )
  await mkdir(join(builtin, 'junk-dir'), { recursive: true }) // 没有 manifest：不是模板集
  await writeFile(join(builtin, '.gitkeep'), '')

  // ① 全新目录：整集复制
  let r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.deepEqual(r.copiedSets, { [SET]: 4 })
  assert.deepEqual(r.addedTemplates, {})
  assert.deepEqual(r.skipped, {})
  assert.equal(await readFile(join(user, SET, 'tpl_b.png'), 'utf8'), 'PNG:tpl_b')
  assert.equal((await readSet(join(user, SET))).templates.length, 3)
  assert.equal(await exists(join(user, 'junk-dir')), false)
  ok('全新数据目录：整个模板集复制过来（3 png + manifest），非模板集目录不碰')

  // ② 幂等
  r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.deepEqual(r, { copiedSets: {}, addedTemplates: {}, skipped: {} })
  ok('再跑一次：什么都不复制')

  // ③ 用户改过：删掉 b、改 a 的阈值和图、加自己的 u；内置新增 d
  const mine = await readSet(join(user, SET))
  mine.templates = mine.templates.filter((t) => t.id !== 'tpl_b')
  const a = mine.templates.find((t) => t.id === 'tpl_a')!
  a.threshold = 0.77
  await writeFile(join(user, SET, 'tpl_a.png'), 'USER-EDITED')
  mine.templates.push(def('tpl_u'))
  await writeFile(join(user, SET, 'tpl_u.png'), 'PNG:tpl_u')
  mine.updatedAt = 5
  await writeFile(join(user, SET, 'manifest.json'), JSON.stringify(mine, null, 2))
  await rm(join(user, SET, 'tpl_b.png'))
  await writeSet(
    join(builtin, SET),
    set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c'), def('tpl_d')]),
    (id) => `PNG:${id}`
  )
  r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.deepEqual(r.addedTemplates, { [SET]: ['tpl_b', 'tpl_d'] })
  assert.deepEqual(r.copiedSets, {})
  const merged = await readSet(join(user, SET))
  assert.deepEqual(
    merged.templates.map((t) => t.id),
    ['tpl_a', 'tpl_c', 'tpl_u', 'tpl_b', 'tpl_d']
  )
  assert.equal(merged.templates.find((t) => t.id === 'tpl_a')!.threshold, 0.77)
  assert.equal(await readFile(join(user, SET, 'tpl_a.png'), 'utf8'), 'USER-EDITED')
  assert.equal(await readFile(join(user, SET, 'tpl_b.png'), 'utf8'), 'PNG:tpl_b')
  assert.equal(await readFile(join(user, SET, 'tpl_d.png'), 'utf8'), 'PNG:tpl_d')
  assert.ok(merged.updatedAt > 5)
  assert.equal(merged.packageName, 'com.example.game')
  ok('已有模板集：只补缺的 b / d，用户改过的 a（阈值 + 图）与自建的 u 原样保留')

  // ④ 用户 manifest 损坏：跳过，不覆盖，不补图
  await writeFile(join(user, SET, 'manifest.json'), '{broken')
  await writeSet(
    join(builtin, SET),
    set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c'), def('tpl_d'), def('tpl_e')]),
    (id) => `PNG:${id}`
  )
  r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.ok(r.skipped[SET], '应记录跳过原因')
  assert.equal(await readFile(join(user, SET, 'manifest.json'), 'utf8'), '{broken')
  assert.equal(await exists(join(user, SET, 'tpl_e.png')), false)
  assert.ok(warns.some((w) => w.includes(SET)))
  ok('用户 manifest 损坏：整集跳过并给中文原因，一个字节都不动')
  await writeFile(join(user, SET, 'manifest.json'), JSON.stringify(merged, null, 2))

  // ⑤ 内置目录不存在（开发期 resources/templates 只有 .gitkeep 的等价情况）
  r = await seedBuiltinTemplates({ builtinDir: join(root, 'nope'), templatesDir: user, log })
  assert.deepEqual(r, { copiedSets: {}, addedTemplates: {}, skipped: {} })
  ok('内置目录不存在：静默返回')

  // ⑥ 内置 manifest 不合法：跳过
  const BAD = 'tset_bad'
  await mkdir(join(builtin, BAD), { recursive: true })
  await writeFile(join(builtin, BAD, 'manifest.json'), JSON.stringify({ id: BAD, name: '' }))
  r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.ok(r.skipped[BAD]?.includes('不合法'))
  assert.equal(await exists(join(user, BAD)), false)
  ok('内置 manifest 不合法：跳过，不在用户目录留东西')

  // ⑦ 不安全文件名 + 内置缺图：那两张跳过，其余照常
  const EDGE = 'tset_edge'
  await writeSet(join(builtin, EDGE), set(EDGE, [def('tpl_ok')]), (id) => `PNG:${id}`)
  const edge = await readSet(join(builtin, EDGE))
  edge.templates.push(def('tpl_evil', { file: '../evil.png' }), def('tpl_missing'))
  await writeFile(join(builtin, EDGE, 'manifest.json'), JSON.stringify(edge, null, 2))
  r = await seedBuiltinTemplates({ builtinDir: builtin, templatesDir: user, log })
  assert.equal(r.copiedSets[EDGE], 2) // tpl_ok.png + manifest；evil 与 missing 都跳过
  assert.deepEqual(
    (await readSet(join(user, EDGE))).templates.map((t) => t.id),
    ['tpl_ok']
  )
  assert.equal(await exists(join(user, 'evil.png')), false)
  assert.equal(await exists(join(root, 'data', 'evil.png')), false)
  assert.ok(warns.some((w) => w.includes('tpl_evil')))
  assert.ok(warns.some((w) => w.includes('tpl_missing')))
  ok('不安全文件名 / 内置缺图：那两张跳过并告警，manifest 里也不写，不会写到模板库外面')

  console.log(`PASS: 内置模板播种 ${passed} 项`)
} finally {
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('wanlong-tplseed-check-'))
    throw new Error('Unexpected cleanup path')
  await rm(target, { recursive: true, force: true })
}
