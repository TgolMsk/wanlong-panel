# 万龙控制面板

MuMu 模拟器多实例控制面板 —— 截图 + 模板匹配的多账号自动化地基。

## 快速开始

```bash
npm install
npm run approve      # npm 11 的 install-scripts 白名单，首次必须批准
npm run dev          # 起面板
```

如果报 `Electron failed to install correctly`：`node node_modules/electron/install.js`

## 文档

- `ARCHITECTURE.md` —— 整体架构、数据流、模块职责、新增游戏脚本的扩展指引
- `CLAUDE.md` —— adb/mumutool 路径、设备参数、常用命令、项目约定、性能参考

## 契约层

`src/shared/` 是四端（主进程 / utilityProcess / preload / 渲染进程）共用的唯一事实来源。
改这里的类型会让所有依赖方同时编译报错 —— 这正是它存在的目的。
