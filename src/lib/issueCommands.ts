export type IssueCommandName = 'status' | 'plan' | 'fix' | 'approve' | 'retry' | 'pause' | 'resume' | 'cancel'

export interface IssueCommandInput {
  command: IssueCommandName
  issueUrl: string
  number: number
  title: string
  detail: string
  association: string
  commentId: string
}

const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
// `retry`, `pause`, `resume` and `cancel` act on the job attached to the issue's
// work item; the four older verbs create work. Both sets are parsed here so the
// webhook has one command vocabulary, not two.
const COMMANDS = new Set<IssueCommandName>(['status', 'plan', 'fix', 'approve', 'retry', 'pause', 'resume', 'cancel'])

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
  return {
    command,
    issueUrl,
    number,
    title: typeof issue.title === 'string' ? issue.title.slice(0, 200) : '',
    detail: typeof issue.body === 'string' ? issue.body.slice(0, 3000) : '',
    association,
    commentId,
  }
}
