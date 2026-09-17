/** 将已生成的 Logo 转为各平台图标，保留透明通道。npm run icons:app */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brand = resolve(root, 'resources/brand')
const renderer = resolve(root, 'src/renderer/src/assets/brand')
await mkdir(brand, { recursive: true })
await mkdir(renderer, { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = new Map()
for (const size of sizes) {
  pngs.set(size, await sharp(resolve(brand, 'logo-source.png')).resize(size, size).png().toBuffer())
}
await writeFile(resolve(brand, 'app-icon.png'), pngs.get(1024))
await writeFile(resolve(renderer, 'app-icon.png'), pngs.get(256))

const icoSizes = sizes.filter((size) => size <= 256)
const header = Buffer.alloc(6 + icoSizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
let offset = header.length
for (const [i, size] of icoSizes.entries()) {
  const entry = 6 + i * 16
  const png = pngs.get(size)
  header[entry] = size === 256 ? 0 : size
  header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(png.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += png.length
}
await writeFile(
  resolve(brand, 'app-icon.ico'),
  Buffer.concat([header, ...icoSizes.map((s) => pngs.get(s))])
)

const icnsEntries = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10']
]
const chunks = icnsEntries.map(([size, type]) => {
  const png = pngs.get(size)
  const chunk = Buffer.alloc(8)
  chunk.write(type, 0, 'ascii')
  chunk.writeUInt32BE(8 + png.length, 4)
  return Buffer.concat([chunk, png])
})
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns', 0, 'ascii')
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
await writeFile(resolve(brand, 'app-icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
console.log('已生成 PNG、Windows ICO、macOS ICNS 和面板 Logo。')
