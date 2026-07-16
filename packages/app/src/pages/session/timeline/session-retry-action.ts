import { createStore } from "solid-js/store"

export function createSessionRetryAction(input: {
  readonly request: (sessionID: string) => Promise<boolean>
  readonly onError: (error: unknown) => void
}) {
  const [state, setState] = createStore({ pending: false, awaitingStatus: false, retrying: false })

  const run = (sessionID: string) => {
    if (state.pending) return
    setState("pending", true)
    return input
      .request(sessionID)
      .then((success) => {
        if (!success) {
          input.onError(false)
          setState("pending", false)
          return
        }
        setState("awaitingStatus", true)
        if (state.retrying) return
        setState({ pending: false, awaitingStatus: false })
      })
      .catch((error) => {
        input.onError(error)
        setState("pending", false)
      })
  }

  const updateStatus = (retrying: boolean) => {
    setState("retrying", retrying)
    if (retrying || !state.awaitingStatus) return
    setState({ pending: false, awaitingStatus: false })
  }

  return {
    get pending() {
      return state.pending
    },
    run,
    updateStatus,
  }
}
