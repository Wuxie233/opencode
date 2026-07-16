import { createSignal, onCleanup, onMount } from "solid-js"
import { Markdown } from "./markdown"

const END = '\n\n<div data-wave10-end="true">Wave 10 End</div>\n'
const INTRO = "# Wave 10 Heading\n\n"
const FILL = `A stable paragraph includes [documentation](https://example.com/docs), \`inline-code\`, and enough prose to exercise parsing and DOM construction without an artificial single-token input.

\`\`\`ts
const wave = "ten"
const workload = wave.length
\`\`\`

## Stable section

- first item
- second item

`

type BenchmarkSnapshot = {
  bytes: number
  elapsed: number
  heartbeatCount: number
  maxHeartbeatGap: number
  longestTask: number
  longTaskCount: number
  blocks: number
  ready: boolean
  replacement: boolean
}

declare global {
  interface Window {
    __markdownPerformance?: {
      run: (bytes: number) => void
      html: () => void
      replace: () => void
      stream: () => void
      snapshot: () => BenchmarkSnapshot
    }
  }
}

function payload(bytes: number) {
  const room = Math.max(0, bytes - INTRO.length - END.length)
  const body = FILL.repeat(Math.ceil(room / FILL.length)).slice(0, room)
  return `${INTRO}${body}${END}`
}

export function MarkdownPerformance() {
  const [text, setText] = createSignal("")
  const [key, setKey] = createSignal("idle")
  const [streaming, setStreaming] = createSignal(false)
  let root: HTMLDivElement | undefined
  let bytes = 0
  let started = 0
  let heartbeatCount = 0
  let maxHeartbeatGap = 0
  let longestTask = 0
  let longTaskCount = 0
  let previousHeartbeat = performance.now()
  let run = 0

  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxHeartbeatGap = Math.max(maxHeartbeatGap, now - previousHeartbeat)
    previousHeartbeat = now
    heartbeatCount++
  }, 16)
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longestTask = Math.max(longestTask, entry.duration)
      longTaskCount++
    }
  })
  observer.observe({ type: "longtask", buffered: true })

  const startValue = (value: string) => {
    bytes = value.length
    heartbeatCount = 0
    maxHeartbeatGap = 0
    longestTask = 0
    longTaskCount = 0
    previousHeartbeat = performance.now()
    started = performance.now()
    setStreaming(false)
    setKey(`run-${++run}`)
    setText(value)
  }

  const start = (size: number) => startValue(payload(size))

  const html = () => startValue(`<script>\n${"x".repeat(70 * 1024)}\n\nVISIBLE_INSIDE_SCRIPT\n</script>\n\nAfter${END}`)

  const replace = () => {
    bytes = 0
    started = performance.now()
    setStreaming(false)
    setKey(`replacement-${++run}`)
    setText("# Replacement\n\nReplacement won.")
  }

  const stream = () => {
    bytes = 0
    started = performance.now()
    setKey(`stream-${++run}`)
    setStreaming(true)
    setText("# Streaming\n\nBefore\n\n```ts\nconst wave = ")
    setTimeout(() => {
      setText('# Streaming\n\nBefore\n\n```ts\nconst wave = "ten"\n```\n\nAfter')
      setStreaming(false)
    }, 50)
  }

  const snapshot = (): BenchmarkSnapshot => ({
    bytes,
    elapsed: started ? performance.now() - started : 0,
    heartbeatCount,
    maxHeartbeatGap,
    longestTask,
    longTaskCount,
    blocks: root?.querySelector('[data-component="markdown"]')?.children.length ?? 0,
    ready: !!root?.querySelector("[data-wave10-end]"),
    replacement: root?.querySelector("h1")?.textContent === "Replacement",
  })

  onMount(() => {
    window.__markdownPerformance = { run: start, html, replace, stream, snapshot }
  })
  onCleanup(() => {
    clearInterval(heartbeat)
    observer.disconnect()
    delete window.__markdownPerformance
  })

  return (
    <div ref={(value) => (root = value)} style={{ "max-width": "100%" }}>
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "margin-bottom": "8px" }}>
        <button type="button" onClick={() => start(100 * 1024)}>
          Render 100 KiB
        </button>
        <button type="button" onClick={() => start(1024 * 1024)}>
          Render 1 MiB
        </button>
        <button type="button" onClick={() => start(10 * 1024 * 1024)}>
          Render 10 MiB
        </button>
        <button type="button" onClick={html}>
          Render HTML
        </button>
        <button type="button" onClick={replace}>
          Replace
        </button>
        <button type="button" onClick={stream}>
          Stream
        </button>
      </div>
      <Markdown text={text()} cacheKey={key()} streaming={streaming()} />
    </div>
  )
}
