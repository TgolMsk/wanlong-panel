/**
 * 模板库 / 模板截取工具。
 *
 * 流程：选实例 -> 抓一帧（原始分辨率）-> 在画布上拉框 -> 填名字 -> 保存。
 *
 * ★ 这里承担一个关键的「防灾」职责：
 *   低方差模板（纯色块、渐变背景）会让 TM_CCOEFF_NORMED 彻底退化 —— 实测两个纯白模板对**任意**
 *   画面都恒定返回 1.0000 @ (0,0)。脚本一旦用上这种模板，就会在完全错误的位置疯狂点击。
 *   所以主进程会在 std < MIN_TEMPLATE_STD 时拒绝保存并抛 TEMPLATE_LOW_VARIANCE，
 *   这个视图必须把那条错误翻译成人能看懂的中文，并明确告诉用户「换一块有图标或文字的区域」。
 *
 * 坐标系：画布上拉的框是 **图像像素坐标**；保存时 crop 原样传（契约要求 image 自己的像素坐标），
 * 而 defaultRoi 必须换算到**参考分辨率**空间。两者别混。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Image as KonvaImage,
  Layer,
  Rect as KonvaRect,
  Stage,
  Text as KonvaText
} from 'react-konva'
import type Konva from 'konva'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Image as AntImage,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography
} from 'antd'
import {
  AimOutlined,
  BgColorsOutlined,
  CameraOutlined,
  ClearOutlined,
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
  ScanOutlined
} from '@ant-design/icons'
import {
  DEFAULT_ALPHA_DIFF_TOLERANCE,
  DEFAULT_MATCH_THRESHOLD,
  MIN_TEMPLATE_STD,
  REF_HEIGHT,
  REF_WIDTH,
  deviceToRef
} from '@shared/constants'
import type { Rect, TemplateDef, TemplateSaveInput } from '@shared/vision'
import type { TemplateTestResult } from '@shared/ipc'
import { isInstanceUp, useAppStore } from '../store/appStore'
import { bufferToObjectUrl, call, normalizeError, silentCall, tryCall, toast } from '../ipc/useIpc'
import { SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import { WL_CANVAS } from '../styles/antd-theme'

type DrawMode = 'crop' | 'roi'

interface Shot {
  bitmap: ImageBitmap
  png: ArrayBuffer
  /** 设备真实分辨率（screencap 头部给的）。 */
  deviceWidth: number
  deviceHeight: number
  /** PNG 自身的像素尺寸 —— crop 坐标以它为准。 */
  imgWidth: number
  imgHeight: number
}

/** 「再抓一帧去底」抓的差分帧：与主帧同一实例、同一分辨率，只是画面被拖开了一点。 */
interface DiffShot {
  png: ArrayBuffer
  /** 缩略图 blob URL，卸载 / 清空时要 revoke。 */
  url: string
  imgWidth: number
  imgHeight: number
}

/** 去底预览的解读：覆盖率太低多半是几帧位置没对齐，≈100% 说明控件是实心的、不需要去底。 */
function describeCoverage(c: number): {
  tone: 'danger' | 'warning' | 'success' | 'info'
  hint: string
} {
  if (c < 0.1)
    return {
      tone: 'danger',
      hint: '几乎全被抠掉了：几帧之间控件位置对不上？或者容差太小。保存会被拒绝。'
    }
  if (c < 0.3)
    return { tone: 'warning', hint: '留下的本体很少，匹配可能不稳；试试调大容差或重抓差分帧。' }
  if (c >= 0.97)
    return {
      tone: 'info',
      hint: '几乎整块不透明：这个控件是实心的，不需要去底，保存后按普通模板处理。'
    }
  return { tone: 'success', hint: '洋红 = 抠掉（不参与匹配）；剩下的就是控件本体。' }
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(b.x - a.x)),
    h: Math.round(Math.abs(b.y - a.y))
  }
}

/** 图像像素矩形 -> 参考分辨率矩形。 */
function rectToRef(r: Rect, imgW: number, imgH: number): Rect {
  const tl = deviceToRef(r.x, r.y, imgW, imgH)
  return {
    x: tl.x,
    y: tl.y,
    w: Math.round((r.w * REF_WIDTH) / imgW),
    h: Math.round((r.h * REF_HEIGHT) / imgH)
  }
}

