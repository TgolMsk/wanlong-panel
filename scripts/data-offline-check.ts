import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defaultSettings } from '@shared/defaults'
import {
  loadSettings,
  saveSettings,
  getSettings,
  getRuntimeSettings,
  resetSettings
} from '@main/config'
import { selectDataContext } from '@main/dataContext'
import { resolvePaths } from '@main/paths'
import { loadGatherStates, saveGatherState } from '@main/game/gatherStateStore'
import { createRuntimeState } from '@main/game/gather/types'

const root = await mkdtemp(join(tmpdir(), 'wanlong-data-check-'))
process.env.WL_RUNTIME_CHECK_DIR = root
try {
  const dirA = join(root, 'A'),
    dirB = join(root, 'B')
  const initial = {
    ...defaultSettings(dirA, 'win32'),
    mumutoolPath: 'C:\\fake\\MuMuManager.exe',
    adbPath: 'C:\\fake\\adb.exe'
  }
  await mkdir(join(root, '.wl-data'), { recursive: true })
  await writeFile(join(root, '.wl-data/settings.json'), JSON.stringify(initial))
  await loadSettings()
  await assert.rejects(saveSettings({ dataDir: 'relative-data' }), { code: 'INVALID_ARGUMENT' })
  await Promise.all([saveSettings({ dataDir: dirB }), saveSettings({ matchThreshold: 0.9 })])
  assert.equal(getSettings().dataDir, dirB)
  assert.equal(getSettings().restartRequired, true)
  assert.equal(getRuntimeSettings().dataDir, dirA)
  assert.equal(getRuntimeSettings().matchThreshold, 0.9)
  assert.equal(
    JSON.parse(await readFile(join(root, '.wl-data/settings.json'), 'utf8')).dataDir,
    dirB
  )
  await saveSettings({ dataDir: dirA })
  assert.equal(getSettings().restartRequired, false)
  await saveSettings({
    emulator: 'ldplayer',
    mumutoolPath: 'C:\\fakeLD\\ldconsole.exe',
    adbPath: 'C:\\fakeLD\\adb.exe'
  })
  assert.equal(getRuntimeSettings().emulator, initial.emulator)
  assert.equal(getSettings().runtimeEmulator, initial.emulator)
  resetSettings()
  const restarted = await loadSettings()
  assert.equal(restarted.emulator, 'ldplayer')
  assert.equal(getSettings().restartRequired, false)

  const primary = await selectDataContext(initial)
  assert.equal(primary, resolve(dirA))
  await writeFile(join(primary, 'scheduler.json'), '{"old":"A"}')
  const alternateSettings = {
    ...initial,
    emulator: 'ldplayer' as const,
    mumutoolPath: 'C:\\fakeLD\\ldconsole.exe'
  }
  const alternate = await selectDataContext(alternateSettings)
  assert.notEqual(alternate, primary)
  assert.equal(await selectDataContext(initial), primary)
  const aPaths = resolvePaths(initial, primary),
    bPaths = resolvePaths(alternateSettings, alternate)
  assert.notEqual(aPaths.accountsDir, bPaths.accountsDir)
  assert.equal(aPaths.templatesDir, bPaths.templatesDir)
  assert.equal(await readFile(join(primary, 'scheduler.json'), 'utf8'), '{"old":"A"}')
  await assert.rejects(readFile(join(alternate, 'scheduler.json')))
  const otherInstall = await selectDataContext({
    ...initial,
    mumutoolPath: 'D:\\other\\MuMuManager.exe'
  })
  assert.notEqual(otherInstall, primary)

  await Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      saveGatherState(primary, i, { ...createRuntimeState(), giveUpUntil: i + 100 })
    )
  )
  const states = await loadGatherStates(primary)
  assert.equal(Object.keys(states).length, 32)
  for (let i = 0; i < 32; i++) assert.equal(states[String(i)].giveUpUntil, i + 100)
  const damaged = join(root, 'damaged')
  await mkdir(damaged)
  await writeFile(join(damaged, 'gather-state.json'), '{broken')
  await assert.rejects(saveGatherState(damaged, 1, createRuntimeState()), { code: 'IO_ERROR' })
  assert.equal(await readFile(join(damaged, 'gather-state.json'), 'utf8'), '{broken')
  await writeFile(join(damaged, 'gather-state.json'), '{}')
  await saveGatherState(damaged, 2, createRuntimeState())
  assert.ok((await loadGatherStates(damaged))['2'])
  console.log(
    'PASS: concurrent settings merge, deferred activation/revert/restart, emulator and installation isolation, shared templates, 32 concurrent state saves, corrupt data preservation and retry'
  )
} finally {
  resetSettings()
  // Only remove the freshly allocated test directory under the system temporary directory.
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('wanlong-data-check-'))
    throw new Error('Unexpected cleanup path')
  await rm(target, { recursive: true, force: true })
}
