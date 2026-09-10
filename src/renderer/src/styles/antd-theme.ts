/**
 * 万龙控制面板 · antd 6 主题契约
 * ---------------------------------------------------------------------------
 * 【本文件与 ./tokens.css 是同一套设计令牌的两种消费方式，色值必须逐条对齐。改一处就改另一处。】
 *
 * 为什么不能直接把 `var(--wl-accent)` 塞进 antd 的 token：
 *   antd 6 是 CSS-in-JS，会拿 seed token **算**出一整族派生色（hover/active/bg/border…），
 *   算法里要做颜色空间运算，喂 `var(...)` 字符串会直接算出 NaN 色。
 *   所以这里一律写字面量，靠注释和评审保证与 tokens.css 一致。
 *
 * 提供三样东西：
 *   1. `WL_PALETTE`  —— 字面量调色板。Canvas / Konva / 图表这类吃不了 CSS 变量的地方从这里取色。
 *   2. `getAntdTheme(mode)` —— 给 `<ConfigProvider theme={...}>` 的完整配置（默认暗色）。
 *   3. `applyThemeMode(mode)` —— 把 `data-theme` 写到 <html> 上，让 tokens.css 的亮色分支生效。
 *
 * 刻意没开 antd 的 `cssVar` 模式：它生成的变量前缀会和本工程的 `--wl-*` 命名空间混在一起，
 * 而主题切换是低频手动操作，全量重渲染的代价可以接受。别为了"优化"擅自打开。
 *
 * 工程约束提醒：不引 Tailwind（preflight 会重置 antd 基础样式），布局用 antd 组件 + CSS 变量。
 */

import { theme as antdAlgorithms } from 'antd'
import type { ThemeConfig } from 'antd'

/** 主题模式。默认暗色，这是风格规范定的，不要改默认值。 */
export type WlThemeMode = 'dark' | 'light'

/** localStorage 里存主题模式的键。 */
export const WL_THEME_STORAGE_KEY = 'wl.theme.mode'

/** 默认主题模式。 */
export const WL_DEFAULT_THEME_MODE: WlThemeMode = 'dark'

// ── 调色板 ──────────────────────────────────────────────────────────────────

/** 品牌固定色，两个模式共用，不随主题变。 */
export const WL_BRAND = {
  /** 最暗底 */
  ink: '#050517',
  /** 深靛 */
  indigo: '#18185C',
  /** 靛紫（渐变终点 / 亮色模式强调色） */
  violet: '#4444A3',
  /** 近白 */
  paper: '#FAFAFD',
  /** 深灰蓝文字 */
  slate: '#3D434D',
  /** 薰衣草灰（次要文字） */
  lavender: '#9FA1D4',
  /** 薄荷绿（暗色模式强调色） */
  mint: '#1BEE79'
} as const

export interface WlPalette {
  /** 窗口底色 */
  bgBase: string
  /** 卡片填充（暗色是半透明毛玻璃，亮色是实心白） */
  bgSurface: string
  bgSurfaceHover: string
  /** 浮层底色，必须不透明 */
  bgElevated: string
  /** 比卡片低一层的凹槽 */
  bgSunken: string
  /** Tooltip 这类反差浮层 */
  bgSpotlight: string
  /** 模态遮罩 */
  bgMask: string
  /** 画面预览 / 模板画布的底 */
  bgCanvas: string

  border: string
  borderStrong: string
  borderSubtle: string
  split: string

  text: string
  textHeading: string
  textSecondary: string
  textTertiary: string
  textDisabled: string
  /** 强调色块上的文字色（薄荷绿按钮上是深色字） */
  textOnAccent: string

  accent: string
  accentHover: string
  accentActive: string
  accentSoft: string
  accentSoftHover: string
  accentBorder: string

  success: string
  warning: string
  danger: string
  info: string
  neutral: string

  /** 图表线：靛蓝 → 亮蓝 */
  chartLineFrom: string
  chartLineTo: string
  chartDot: string
  chartGrid: string
  chartAxis: string
  /** 多序列时按序取 */
  series: readonly string[]
}

