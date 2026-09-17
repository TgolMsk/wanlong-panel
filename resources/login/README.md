# 登录素材与适配记录

适配对象：`com.lilithgames.samo.android.cn`，游戏 1.0.52.18，MuMu 6.6.4 / Android 15，2026-09-15。
原始帧为 2560×1440 无损 PNG。手机号和验证码页面采用原生 SDK，游戏内部采用 Unity。

## 可复用控件

以下 id 均以 `com.lilithgames.samo.android.cn:id/` 为前缀。坐标仅作本次素材索引，运行时必须重新读取节点 bounds。

| 页面 | 控件 id | 语义／验证条件 |
| --- | --- | --- |
| 手机号 | `phoneEditText` | 格式化显示的手机号；输入后去除空格，与请求号码核对 |
| 手机号 | `agreementCheckBox` | 检查 `checked`；用户明确确认协议后才能勾选 |
| 手机号 | `submitButton` | 文案必须是「登录」；点击后向该号码发送验证码 |
| 验证码 | `digitsInput` | 六格自定义容器，非 EditText；点第一格并输入数字，满六位自动校验 |
| 验证码 | `messageText` | 短信接收提示；对外仅返回掩码号码 |
| 验证码 | `resendButton` | 倒计时期间禁用重发；结束后检查重发文案和 enabled |
| 游戏 | `unitySurfaceView` | 仅说明登录窗口关闭；仍需游戏模板检查是否已进入主界面 |

复用文件 `fixtures/phone.xml`、`fixtures/code.xml`、`fixtures/game.xml` 来自实机 UIAutomator 输出，手机号已替换为测试数据，供 `scripts/login-offline-check.ts` 回放。解析器过滤其它应用、重复 id 和无效 bounds。

## 本地原始素材索引

素材保存在开发数据目录 `.wl-data/login-research/`，完整截图包含账号信息，保持本地，不随公开仓库分发。

| 文件 | 阶段 |
| --- | --- |
| `01-phone-empty.png` | 初始手机号弹窗 |
| `02-phone-entered.png`、`02-phone.xml` | 手机号格式、协议控件和提交按钮 |
| `03-code-awaiting.png`、`03-code.xml` | 验证码六格输入和重发倒计时 |
| `04-after-code.png`、`04-after-code.xml` | 验证通过，返回 Unity 加载页面 |
| `05-after-loading.png` | 首次进入后的预下载公告 |
| `06-event-popup.png` | 活动公告及关闭入口 |
| `07-after-popup.png` | 已进入城内，主界面检查正样本 |
| `08-profile.png`、`09-settings.png` | 后续扩展选区／角色管理的入口参考，本轮不自动操作 |
| `10-in-game-panel.png`、`11-check-current.png` | 已进入游戏后的其它面板／剧情，主界面检查负样本 |

后续版本变化时，重新录制相同阶段，更新 SDK 选择器与对应回放测试；Unity 部分按模板库制作流程裁剪专用无损模板。不要直接将完整登录截图用作模板，也不要让每个 API 调用方各自维护一套屏幕坐标。
