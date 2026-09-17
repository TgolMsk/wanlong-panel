import assert from 'node:assert/strict'
import sharp from 'sharp'
import { rawFrameToPngShot, rawFrameToShot } from '@main/handlers/device'
import { prepareTemplate } from '@vision/template'
import { matchAllInCrop } from '@main/game/vision/matchAll'
import { buildDiffAlpha, applyAlpha } from '@vision/alpha'
import type { RawFrame } from '@shared/vision'

const rgba = Buffer.alloc(64 * 48 * 4)
for (let i = 0; i < 64 * 48; i++) {
  rgba[i * 4] = (i * 17) % 256
  rgba[i * 4 + 1] = (i * 37) % 256
  rgba[i * 4 + 2] = (i * 53) % 256
  rgba[i * 4 + 3] = 255
}
const frame: RawFrame = { data: rgba, width: 64, height: 48, format: 1, capturedAt: 42 }
const png = await rawFrameToPngShot(frame)
assert.equal((await sharp(Buffer.from(png.png)).metadata()).format, 'png')
assert.deepEqual(await sharp(Buffer.from(png.png)).ensureAlpha().raw().toBuffer(), rgba)
assert.equal(png.capturedAt, 42)
const small = await rawFrameToPngShot(frame, 32)
assert.equal(small.imageWidth, 32)
assert.equal(small.imageHeight, 24)
assert.equal(small.width, 64)
assert.equal(
  (await sharp(Buffer.from((await rawFrameToShot(frame, { width: 0 }, 0)).jpeg)).metadata()).format,
  'jpeg'
)
await assert.rejects(rawFrameToPngShot({ ...frame, data: rgba.subarray(4) }), {
  code: 'CAPTURE_BAD_FRAME'
})

// Preserve a textured foreground; independently vary every background pixel.
const w = 24,
  h = 20
const bg = (seed: number): Buffer => {
  const pixels = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const foreground = x >= 6 && x < 18 && y >= 4 && y < 16
      const v = foreground ? 30 + ((x * 31 + y * 53) % 200) : seed
      pixels.fill(v, (y * w + x) * 3, (y * w + x + 1) * 3)
    }
  return pixels
}
const makePng = (data: Buffer) =>
  sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer()
const [first, second] = await Promise.all([makePng(bg(5)), makePng(bg(240))])
const diff = await buildDiffAlpha(
  [first, second],
  { x: 0, y: 0, w, h },
  { tolerance: 0, smooth: false }
)
assert.equal(diff.coverage, 144 / 480)
const templ = await prepareTemplate(await applyAlpha(first, diff.alphaPng), {
  id: 'offline-mask',
  name: 'offline mask',
  refW: 2560,
  shrink: 1
})
assert.ok(templ.mask)
const cw = 90,
  ch = 44
const crop = { x: 100, y: 200, w: cw, h: ch, gray: new Uint8Array(cw * ch).fill(210) }
const spots = [
  { x: 3, y: 8 },
  { x: 53, y: 12 }
]
for (const p of spots)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (templ.mask![idx]) crop.gray[(p.y + y) * cw + p.x + x] = templ.gray[idx]
    }
const peaks = await matchAllInCrop(crop, templ, { minScore: 0.98 })
assert.equal(peaks.length, 2)
for (const p of spots) assert.ok(peaks.some((hit) => hit.x === p.x + 100 && hit.y === p.y + 200))
assert.equal(
  (await matchAllInCrop({ ...crop, gray: new Uint8Array(cw * ch).fill(120) }, templ)).length,
  0
)
await assert.rejects(matchAllInCrop(crop, { ...templ, mask: new Uint8Array(1) }), {
  code: 'INVALID_ARGUMENT'
})
await assert.rejects(matchAllInCrop(crop, { ...templ, mask: new Uint8Array(w * h) }), {
  code: 'TEMPLATE_LOW_VARIANCE'
})
const sparse = Buffer.alloc(w * h)
sparse[10] = 255
const sparsePng = await sharp(sparse, { raw: { width: w, height: h, channels: 1 } })
  .png()
  .toBuffer()
await assert.rejects(
  prepareTemplate(await applyAlpha(first, sparsePng), { id: 'sparse', name: 'sparse', refW: 2560 }),
  { code: 'TEMPLATE_LOW_VARIANCE' }
)
const opaque = await prepareTemplate(second, {
  id: 'opaque',
  name: 'opaque',
  refW: 2560,
  shrink: 1
})
const exact = await matchAllInCrop({ x: 0, y: 0, w, h, gray: opaque.gray }, opaque)
assert.equal(exact.length, 1)
assert.ok(exact[0].score > 0.99)
console.log(
  'PASS: PNG exact pixels/dimensions, JPEG compatibility, diff alpha, masked repeated glyphs, negatives, malformed/sparse masks, opaque matching'
)
