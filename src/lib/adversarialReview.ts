// An adversarial review is a second, independent read of the same diff: a fresh
// model call that sees the change, the base/tip shas, the verifier result and the
// repository policy, and never the author's summary or claimed test output.
// A same-context review that has already read the author's evidence only repeats
// it, so the boundary here is the packet: it is assembled from named fields, not
// from the job row, and a caller that happens to hold the author's narrative
// cannot pass it through.
//
// The reviewer must name one concrete risk (file:line, failure mode, repro) or
// say "No concrete risk" with the checks it ran. A score is not a verdict: a
// model that answers with a number has not reviewed anything, and the merge gate
// treats that as no evidence instead of a pass.

import { sha256Hex } from './secrets.js'

export interface AdversarialPacketInput {
  baseSha: string
  tipSha: string
  diff: string
  verifier: string
  policy: string[]
}

export interface AdversarialPacket {
  baseSha: string
  tipSha: string
  diff: string
  verifier: string
  policy: string[]
}

export type AdversarialVerdict =
  | { kind: 'risk'; file: string; line: number; failureMode: string; repro: string; checks: string[] }
  | { kind: 'none'; checks: string[] }
  | { kind: 'invalid'; reason: string }

export interface AdversarialReview {
  verdict: AdversarialVerdict
  model: string
  promptHash: string
  baseSha: string
  tipSha: string
}

export type AdversarialModel = (prompt: string) => Promise<string>

// One huge pull request must not turn the review into a second copy of the
// repository, and a 20 MB prompt would only fail upstream.
const MAX_DIFF_CHARS = 60_000
const SHA = /^[0-9a-f]{40}$/i

export function assembleAdversarialPacket(input: AdversarialPacketInput): AdversarialPacket {
  const baseSha = typeof input?.baseSha === 'string' ? input.baseSha.trim() : ''
  const tipSha = typeof input?.tipSha === 'string' ? input.tipSha.trim() : ''
  if (!SHA.test(baseSha) || !SHA.test(tipSha)) throw new Error('an adversarial review needs a base and a tip sha')
  const diff = typeof input?.diff === 'string' ? input.diff.trim() : ''
  if (diff === '') throw new Error('an adversarial review needs a diff')
  const verifier = typeof input?.verifier === 'string' ? input.verifier.trim() : ''
  if (verifier === '') throw new Error('an adversarial review needs the verifier result it may trust')
  const policy = (Array.isArray(input?.policy) ? input.policy : [])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '')
    .slice(0, 20)
  if (policy.length === 0) throw new Error('an adversarial review needs the repository policy')
  // Named fields only: a spread here would carry whatever else the caller holds.
  return { baseSha, tipSha, diff: diff.slice(0, MAX_DIFF_CHARS), verifier: verifier.slice(0, 4000), policy }
}

export function adversarialPrompt(packet: AdversarialPacket): { text: string; hash: string } {
  const text = [
    'You are an independent adversarial reviewer for a code change.',
    'You did not write it. You cannot see the author summary or the author\'s claimed test output, and you must not assume either is true.',
    'Read the diff and the verifier result, then either name one concrete defect or say there is none.',
    '',
    `Base: ${packet.baseSha}`,
    `Tip: ${packet.tipSha}`,
    '',
    'Repository policy:',
    ...packet.policy.map((entry) => `- ${entry}`),
    '',
    'Verifier result (what Fledge actually ran):',
    packet.verifier,
    '',
    'Diff:',
    packet.diff,
    '',
    'Answer in exactly one of these two shapes, with nothing else:',
    '',
    'Concrete risk: <path>:<line>',
    'Failure mode: <one line: what breaks and for whom>',
    'Repro: <one line: the input, command or step that shows it>',
    'Checks: <what you read or ran, comma separated>',
    '',
    'or',
    '',
    'No concrete risk',
    'Checks: <what you read or ran, comma separated>',
    '',
    'A score, a grade, a summary or a compliment is not an answer.',
  ].join('\n')
  return { text, hash: sha256Hex(text) }
}

