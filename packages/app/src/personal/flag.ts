export const personalUIStorageKey = "opencode.personal-ui"

export function resolvePersonalUI(input: { search: string; stored?: string | null }) {
  const override = new URLSearchParams(input.search).get("personal-ui")
  if (override === "1") return { enabled: true, persist: "1" as const }
  if (override === "0") return { enabled: false, persist: "0" as const }
  return { enabled: input.stored === "1" }
}

export function personalUIEnabled() {
  if (typeof window === "undefined") return false
  const result = resolvePersonalUI({ search: window.location.search, stored: window.localStorage.getItem(personalUIStorageKey) })
  if (result.persist) window.localStorage.setItem(personalUIStorageKey, result.persist)
  return result.enabled
}

export function setPersonalUI(enabled: boolean) {
  window.localStorage.setItem(personalUIStorageKey, enabled ? "1" : "0")
  const url = new URL(window.location.href)
  url.searchParams.set("personal-ui", enabled ? "1" : "0")
  window.location.assign(url)
}
