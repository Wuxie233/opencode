import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createSessionRetryAction } from "./session-retry-action"

function response(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("session retry action", () => {
  test("keeps a successful retry latched until authoritative status exits retry", async () => {
    let resolveRequest = (_response: Response) => {}
    let calls = 0
    let request: Request | undefined
    const requested = Promise.withResolvers<void>()
    const fetcher: typeof fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1
        request = input instanceof Request ? input : new Request(input, init)
        requested.resolve()
        return new Promise<Response>((resolve) => {
          resolveRequest = resolve
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      throwOnError: true,
      fetch: fetcher,
    })

    await createRoot(async (dispose) => {
      const action = createSessionRetryAction({
        request: (sessionID) => client.session.retry({ sessionID }).then((result) => result.data ?? false),
        onError: () => {},
      })
      action.updateStatus(true)

      const pending = action.run("ses_retry")
      const inFlightDuplicate = action.run("ses_retry")
      await requested.promise

      expect(calls).toBe(1)
      expect(action.pending).toBe(true)
      expect(inFlightDuplicate).toBeUndefined()
      expect(request?.method).toBe("POST")
      expect(new URL(request?.url ?? "http://invalid").pathname).toBe("/session/ses_retry/retry")

      resolveRequest(response(200, "true"))
      await pending

      const successfulDuplicate = action.run("ses_retry")

      expect(calls).toBe(1)
      expect(action.pending).toBe(true)
      expect(successfulDuplicate).toBeUndefined()

      action.updateStatus(false)

      expect(action.pending).toBe(false)
      dispose()
    })
  })

  test("reports a false response and restores the action", async () => {
    const errors: unknown[] = []
    let calls = 0
    const fetcher: typeof fetch = Object.assign(
      () => {
        calls += 1
        return Promise.resolve(response(200, "false"))
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      throwOnError: true,
      fetch: fetcher,
    })

    await createRoot(async (dispose) => {
      const action = createSessionRetryAction({
        request: (sessionID) => client.session.retry({ sessionID }).then((result) => result.data ?? false),
        onError: (error) => errors.push(error),
      })
      action.updateStatus(true)

      await action.run("ses_retry")

      expect(errors).toEqual([false])
      expect(action.pending).toBe(false)

      await action.run("ses_retry")

      expect(calls).toBe(2)
      dispose()
    })
  })

  test("reports failure and restores the action", async () => {
    const errors: unknown[] = []
    let calls = 0
    const fetcher: typeof fetch = Object.assign(
      () => {
        calls += 1
        return Promise.resolve(response(500, JSON.stringify({ data: { message: "retry failed" } })))
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      throwOnError: true,
      fetch: fetcher,
    })

    await createRoot(async (dispose) => {
      const action = createSessionRetryAction({
        request: (sessionID) => client.session.retry({ sessionID }).then((result) => result.data ?? false),
        onError: (error) => errors.push(error),
      })
      action.updateStatus(true)

      await action.run("ses_retry")

      expect(errors).toHaveLength(1)
      expect(action.pending).toBe(false)

      await action.run("ses_retry")

      expect(calls).toBe(2)
      dispose()
    })
  })
})
