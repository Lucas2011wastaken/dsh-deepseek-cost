/**
 * 集成测试：真实 cordis root + 桩服务，验证底栏字段、面板、多实例汇总、
 * 旧台账迁移与配额展示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { apply as pluginApply, name as pluginName, Config as pluginConfig } from '../lib/types/index.js'

const bj = (hour, day = 15) => Date.UTC(2026, 9, day, hour - 8, 0, 0)
const IDLE = bj(21) // 北京 21:00：官方谷价
const PEAK = bj(10) // 北京 10:00：官方高峰

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const settle = () => sleep(150)

/** 假 React：createElement 记树，useSyncExternalStore 直接取快照。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useEffect: (fn) => { fn() },
}

/** 面板 UI kit 桩：新接缝（Divider / ScrollBox / 计时）都按宿主契约给形状。 */
const panelUi = (width, height) => ({
  Box: 'Box',
  Text: 'Text',
  Divider: 'Divider',
  ScrollBox: 'ScrollBox',
  useTerminalSize: () => ({ columns: width, rows: height }),
  useAnimationTime: () => 0,
})

/** 面板 props 桩：默认宽 60 / 高 30，活跃会话 s1。 */
const panelProps = (width = 60, height = 30, overrides = {}) => ({
  React: fakeReact,
  ui: panelUi(width, height),
  host: { snapshot: () => ({ sessionId: 's1' }), notify: () => {}, clearBadge: () => {} },
  width,
  height,
  focused: false,
  visible: true,
  mode: 'split',
  ...overrides,
})

/** 把 createElement 树压成纯字符串数组。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object' && 'children' in node) {
    flatten(node.children, out)
    return out
  }
  return out
}

/** 收集 Divider 的 title（标题是 prop，不是文本子节点）。 */
function dividerTitles(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) dividerTitles(child, out)
    return out
  }
  if (typeof node.props?.title === 'string' && node.props.title !== '') out.push(node.props.title)
  dividerTitles(node.children, out)
  return out
}

async function mount(options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'dsh-cost-plugin-'))
  const root = new Context()
  const captured = {
    statusCalls: [],
    statusDisposed: 0,
    fieldCalls: [],
    fieldDisposed: 0,
    opened: [],
    panel: undefined,
    panelDisposed: 0,
    storageOpened: 0,
  }
  const shared = { doc: options.legacyDoc ?? null }

  const harness = {
    name: 'test-harness',
    apply(ctx) {
      ctx.provide('tuiStatus')
      ctx.set('tuiStatus', {
        set(key, text) {
          captured.statusCalls.push({ key, text })
          return () => { captured.statusDisposed += 1 }
        },
        ...(options.setField === false ? {} : {
          setField(key, text, fieldOptions) {
            captured.fieldCalls.push({ key, text, options: fieldOptions })
            return () => { captured.fieldDisposed += 1 }
          },
        }),
      })
      ctx.provide('tuiPanels')
      ctx.set('tuiPanels', {
        register(descriptor) {
          captured.panel = descriptor
          return () => { captured.panelDisposed += 1 }
        },
        ...(options.panelApi === false ? {} : {
          list() {
            return captured.panel === undefined
              ? []
              : [{ id: 'act1:ledger', title: captured.panel.title, source: 'plugin' }]
          },
          open(id) {
            captured.opened.push(id)
            return true
          },
        }),
      })
      if (options.storage !== false) {
        ctx.provide('tuiPluginStorage')
        if (options.storageMode === 'denied') {
          ctx.set('tuiPluginStorage', {
            open() {
              const error = new Error('not admitted')
              error.code = 'COMPONENT_NOT_ADMITTED'
              throw error
            },
          })
        } else {
          ctx.set('tuiPluginStorage', {
            open(ctx) {
              captured.storageOpened += 1
              return {
                async get() { return { value: shared.doc } },
              }
            },
          })
        }
      }
    },
  }

  root.plugin(harness)
  root.plugin({ name: pluginName, apply: pluginApply, Config: pluginConfig }, {
    providers: ['ollama-pro'],
    storage: { dir, refreshMs: 60_000, keepDays: 45, ...(options.storageConfig ?? {}) },
    quota: { enabled: false, ...(options.quota ?? {}) },
    ...(options.configOverrides ?? {}),
  })
  await settle()
  return { root, captured, dir, shared }
}

