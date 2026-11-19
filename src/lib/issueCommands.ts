export type IssueCommandName = 'status' | 'plan' | 'fix' | 'approve' | 'retry' | 'pause' | 'resume' | 'cancel'

export interface IssueCommandInput {
  command: IssueCommandName
  issueUrl: string
  number: number
  title: string
  detail: string
  association: string
  commentId: string
  // #634: who wrote the command. A plan decision records the person who decided,
  // so the door has to name them; empty when the payload carries no author.
  actor: string
}

// #637: a mention is the second way a comment starts work. It is a plain-text
// trigger, not an identity check: the names are configured per deployment, the
// match is case-insensitive at a word boundary, and the trusted-comment set, the
// created-only rule and the comment id are the command path's, not a second set.
export interface MentionTriggerInput {
  name: string
  issueUrl: string
  number: number
  title: string
  detail: string
  association: string
  commentId: string
  onPullRequest: boolean
  actor: string
}

export interface MentionOptions {
  names: readonly string[]
  botLogin?: string
}

const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
// `retry`, `pause`, `resume` and `cancel` act on the job attached to the issue's
// work item; the four older verbs create work. Both sets are parsed here so the
// webhook has one command vocabulary, not two.
const COMMANDS = new Set<IssueCommandName>(['status', 'plan', 'fix', 'approve', 'retry', 'pause', 'resume', 'cancel'])

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A mention is a whole name after an `@` at a word boundary: `@Fledge` matches,
// `@fledged` and `foo@fledge.example` do not. Matching on the `@` alone would
// make every mail address in a comment a trigger.
function mentionMatcher(names: readonly string[]): RegExp | null {
  const usable = names.map((name) => name.trim()).filter((name) => name !== '')
  if (usable.length === 0) return null
  return new RegExp(`(?:^|[^\\w@])@(${usable.map(escapeRegExp).join('|')})\\b`, 'i')
}

export function parseIssueCommand(body: Record<string, unknown>): IssueCommandInput | null {
  if (body.action !== 'created') return null
  const comment = typeof body.comment === 'object' && body.comment !== null ? (body.comment as Record<string, unknown>) : {}
  const issue = typeof body.issue === 'object' && body.issue !== null ? (body.issue as Record<string, unknown>) : {}
  const association = typeof comment.author_association === 'string' ? comment.author_association : ''
  if (!ALLOWED_ASSOCIATIONS.has(association)) return null
  const text = typeof comment.body === 'string' ? comment.body.trim() : ''
  const match = /^\/fledge\b\s*(\w*)/i.exec(text)
  if (match === null) return null
  const command = (match[1] === '' ? 'status' : match[1]!.toLowerCase()) as IssueCommandName
  if (!COMMANDS.has(command)) return null
  const issueUrl = typeof issue.html_url === 'string' ? issue.html_url : ''
  const number = typeof issue.number === 'number' ? issue.number : 0
  const commentId = typeof comment.id === 'number' || typeof comment.id === 'string' ? String(comment.id) : ''
  if (issueUrl === '' || number === 0 || commentId === '') return null
  const author = objectOf(comment.user)
  return {
    command,
    issueUrl,
    number,
    title: typeof issue.title === 'string' ? issue.title.slice(0, 200) : '',
    detail: typeof issue.body === 'string' ? issue.body.slice(0, 3000) : '',
    association,
    commentId,
    actor: typeof author.login === 'string' ? author.login : '',
  }
}

export function parseMentionTrigger(body: Record<string, unknown>, options: MentionOptions): MentionTriggerInput | null {
  if (body.action !== 'created') return null
  const comment = objectOf(body.comment)
  const issue = objectOf(body.issue)
  const association = typeof comment.author_association === 'string' ? comment.author_association : ''
  if (!ALLOWED_ASSOCIATIONS.has(association)) return null
  const author = objectOf(comment.user)
  const actor = typeof author.login === 'string' ? author.login : ''
  // The bot's own comment is never a trigger: an answer that names the word
  // would otherwise review its own review, which is the loop this card bounds.
  const botLogin = (options.botLogin ?? '').toLowerCase()
  if (botLogin !== '' && actor.toLowerCase() === botLogin) return null
  const matcher = mentionMatcher(options.names)
  if (matcher === null) return null
  const text = typeof comment.body === 'string' ? comment.body : ''
  const match = matcher.exec(text)
  if (match === null) return null
  // A closed issue or pull request does not start work: the answer would land on
  // a thread nobody is watching, and the trigger would spend budget anyway.
  if (issue.state === 'closed') return null
  const issueUrl = typeof issue.html_url === 'string' ? issue.html_url : ''
  const number = typeof issue.number === 'number' ? issue.number : 0
  const commentId = typeof comment.id === 'number' || typeof comment.id === 'string' ? String(comment.id) : ''
  if (issueUrl === '' || number === 0 || commentId === '') return null
  return {
    name: (match[1] ?? '').toLowerCase(),
    issueUrl,
    number,
    title: typeof issue.title === 'string' ? issue.title.slice(0, 200) : '',
    detail: typeof issue.body === 'string' ? issue.body.slice(0, 3000) : '',
    association,
    commentId,
    onPullRequest: typeof issue.pull_request === 'object' && issue.pull_request !== null,
    actor,
  }
}
