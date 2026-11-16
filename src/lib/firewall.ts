import { stripControlCharacters } from './untrusted.js'

// #370, second slice: the first slice fences issue text so the agent reads it as
// data. Fencing alone does not tell a reader what the text tried to do, so this
// slice scans the same payload for instruction-like patterns and records only
// the rule ids. The body itself never leaves `wrapUntrusted`.
//
// The list is deliberately finite and readable: every rule answers "does this
// text try to hand the agent a new job?" and none of them decides anything on
// its own. It labels and records; it does not block the run, the merge or the
// user's right to write an angry issue.
export const UNTRUSTED_EVENT_KIND = 'job.untrusted_input'

export interface FirewallRule {
  id: string
  pattern: RegExp
}

export const FIREWALL_RULES: readonly FirewallRule[] = [
  { id: 'ignore-previous-instructions', pattern: /\b(?:ignore|disregard|forget)\b[^.\n]{0,60}\b(?:instructions?|prompts?|directions?|rules?)\b/i },
  { id: 'push-to-main', pattern: /\bpush\b[^.\n]{0,40}\b(?:to|into)\s+(?:main|master)\b/i },
  { id: 'merge-pull-request', pattern: /\bmerge\b[^.\n]{0,30}\b(?:pull request|pr)\b/i },
  { id: 'system-prompt', pattern: /\b(?:system prompt|you are now|new instructions?|act as (?:a|an|the) (?:system|admin|developer))\b/i },
  { id: 'run-command', pattern: /\b(?:run|execute)\b[^.\n]{0,30}\b(?:commands?|shell|bash|powershell|scripts?)\b/i },
  { id: 'reveal-secret', pattern: /\b(?:print|reveal|show|send|exfiltrate|leak|cat)\b[^.\n]{0,40}\b(?:secrets?|tokens?|passwords?|api[- ]?keys?|credentials?)\b/i },
]

export interface FirewallResult {
  clean: boolean
  /** Rule ids in table order. Matched text is never returned or stored. */
  directives: string[]
}

// Scan exactly what the agent will read: the fence strips control characters
// before it is assembled, so scanning the raw value would let a hidden newline
// split a pattern that the agent still sees intact.
export function scanUntrusted(value: string): FirewallResult {
  const text = stripControlCharacters(value)
  const directives = FIREWALL_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id)
  return { clean: directives.length === 0, directives }
}
