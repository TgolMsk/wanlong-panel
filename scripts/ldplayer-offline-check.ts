/**
 * 雷电驱动的离线自检：不碰模拟器，只验证纯函数部分——
 *   · list2 解析（真机抄下来的三行 + 带逗号的标题 + 雷电 9 的 7 列格式 + 垃圾行）
 *   · 原始行 -> MumuInstance 的状态 / 端口 / 分辨率映射
 *   · 控制台输出解码（GBK 的「万龙1号」、UTF-8、空）
 *   · assertLdOk 的三条失败判据（退出码 / player don't exist / 用法文本）
 *   · modify 参数拼装（resolution 两种写法、未知键报错、布尔与整数校验）
 *
 *   npm run check:ld
 */

import { ldAdbPort, serialOf } from '@shared/constants'
import { AppError } from '@shared/errors'
import {
  assertLdOk,
  assertLdTextOk,
  decodeConsoleText,
  isLdUsageText,
  type LdExecResult
} from '@main/mumu/ldplayer/cli'
import { ldRawToInstance, parseLdList2 } from '@main/mumu/ldplayer/parse'
import { LD_MODIFY_KEYS } from '@main/mumu/ldplayer/index'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return AppError.from(e).code === code
  }
}

// ── 1. list2 解析 ────────────────────────────────────────────────────────

console.log('【一、list2 解析】')
{
  // 真机抄录（雷电 14.0.26.1，2026-09-14）：实例 1「万龙1号」在跑，0 / 2 停机。
  const text =
    '0,万龙游戏,0,0,0,-1,-1,2560,1440,360\r\n' +
    '1,万龙1号,3148512,1837642,1,20204,29052,2560,1440,360\r\n' +
    '2,雷电模拟器-1-2,0,0,0,-1,-1,2560,1440,360\r\n'
  const rows = parseLdList2(text.replace(/\r\n/g, '\n'))
  check('三行全部解析', rows.length === 3, `得到 ${rows.length} 行`)
  const r1 = rows[1]!
  check('index / 标题', r1.index === 1 && r1.title === '万龙1号', `${r1.index}「${r1.title}」`)
  check(
    'android_started / pid / vbox_pid',
    r1.androidStarted && r1.pid === 20204 && r1.vboxPid === 29052
  )
  check('分辨率三列', r1.width === 2560 && r1.height === 1440 && r1.dpi === 360)
  const r0 = rows[0]!
  check('停机实例 pid -1 -> null', r0.pid === null && r0.vboxPid === null && !r0.androidStarted)

  // 标题里有逗号（用户可以随便改名）。
  const comma = parseLdList2('3,主号,一区,0,0,0,-1,-1,1920,1080,280')
  check(
    '标题含逗号时不丢字',
    comma.length === 1 && comma[0]!.title === '主号,一区',
    comma[0]?.title ?? ''
  )
  check('标题含逗号时数值列仍对', comma[0]!.width === 1920 && comma[0]!.dpi === 280)

  // 纯数字标题不能被吞进数值尾巴。
  const numeric = parseLdList2('4,123,0,0,0,-1,-1,2560,1440,360')
  check(
    '纯数字标题',
    numeric.length === 1 && numeric[0]!.title === '123' && numeric[0]!.width === 2560
  )

  // 雷电 9 的 7 列格式（没有分辨率）。
  const v9 = parseLdList2('0,雷电模拟器,0,0,1,4321,4322')
  check(
    '雷电 9 的 7 列格式',
    v9.length === 1 && v9[0]!.androidStarted && v9[0]!.pid === 4321 && v9[0]!.width === null
  )

  // 垃圾行 / 空行 / 用法文本都不该产出实例。
  const junk = parseLdList2('\n\nUsage:\nldconsole <command> [parameter]\nabc,def\n')
  check('垃圾行不产出实例', junk.length === 0, `得到 ${junk.length} 行`)
  check(
    '用法文本识别',
    isLdUsageText('dnplayer v14.0.26.1 Command Line Management Interface\nUsage:')
  )
  check('普通输出不当成用法文本', !isLdUsageText('0,万龙游戏,0,0,0,-1,-1,2560,1440,360'))
}

// ── 2. 原始行 -> MumuInstance ─────────────────────────────────────────────

console.log('【二、实例视图映射】')
{
  const rows = parseLdList2(
    '0,万龙游戏,0,0,0,-1,-1,2560,1440,360\n1,万龙1号,3148512,1837642,1,20204,29052,2560,1440,360\n5,启动中,1,1,0,777,778,1920,1080,280'
  )
  const [stopped, running, starting] = rows.map(ldRawToInstance)
  check(
    '停机 -> stopped / adbPort null / serial null',
    stopped!.state === 'stopped' &&
      stopped!.adbPort === null &&
      stopped!.serial === null &&
      !stopped!.screenReady
  )
  check(
    '运行 -> running / 端口 5557 / serial 127.0.0.1:5557',
    running!.state === 'running' &&
      running!.adbPort === 5557 &&
      running!.serial === serialOf(5557) &&
      running!.screenReady
  )
  check(
    '进程起了但 Android 没起 -> starting，端口已给、screenReady=false',
    starting!.state === 'starting' &&
      starting!.adbPort === ldAdbPort(5) &&
      starting!.adbPort === 5565 &&
      !starting!.screenReady
  )
  check('分辨率透传', running!.resolution?.width === 2560 && running!.resolution?.dpi === 360)
  check(
    'adb / accountId / runId 是初始值',
    running!.adb === 'disconnected' && running!.accountId === null && running!.runId === null
  )
  check(
    '端口公式 5555 + 2·index',
    ldAdbPort(0) === 5555 && ldAdbPort(1) === 5557 && ldAdbPort(99) === 5753
  )
}

