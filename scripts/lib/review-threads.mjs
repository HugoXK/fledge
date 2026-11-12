// #308: the review-thread state is GraphQL-only, so it gets its own reader beside
// the REST client. `evaluateGate` takes it injected like `api`, which is what lets
// a test make the query reject without a network mock.
//
// It fails closed in every shape it cannot read: a non-2xx, a GraphQL `errors`
// array, a payload with no thread list, and a truncated first page. Returning an
// empty list for any of those would tell the gate "no threads", which is the
// assumption that let #299 report ready at a tip the merge API refused.
const THREAD_PAGE = 100

export function reviewThreadsClient({ token, base, userAgent }) {
  const endpoint = `${String(base).replace(/\/$/, '')}/graphql`
  return async function reviewThreads(repo, prNumber) {
    const [owner, name] = String(repo).split('/')
    if ((owner ?? '') === '' || (name ?? '') === '') throw new Error(`cannot read review threads for "${repo}"`)
    const query = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: ${THREAD_PAGE}) {
            pageInfo { hasNextPage }
            nodes { isResolved isOutdated path line originalLine }
          }
        }
      }
    }`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': userAgent,
      },
      body: JSON.stringify({ query, variables: { owner, name, number: prNumber } }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`GitHub ${response.status} /graphql: ${text.slice(0, 200)}`)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('the review-thread query returned no JSON')
    }
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(`the review-thread query failed: ${String(payload.errors[0]?.message ?? 'unknown error')}`)
    }
    const threads = payload?.data?.repository?.pullRequest?.reviewThreads
    if (threads === null || typeof threads !== 'object' || !Array.isArray(threads.nodes)) {
      throw new Error('the review-thread query returned no thread list')
    }
    if (threads.pageInfo?.hasNextPage === true) {
      throw new Error(`the pull request has more than ${THREAD_PAGE} review threads; refusing to decide on a truncated list`)
    }
    return threads.nodes.map((node) => ({
      isResolved: node?.isResolved === true,
      isOutdated: node?.isOutdated === true,
      path: typeof node?.path === 'string' ? node.path : '',
      line: Number.isInteger(node?.line) ? node.line : null,
      originalLine: Number.isInteger(node?.originalLine) ? node.originalLine : null,
    }))
  }
}
