// Turn the release chain into one read-only status (issue #280).
//
// The chain a version has to walk is: plan -> release branch -> pull request ->
// annotated tag -> image digest -> SBOM -> build-provenance attestation ->
// GitHub Release -> the running `/healthz`. Each step is a fact read back from
// the API; a fixture with one of them missing is red, and the CLI keeps no
// write endpoint at all — it never deploys, tags or merges.
//
// Pure: no clock, no network, no repository. The caller supplies the payloads
// and the check time, so every verdict is reproducible from a fixture.

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const VERSION = /^\d+\.\d+\.\d+$/

function link(id, state, detail) {
  return { id, state, detail }
}

function ok(id, detail) {
  return link(id, 'ok', detail)
}

function bad(links, id, state, detail) {
  links.push(link(id, state, detail))
}

function text(value) {
  return String(value ?? '')
}

// A version link: the chain is for one version, and `package.json` is the other
// half of the comparison the issue asks for. An unreadable `package.json` is
// reported, not guessed.
function versionLink(links, version, packageVersion) {
  if (packageVersion === '') {
    links.push(link('version', 'skipped', `no package.json was read; v${version} is the only reference`))
    return
  }
  if (packageVersion !== version) {
    bad(links, 'version', 'mismatch', `package.json is at v${packageVersion}, the chain is for v${version}`)
    return
  }
  links.push(ok('version', `package.json is at v${version}`))
}

function planLink(links, version, plan) {
  if (plan === null || plan === undefined) {
    bad(links, 'plan', 'missing', `no release plan for v${version}`)
    return
  }
  const planned = text(plan.version)
  const mainSha = text(plan.mainSha)
  if (planned !== version) {
    bad(links, 'plan', 'mismatch', `the plan is for v${planned || '(none)'}, not v${version}`)
    return
  }
  if (!SHA.test(mainSha)) {
    bad(links, 'plan', 'mismatch', `the plan's main sha "${mainSha}" is not a 40-character sha`)
    return
  }
  const at = text(plan.plannedAt)
  links.push(ok('plan', `planned v${version} from main ${mainSha}${at === '' ? '' : ` on ${at}`}`))
}

function branchLink(links, version, branch, pull) {
  const name = `release/v${version}`
  if (branch === null || branch === undefined) {
    bad(links, 'branch', 'missing', `no ${name} branch`)
    return
  }
  if (branch.deleted === true) {
    // A merged release usually deletes its branch. The pull request head is the
    // record of the tip, so a deleted branch is not a gap; an unmerged one is
    // red on the pull link instead.
    const head = text(pull?.headSha)
    links.push(link('branch', 'skipped', `${name} was deleted after the merge${SHA.test(head) ? `; pull request head ${head} is the record` : ''}`))
    return
  }
  if (text(branch.name) !== name) {
    bad(links, 'branch', 'mismatch', `the branch is "${text(branch.name) || '(none)'}", not ${name}`)
    return
  }
  const tip = text(branch.tip)
  if (!SHA.test(tip)) {
    bad(links, 'branch', 'mismatch', `${name} has no readable tip ("${tip}")`)
    return
  }
  links.push(ok('branch', `${name} at ${tip}`))
}

function pullLink(links, version, pull, branch) {
  if (pull === null || pull === undefined) {
    bad(links, 'pull', 'missing', `no pull request for release/v${version}`)
    return
  }
  const number = Number(pull.number ?? 0)
  if (!Number.isInteger(number) || number <= 0) {
    bad(links, 'pull', 'mismatch', 'the release pull request has no readable number')
    return
  }
  const state = text(pull.state)
  if (state !== 'merged') {
    bad(links, 'pull', 'mismatch', `pull request #${number} is ${state || 'unreadable'}, not merged: v${version} is not released`)
    return
  }
  const headSha = text(pull.headSha)
  const mergeCommitSha = text(pull.mergeCommitSha)
  if (!SHA.test(headSha)) {
    bad(links, 'pull', 'mismatch', `pull request #${number} has no readable head sha`)
    return
  }
  if (branch !== null && branch !== undefined && branch.deleted !== true && SHA.test(text(branch.tip)) && text(branch.tip) !== headSha) {
    bad(links, 'pull', 'mismatch', `pull request #${number} head ${headSha} is not the branch tip ${text(branch.tip)}`)
    return
  }
  if (!SHA.test(mergeCommitSha)) {
    bad(links, 'pull', 'mismatch', `pull request #${number} has no readable squash commit`)
    return
  }
  links.push(ok('pull', `#${number} merged from release/v${version}, head ${headSha}, squash ${mergeCommitSha}`))
}