// ── 3. 控制台解码 ─────────────────────────────────────────────────────────

console.log('【三、控制台输出解码】')
{
  // 「万龙1号」的 GBK 字节：万=CD F2，龙=C1 FA，1=31，号=BA C5。
  const gbk = Buffer.from([0x31, 0x2c, 0xcd, 0xf2, 0xc1, 0xfa, 0x31, 0xba, 0xc5, 0x2c, 0x30])
  const decoded = decodeConsoleText(gbk)
  check('GBK 字节解成「万龙1号」', decoded === '1,万龙1号,0', JSON.stringify(decoded))
  check('UTF-8 原样', decodeConsoleText(Buffer.from('1,万龙1号,0', 'utf8')) === '1,万龙1号,0')
  check('空缓冲', decodeConsoleText(Buffer.alloc(0)) === '')
  const parsed = parseLdList2(
    decodeConsoleText(
      Buffer.from([
        0x31, 0x2c, 0xcd, 0xf2, 0xc1, 0xfa, 0x31, 0xba, 0xc5, 0x2c, 0x30, 0x2c, 0x30, 0x2c, 0x31,
        0x2c, 0x39, 0x2c, 0x39
      ])
    )
  )
  check(
    'GBK 解码后能解析出「万龙1号」',
    parsed[0]?.title === '万龙1号' && parsed[0]?.androidStarted === true
  )
}

// ── 4. assertLdOk ────────────────────────────────────────────────────────

console.log('【四、成败判定】')
{
  const res = (stdout: string, code: number | null = 0): LdExecResult => ({
    stdout,
    stderr: '',
    code,
    elapsedMs: 1
  })
  // ★ add / copy 的退出码是新实例 index（真机：copy --from 0 退出 3、add 退出 4），只能按文本判错。
  check(
    'add/copy：退出码 3 + 空输出不算失败（退出码是新实例 index）',
    !throwsCode(
      () => assertLdTextOk(res('', 3), ['copy', '--from', '0'], '克隆实例'),
      'MUMU_API_ERROR'
    )
  )
  check(
    "assertLdTextOk 仍拦 player don't exist!",
    throwsCode(
      () => assertLdTextOk(res("player don't exist!", 0), ['copy', '--from', '99'], '克隆实例'),
      'MUMU_INSTANCE_MISSING'
    )
  )
  check(
    'assertLdTextOk 仍拦用法文本',
    throwsCode(
      () => assertLdTextOk(res('Usage:\nldconsole <command> [parameter]', 4), ['add'], '创建实例'),
      'MUMU_CLI_USAGE'
    )
  )
  check(
    'assertLdOk 对退出码 3 仍然报错（launch/quit 这类命令成功必须是 0）',
    throwsCode(
      () => assertLdOk(res('', 3), ['launch', '--index', '1'], '启动实例 1'),
      'MUMU_API_ERROR'
    )
  )
  check(
    '退出码 0 + 空输出 = 成功',
    !throwsCode(() => assertLdOk(res(''), ['launch'], '启动'), 'MUMU_API_ERROR')
  )
  check(
    "player don't exist! -> MUMU_INSTANCE_MISSING（即使退出码 0）",
    throwsCode(
      () => assertLdOk(res("player don't exist!", 0), ['quit'], '关闭'),
      'MUMU_INSTANCE_MISSING'
    )
  )
  check(
    '用法文本 -> MUMU_CLI_USAGE',
    throwsCode(
      () =>
        assertLdOk(
          res('dnplayer v14.0.26.1 Command Line Management Interface\nUsage:', -1001),
          ['launch'],
          '启动'
        ),
      'MUMU_CLI_USAGE'
    )
  )
  check(
    '退出码 -1001 + 其它文本 -> MUMU_API_ERROR',
    throwsCode(() => assertLdOk(res('something bad', -1001), ['reboot'], '重启'), 'MUMU_API_ERROR')
  )
  check(
    'list2 正常输出不报错',
    !throwsCode(
      () => assertLdOk(res('0,万龙游戏,0,0,0,-1,-1,2560,1440,360'), ['list2'], '列出'),
      'MUMU_API_ERROR'
    )
  )
}

// ── 5. modify 参数 ───────────────────────────────────────────────────────

console.log('【五、modify 参数拼装】')
{
  const f = LD_MODIFY_KEYS
  check('resolution 字符串', f['resolution']!.format('2560,1440,360') === '2560,1440,360')
  check(
    'resolution 2560x1440@360 写法',
    f['resolution']!.format('2560x1440@360') === '2560,1440,360'
  )
  check(
    'resolution 对象',
    f['resolution']!.format({ width: 2560, height: 1440, dpi: 360 }) === '2560,1440,360'
  )
  check(
    'resolution 非法',
    throwsCode(() => f['resolution']!.format('2560,1440'), 'INVALID_ARGUMENT')
  )
  check('cpu 整数', f['cpu']!.format(4) === '4' && f['cpu']!.format('6') === '6')
  check(
    'cpu 非法',
    throwsCode(() => f['cpu']!.format(0), 'INVALID_ARGUMENT')
  )
  check('memory', f['memory']!.format(4096) === '4096')
  check(
    '布尔 true/1/"1"',
    f['root']!.format(true) === '1' &&
      f['root']!.format(1) === '1' &&
      f['autorotate']!.format('0') === '0'
  )
  check(
    '布尔非法',
    throwsCode(() => f['lockwindow']!.format('yes'), 'INVALID_ARGUMENT')
  )
  check(
    '字符串空值非法',
    throwsCode(() => f['model']!.format(''), 'INVALID_ARGUMENT')
  )
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
if (fail > 0) process.exitCode = 1
