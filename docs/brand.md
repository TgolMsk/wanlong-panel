# 万龙面板品牌资源

使用内置 imagegen 生成龙形 Logo；以靛蓝底色和薄荷绿龙形延续面板配色。生成时间：2026-09-15。

## 文件

- `resources/brand/logo-source.png`：生成原图，保留透明通道。
- `resources/brand/app-icon.png`：1024×1024 主图标。
- `resources/brand/app-icon.ico`：Windows 图标，含 16、24、32、48、64、128、256 像素尺寸。
- `resources/brand/app-icon.icns`：macOS 图标，含 16～1024 像素尺寸。
- `src/renderer/src/assets/brand/app-icon.png`：256×256 面板侧栏与页面图标。

运行 `npm run icons:app` 从原图重新生成上述派生文件。转换仅调整尺寸和容器格式，不重新绘制图形。
窗口通过 `resourcesDir()` 加载图标，安装包通过 `electron-builder.yml` 引用 ICO / ICNS。

## 最终生成提示词

```text
Use case: logo-brand. Create a production-ready desktop application icon for 万龙面板 (Wanlong Panel), an emulator fleet and automation dashboard. One single square 1024px app icon, not a presentation board or mockup. A bold minimalist geometric dragon head integrated with a subtle W-shaped silhouette, facing right, distinctive graceful horns and one simple eye, built from broad clean mint-green shapes. Existing app palette: midnight indigo #050517 and #18185c background, mint green #1bee79 mark, restrained lavender highlights. Center the mark at about 65 percent of canvas width with generous even breathing room. A softly rounded square dark indigo tile, truly transparent outside its rounded corners. Crisp vector-like contours, almost flat design with only subtle tonal depth, legible at 24px. Premium calm utility software identity. No text, letters, badges, frames, tiny scales, fine circuit lines, mascot body, glows, elaborate illustration, copyrighted game insignia or extra objects.
```

## 导航结构

`src/renderer/src/navigation.tsx` 统一定义五个主入口及十个原有页面的映射。
页面 key 保持不变，原有 localStorage 页面记忆与程序内跳转继续使用；切换主入口时恢复该组本次会话里最近打开的页面。
`styles/shell.css` 只添加布局样式，沿用已有 `--wl-*` 设计令牌。
