export function shouldReleaseDeferredRender(input: {
  sessionID?: string
  mobileChanges: boolean
  timelineMounted: boolean
}) {
  if (!input.sessionID) return true
  if (input.mobileChanges) return true
  return input.timelineMounted
}
