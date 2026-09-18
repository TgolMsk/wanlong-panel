/**
 * 「从画面截取 → 直接变成一块」。
 *
 * 流程一条直线：选实例 → 抓一帧 → 在画面上**拉个框** → 选要做成哪种块 → 起个名字 → 保存并插入。
 * 一次点击同时干了两件事：模板存进模板库，块插进脚本 —— 这正是「截图直接拖成功能块」。
 *
 * 与「模板库」页的分工：那边是模板的**仓库**（改阈值、透明底去底、立即验证、删除），
 * 这边是写脚本时的**快捷通道**，只留最常用的一条路。两边保存走的是同一条 `template:save`。
 *
 * ★ 三个坑，都是模板库页踩过的，这里原样遵守：
 *   1. 拉框坐标是**图像像素**，crop 原样传（契约要求 image 自己的像素坐标）。
 *   2. 不传 defaultRoi —— 主进程会按模板位置自动外扩一个（实测 ROI 最多能带来 43 倍加速）。
 *   3. 低方差（纯色块、渐变）模板会被主进程拒绝，必须把 TEMPLATE_LOW_VARIANCE 翻成人话：
 *      「换一块有图标或文字的区域」，而不是把错误码甩给用户。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Image as KonvaImage, Layer, Rect as KonvaRect, Stage } from 'react-konva'
import type Konva from 'konva'
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Tooltip,
  Typography
} from 'antd'
import { CameraOutlined } from '@ant-design/icons'
import { MIN_TEMPLATE_STD } from '@shared/constants'
import type { Rect, TemplateDef, TemplateSaveInput } from '@shared/vision'
import type { ScriptStep } from '@shared/script'
import { isInstanceUp, useAppStore } from '../../store/appStore'
import { call, normalizeError, silentCall, toast } from '../../ipc/useIpc'
import { WL_CANVAS } from '../../styles/antd-theme'
import { makeBlock, type BlockKind } from '@shared/blocks'

/** 抓到的一帧。 */
interface Shot {
  bitmap: ImageBitmap
  png: ArrayBuffer
  /** PNG 自身的像素尺寸 —— crop 坐标以它为准。 */
  imgWidth: number
  imgHeight: number
}

/** 画布最大宽度，超了按比例缩。 */
const CANVAS_MAX_W = 760

/** 能从画面直接截出来的块只有这三种（都是「对着一张图做点什么」）。 */
const CAPTURE_KINDS: { value: BlockKind; label: string; hint: string }[] = [
  { value: 'tapTemplate', label: '点这张图', hint: '找到它就点下去' },
  { value: 'waitAppear', label: '等它出现', hint: '一直等到它出现再往下走' },
  { value: 'waitDisappear', label: '等它消失', hint: '等它从画面上消失（加载圈转完）' }
]

export interface CaptureBlockModalProps {
  open: boolean
  /** 脚本绑定的模板集 id。没有就不能截 —— 外层负责先让用户选模板集。 */
  setId: string | null
  /** 生成新块 id 用（避开已用的）。 */
  makeId: (prefix: string) => string
  onCancel: () => void
  /** 保存成功：把新模板和新块交给外层插进脚本。 */
  onDone: (step: ScriptStep, template: TemplateDef) => void
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(a.x - b.x)),
    h: Math.round(Math.abs(a.y - b.y))
  }
}