const header = (provider, model, time = IDLE) => ({
  type: 'request/header',
  seq: 1,
  time,
  data: { header: { config: { provider, model } } },
})

const message = (usage, time = IDLE) => ({
  type: 'assistant/message',
  seq: 2,
  time,
  data: { turn: 1, step: 1, message: { content: [] }, usage },
})

const session = (id = 's1') => ({ id, header: { origin: 'main' } })

test('Config：新键默认值；旧 persist/plan/fx 不再复活', () => {
  const std = pluginConfig['~standard']
  assert.equal(std.version, 1)
  const resolved = std.validate({ providers: 'nope', fx: 9999, persist: { file: '/x' }, plan: { includedUsd: 60 } }).value
  assert.deepEqual(resolved.providers, ['ollama-pro'])
  assert.equal(resolved.storage.enabled, true)
  assert.equal(resolved.quota.enabled, true)
  assert.equal(resolved.quota.credentialsFile, '~/.dsh/.credentials.yaml')
  assert.equal(resolved.billing.anchor, '')
  assert.equal(resolved.fx, undefined)
  assert.equal(resolved.persist, undefined)
  assert.equal(std.validate(null).value.panel.icon, '◈')
  assert.equal(std.validate({ panel: { icon: '🐳' } }).value.panel.icon, '')
})

test('挂载后注册底栏字段与面板；detail 不再出现命中率/Ollama', async () => {
  const { root, captured, dir } = await mount()
  try {
    assert.equal(captured.panel?.id, 'ledger')
    assert.equal(captured.panel?.title, 'DS 官价台账')
    assert.equal(typeof captured.panel?.component, 'function')
    assert.deepEqual(captured.fieldCalls, [])

    const s = session()
    root.emit('session/event', s, header('ollama-pro', 'deepseek-v4-pro:0813'))
    root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))
    await settle()

    const last = captured.fieldCalls.at(-1)
    assert.equal(last.key, 'deepseek-cost')
    assert.match(last.text, /DS官价≈¥18/)
    assert.match(last.text, /谷/)
    assert.equal(last.options?.slot, 'left-tail')
    assert.equal(last.options?.tone, 'dim')
    assert.match(last.options?.detail ?? '', /本会话 输入 1\.00M/)
    assert.doesNotMatch(last.options?.detail ?? '', /命中|Ollama/)
    assert.match(last.options?.detail ?? '', /点击打开台账/)
    assert.equal(typeof last.options?.onClick, 'function')
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('点击底栏字段打开自己注册的台账面板', async () => {
  const { root, captured, dir } = await mount()
  try {
    const s = session()
    root.emit('session/event', s, header('ollama-pro', 'deepseek-v4.1-flash'))
    root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 0 }))
    await settle()
    captured.fieldCalls.at(-1).options.onClick()
    assert.deepEqual(captured.opened, ['act1:ledger'])
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('placement=line 用旧状态行；旧宿主没有 setField 也自动回退', async () => {
  const forced = await mount({ configOverrides: { status: { placement: 'line' } } })
  try {
    const s = session('line')
    forced.root.emit('session/event', s, header('ollama-pro', 'deepseek-v4.1-flash'))
    forced.root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 0 }))
    await settle()
    assert.match(forced.captured.statusCalls.at(-1).text, /DS官价≈¥1/)
    assert.deepEqual(forced.captured.fieldCalls, [])
  } finally {
    await forced.root.stop?.()
    await rm(forced.dir, { recursive: true, force: true })
  }

  const legacy = await mount({ setField: false })
  try {
    const s = session('legacy')
    legacy.root.emit('session/event', s, header('ollama-pro', 'deepseek-v4.1-flash'))
    legacy.root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 0 }))
    await settle()
    assert.match(legacy.captured.statusCalls.at(-1).text, /DS官价≈¥1/)
    assert.deepEqual(legacy.captured.fieldCalls, [])
  } finally {
    await legacy.root.stop?.()
    await rm(legacy.dir, { recursive: true, force: true })
  }
})

