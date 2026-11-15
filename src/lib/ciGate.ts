// #543 slice 1: answer whether a repository's own CI gates a merge, read-only.
// Everything here is pure: the console route reads GitHub and hands the facts
// in, so every rule below is testable without a network, a token or a clock.
// Nothing in this module writes to the user's repository.

export interface WorkflowFile {
  /** Repository-relative path, e.g. `.github/workflows/ci.yml`. */
  path: string
  content: string
}

export interface MergeGateFacts {
  protected: boolean
  requiredChecks: string[]
}

export interface MergedPullFacts {
  number: number
  mergedAt: string
  /** Conclusions of the check runs on the commit that landed, newest first. */
  conclusions: string[]
}

export interface CiGateInput {
  repo: string
  defaultBranch: string
  workflows: WorkflowFile[]
  /** `null` means GitHub refused the protection read (403); that is unknown, not a gap. */
  gate: MergeGateFacts | null
  mergedPulls: MergedPullFacts[]
}

export type CiGateState = 'ok' | 'gap' | 'unknown'

export interface CiGateFinding {
  id: 'workflow' | 'pull-request-trigger' | 'test-on-pull-request' | 'required-check' | 'merged-without-check'
  title: string
  state: CiGateState
  sentence: string
  evidence: string[]
}

export interface CiGateReport {
  verdict: 'gated' | 'gaps' | 'unknown'
  findings: CiGateFinding[]
}

// A workflow "runs on a pull request" when its trigger block names
// `pull_request` (or `pull_request_target`). This is a text read, not a YAML
// parse: the file is evidence the operator can open at the same path, and the
// report quotes the line rather than claiming a parsed structure Fledge does not
// build.
const PULL_REQUEST_TRIGGER = /\bpull_request(_target)?\b/

// The command shapes that mean "run the tests" across the stacks Fledge connects.
// A workflow that only lints or builds is a real gate for other purposes, but it
// is not the test gate this card asks about, so it is reported as a gap with the
// file named rather than silently counted.
const TEST_COMMAND = /\b(npm (run )?test|yarn( run)? test|pnpm( run)? test|node --test|vitest|jest|pytest|python3? -m pytest|go test|cargo test|mvn( -\S+)*( test| verify)|gradlew? (test|check)|make (test|check)|bundle exec (rake|rspec)|rspec|dotnet test|tox)\b/

function firstMatchLine(content: string, pattern: RegExp): string | null {
  for (const line of content.split('\n')) if (pattern.test(line)) return line.trim()
  return null
}

