const batchBytes = 32 * 1024
const batchItems = 128

type ProgressiveRenderInput<T extends { raw: string }, R> = {
  items: readonly T[]
  render: (item: T, index: number) => Promise<R>
  publish: (items: R[]) => void
  active: () => boolean
}

export async function renderProgressively<T extends { raw: string }, R>(input: ProgressiveRenderInput<T, R>) {
  const rendered: R[] = []
  let published: R[] = []
  let index = 0
  while (index < input.items.length && input.active()) {
    const start = index
    let bytes = 0
    while (index < input.items.length && index - start < batchItems) {
      const item = input.items[index]
      if (!item) break
      if (index > start && bytes + item.raw.length > batchBytes) break
      bytes += item.raw.length
      index++
    }
    const batch = await Promise.all(input.items.slice(start, index).map(input.render))
    if (!input.active()) return published
    rendered.push(...batch)
    published = rendered.slice()
    input.publish(published)
    if (index < input.items.length)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
  }
  return published
}