function lineValue(lines: string[], label: string): string {
  const prefix = `${label.toLowerCase()}:`
  for (const line of lines) {
    if (line.toLowerCase().startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  return ''
}

function checksOf(line: string): string[] {
  return line.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '').slice(0, 20)
}

export function parseAdversarialVerdict(text: string): AdversarialVerdict {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return { kind: 'invalid', reason: 'empty answer: not an adversarial review' }
  const riskLine = lines.find((line) => /^concrete risk:/i.test(line))
  const noneLine = lines.some((line) => /^no concrete risk\b/i.test(line))
  if (riskLine === undefined && !noneLine) {
    if (/\bscore\s*[:=]?\s*\d{1,3}(\s*\/\s*100)?\b/i.test(text) || /^\d{1,3}\s*\/\s*100$/m.test(text)) {
      return { kind: 'invalid', reason: 'a score is not an adversarial review: no file:line and no failure mode' }
    }
    return { kind: 'invalid', reason: 'not an adversarial review: neither "Concrete risk:" nor "No concrete risk"' }
  }
  if (riskLine !== undefined) {
    const target = riskLine.slice('Concrete risk:'.length).trim()
    const match = /^(.*?):(\d+)$/.exec(target)
    if (match === null || match[1]!.trim() === '') {
      return { kind: 'invalid', reason: 'a concrete risk needs file:line, not a description' }
    }
    const failureMode = lineValue(lines, 'Failure mode')
    if (failureMode === '') return { kind: 'invalid', reason: 'a concrete risk needs a failure mode' }
    const repro = lineValue(lines, 'Repro')
    if (repro === '') return { kind: 'invalid', reason: 'a concrete risk needs a repro' }
    return {
      kind: 'risk',
      file: match[1]!.trim(),
      line: Number(match[2]),
      failureMode: failureMode.slice(0, 500),
      repro: repro.slice(0, 500),
      checks: checksOf(lineValue(lines, 'Checks')),
    }
  }
  const checks = checksOf(lineValue(lines, 'Checks'))
  if (checks.length === 0) return { kind: 'invalid', reason: '"No concrete risk" needs the checks it ran' }
  return { kind: 'none', checks }
}

export async function runAdversarialReview(input: {
  packet: AdversarialPacket
  model: AdversarialModel
  modelId: string
}): Promise<AdversarialReview> {
  const prompt = adversarialPrompt(input.packet)
  const answer = await input.model(prompt.text)
  return {
    verdict: parseAdversarialVerdict(String(answer ?? '')),
    model: input.modelId,
    promptHash: prompt.hash,
    baseSha: input.packet.baseSha,
    tipSha: input.packet.tipSha,
  }
}

// A concrete risk blocks the automatic merge until a later run clears it. The
// absence of a pass, a rejected answer and "no concrete risk" all leave the
// merge alone: Fledge does not invent a risk, and it does not treat a number as
// proof either — the job page says which of the three happened.
export function adversarialMergeBlock(review: { verdict: AdversarialVerdict } | null | undefined): { kind: 'risk'; file: string; line: number } | null {
  if (review === null || review === undefined) return null
  if (review.verdict.kind !== 'risk') return null
  return { kind: 'risk', file: review.verdict.file, line: review.verdict.line }
}

// The production model call: one fresh request, no conversation and no tools.
// The packet is the whole context, which is what makes the review independent.
export function openAiAdversarialModel(options: {
  baseUrl: string
  key: string
  model: string
  timeoutMs?: number
  maxTokens?: number
}): AdversarialModel {
  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens ?? 800,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
    if (!response.ok) throw new Error(`adversarial model answered HTTP ${response.status}`)
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = body.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
  }
}

// The job page reads the pass back from one `job.adversarial` event. The record
// keeps the model and the prompt hash so a reader can tell which model answered
// and whether the packet was the same one the verdict names.
export interface AdversarialRecord {
  status: 'risk' | 'none' | 'invalid' | 'skipped' | 'unavailable'
  target: string | null
  reason: string | null
  model: string | null
  promptHash: string | null
  checks: string[]
}

export function parseAdversarialRecord(meta: string | null | undefined): AdversarialRecord | null {
  if (typeof meta !== 'string' || meta.trim() === '') return null
  let value: Record<string, unknown>
  try {
    const parsed = JSON.parse(meta) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    value = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const verdict = (value.verdict !== null && typeof value.verdict === 'object' ? value.verdict : {}) as Record<string, unknown>
  const raw = typeof verdict.kind === 'string' ? verdict.kind : typeof value.status === 'string' ? value.status : ''
  const status = raw === 'risk' || raw === 'none' || raw === 'invalid' || raw === 'skipped' || raw === 'unavailable' ? raw : null
  if (status === null) return null
  const text = (input: unknown): string | null => (typeof input === 'string' && input.trim() !== '' ? input.trim() : null)
  return {
    status,
    target: text(value.target),
    reason: text(verdict.reason) ?? text(value.reason),
    model: text(value.model),
    promptHash: text(value.promptHash),
    checks: Array.isArray(verdict.checks) ? verdict.checks.filter((entry): entry is string => typeof entry === 'string').slice(0, 20) : [],
  }
}
