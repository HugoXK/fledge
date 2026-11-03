const FORBIDDEN = /[~^:?*[\\]/
const SEGMENT_OK = /^[A-Za-z0-9._-]+$/

export function isValidBranchName(value: string): boolean {
  if (value === '' || value.length > 255) return false
  if (value.startsWith('/') || value.endsWith('/') || value.startsWith('-') || value.endsWith('.') || value.endsWith('.lock')) return false
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false
  if (FORBIDDEN.test(value)) return false
  if ([...value].some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) return false
  return value.split('/').every((segment) => segment !== '' && !segment.startsWith('.') && SEGMENT_OK.test(segment))
}
