/**
 * 事件台账单测：线格式、多实例增量合并、半行/截断、裁剪、旧台账迁移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeEvent, encodeEvent, migrateLegacyDoc, UsageLog } from '../lib/types/events.js'
import { addUsage, emptyDoc } from '../lib/types/ledger.js'
import { slotsFor } from '../lib/types/pricing.js'

const counts = (input, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })
const event = (sid, t, c, peak = false, model = 'deepseek-v4.1-flash') => ({
  t, sid, provider: 'ollama-pro', model, subagent: false, peak, counts: c,
})

test('事件线格式往返；坏行/零用量被丢弃', () => {
  const ev = event('s1', 1_700_000_000_000, counts(10, 20, 30, 40), true)
  const line = encodeEvent(ev)
  assert.deepEqual(decodeEvent(line), ev)
  assert.equal(decodeEvent('not json'), undefined)
  assert.equal(decodeEvent('{"t":1,"p":"x","m":"y","pk":0,"i":0,"cr":0,"cw":0,"o":0}'), undefined)
  assert.equal(decodeEvent(JSON.stringify({ t: 1, p: '', m: 'y', pk: 0, i: 1 })), undefined)
})

test('多实例：各自追加，互不覆盖，refresh 后汇总', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-events-'))
  try {
    const now = Date.now()
    const a = new UsageLog({ dir, keepDays: 45, persist: true })
    const b = new UsageLog({ dir, keepDays: 45, persist: true })
    await a.init()
    await b.init()

    a.append(event('s1', now - 5_000, counts(1_000_000)))
    b.append(event('s2', now - 3_000, counts(2_000_000)))
    await a.flush()
    await b.flush()

    assert.equal(await a.refresh(), true)
    // 自己的文件不重复扫描；a 能看到 b 的 2M + 自己的 1M。
    assert.equal(a.summaryOfWindow(-Infinity, now).tokens.input, 3_000_000)
    assert.equal(a.summaryOfSession('s1').tokens.input, 1_000_000)
    assert.equal(a.summaryOfSession('s2').tokens.input, 2_000_000)
    assert.equal(a.instances, 2)
    assert.equal(a.lastMain, 's2')
    // 重复 refresh 不重复计数。
    assert.equal(await a.refresh(), false)
    assert.equal(a.summaryOfWindow(-Infinity, now).tokens.input, 3_000_000)
    await a.flush()
    await b.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('半行 JSON 先忽略，补齐后只计一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-partial-'))
  try {
    const instances = join(dir, 'instances')
    await mkdir(instances, { recursive: true })
    const file = join(instances, 'foreign.jsonl')
    const line = encodeEvent(event('s1', Date.now() - 1_000, counts(100)))
    await writeFile(file, `${line}\n{"t":`)
    const log = new UsageLog({ dir, keepDays: 45, persist: true })
    await log.init()
    assert.equal(log.summaryOfWindow(-Infinity, Date.now()).tokens.input, 100)
    await writeFile(file, `${line}\n${line}\n`)
    assert.equal(await log.refresh(), true)
    assert.equal(log.summaryOfWindow(-Infinity, Date.now()).tokens.input, 200)
    await rm(join(instances, log.instanceId + '.jsonl'), { force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('文件被截断时整体重建，不重复也不丢新内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-rebuild-'))
  try {
    const instances = join(dir, 'instances')
    await mkdir(instances, { recursive: true })
    const file = join(instances, 'foreign.jsonl')
    const now = Date.now()
    const line1 = encodeEvent(event('s1', now - 2_000, counts(100)))
    const line2 = encodeEvent(event('s1', now - 1_000, counts(200)))
    await writeFile(file, `${line1}\n${line2}\n`)
    const log = new UsageLog({ dir, keepDays: 45, persist: true })
    await log.init()
    assert.equal(log.summaryOfWindow(-Infinity, now).tokens.input, 300)
    // 压缩：文件变小且内容替换。
    const line3 = encodeEvent(event('s1', now - 500, counts(50)))
    await writeFile(file, `${line3}\n`)
    assert.equal(await log.refresh(), true)
    assert.equal(log.summaryOfWindow(-Infinity, now).tokens.input, 50)
    await rm(join(instances, log.instanceId + '.jsonl'), { force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pruneOwn 只裁自己的文件；pruneDead 清掉过期死实例', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-prune-'))
  try {
    const now = Date.now()
    const log = new UsageLog({ dir, keepDays: 2, persist: true })
    await log.init()
    log.append(event('s1', now - 4 * 86_400_000, counts(100)))
    log.append(event('s1', now - 1_000, counts(200)))
    await log.flush()
    await log.pruneOwn()
    const text = await readFile(log.filePath, 'utf8')
    assert.doesNotMatch(text, /"i":100/)
    assert.match(text, /"i":200/)

    const dead = join(log.instancesDir, 'dead.jsonl')
    await writeFile(dead, `${encodeEvent(event('s2', now - 10 * 86_400_000, counts(1)))}\n`)
    const old = new Date(now - 10 * 86_400_000)
    await utimes(dead, old, old)
    await log.pruneDead()
    await assert.rejects(readFile(dead, 'utf8'))
    await rm(log.filePath, { force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('裁剪期间的新追加不会被 rename 覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-prune-race-'))
  try {
    const now = Date.now()
    const log = new UsageLog({ dir, keepDays: 2, persist: true })
    await log.init()
    log.append(event('s1', now - 4 * 86_400_000, counts(100)))
    await log.flush()
    const pruning = log.pruneOwn()
    log.append(event('s1', now - 1_000, counts(200)))
    await pruning
    await log.flush()
    const text = await readFile(log.filePath, 'utf8')
    assert.match(text, /"i":200/)
    assert.doesNotMatch(text, /"i":100/)
    await rm(log.filePath, { force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('旧台账迁移：峰/谷各一条日初事件；重复调用不重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-migrate-'))
  try {
    const now = Date.now()
    const instances = join(dir, 'instances')
    await mkdir(instances, { recursive: true })
    const doc = emptyDoc(now)
    const peak = slotsFor(counts(1_000_000), Date.UTC(2026, 9, 15, 2, 0)) // 北京 10:00 峰
    const merged = addUsage(doc, '2026-10-15', 'ollama-pro|deepseek-v4.1-flash', peak, now)
    const first = await migrateLegacyDoc(merged, { dir, instancesDir: instances })
    assert.equal(first, 1)
    const target = join(instances, 'legacy.jsonl')
    const lines = (await readFile(target, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /"pk":1/)
    const second = await migrateLegacyDoc(merged, { dir, instancesDir: instances })
    assert.equal(second, 0)
    assert.equal((await readFile(target, 'utf8')).trim().split('\n').length, 1)
    assert.ok(await readFile(join(dir, 'migrated.json'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
