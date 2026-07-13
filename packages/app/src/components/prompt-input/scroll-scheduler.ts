export function createScrollScheduler(input: {
  measure: () => void
  schedule?: (callback: FrameRequestCallback) => number
  cancel?: (id: number) => void
}) {
  const schedule = input.schedule ?? requestAnimationFrame
  const cancel = input.cancel ?? cancelAnimationFrame
  let frame: number | undefined
  let remaining = 0

  const run = () => {
    frame = undefined
    if (remaining === 0) return
    remaining -= 1
    input.measure()
    if (remaining > 0) frame = schedule(run)
  }

  const queue = (count = 2) => {
    remaining = Math.max(remaining, count)
    if (frame !== undefined) return
    frame = schedule(run)
  }

  const stop = () => {
    remaining = 0
    if (frame === undefined) return
    cancel(frame)
    frame = undefined
  }

  return { queue, stop }
}
