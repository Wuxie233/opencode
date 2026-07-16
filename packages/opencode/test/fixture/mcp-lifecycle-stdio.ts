import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, String(process.pid))
  await new Promise(() => {})
}

if (process.argv.includes("--hang-child")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  await Bun.write(pidFile, `${process.pid}\n${child.pid}`)
  await new Promise(() => {})
}

const exitsWithChild = process.argv.includes("--exit-parent-child")
const child = exitsWithChild
  ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
  : undefined
if (child) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, `${process.pid}\n${child.pid}`)
}

const orphanParent = process.argv.includes("--orphan-parent")
if (orphanParent) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  const releaseFile = process.env.MCP_LIFECYCLE_RELEASE_FILE
  if (!pidFile || !releaseFile) throw new Error("MCP_LIFECYCLE_PID_FILE and MCP_LIFECYCLE_RELEASE_FILE are required")
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  await Bun.write(pidFile, `${process.pid}\n${child.pid}`)
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => {
  if (exitsWithChild) setTimeout(() => process.exit(0), 50)
  return Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  })
})

await server.connect(new StdioServerTransport())

if (orphanParent) {
  const releaseFile = process.env.MCP_LIFECYCLE_RELEASE_FILE
  if (!releaseFile) throw new Error("MCP_LIFECYCLE_RELEASE_FILE is required")
  while (!(await Bun.file(releaseFile).exists())) await Bun.sleep(10)
  process.exit(0)
}
