/**
 * 台账单测：累计、四口径取数、裁剪、容错读回、旧文档兼容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addUsage,
  emptyDoc,
  modelKey,
  normalizeDoc,
  pruneDays,
  slotsInRange,
  splitModelKey,
  summarize,
} from '../lib/types/ledger.js'
import { beijingDateKey, slotsFor, ZERO_SLOTS } from '../lib/types/pricing.js'

const bj = (hour, day = 15) => Date.UTC(2026, 9, day, hour - 8, 0, 0)
const NOW = bj(21) // 北京 2026-10-15 21:00（谷价时段）

const counts = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

test('addUsage 累计同一 (日期, 模型) 的用量', () => {
  let doc = emptyDoc(NOW)
  const key = modelKey('ollama-pro', 'deepseek-v4-pro:0813')
  const slots = slotsFor(counts(1_000_000, 0), NOW)
  doc = addUsage(doc, '2026-10-15', key, slots, NOW)
  doc = addUsage(doc, '2026-10-15', key, slots, NOW)
  const day = doc.days['2026-10-15']
  assert.equal(day[key].idle.input, 2_000_000)
  assert.equal(day[key].peak.input, 0)
  assert.equal(doc.updatedAt, NOW)
})

test('summarize：pro 谷价 1M 输入 + 1M 输出 = ¥18.00', () => {
  const key = modelKey('ollama-pro', 'deepseek-v4-pro:0813')
  let doc = emptyDoc(NOW)
  doc = addUsage(doc, '2026-10-15', key, slotsFor(counts(1_000_000, 1_000_000), NOW), NOW)
  const summary = summarize(slotsInRange(doc, 'today', NOW))
  assert.equal(Number(summary.officialCny.toFixed(6)), 18) // 4.5 + 13.5
  assert.deepEqual(summary.tokens, counts(1_000_000, 1_000_000))
  assert.equal(summary.unpricedTokens, 0)
})

test('非 deepseek 模型只报 token 不给金额', () => {
  const key = modelKey('ollama-pro', 'glm-5.3-flash')
  let doc = emptyDoc(NOW)
  doc = addUsage(doc, '2026-10-15', key, slotsFor(counts(500_000, 100_000), NOW), NOW)
  const summary = summarize(slotsInRange(doc, 'today', NOW))
  assert.equal(summary.officialCny, 0)
  assert.equal(summary.unpricedTokens, 600_000)
  assert.deepEqual(summary.pricedKeys, [])
})

test('四口径：今日 / 本月 / 累计', () => {
  const key = modelKey('ollama-pro', 'deepseek-v4.1-flash')
  let doc = emptyDoc(NOW)
  doc = addUsage(doc, '2026-09-30', key, slotsFor(counts(1_000_000, 0), NOW), NOW) // 上个月
  doc = addUsage(doc, '2026-10-01', key, slotsFor(counts(1_000_000, 0), NOW), NOW) // 本月非今日
  doc = addUsage(doc, '2026-10-15', key, slotsFor(counts(1_000_000, 0), NOW), NOW) // 今天
  const today = summarize(slotsInRange(doc, 'today', NOW))
  const month = summarize(slotsInRange(doc, 'month', NOW))
  const all = summarize(slotsInRange(doc, 'all', NOW))
  assert.equal(today.tokens.input, 1_000_000)
  assert.equal(month.tokens.input, 2_000_000)
  assert.equal(all.tokens.input, 3_000_000)
  // session 口径在 index.ts 内存里维护，这里给空台账就是 0
  assert.equal(summarize(slotsInRange(doc, 'session', NOW)).tokens.input, 0)
})

test('pruneDays 只保留最近 N 天', () => {
  const key = 'ollama-pro|deepseek-flash'
  let doc = emptyDoc(NOW)
  for (const day of ['2026-09-01', '2026-10-14', '2026-10-15']) {
    doc = addUsage(doc, day, key, slotsFor(counts(1, 0), NOW), NOW)
  }
  const pruned = pruneDays(doc, 2, NOW)
  assert.deepEqual(Object.keys(pruned.days).sort(), ['2026-10-14', '2026-10-15'])
  // 无需裁剪时返回原引用（避免每笔都造新对象）
  assert.equal(pruneDays(doc, 400, NOW), doc)
})

test('normalizeDoc 把垃圾输入吃成空台账', () => {
  for (const bad of [null, 42, 'x', [], { days: 'nope' }, { days: { '2026-10-15': { k: 'bad' } } }]) {
    const doc = normalizeDoc(bad, NOW)
    assert.equal(doc.version, 2)
    assert.deepEqual(doc.days, {})
  }
  // 半好半坏：好的留下，坏的丢掉
  const good = slotsFor(counts(5, 6), NOW)
  const doc = normalizeDoc({
    since: 1,
    updatedAt: 2,
    days: {
      '2026-10-15': { 'ollama-pro|deepseek-flash': good, 'broken|model': { peak: 1 } },
      'not-a-date': { 'ollama-pro|deepseek-flash': good },
    },
  }, NOW)
  assert.deepEqual(Object.keys(doc.days), ['2026-10-15'])
  assert.deepEqual(Object.keys(doc.days['2026-10-15']), ['ollama-pro|deepseek-flash'])
  assert.equal(doc.since, 1)
})

test('v1 旧台账读回：dsPeak/dsIdle 映射到 peak/idle，Ollama 槽丢弃', () => {
  const c = counts(10, 0)
  const doc = normalizeDoc({
    version: 1,
    since: NOW,
    updatedAt: NOW,
    days: {
      '2026-10-15': {
        'ollama-pro|deepseek-v4.1-flash': {
          dsPeak: c,
          dsIdle: c,
          olPeak: c,
          olIdle: c,
        },
      },
    },
  }, NOW)
  assert.equal(doc.version, 2)
  const slots = doc.days['2026-10-15']['ollama-pro|deepseek-v4.1-flash']
  assert.deepEqual(slots, { peak: c, idle: c })
  // 两槽都参与汇总：峰价 2 + 谷价 1 元/百万，各 10 输入 → 30/1e6
  const summary = summarize({ 'ollama-pro|deepseek-v4.1-flash': slots })
  assert.equal(Number(summary.officialCny.toFixed(8)), Number((30 / 1e6).toFixed(8)))
})

test('modelKey / splitModelKey 往返', () => {
  const key = modelKey('ollama-pro', 'deepseek-v4-pro:0813')
  assert.deepEqual(splitModelKey(key), { provider: 'ollama-pro', model: 'deepseek-v4-pro:0813' })
  assert.deepEqual(splitModelKey('no-separator'), { provider: '', model: 'no-separator' })
})

test('空台账 + ZERO_SLOTS 不会产生 NaN', () => {
  const summary = summarize({})
  assert.equal(summary.officialCny, 0)
  assert.equal(summary.unpricedTokens, 0)
  assert.deepEqual(summary.tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(slotsInRange(emptyDoc(NOW), 'all', NOW)['x'], undefined)
  assert.deepEqual(ZERO_SLOTS.peak, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(beijingDateKey(NOW), '2026-10-15')
})
