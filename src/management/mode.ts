// #540: how far the console adapters go for commands added after slice 1.
//
// `off`   — the route a person already knows calls its service directly.
// `shadow`— the command is reserved and recorded, but the route still executes
//           today's path; the receipt is where a divergence shows up.
// `on`    — the command runs through the service and the receipt is the result.
//
// An unknown value is `off`: a typo must not silently start enforcing.
export type ManagementServiceMode = 'off' | 'shadow' | 'on'

export function parseManagementService(raw: string): ManagementServiceMode {
  const value = raw.trim().toLowerCase()
  return value === 'on' || value === 'shadow' || value === 'off' ? value : 'off'
}
