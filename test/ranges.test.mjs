/**
 * 区间单测：北京自然日/周/月、付费月锚点、Ollama 周限与 period。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addMonthsClamped,
  beijingDayStart,
  beijingMonthStart,
  beijingWeekStart,
  billingCycle,
  buildRangeSet,
  parseAnchor,
  quotaMonthWindow,
  quotaWeekWindow,
} from '../lib/types/ranges.js'

const bj = (y, m, d, hour = 0) => Date.UTC(y, m - 1, d, hour - 8, 0, 0)

test('北京自然日/周/月起点', () => {
  // 2026-10-24 20:00 北京（周六）
  const now = bj(2026, 10, 24, 20)
  assert.equal(beijingDayStart(now), bj(2026, 10, 24))
  assert.equal(beijingWeekStart(now), bj(2026, 10, 19)) // 周一
  assert.equal(beijingMonthStart(now), bj(2026, 10, 1))
})

test('付费月锚点：跨月/月末夹取', () => {
  assert.equal(addMonthsClamped(Date.UTC(2026, 0, 31, 1, 30), 1), Date.UTC(2026, 1, 28, 1, 30))
  const anchor = Date.parse('2026-09-15T09:30:00+08:00')
  const now = Date.parse('2026-10-24T12:00:00+08:00')
  const cycle = billingCycle(anchor, now)
  assert.ok(cycle)
  assert.equal(cycle.from, Date.parse('2026-10-15T09:30:00+08:00'))
  assert.equal(cycle.to, Date.parse('2026-11-15T09:30:00+08:00'))
  assert.equal(parseAnchor(''), undefined)
  assert.equal(parseAnchor('not-a-date'), undefined)
})

test('Ollama 周限 / period 窗口', () => {
  const weekly = { resetsAt: Date.parse('2026-10-26T00:00:00Z') }
  assert.deepEqual(quotaWeekWindow({ weekly }), {
    from: weekly.resetsAt - 7 * 86_400_000,
    to: weekly.resetsAt,
  })
  const period = {
    from: Date.parse('2026-10-15T09:30:00Z'),
    until: Date.parse('2026-11-15T09:30:00Z'),
  }
  assert.deepEqual(quotaMonthWindow({ included: { period } }), { from: period.from, to: period.until })
  assert.equal(quotaWeekWindow(undefined), undefined)
  assert.equal(quotaMonthWindow(undefined), undefined)
})

test('buildRangeSet：老套餐周对齐 resets_at，月度退回自然月', () => {
  const now = Date.parse('2026-10-24T20:00:00+08:00')
  const resetsAt = Date.parse('2026-10-26T00:00:00Z')
  const ranges = buildRangeSet(now, { weekly: { resetsAt } }, undefined)
  assert.equal(ranges.week.from, resetsAt - 7 * 86_400_000)
  assert.equal(ranges.week.to, now)
  assert.equal(ranges.week.note, 'Ollama 周限')
  assert.equal(ranges.month.note, '自然月')
})

test('buildRangeSet：新套餐月度用 period，周退回自然周', () => {
  const now = Date.parse('2026-10-24T20:00:00+08:00')
  const period = {
    from: Date.parse('2026-10-15T09:30:00Z'),
    until: Date.parse('2026-11-15T09:30:00Z'),
  }
  const ranges = buildRangeSet(now, { included: { period } }, undefined)
  assert.equal(ranges.month.from, period.from)
  assert.equal(ranges.month.to, now)
  assert.equal(ranges.month.note, '付费月')
  assert.equal(ranges.week.note, '自然周')
})

test('buildRangeSet：老套餐用 billing.anchor 算付费月', () => {
  const now = Date.parse('2026-10-24T20:00:00+08:00')
  const anchor = Date.parse('2026-09-15T09:30:00+08:00')
  const ranges = buildRangeSet(now, undefined, anchor)
  assert.equal(ranges.month.from, Date.parse('2026-10-15T09:30:00+08:00'))
  assert.equal(ranges.month.to, now)
  assert.equal(ranges.month.note, '付费月')
})
