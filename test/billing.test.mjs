/**
 * 本地付费月锚点文件单测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BILLING_ANCHOR_FILE, readBillingAnchorFile } from '../lib/types/billing.js'

test('billing-anchor：缺失/空文件返回空串', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-anchor-'))
  try {
    assert.equal(readBillingAnchorFile(dir), '')
    await writeFile(join(dir, BILLING_ANCHOR_FILE), '\n')
    assert.equal(readBillingAnchorFile(dir), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('billing-anchor：取第一行并 trim，忽略后续行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-anchor-'))
  try {
    await writeFile(join(dir, BILLING_ANCHOR_FILE), "  2026-09-15T09:30:00+08:00  \nignored\n")
    assert.equal(readBillingAnchorFile(dir), '2026-09-15T09:30:00+08:00')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
