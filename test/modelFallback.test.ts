import test from 'node:test'
import assert from 'node:assert/strict'
import { modelOrder, retryableModelFailure } from '../src/gateway/modelFallback.js'
import type { RepoProviderModelRow } from '../src/db.js'

// #358: the two decisions a model fallback rests on, tested without a network.
//
// The order is the repository's own: `is_default` is the head, the rest keep the
// order `listRepoModelSelection` returns. The retry decision is the boundary the
// card draws — a rate limit or an outage may try another model, an authorization
// failure, an exhausted quota, a payment problem and a policy refusal may not.

function row(id: string, isDefault: 0 | 1): RepoProviderModelRow {
  return {
    id,
    provider_id: 'prov',
    model: `model-${id}`,
    label: `Label ${id}`,
    created_at: '2026-11-12T00:00:00.000Z',
    provider_label: 'Provider',
    provider_region: 'eu',
    provider_data_policy_url: '',
    provider_allowed: 1,
    base_url: 'http://127.0.0.1:1/v1',
    key_enc: '',
    allow_private: 1,
    is_default: isDefault,
  }
}

test('the default model is the head and the rest keep their existing order', () => {
  const selection = [row('a', 0), row('b', 1), row('c', 0)]
  assert.deepEqual(modelOrder(selection).map((entry) => entry.id), ['b', 'a', 'c'])
  // A call that names one of the selection starts there, so the model the
  // instance asked for is the one tried first.
  assert.deepEqual(modelOrder(selection, 'c').map((entry) => entry.id), ['c', 'a', 'b'])
  // A name outside the selection falls back to the default rather than to nothing.
  assert.deepEqual(modelOrder(selection, 'gone').map((entry) => entry.id), ['b', 'a', 'c'])
  assert.deepEqual(modelOrder([]), [])
})

test('only a transient model failure falls back', () => {
  const retryable = [
    [429, '{"error":{"message":"Rate limit reached for requests"}}'],
    [500, 'internal'],
    [502, 'bad gateway'],
    [503, '{"error":{"message":"The model is overloaded"}}'],
    [504, 'gateway timeout'],
    [408, 'timeout'],
    [404, '{"error":{"message":"The model gpt-x has been decommissioned"}}'],
  ] as const
  for (const [status, body] of retryable) {
    assert.equal(retryableModelFailure(status, body), true, `${status} ${body} should fall back`)
  }

  const never = [
    // Auth and payment belong to the repository's credential, not the model.
    [401, '{"error":{"message":"invalid api key"}}'],
    [403, '{"error":{"message":"forbidden"}}'],
    [402, '{"error":{"message":"payment required"}}'],
    // An exhausted provider quota arrives as 429 and must not be retried on
    // another model, which would charge the same account again.
    [429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details"}}'],
    [429, '{"error":{"type":"insufficient_quota"}}'],
    // A policy refusal is a decision about the request, not the model.
    [400, '{"error":{"type":"content_policy_violation","message":"Your request was rejected"}}'],
    [429, '{"error":{"type":"policy_violation"}}'],
    // A wrong URL or a malformed request is not repaired by another model.
    [404, '{"error":{"message":"not found"}}'],
    [400, '{"error":{"message":"bad request"}}'],
  ] as const
  for (const [status, body] of never) {
    assert.equal(retryableModelFailure(status, body), false, `${status} ${body} must not fall back`)
  }
})
