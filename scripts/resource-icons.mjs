/**
 * 把「白底圆角框」的资源原画处理成透明底图标，供面板替换文字占位（采集总览行徽章、采集配置卡）。
 *
 *   node scripts/resource-icons.mjs            # 处理 resources/icons/raw/{wood,gold,iron,mana}.(webp|png|jpg)
 *
 * 处理：① 向内裁掉 4% 边（去掉圆角描边）；② 从四周做泛洪填充，把与边缘相连的「亮且低饱和」像素
 * （白底 + 淡灰投影）抠成透明，物体内部的高光不受影响；③ 边缘 1~2px 羽化；④ 按不透明像素裁边、等比缩到 192px。
 * 输出 src/renderer/src/assets/resources/<type>.png，面板用 import.meta.glob 按文件名取用，缺哪张就退回文字徽章。
 */
import sharp from 'sharp'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const RAW = 'resources/icons/raw'
const OUT = 'src/renderer/src/assets/resources'
const TYPES = ['wood', 'gold', 'iron', 'mana']
const SIZE = 192
/** 亮度 ≥ 它且饱和度低就算「白底/投影」。 */
const BG_MIN = 212
const BG_SAT = 14

async function processOne(type, file) {
  const img = sharp(file).ensureAlpha()
  const meta = await img.metadata()
  const w0 = meta.width, h0 = meta.height
  const inset = Math.round(Math.min(w0, h0) * 0.04)
  const { data, info } = await img
    .extract({ left: inset, top: inset, width: w0 - inset * 2, height: h0 - inset * 2 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const isBg = (i) => {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    return mn >= BG_MIN && mx - mn <= BG_SAT
  }
  // 泛洪：只有与边缘连通的背景才透明。
  const bg = new Uint8Array(w * h)
  const stack = []
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x) }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()
    if (bg[i] || !isBg(i)) continue
    bg[i] = 1
    const x = i % w, y = (i - x) / w
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - w)
    if (y < h - 1) stack.push(i + w)
  }
  // α：背景 0；紧邻背景的物体像素按亮度羽化；其余 255。
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) { data[i * 4 + 3] = 0; continue }
    const x = i % w, y = (i - x) / w
    const nearBg = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w])
    if (nearBg) {
      const mn = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
      const a = mn <= 190 ? 255 : Math.round(255 * (1 - (mn - 190) / (255 - 190)))
      data[i * 4 + 3] = Math.max(40, a)
    } else data[i * 4 + 3] = 255
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (maxX < 0) throw new Error(`${file}：整张都被当成背景了，阈值不对`)
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04)
  const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad)
  const cw = Math.min(w, maxX + pad + 1) - cx, ch = Math.min(h, maxY + pad + 1) - cy
  const out = join(OUT, `${type}.png`)
  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out)
  const opaque = data.filter((_, i) => i % 4 === 3 && data[i] > 0).length
  console.log(`${type}: ${file} → ${out}（不透明 ${(opaque / (w * h) * 100).toFixed(0)}%，裁边 ${cw}x${ch}）`)
}

const files = await readdir(RAW)
for (const type of TYPES) {
  const f = files.find((n) => n.replace(/\.[^.]+$/, '') === type)
  if (!f) { console.log(`${type}: resources/icons/raw 里没有这张，跳过（面板退回文字徽章）`); continue }
  await processOne(type, join(RAW, f))
}
if (!existsSync(OUT)) console.log('输出目录不存在？')
