import type { Config } from '../config.js'
import type { RepoRow, RepoRuleOverrideRow } from '../db.js'
import { translator, type Locale } from '../i18n.js'
import { humanTimeShort } from '../lib/time.js'
import { MAX_RULE_FILE_BYTES, RULE_PATHS } from '../rules.js'
import { escapeHtml, layout, type Viewer } from './layout.js'

export interface RulesOverridesPageInput {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  overrides: RepoRuleOverrideRow[]
  saved?: string
  cleared?: string
  conflictPath?: string
  conflictRevision?: number
  refused?: string
}

function csrf(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`
}

export function rulesOverridesPage(input: RulesOverridesPageInput): string {
  const { config, locale, viewer, repo, overrides, saved, cleared, conflictPath, conflictRevision, refused } = input
  const t = translator(locale)
  const byPath = new Map(overrides.map((row) => [row.path, row]))

  const banners: string[] = []
  if (saved !== undefined) banners.push(`<p class="banner ok" data-rules-override-saved="${escapeHtml(saved)}">${escapeHtml(t('覆盖已保存。', 'Override saved.'))}</p>`)
  if (cleared !== undefined) banners.push(`<p class="banner ok" data-rules-override-cleared="${escapeHtml(cleared)}">${escapeHtml(t('覆盖已清除；这个文件回退到下一层。', 'Override cleared; this file falls back to the next layer.'))}</p>`)
  if (conflictPath !== undefined) {
    banners.push(`<p class="banner bad" data-rules-override-conflict="${escapeHtml(conflictPath)}" data-rules-override-conflict-revision="${conflictRevision ?? 0}">${escapeHtml(t(`这个覆盖已经更新到版本 ${conflictRevision ?? 0}；你的修改基于旧版本，被拒绝了。刷新页面后重试。`, `This override is already at revision ${conflictRevision ?? 0}; your change was based on an older revision and was refused. Refresh and try again.`))}</p>`)
  }
  if (refused !== undefined) {
    const message = refused === 'path_invalid'
      ? t('只有三个规则文件可以覆盖；`.agents/skills` 不在这一批里。', 'Only the three rule files can be overridden; `.agents/skills` is not in this slice.')
      : refused === 'content_empty'
        ? t('覆盖内容不能为空；要移除覆盖请用清除按钮。', 'Override content cannot be empty; use the clear button to remove one.')
        : refused === 'content_too_large'
          ? t(`覆盖内容最多 ${MAX_RULE_FILE_BYTES} 字节。`, `Override content is limited to ${MAX_RULE_FILE_BYTES} bytes.`)
          : refused === 'content_invalid'
            ? t('覆盖内容包含无效字符。', 'Override content contains an invalid character.')
            : refused === 'revision_invalid'
              ? t('版本号无效；请刷新页面后重试。', 'The revision number is invalid; refresh and try again.')
              : refused === 'rule_override_missing'
                ? t('这个覆盖已经不存在了。', 'That override no longer exists.')
                : t('这次修改没有被接受。', 'The change was not accepted.')
    banners.push(`<p class="banner bad" data-rules-override-refused="${escapeHtml(refused)}">${escapeHtml(message)}</p>`)
  }

  const cards = RULE_PATHS.map((path) => {
    const override = byPath.get(path)
    const form = `<form method="post" action="/repos/${escapeHtml(repo.id)}/rules" class="form" data-rules-override-form="${escapeHtml(path)}">
      ${csrf(viewer)}
      <input type="hidden" name="path" value="${escapeHtml(path)}" />
      <input type="hidden" name="expected_revision" value="${override?.revision ?? 0}" />
      <label for="rules-content-${escapeHtml(path.replace(/[^a-z0-9]+/gi, '-'))}">${escapeHtml(t('覆盖内容', 'Override content'))}
        <textarea id="rules-content-${escapeHtml(path.replace(/[^a-z0-9]+/gi, '-'))}" name="content" rows="8" required>${escapeHtml(override?.content ?? '')}</textarea>
      </label>
      <button class="btn" type="submit">${escapeHtml(override === undefined ? t('添加覆盖', 'Add override') : t('保存覆盖', 'Save override'))}</button>
    </form>`
    const clear = override === undefined ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/rules/delete" class="form" data-rules-override-clear="${escapeHtml(path)}">
      ${csrf(viewer)}
      <input type="hidden" name="path" value="${escapeHtml(path)}" />
      <input type="hidden" name="expected_revision" value="${override.revision}" />
      <button class="btn btn-ghost" type="submit">${escapeHtml(t('清除覆盖', 'Clear override'))}</button>
    </form>`
    const state = override === undefined
      ? `<p class="muted" data-rules-override-path="${escapeHtml(path)}" data-rules-override-state="none">${escapeHtml(t('没有控制台覆盖。仓库文件优先；没有仓库文件时使用内置行为。', 'No console override. A repository file wins; without one the built-in behaviour applies.'))}</p>`
      : `<p class="muted" data-rules-override-path="${escapeHtml(path)}" data-rules-override-state="set" data-rules-override-revision="${override.revision}">${escapeHtml(t(`版本 ${override.revision} · ${humanTimeShort(override.updated_at)} 由 ${override.updated_by} 更新。仓库文件仍然优先于这个覆盖。`, `Revision ${override.revision} · updated ${humanTimeShort(override.updated_at)} by ${override.updated_by}. A repository file still wins over this override.`))}</p>`
    return `<section class="card" id="repo-rules-${escapeHtml(path.replace(/[^a-z0-9]+/gi, '-'))}">
      <h2><code>${escapeHtml(path)}</code></h2>
      ${state}
      ${form}
      ${clear}
    </section>`
  }).join('\n')

  const body = `<section class="card">
    <h1>${escapeHtml(t('仓库规则覆盖', 'Repository rule overrides'))}</h1>
    <p class="muted">${escapeHtml(t('生效顺序：仓库文件 > 控制台覆盖 > 内置行为。控制台覆盖只影响没有同名仓库文件的规则文件，并且从下一个任务开始生效。', 'Precedence: repository file > console override > built-in behaviour. A console override only applies when the repository has no file at that path, and it affects later jobs.'))} · <a href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to the repository'))}</a></p>
    ${banners.join('\n')}
    ${cards}
  </section>`

  return layout({ title: t('仓库规则覆盖', 'Repository rule overrides'), viewer, body, config, locale, path: `/repos/${repo.id}/rules`, active: 'dashboard' })
}
