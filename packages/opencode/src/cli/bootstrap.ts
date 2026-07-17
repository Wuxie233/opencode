import { InstanceRuntime } from "../project/instance-runtime"
import { context } from "../project/instance-context"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  let current: Parameters<typeof context.provide>[0] | undefined
  try {
    return await InstanceRuntime.provide({ directory }, (ctx) => {
      current = ctx
      return context.provide(ctx, cb)
    })
  } finally {
    if (current) await InstanceRuntime.disposeInstance(current)
  }
}
