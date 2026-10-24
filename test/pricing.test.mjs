/**
 * 计价层单测：峰谷时钟（含节假日）、模型归类、计价公式、价目关系。
 * 全部用显式时间戳，不依赖系统时区（容器 TZ 可能是任何值）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyModel,
  costOfCounts,
  costOfSlots,
  countsOf,
  DEEPSEEK_CNY,
  DEEPSEEK_PEAK,
  CN_HOLIDAYS_2026,
  beijingDateKey,
  isPeak,
  readLocal,
  slotsFor,
  ZERO_COUNTS,
  ZERO_SLOTS,
  addCounts,
  slotsTotal,
} from '../lib/types/pricing.js'

/** 北京时间 2026-10-15（周四）各整点的 UTC 毫秒。 */
const bj = (hour, minute = 0, day = 15) => Date.UTC(2026, 9, day, hour - 8, minute, 0)

test('DeepSeek 官方峰谷窗口：北京工作日 9-12 / 14-18', () => {
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(8, 59)), false)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(9, 0)), true)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(11, 59)), true)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(12, 0)), false)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(14, 0)), true)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(17, 59)), true)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(18, 0)), false)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(23, 0)), false)
})

test('周末全天谷价（含调休上班的周六）', () => {
  // 2026-10-17 周六 10:00 北京 = 官方高峰小时，但周末规则优先
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(10, 0, 17)), false)
  // 2026-09-20 周日（国庆调休上班日）同样是谷价
  assert.equal(readLocal(DEEPSEEK_PEAK, Date.UTC(2026, 8, 20, 2, 0)).weekday, 0)
  assert.equal(isPeak(DEEPSEEK_PEAK, Date.UTC(2026, 8, 20, 2, 0)), false)
})

test('法定节假日全天谷价（工作日也不行）', () => {
  // 2026-10-01 周四 10:00 北京：平时是高峰，节假日规则压过它
  assert.equal(readLocal(DEEPSEEK_PEAK, bj(10, 0, 1)).weekday, 4)
  assert.equal(isPeak(DEEPSEEK_PEAK, bj(10, 0, 1)), false)
  // 节假日表覆盖 10/7，不含 10/8（调休后已恢复上班）
  assert.equal(CN_HOLIDAYS_2026.length, 33)
  assert.ok(CN_HOLIDAYS_2026.includes('2026-10-07'))
  assert.ok(!CN_HOLIDAYS_2026.includes('2026-10-08'))
})

test('两槽分桶：一笔用量只落进官方峰/谷之一', () => {
  const counts = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }
  const peakSlots = slotsFor(counts, bj(10))
  assert.deepEqual(peakSlots.peak, counts)
  assert.deepEqual(peakSlots.idle, ZERO_COUNTS)
  assert.equal(slotsTotal(peakSlots).input, 1000)

  const idleSlots = slotsFor(counts, bj(21))
  assert.deepEqual(idleSlots.peak, ZERO_COUNTS)
  assert.deepEqual(idleSlots.idle, counts)
  assert.equal(slotsTotal(idleSlots).input, 1000)
})

test('模型归类只认 deepseek，且不会被 glm-5.3-flash 骗到', () => {
  assert.equal(classifyModel('deepseek-v4-pro:0813'), 'pro')
  assert.equal(classifyModel('deepseek-v4-pro'), 'pro')
  assert.equal(classifyModel('deepseek-v4.1-flash'), 'flash')
  assert.equal(classifyModel('deepseek-flash'), 'flash')
  assert.equal(classifyModel('deepseek-v4-flash-vision-exp'), 'flash')
  assert.equal(classifyModel('DeepSeek-V4-Pro:0813'), 'pro')
  assert.equal(classifyModel('glm-5.3-flash'), undefined)
  assert.equal(classifyModel('kimi-k3'), undefined)
  assert.equal(classifyModel('deepseek-unknown-thing'), undefined)
  assert.equal(classifyModel(''), undefined)
})

test('计价公式：输入未命中 + 缓存命中 + 缓存写入(按未命中) + 输出', () => {
  const counts = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }
  // pro 谷价：4.5 + 0.15 + 4.5 + 13.5 = 22.65 元
  assert.equal(Number(costOfCounts(counts, DEEPSEEK_CNY.pro, 0).toFixed(6)), 22.65)
  // pro 峰价：9 + 0.3 + 9 + 27 = 45.3 元
  assert.equal(Number(costOfCounts(counts, DEEPSEEK_CNY.pro, 1).toFixed(6)), 45.3)
  // flash 谷价：1 + 0.02 + 1 + 4 = 6.02 元
  assert.equal(Number(costOfCounts(counts, DEEPSEEK_CNY.flash, 0).toFixed(6)), 6.02)
})

test('峰价 = 谷价 × 2（官方口径）', () => {
  for (const price of Object.values(DEEPSEEK_CNY)) {
    for (const rate of ['hit', 'miss', 'out']) {
      assert.equal(Number((price[rate][0] * 2).toFixed(8)), Number(price[rate][1].toFixed(8)))
    }
  }
})

test('countsOf / addCounts 防御性解析', () => {
  assert.deepEqual(countsOf({ inputTokens: 10, outputTokens: 5 }), { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })
  assert.deepEqual(countsOf({ inputTokens: -3, outputTokens: Number.NaN }), ZERO_COUNTS)
  assert.deepEqual(countsOf({}), ZERO_COUNTS)
  assert.deepEqual(addCounts({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, ZERO_COUNTS), { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })
})

test('costOfSlots 按峰/谷取桶', () => {
  const counts = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
  const peak = slotsFor(counts, bj(10))
  assert.equal(Number(costOfSlots(peak, DEEPSEEK_CNY.pro).toFixed(6)), 9)
  const idle = slotsFor(counts, bj(21))
  assert.equal(Number(costOfSlots(idle, DEEPSEEK_CNY.pro).toFixed(6)), 4.5)
  // 空槽计价为 0，不是 NaN
  assert.equal(costOfSlots(ZERO_SLOTS, DEEPSEEK_CNY.pro), 0)
})

test('北京日历日键', () => {
  assert.equal(beijingDateKey(bj(0, 30)), '2026-10-15')
  assert.equal(beijingDateKey(Date.UTC(2026, 9, 14, 16, 30)), '2026-10-15') // UTC 16:30 = 北京次日 00:30
  assert.equal(beijingDateKey(Date.UTC(2026, 9, 14, 15, 30)), '2026-10-14')
})
