/**
 * 画面预览 + 手动操控。
 *
 * ★ 两条不能违背的事实：
 *  1. **帧率天花板 ≈ 3fps**。screencap 是同步阻塞的，2560x1440 raw 一帧就要 280ms，
 *     模拟器吞吐硬上限约 4.3 帧/秒。所以这里不做「流畅播放」的暗示，界面上直接标出实测帧率，
 *     并把它当成「监控快照」而不是「投屏」。
 *  2. **帧数据绝不进 React state**。ImageBitmap 存在 ref 里，直接画到 canvas；
 *     进了 state 会每帧触发一次全组件重渲染，几帧就卡死。
 *
 * 两种取帧方式：
 *   · 直连模式：这次执行有 worker MessagePort，帧由 worker 推过来（Transferable，零拷贝）。
 *   · 轮询模式：没有执行在跑时，手动/定时调 device:capture 抓一帧。
 * 面板不可见（active=false）时会给 worker 发 {preview:false} 关流省 CPU。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography
} from 'antd'
import { AimOutlined, CameraOutlined, ReloadOutlined } from '@ant-design/icons'
import { PREVIEW_MAX_FPS, PREVIEW_WIDTH, REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import type { AndroidKey } from '@shared/script'
import type { MatchResult } from '@shared/vision'
import type { ManualInput } from '@shared/ipc'
import { hasWorkerPort, postToWorker, useWorkerPort } from '../ipc/useWorkerPort'
import { tryCall, toast } from '../ipc/useIpc'
import { SemanticTag } from '../components/StatusTag'
import { WL_CANVAS } from '../styles/antd-theme'

/** 拖动超过这么多参考像素才算滑动，否则按点击处理。 */
const SWIPE_THRESHOLD_REF = 40

const KEY_OPTIONS: { value: AndroidKey; label: string }[] = [
  { value: 'BACK', label: '返回' },
  { value: 'HOME', label: '主页' },
  { value: 'APP_SWITCH', label: '最近任务' },
  { value: 'ENTER', label: '回车' },
  { value: 'DEL', label: '退格' },
  { value: 'MENU', label: '菜单' },
  { value: 'ESCAPE', label: 'ESC' },
  { value: 'VOLUME_UP', label: '音量+' },
  { value: 'VOLUME_DOWN', label: '音量-' }
]

export interface PreviewPaneProps {
  instanceIndex: number | null
  /** 有执行在跑时传进来，优先走 worker 直连帧。 */
  runId?: string | null
  /** 面板是否可见。false 时停止取帧并通知 worker 关流。 */
  active?: boolean
  height?: number
}