function tagLink(links, version, tag, pull) {
  const name = `v${version}`
  if (tag === null || tag === undefined) {
    bad(links, 'tag', 'missing', `no ${name} tag`)
    return
  }
  if (text(tag.name) !== name) {
    bad(links, 'tag', 'mismatch', `the tag is "${text(tag.name) || '(none)'}", not ${name}`)
    return
  }
  const objectType = text(tag.objectType)
  if (objectType !== 'tag') {
    bad(links, 'tag', 'mismatch', `${name} is not annotated: the ref points at a ${objectType || 'unreadable'} object`)
    return
  }
  const objectSha = text(tag.objectSha)
  const targetSha = text(tag.targetSha)
  if (!SHA.test(objectSha)) {
    bad(links, 'tag', 'mismatch', `${name} has no readable annotated object`)
    return
  }
  if (!SHA.test(targetSha)) {
    bad(links, 'tag', 'mismatch', `${name} names no target commit`)
    return
  }
  const squash = text(pull?.mergeCommitSha)
  if (SHA.test(squash) && targetSha !== squash) {
    bad(links, 'tag', 'mismatch', `${name} targets ${targetSha}, not the squash commit ${squash}`)
    return
  }
  links.push(ok('tag', `${name} annotated, object ${objectSha}, targets ${targetSha}`))
}

function imageLink(links, version, image) {
  if (image === null || image === undefined) {
    bad(links, 'image', 'missing', `the release names no container image for v${version}`)
    return
  }
  const tag = text(image.tag)
  const digest = text(image.digest)
  if (!tag.endsWith(`:v${version}`) && !tag.endsWith(`:${version}`)) {
    bad(links, 'image', 'mismatch', `the image "${tag || '(none)'}" is not tagged v${version}`)
    return
  }
  if (!DIGEST.test(digest)) {
    bad(links, 'image', 'mismatch', `the image ${tag} has no sha256 digest ("${digest}")`)
    return
  }
  links.push(ok('image', `${tag} @ ${digest}`))
}

function sbomLink(links, version, sbom) {
  const name = text(sbom?.name)
  if (sbom === null || sbom === undefined || sbom.present !== true || name === '') {
    bad(links, 'sbom', 'missing', `no SBOM was published for v${version}`)
    return
  }
  links.push(ok('sbom', `SBOM ${name}`))
}

function attestationLink(links, version, attestation, image) {
  if (attestation === null || attestation === undefined || attestation.present !== true) {
    bad(links, 'attestation', 'missing', `no build-provenance attestation for v${version}`)
    return
  }
  const subject = text(attestation.subjectDigest)
  const digest = text(image?.digest)
  if (!DIGEST.test(subject)) {
    bad(links, 'attestation', 'mismatch', `the attestation signs no readable digest ("${subject}")`)
    return
  }
  if (DIGEST.test(digest) && subject !== digest) {
    bad(links, 'attestation', 'mismatch', `the attestation signs ${subject}, not the image digest ${digest}`)
    return
  }
  links.push(ok('attestation', `provenance for ${subject}`))
}

