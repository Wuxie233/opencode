import { InstanceRuntime } from "../project/instance-runtime"
import { context } from "../project/instance-context"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return InstanceRuntime.provide({ directory }, (ctx) => context.provide(ctx, cb))
}