export default function PreviewPane({
  instanceIndex,
  runId = null,
  active = true,
  height = 460
}: PreviewPaneProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const matchesRef = useRef<MatchResult[]>([])
  const dragRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const pollingRef = useRef(false)
  const fpsWindowRef = useRef<number[]>([])

  const [autoPoll, setAutoPoll] = useState(false)
  const [showMatches, setShowMatches] = useState(true)
  const [mode, setMode] = useState<'tap' | 'swipe'>('tap')
  const [fps, setFps] = useState(0)
  const [frameInfo, setFrameInfo] = useState<{
    w: number
    h: number
    deviceWidth: number
    deviceHeight: number
    at: number
  } | null>(null)
  const [textToSend, setTextToSend] = useState('')
  const [key, setKey] = useState<AndroidKey>('BACK')
  const [capturing, setCapturing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const live = !!runId && hasWorkerPort(runId)

  // ── 绘制 ────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const bmp = bitmapRef.current
    if (!canvas || !bmp) return
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width
      canvas.height = bmp.height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)

    if (!showMatches) return
    // 匹配框是**参考坐标**，按比例换算到当前 bitmap 像素。
    const sx = canvas.width / REF_WIDTH
    const sy = canvas.height / REF_HEIGHT
    ctx.lineWidth = Math.max(1, Math.round(canvas.width / 400))
    ctx.font = `${Math.max(11, Math.round(canvas.width / 60))}px system-ui, sans-serif`
    for (const m of matchesRef.current) {
      if (!m.found) continue
      // Canvas 吃不了 CSS 变量，颜色统一从 WL_CANVAS 取，别在这写十六进制。
      ctx.strokeStyle = WL_CANVAS.matchStroke
      ctx.strokeRect(m.x * sx, m.y * sy, m.w * sx, m.h * sy)
      const label = `${m.templateId} ${m.score.toFixed(3)}`
      const tw = ctx.measureText(label).width
      ctx.fillStyle = WL_CANVAS.matchLabelBg
      ctx.fillRect(m.x * sx, Math.max(0, m.y * sy - 18), tw + 8, 18)
      ctx.fillStyle = WL_CANVAS.matchLabelText
      ctx.fillText(label, m.x * sx + 4, Math.max(13, m.y * sy - 5))
    }
  }, [showMatches])

  const setBitmap = useCallback(
    (bmp: ImageBitmap, meta: { deviceWidth: number; deviceHeight: number; capturedAt: number }) => {
      bitmapRef.current?.close()
      bitmapRef.current = bmp
      const now = performance.now()
      const win = fpsWindowRef.current
      win.push(now)
      while (win.length > 0 && now - win[0] > 3000) win.shift()
      setFps(win.length >= 2 ? Number((((win.length - 1) * 1000) / (now - win[0])).toFixed(1)) : 0)
      setFrameInfo({
        w: bmp.width,
        h: bmp.height,
        deviceWidth: meta.deviceWidth,
        deviceHeight: meta.deviceHeight,
        at: meta.capturedAt
      })
      draw()
    },
    [draw]
  )

  // frameInfo 必须进依赖：第一帧到达时 canvas 还没挂载（渲染分支依赖 frameInfo），
  // setBitmap 里那次同步 draw() 拿到的是 null，必须等这次 commit 之后补画一次。
  useEffect(() => {
    draw()
  }, [draw, showMatches, frameInfo])

  // 卸载时释放最后一帧，避免 ImageBitmap 泄漏（每帧几 MB）。
  useEffect(() => {
    return () => {
      bitmapRef.current?.close()
      bitmapRef.current = null
    }
  }, [])

  // ── 直连模式：worker 推帧 ────────────────────────────────────────────────

  useWorkerPort({
    onFrame: (f) => {
      if (!active) return
      if (runId && f.runId !== runId) return
      void createImageBitmap(new Blob([f.jpeg], { type: 'image/jpeg' }))
        .then((bmp) =>
          setBitmap(bmp, {
            deviceWidth: f.deviceWidth,
            deviceHeight: f.deviceHeight,
            capturedAt: f.capturedAt
          })
        )
        .catch((e: unknown) => setLastError(`预览帧解码失败：${String(e)}`))
    },
    onMatches: (rid, results) => {
      if (runId && rid !== runId) return
      matchesRef.current = results
      draw()
    }
  })

  // 开关推流。面板隐藏 / 切走 / 卸载都要关，否则 worker 白白多截图。
  useEffect(() => {
    if (!runId) return
    postToWorker(runId, { type: 'preview', enabled: active })
    postToWorker(runId, { type: 'debugMatches', enabled: active && showMatches })
    return () => {
      postToWorker(runId, { type: 'preview', enabled: false })
    }
  }, [runId, active, showMatches])

  // ── 轮询模式：device:capture ────────────────────────────────────────────

  const captureOnce = useCallback(async (): Promise<void> => {
    if (instanceIndex === null) return
    if (pollingRef.current) return
    pollingRef.current = true
    setCapturing(true)
    try {
      const shot = await tryCall('device:capture', instanceIndex, {
        width: PREVIEW_WIDTH
      })
      if (!shot) {
        setAutoPoll(false)
        setLastError('抓帧失败，已停止自动刷新。请确认实例已开机并且 adb 已连接。')
        return
      }
      setLastError(null)
      const bmp = await createImageBitmap(new Blob([shot.jpeg], { type: 'image/jpeg' }))
      setBitmap(bmp, {
        deviceWidth: shot.width,
        deviceHeight: shot.height,
        capturedAt: shot.capturedAt
      })
    } finally {
      pollingRef.current = false
      setCapturing(false)
    }
  }, [instanceIndex, setBitmap])

  useEffect(() => {
    if (live || !autoPoll || !active || instanceIndex === null) return
    // 间隔取 1/PREVIEW_MAX_FPS，再留点余量：抓得更快也只是排队，没有意义。
    const interval = Math.ceil(1000 / PREVIEW_MAX_FPS) + 60
    const timer = setInterval(() => void captureOnce(), interval)
    return () => clearInterval(timer)
  }, [live, autoPoll, active, instanceIndex, captureOnce])

  // ── 手动操控 ────────────────────────────────────────────────────────────

  /** 画布上的鼠标位置 -> 参考坐标。与设备真实分辨率无关，按比例换算即可。 */
  const toRef = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas || !bitmapRef.current) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const rx = (e.clientX - rect.left) / rect.width
    const ry = (e.clientY - rect.top) / rect.height
    return {
      x: Math.round(Math.min(1, Math.max(0, rx)) * REF_WIDTH),
      y: Math.round(Math.min(1, Math.max(0, ry)) * REF_HEIGHT)
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const p = toRef(e)
    if (!p) return
    dragRef.current = { x: p.x, y: p.y, t: Date.now() }
  }

  const onPointerUp = async (e: React.PointerEvent<HTMLCanvasElement>): Promise<void> => {
    if (instanceIndex === null) return
    const start = dragRef.current
    dragRef.current = null
    const end = toRef(e)
    if (!start || !end) return
    const dist = Math.hypot(end.x - start.x, end.y - start.y)
    const held = Date.now() - start.t

    if (mode === 'swipe' || dist > SWIPE_THRESHOLD_REF) {
      const input: ManualInput = {
        instanceIndex,
        at: { x: start.x, y: start.y },
        to: { x: end.x, y: end.y },
        durationMs: Math.max(120, Math.min(1200, held))
      }
      await tryCall('device:swipe', input)
      return
    }
    const input: ManualInput = { instanceIndex, at: { x: end.x, y: end.y } }
    await tryCall('device:tap', input)
    // 点完立刻补一帧，让人看到反馈（直连模式下 worker 自己会推）。
    if (!live) setTimeout(() => void captureOnce(), 350)
  }

  const sendKey = async (): Promise<void> => {
    if (instanceIndex === null) return
    await tryCall('device:key', { instanceIndex, key })
    if (!live) setTimeout(() => void captureOnce(), 350)
  }

  const sendText = async (): Promise<void> => {
    if (instanceIndex === null || !textToSend) return
    const ok = await tryCall('device:text', { instanceIndex, text: textToSend })
    if (ok !== undefined) {
      toast().success('文本已发送')
      setTextToSend('')
    }
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  if (instanceIndex === null) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="先在左侧选一个实例，再来看画面"
        style={{ padding: 40 }}
      />
    )
  }

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap size={8}>
        <SemanticTag tone={live ? 'success' : 'neutral'}>
          {live ? '直连推流' : '轮询抓帧'}
        </SemanticTag>
        <Tooltip
          title={`帧率被 screencap 卡在约 ${PREVIEW_MAX_FPS} 帧/秒，这是模拟器的硬上限，不是面板的问题。`}
        >
          <SemanticTag tone={fps > 0 ? 'info' : 'neutral'}>实测 {fps} 帧/秒</SemanticTag>
        </Tooltip>
        {frameInfo && (
          <span className="wl-micro">
            画面 {frameInfo.deviceWidth}x{frameInfo.deviceHeight}｜预览 {frameInfo.w}x{frameInfo.h}
          </span>
        )}
        {!live && (
          <>
            <Button
              size="small"
              icon={<CameraOutlined />}
              loading={capturing}
              onClick={() => void captureOnce()}
            >
              抓一帧
            </Button>
            <Space size={4}>
              <Switch size="small" checked={autoPoll} onChange={setAutoPoll} />
              <span className="wl-label">自动刷新</span>
            </Space>
          </>
        )}
        <Space size={4}>
          <Switch size="small" checked={showMatches} onChange={setShowMatches} />
          <span className="wl-label">显示匹配框</span>
        </Space>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as 'tap' | 'swipe')}
          options={[
            { value: 'tap', label: '点击' },
            { value: 'swipe', label: '滑动' }
          ]}
        />
      </Space>

      {lastError && (
        <Alert
          type="error"
          showIcon
          closable
          message={lastError}
          onClose={() => setLastError(null)}
        />
      )}

      <div
        style={{
          // ★ 刻意不套 .wl-glass / backdrop-filter：预览本来就只有约 3fps，
          //   再叠一层毛玻璃合成会进一步拖慢。只给纯色底 + 圆角 + 细描边。
          background: 'var(--wl-bg-canvas)',
          border: '1px solid var(--wl-border-subtle)',
          borderRadius: 'var(--wl-radius-md)',
          overflow: 'hidden',
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {frameInfo ? (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerUp={(e) => void onPointerUp(e)}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              cursor: mode === 'swipe' ? 'grab' : 'crosshair',
              touchAction: 'none'
            }}
          />
        ) : (
          <Space direction="vertical" align="center">
            <Typography.Text style={{ color: 'var(--wl-text-tertiary)' }}>
              还没有画面
            </Typography.Text>
            <Button
              icon={<ReloadOutlined />}
              loading={capturing}
              onClick={() => void captureOnce()}
            >
              抓一帧看看
            </Button>
          </Space>
        )}
      </div>

      <Space wrap size={8}>
        <span className="wl-micro">
          <AimOutlined /> 在画面上点一下即为点击；按住拖动即为滑动（超过 {SWIPE_THRESHOLD_REF}{' '}
          参考像素）。
        </span>
      </Space>

      <Space wrap size={8}>
        <Select<AndroidKey>
          size="small"
          value={key}
          style={{ width: 120 }}
          onChange={setKey}
          options={KEY_OPTIONS}
        />
        <Button size="small" onClick={() => void sendKey()}>
          发送按键
        </Button>
        <Input
          size="small"
          style={{ width: 240 }}
          placeholder="输入文本后回车发送"
          value={textToSend}
          onChange={(e) => setTextToSend(e.target.value)}
          onPressEnter={() => void sendText()}
        />
        <Button size="small" onClick={() => void sendText()} disabled={!textToSend}>
          发送文本
        </Button>
        <Tooltip title="中文必须依赖 ADBKeyboard 输入法（adb 自带的 input text 会静默丢掉非 ASCII 字符）。没装的话到「设置」页一键安装。">
          <span className="wl-micro">中文输入需要 ADBKeyboard</span>
        </Tooltip>
      </Space>
    </Space>
  )
}