function releaseLink(links, version, release) {
  if (release === null || release === undefined) {
    bad(links, 'release', 'missing', `no GitHub Release for v${version}`)
    return
  }
  const url = text(release.url)
  const suffix = `/releases/tag/v${version}`
  if (!url.endsWith(suffix)) {
    bad(links, 'release', 'mismatch', `the Release url "${url || '(none)'}" does not name ${suffix}`)
    return
  }
  if (text(release.tagName) !== `v${version}`) {
    bad(links, 'release', 'mismatch', `the Release is for "${text(release.tagName) || '(none)'}", not v${version}`)
    return
  }
  if (release.draft === true) {
    bad(links, 'release', 'mismatch', `${url} is still a draft`)
    return
  }
  const publishedAt = text(release.publishedAt)
  if (publishedAt === '' || Number.isNaN(Date.parse(publishedAt))) {
    bad(links, 'release', 'mismatch', `${url} has no readable published_at`)
    return
  }
  links.push(ok('release', `${url} published ${publishedAt}`))
}

// The last link is the one an operator actually asks about: is the thing that is
// running the thing that was released? It is skipped, not failed, when no
// deployed base URL is configured — an unreachable probe is a missing answer.
function healthzLink(links, version, packageVersion, baseUrl, healthz, tag) {
  if (baseUrl === '') {
    links.push(link('healthz', 'skipped', 'no deployed base URL is configured, so the running instance was not probed'))
    return
  }
  if (healthz === null || healthz === undefined) {
    bad(links, 'healthz', 'missing', `no answer from ${baseUrl}/healthz`)
    return
  }
  const reference = packageVersion === '' ? version : packageVersion
  const runningVersion = text(healthz.version)
  if (runningVersion !== reference) {
    bad(links, 'healthz', 'mismatch', `${baseUrl}/healthz reports v${runningVersion || '(none)'}, package.json is v${reference}`)
    return
  }
  const runningCommit = text(healthz.commit)
  const target = text(tag?.targetSha)
  if (SHA.test(target) && runningCommit !== target.slice(0, 12)) {
    bad(links, 'healthz', 'mismatch', `${baseUrl}/healthz runs ${runningCommit || '(none)'}, the tag targets ${target.slice(0, 12)}`)
    return
  }
  links.push(ok('healthz', `v${runningVersion} at ${runningCommit} on ${baseUrl}`))
}

export function evaluateReleaseStatus(input = {}) {
  const version = text(input?.version)
  const packageVersion = text(input?.packageVersion)
  const checkedAt = text(input?.checkedAt)
  const baseUrl = text(input?.baseUrl).replace(/\/$/, '')

  // The two facts the admin page compares with are fields, not prose inside a
  // link's detail: `targetSha` is what a running build is matched against, and
  // `releaseUrl` is the link the card renders. Both are validated here so a
  // snapshot can never carry an unreadable sha or a non-http URL.
  const tagTarget = text(input?.tag?.targetSha)
  const releaseUrl = text(input?.release?.url)
  const targetSha = SHA.test(tagTarget) ? tagTarget : ''
  const url = /^https?:\/\//.test(releaseUrl) ? releaseUrl : ''

  // A chain for a version nobody named cannot be judged; saying so is better
  // than judging it green against an empty string.
  if (!VERSION.test(version)) {
    const detail = `"${version}" is not an X.Y.Z version`
    return { schema: 1, version, checkedAt, baseUrl, ok: false, links: [link('version', 'mismatch', detail)], problems: [`version: ${detail}`], targetSha: '', releaseUrl: '' }
  }

  const links = []
  versionLink(links, version, packageVersion)
  planLink(links, version, input?.plan ?? null)
  branchLink(links, version, input?.branch ?? null, input?.pull ?? null)
  pullLink(links, version, input?.pull ?? null, input?.branch ?? null)
  tagLink(links, version, input?.tag ?? null, input?.pull ?? null)
  imageLink(links, version, input?.image ?? null)
  sbomLink(links, version, input?.sbom ?? null)
  attestationLink(links, version, input?.attestation ?? null, input?.image ?? null)
  releaseLink(links, version, input?.release ?? null)
  healthzLink(links, version, packageVersion, baseUrl, input?.healthz ?? null, input?.tag ?? null)

  const problems = links.filter((entry) => entry.state === 'missing' || entry.state === 'mismatch').map((entry) => `${entry.id}: ${entry.detail}`)
  return { schema: 1, version, checkedAt, baseUrl, ok: problems.length === 0, links, problems, targetSha, releaseUrl: url }
}
