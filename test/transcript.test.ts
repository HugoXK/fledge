import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { parseChiefTranscript, redactChiefText } from '../src/lib/chiefTranscript.js'
import { readZipText } from '../src/lib/zip.js'

function makeZip(name: string, text: string, compress = false): Buffer {
  const filename = Buffer.from(name)
  const plain = Buffer.from(text)
  const data = compress ? deflateRawSync(plain) : plain
  const method = compress ? 8 : 0
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(plain.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(plain.length, 24)
  central.writeUInt16LE(filename.length, 28)
  central.writeUInt32LE(0, 42)
  const cdOffset = local.length + filename.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + filename.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  return Buffer.concat([local, filename, data, central, filename, eocd])
}

test('zip reader extracts the session jsonl entry', () => {
  const text = '{"type":"session"}\n{"type":"user/message"}\n'
  assert.equal(readZipText(makeZip('session.v4.jsonl', text), /^session(?:\.v\d+)?\.jsonl$/), text)
  assert.equal(readZipText(makeZip('session.v4.jsonl', text, true), /^session(?:\.v\d+)?\.jsonl$/), text)
  assert.equal(readZipText(makeZip('other.txt', text), /^session(?:\.v\d+)?\.jsonl$/), null)
})

test('chief transcript keeps human turns and redacts internal job prompts', () => {
  const events = [
    { type: 'session', id: 's1' },
    { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fledge provisioning request. Do not write code.' }] } },
    { type: 'user/message', time: 2, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled' }] } },
    { type: 'user/message', time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '[Fledge owner message]\nPlease report progress.' }] } },
    { type: 'assistant/message', time: 4, data: { message: { content: [{ type: 'text', text: 'One test is still red.' }, { type: 'tool-call', name: 'bash' }] } } },
    { type: 'assistant/message', time: 5, data: { message: { content: [{ type: 'text', text: 'Bearer flg_secretsecret and more.' }] } } },
    { type: 'user/message', time: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'A Fledge job is ready. Work in your own workspace.' }] } },
    { type: 'assistant/message', time: 7, data: { message: { content: [{ type: 'text', text: 'Internal job reply.' }] } } },
    { type: 'user/message', time: 8, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'What is left?' }] } },
    { type: 'assistant/message', time: 9, data: { message: { content: [{ type: 'text', text: 'Two tests, then a PR.' }] } } },
  ]
  const messages = parseChiefTranscript(events.map((event) => JSON.stringify(event)).join('\n'))
  assert.deepEqual(messages.map((message) => message.role), ['user', 'chief', 'user', 'chief'])
  assert.equal(messages[0]?.text, 'Please report progress.')
  assert.match(messages[1]?.text ?? '', /One test is still red/)
  assert.match(messages[1]?.text ?? '', /\[redacted/)
  assert.equal(messages[2]?.text, 'What is left?')
  assert.equal(messages[3]?.text, 'Two tests, then a PR.')
  assert.equal(messages.some((message) => message.text.includes('Internal job reply')), false)
  assert.equal(redactChiefText('ghp_123456789012345678901234567890'), '[redacted-github-token]')
})