const DARK: WlPalette = {
  bgBase: '#050517',
  bgSurface: 'rgba(255,255,255,0.055)',
  bgSurfaceHover: 'rgba(255,255,255,0.085)',
  bgElevated: '#141438',
  bgSunken: 'rgba(3,3,16,0.55)',
  bgSpotlight: '#1C1C4A',
  bgMask: 'rgba(5,5,23,0.72)',
  bgCanvas: '#04040F',

  border: 'rgba(255,255,255,0.14)',
  borderStrong: 'rgba(255,255,255,0.24)',
  borderSubtle: 'rgba(255,255,255,0.08)',
  split: 'rgba(255,255,255,0.08)',

  text: '#FAFAFD',
  textHeading: '#FFFFFF',
  textSecondary: '#9FA1D4',
  textTertiary: 'rgba(159,161,212,0.68)',
  textDisabled: 'rgba(159,161,212,0.40)',
  textOnAccent: '#050517',

  accent: '#1BEE79',
  accentHover: '#4DF396',
  accentActive: '#12C862',
  accentSoft: 'rgba(27,238,121,0.14)',
  accentSoftHover: 'rgba(27,238,121,0.20)',
  accentBorder: 'rgba(27,238,121,0.42)',

  success: '#1BEE79',
  warning: '#FFC46B',
  danger: '#FF6B7A',
  info: '#6C8CFF',
  neutral: '#9FA1D4',

  chartLineFrom: '#4444A3',
  chartLineTo: '#58A6FF',
  chartDot: '#58A6FF',
  chartGrid: 'rgba(255,255,255,0.07)',
  chartAxis: 'rgba(159,161,212,0.60)',
  series: ['#58A6FF', '#1BEE79', '#9F7BFF', '#FFC46B', '#FF6B7A', '#4DD7D1']
}

const LIGHT: WlPalette = {
  bgBase: '#FAFAFD',
  bgSurface: '#FFFFFF',
  bgSurfaceHover: '#F6F6FB',
  bgElevated: '#FFFFFF',
  bgSunken: 'rgba(61,67,77,0.05)',
  bgSpotlight: '#18185C',
  bgMask: 'rgba(24,24,92,0.35)',
  bgCanvas: '#1A1A2E',

  border: 'rgba(68,68,163,0.16)',
  borderStrong: 'rgba(68,68,163,0.32)',
  borderSubtle: 'rgba(68,68,163,0.09)',
  split: 'rgba(61,67,77,0.09)',

  text: '#3D434D',
  textHeading: '#1B1F2A',
  textSecondary: '#7A7DB5',
  textTertiary: '#9FA1D4',
  textDisabled: 'rgba(159,161,212,0.62)',
  textOnAccent: '#FAFAFD',

  accent: '#4444A3',
  accentHover: '#5757BD',
  accentActive: '#33337F',
  accentSoft: 'rgba(68,68,163,0.10)',
  accentSoftHover: 'rgba(68,68,163,0.16)',
  accentBorder: 'rgba(68,68,163,0.38)',

  success: '#0FA958',
  warning: '#C07800',
  danger: '#D93A4C',
  info: '#3A5BD9',
  neutral: '#7A7DB5',

  chartLineFrom: '#4444A3',
  chartLineTo: '#2F7DE0',
  chartDot: '#2F7DE0',
  chartGrid: 'rgba(61,67,77,0.08)',
  chartAxis: 'rgba(61,67,77,0.55)',
  series: ['#2F7DE0', '#0FA958', '#7A4BD6', '#C07800', '#D93A4C', '#1A9C96']
}

/** 两套调色板。`WL_PALETTE.dark.accent` 这样取。 */
export const WL_PALETTE: Record<WlThemeMode, WlPalette> = { dark: DARK, light: LIGHT }

/** 取当前模式的调色板。 */
export function wlColors(mode: WlThemeMode = WL_DEFAULT_THEME_MODE): WlPalette {
  return WL_PALETTE[mode] ?? DARK
}

/**
 * Canvas / Konva 专用色。
 * 画面预览的匹配框、模板编辑器的 ROI 框都在 2D 上下文里画，吃不了 CSS 变量，
 * **必须**从这里取，不许在组件里再写十六进制。
 * 两个模式共用一套：画布本身永远是深底，色值按深底调过。
 */
