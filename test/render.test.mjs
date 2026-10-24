/**
 * 展示层单测：缓存写入并进「输入」、峰谷窗口与下一次切换、金额格式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  billedInputTokens,
  formatCnyCompact,
  formatDuration,
  formatUsd,
  nextPeakSwitch,
  peakWindowLine,
} from '../lib/types/render.js'
import { DEEPSEEK_PEAK } from '../lib/types/pricing.js'

const bj = (hour, day = 15, minute = 0) => Date.UTC(2026, 9, day, hour - 8, minute, 0)

test('缓存写入并入「输入」', () => {
  const counts = { input: 30, cacheRead: 60, cacheWrite: 10, output: 0 }
  assert.equal(billedInputTokens(counts), 40)
})

test('美元格式：配额余额用两位小数', () => {
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(72.5), '$72.50')
  assert.equal(formatUsd(Number.NaN), '$0')
})

test('峰谷窗口文案：北京 + 两段工作日窗口', () => {
  const text = peakWindowLine(DEEPSEEK_PEAK)
  assert.match(text, /北京/)
  assert.match(text, /9-12/)
  assert.match(text, /14-18/)
  assert.match(text, /节假日 33 天/)
})

test('下一次峰谷切换：谷→峰、峰→谷、周末、节假日', () => {
  // 周四 21:00 谷 → 周五 09:00 峰
  assert.deepEqual(nextPeakSwitch(DEEPSEEK_PEAK, bj(21)), {
    atMs: bj(9, 16),
    toPeak: true,
  })
  // 周四 10:30 峰 → 当天 12:00 谷
  assert.deepEqual(nextPeakSwitch(DEEPSEEK_PEAK, bj(10, 15, 30)), {
    atMs: bj(12),
    toPeak: false,
  })
  // 周四 13:00 谷 → 当天 14:00 峰
  assert.deepEqual(nextPeakSwitch(DEEPSEEK_PEAK, bj(13)), {
    atMs: bj(14),
    toPeak: true,
  })
  // 周五 19:00 谷 → 下周一 09:00 峰（周末全天谷价）
  assert.deepEqual(nextPeakSwitch(DEEPSEEK_PEAK, bj(19, 16)), {
    atMs: bj(9, 19),
    toPeak: true,
  })
  // 国庆假期中：10/1 10:00 → 10/8 09:00（10/1–10/7 全天谷价）
  assert.deepEqual(nextPeakSwitch(DEEPSEEK_PEAK, bj(10, 1)), {
    atMs: bj(9, 8),
    toPeak: true,
  })
})

test('表格金额紧凑格式：上千后不挤爆列宽', () => {
  assert.equal(formatCnyCompact(0), '¥0')
  assert.equal(formatCnyCompact(3.42), '¥3.42')
  assert.equal(formatCnyCompact(1234.56), '¥1.23k')
  assert.equal(formatCnyCompact(12_345.67), '¥12.3k')
  assert.equal(formatCnyCompact(1_234_567.8), '¥1.23M')
})

test('剩余时长格式', () => {
  assert.equal(formatDuration(12 * 3_600_000), '12h00m')
  assert.equal(formatDuration(2 * 86_400_000 + 14 * 3_600_000), '2d14h')
  assert.equal(formatDuration(30 * 60_000), '30m')
  assert.equal(formatDuration(0), '0m')
  assert.equal(formatDuration(Number.NaN), '0m')
})
