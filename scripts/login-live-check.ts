/** 只读实机检查：不发短信、不输入、不切账号、不启用自动任务。 */
import { resolve } from 'node:path'
import { setAdbPath } from '@main/adb/exec'
import { setTemplatesDir } from '@vision/index'
import { readLoginUi } from '@main/login/nativeUi'
import { phoneScreen } from '@main/login/phoneDriver'
import { verifyGameFrame, verifyGameHome } from '@main/login/verify'
import sharp from 'sharp'

const [adbPath, serial, templatesDir] = process.argv.slice(2)
if (adbPath === '--frame') {
  if (!serial || !templatesDir) throw new Error('需要参数：--frame PNG路径 模板目录 [true|false]')
  setTemplatesDir(resolve(templatesDir))
  const { data, info } = await sharp(resolve(serial))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const homeVerified = await verifyGameFrame(
    { data, width: info.width, height: info.height, format: 1, capturedAt: 0 },
    resolve(templatesDir),
    2560,
    1440
  )
  const expected = process.argv[5] !== 'false'
  console.log(JSON.stringify({ mode: 'frame', homeVerified, expected }))
  process.exit(homeVerified === expected ? 0 : 1)
}
if (!adbPath || !/^127\.0\.0\.1:\d+$/.test(serial ?? '') || !templatesDir) {
  throw new Error('需要参数：ADB 完整路径、当前实例的实际 serial、模板目录。')
}
setAdbPath(resolve(adbPath))
setTemplatesDir(resolve(templatesDir))
const screen = phoneScreen(await readLoginUi(serial))
const homeVerified = await verifyGameHome(serial, resolve(templatesDir), 2560, 1440)
console.log(JSON.stringify({ screen: screen.step, homeVerified }))
if (!homeVerified) process.exitCode = 1
