import test from 'node:test'
import assert from 'node:assert/strict'
import { intervalLabel, normalizeInterval } from '../src/lib/intervals.js'

const t = (zh: string, _en: string): string => zh

test('interval normalization clamps to the supported range', () => {
  assert.equal(normalizeInterval('0'), 15)
  assert.equal(normalizeInterval('120'), 120)
  assert.equal(normalizeInterval('999999'), 43_200)
  assert.equal(normalizeInterval('', 1440), 1440)
  assert.equal(normalizeInterval('abc', 360), 360)
})

test('interval labels cover the expanded cadence options', () => {
  assert.equal(intervalLabel(15, t), '每 15 分钟')
  assert.equal(intervalLabel(120, t), '每 2 小时')
  assert.equal(intervalLabel(4320, t), '每 3 天')
  assert.equal(intervalLabel(20_160, t), '每 2 周')
  assert.equal(intervalLabel(90, t), '每 90 分钟')
})
