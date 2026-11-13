import type { Config } from '../config.js'
import type { ProjectMemoryRow, ProjectMemoryVersionRow, RepoRow } from '../db.js'
import { translator, type Locale } from '../i18n.js'
import {
  MEMORY_BODY_MAX,
  MEMORY_KINDS,
  MEMORY_QUERY_MAX,
  MEMORY_SEARCH_LIMIT,
  MEMORY_STATUSES,
  MEMORY_VERIFICATIONS,
  memoryAudienceLabel,
  memoryKindLabel,
  memoryStatusLabel,
  memoryVerificationLabel,
  previewOf,
  type MemorySearch,
} from '../lib/memory.js'
import { allowedRepoRoles, type RepoRole } from '../lib/repoRole.js'
import { humanTimeShort } from '../lib/time.js'
import { escapeHtml, layout, type Viewer } from './layout.js'

// #539: the repository page for project memory. One page carries the whole slice:
// the list, the bounded search, the exact-version read and the write form. Every
// value that reaches the document is escaped, every sentence is bilingual, and
// every state (empty, refused, conflict, saved, historical, missing) is rendered
// rather than implied.

export interface MemoryDetail {
  entry: ProjectMemoryRow
  version: ProjectMemoryVersionRow
  historical: boolean
}

export interface MemoryPageInput {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  role: RepoRole | null
  search: MemorySearch
  detail?: MemoryDetail
  versions: ProjectMemoryVersionRow[]
  query?: string
  saved?: boolean
  unchanged?: boolean
  conflictRevision?: number
  refused?: string
}

function refusalText(t: (zh: string, en: string) => string, code: string): string {
  switch (code) {
    case 'key_invalid': return t('键名只能是小写字母、数字、点、下划线和连字符，且以字母或数字开头（最多 64 个字符）。', 'A key is lowercase letters, digits, dot, underscore and hyphen, starting with a letter or digit (at most 64 characters).')
    case 'body_empty': return t('正文不能为空。', 'The body cannot be empty.')
    case 'body_too_long': return t(`正文最多 ${MEMORY_BODY_MAX} 个字符。`, `The body is limited to ${MEMORY_BODY_MAX} characters.`)
    case 'kind_invalid': return t('类型不在允许的列表里。', 'That kind is not one of the allowed values.')
    case 'status_invalid': return t('状态不在允许的列表里。', 'That status is not one of the allowed values.')
    case 'verification_invalid': return t('验证方式不在允许的列表里。', 'That verification is not one of the allowed values.')
    case 'audience_invalid': return t('可见范围只能是项目共享或某个角色。', 'The audience must be the project or one role.')
    case 'role_not_allowed': return t('你不能以这个角色写入记忆；先切换仓库角色再试。', 'You may not write for that role; switch the repository role first.')
    case 'scope_too_long': return t('范围说明太长。', 'The scope note is too long.')
    case 'reason_too_long': return t('修改原因太长。', 'The reason is too long.')
    case 'revision_invalid': return t('版本号无效，请刷新页面后重试。', 'The revision number is invalid; refresh the page and try again.')
    case 'source_invalid': return t('来源必须是一个最多 20 条的 JSON 字符串数组。', 'Sources must be a JSON array of at most 20 strings.')
    case 'memory_not_found': return t('你要修改的这条记忆已经不存在了；请作为新条目重新写入。', 'The entry you tried to update no longer exists; write it again as a new entry.')
    case 'query_too_long': return t(`搜索词最多 ${MEMORY_QUERY_MAX} 个字符。`, `A search term is limited to ${MEMORY_QUERY_MAX} characters.`)
    default: return t('这次写入没有被接受。', 'The write was not accepted.')
  }
}

function csrf(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`
}

function select(name: string, values: readonly string[], current: string, label: (value: string) => string, t: (zh: string, en: string) => string): string {
  return `<select id="memory-${name}" name="${escapeHtml(name)}">${values
    .map((value) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label(value))}</option>`)
    .join('')}</select>`
}

