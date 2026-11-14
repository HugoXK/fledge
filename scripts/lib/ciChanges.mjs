// Classify a pull request's changed paths so a gate that cannot learn anything
// from the diff is skipped before a runner starts.
//
// Safety rule: every "not applicable" answer is an allowlist. A path this module
// does not recognise is treated as code and as a Docker input, so an unknown new
// top-level directory runs the full gate instead of silently skipping it. An
// empty path list also runs everything: an unreadable diff must not shrink the
// gate.

const DOC_PATHS = [
  /^docs\//,
  /^README(?:\.zh)?\.md$/,
  /^CHANGELOG\.md$/,
  /^changelog\.d\//,
  /^CONTRIBUTING\.md$/,
  /^CODE_OF_CONDUCT\.md$/,
  /^SECURITY\.md$/,
  /^LICENSE$/,
  /^AGENTS\.md$/,
  /^LESSONS\.md$/,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
]

const SOURCE_PATHS = [
  /^src\//,
  /^bridge\//,
  /^scripts\//,
  /^test\//,
  /^mock\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig(?:\.[a-z]+)?\.json$/,
]

const FRONTEND_PATHS = [
  /^public\//,
  /^src\/views\//,
  /^src\/email\//,
  /^src\/app\.ts$/,
]

const DEPENDENCY_PATHS = [/^package\.json$/, /^package-lock\.json$/]

const DB_PATHS = [
  /^src\/db\.ts$/,
  /^scripts\/backup\.mjs$/,
  /^scripts\/restore-drill(?:-ci)?\.mjs$/,
  /^scripts\/lib\/backup[^/]*\.mjs$/,
]

// The Docker build copies these trees and files. A test-only change does not
// affect the image, and a documentation-only change is excluded separately.
const DOCKER_PATHS = [
  /^Dockerfile$/,
  /^src\//,
  /^bridge\//,
  /^public\//,
  /^scripts\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig(?:\.[a-z]+)?\.json$/,
  /^CHANGELOG\.md$/,
  /^changelog\.d\//,
]

// The workflow checks (action pinning and shell-injection linting) read the
// workflow tree and this small set of scripts; nothing else can change their
// answer.
const WORKFLOW_PATHS = [
  /^\.github\//,
  /^scripts\/action-pins\.mjs$/,
  /^scripts\/lib\/action-pins[^/]*\.mjs$/,
  /^scripts\/workflow-injection\.mjs$/,
  /^scripts\/lib\/workflow-injection[^/]*\.mjs$/,
]

// Paths that are not code and have no gate of their own. Keeping them out of
// the "unknown" fallback lets a deploy-doc-only change skip the code gates.
const NON_CODE_PATHS = [/^deploy\//, /^CODEOWNERS$/]

function matches(patterns, path) {
  return patterns.some((pattern) => pattern.test(path))
}

function normalize(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function isDocPath(path) {
  return matches(DOC_PATHS, normalize(path))
}

export function isSourcePath(path) {
  return matches(SOURCE_PATHS, normalize(path))
}

export function isFrontendPath(path) {
  return matches(FRONTEND_PATHS, normalize(path))
}

export function isDependencyPath(path) {
  return matches(DEPENDENCY_PATHS, normalize(path))
}

export function isDbPath(path) {
  return matches(DB_PATHS, normalize(path))
}

export function isWorkflowPath(path) {
  return matches(WORKFLOW_PATHS, normalize(path))
}

export function isDockerInputPath(path) {
  return matches(DOCKER_PATHS, normalize(path))
}

function isKnownNonCode(path) {
  return isDocPath(path) || isWorkflowPath(path) || matches(NON_CODE_PATHS, path)
}

export function allGateChanges() {
  return {
    docsOnly: false,
    source: true,
    frontend: true,
    deps: true,
    db: true,
    docker: true,
    workflows: true,
    codeql: true,
  }
}

export function classifyChanges(paths) {
  const list = (Array.isArray(paths) ? paths : []).map(normalize).filter((path) => path !== '')
  if (list.length === 0) return allGateChanges()

  const docsOnly = list.every(isDocPath)
  // A new top-level directory is code until a rule says otherwise. This is the
  // one direction that must be conservative: a wrong skip hides a defect, a
  // wrong run only costs a runner.
  const unknown = list.some((path) => !isKnownNonCode(path) && !isSourcePath(path) && !isDockerInputPath(path))
  const source = unknown || list.some(isSourcePath)
  const frontend = list.some(isFrontendPath)
  const deps = list.some(isDependencyPath)
  const db = list.some(isDbPath)
  const workflows = list.some(isWorkflowPath)
  const docker = !docsOnly && (unknown || list.some(isDockerInputPath))
  // CodeQL analyses JavaScript/TypeScript. A documentation-only, deploy-only or
  // Dockerfile-only diff cannot add a source result. A workflow diff still runs
  // it: the CodeQL workflow and its baseline are policy files, and a PR that
  // edits them must not also remove the analysis that judges it.
  const codeql = source || frontend || workflows

  return { docsOnly, source, frontend, deps, db, docker, workflows, codeql }
}
