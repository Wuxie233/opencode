import type {
  ClaimPairingRequest,
  ClaimPairingResponse,
  CreatePairingRequest,
  CreatePairingResponse,
  GetSidebarStateResponse,
  PutSidebarStateRequest,
  PutSidebarStateResponse,
} from "./contract"

export interface SidebarSyncClientOptions {
  readonly baseUrl: string
  readonly token?: string
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export function createSidebarSyncClient(options: SidebarSyncClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const fetcher = options.fetch ?? fetch

  async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (!response.ok) {
      if (response.status === 409) throw await response.json()
      throw new Error(`Sidebar sync request failed: ${method} ${path} ${response.status}`)
    }
    if (method === "GET" && response.status === 204) return undefined as T

    return response.json() as Promise<T>
  }

  return {
    createPairing(body: CreatePairingRequest = {}) {
      return request<CreatePairingResponse>("POST", "/sidebar-sync/pairing", body)
    },

    claimPairing(code: string, body: ClaimPairingRequest = {}) {
      return request<ClaimPairingResponse>("POST", `/sidebar-sync/pairing/${encodeURIComponent(code)}/claim`, body)
    },

    getState(namespace: string, scope: string) {
      return request<GetSidebarStateResponse | undefined>(
        "GET",
        `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`,
        undefined,
        options.token,
      )
    },

    putState(namespace: string, scope: string, body: PutSidebarStateRequest) {
      return request<PutSidebarStateResponse>(
        "PUT",
        `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`,
        body,
        options.token,
      )
    },
  }
}
