import test from 'node:test'
import assert from 'node:assert/strict'
import { durationText } from '../src/views/pages.js'

// #1057: `durationText` rounded inside a band before it chose the unit, so a
// value one millisecond short of the next band printed the unit it had just
// completed — "60s", "60m", "24.0h" — in the review-trend cells and the
// delivery card. Each edge here is the band's top end; the expected answer is
// the next unit, never a repeated one.
test('a duration never prints a unit it has just completed', () => {
  assert.equal(durationText(59_600), '1m', '59.6 s rounds to 60 s, which is one minute')
  assert.equal(durationText(3_599_000), '1h', '59.98 m rounds to 60 m, which is one hour')
  assert.equal(durationText(86_399_000), '1.0d', '23.9997 h prints 24.0 h, which is a day')
})

test('the last whole value inside a band keeps its own unit', () => {
  assert.equal(durationText(999), '<1s')
  assert.equal(durationText(59_499), '59s', '59.499 s rounds to 59 s, still seconds')
  assert.equal(durationText(3_539_000), '59m', '58.98 m rounds to 59 m, still minutes')
})

test('values that stay inside a band are unchanged', () => {
  assert.equal(durationText(45_000), '45s')
  assert.equal(durationText(90_000), '2m')
  assert.equal(durationText(5_400_000), '1.5h')
  assert.equal(durationText(172_800_000), '2.0d')
  assert.equal(durationText(null), '—')
  assert.equal(durationText(undefined), '—')
  assert.equal(durationText(-1), '—')
})