export default function TemplateEditor(): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const templateSets = useAppStore((s) => s.templateSets)
  const selectedInstance = useAppStore((s) => s.selectedInstance)
  const selectInstance = useAppStore((s) => s.selectInstance)
  const refreshTemplateSets = useAppStore((s) => s.refreshTemplateSets)

  const [setId, setSetId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<TemplateDef[]>([])
  const [selectedTpl, setSelectedTpl] = useState<TemplateDef | null>(null)
  const [tplImageUrl, setTplImageUrl] = useState<string | null>(null)

  const [shot, setShot] = useState<Shot | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [fullRes, setFullRes] = useState(true)

  const [mode, setMode] = useState<DrawMode>('crop')
  const [crop, setCrop] = useState<Rect | null>(null)
  const [roi, setRoi] = useState<Rect | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const [name, setName] = useState('')
  /** 可选的固定 ID：流程 / 调度器按 id 引用模板（如 tpl_btn_close_popup），留空则自动生成。 */
  const [tplId, setTplId] = useState('')
  const [threshold, setThreshold] = useState<number>(DEFAULT_MATCH_THRESHOLD)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{
    code: string
    message: string
    std?: number
  } | null>(null)

  const [newSetOpen, setNewSetOpen] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [newSetPkg, setNewSetPkg] = useState('')

  // ── 透明底（多帧差分去底）──
  const [diffShots, setDiffShots] = useState<DiffShot[]>([])
  const diffShotsRef = useRef<DiffShot[]>([])
  const [diffTolerance, setDiffTolerance] = useState<number>(DEFAULT_ALPHA_DIFF_TOLERANCE)
  const [capturingDiff, setCapturingDiff] = useState(false)
  const [alphaPreview, setAlphaPreview] = useState<{ url: string; coverage: number } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    (TemplateTestResult & { previewUrl: string }) | null
  >(null)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [stageW, setStageW] = useState(720)

  // ── 画布尺寸 ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 720
      setStageW(Math.max(320, Math.floor(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scale = shot ? stageW / shot.imgWidth : 1
  const stageH = shot ? Math.round(shot.imgHeight * scale) : 0

  // ── 模板集 / 模板列表 ───────────────────────────────────────────────────
  useEffect(() => {
    if (!setId && templateSets.length > 0) setSetId(templateSets[0].id)
  }, [templateSets, setId])

  const loadTemplates = useCallback(async (id: string | null) => {
    if (!id) {
      setTemplates([])
      return
    }
    const list = await tryCall('template:list', id)
    setTemplates(list ?? [])
  }, [])

  useEffect(() => {
    void loadTemplates(setId)
    setSelectedTpl(null)
  }, [setId, loadTemplates])

  // 选中模板时按需读原图，避免一次拉几十张 png。
  useEffect(() => {
    let revoked: string | null = null
    if (!selectedTpl || !setId) {
      setTplImageUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
      return
    }
    let alive = true
    silentCall('template:image', setId, selectedTpl.id)
      .then((buf) => {
        if (!alive) return
        const url = bufferToObjectUrl(buf, 'image/png')
        revoked = url
        setTplImageUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return url
        })
      })
      .catch(() => {
        if (alive) setTplImageUrl(null)
      })
    return () => {
      alive = false
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [selectedTpl, setId])

  // 卸载时收干净 ImageBitmap 与 blob URL。
  useEffect(() => {
    return () => {
      shot?.bitmap.close()
    }
  }, [shot])

  // ── 抓帧 ────────────────────────────────────────────────────────────────
  const capture = async (): Promise<void> => {
    if (selectedInstance === null) {
      toast().warning('请先选择一个实例')
      return
    }
    setCapturing(true)
    try {
      // width:0 = 保持原始分辨率。模板越接近原始像素，匹配越稳。
      const s = await call('device:capturePng', selectedInstance, fullRes ? 0 : 1280)
      const bitmap = await createImageBitmap(new Blob([s.png], { type: 'image/png' }))
      // 旧帧的 ImageBitmap 由下面那个 [shot] 依赖的 effect 在 cleanup 里 close，
      // 这里不要在 setState 的 updater 里做副作用（StrictMode 会把 updater 跑两遍）。
      setShot({
        bitmap,
        png: s.png,
        deviceWidth: s.width,
        deviceHeight: s.height,
        imgWidth: s.imageWidth,
        imgHeight: s.imageHeight
      })
      setCrop(null)
      setRoi(null)
      setSaveError(null)
      // 主帧换了，之前抓的差分帧就不再是「同一位置」，一并作废。
      clearDiffShots()
    } catch {
      /* 已提示 */
    } finally {
      setCapturing(false)
    }
  }

  // ── 透明底：再抓一帧去底 ────────────────────────────────────────────────
  const clearDiffShots = (): void => {
    for (const d of diffShotsRef.current) URL.revokeObjectURL(d.url)
    diffShotsRef.current = []
    setDiffShots([])
    setAlphaPreview((old) => {
      if (old) URL.revokeObjectURL(old.url)
      return null
    })
    setPreviewError(null)
  }

  const captureDiff = async (): Promise<void> => {
    if (selectedInstance === null || !shot) {
      toast().warning('先抓主帧，再抓差分帧')
      return
    }
    if (diffShotsRef.current.length >= 3) {
      toast().info('最多 3 帧差分帧就够了')
      return
    }
    setCapturingDiff(true)
    try {
      const s = await call('device:capturePng', selectedInstance, fullRes ? 0 : 1280)
      if (s.imageWidth !== shot.imgWidth || s.imageHeight !== shot.imgHeight) {
        toast().error(
          `这一帧 ${s.imageWidth}x${s.imageHeight} 与主帧 ${shot.imgWidth}x${shot.imgHeight} 尺寸不一致，` +
            '请保持同一实例、同一「原始分辨率」开关再抓。'
        )
        return
      }
      const d: DiffShot = {
        png: s.png,
        url: bufferToObjectUrl(s.png, 'image/png'),
        imgWidth: s.imageWidth,
        imgHeight: s.imageHeight
      }
      diffShotsRef.current = [...diffShotsRef.current, d]
      setDiffShots(diffShotsRef.current)
    } catch {
      /* 已提示 */
    } finally {
      setCapturingDiff(false)
    }
  }

  // 卸载时把差分帧的 blob URL 收干净。
  useEffect(() => {
    return () => {
      for (const d of diffShotsRef.current) URL.revokeObjectURL(d.url)
    }
  }, [])

  // 差分帧 / 截取框 / 容差一变就重算预览（防抖 350ms；抓帧是 MB 级，别拖着算）。
  useEffect(() => {
    if (!shot || diffShots.length === 0 || !crop || crop.w < 8 || crop.h < 8) {
      setAlphaPreview((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return null
      })
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      setPreviewing(true)
      setPreviewError(null)
      silentCall('template:alphaPreview', {
        image: shot.png,
        diffFrames: diffShots.map((d) => d.png),
        crop,
        tolerance: diffTolerance,
        previewWidth: 320
      })
        .then((r) => {
          if (!alive) return
          setAlphaPreview((old) => {
            if (old) URL.revokeObjectURL(old.url)
            return { url: bufferToObjectUrl(r.previewPng, 'image/png'), coverage: r.coverage }
          })
        })
        .catch((e) => {
          if (!alive) return
          setPreviewError(normalizeError(e).message)
        })
        .finally(() => {
          if (alive) setPreviewing(false)
        })
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [shot, diffShots, crop, diffTolerance])

  // ── 画布拉框 ────────────────────────────────────────────────────────────
  const pointerOnImage = (stage: Konva.Stage | null): { x: number; y: number } | null => {
    if (!stage || !shot) return null
    const p = stage.getPointerPosition()
    if (!p) return null
    return {
      x: Math.min(shot.imgWidth, Math.max(0, p.x / scale)),
      y: Math.min(shot.imgHeight, Math.max(0, p.y / scale))
    }
  }

  const onDown = (e: Konva.KonvaEventObject<PointerEvent>): void => {
    const p = pointerOnImage(e.target.getStage())
    if (!p) return
    dragStart.current = p
    if (mode === 'crop') setCrop({ x: p.x, y: p.y, w: 0, h: 0 })
    else setRoi({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onMove = (e: Konva.KonvaEventObject<PointerEvent>): void => {
    if (!dragStart.current) return
    const p = pointerOnImage(e.target.getStage())
    if (!p) return
    const r = normRect(dragStart.current, p)
    if (mode === 'crop') setCrop(r)
    else setRoi(r)
  }

  const onUp = (): void => {
    dragStart.current = null
  }

  // ── 保存 ────────────────────────────────────────────────────────────────
  const save = async (): Promise<void> => {
    if (!setId) {
      toast().warning('请先选择或新建一个模板集')
      return
    }
    if (!shot) {
      toast().warning('请先抓一帧画面')
      return
    }
    if (!crop || crop.w < 8 || crop.h < 8) {
      toast().warning('请在画面上拉出一个至少 8x8 像素的截取框')
      return
    }
    if (!name.trim()) {
      toast().warning('请给模板起个名字，例如「联盟按钮」')
      return
    }
    const idText = tplId.trim()
    if (idText && !/^[A-Za-z0-9_-]{3,64}$/.test(idText)) {
      toast().warning('模板 ID 只能用字母、数字、下划线、短横线，3~64 位，例如 tpl_btn_close_popup')
      return
    }
    const input: TemplateSaveInput = {
      ...(idText ? { id: idText } : {}),
      name: name.trim(),
      image: shot.png,
      authoredWidth: shot.imgWidth,
      authoredHeight: shot.imgHeight,
      crop,
      defaultRoi: roi ? rectToRef(roi, shot.imgWidth, shot.imgHeight) : undefined,
      threshold,
      note: note.trim() || undefined,
      // 透明底：有差分帧就交给主进程按 crop 做差分去底（与预览走同一套算法）。
      ...(diffShots.length > 0 ? { diffFrames: diffShots.map((d) => d.png), diffTolerance } : {})
    }
    setSaving(true)
    setSaveError(null)
    try {
      const def = await silentCall('template:save', setId, input)
      toast().success(
        `模板「${def.name}」已保存（标准差 ${def.std?.toFixed(1) ?? '—'}` +
          (typeof def.maskCoverage === 'number'
            ? `，透明底 ${Math.round(def.maskCoverage * 100)}%）`
            : '）')
      )
      setName('')
      setTplId('')
      setNote('')
      setCrop(null)
      clearDiffShots()
      await loadTemplates(setId)
      await refreshTemplateSets()
    } catch (e) {
      const err = normalizeError(e)
      const std = typeof err.detail?.std === 'number' ? (err.detail.std as number) : undefined
      setSaveError({ code: err.code, message: err.message, std })
      if (err.code !== 'TEMPLATE_LOW_VARIANCE') toast().error(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── 立即验证 ────────────────────────────────────────────────────────────
  const runTest = async (tpl: TemplateDef): Promise<void> => {
    if (!setId) return
    if (selectedInstance === null) {
      toast().warning('请先选择一个实例，验证需要在真实画面上跑一次匹配')
      return
    }
    setTesting(true)
    try {
      const r = await call('template:test', {
        setId,
        templateId: tpl.id,
        instanceIndex: selectedInstance,
        roi: tpl.defaultRoi,
        threshold: tpl.threshold
      })
      setTestResult((old) => {
        if (old) URL.revokeObjectURL(old.previewUrl)
        return { ...r, previewUrl: bufferToObjectUrl(r.preview.jpeg) }
      })
    } catch {
      /* 已提示 */
    } finally {
      setTesting(false)
    }
  }

  const createSet = async (): Promise<void> => {
    if (!newSetName.trim()) {
      toast().warning('请填写模板集名称')
      return
    }
    const s = await tryCall('template:createSet', newSetName.trim(), newSetPkg.trim() || undefined)
    if (s) {
      toast().success(`模板集「${s.name}」已创建`)
      setNewSetOpen(false)
      setNewSetName('')
      setNewSetPkg('')
      await refreshTemplateSets()
      setSetId(s.id)
    }
  }

  const removeTemplate = async (tpl: TemplateDef): Promise<void> => {
    if (!setId) return
    const r = await tryCall('template:delete', setId, tpl.id)
    if (r !== undefined) {
      toast().success(`模板「${tpl.name}」已删除`)
      if (selectedTpl?.id === tpl.id) setSelectedTpl(null)
      await loadTemplates(setId)
    }
  }

  const instanceOptions = useMemo(
    () =>
      instances.map((i) => ({
        value: i.index,
        label: `${i.index} · ${i.name}${i.adb === 'connected' ? '' : '（adb 未连接）'}`,
        disabled: !isInstanceUp(i) || i.adb !== 'connected'
      })),
    [instances]
  )

  const currentSet = templateSets.find((s) => s.id === setId) ?? null

  return (
    <Row gutter={12}>
      {/* ── 左：模板集与模板列表 ── */}
      <Col span={7}>
        <GlassCard
          padding="sm"
          title="模板集"
          extra={
            <Button size="small" icon={<PlusOutlined />} onClick={() => setNewSetOpen(true)}>
              新建
            </Button>
          }
        >
          <Select
            style={{ width: '100%', marginBottom: 8 }}
            placeholder="选择模板集"
            value={setId ?? undefined}
            onChange={(v: string) => setSetId(v)}
            options={templateSets.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.templates.length} 个${s.packageName ? `｜${s.packageName}` : ''}）`
            }))}
            notFoundContent="还没有模板集，点右上角「新建」"
          />
          {currentSet && (
            <span className="wl-micro">
              参考分辨率 {currentSet.refWidth}x{currentSet.refHeight}
            </span>
          )}

          <List
            size="small"
            style={{ marginTop: 8, maxHeight: 420, overflowY: 'auto' }}
            dataSource={templates}
            locale={{ emptyText: '这个集合里还没有模板。在右边抓一帧画面，拉框保存。' }}
            renderItem={(t) => {
              const low = typeof t.std === 'number' && t.std < MIN_TEMPLATE_STD * 1.5
              return (
                <List.Item
                  className={selectedTpl?.id === t.id ? 'wl-selected' : 'wl-hoverable'}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 'var(--wl-radius-sm)',
                    paddingInline: 'var(--wl-space-2)'
                  }}
                  onClick={() => setSelectedTpl(t)}
                  actions={[
                    <Tooltip key="test" title="在当前实例的真实画面上跑一次匹配">
                      <Button
                        size="small"
                        type="link"
                        icon={<ScanOutlined />}
                        loading={testing}
                        onClick={(e) => {
                          e.stopPropagation()
                          void runTest(t)
                        }}
                      />
                    </Tooltip>,
                    <Popconfirm
                      key="del"
                      title="删除这个模板？"
                      description="引用它的脚本会在运行时报「模板不存在」。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => void removeTemplate(t)}
                    >
                      <Button
                        size="small"
                        type="link"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size={4}>
                        <span>{t.name}</span>
                        {typeof t.std === 'number' && (
                          <Tooltip
                            title={
                              low
                                ? `标准差只有 ${t.std.toFixed(1)}，纹理偏单调，匹配容易误判。建议换一块有图标或文字的区域重截。`
                                : `灰度标准差 ${t.std.toFixed(1)}，纹理充足`
                            }
                          >
                            <SemanticTag tone={low ? 'warning' : 'success'}>
                              σ {t.std.toFixed(1)}
                            </SemanticTag>
                          </Tooltip>
                        )}
                        {typeof t.maskCoverage === 'number' && (
                          <Tooltip
                            title={`透明底模板：只有 ${Math.round(t.maskCoverage * 100)}% 的像素参与匹配，其余是会变的背景，已抠掉（多帧差分去底）。`}
                          >
                            <SemanticTag tone="info">
                              透明底 {Math.round(t.maskCoverage * 100)}%
                            </SemanticTag>
                          </Tooltip>
                        )}
                      </Space>
                    }
                    description={
                      <span className="wl-micro">
                        {t.bounds.w}x{t.bounds.h}
                        {t.defaultRoi ? '｜已设 ROI' : '｜全屏搜索'}
                        {t.threshold ? `｜阈值 ${t.threshold}` : ''}
                      </span>
                    }
                  />
                </List.Item>
              )
            }}
          />

          {selectedTpl && (
            <Card
              size="small"
              style={{ marginTop: 'var(--wl-space-2)' }}
              title={`模板：${selectedTpl.name}`}
            >
              {tplImageUrl ? (
                <AntImage
                  src={tplImageUrl}
                  alt={selectedTpl.name}
                  style={{ maxWidth: '100%', border: '1px solid var(--wl-border)' }}
                />
              ) : (
                <Typography.Text type="secondary">图片加载中…</Typography.Text>
              )}
              <Descriptions size="small" column={1} style={{ marginTop: 8 }}>
                <Descriptions.Item label="截取时画面">
                  {selectedTpl.authoredWidth}x{selectedTpl.authoredHeight}
                </Descriptions.Item>
                <Descriptions.Item label="参考坐标">
                  {selectedTpl.bounds.x},{selectedTpl.bounds.y} · {selectedTpl.bounds.w}x
                  {selectedTpl.bounds.h}
                </Descriptions.Item>
                <Descriptions.Item label="默认 ROI">
                  {selectedTpl.defaultRoi
                    ? `${selectedTpl.defaultRoi.x},${selectedTpl.defaultRoi.y} · ${selectedTpl.defaultRoi.w}x${selectedTpl.defaultRoi.h}`
                    : '未设置（全屏搜索，慢 40 倍左右）'}
                </Descriptions.Item>
                {typeof selectedTpl.maskCoverage === 'number' && (
                  <Descriptions.Item label="透明底">
                    不透明 {Math.round(selectedTpl.maskCoverage * 100)}
                    %，其余像素（会变的背景）不参与匹配
                  </Descriptions.Item>
                )}
              </Descriptions>
            </Card>
          )}
        </GlassCard>
      </Col>

      {/* ── 右：抓帧与拉框 ── */}
      <Col span={17}>
        <GlassCard
          padding="sm"
          title="截取模板"
          extra={
            <Space wrap>
              <Select
                size="small"
                style={{ width: 220 }}
                placeholder="选择实例"
                value={selectedInstance ?? undefined}
                onChange={(v: number) => selectInstance(v)}
                options={instanceOptions}
                notFoundContent="没有可用实例，请先到「实例管理」启动并连接 adb"
              />
              <Tooltip title="原始分辨率抓帧更慢（约 280ms），但模板像素与实际画面一致，匹配最稳。">
                <Space size={4}>
                  <Switch size="small" checked={fullRes} onChange={setFullRes} />
                  <span className="wl-label">原始分辨率</span>
                </Space>
              </Tooltip>
              <Button
                size="small"
                type="primary"
                icon={<CameraOutlined />}
                loading={capturing}
                onClick={() => void capture()}
              >
                抓一帧
              </Button>
            </Space>
          }
        >
          <Space style={{ marginBottom: 8 }} wrap>
            <Segmented<DrawMode>
              size="small"
              value={mode}
              onChange={(v) => setMode(v)}
              options={[
                { value: 'crop', label: '拉截取框' },
                { value: 'roi', label: '拉默认 ROI' }
              ]}
            />
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={() => (mode === 'crop' ? setCrop(null) : setRoi(null))}
            >
              清除当前框
            </Button>
            {crop && (
              <SemanticTag tone="info">
                截取框 {crop.x},{crop.y} · {crop.w}x{crop.h}
              </SemanticTag>
            )}
            {roi && shot && (
              <SemanticTag tone="accent">
                ROI（参考坐标）
                {(() => {
                  const r = rectToRef(roi, shot.imgWidth, shot.imgHeight)
                  return ` ${r.x},${r.y} · ${r.w}x${r.h}`
                })()}
              </SemanticTag>
            )}
            {shot && (
              <span className="wl-micro">
                无损 PNG｜设备画面 {shot.deviceWidth}x{shot.deviceHeight}｜本帧 {shot.imgWidth}x
                {shot.imgHeight}
              </span>
            )}
          </Space>

          <div
            ref={wrapRef}
            style={{
              width: '100%',
              background: WL_CANVAS.bg,
              borderRadius: 16,
              overflow: 'hidden',
              minHeight: 200
            }}
          >
            {shot ? (
              <Stage
                width={stageW}
                height={stageH}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                style={{ cursor: 'crosshair' }}
              >
                <Layer>
                  <KonvaImage image={shot.bitmap} width={stageW} height={stageH} />
                  {roi && (
                    <>
                      <KonvaRect
                        x={roi.x * scale}
                        y={roi.y * scale}
                        width={roi.w * scale}
                        height={roi.h * scale}
                        stroke={WL_CANVAS.savedStroke}
                        strokeWidth={2}
                        dash={[6, 4]}
                      />
                      <KonvaText
                        x={roi.x * scale + 4}
                        y={Math.max(0, roi.y * scale - 16)}
                        text="搜索区域 ROI"
                        fontSize={12}
                        fill={WL_CANVAS.savedLabel}
                      />
                    </>
                  )}
                  {crop && (
                    <>
                      <KonvaRect
                        x={crop.x * scale}
                        y={crop.y * scale}
                        width={crop.w * scale}
                        height={crop.h * scale}
                        stroke={WL_CANVAS.roiStroke}
                        strokeWidth={2}
                        fill={WL_CANVAS.roiFill}
                      />
                      <KonvaText
                        x={crop.x * scale + 4}
                        y={Math.max(0, crop.y * scale - 16)}
                        text={`模板 ${crop.w}x${crop.h}`}
                        fontSize={12}
                        fill={WL_CANVAS.roiLabel}
                      />
                    </>
                  )}
                </Layer>
              </Stage>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                style={{ padding: 60 }}
                description={
                  <Typography.Text style={{ color: WL_CANVAS.hint }}>
                    先选实例再点「抓一帧」，然后在画面上按住拖动拉出模板区域
                  </Typography.Text>
                }
              />
            )}
          </div>

          <Card
            size="small"
            style={{ marginTop: 10 }}
            title={
              <Space size={6}>
                <BgColorsOutlined />
                <span>透明底（去掉会变的背景）</span>
                {diffShots.length > 0 && (
                  <SemanticTag tone="info">已抓 {diffShots.length}/3 帧</SemanticTag>
                )}
              </Space>
            }
            extra={
              <Space size={6}>
                <Button
                  size="small"
                  icon={<CameraOutlined />}
                  loading={capturingDiff}
                  disabled={!shot || diffShots.length >= 3}
                  onClick={() => void captureDiff()}
                >
                  再抓一帧去底
                </Button>
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  disabled={diffShots.length === 0}
                  onClick={clearDiffShots}
                >
                  清空
                </Button>
              </Space>
            }
          >
            <Row gutter={12} align="top">
              <Col flex="1 1 320px">
                <Typography.Paragraph className="wl-micro" style={{ marginBottom: 8 }}>
                  圆环 / 镂空 / 半透明、压在地图或城内地形上的控件，整块裁下来会随背景漂移。
                  做法：先把游戏画面<strong>拖开一点</strong>
                  （让图标底下的背景变了、图标本身没动）， 再点「再抓一帧去底」，抓 1~3
                  帧。几帧之间没变的像素才当模板本体，其余抠成透明、不参与匹配。
                  实心控件不需要这一步。
                </Typography.Paragraph>
                <Space wrap size={8}>
                  <Space size={4}>
                    <span className="wl-label">容差</span>
                    <Tooltip title="RGB 任一通道差值 ≤ 容差视为「没变」。默认 24；背景只是轻微变化时调小，画面有压缩噪点时调大。">
                      <InputNumber
                        size="small"
                        min={4}
                        max={96}
                        value={diffTolerance}
                        onChange={(v) =>
                          setDiffTolerance(typeof v === 'number' ? v : DEFAULT_ALPHA_DIFF_TOLERANCE)
                        }
                      />
                    </Tooltip>
                  </Space>
                  {diffShots.map((d, i) => (
                    <img
                      key={d.url}
                      src={d.url}
                      alt={`差分帧 ${i + 1}`}
                      style={{ height: 44, borderRadius: 6, border: '1px solid var(--wl-border)' }}
                    />
                  ))}
                </Space>
              </Col>
              {diffShots.length > 0 && (
                <Col flex="0 0 340px">
                  {alphaPreview ? (
                    <Space direction="vertical" size={4}>
                      <img
                        src={alphaPreview.url}
                        alt="去底预览"
                        style={{
                          maxWidth: 320,
                          maxHeight: 220,
                          borderRadius: 8,
                          border: '1px solid var(--wl-border)',
                          imageRendering: 'pixelated'
                        }}
                      />
                      {(() => {
                        const d = describeCoverage(alphaPreview.coverage)
                        return (
                          <Space size={6} wrap>
                            <SemanticTag tone={d.tone}>
                              不透明 {Math.round(alphaPreview.coverage * 100)}%
                            </SemanticTag>
                            <span className="wl-micro">{d.hint}</span>
                          </Space>
                        )
                      })()}
                    </Space>
                  ) : (
                    <span className="wl-micro">
                      {previewError
                        ? `预览失败：${previewError}`
                        : !crop
                          ? '先在画面上拉一个截取框，这里会显示去底效果'
                          : previewing
                            ? '计算中…'
                            : '等待预览'}
                    </span>
                  )}
                </Col>
              )}
            </Row>
          </Card>

          {saveError && (
            <Alert
              style={{ marginTop: 'var(--wl-space-3)' }}
              type="error"
              showIcon
              closable
              onClose={() => setSaveError(null)}
              message={
                saveError.code === 'TEMPLATE_LOW_VARIANCE'
                  ? '这块区域纹理太单调，不能当模板'
                  : '保存失败'
              }
              description={
                saveError.code === 'TEMPLATE_LOW_VARIANCE' ? (
                  <div>
                    <p style={{ marginBottom: 6 }}>
                      灰度标准差
                      {typeof saveError.std === 'number'
                        ? ` 只有 ${saveError.std.toFixed(1)}`
                        : '过低'}
                      （下限 {MIN_TEMPLATE_STD}）。纯色块或渐变背景会让匹配算法彻底失效 ——
                      实测这类模板对<strong>任意</strong>画面都返回 1.0000
                      的满分，脚本会在完全错误的位置疯狂点击。
                    </p>
                    <p style={{ marginBottom: 0 }}>
                      请换一块<strong>有图标、有文字、有明显边缘</strong>的区域重新框选，
                      并尽量把框贴紧图标本身，别把大片背景框进去。
                    </p>
                  </div>
                ) : (
                  saveError.message
                )
              }
            />
          )}

          <Form layout="inline" style={{ marginTop: 10, rowGap: 8 }}>
            <Form.Item label="模板名称" style={{ flex: 1, minWidth: 220 }}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：联盟按钮 / 每日签到弹窗"
              />
            </Form.Item>
            <Form.Item label="模板 ID" style={{ minWidth: 240 }}>
              <Tooltip title="可选。流程 / 调度器按 ID 引用模板：填已有的 ID 会覆盖那张模板（例如补裁 tpl_btn_close_popup）；留空自动生成。">
                <Input
                  value={tplId}
                  onChange={(e) => setTplId(e.target.value)}
                  placeholder="可选，如 tpl_btn_close_popup"
                  allowClear
                />
              </Tooltip>
            </Form.Item>
            <Form.Item label="阈值">
              <InputNumber
                min={0.5}
                max={0.999}
                step={0.01}
                value={threshold}
                onChange={(v) => setThreshold(typeof v === 'number' ? v : DEFAULT_MATCH_THRESHOLD)}
              />
            </Form.Item>
            <Form.Item label="备注" style={{ flex: 1, minWidth: 200 }}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!shot || !crop || !setId}
                onClick={() => void save()}
              >
                保存模板
              </Button>
            </Form.Item>
          </Form>

          <Alert
            style={{ marginTop: 8 }}
            type="info"
            showIcon
            icon={<AimOutlined />}
            message="强烈建议顺手拉一个默认 ROI"
            description={`实测全屏匹配 62ms，缩到导航条 5.2ms，缩到单个按钮 1.45ms —— 限定搜索区域是最划算的一档加速（约 40 倍），而且能顺带避开画面别处长得像的元素。`}
          />
        </GlassCard>
      </Col>

      {/* 新建模板集 */}
      <Modal
        open={newSetOpen}
        title="新建模板集"
        okText="创建"
        cancelText="取消"
        onOk={() => void createSet()}
        onCancel={() => setNewSetOpen(false)}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="名称" required>
            <Input
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              placeholder="例如：主界面 / 联盟副本"
            />
          </Form.Item>
          <Form.Item label="归属游戏包名（可选）" extra="填了之后脚本可以按包名筛选可用模板集。">
            <Input
              value={newSetPkg}
              onChange={(e) => setNewSetPkg(e.target.value)}
              placeholder="com.example.game"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 匹配验证结果 */}
      <Modal
        open={!!testResult}
        title="匹配验证结果"
        footer={null}
        width={900}
        onCancel={() => {
          if (testResult) URL.revokeObjectURL(testResult.previewUrl)
          setTestResult(null)
        }}
        destroyOnHidden
      >
        {testResult && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type={testResult.match.found ? 'success' : 'warning'}
              showIcon
              message={
                testResult.match.found
                  ? `命中：得分 ${testResult.match.score.toFixed(4)}（阈值 ${testResult.match.threshold}）`
                  : `未命中：最高得分 ${testResult.match.score.toFixed(4)}，低于阈值 ${testResult.match.threshold}`
              }
              description={
                testResult.match.found
                  ? `落点（参考坐标）${testResult.match.centerX},${testResult.match.centerY}，耗时 ${testResult.match.elapsedMs}ms`
                  : (testResult.match.reason ??
                    '画面上没有这个元素，或者阈值定得太高。可以先把阈值降到 0.8 试试，但别低于 0.7。')
              }
            />
            <AntImage src={testResult.previewUrl} alt="验证预览" style={{ width: '100%' }} />
          </Space>
        )}
      </Modal>
    </Row>
  )
}
