// Read-only deployment drift and canary-gate logic (issue #395).
//
// Fledge never deploys or rolls back a host. It records what an operator says
// happened, and this module judges those records: is production behind the
// released tag, does a live `/healthz` still name the recorded commit, and does
// the canary evidence actually exist. Every verdict is pure and takes no clock,
// network or environment, so a fixture can reproduce it.
//
// Missing evidence is never a pass: a gate link with no value is blocked, and a
// deployment with no readable version or commit cannot be called `ok`.

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const SHA = /^[0-9a-f]{7,40}$/

function text(value) {
  return String(value ?? '')
}

export function parseVersion(value) {
  const match = VERSION.exec(text(value))
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function sameCommit(left, right) {
  const a = text(left).toLowerCase()
  const b = text(right).toLowerCase()
  if (!SHA.test(a) || !SHA.test(b)) return false
  return a.startsWith(b) || b.startsWith(a)
}

function drift(state, summary, input) {
  return {
    state,
    alert: state === 'behind' || state === 'mismatch',
    summary,
    deployment: input.deployment ?? null,
    release: input.release ?? null,
  }
}

function liveHealthMismatch(deployment, healthz) {
  if (healthz === null || healthz === undefined) return ''
  if (healthz.ok === false) return 'the live /healthz is not ok'
  const status = Number(healthz.status)
  if (Number.isFinite(status) && status >= 100 && (status < 200 || status >= 300)) return `the live /healthz answered ${status}`
  const version = text(healthz.version)
  if (version !== '' && version !== text(deployment.version)) return `the live /healthz reports v${version}, the deployment recorded v${text(deployment.version)}`
  const commit = text(healthz.commit)
  if (commit !== '' && !sameCommit(commit, deployment.commit)) return `the live /healthz runs ${commit}, the deployment recorded ${text(deployment.commit)}`
  if (version === '' && commit === '') return 'the live /healthz carries neither a version nor a commit'
  return ''
}

function recordedHealthMismatch(deployment) {
  const healthz = deployment.healthz
  if (healthz !== null && healthz !== undefined) {
    if (healthz.ok === false) return 'the recorded /healthz is not ok'
    const commit = text(healthz.commit)
    if (commit !== '' && !sameCommit(commit, deployment.commit)) return `the recorded /healthz ran ${commit}, the deployment recorded ${text(deployment.commit)}`
  }
  const readyz = deployment.readyz
  if (readyz !== null && readyz !== undefined) {
    if (readyz.ok === false) return 'the recorded /readyz is not ok'
  }
  return ''
}

export function assessDeploymentDrift(input = {}) {
  const deployment = input?.deployment ?? null
  const release = input?.release ?? null
  if (deployment === null || typeof deployment !== 'object') {
    return drift('unknown', 'no deployment is recorded for this environment', { deployment, release })
  }
  if (parseVersion(deployment.version) === null) {
    return drift('unknown', `the recorded deployment names no readable version ("${text(deployment.version)}")`, { deployment, release })
  }
  if (!SHA.test(text(deployment.commit))) {
    return drift('unknown', `the recorded deployment names no readable commit ("${text(deployment.commit)}")`, { deployment, release })
  }
  if (release === null || typeof release !== 'object' || parseVersion(release.version) === null) {
    return drift('unknown', 'no released version is recorded, so drift cannot be judged', { deployment, release })
  }

  const order = compareVersions(deployment.version, release.version)
  if (order === null) {
    return drift('unknown', 'the versions cannot be compared', { deployment, release })
  }
  if (order < 0) {
    return drift('behind', `${text(deployment.environment) || 'this environment'} runs v${text(deployment.version)}, released v${text(release.version)}`, { deployment, release })
  }
  if (order > 0) {
    return drift('mismatch', `${text(deployment.environment) || 'this environment'} runs v${text(deployment.version)}, ahead of the released v${text(release.version)}`, { deployment, release })
  }

  const live = liveHealthMismatch(deployment, input?.healthz ?? null)
  if (live !== '') return drift('mismatch', live, { deployment, release })
  const recorded = recordedHealthMismatch(deployment)
  if (recorded !== '') return drift('mismatch', recorded, { deployment, release })

  const releaseCommit = text(release.commit)
  if (SHA.test(releaseCommit) && !sameCommit(deployment.commit, releaseCommit)) {
    return drift('mismatch', `the deployment runs ${text(deployment.commit)}, the release names ${releaseCommit}`, { deployment, release })
  }
  return drift('ok', `v${text(deployment.version)} at ${text(deployment.commit)} is the released version`, { deployment, release })
}

function gateCheck(id, ok, detail) {
  return { id, ok, detail }
}

function okStatus(value) {
  const status = Number(value)
  return Number.isFinite(status) && status >= 200 && status < 300
}

function windowOk(evidence, id) {
  if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
    return gateCheck(id, false, `${id} evidence is missing`)
  }
  if (evidence.ok !== true) return gateCheck(id, false, `${id} did not pass`)
  const minutes = Number(evidence.windowMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return gateCheck(id, false, `${id} has no measured window`)
  return null
}

export function evaluateCanaryGate(evidence = {}, expected = {}) {
  const checks = []
  const healthz = evidence?.healthz ?? null
  if (healthz === null || healthz === undefined) {
    checks.push(gateCheck('healthz', false, '/healthz evidence is missing'))
  } else if (healthz.ok !== true) {
    checks.push(gateCheck('healthz', false, '/healthz did not pass'))
  } else if (!okStatus(healthz.status)) {
    checks.push(gateCheck('healthz', false, `/healthz answered ${text(healthz.status) || 'no status'}`))
  } else if (!SHA.test(text(healthz.commit))) {
    checks.push(gateCheck('healthz', false, '/healthz carries no readable commit'))
  } else if (SHA.test(text(expected.commit)) && !sameCommit(healthz.commit, expected.commit)) {
    checks.push(gateCheck('healthz', false, `/healthz runs ${text(healthz.commit)}, not the promoted ${text(expected.commit)}`))
  } else if (text(expected.version) !== '' && text(healthz.version) !== text(expected.version)) {
    checks.push(gateCheck('healthz', false, `/healthz reports v${text(healthz.version) || '(none)'}, not v${text(expected.version)}`))
  } else {
    checks.push(gateCheck('healthz', true, `/healthz ok at ${text(healthz.commit)}`))
  }

  const readyz = evidence?.readyz ?? null
  if (readyz === null || readyz === undefined) {
    checks.push(gateCheck('readyz', false, '/readyz evidence is missing'))
  } else if (readyz.ok !== true) {
    checks.push(gateCheck('readyz', false, '/readyz did not pass'))
  } else if (!okStatus(readyz.status)) {
    checks.push(gateCheck('readyz', false, `/readyz answered ${text(readyz.status) || 'no status'}`))
  } else {
    checks.push(gateCheck('readyz', true, '/readyz ok'))
  }

  const smoke = evidence?.smoke ?? null
  if (smoke === null || smoke === undefined) {
    checks.push(gateCheck('smoke', false, 'the smoke job is missing'))
  } else if (smoke.ok !== true) {
    checks.push(gateCheck('smoke', false, 'the smoke job did not pass'))
  } else if (text(smoke.jobId) === '') {
    checks.push(gateCheck('smoke', false, 'the smoke job names no job id'))
  } else {
    checks.push(gateCheck('smoke', true, `smoke job ${text(smoke.jobId)} passed`))
  }

  const errorWindow = windowOk(evidence?.errorWindow ?? null, 'error window')
  if (errorWindow !== null) checks.push(errorWindow)
  else {
    const errors = Number(evidence.errorWindow.errors)
    const threshold = Number(evidence.errorWindow.threshold)
    if (!Number.isFinite(errors) || errors < 0) checks.push(gateCheck('error window', false, 'the error window has no measured error count'))
    else if (Number.isFinite(threshold) && errors > threshold) checks.push(gateCheck('error window', false, `${errors} errors exceed ${threshold}`))
    else checks.push(gateCheck('error window', true, `${errors} errors in ${evidence.errorWindow.windowMinutes} minutes`))
  }

  const latencyWindow = windowOk(evidence?.latencyWindow ?? null, 'latency window')
  if (latencyWindow !== null) checks.push(latencyWindow)
  else {
    const p95 = Number(evidence.latencyWindow.p95Ms)
    const threshold = Number(evidence.latencyWindow.thresholdMs)
    if (!Number.isFinite(p95) || p95 < 0) checks.push(gateCheck('latency window', false, 'the latency window has no measured p95'))
    else if (Number.isFinite(threshold) && p95 > threshold) checks.push(gateCheck('latency window', false, `p95 ${p95}ms exceeds ${threshold}ms`))
    else checks.push(gateCheck('latency window', true, `p95 ${p95}ms in ${evidence.latencyWindow.windowMinutes} minutes`))
  }

  const blocked = checks.filter((entry) => !entry.ok).map((entry) => `${entry.id}: ${entry.detail}`)
  return { ok: blocked.length === 0, checks, blocked }
}
