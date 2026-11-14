// One renderer for the five states a data region can be in. Every page that can
// be empty, loading, failed or forbidden renders through here so the console
// never shows a blank block with no explanation and no next step.
//
// Contract (asserted by test/uiStates.test.ts):
//   loading  -> aria-busy="true", role="status", skeleton placeholders
//   empty    -> role="status", one sentence and the next action
//   error    -> role="alert", the failure sentence and a retry/next link
//   success  -> role="status", a short confirmation
//   disabled -> aria-disabled="true", why it is unavailable and what unlocks it

import { escapeHtml } from './layout.js'

export type StateKind = 'loading' | 'empty' | 'error' | 'success' | 'disabled'

export interface StateAction {
  href?: string
  label: string
  /** A form action instead of a link, for a retry that must POST. */
  formAction?: string
  csrf?: string
  /** Extra hidden inputs for a POST that is a command (#540); escaped here. */
  fields?: Array<{ name: string; value: string }>
}

export interface StateOptions {
  kind: StateKind
  title: string
  body?: string
  action?: StateAction
  /** Extra skeleton lines for a loading state. */
  skeletonLines?: number
}

// One icon per state, drawn on the same 24x24 grid: the glyphs these replace
// ('0', '!', '✓', '–') came from whatever face the platform picked for the code
// point, so the weight and baseline moved between Windows, macOS and Android and
// a Chinese reader saw Latin punctuation. Colour is inherited -- the state's own
// `.state-icon` rule still sets it -- and the size comes from `.state-icon svg`
// in the stylesheet, so the markup carries no width, height or colour.
//
// A literal map, like the glyphs were: the only value that reaches the markup is
// the kind, nothing user-controlled is interpolated into the SVG, and there is no
// icon package to license or keep versioned.
const ICON_ATTRS = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
const ICONS: Record<StateKind, string> = {
  // An open ring: work is under way, and the skeleton below states how much is
  // still loading. No animation, so the icon adds no motion of its own.
  loading: `<svg viewBox="0 0 24 24" ${ICON_ATTRS}><path d="M12 3a9 9 0 1 1-6.36 2.64" /></svg>`,
  // An empty tray: nothing is in it, and the next action sits beside it.
  empty: `<svg viewBox="0 0 24 24" ${ICON_ATTRS}><path d="M4 13V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" /><path d="M4 13h4l1.6 2.5h4.8L16 13h4" /><path d="M4 13v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>`,
  // A circled exclamation: the failure sentence carries the words.
  error: `<svg viewBox="0 0 24 24" ${ICON_ATTRS}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.2h.01" /></svg>`,
  // A circled check: the confirmation sentence carries the words.
  success: `<svg viewBox="0 0 24 24" ${ICON_ATTRS}><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.8 2.8 5.2-5.6" /></svg>`,
  // A circled slash: the reason sits beside it and no control on the block acts.
  disabled: `<svg viewBox="0 0 24 24" ${ICON_ATTRS}><circle cx="12" cy="12" r="9" /><path d="M6.4 17.6 17.6 6.4" /></svg>`,
}

const ROLES: Record<StateKind, string> = {
  loading: 'status',
  empty: 'status',
  error: 'alert',
  success: 'status',
  disabled: '',
}

function actionHtml(action: StateAction | undefined): string {
  if (action === undefined) return ''
  if (action.formAction !== undefined && action.formAction !== '') {
    const fields = (action.fields ?? []).map((field) => `<input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}" />`).join('')
    return `<form method="post" action="${escapeHtml(action.formAction)}" class="actions">${action.csrf === undefined ? '' : `<input type="hidden" name="csrf" value="${escapeHtml(action.csrf)}" />`}${fields}<button class="btn btn-small" type="submit">${escapeHtml(action.label)}</button></form>`
  }
  if (action.href !== undefined && action.href !== '') {
    return `<div class="actions"><a class="btn btn-small" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></div>`
  }
  return `<div class="actions"><span class="fine">${escapeHtml(action.label)}</span></div>`
}

export function renderState(options: StateOptions): string {
  const { kind, title, body, action } = options
  const lines = kind === 'loading' ? Math.max(1, options.skeletonLines ?? 2) : 0
  const skeletons = lines === 0
    ? ''
    : Array.from({ length: lines }, (_, index) => `<span class="skeleton${index === lines - 1 ? ' wide' : ''}"></span>`).join('')
  const aria = kind === 'loading'
    ? ' aria-busy="true"'
    : kind === 'disabled'
      ? ' aria-disabled="true"'
      : ''
  const role = ROLES[kind] === '' ? '' : ` role="${ROLES[kind]}"`
  return `<div class="state state-${kind}" data-state="${kind}"${role}${aria}>
  <span class="state-icon" aria-hidden="true">${ICONS[kind]}</span>
  <div class="state-body">
    <strong>${escapeHtml(title)}</strong>
    ${body === undefined || body === '' ? '' : `<p>${escapeHtml(body)}</p>`}
    ${skeletons}
    ${actionHtml(action)}
  </div>
</div>`
}

/** The same component inside a table cell, so a list cannot fall back to a grey sentence. */
export function stateCell(colspan: number, options: StateOptions): string {
  return `<tr data-state="${options.kind}"><td colspan="${colspan}">${renderState(options)}</td></tr>`
}
