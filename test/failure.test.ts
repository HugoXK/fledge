import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, failureBreakdown, failureLabel } from '../src/lib/failure.js'

const base = { kind: 'iterate', status: 'failed' as const }

test('failures map to actionable categories', () => {
  assert.equal(classifyFailure({ ...base, error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。' })?.kind, 'quota')
  assert.equal(classifyFailure({ ...base, error: 'GitHub token 权限不足，请重新授权这个仓库。' })?.kind, 'credential')
  assert.equal(classifyFailure({ ...base, error: 'STAGE_EVIDENCE_MISSING: 缺少失败测试证据' })?.kind, 'stage_evidence')
  assert.equal(classifyFailure({ ...base, error: '任务停滞：超过 30 分钟没有心跳。' })?.kind, 'stalled')
  assert.equal(classifyFailure({ ...base, error: '任务超时未回报' })?.kind, 'timeout')
  assert.equal(classifyFailure({ ...base, error: 'FlyBot 实例尚未就绪' })?.kind, 'bridge')
  assert.equal(classifyFailure({ ...base, error: 'PR 检查还没有全绿' })?.kind, 'github')
  assert.equal(classifyFailure({ ...base, error: '模型供应商连接失败' })?.kind, 'model')
  assert.equal(classifyFailure({ ...base, error: 'something unexpected' })?.kind, 'unknown')
  assert.equal(classifyFailure({ ...base, status: 'succeeded', error: '' }), null)
})

test('failure labels are bilingual and the breakdown is ordered', () => {
  const t = (zh: string, en: string): string => `${zh}/${en}`
  assert.match(failureLabel(t, 'quota'), /平台额度不足\/Platform quota exhausted/)
  const rows = failureBreakdown([
    { ...base, error: '模型供应商连接失败' },
    { ...base, error: '平台额度已用完' },
    { ...base, error: '平台额度已用完' },
    { ...base, status: 'succeeded', error: '' },
  ])
  assert.deepEqual(rows, [{ kind: 'quota', count: 2 }, { kind: 'model', count: 1 }])
})