export const WL_CANVAS = {
  /** 画布底色（无画面时） */
  bg: '#04040F',
  /** 命中框描边 */
  matchStroke: '#1BEE79',
  /** 命中框半透明填充 */
  matchFill: 'rgba(27,238,121,0.12)',
  /** 命中标签底 */
  matchLabelBg: 'rgba(27,238,121,0.88)',
  /** 命中标签文字（深色，压在薄荷绿上） */
  matchLabelText: '#050517',
  /** 正在框选的 ROI */
  roiStroke: '#58A6FF',
  roiFill: 'rgba(88,166,255,0.14)',
  roiLabel: '#9F7BFF',
  /** 已保存的模板框 */
  savedStroke: '#9F7BFF',
  savedFill: 'rgba(159,123,255,0.10)',
  savedLabel: '#C3A8FF',
  /** 辅助网格 / 十字线 */
  guide: 'rgba(255,255,255,0.18)',
  /** 画布上的提示文字 */
  hint: 'rgba(159,161,212,0.75)'
} as const

/** 日志四级颜色。LogPane 与其它需要按级别染色的地方共用。 */
export const WL_LOG_COLORS: Record<WlThemeMode, Record<'debug' | 'info' | 'warn' | 'error', string>> =
  {
    dark: { debug: '#9FA1D4', info: '#6C8CFF', warn: '#FFC46B', error: '#FF6B7A' },
    light: { debug: '#7A7DB5', info: '#3A5BD9', warn: '#C07800', error: '#D93A4C' }
  }

// ── 排版 / 尺寸常量（与 tokens.css 的 --wl-fs-* / --wl-radius-* 对齐）──────────

export const WL_TYPO = {
  fontFamily:
    "'Inter', 'Manrope', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
  fontFamilyCode:
    "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, 'PingFang SC', monospace",
  fsDisplay: 34,
  fsTitle: 24,
  fsHeading: 18,
  fsSubtitle: 15,
  fsBody: 13,
  fsLabel: 12,
  fsMicro: 11,
  fsMetric: 28,
  fsMetricSm: 20
} as const

export const WL_RADIUS = {
  xs: 8,
  sm: 12,
  md: 16,
  card: 20,
  lg: 24,
  /** 按钮一律药丸形 */
  pill: 999
} as const

/** 阴影：非常柔和且拉长。字符串与 tokens.css 的 --wl-shadow-* 一致。 */
export const WL_SHADOW: Record<WlThemeMode, { sm: string; md: string; lg: string; accent: string }> =
  {
    dark: {
      sm: '0 8px 24px -12px rgba(5,5,23,0.60)',
      md: '0 18px 44px -18px rgba(5,5,23,0.70)',
      lg: '0 34px 80px -30px rgba(5,5,23,0.78)',
      accent: '0 12px 30px -12px rgba(27,238,121,0.34)'
    },
    light: {
      sm: '0 8px 24px -14px rgba(61,67,77,0.22)',
      md: '0 18px 44px -20px rgba(61,67,77,0.24)',
      lg: '0 34px 80px -32px rgba(61,67,77,0.26)',
      accent: '0 12px 30px -14px rgba(68,68,163,0.28)'
    }
  }

// ── antd 主题配置 ───────────────────────────────────────────────────────────

/**
 * 生成 antd 的 ThemeConfig。
 *
 * 三件关键事：
 *  · **Layout 三层全透明**（headerBg / siderBg / bodyBg），让 body 上的品牌渐变透上来。
 *    antd 默认给的 #001529 深蓝顶栏必须被这里盖掉。
 *  · **Card / Table 用半透明填充**，配合 tokens.css 的 `.wl-glass` 形成毛玻璃卡；
 *    浮层（Modal / Drawer / Dropdown / Select 下拉）走 `bgElevated`，**必须不透明**，
 *    否则弹层背后的表格会透出来糊成一片。
 *  · **`colorTextLightSolid` 设成深墨色**：强调色是高亮薄荷绿，按钮/徽标上的字必须是深色。
 *    亮色模式下强调色变成靛紫，这里自动切回近白。
 */
