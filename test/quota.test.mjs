/**
 * 配额单测：legacy/monthly 解析、凭据读取、缓存复用、错误分类。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseBalance, parseCredentialRefs, QuotaClient, resolveApiKey } from '../lib/types/quota.js'

const legacyBody = {
  included: {
    session: { remaining_percent: 75, resets_at: '2026-10-24T12:00:00Z' },
    weekly: { remaining_percent: 40, resets_at: '2026-10-26T00:00:00Z' },
  },
  purchased: { balance_usd: 25 },
}

const monthlyBody = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
  },
  purchased: { balance_usd: 12 },
}

test('legacy 配额：session/weekly + purchased', () => {
  const now = Date.now()
  const snapshot = parseBalance(legacyBody, now)
  assert.ok(snapshot)
  assert.equal(snapshot.kind, 'legacy')
  assert.equal(snapshot.session?.remainingPercent, 75)
  assert.equal(snapshot.weekly?.remainingPercent, 40)
  assert.equal(snapshot.purchasedUsd, 25)
  assert.equal(snapshot.fetchedAt, now)
})

test('monthly 配额：余额/额度/付费月 period', () => {
  const snapshot = parseBalance(monthlyBody, Date.now())
  assert.ok(snapshot)
  assert.equal(snapshot.kind, 'monthly')
  assert.equal(snapshot.included?.balanceUsd, 72.5)
  assert.equal(snapshot.included?.allowanceUsd, 100)
  assert.equal(snapshot.included?.period.until, Date.parse('2026-10-15T09:30:00Z'))
})

test('认不出的形状返回 undefined；坏百分比被夹到 0–100', () => {
  assert.equal(parseBalance(null), undefined)
  assert.equal(parseBalance({ included: {} }), undefined)
  assert.equal(parseBalance({ included: { session: { remaining_percent: 'x', resets_at: 'y' } } }), undefined)
  const clamped = parseBalance({
    included: { session: { remaining_percent: 140, resets_at: '2026-10-24T12:00:00Z' } },
  })
  assert.equal(clamped?.session?.remainingPercent, 100)
})

test('凭据解析：只读 refs 明文，跳过引用型值与后续顶层段', () => {
  const refs = parseCredentialRefs([
    'version: 1',
    'refs:',
    '  OLLAMA_PRO_API_KEY: abc123',
    '  QUOTED: "hello world"',
    '  COMMENTED: xyz  # comment',
    '  REF_ENV: env:SOMETHING',
    'records:',
    '  client-connection/browser-session:',
    '    secret: should-not-be-read',
  ].join('\n'))
  assert.deepEqual(refs, {
    OLLAMA_PRO_API_KEY: 'abc123',
    QUOTED: 'hello world',
    COMMENTED: 'xyz',
  })
})

test('resolveApiKey：env 优先，其次凭据文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-creds-'))
  try {
    const file = join(dir, 'creds.yaml')
    await writeFile(file, 'refs:\n  DSH_TEST_OLLAMA_KEY: from-file\n')
    const config = {
      enabled: true,
      apiKeyEnv: ['DSH_TEST_OLLAMA_KEY'],
      credentialsFile: file,
      baseUrl: 'https://ollama.com',
      pollMs: 60_000,
      timeoutMs: 8_000,
    }
    delete process.env['DSH_TEST_OLLAMA_KEY']
    assert.equal(await resolveApiKey(config), 'from-file')
    process.env['DSH_TEST_OLLAMA_KEY'] = 'from-env'
    assert.equal(await resolveApiKey(config), 'from-env')
    delete process.env['DSH_TEST_OLLAMA_KEY']
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('QuotaClient：首次请求后写缓存，第二个实例直接复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-client-'))
  try {
    const creds = join(dir, 'creds.yaml')
    await writeFile(creds, 'refs:\n  OLLAMA_PRO_API_KEY: test-token\n')
    const config = {
      enabled: true,
      apiKeyEnv: ['OLLAMA_PRO_API_KEY'],
      credentialsFile: creds,
      baseUrl: 'https://ollama.com',
      pollMs: 60_000,
      timeoutMs: 8_000,
    }
    let calls = 0
    const fetchOk = async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => legacyBody,
      }
    }
    const first = new QuotaClient(config, dir, fetchOk)
    await first.start()
    assert.equal(calls, 1)
    assert.equal(first.getSnapshot()?.weekly?.remainingPercent, 40)
    first.stop()

    const second = new QuotaClient(config, dir, async () => {
      throw new Error('cache hit 不应再请求')
    })
    await second.start()
    assert.equal(calls, 1)
    assert.equal(second.getSnapshot()?.session?.remainingPercent, 75)
    second.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('QuotaClient：429 保留旧值并记录原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-429-'))
  try {
    const creds = join(dir, 'creds.yaml')
    await writeFile(creds, 'refs:\n  OLLAMA_PRO_API_KEY: test-token\n')
    const config = {
      enabled: true,
      apiKeyEnv: ['OLLAMA_PRO_API_KEY'],
      credentialsFile: creds,
      baseUrl: 'https://ollama.com',
      pollMs: 60_000,
      timeoutMs: 8_000,
    }
    const client = new QuotaClient(config, dir, async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '30']]),
      json: async () => ({}),
    }))
    await client.start()
    assert.match(client.getReason(), /限流/)
    assert.equal(client.getSnapshot(), undefined)
    client.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
