// Configured secrets (an SMTP password, a model key) have no shape a pattern can
// recognise, so the config registers its literal values here. The set is
// replaced per call, not appended: tests call loadConfig() repeatedly, and
// appending would leak every earlier config's secrets into later assertions.
let registeredSecrets: string[] = []

export function registerRedactionSecrets(values: readonly string[]): void {
  const unique = new Set<string>()
  for (const value of values) {
    // A short operator password is ordinary words in prose; replacing it would
    // shred summaries without protecting anything.
    if (typeof value === 'string' && value.length >= 8) unique.add(value)
  }
  registeredSecrets = [...unique].sort((a, b) => b.length - a.length)
}

// One deterministic recogniser for every secret shape Fledge can meet in a job
// log, a callback or a URL. Run it before a slice: a secret cut in half is a
// fragment no pattern can recognise, and redacting after the cut would leave it.
export function redact(value: string): string {
  let text = String(value ?? '')
  for (const secret of registeredSecrets) {
    if (text.includes(secret)) text = text.split(secret).join('[redacted-secret]')
  }
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    // No leading boundary on an opaque prefix: a summary can glue a token onto a
    // word ("…xyzghp_…") and a fragment of a token is still a token. `sk-` keeps
    // its boundary because English words contain "sk-" ("ri sk-assessment…").
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted-jwt]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted-api-key]')
    .replace(/flg_[A-Za-z0-9_-]{16,}\b/g, '[redacted-fledge-token]')
    .replace(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted-google-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]')
    // Credentials in a URL (`scheme://user:password@host`) have no key name to
    // match, and the token may also be the username, which the token patterns
    // above already replace.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/gi, '$1[redacted-credentials]@')
    // `token=`, `password=` and their siblings, including a quoted value and an
    // `Authorization: token …`-shaped key/value pair.
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|account[_-]?key)\b\s*[=:]\s*)(["']?)([^"'&\s<>]+)\2/gi,
      '$1$2[redacted]$2',
    )
}
