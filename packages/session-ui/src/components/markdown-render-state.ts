import { MarkdownWorkerDisposedError, MarkdownWorkerSupersededError } from "./markdown-worker-protocol"

type RenderSettlement<T> = {
  render: () => Promise<T>
  active: () => boolean
  fallback: (error: unknown) => T
}

export async function settleMarkdownRender<T>(input: RenderSettlement<T>) {
  try {
    const result = await input.render()
    if (!input.active()) return
    return result
  } catch (error) {
    if (!input.active()) return
    if (error instanceof MarkdownWorkerDisposedError || error instanceof MarkdownWorkerSupersededError) return
    return input.fallback(error)
  }
}

export function pendingMarkdownResult<T>(text: string, count: number) {
  return count === 0 ? { text, blocks: [] as T[] } : undefined
}
