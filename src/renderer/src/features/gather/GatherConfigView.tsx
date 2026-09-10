/**
 * 「自动采集配置」页面。
 *
 * 逐项对应 resources/game-data/gather-config.schema.json（version = 2）。
 * 每一项都写清楚它是什么、调大调小分别付出什么代价 —— 使用者是玩家，不是读 schema 的人。
 *
 * ★ 全页最重要的一句话（在等级那一节还会再说一遍）：
 *   这里配的等级是**搜索下限**，不是目标等级。游戏返回的是「等级 >= 搜索值」的点，
 *   搜 5 跳到 7 是正常且更划算的结果，不是失败。
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Tag,
  Tooltip
} from 'antd'
import { ExportOutlined, ImportOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { useAppStore } from '@/store/appStore'
import { toast } from '@/ipc/useIpc'
import { useMarchStore } from './marchStore'
import { ConfigField, ConfigSection } from './ConfigField'
import {
  defaultGatherConfig,
  defaultLevelPolicy,
  describeLevelPolicy,
  formatSeconds,
  formatStorage,
  hasBlockingIssue,
  validateGatherConfig,
  type AllianceTerritory,
  type GatherConfig,
  type ResourceEntry
} from './config'
import {
  exportGatherConfig,
  importGatherConfig,
  loadGatherConfig,
  saveGatherConfig,
  type GatherConfigOrigin
} from './configStorage'
import { GATHER_RESOURCE_META, GATHER_RESOURCE_TYPES, type GatherResourceType } from './types'
import './gather.css'
import { ResourceBadge } from './ResourceBadge'

const ORIGIN_TEXT: Record<GatherConfigOrigin, string> = {
  account: '存于绑定账号（accounts.json）',
  local: '存于本机存储（未绑定账号）',
  default: '尚未保存过，当前是默认配置'
}

export default function GatherConfigView(): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)
  const selectedInstance = useAppStore((s) => s.selectedInstance)
  const selectInstance = useAppStore((s) => s.selectInstance)
  const setAccounts = useAppStore((s) => s.setAccounts)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)

  const [cfg, setCfg] = useState<GatherConfig>(() => defaultGatherConfig())
  const [origin, setOrigin] = useState<GatherConfigOrigin>('default')
  const [loadWarning, setLoadWarning] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ioOpen, setIoOpen] = useState(false)
  const [ioText, setIoText] = useState('')
  const [ioError, setIoError] = useState<string | null>(null)

  // 调度器那边有一份自己的运行时配置（SchedulerConfig），与本页的 schedule.* 有四项重叠。
  // 两边不一致时会让人困惑「到底哪个生效」，所以这里读出来做比对并提供一键同步。
  const schedConfig = useMarchStore((s) => s.config)
  const loadSched = useMarchStore((s) => s.load)
  const saveSchedConfig = useMarchStore((s) => s.saveConfig)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    void loadSched()
  }, [loadSched])

  // 换实例时重新载入这个实例的配置。
  useEffect(() => {
    if (selectedInstance === null) {
      setCfg(defaultGatherConfig())
      setOrigin('default')
      setLoadWarning(null)
      setDirty(false)
      return
    }
    const loaded = loadGatherConfig(selectedInstance, accounts)
    setCfg(loaded.config)
    setOrigin(loaded.origin)
    setLoadWarning(loaded.warning)
    setDirty(false)
  }, [selectedInstance, accounts])

  // 本页 schedule.* 与调度器运行时配置的重叠项比对。
  const schedMismatch = useMemo(() => {
    const diffs: Array<{ key: string; label: string; here: string; there: string }> = []
    if (cfg.schedule.slackSeconds !== schedConfig.slackSeconds) {
      diffs.push({
        key: 'slackSeconds',
        label: '唤醒冗余',
        here: `${cfg.schedule.slackSeconds} 秒`,
        there: `${schedConfig.slackSeconds} 秒`
      })
    }
    if (cfg.schedule.retryBackoffSeconds.join(',') !== schedConfig.retryBackoffSeconds.join(',')) {
      diffs.push({
        key: 'retryBackoffSeconds',
        label: '退避序列',
        here: cfg.schedule.retryBackoffSeconds.join(', '),
        there: schedConfig.retryBackoffSeconds.join(', ')
      })
    }
    if (cfg.schedule.maxBackoffSeconds !== schedConfig.maxBackoffSeconds) {
      diffs.push({
        key: 'maxBackoffSeconds',
        label: '退避上限',
        here: `${cfg.schedule.maxBackoffSeconds} 秒`,
        there: `${schedConfig.maxBackoffSeconds} 秒`
      })
    }
    if (cfg.schedule.calibrateIntervalMin !== schedConfig.calibrateIntervalMin) {
      diffs.push({
        key: 'calibrateIntervalMin',
        label: '兜底校准间隔',
        here: `${cfg.schedule.calibrateIntervalMin} 分钟`,
        there: `${schedConfig.calibrateIntervalMin} 分钟`
      })
    }
    if (cfg.schedule.jitterSeconds !== schedConfig.jitterSeconds) {
      diffs.push({
        key: 'jitterSeconds',
        label: '错峰抖动',
        here: `${cfg.schedule.jitterSeconds} 秒`,
        there: `${schedConfig.jitterSeconds} 秒`
      })
    }
    if (cfg.safety.unknownEtaFallbackSeconds !== schedConfig.unknownEtaFallbackSeconds) {
      diffs.push({
        key: 'unknownEtaFallbackSeconds',
        label: '倒计时读不出时的保守 ETA',
        here: `${cfg.safety.unknownEtaFallbackSeconds} 秒`,
        there: `${schedConfig.unknownEtaFallbackSeconds} 秒`
      })
    }
    return diffs
  }, [cfg, schedConfig])

  async function onSyncScheduler(): Promise<void> {
    setSyncing(true)
    try {
      const err = await saveSchedConfig({
        slackSeconds: cfg.schedule.slackSeconds,
        retryBackoffSeconds: cfg.schedule.retryBackoffSeconds,
        maxBackoffSeconds: cfg.schedule.maxBackoffSeconds,
        calibrateIntervalMin: cfg.schedule.calibrateIntervalMin,
        jitterSeconds: cfg.schedule.jitterSeconds,
        unknownEtaFallbackSeconds: cfg.safety.unknownEtaFallbackSeconds
      })
      if (err) toast().error(`同步到调度器失败：${err}`)
      else toast().success('已把这几项同步给调度器，立即生效。')
    } finally {
      setSyncing(false)
    }
  }

  const issues = useMemo(() => validateGatherConfig(cfg), [cfg])
  const blocked = hasBlockingIssue(issues)
  const errorCount = issues.filter((i) => i.level === 'error').length
  const warnCount = issues.length - errorCount

  /** 统一的改配置入口：改完必然置脏。 */
  function patch(fn: (draft: GatherConfig) => GatherConfig): void {
    setCfg((prev) => fn(structuredClone(prev)))
    setDirty(true)
  }

  function patchResource(type: GatherResourceType, fn: (r: ResourceEntry) => void): void {
    patch((d) => {
      const r = d.resources.find((x) => x.type === type)
      if (r) fn(r)
      return d
    })
  }

  async function onSave(): Promise<void> {
    if (selectedInstance === null) {
      toast().warning('先选一个实例再保存。')
      return
    }
    if (blocked) {
      toast().error(`还有 ${errorCount} 处配置错误，修好之后才能保存。`)
      return
    }
    setSaving(true)
    try {
      const res = await saveGatherConfig(selectedInstance, accounts, cfg)
      if (res.accounts) setAccounts(res.accounts)
      else if (res.origin === 'account') await refreshAccounts()
      setOrigin(res.origin)
      setDirty(false)
      toast().success(res.message)
    } catch (e) {
      // 不吞异常：把中文原因原样弹出来。
      toast().error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function onResetDefaults(): void {
    Modal.confirm({
      title: '恢复默认配置？',
      content: '当前页面上的修改会被丢弃，恢复成 schema 里的默认值。恢复后仍需点「保存」才会落盘。',
      okText: '恢复默认',
      cancelText: '取消',
      onOk: () => {
        setCfg(defaultGatherConfig())
        setDirty(true)
      }
    })
  }

  function onOpenExport(): void {
    setIoText(exportGatherConfig(cfg))
    setIoError(null)
    setIoOpen(true)
  }

  function onApplyImport(): void {
    try {
      const next = importGatherConfig(ioText)
      setCfg(next)
      setDirty(true)
      setIoOpen(false)
      setIoError(null)
      toast().success('已导入，检查无误后点「保存」落盘。')
    } catch (e) {
      setIoError(e instanceof Error ? e.message : String(e))
    }
  }

  const lp = cfg.levelPolicy
  const enabledResources = cfg.resources.filter((r) => r.enabled)

  return (
    <div className="wlg-page wlg-cfg">
      <div className="wlg-page-head">
        <div className="wlg-page-head-text">
          <h1 className="wl-title">自动采集配置</h1>
          <span className="wl-label">
            按实例分别配置。每一项都写了它的代价，改之前先读一眼说明。
          </span>
        </div>
        <div className="wlg-field-inline">
          <span className="wl-label">实例</span>
          <Select
            style={{ minWidth: 240 }}
            value={selectedInstance ?? undefined}
            placeholder="选择要配置的实例"
            onChange={(v: number) => selectInstance(v)}
            options={instances.map((i) => ({
              value: i.index,
              label: `#${i.index} ${i.name}${
                accounts.find((a) => a.instanceIndex === i.index)
                  ? ` · ${accounts.find((a) => a.instanceIndex === i.index)?.name}`
                  : ' · 未绑账号'
              }`
            }))}
          />
        </div>
      </div>

      {selectedInstance === null && (
        <Alert
          type="info"
          showIcon
          message="先选一个实例"
          description="采集配置是按实例（按账号）保存的，不同账号可以采不同的资源、用不同的等级下限。"
        />
      )}

      {loadWarning && (
        <Alert
          type="warning"
          showIcon
          message="读取已保存的配置时有问题"
          description={loadWarning}
        />
      )}

      {origin === 'local' && (
        <Alert
          type="warning"
          showIcon
          message="这份配置只存在本机浏览器存储里"
          description={
            <span>
              实例 #{selectedInstance} 还没绑定账号，配置无法随 accounts.json 落盘，
              换台机器或清掉存储就没了。建议先到「账号」页给它绑一个账号。
            </span>
          }
        />
      )}

      {/* ── 总开关 ─────────────────────────────────────────────────── */}
      <ConfigSection
        title="总开关"
        desc={
          <span>
            关掉之后调度器完全不会为这个实例安排采集任务，已经在途的队伍不受影响（游戏会自己
            把它们带回来）。当前配置来源：<b>{ORIGIN_TEXT[origin]}</b>。
          </span>
        }
        extra={
          <span className="wlg-field-inline">
            {errorCount > 0 && <Tag color="error">{errorCount} 处错误</Tag>}
            {warnCount > 0 && <Tag color="warning">{warnCount} 处提醒</Tag>}
            {errorCount === 0 && warnCount === 0 && <Tag color="success">配置校验通过</Tag>}
          </span>
        }
      >
        <ConfigField
          name="启用自动采集"
          path="enabled"
          issues={issues}
          hint="打开后，调度器会按下面的策略自动搜点、派兵、记录 ETA 并在队列释放时再派。"
          cost="打开就是真的会派兵占用行军队列。先把下面的阈值配好再开。"
        >
          <Switch
            checked={cfg.enabled}
            onChange={(v) => patch((d) => ((d.enabled = v), d))}
            checkedChildren="已启用"
            unCheckedChildren="已停用"
          />
        </ConfigField>
      </ConfigSection>

      {/* ── 资源类型 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="资源类型"
        desc={
          <span>
            勾选要采的资源，并给每种分配队列数与优先级。有空队列时，调度器按优先级从小到大
            找第一个「还欠队列」的资源去派。当前已启用 {enabledResources.length} 种， 合计分配{' '}
            {enabledResources.reduce((s, r) => s + r.queues, 0)} 个队列。
          </span>
        }
      >
        <div className="wlg-res-grid">
          {GATHER_RESOURCE_TYPES.map((type) => {
            const meta = GATHER_RESOURCE_META[type]
            const entry = cfg.resources.find((r) => r.type === type)
            if (!entry) return null
            return (
              <div
                key={type}
                className={entry.enabled ? 'wlg-res-card wlg-res-card-on' : 'wlg-res-card'}
              >
                <div className="wlg-res-card-head">
                  <ResourceBadge type={type} size={34} />
                  <div className="wlg-res-card-name">
                    <span className="wlg-field-name">{meta.resource}</span>
                    <span className="wl-micro">搜索面板分类「{meta.category}」</span>
                  </div>
                  <Switch
                    size="small"
                    checked={entry.enabled}
                    onChange={(v) => patchResource(type, (r) => void (r.enabled = v))}
                  />
                </div>
                <div className="wlg-res-card-row">
                  <Tooltip title="数字越小越先派。有空队列时优先满足优先级高、且还没派满队列数的资源。">
                    <span className="wl-label">优先级</span>
                  </Tooltip>
                  <InputNumber
                    size="small"
                    min={1}
                    max={4}
                    value={entry.priority}
                    disabled={!entry.enabled}
                    onChange={(v) =>
                      patchResource(
                        type,
                        (r) => void (r.priority = typeof v === 'number' ? v : r.priority)
                      )
                    }
                  />
                </div>
                <div className="wlg-res-card-row">
                  <Tooltip title="这种资源最多同时占用几个行军队列。填 0 等于不采（即使开关是开的）。">
                    <span className="wl-label">分配队列</span>
                  </Tooltip>
                  <InputNumber
                    size="small"
                    min={0}
                    max={5}
                    value={entry.queues}
                    disabled={!entry.enabled}
                    onChange={(v) =>
                      patchResource(
                        type,
                        (r) => void (r.queues = typeof v === 'number' ? v : r.queues)
                      )
                    }
                  />
                </div>
              </div>
            )
          })}
        </div>
        {issues
          .filter((i) => i.path === 'resources' || i.path.startsWith('resources.'))
          .map((i, k) => (
            <div key={k} className={i.level === 'error' ? 'wlg-field-err' : 'wlg-field-warn'}>
              {i.level === 'error' ? '错误：' : '提醒：'}
              {i.message}
            </div>
          ))}
      </ConfigSection>

      {/* ── 等级下限 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="等级策略（搜索下限）"
        desc={
          <Alert
            type="info"
            showIcon
            message="这里配的是「搜索下限」，不是目标等级"
            description={
              <span>
                游戏的匹配规则是「返回等级 <b>大于等于</b> 搜索值的资源点」，不是精确匹配。
                真机实测：把搜索值调到 1，连续搜 6 次返回的点是 8、7、7、7、7、8 ——
                一次都没等于搜索值。 所以搜 5 跳到 7 级点是<b>正常且更划算</b>的结果，不是失败；
                游戏也<b>不提供等级上界</b>，想避开不要的点只能靠下面的储量 / 行军时长 / 采集者 /
                联盟四个维度。
              </span>
            }
          />
        }
      >
        <ConfigField
          name="下限的算法"
          path="levelPolicy.mode"
          issues={issues}
          hint="相对：跟着游戏进程自动走（等级上限从 8 涨到 10 时不用改配置）。绝对：锁死一个值。"
        >
          <Segmented
            value={lp.mode}
            onChange={(v) =>
              patch((d) => {
                d.levelPolicy =
                  v === 'absolute'
                    ? { mode: 'absolute', level: 7, minLevel: 5, allowRelax: true }
                    : defaultLevelPolicy()
                return d
              })
            }
            options={[
              { label: '相对上限（推荐）', value: 'relative' },
              { label: '绝对值', value: 'absolute' }
            ]}
          />
        </ConfigField>

        {lp.mode === 'relative' ? (
          <>
            <ConfigField
              name="相对上限的偏移"
              path="levelPolicy.offset"
              issues={issues}
              hint="搜索下限 = 动态探测到的等级上限 + 这个偏移。用户默认规则是上限 −1。"
              cost="偏移越接近 0，候选点越少、越容易搜不到而反复重搜（每次重搜要多截几张图）；偏移越负，候选点越多、越快派出去，但可能采到低级点。"
            >
              <InputNumber
                min={-5}
                max={0}
                value={lp.offset}
                onChange={(v) =>
                  patch((d) => {
                    if (d.levelPolicy.mode === 'relative' && typeof v === 'number') {
                      d.levelPolicy.offset = v
                    }
                    return d
                  })
                }
              />
              <span className="wl-label">级</span>
            </ConfigField>

            <ConfigField
              name="探测失败时假定的上限"
              path="levelPolicy.assumedMaxLevel"
              issues={issues}
              hint="正常情况下上限是把搜索滑杆推到最右读出来的。读不到时用这个值兜底，实测当前版本是 8。"
            >
              <InputNumber
                min={1}
                max={15}
                value={lp.assumedMaxLevel}
                onChange={(v) =>
                  patch((d) => {
                    if (d.levelPolicy.mode === 'relative' && typeof v === 'number') {
                      d.levelPolicy.assumedMaxLevel = v
                    }
                    return d
                  })
                }
              />
            </ConfigField>

            <ConfigField
              name="上限硬顶"
              path="levelPolicy.maxLevelHardCap"
              issues={issues}
              hint="探测读到超过这个值一律判为识别错误。这是防误识别的护栏，不是资源点的等级上界。"
            >
              <InputNumber
                min={1}
                max={30}
                value={lp.maxLevelHardCap}
                onChange={(v) =>
                  patch((d) => {
                    if (d.levelPolicy.mode === 'relative' && typeof v === 'number') {
                      d.levelPolicy.maxLevelHardCap = v
                    }
                    return d
                  })
                }
              />
            </ConfigField>
          </>
        ) : (
          <>
            <ConfigField
              name="固定搜索下限"
              path="levelPolicy.level"
              issues={issues}
              hint="配 6 会搜到 6 级及以上的点，7、8 级都算合格。"
              cost="配得越高，附近符合的点越少，越容易一直搜不到而进入冷却；配得越低，派兵越快但收益偏低。"
            >
              <InputNumber
                min={1}
                max={15}
                value={lp.level}
                onChange={(v) =>
                  patch((d) => {
                    if (d.levelPolicy.mode === 'absolute' && typeof v === 'number') {
                      d.levelPolicy.level = v
                    }
                    return d
                  })
                }
              />
              <span className="wl-label">级及以上</span>
            </ConfigField>

            <ConfigField
              name="允许放宽下限重试"
              path="levelPolicy.allowRelax"
              issues={issues}
              hint="关掉则固定下限搜不到就放弃本轮，不放宽。"
            >
              <Switch
                checked={lp.allowRelax}
                onChange={(v) =>
                  patch((d) => {
                    if (d.levelPolicy.mode === 'absolute') d.levelPolicy.allowRelax = v
                    return d
                  })
                }
              />
            </ConfigField>
          </>
        )}

        <ConfigField
          name="下限可放宽到的最低值"
          path="levelPolicy.minLevel"
          issues={issues}
          hint="连续搜不到可用点时，下限会按下面的「每次放宽级数」逐步降低，降到这里为止；再失败就本轮放弃并进入冷却。"
          cost="设得越低越不容易空手而归，但也更可能采到收益很低的点。"
        >
          <InputNumber
            min={1}
            max={15}
            value={lp.minLevel}
            onChange={(v) =>
              patch((d) => {
                if (typeof v === 'number') d.levelPolicy.minLevel = v
                return d
              })
            }
          />
        </ConfigField>

        <div className="wlg-field-cost">{describeLevelPolicy(lp, null)}</div>
      </ConfigSection>

      {/* ── 筛选阈值 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="资源点筛选阈值"
        desc="搜到一个点之后，用这几条判断要不要采。任何一条不满足都会退出去重搜（重搜会多花几百毫秒到一秒）。"
      >
        <ConfigField
          name="最低储量"
          path="thresholds.minStorage"
          issues={issues}
          hint={
            <span>
              读资源点卡片上的「储量」（实测能读到 1,260,000 这种数）。低于这个值直接换点。
              当前设定：<b>{formatStorage(cfg.thresholds.minStorage)}</b>，填 0 表示不限制。
            </span>
          }
          cost="设得高，采一趟的收益高，但符合的点变少、更容易反复重搜；设得低，很快就能派出去但可能采一个小坑。"
        >
          <InputNumber
            min={0}
            step={50000}
            style={{ width: 180 }}
            value={cfg.thresholds.minStorage}
            onChange={(v) =>
              patch((d) => ((d.thresholds.minStorage = typeof v === 'number' ? v : 0), d))
            }
          />
        </ConfigField>

        <ConfigField
          name="最长单程行军"
          path="thresholds.maxTravelSeconds"
          issues={issues}
          hint={
            <span>
              首选的距离约束。这个数在「创建部队」页能从行军按钮上<b>直接读到</b>（实测显示
              00:01:04）， 精确且必然可见，比读地图上的「18 km」可靠得多。当前设定：
              <b>{formatSeconds(cfg.thresholds.maxTravelSeconds)}</b>，填 0 表示不限制。
            </span>
          }
          cost="设得小，队伍来回快、单位时间产量高，但附近符合的点少；设得大，能采远处的好点，但一趟往返会占住队列很久。"
        >
          <InputNumber
            min={0}
            step={30}
            style={{ width: 180 }}
            value={cfg.thresholds.maxTravelSeconds}
            onChange={(v) =>
              patch((d) => ((d.thresholds.maxTravelSeconds = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">秒</span>
        </ConfigField>

        <ConfigField
          name="最远距离（可选）"
          path="thresholds.maxDistanceKm"
          issues={issues}
          hint="读卡片右下角的「18 km」。这个标签贴在地图标记上、背景不稳定，识别可靠性明显低于上面的行军秒数，默认 0（不启用）。"
          cost="启用后多一道筛选，但一旦这个数字识别错了，会莫名其妙地把好点筛掉。除非确有需要，保持 0。"
        >
          <InputNumber
            min={0}
            style={{ width: 180 }}
            value={cfg.thresholds.maxDistanceKm}
            onChange={(v) =>
              patch((d) => ((d.thresholds.maxDistanceKm = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">km</span>
        </ConfigField>

        <ConfigField
          name="必须「采集者 无」"
          path="thresholds.requireGathererNone"
          issues={issues}
          hint="卡片上「采集者」一栏必须是「无」，否则说明这个点已经被别人占了。"
          cost="关掉等于允许去抢已占用的点，实际结果就是派兵失败白跑一趟。除非在调试，不要关。"
        >
          <Switch
            checked={cfg.thresholds.requireGathererNone}
            onChange={(v) => patch((d) => ((d.thresholds.requireGathererNone = v), d))}
          />
        </ConfigField>

        <ConfigField
          name="所属联盟策略"
          path="thresholds.allianceTerritory"
          issues={issues}
          hint={
            <span>
              卡片的「所属联盟」实测<b>不只有「无」</b>，还会出现联盟缩写（如 [T89S]），表示这个点
              在某个联盟的领地里。本方领地通常有采集加成；敌对领地则可能被打掉部队和资源。
            </span>
          }
          cost="默认「不筛」：收点最快、可选目标最多。改成筛选会漏掉大量可采点，且需要额外识别联盟字段。"
        >
          <Select
            style={{ minWidth: 260 }}
            value={cfg.thresholds.allianceTerritory}
            onChange={(v: AllianceTerritory) =>
              patch((d) => ((d.thresholds.allianceTerritory = v), d))
            }
            options={[
              { value: 'any', label: '不筛联盟 —— 任何领地都采（默认）' },
              { value: 'own-and-neutral', label: '本方 + 中立' },
              { value: 'own-only', label: '只采本方联盟领地（通常有加成）' }
            ]}
          />
        </ConfigField>

        <ConfigField
          name="本方联盟缩写"
          path="thresholds.ownAllianceTag"
          issues={issues}
          hint={
            <span>
              例如 <span className="wl-mono">T89A</span>
              。上面不选「不筛」时需要它来判断哪块是本方领地。
              留空时引擎会自动降级为「只接受所属联盟＝无（中立点）」并在这里告警 ——
              方向是安全的（少采而不是采错），但会漏掉本方领地上的加成点。
            </span>
          }
          cost="填了还要为它裁一张本方联盟标签的模板（按账号一张）。换联盟之后必须重裁，否则会把别人的领地认成自己的。"
        >
          <Input
            style={{ width: 180 }}
            maxLength={8}
            placeholder="留空 = 只接受中立点"
            value={cfg.thresholds.ownAllianceTag}
            onChange={(e) => patch((d) => ((d.thresholds.ownAllianceTag = e.target.value), d))}
          />
        </ConfigField>

        <ConfigField
          name="优先一趟采空"
          path="thresholds.preferLoadCoversStorage"
          issues={issues}
          hint="打开后，如果「创建部队」页显示的负载量小于卡片储量（一趟拉不完），就退出去重搜一个更小的点。"
          cost="默认关：勾了下面的「自动采集至清空」之后游戏会自己续采，没必要为此多重搜几次。"
        >
          <Switch
            checked={cfg.thresholds.preferLoadCoversStorage}
            onChange={(v) => patch((d) => ((d.thresholds.preferLoadCoversStorage = v), d))}
          />
        </ConfigField>
      </ConfigSection>

      {/* ── 游戏内设置项 ───────────────────────────────────────────── */}
      <ConfigSection
        title="游戏内设置项"
        desc="这一节改的是游戏里的勾选框，不是面板自己的开关。引擎走「读实际态 → 比对 → 只在不一致时点一下 → 复验」的对账流程，绝不盲点。"
      >
        <ConfigField
          name="自动采集至清空"
          path="autoGatherUntilEmpty"
          issues={issues}
          hint="资源点卡片上的勾选框。勾上之后队伍会一直采到这个点清空为止，不需要面板反复派兵。"
          cost="开着能显著减少派兵次数（也就少了很多次截图与操作）；关掉则每趟采满就回，队列周转更快但面板要更频繁地干活。"
        >
          <Switch
            checked={cfg.autoGatherUntilEmpty}
            onChange={(v) => patch((d) => ((d.autoGatherUntilEmpty = v), d))}
          />
        </ConfigField>
      </ConfigSection>

      {/* ── 队列分配 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="队列与派兵前置"
        desc="派兵的硬前置只有一个：行军队列有空位（「部队管理」右上角的 N/M）。指挥官耐力只用于打架，不影响采集，不做拦截。"
      >
        <ConfigField
          name="预留队列数"
          path="queuePlan.reserveQueues"
          issues={issues}
          hint="留给打野、集结这些别的玩法，自动采集不会去占。可用队列 = 队列上限 − 已用 − 预留。"
          cost="留得多，别的玩法随时有队伍可用；留得少，采集吞吐更高。"
        >
          <InputNumber
            min={0}
            max={5}
            value={cfg.queuePlan.reserveQueues}
            onChange={(v) =>
              patch((d) => ((d.queuePlan.reserveQueues = typeof v === 'number' ? v : 0), d))
            }
          />
        </ConfigField>

        <ConfigField
          name="自动采集最多占用的队列数"
          path="queuePlan.maxConcurrentGather"
          issues={issues}
          hint="上面各资源分配的队列之和不应超过这个值，超出的部分不会生效。"
        >
          <InputNumber
            min={1}
            max={5}
            value={cfg.queuePlan.maxConcurrentGather}
            onChange={(v) =>
              patch((d) => ((d.queuePlan.maxConcurrentGather = typeof v === 'number' ? v : 1), d))
            }
          />
        </ConfigField>

        <ConfigField
          name="避免两队派同一个点"
          path="queuePlan.avoidDuplicateTarget"
          issues={issues}
          hint="用「部队管理」面板每行的坐标做去重；新搜到的点如果和在途目标坐标相同就重搜。"
          cost="关掉会省下读坐标的那一点识别开销，但两队撞同一个点，后到的那队会白跑。"
        >
          <Switch
            checked={cfg.queuePlan.avoidDuplicateTarget}
            onChange={(v) => patch((d) => ((d.queuePlan.avoidDuplicateTarget = v), d))}
          />
        </ConfigField>

      </ConfigSection>

      {/* ── 搜索重试 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="搜索与放宽重试"
        desc={
          <span>
            搜到的点被占用 / 储量不够 / 太远 / 联盟不符 / 与在途目标重复，都算一次失败。
            连续失败到上限后，按下面的级数<b>放宽搜索下限</b>——注意「放宽」是让更多点符合条件，
            不等于「退而求其次采低级点」，放宽后照样可能采到高级点。
            <b>等级高于下限不算失败，不会计数。</b>
          </span>
        }
      >
        <ConfigField
          name="同一下限下最多重搜次数"
          path="searchRetry.occupiedRetryLimit"
          issues={issues}
          cost="次数多，坚持在高等级上找好点，代价是每次重搜都要多截几张图（游戏在前台时单张约 750ms）；次数少，很快就放宽下限，派得快但收益可能低。"
        >
          <InputNumber
            min={1}
            max={20}
            value={cfg.searchRetry.occupiedRetryLimit}
            onChange={(v) =>
              patch((d) => ((d.searchRetry.occupiedRetryLimit = typeof v === 'number' ? v : 1), d))
            }
          />
          <span className="wl-label">次</span>
        </ConfigField>

        <ConfigField
          name="每次放宽几级"
          path="searchRetry.floorRelaxStep"
          issues={issues}
          hint="schema v1 里这项叫 levelDownStep，名字有误导已更名。"
        >
          <InputNumber
            min={1}
            max={3}
            value={cfg.searchRetry.floorRelaxStep}
            onChange={(v) =>
              patch((d) => ((d.searchRetry.floorRelaxStep = typeof v === 'number' ? v : 1), d))
            }
          />
          <span className="wl-label">级</span>
        </ConfigField>

        <ConfigField
          name="两次搜索之间的间隔"
          path="searchRetry.researchDelayMs"
          issues={issues}
          hint="给地图跳转和卡片弹出动画留时间。"
          cost="太小会截到动画中间帧、模板匹配失败，反而要多搜几次；太大就是白等。"
        >
          <InputNumber
            min={0}
            step={100}
            style={{ width: 160 }}
            value={cfg.searchRetry.researchDelayMs}
            onChange={(v) =>
              patch((d) => ((d.searchRetry.researchDelayMs = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">毫秒</span>
        </ConfigField>

        <ConfigField
          name="动态探测等级上限"
          path="searchRetry.probeMaxLevel"
          issues={issues}
          hint="把搜索滑杆推到最右读数得到上限（实测当前 8，后期版本会到 10）。关掉则一直用上面的「假定上限」。"
          cost="开着每隔一段时间多花几张截图，换来的是版本更新后不用手改配置。"
        >
          <Switch
            checked={cfg.searchRetry.probeMaxLevel}
            onChange={(v) => patch((d) => ((d.searchRetry.probeMaxLevel = v), d))}
          />
        </ConfigField>

        <ConfigField
          name="重新探测上限的间隔"
          path="searchRetry.probeIntervalMin"
          issues={issues}
          hint="上限随游戏进程增长，变化极慢，默认 12 小时探一次，其余时间用缓存值。"
        >
          <InputNumber
            min={1}
            style={{ width: 160 }}
            value={cfg.searchRetry.probeIntervalMin}
            onChange={(v) =>
              patch((d) => ((d.searchRetry.probeIntervalMin = typeof v === 'number' ? v : 1), d))
            }
          />
          <span className="wl-label">分钟</span>
        </ConfigField>
      </ConfigSection>

      {/* ── 调度冗余 ────────────────────────────────────────────────── */}
      <ConfigSection
        title="调度冗余量"
        desc={
          <span>
            用户明确要求：<b>重复采集不必卡死时间，留冗余，宁晚勿早</b>。 唤醒时刻 = 队列释放时刻 +
            唤醒冗余；队列释放时刻 = 采集完成 + 单程行军
            （采集完队伍会自动回城，行军耗时在派兵时就从行军按钮上读到了，不用猜）。
          </span>
        }
      >
        {schedMismatch.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 'var(--wl-space-4)' }}
            message="这几项与调度器当前运行的值不一致"
            description={
              <div>
                <div style={{ marginBottom: 'var(--wl-space-2)' }}>
                  调度器自己也保存了一份运行时配置，真正决定什么时候唤醒的是<b>它那一份</b>。
                  下面这些项两边对不上，同步一下免得改了半天不生效：
                </div>
                {schedMismatch.map((d) => (
                  <div key={d.key} className="wl-micro">
                    · {d.label}：本页 <b>{d.here}</b>，调度器 <b>{d.there}</b>
                  </div>
                ))}
                <Button
                  size="small"
                  type="primary"
                  loading={syncing}
                  style={{ marginTop: 'var(--wl-space-3)' }}
                  onClick={() => void onSyncScheduler()}
                >
                  把本页的值同步给调度器
                </Button>
              </div>
            }
          />
        )}

        <ConfigField
          name="唤醒冗余"
          path="schedule.slackSeconds"
          issues={issues}
          hint={<span>当前 {formatSeconds(cfg.schedule.slackSeconds)}。</span>}
          cost="调小提高效率，但更容易撞上「队伍还没回来」——白开一次面板（截图约 750ms）之后还得退避重排，反而更慢。调大就是多空转一会儿。"
        >
          <InputNumber
            min={0}
            max={900}
            step={10}
            style={{ width: 160 }}
            value={cfg.schedule.slackSeconds}
            onChange={(v) =>
              patch((d) => ((d.schedule.slackSeconds = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">秒</span>
        </ConfigField>

        <ConfigField
          name="队列仍未空时的退避序列"
          path="schedule.retryBackoffSeconds"
          issues={issues}
          hint="逗号分隔的秒数，逐项取用，用完之后一直用最后一项。派兵成功后计数清零。"
          cost="序列爬得太慢会一直空转重试；爬得太快则队伍刚好回来时你还在睡。"
        >
          <Input
            style={{ width: 320 }}
            value={cfg.schedule.retryBackoffSeconds.join(', ')}
            onChange={(e) =>
              patch((d) => {
                const parsed = e.target.value
                  .split(/[,，\s]+/)
                  .map((s) => Number.parseInt(s, 10))
                  .filter((n) => Number.isFinite(n))
                d.schedule.retryBackoffSeconds = parsed
                return d
              })
            }
            placeholder="30, 60, 120, 240, 300"
          />
        </ConfigField>

        <ConfigField name="退避上限" path="schedule.maxBackoffSeconds" issues={issues}>
          <InputNumber
            min={30}
            step={30}
            style={{ width: 160 }}
            value={cfg.schedule.maxBackoffSeconds}
            onChange={(v) =>
              patch((d) => ((d.schedule.maxBackoffSeconds = typeof v === 'number' ? v : 30), d))
            }
          />
          <span className="wl-label">秒</span>
        </ConfigField>

        <ConfigField
          name="兜底校准间隔"
          path="schedule.calibrateIntervalMin"
          issues={issues}
          hint="距上次读「部队管理」面板超过这个时长就强制重采一次，纠正本地递推的漂移（机器休眠会让定时器滞后）。总览页上超过这个时长的行会灰化并标「待校准」。"
          cost="调小更准，但每次校准都要真的开一次面板（几张截图）；调大省开销，但倒计时可能与实际有偏差。"
        >
          <InputNumber
            min={1}
            style={{ width: 160 }}
            value={cfg.schedule.calibrateIntervalMin}
            onChange={(v) =>
              patch((d) => ((d.schedule.calibrateIntervalMin = typeof v === 'number' ? v : 1), d))
            }
          />
          <span className="wl-label">分钟</span>
        </ConfigField>

        <ConfigField
          name="多实例错峰抖动"
          path="schedule.jitterSeconds"
          issues={issues}
          hint="唤醒时刻上再加一个 0 到该值之间的随机量。"
          cost="多开时很有用：所有账号同一秒醒来会一起抢 adb（全局并发只有 6 条车道），互相拖慢。单开可以设 0。"
        >
          <InputNumber
            min={0}
            style={{ width: 160 }}
            value={cfg.schedule.jitterSeconds}
            onChange={(v) =>
              patch((d) => ((d.schedule.jitterSeconds = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">秒</span>
        </ConfigField>

        <ConfigField
          name="每小时派兵次数上限"
          path="schedule.maxDispatchesPerHour"
          issues={issues}
          hint="熔断保护：识别出错导致疯狂重试时兜底。填 0 表示不限制。"
        >
          <InputNumber
            min={0}
            style={{ width: 160 }}
            value={cfg.schedule.maxDispatchesPerHour}
            onChange={(v) =>
              patch((d) => ((d.schedule.maxDispatchesPerHour = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">次</span>
        </ConfigField>

        <ConfigField
          name="放弃后的冷却"
          path="schedule.giveUpCooldownMin"
          issues={issues}
          hint="下限已经放宽到最低值仍然搜不到可用点时，隔这么久再试一轮。"
        >
          <InputNumber
            min={1}
            style={{ width: 160 }}
            value={cfg.schedule.giveUpCooldownMin}
            onChange={(v) =>
              patch((d) => ((d.schedule.giveUpCooldownMin = typeof v === 'number' ? v : 1), d))
            }
          />
          <span className="wl-label">分钟</span>
        </ConfigField>
      </ConfigSection>

      {/* ── 安全与容错 ─────────────────────────────────────────────── */}
      <ConfigSection
        title="安全与容错"
        desc="识别不确定时怎么办。默认全是保守档：宁可少采一轮，也不在读不准的情况下乱点。"
      >
        <ConfigField
          name="对账复验失败即中止"
          path="safety.abortOnReconcileFail"
          issues={issues}
          hint="改完游戏内设置项后会再读一次确认。确认不通过就中止本轮并报错，不再继续点。"
          cost="关掉可能让勾选框被反复点开点关。建议保持开启。"
        >
          <Switch
            checked={cfg.safety.abortOnReconcileFail}
            onChange={(v) => patch((d) => ((d.safety.abortOnReconcileFail = v), d))}
          />
        </ConfigField>

        <ConfigField
          name="卡片等级识别失败时"
          path="safety.onUnknownLevel"
          issues={issues}
          hint={
            <span>
              「继续」的理由是：既然游戏只会返回等级 <b>≥</b> 搜索下限的点，读不出等级时也可以
              认为它满足下限，接着走后面的储量 / 联盟 / 行军时长校验。
            </span>
          }
          cost="选「中止」最保守但会更频繁地空转 —— 当前模板库只有 7、8 两个等级字形，选它几乎每轮都会中止；选「继续」代价只是日志里缺等级信息，故取它作默认。"
        >
          <Select
            style={{ minWidth: 300 }}
            value={cfg.safety.onUnknownLevel}
            onChange={(v: 'abort' | 'acceptCard') =>
              patch((d) => ((d.safety.onUnknownLevel = v), d))
            }
            options={[
              { value: 'abort', label: '中止本轮（最保守）' },
              { value: 'acceptCard', label: '视为满足下限，继续后续校验（默认）' }
            ]}
          />
        </ConfigField>

        <ConfigField
          name="储量识别失败时"
          path="safety.onUnknownStorage"
          issues={issues}
          cost="选「换点」会多搜几次；选「接受」可能采到一个几乎空的点。"
        >
          <Select
            style={{ minWidth: 300 }}
            value={cfg.safety.onUnknownStorage}
            onChange={(v: 'skipPoint' | 'accept') =>
              patch((d) => ((d.safety.onUnknownStorage = v), d))
            }
            options={[
              { value: 'skipPoint', label: '当作不达标，换点（保守，默认）' },
              { value: 'accept', label: '接受这个点' }
            ]}
          />
        </ConfigField>

        <ConfigField
          name="倒计时识别失败时的保守 ETA"
          path="safety.unknownEtaFallbackSeconds"
          issues={issues}
          hint="读不出「采集中 HH:MM:SS」时，按这个值重排唤醒。总览页上这样的行会显示「无倒计时数据」而不是当成空闲。"
          cost="宁晚勿早：设小了会一次次白跑去看队伍回来没有。"
        >
          <InputNumber
            min={60}
            step={60}
            style={{ width: 160 }}
            value={cfg.safety.unknownEtaFallbackSeconds}
            onChange={(v) =>
              patch(
                (d) => ((d.safety.unknownEtaFallbackSeconds = typeof v === 'number' ? v : 60), d)
              )
            }
          />
          <span className="wl-label">秒</span>
        </ConfigField>

        <ConfigField
          name="单轮派兵截图数上限"
          path="safety.maxCapturesPerCycle"
          issues={issues}
          hint="游戏在前台时单张截图实测约 750ms。超过上限说明流程卡在某一步了，中止并报错。默认 60：实测一次顺利派兵要 17 帧、一次换点要 6~7 帧，给少了重试策略跑不满就被熔断。"
        >
          <InputNumber
            min={6}
            style={{ width: 160 }}
            value={cfg.safety.maxCapturesPerCycle}
            onChange={(v) =>
              patch((d) => ((d.safety.maxCapturesPerCycle = typeof v === 'number' ? v : 6), d))
            }
          />
          <span className="wl-label">张</span>
        </ConfigField>

        <ConfigField
          name="滑动重试次数"
          path="safety.swipeRetry"
          issues={issues}
          hint="adb 的滑动指令会偶发被系统拒绝（SecurityException: INJECT_EVENTS），实测重试一次就好。"
          cost="设 0 等于把这种偶发失败直接变成整轮失败。"
        >
          <InputNumber
            min={0}
            style={{ width: 160 }}
            value={cfg.safety.swipeRetry}
            onChange={(v) =>
              patch((d) => ((d.safety.swipeRetry = typeof v === 'number' ? v : 0), d))
            }
          />
          <span className="wl-label">次</span>
        </ConfigField>

        <ConfigField
          name="截图留痕策略"
          path="safety.shotPolicy"
          issues={issues}
          hint="覆盖面板的全局设置。留痕图约 40KB 一张，存在 shots 目录下。"
          cost="「每步都留」排障最方便，但磁盘涨得快；「从不」最省，出问题时无从查起。"
        >
          <Select
            style={{ minWidth: 260 }}
            value={cfg.safety.shotPolicy}
            onChange={(v: 'never' | 'onFail' | 'always') =>
              patch((d) => ((d.safety.shotPolicy = v), d))
            }
            options={[
              { value: 'never', label: '从不留痕' },
              { value: 'onFail', label: '仅失败时留痕（默认）' },
              { value: 'always', label: '每一步都留痕' }
            ]}
          />
        </ConfigField>
      </ConfigSection>

      {/* ── 吸底操作条 ─────────────────────────────────────────────── */}
      <div className="wl-solid wlg-actions">
        <span className="wlg-actions-msg">
          {selectedInstance === null
            ? '未选择实例'
            : dirty
              ? '有未保存的修改'
              : `已同步 · ${ORIGIN_TEXT[origin]}`}
          {blocked && (
            <span style={{ color: 'var(--wl-danger)' }}>　{errorCount} 处错误未修复</span>
          )}
        </span>
        <div className="wlg-actions-btns">
          <Button icon={<ExportOutlined />} onClick={onOpenExport}>
            导出 / 导入
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onResetDefaults}>
            恢复默认
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={selectedInstance === null || blocked}
            onClick={() => void onSave()}
          >
            保存
          </Button>
        </div>
      </div>

      <Modal
        open={ioOpen}
        title="导出 / 导入采集配置"
        okText="导入这段 JSON"
        cancelText="关闭"
        width={720}
        onOk={onApplyImport}
        onCancel={() => setIoOpen(false)}
        okButtonProps={{ icon: <ImportOutlined /> }}
      >
        <div className="wlg-field-hint" style={{ marginBottom: 'var(--wl-space-3)' }}>
          下面是当前页面上的配置。可以整段复制走做备份，也可以粘一段进来再点「导入」——
          导入只改页面，还要再点「保存」才会落盘。缺失的字段会自动补默认值。
        </div>
        <Input.TextArea
          rows={16}
          value={ioText}
          spellCheck={false}
          onChange={(e) => {
            setIoText(e.target.value)
            setIoError(null)
          }}
          style={{ fontFamily: 'var(--wl-font-mono)', fontSize: 'var(--wl-fs-mono)' }}
        />
        {ioError && (
          <div className="wlg-field-err" style={{ marginTop: 'var(--wl-space-2)' }}>
            导入失败：{ioError}
          </div>
        )}
      </Modal>
    </div>
  )
}