export function getAntdTheme(mode: WlThemeMode = WL_DEFAULT_THEME_MODE): ThemeConfig {
  const c = wlColors(mode)
  const shadow = WL_SHADOW[mode] ?? WL_SHADOW.dark
  const isDark = mode === 'dark'

  return {
    algorithm: isDark ? antdAlgorithms.darkAlgorithm : antdAlgorithms.defaultAlgorithm,

    token: {
      // 品牌
      colorPrimary: c.accent,
      colorLink: c.info,
      colorInfo: c.info,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.danger,

      // 底色 / 文字基准（seed，派生色由算法自己算）
      colorBgBase: c.bgBase,
      colorTextBase: c.text,

      // 关键覆盖：让容器透出 body 渐变
      colorBgLayout: 'transparent',
      colorBgContainer: c.bgSurface,
      colorBgElevated: c.bgElevated,
      colorBgSpotlight: c.bgSpotlight,
      colorBgMask: c.bgMask,

      colorBorder: c.border,
      colorBorderSecondary: c.borderSubtle,
      colorSplit: c.split,

      colorText: c.text,
      colorTextHeading: c.textHeading,
      colorTextSecondary: c.textSecondary,
      colorTextTertiary: c.textTertiary,
      colorTextQuaternary: c.textDisabled,
      colorTextDescription: c.textSecondary,
      colorTextPlaceholder: c.textDisabled,
      colorTextDisabled: c.textDisabled,
      colorTextLabel: c.textSecondary,
      colorIcon: c.textSecondary,
      colorIconHover: c.text,
      /** 强调色块上的文字 */
      colorTextLightSolid: c.textOnAccent,

      // 排版
      fontFamily: WL_TYPO.fontFamily,
      fontFamilyCode: WL_TYPO.fontFamilyCode,
      fontSize: WL_TYPO.fsBody,
      fontSizeSM: WL_TYPO.fsLabel,
      fontSizeLG: WL_TYPO.fsSubtitle,
      fontSizeXL: WL_TYPO.fsHeading,
      fontSizeHeading1: WL_TYPO.fsDisplay,
      fontSizeHeading2: WL_TYPO.fsTitle,
      fontSizeHeading3: WL_TYPO.fsHeading,
      fontSizeHeading4: WL_TYPO.fsSubtitle,
      fontSizeHeading5: WL_TYPO.fsBody,
      // 标题"超大号但中等字重"
      fontWeightStrong: 500,
      lineHeight: 1.55,
      lineHeightHeading1: 1.08,
      lineHeightHeading2: 1.16,
      lineHeightHeading3: 1.28,

      // 形状
      borderRadius: WL_RADIUS.sm,
      borderRadiusXS: 6,
      borderRadiusSM: WL_RADIUS.xs,
      borderRadiusLG: WL_RADIUS.card,
      lineWidth: 1,
      wireframe: false,

      // 控件高度
      controlHeight: 34,
      controlHeightSM: 26,
      controlHeightLG: 42,
      controlOutlineWidth: 2,
      controlItemBgHover: c.bgSurfaceHover,
      controlItemBgActive: c.accentSoft,
      controlItemBgActiveHover: c.accentSoftHover,

      // 阴影：柔和且拉长
      boxShadow: shadow.sm,
      boxShadowSecondary: shadow.md,
      boxShadowTertiary: shadow.sm,

      // 动效
      motionDurationFast: '0.12s',
      motionDurationMid: '0.2s',
      motionDurationSlow: '0.32s',
      motionEaseInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
      motionEaseOut: 'cubic-bezier(0.22, 0.61, 0.36, 1)',

      // 间距（面板信息密集，比默认略紧）
      padding: 16,
      paddingLG: 20,
      paddingSM: 12,
      paddingXS: 8,
      margin: 16,
      marginSM: 12,
      marginXS: 8
    },

    components: {
      // ── 骨架：三层全透明，让 body 渐变透上来 ────────────────────────────
      Layout: {
        headerBg: 'transparent',
        siderBg: 'transparent',
        lightSiderBg: 'transparent',
        bodyBg: 'transparent',
        footerBg: 'transparent',
        triggerBg: c.bgElevated,
        triggerColor: c.text,
        headerHeight: 60,
        headerPadding: '0 20px',
        headerColor: c.text
      },

      // ── 左侧导航：无边框、圆角药丸项、选中用强调弱底 ─────────────────────
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        popupBg: c.bgElevated,
        itemColor: c.textSecondary,
        itemHoverColor: c.text,
        itemHoverBg: c.bgSurfaceHover,
        itemSelectedColor: c.accent,
        itemSelectedBg: c.accentSoft,
        itemActiveBg: c.accentSoftHover,
        itemDisabledColor: c.textDisabled,
        itemBorderRadius: WL_RADIUS.md,
        subMenuItemBorderRadius: WL_RADIUS.md,
        itemHeight: 42,
        itemMarginInline: 10,
        itemMarginBlock: 4,
        itemPaddingInline: 14,
        iconSize: 16,
        iconMarginInlineEnd: 12,
        collapsedIconSize: 18,
        groupTitleColor: c.textTertiary,
        groupTitleFontSize: WL_TYPO.fsLabel,
        // 去掉默认的选中右侧竖条，选中态只靠弱底 + 字色表达
        activeBarWidth: 0,
        activeBarHeight: 0,
        activeBarBorderWidth: 0,
        darkItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
        darkItemColor: c.textSecondary,
        darkItemHoverBg: c.bgSurfaceHover,
        darkItemSelectedBg: c.accentSoft,
        darkItemSelectedColor: c.accent,
        darkPopupBg: c.bgElevated
      },

      // ── 卡片：毛玻璃 + 大圆角 + 柔长阴影 ───────────────────────────────
      Card: {
        colorBgContainer: c.bgSurface,
        colorBorderSecondary: c.borderSubtle,
        headerBg: 'transparent',
        headerFontSize: WL_TYPO.fsSubtitle,
        headerFontSizeSM: WL_TYPO.fsBody,
        headerHeight: 52,
        headerHeightSM: 42,
        headerPadding: 20,
        headerPaddingSM: 14,
        bodyPadding: 20,
        bodyPaddingSM: 14,
        borderRadiusLG: WL_RADIUS.card,
        extraColor: c.textSecondary,
        boxShadowTertiary: shadow.sm
      },

      // ── 按钮：主按钮薄荷绿药丸 + 深色字；次按钮描边/纯文字 ────────────────
      Button: {
        borderRadius: WL_RADIUS.pill,
        borderRadiusLG: WL_RADIUS.pill,
        borderRadiusSM: WL_RADIUS.pill,
        fontWeight: 500,
        contentFontSize: WL_TYPO.fsBody,
        contentFontSizeSM: WL_TYPO.fsLabel,
        paddingInline: 18,
        paddingInlineSM: 12,
        paddingInlineLG: 24,
        primaryColor: c.textOnAccent,
        solidTextColor: c.textOnAccent,
        dangerColor: c.textOnAccent,
        primaryShadow: shadow.accent,
        defaultShadow: 'none',
        dangerShadow: 'none',
        defaultBg: 'transparent',
        defaultColor: c.text,
        defaultBorderColor: c.border,
        defaultHoverBg: c.bgSurfaceHover,
        defaultHoverColor: c.accent,
        defaultHoverBorderColor: c.accentBorder,
        defaultActiveBg: c.accentSoft,
        defaultActiveColor: c.accent,
        defaultActiveBorderColor: c.accent,
        defaultBgDisabled: 'transparent',
        borderColorDisabled: c.borderSubtle,
        textHoverBg: c.bgSurfaceHover,
        linkHoverBg: 'transparent',
        ghostBg: 'transparent'
      },

      // ── 表格：无表头底、细行线、悬停轻提亮 ──────────────────────────────
      Table: {
        colorBgContainer: 'transparent',
        headerBg: 'transparent',
        headerColor: c.textSecondary,
        headerSplitColor: 'transparent',
        headerBorderRadius: 0,
        borderColor: c.split,
        rowHoverBg: c.bgSurfaceHover,
        rowSelectedBg: c.accentSoft,
        rowSelectedHoverBg: c.accentSoftHover,
        rowExpandedBg: c.bgSunken,
        footerBg: 'transparent',
        footerColor: c.textSecondary,
        cellFontSize: WL_TYPO.fsBody,
        cellFontSizeSM: WL_TYPO.fsLabel,
        cellPaddingBlock: 10,
        cellPaddingInline: 12,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 10,
        expandIconBg: 'transparent',
        filterDropdownBg: c.bgElevated,
        filterDropdownMenuBg: c.bgElevated,
        stickyScrollBarBg: c.border,
        stickyScrollBarBorderRadius: WL_RADIUS.pill
      },

      // ── 输入类：半透明填充 + 中圆角 ────────────────────────────────────
      Input: {
        colorBgContainer: c.bgSurface,
        colorBorder: c.border,
        borderRadius: WL_RADIUS.sm,
        borderRadiusLG: WL_RADIUS.sm,
        borderRadiusSM: WL_RADIUS.xs,
        colorTextPlaceholder: c.textDisabled,
        paddingInline: 12
      },
      InputNumber: {
        colorBgContainer: c.bgSurface,
        colorBorder: c.border,
        borderRadius: WL_RADIUS.sm,
        borderRadiusLG: WL_RADIUS.sm,
        borderRadiusSM: WL_RADIUS.xs
      },
      Select: {
        colorBgContainer: c.bgSurface,
        colorBgElevated: c.bgElevated,
        colorBorder: c.border,
        borderRadius: WL_RADIUS.sm,
        borderRadiusLG: WL_RADIUS.sm,
        borderRadiusSM: WL_RADIUS.xs,
        controlItemBgActive: c.accentSoft,
        controlItemBgHover: c.bgSurfaceHover,
        boxShadowSecondary: shadow.md
      },
      DatePicker: {
        colorBgContainer: c.bgSurface,
        colorBgElevated: c.bgElevated,
        colorBorder: c.border,
        borderRadius: WL_RADIUS.sm
      },
      Form: {
        labelColor: c.textSecondary,
        labelFontSize: WL_TYPO.fsLabel,
        itemMarginBottom: 16,
        labelRequiredMarkColor: c.danger
      },

      // ── 分段控件 / 页签 ────────────────────────────────────────────────
      Segmented: {
        trackBg: c.bgSurface,
        trackPadding: 3,
        itemColor: c.textSecondary,
        itemHoverColor: c.text,
        itemHoverBg: c.bgSurfaceHover,
        itemActiveBg: c.accentSoftHover,
        itemSelectedBg: c.accentSoft,
        itemSelectedColor: c.accent,
        borderRadius: WL_RADIUS.pill,
        borderRadiusSM: WL_RADIUS.pill,
        borderRadiusLG: WL_RADIUS.pill
      },
      Tabs: {
        itemColor: c.textSecondary,
        itemHoverColor: c.text,
        itemSelectedColor: c.text,
        itemActiveColor: c.accent,
        inkBarColor: c.accent,
        titleFontSize: WL_TYPO.fsBody,
        titleFontSizeSM: WL_TYPO.fsLabel,
        horizontalItemGutter: 20,
        horizontalItemPadding: '8px 0',
        horizontalMargin: '0 0 12px 0',
        cardBg: c.bgSurface
      },

      // ── 状态展示 ──────────────────────────────────────────────────────
      Tag: {
        defaultBg: c.bgSurface,
        defaultColor: c.textSecondary,
        solidTextColor: c.textOnAccent,
        borderRadiusSM: WL_RADIUS.pill,
        fontSizeSM: WL_TYPO.fsLabel,
        colorBorder: c.borderSubtle
      },
      Badge: {
        colorBgContainer: c.bgBase,
        textFontSize: WL_TYPO.fsMicro,
        textFontSizeSM: WL_TYPO.fsMicro
      },
      Alert: {
        borderRadius: WL_RADIUS.md,
        defaultPadding: '10px 14px',
        withDescriptionPadding: '14px 16px',
        colorInfoBg: c.accentSoft,
        colorInfoBorder: c.accentBorder,
        colorSuccessBg: 'transparent',
        colorWarningBg: 'transparent',
        colorErrorBg: 'transparent'
      },
      Progress: {
        defaultColor: c.accent,
        remainingColor: c.bgSurface,
        circleTextColor: c.text,
        lineBorderRadius: WL_RADIUS.pill
      },
      Statistic: {
        titleFontSize: WL_TYPO.fsLabel,
        contentFontSize: WL_TYPO.fsMetric,
        colorTextDescription: c.textSecondary
      },
      Descriptions: {
        labelColor: c.textSecondary,
        titleColor: c.textHeading,
        contentColor: c.text,
        labelBg: 'transparent',
        extraColor: c.textSecondary
      },
      Divider: {
        colorSplit: c.split,
        colorTextHeading: c.textSecondary
      },
      Switch: {
        handleBg: c.bgBase,
        trackHeight: 20,
        trackMinWidth: 40
      },
      Slider: {
        railBg: c.bgSurface,
        railHoverBg: c.bgSurfaceHover,
        trackBg: c.accent,
        trackHoverBg: c.accentHover,
        handleColor: c.accent,
        handleActiveColor: c.accentHover,
        dotBorderColor: c.border
      },

      // ── 浮层：一律不透明 + 大圆角 + 柔长阴影 ─────────────────────────────
      Modal: {
        contentBg: c.bgElevated,
        headerBg: 'transparent',
        footerBg: 'transparent',
        titleColor: c.textHeading,
        titleFontSize: WL_TYPO.fsHeading,
        borderRadiusLG: WL_RADIUS.lg,
        boxShadow: shadow.lg,
        paddingContentHorizontalLG: 24
      },
      Drawer: {
        colorBgElevated: c.bgElevated,
        colorSplit: c.split,
        borderRadiusLG: WL_RADIUS.lg,
        boxShadow: shadow.lg
      },
      Popover: {
        colorBgElevated: c.bgElevated,
        colorText: c.text,
        borderRadiusLG: WL_RADIUS.md,
        boxShadowSecondary: shadow.md
      },
      Popconfirm: {
        colorBgElevated: c.bgElevated,
        borderRadiusLG: WL_RADIUS.md
      },
      Dropdown: {
        colorBgElevated: c.bgElevated,
        borderRadiusLG: WL_RADIUS.md,
        controlItemBgHover: c.bgSurfaceHover,
        boxShadowSecondary: shadow.md
      },
      Tooltip: {
        colorBgSpotlight: c.bgSpotlight,
        colorTextLightSolid: isDark ? c.text : '#FAFAFD',
        borderRadius: WL_RADIUS.xs,
        borderRadiusOuter: WL_RADIUS.xs
      },
      Message: {
        contentBg: c.bgElevated,
        contentPadding: '10px 16px',
        borderRadiusLG: WL_RADIUS.md,
        boxShadow: shadow.md
      },
      Notification: {
        colorBgElevated: c.bgElevated,
        borderRadiusLG: WL_RADIUS.md,
        boxShadow: shadow.md
      },
      List: {
        colorBgContainer: 'transparent',
        headerBg: 'transparent',
        footerBg: 'transparent',
        itemPadding: '10px 0'
      },
      Collapse: {
        headerBg: 'transparent',
        contentBg: 'transparent',
        borderRadiusLG: WL_RADIUS.md,
        headerPadding: '10px 14px',
        contentPadding: '12px 14px'
      },
      Empty: {
        colorTextDescription: c.textTertiary
      },
      Spin: {
        colorPrimary: c.accent
      },
      Typography: {
        colorText: c.text,
        colorTextHeading: c.textHeading,
        colorTextDescription: c.textSecondary,
        titleMarginBottom: '0.4em',
        titleMarginTop: '0'
      }
    }
  }
}

/** 暗色主题（默认）。 */
export const wlDarkTheme: ThemeConfig = getAntdTheme('dark')

/** 亮色主题。 */
export const wlLightTheme: ThemeConfig = getAntdTheme('light')

// ── 主题模式的读写 ──────────────────────────────────────────────────────────

/**
 * 把主题模式写到 <html data-theme> 上（tokens.css 的亮色分支靠它生效），
 * 顺手落盘 localStorage。渲染进程是 sandbox 下的普通网页环境，localStorage 可用，
 * 但仍然包一层 try/catch —— 隐私模式或存储被禁时不能让面板起不来。
 */
export function applyThemeMode(mode: WlThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode
  try {
    window.localStorage.setItem(WL_THEME_STORAGE_KEY, mode)
  } catch {
    // 存不下就算了，下次启动回到默认暗色，不影响使用
  }
}

/** 读回上次选的主题模式，读不到就用默认暗色。 */
export function readStoredThemeMode(): WlThemeMode {
  try {
    const v = window.localStorage.getItem(WL_THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // 忽略
  }
  return WL_DEFAULT_THEME_MODE
}
