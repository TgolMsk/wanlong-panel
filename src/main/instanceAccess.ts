import { AppError } from '@shared/errors'

/** 主进程统一占用表。必须在第一次 await 前取得，持有至所有设备操作结束。 */
export class InstanceAccess {
  private readonly owners = new Map<number, { label: string }>()

  acquire(index: number, label: string): () => void {
    const owner = this.owners.get(index)
    if (owner) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `实例 ${index} 正在${owner.label}，请等待结束后再试。`,
        {
          instanceIndex: index,
          owner: owner.label
        }
      )
    }
    const token = { label }
    this.owners.set(index, token)
    return () => {
      if (this.owners.get(index) === token) this.owners.delete(index)
    }
  }

  /**
   * 现在有没有实例被占着；有就返回一句中文说明（「实例 0 正在运行脚本」）。
   *
   * 这张表是**所有**会动设备的链路的交汇点（脚本执行、采集采样/派遣、账号登录、开机配置），
   * 所以「现在能不能退出应用去装更新」问它一个就够，不用去各个模块挨个打听。
   */
  anyBusy(): string | null {
    for (const [index, owner] of this.owners) {
      return `实例 ${index} 正在${owner.label}。`
    }
    return null
  }
}

export const instanceAccess = new InstanceAccess()