export function reportCiGate(input: CiGateInput): CiGateReport {
  const findings: CiGateFinding[] = []
  const pullRequestWorkflows = input.workflows.filter((file) => PULL_REQUEST_TRIGGER.test(file.content))
  const testWorkflows = pullRequestWorkflows.filter((file) => TEST_COMMAND.test(file.content))

  findings.push(input.workflows.length > 0
    ? {
        id: 'workflow',
        title: 'A workflow file exists',
        state: 'ok',
        sentence: `${input.workflows.length} workflow file(s) on \`${input.defaultBranch}\`.`,
        evidence: input.workflows.map((file) => file.path),
      }
    : {
        id: 'workflow',
        title: 'A workflow file exists',
        state: 'gap',
        sentence: `No file under \`.github/workflows\` on \`${input.defaultBranch}\`, so no check can run.`,
        evidence: [`${input.repo}@${input.defaultBranch}:.github/workflows`],
      })

  findings.push(pullRequestWorkflows.length > 0
    ? {
        id: 'pull-request-trigger',
        title: 'A workflow runs on pull requests',
        state: 'ok',
        sentence: `A check runs when a pull request opens or changes on \`${input.defaultBranch}\`.`,
        evidence: pullRequestWorkflows.map((file) => `${file.path}: ${firstMatchLine(file.content, PULL_REQUEST_TRIGGER) ?? 'pull_request'}`),
      }
    : {
        id: 'pull-request-trigger',
        title: 'A workflow runs on pull requests',
        state: 'gap',
        sentence: 'No workflow triggers on `pull_request`, so a pull request gets no check at all.',
        evidence: input.workflows.length === 0
          ? [`${input.repo}@${input.defaultBranch}:.github/workflows`]
          : input.workflows.map((file) => file.path),
      })

  findings.push(testWorkflows.length > 0
    ? {
        id: 'test-on-pull-request',
        title: 'That workflow runs the tests',
        state: 'ok',
        sentence: 'The pull-request workflow runs a test command.',
        evidence: testWorkflows.map((file) => `${file.path}: ${firstMatchLine(file.content, TEST_COMMAND) ?? 'test'}`),
      }
    : {
        id: 'test-on-pull-request',
        title: 'That workflow runs the tests',
        state: 'gap',
        sentence: pullRequestWorkflows.length === 0
          ? 'No pull-request workflow exists to run the tests.'
          : 'The pull-request workflow runs no test command, so a green check does not mean the tests passed.',
        evidence: pullRequestWorkflows.length === 0 ? [] : pullRequestWorkflows.map((file) => file.path),
      })

  if (input.gate === null) {
    findings.push({
      id: 'required-check',
      title: 'The check is required before merge',
      state: 'unknown',
      sentence: 'GitHub refused the branch-protection read, so this deployment cannot say whether a check is required.',
      evidence: [`${input.repo}@${input.defaultBranch}: protection read forbidden`],
    })
  } else if (!input.gate.protected) {
    findings.push({
      id: 'required-check',
      title: 'The check is required before merge',
      state: 'gap',
      sentence: `\`${input.defaultBranch}\` is not protected, so a red check does not stop a merge.`,
      evidence: [`${input.repo}@${input.defaultBranch}: no branch protection`],
    })
  } else if (input.gate.requiredChecks.length === 0) {
    findings.push({
      id: 'required-check',
      title: 'The check is required before merge',
      state: 'gap',
      sentence: `\`${input.defaultBranch}\` is protected but requires no check, so a green check is not a condition of merge.`,
      evidence: [`${input.repo}@${input.defaultBranch}: protection requires no status check`],
    })
  } else {
    findings.push({
      id: 'required-check',
      title: 'The check is required before merge',
      state: 'ok',
      sentence: `\`${input.defaultBranch}\` requires ${input.gate.requiredChecks.length} check(s) before merge.`,
      evidence: input.gate.requiredChecks.map((name) => `${input.repo}@${input.defaultBranch}: required check ${name}`),
    })
  }

  const unpaced = input.mergedPulls.filter((pull) => !pull.conclusions.includes('success'))
  const mergedFinding: CiGateFinding = input.mergedPulls.length === 0
    ? {
        id: 'merged-without-check',
        title: 'Merged pull requests carried a passing check',
        state: 'ok',
        sentence: 'No pull request merged in the window, so there is nothing to contradict the gate yet.',
        evidence: [],
      }
    : unpaced.length === 0
      ? {
          id: 'merged-without-check',
          title: 'Merged pull requests carried a passing check',
          state: 'ok',
          sentence: `All ${input.mergedPulls.length} pull request(s) merged in the window carried a successful check.`,
          evidence: input.mergedPulls.map((pull) => `${input.repo}#${pull.number} merged ${pull.mergedAt}: ${pull.conclusions.join(', ') || 'no checks'}`),
        }
      : {
          id: 'merged-without-check',
          title: 'Merged pull requests carried a passing check',
          state: 'gap',
          sentence: unpaced.length === 1
            ? 'One pull request merged in the window landed without a successful check.'
            : `${unpaced.length} pull requests merged in the window landed without a successful check.`,
          evidence: unpaced.map((pull) => `${input.repo}#${pull.number} merged ${pull.mergedAt}: ${pull.conclusions.join(', ') || 'no checks'}`),
        }
  findings.push(mergedFinding)

  // `unknown` beats `gated`: a report that could not read protection must not be
  // quoted as "this repository is gated".
  const verdict = findings.some((finding) => finding.state === 'gap')
    ? 'gaps'
    : findings.some((finding) => finding.state === 'unknown') ? 'unknown' : 'gated'
  return { verdict, findings }
}