test('非目标 provider 的用量不进账', async () => {
  const { root, captured, dir } = await mount()
  try {
    const s = session()
    root.emit('session/event', s, header('deepseek-official', 'deepseek-v4-pro'))
    root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))
    await settle()
    assert.deepEqual(captured.fieldCalls, [])
    assert.deepEqual(captured.statusCalls, [])
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('未识别模型只报未计价 token，并用 warning 露出来', async () => {
  const { root, captured, dir } = await mount()
  try {
    const s = session()
    root.emit('session/event', s, header('ollama-pro', 'glm-5.3-flash'))
    root.emit('session/event', s, message({ inputTokens: 600_000, outputTokens: 0 }))
    await settle()
    const last = captured.fieldCalls.at(-1)
    assert.match(last.text, /未计价/)
    assert.match(last.text, /600k/)
    assert.equal(last.options?.tone, 'warning')
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('面板渲染：活跃会话主卡 + 今日/本周/本月/累计，无命中率', async () => {
  const { root, captured, dir } = await mount()
  try {
    const s = session()
    root.emit('session/event', s, header('ollama-pro', 'deepseek-v4-pro:0813'))
    root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 2_000_000 }))
    await settle()

    const tree = captured.panel.component(panelProps(60))
    const text = flatten(tree).join('\n')
    assert.match(text, /ollama-pro/)
    assert.match(text, /本会话/)
    assert.match(text, /#s1/)
    assert.match(text, /今日/)
    assert.match(text, /本周/)
    assert.match(text, /本月/)
    assert.match(text, /累计/)
    assert.match(text, /输入/)
    assert.match(text, /缓存读/)
    assert.match(text, /输出/)
    // 1M 输入 + 1M 输出 + 2M 缓存命中 = 4.5 + 13.5 + 2×0.15 = 18.3 元
    assert.match(text, /¥18\.30/)
    assert.doesNotMatch(text, /命中|Ollama \$/)
    assert.match(text, /共享日志/)
    assert.match(text, /1 实例/)
    assert.ok(dividerTitles(tree).includes('口径'))
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('面板窄宽度：紧凑排版且不显示命中率', async () => {
  const { root, captured, dir } = await mount()
  try {
    const s = session()
    root.emit('session/event', s, header('ollama-pro', 'deepseek-v4.1-flash'))
    root.emit('session/event', s, message({ inputTokens: 100_000, outputTokens: 50_000 }))
    await settle()

    const hidden = captured.panel.component(panelProps(60, 30, { visible: false }))
    assert.equal(hidden, null)

    const narrow = captured.panel.component(panelProps(30))
    const text = flatten(narrow).join('\n')
    assert.match(text, /输入/)
    assert.match(text, /100k/)
    assert.match(text, /输出/)
    assert.match(text, /50\.0k/)
    assert.doesNotMatch(text, /命中/)
    assert.ok(dividerTitles(narrow).includes('今日 · 本周 · 本月 · 累计'))
  } finally {
    await root.stop?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('多实例：两个 TUI 的用量都进今日/累计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-multi-'))
  try {
    const first = await mount({ dir })
    const s1 = session('a')
    first.root.emit('session/event', s1, header('ollama-pro', 'deepseek-v4.1-flash'))
    first.root.emit('session/event', s1, message({ inputTokens: 1_000_000, outputTokens: 0 }))
    await settle()
    await first.root.stop?.()
    await sleep(100)

    const second = await mount({ dir })
    const s2 = session('b')
    second.root.emit('session/event', s2, header('ollama-pro', 'deepseek-v4.1-flash'))
    second.root.emit('session/event', s2, message({ inputTokens: 2_000_000, outputTokens: 0 }))
    await settle()

    const tree = second.captured.panel.component(panelProps(60, 30, {
      host: { snapshot: () => ({ sessionId: 'b' }), notify: () => {}, clearBadge: () => {} },
    }))
    const text = flatten(tree).join('\n')
    // 本会话只算 b 的 2M；累计含 a+b 的 3M → flash 谷价 ¥3.00
    assert.match(text, /¥2\.00/)
    assert.match(text, /¥3\.00/)
    assert.match(text, /2 实例/)
    await second.root.stop?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('旧插件存储台账迁移：累计包含旧数据，标记只写一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-legacy-'))
  const date = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
  const legacyDoc = {
    version: 2,
    since: Date.now() - 86_400_000,
    updatedAt: Date.now() - 1000,
    days: {
      [date]: {
        'ollama-pro|deepseek-v4.1-flash': {
          peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          idle: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    },
  }
  try {
    const { root, captured } = await mount({ dir, legacyDoc })
    const tree = captured.panel.component(panelProps(60))
    assert.match(flatten(tree).join('\n'), /¥1\.00/)
    const marker = JSON.parse(await readFile(join(dir, 'migrated.json'), 'utf8'))
    assert.ok(marker.migratedAt > 0)
    const legacyLines = (await readFile(join(dir, 'instances', 'legacy.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(legacyLines.length, 1)
    await root.stop?.()

    // 第二次挂载不会重复导入。
    const second = await mount({ dir, legacyDoc })
    const tree2 = second.captured.panel.component(panelProps(60))
    assert.match(flatten(tree2).join('\n'), /¥1\.00/)
    assert.equal((await readFile(join(dir, 'instances', 'legacy.jsonl'), 'utf8')).trim().split('\n').length, 1)
    await second.root.stop?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('直挂行拿不到插件存储：仍从文件旧台账迁移，不丢账', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-file-legacy-'))
  const date = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
  const legacy = {
    version: 1,
    since: Date.now() - 86_400_000,
    updatedAt: Date.now() - 1000,
    days: {
      [date]: {
        'ollama-pro|deepseek-v4.1-flash': {
          dsPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          dsIdle: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          olPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          olIdle: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    },
  }
  try {
    await writeFile(join(dir, 'ledger.json'), JSON.stringify(legacy))
    const { root, captured } = await mount({ dir, storageMode: 'denied' })
    const tree = captured.panel.component(panelProps(60))
    assert.match(flatten(tree).join('\n'), /¥1\.00/)
    assert.ok(await stat(join(dir, 'instances', 'legacy.jsonl')))
    await root.stop?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('配额面板：legacy 5h/周剩余量与重置时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-quota-panel-'))
  try {
    const creds = join(dir, 'creds.yaml')
    await writeFile(creds, 'refs:\n  OLLAMA_PRO_API_KEY: test-token\n')
    const cache = {
      fetchedAt: Date.now(),
      payload: {
        included: {
          session: { remaining_percent: 75, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() },
          weekly: { remaining_percent: 40, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        },
      },
    }
    await writeFile(join(dir, 'quota.json'), JSON.stringify(cache))
    const { root, captured } = await mount({
      dir,
      quota: { enabled: true, credentialsFile: creds, pollMs: 60_000 },
    })
    const tree = captured.panel.component(panelProps(60))
    const text = flatten(tree).join('\n')
    assert.ok(dividerTitles(tree).includes('Ollama 配额'))
    assert.match(text, /5h/)
    assert.match(text, /剩 75\.0%/)
    assert.match(text, /周/)
    assert.match(text, /剩 40\.0%/)
    assert.match(text, /账户级/)
    await root.stop?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('卸载时撤下状态行与面板（ctx.effect 清理）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-unload-'))
  const root = new Context()
  const captured = { statusDisposed: 0, fieldDisposed: 0, panelDisposed: 0, panel: undefined }
  const harness = {
    name: 'h2',
    apply(ctx) {
      ctx.provide('tuiStatus')
      ctx.set('tuiStatus', {
        set: () => () => { captured.statusDisposed += 1 },
        setField: () => () => { captured.fieldDisposed += 1 },
      })
      ctx.provide('tuiPanels')
      ctx.set('tuiPanels', { register: (d) => { captured.panel = d; return () => { captured.panelDisposed += 1 } } })
    },
  }
  root.plugin(harness)
  const fiber = root.plugin({ name: pluginName, apply: pluginApply, Config: pluginConfig }, {
    storage: { dir },
    quota: { enabled: false },
  })
  await settle()
  const s = session('unload')
  root.emit('session/event', s, header('ollama-pro', 'deepseek-v4.1-flash', IDLE))
  root.emit('session/event', s, message({ inputTokens: 1_000_000, outputTokens: 0 }, IDLE))
  await settle()
  assert.equal(captured.fieldDisposed, 0)
  await fiber.dispose()
  await settle()
  assert.equal(captured.panelDisposed, 1)
  assert.equal(captured.fieldDisposed >= 1, true)
  await rm(dir, { recursive: true, force: true })
})