export function memoryPage(input: MemoryPageInput): string {
  const { config, locale, viewer, repo, role, search, detail, versions, query, saved, unchanged, conflictRevision, refused } = input
  const t = translator(locale)
  const allowed = allowedRepoRoles(repo.permission)
  const audiences = ['project', ...allowed.map((value) => `role:${value}`)]
  const entry = detail?.entry

  const banners: string[] = []
  if (saved === true) banners.push(`<p class="banner ok" data-memory-saved="1">${escapeHtml(t('记忆已写入。', 'Memory saved.'))}</p>`)
  if (unchanged === true) banners.push(`<p class="banner ok" data-memory-unchanged="1">${escapeHtml(t('内容没有变化，所以没有产生新版本。', 'Nothing changed, so no new revision was created.'))}</p>`)
  if (conflictRevision !== undefined) {
    banners.push(`<p class="banner bad" data-memory-conflict="${conflictRevision}">${escapeHtml(t(`这条记忆已经更新到版本 ${conflictRevision}；你的写入基于旧版本，被拒绝了。先在下面读新版本，再基于它修改。`, `This entry is already at revision ${conflictRevision}; your write was based on an older revision and was refused. Read the current revision below, then write against it.`))}</p>`)
  }
  if (refused !== undefined) {
    banners.push(`<p class="banner bad" data-memory-refused="${escapeHtml(refused)}">${escapeHtml(refusalText(t, refused))}</p>`)
  }
  if (search.refused !== null && search.refused !== undefined) {
    banners.push(`<p class="banner bad" data-memory-refused="${escapeHtml(search.refused)}">${escapeHtml(refusalText(t, search.refused))}</p>`)
  }

  const rows = search.matches
    .map((row) => {
      const href = `/repos/${escapeHtml(repo.id)}/memory?key=${encodeURIComponent(row.key)}`
      return `<tr data-memory-key="${escapeHtml(row.key)}" data-memory-row-revision="${row.revision}">
        <td><a href="${href}"><code>${escapeHtml(row.key)}</code></a></td>
        <td>${escapeHtml(memoryKindLabel(t, row.kind))}</td>
        <td>${escapeHtml(memoryStatusLabel(t, row.status))}</td>
        <td>${escapeHtml(memoryVerificationLabel(t, row.verification))}</td>
        <td>${escapeHtml(memoryAudienceLabel(t, row.audience))}</td>
        <td>${row.revision}</td>
        <td>${escapeHtml(humanTimeShort(row.updated_at))}</td>
      </tr>`
    })
    .join('')

  const list = search.matches.length === 0
    ? `<p class="muted" data-memory-empty="${input.search.total === 0 ? 'true' : 'false'}">${escapeHtml(search.total === 0
      ? t('这个仓库还没有记忆条目。下面写第一条。', 'This repository has no memory entries yet. Write the first one below.')
      : t('没有条目匹配这个搜索词。', 'No entry matches that search term.'))}</p>`
    : `<div class="table-scroll"><table class="job-table">
        <thead><tr><th>${escapeHtml(t('键', 'Key'))}</th><th>${escapeHtml(t('类型', 'Kind'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('验证', 'Verification'))}</th><th>${escapeHtml(t('可见范围', 'Audience'))}</th><th>${escapeHtml(t('版本', 'Revision'))}</th><th>${escapeHtml(t('更新', 'Updated'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${search.truncated ? `<p class="muted">${escapeHtml(t(`只显示前 ${MEMORY_SEARCH_LIMIT} 条（共 ${search.total} 条）。缩小搜索词可以看到更多。`, `Showing the first ${MEMORY_SEARCH_LIMIT} of ${search.total} entries; narrow the search to see the rest.`))}</p>` : ''}`

  const detailHtml = detail === undefined || entry === undefined
    ? ''
    : `<section class="card" id="memory-entry" data-memory-key="${escapeHtml(entry.key)}">
        <h2><code>${escapeHtml(entry.key)}</code> <span class="badge${detail.historical ? '' : ' good'}">${escapeHtml(detail.historical ? t('历史版本', 'Historical revision') : t('当前版本', 'Current revision'))}</span></h2>
        <p class="muted" data-memory-revision="${detail.version.revision}" data-memory-historical="${detail.historical}" data-memory-digest="${escapeHtml(detail.version.digest)}" data-memory-kind="${escapeHtml(entry.kind)}" data-memory-audience="${escapeHtml(entry.audience)}" data-memory-version-count="${versions.length}">
          ${escapeHtml(t('版本', 'Revision'))} ${detail.version.revision} · ${escapeHtml(memoryKindLabel(t, entry.kind))} · ${escapeHtml(memoryStatusLabel(t, entry.status))} · ${escapeHtml(memoryVerificationLabel(t, entry.verification))} · ${escapeHtml(memoryAudienceLabel(t, entry.audience))}
          ${entry.scope === '' ? '' : ` · <code>${escapeHtml(entry.scope)}</code>`}
        </p>
        <p class="muted">${escapeHtml(t('正文摘要', 'Body digest'))}: <code>${escapeHtml(detail.version.digest)}</code> · ${escapeHtml(t('写入', 'Written'))} ${escapeHtml(humanTimeShort(detail.version.created_at))}${detail.version.reason === '' ? '' : ` · ${escapeHtml(t('原因', 'Reason'))}: ${escapeHtml(detail.version.reason)}`}</p>
        <pre class="memory-body">${escapeHtml(detail.version.body)}</pre>
        ${versions.length <= 1 ? '' : `<h3>${escapeHtml(t('版本历史', 'Revision history'))}</h3>
        <ul class="memory-versions">${versions
          .map((version) => `<li data-memory-version="${version.revision}">${version.revision === detail.version.revision ? `<b>${version.revision}</b>` : `<a href="/repos/${escapeHtml(repo.id)}/memory?key=${encodeURIComponent(entry.key)}&amp;rev=${version.revision}">${version.revision}</a>`} · ${escapeHtml(humanTimeShort(version.created_at))} · <code>${escapeHtml(version.digest.slice(0, 12))}…</code></li>`)
          .join('')}</ul>`}
      </section>`

  const form = `<section class="card" id="memory-write">
    <h2>${escapeHtml(t('写入记忆', 'Write memory'))}</h2>
    <p class="muted">${escapeHtml(entry === undefined
      ? t('新条目从版本 1 开始。', 'A new entry starts at revision 1.')
      : t(`正在编辑版本 ${entry.revision}；如果它在这期间被别人改动，这次写入会被拒绝，而不是覆盖。`, `Editing revision ${entry.revision}; if it moved in the meantime this write is refused instead of overwriting.`))}</p>
    <form method="post" action="/repos/${escapeHtml(repo.id)}/memory" class="form memory-form">
      ${csrf(viewer)}
      <input type="hidden" name="expected_revision" value="${entry === undefined ? 0 : entry.revision}" />
        <label for="memory-key">${escapeHtml(t('键', 'Key'))}<input id="memory-key" name="key" value="${escapeHtml(entry?.key ?? '')}" required pattern="[a-z0-9][a-z0-9._-]{0,63}" /></label>
        <label for="memory-kind">${escapeHtml(t('类型', 'Kind'))}${select('kind', MEMORY_KINDS, entry?.kind ?? 'decision', (value) => memoryKindLabel(t, value), t)}</label>
        <label for="memory-status">${escapeHtml(t('状态', 'Status'))}${select('status', MEMORY_STATUSES, entry?.status ?? 'active', (value) => memoryStatusLabel(t, value), t)}</label>
        <label for="memory-verification">${escapeHtml(t('验证', 'Verification'))}${select('verification', MEMORY_VERIFICATIONS, entry?.verification ?? 'human_asserted', (value) => memoryVerificationLabel(t, value), t)}</label>
        <label for="memory-audience">${escapeHtml(t('可见范围', 'Audience'))}${select('audience', audiences, entry?.audience ?? 'project', (value) => memoryAudienceLabel(t, value), t)}</label>
        <label for="memory-scope">${escapeHtml(t('范围（模块或路径）', 'Scope (module or path)'))}<input id="memory-scope" name="scope" value="${escapeHtml(entry?.scope ?? '')}" /></label>
      <p class="fine">${escapeHtml(t(`当前仓库角色：${role === null ? '未选择' : role}。角色条目只有该角色能读到；即使是管理员，切到别的角色也读不到。`, `Current repository role: ${role === null ? 'not chosen' : role}. A role entry is readable only by that role, and an administrator acting as another role cannot read it either.`))}</p>
      <label for="memory-body">${escapeHtml(t('正文', 'Body'))}<textarea id="memory-body" name="body" rows="4" required>${escapeHtml(entry?.body ?? '')}</textarea></label>
      <label for="memory-reason">${escapeHtml(t('修改原因（可选）', 'Reason (optional)'))}<input id="memory-reason" name="reason" maxlength="200" /></label>
      <button class="btn" type="submit">${escapeHtml(entry === undefined ? t('写入版本 1', 'Write revision 1') : t('写入新版本', 'Write new revision'))}</button>
    </form>
  </section>`

  const body = `<section class="card">
      <h1>${escapeHtml(t('项目记忆', 'Project memory'))}</h1>
      <p class="muted">${escapeHtml(t('这是一个有版本的项目记忆：每条记忆都有键、可见范围和版本历史。读到的是确定的版本，不是摘要。', 'A versioned project memory: every entry has a key, an audience and a revision history, and a read returns one exact revision rather than a summary.'))} · <a href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to the repository'))}</a></p>
      ${banners.join('\n')}
      <form method="get" action="/repos/${escapeHtml(repo.id)}/memory" role="search" class="form">
        <label for="memory-q">${escapeHtml(t('搜索（键、正文或范围）', 'Search (key, body or scope)'))}
          <input id="memory-q" name="q" value="${escapeHtml(query ?? '')}" maxlength="${MEMORY_QUERY_MAX}" />
        </label>
        <button class="btn btn-ghost" type="submit">${escapeHtml(t('搜索', 'Search'))}</button>
      </form>
    </section>
    <section class="card">
      <h2>${escapeHtml(t('条目', 'Entries'))}</h2>
      ${list}
    </section>
    ${detailHtml}
    ${form}`
  return layout({ title: t('项目记忆', 'Project memory'), viewer, body, config, locale, path: `/repos/${repo.id}/memory`, active: 'dashboard' })
}

export function memoryMissingPage(input: { config: Config; locale: Locale; viewer: Viewer; repo: RepoRow }): string {
  const t = translator(input.locale)
  const body = `<section class="card">
      <h1>${escapeHtml(t('没有这条记忆', 'No such entry'))}</h1>
      <p class="muted">${escapeHtml(t('这个仓库里没有这条记忆，或者它不在你当前角色的可见范围内。', 'This repository has no such entry, or it is outside the audience of your current role.'))}</p>
      <p><a href="/repos/${escapeHtml(input.repo.id)}/memory">${escapeHtml(t('返回项目记忆', 'Back to project memory'))}</a></p>
    </section>`
  return layout({ title: t('没有这条记忆', 'No such entry'), viewer: input.viewer, body, config: input.config, locale: input.locale, path: `/repos/${input.repo.id}/memory`, active: 'dashboard' })
}
