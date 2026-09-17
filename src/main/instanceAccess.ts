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
}

export const instanceAccess = new InstanceAccess()
