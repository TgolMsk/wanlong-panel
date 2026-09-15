/**
 * AI 顾问模块出口（主进程）。
 *
 *   advisor.ts  配置 / 限频 / 两阶段问询 / 记录          —— 只出主意
 *   recover.ts  执行白名单点击 / 复验 / 自学模板 / 记录   —— 只动手
 *   harvest.ts  把关闭按钮裁成模板存进模板库
 *   client.ts   OpenAI 兼容视觉接口 + 视觉能力探测
 *   store.ts    <dataDir>/ai.json
 *   ipc.ts      ai:* 通道（唯一 import electron 的文件，本出口不导出它）
 */

export { AiAdvisor, encodeFrameJpeg, extractJson, parseAdvice } from './advisor'
export type { AiAdvisorDeps, ConsultInput, ConsultResult, ParsedAdvice } from './advisor'
export {
  buildProbeImage,
  chatCompletionsUrl,
  chatVision,
  classifyHttpFailure,
  describeAiFailure,
  probeVision,
  resolveAiFetch,
  setAiFetch
} from './client'
export type { FetchLike, VisionReply, VisionRequest } from './client'
export {
  CLOSE_POPUP_TEMPLATE_ID,
  MAX_HARVESTED_VARIANTS,
  harvestCloseButton,
  isClosePopupTemplateId,
  nextHarvestId
} from './harvest'
export type { HarvestInput, HarvestResult } from './harvest'
export { aiRecoverUnknownScreen, meanAbsDiff } from './recover'
export type { RecoverContext, RecoverIo, RecoverLogger, RecoverResult } from './recover'
export { aiFilePath, loadAiFile, saveAiFile } from './store'

import { AiAdvisor } from './advisor'

let singleton: AiAdvisor | null = null

/** 主进程只有一份顾问。 */
export function getAiAdvisor(): AiAdvisor {
  if (!singleton) singleton = new AiAdvisor()
  return singleton
}