export default function CaptureBlockModal({
  open,
  setId,
  makeId,
  onCancel,
  onDone
}: CaptureBlockModalProps): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const [instanceIndex, setInstanceIndex] = useState<number | null>(null)
  const [shot, setShot] = useState<Shot | null>(null)
  const [crop, setCrop] = useState<Rect | null>(null)
  const [kind, setKind] = useState<BlockKind>('tapTemplate')
  const [name, setName] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; lowVariance: boolean } | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const upInstances = instances.filter(isInstanceUp)

  // 关掉时把这一帧的 ImageBitmap 还给系统（一帧 2560x1440 RGBA ≈ 14MB，攒几帧就很可观）。
  useEffect(() => {
    return () => {
      shot?.bitmap.close()
    }
  }, [shot])

  useEffect(() => {
    if (!open) return
    if (instanceIndex === null && upInstances.length > 0) setInstanceIndex(upInstances[0].index)
  }, [open, upInstances, instanceIndex])

  const reset = useCallback(() => {
    setShot(null)
    setCrop(null)
    setName('')
    setError(null)
  }, [])

  const capture = async (): Promise<void> => {
    if (instanceIndex === null) {
      toast().warning('请先选一个已开机的实例')
      return
    }
    setCapturing(true)
    try {
      // width:0 = 保持原始分辨率。模板越接近原始像素，匹配越稳。
      const s = await call('device:capturePng', instanceIndex, 0)
      const bitmap = await createImageBitmap(new Blob([s.png], { type: 'image/png' }))
      setShot({ bitmap, png: s.png, imgWidth: s.imageWidth, imgHeight: s.imageHeight })
      setCrop(null)
      setError(null)
    } catch {
      /* call() 已经弹过中文提示 */
    } finally {
      setCapturing(false)
    }
  }

  const scale = shot ? Math.min(1, CANVAS_MAX_W / shot.imgWidth) : 1

  const pointerOnImage = (stage: Konva.Stage | null): { x: number; y: number } | null => {
    if (!stage || !shot) return null
    const p = stage.getPointerPosition()
    if (!p) return null
    return {
      x: Math.min(shot.imgWidth, Math.max(0, p.x / scale)),
      y: Math.min(shot.imgHeight, Math.max(0, p.y / scale))
    }
  }

  const save = async (): Promise<void> => {
    if (!setId) {
      toast().warning('这个脚本还没选模板集，先在上面选一个')
      return
    }
    if (!shot) {
      toast().warning('先抓一帧画面')
      return
    }
    if (!crop || crop.w < 8 || crop.h < 8) {
      toast().warning('在画面上拉一个至少 8×8 像素的框，框住要认的图标或文字')
      return
    }
    if (!name.trim()) {
      toast().warning('给它起个名字，例如「联盟按钮」')
      return
    }
    const input: TemplateSaveInput = {
      name: name.trim(),
      image: shot.png,
      authoredWidth: shot.imgWidth,
      authoredHeight: shot.imgHeight,
      crop,
      // 不给 defaultRoi：主进程会按模板位置自动外扩一个，比全屏搜快得多，也省得用户再拉一次框。
      note: '在脚本编辑器里截取'
    }
    setSaving(true)
    setError(null)
    try {
      const def = await silentCall('template:save', setId, input)
      const step = makeBlock(kind, makeId(kind === 'tapTemplate' ? 'tap' : 'wait'), def.id)
      onDone(step, def)
      toast().success(`已存为模板「${def.name}」并插入一块（标准差 ${def.std?.toFixed(1) ?? '—'}）`)
      reset()
    } catch (e) {
      const err = normalizeError(e)
      setError({ message: err.message, lowVariance: err.code === 'TEMPLATE_LOW_VARIANCE' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title="从画面截取一块"
      width={CANVAS_MAX_W + 96}
      onCancel={() => {
        reset()
        onCancel()
      }}
      onOk={() => void save()}
      okText="保存并插入"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Select
            style={{ width: 220 }}
            placeholder="选一个已开机的实例"
            value={instanceIndex ?? undefined}
            onChange={(v) => setInstanceIndex(v)}
            options={upInstances.map((i) => ({ value: i.index, label: `${i.index} · ${i.name}` }))}
            notFoundContent="没有已开机的实例"
          />
          <Button
            type="primary"
            icon={<CameraOutlined />}
            loading={capturing}
            onClick={() => void capture()}
          >
            抓一帧
          </Button>
          <Typography.Text type="secondary">
            在画面上按住拖一个框，框住要认的图标或文字
          </Typography.Text>
        </Space>

        {!shot ? (
          <Empty
            description={
              upInstances.length === 0
                ? '先到「模拟器实例」页把实例开起来并连接 adb'
                : '点「抓一帧」把当前画面取过来'
            }
          />
        ) : (
          <div
            style={{
              background: WL_CANVAS.bg,
              borderRadius: 8,
              overflow: 'hidden',
              width: shot.imgWidth * scale,
              height: shot.imgHeight * scale
            }}
          >
            <Stage
              width={shot.imgWidth * scale}
              height={shot.imgHeight * scale}
              onPointerDown={(e) => {
                const p = pointerOnImage(e.target.getStage())
                if (!p) return
                dragStart.current = p
                setCrop({ x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 })
              }}
              onPointerMove={(e) => {
                if (!dragStart.current) return
                const p = pointerOnImage(e.target.getStage())
                if (!p) return
                setCrop(normRect(dragStart.current, p))
              }}
              onPointerUp={() => {
                dragStart.current = null
              }}
            >
              <Layer listening={false}>
                <KonvaImage image={shot.bitmap} scaleX={scale} scaleY={scale} />
                {crop && crop.w > 0 && (
                  <KonvaRect
                    x={crop.x * scale}
                    y={crop.y * scale}
                    width={crop.w * scale}
                    height={crop.h * scale}
                    stroke={WL_CANVAS.matchStroke}
                    strokeWidth={2}
                    dash={[6, 4]}
                    fill={WL_CANVAS.matchFill}
                  />
                )}
              </Layer>
            </Stage>
          </div>
        )}

        <Space wrap align="start">
          <div>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text strong>做成哪种块</Typography.Text>
            </div>
            <Segmented
              value={kind}
              onChange={(v) => setKind(v as BlockKind)}
              options={CAPTURE_KINDS.map((k) => ({
                value: k.value,
                label: <Tooltip title={k.hint}>{k.label}</Tooltip>
              }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text strong>叫什么名字</Typography.Text>
            </div>
            <Input
              style={{ width: 240 }}
              placeholder="例如：联盟按钮"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              onPressEnter={() => void save()}
            />
          </div>
          {crop && crop.w > 0 && (
            <div>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>框住的区域</Typography.Text>
              </div>
              <Typography.Text type="secondary">
                {crop.w} × {crop.h} 像素 @ ({crop.x}, {crop.y})
              </Typography.Text>
            </div>
          )}
        </Space>

        {error && (
          <Alert
            type="error"
            showIcon
            message={error.lowVariance ? '这块图案太单调，不能当模板' : '保存失败'}
            description={
              error.lowVariance ? (
                <span>
                  纯色块和渐变背景会让匹配彻底失效 —— 实测两张纯白模板对<strong>任意</strong>画面都返回 1.0000，
                  脚本会在完全错误的位置疯狂点击，所以这里直接拒绝（标准差要求 ≥ {MIN_TEMPLATE_STD}
                  ）。
                  <br />
                  换一块<strong>有图标、有文字、有明显边缘</strong>的区域再框一次。
                </span>
              ) : (
                error.message
              )
            }
          />
        )}
      </Space>
    </Modal>
  )
}
