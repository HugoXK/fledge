function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (octets === null) return false
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function parseIpv6(address: string): number[] | null {
  let value = address.toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const ipv4 = parseIpv4(value.slice(lastColon + 1))
    if (ipv4 === null) return null
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0)
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)
    value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':')
  const right = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : []
  const groups = [...left, ...right]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const parsed = groups.map((group) => Number.parseInt(group, 16))
  if (halves.length === 1) return parsed.length === 8 ? parsed : null
  const zeros = 8 - parsed.length
  if (zeros < 1) return null
  return [...parsed.slice(0, left.length), ...Array<number>(zeros).fill(0), ...parsed.slice(left.length)]
}

function mappedIpv4(groups: number[]): string | null {
  if (groups.length !== 8) return null
  if (groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return null
  const high = groups[6] ?? 0
  const low = groups[7] ?? 0
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

export function isBlockedIpAddress(address: string): boolean {
  const text = address.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = parseIpv4(text)
  if (ipv4 !== null) return isBlockedIpv4(text)
  const groups = parseIpv6(text)
  if (groups === null) return false
  const mapped = mappedIpv4(groups)
  if (mapped !== null) return isBlockedIpv4(mapped)
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if (groups.slice(0, 6).every((group) => group === 0)) {
    const compatible = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`
    return isBlockedIpv4(compatible)
  }
  const first = groups[0] ?? 0
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}
