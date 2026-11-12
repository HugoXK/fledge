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
}

export interface StateOptions {
  kind: StateKind
  title: string
  body?: string
  action?: StateAction
  /** Extra skeleton lines for a loading state. */
  skeletonLines?: number
}

const ICONS: Record<StateKind, string> = {
  loading: '…',
  empty: '0',
  error: '!',
  success: '✓',
  disabled: '–',
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
    return `<form method="post" action="${escapeHtml(action.formAction)}" class="actions">${action.csrf === undefined ? '' : `<input type="hidden" name="csrf" value="${escapeHtml(action.csrf)}" />`}<button class="btn btn-small" type="submit">${escapeHtml(action.label)}</button></form>`
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
