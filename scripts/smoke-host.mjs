#!/usr/bin/env node
/**
 * 真实宿主兼容性冒烟（不是 test/ 里的桩服务）。
 *
 * 把本插件挂到**本机已安装的 dsh-tui** 上，逐项验证它用到的公开接缝：
 *   接缝十一  ctx.tuiStatus.setField（底栏字段，0.17.0 起才有）
 *   接缝十一  ctx.tuiStatus.set（老宿主回退）
 *   侧栏面板  ctx.tuiPanels.register / list / open
 *   存储契约  ctx.tuiPluginStorage.open(ctx) → { get, set }
 *   清单       dsh-plugin.json 能否被宿主自带的 @dsh-std/manifest 接受
 *
 * 用法：
 *   node scripts/smoke-host.mjs
 *   DSH_TUI_HOST=/path/to/dsh-tui node scripts/smoke-host.mjs
 *
 * 退出码：0 = 全过；1 = 有失败项。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)

const candidates = [
  process.env['DSH_TUI_HOST'],
  process.env['HOME'] ? join(process.env['HOME'], '.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui') : undefined,
  process.env['HOME'] ? join(process.env['HOME'], 'Code/dsh-TUI') : undefined,
].filter(entry => typeof entry === 'string' && entry !== '')

const hostDir = candidates.find(entry => existsSync(join(entry, 'lib/types/dsh-adapter/status.js')))
if (hostDir === undefined) {
  console.error('找不到 dsh-tui 安装：请设置 DSH_TUI_HOST 指向包根（含 lib/types/）。')
  process.exit(2)
}

const hostPkg = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
console.log(`宿主: ${hostPkg.name}@${hostPkg.version}  (${hostDir})`)

const require = createRequire(join(hostDir, 'package.json'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const statusMod = await import(pathToFileURL(join(hostDir, 'lib/types/dsh-adapter/status.js')).href)
const panelsMod = await import(pathToFileURL(join(hostDir, 'lib/types/dsh-adapter/panels.js')).href)
const storageMod = await import(pathToFileURL(join(hostDir, 'lib/types/dsh-adapter/plugin-storage.js')).href)
let stringWidth = text => [...text].length
try {
  stringWidth = (await import(pathToFileURL(join(hostDir, 'lib/types/ink/stringWidth.js')).href)).stringWidth
} catch {
  // 取不到就用码点数兜底；只影响宽度断言的精度。
}

const plugin = await import(pathToFileURL(join(pluginRoot, 'lib/types/index.js')).href)

let failed = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok || extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

// ── 1. 清单：用宿主自带的 @dsh-std/manifest 解析 + 校验 ─────────────────
try {
  const manifestMod = await import(pathToFileURL(require.resolve('@dsh-std/manifest')).href)
  const registryMod = await import(pathToFileURL(join(hostDir, 'lib/types/adapter/standard/registry.js')).href)
  const validateMod = await import(pathToFileURL(join(hostDir, 'lib/types/adapter/standard/validate.js')).href)
  const source = readFileSync(join(pluginRoot, 'dsh-plugin.json'), 'utf8')
  const parsed = manifestMod.parseManifest(source, { source: 'dsh-plugin.json' })
  check('清单被宿主解析（manifestVersion 0.15）', parsed.manifestVersion === '0.15', String(parsed.manifestVersion))
  const data = registryMod.loadSpecData()
  if (data === undefined) {
    console.log('SKIP: 宿主未随包提供 spec 数据，跳过契约校验')
  } else {
    const index = validateMod.createContractIndex(data.registry, data.permissions)
    validateMod.validatePlugin(index, parsed)
    check('清单通过宿主契约校验（LocalStorage / 权限词表）', true)
  }
} catch (error) {
  check('清单校验', false, String(error))
}

// ── 2. 真实服务：status / panels / storage ────────────────────────────────
const root = new Context()
const warnings = []
root.logger.exporter({
  colors: false,
  levels: { default: 4 },
  export(message) {
    if (message.type === 'warn') warnings.push(message.args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  },
})

await root.plugin(statusMod.TuiStatusRuntime)
await root.plugin(panelsMod.TuiPanelRuntime)
const storageDir = mkdtempSync(join(tmpdir(), 'dsh-cost-smoke-storage-'))
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-cost-smoke-data-'))
await root.plugin(storageMod.TuiPluginStorageRuntime, { dir: storageDir })

const statusStore = statusMod.getHostStatusStore(root.get('tuiStatus'))
if (statusStore === undefined) throw new Error('宿主没有状态 store')

// 记录插件是否真的按 0.17.0 的 open() 拿句柄
const storageSvc = root.get('tuiPluginStorage')
let openCalls = 0
let openError
const originalOpen = storageSvc.open.bind(storageSvc)
storageSvc.open = (pluginCtx) => {
  openCalls += 1
  try {
    return originalOpen(pluginCtx)
  } catch (error) {
    openError = error
    throw error
  }
}

const ledgerFile = join(dataDir, 'ledger.json')
let pluginCtx
const fiber = root.inject(['tuiStatus', 'tuiPanels', 'tuiPluginStorage'], (ctx) => {
  pluginCtx = ctx
  plugin.apply(ctx, {
    providers: ['ollama-pro'],
    storage: { dir: dataDir, refreshMs: 60_000, keepDays: 45 },
    quota: { enabled: false },
    status: { placement: 'auto', slots: undefined, click: true, detail: true, maxCells: 28 },
    panel: { enabled: true },
  })
})
await fiber

const session = { id: 'smoke', header: { origin: 'main' } }
const time = Date.UTC(2026, 9, 15, 13, 0, 0) // 北京 21:00（官方谷价）
root.emit('session/event', session, {
  type: 'request/header', seq: 1, time,
  data: { header: { config: { provider: 'ollama-pro', model: 'deepseek-v4-pro:0813' } } },
})
root.emit('session/event', session, {
  type: 'assistant/message', seq: 2, time,
  data: { turn: 1, step: 1, message: { content: [] }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
})
await new Promise(resolve => setTimeout(resolve, 120))

// ── 3. 底栏字段 ───────────────────────────────────────────────────────────
const fields = statusStore.getFieldSnapshot()
const field = fields.find(entry => entry.key === 'deepseek-cost')
check('底栏字段被真实宿主接纳', field !== undefined, JSON.stringify(fields.map(entry => entry.key)))
if (field !== undefined) {
  check('槽位 left-tail', field.slot === 'left-tail', field.slot)
  check('色调 dim', field.tone === 'dim', field.tone)
  check(`文本宽度 ≤ maxCells(${field.maxCells})`, stringWidth(field.text) <= field.maxCells, `${stringWidth(field.text)} cells: ${field.text}`)
  check('悬停详情存在且 ≤ 160 cells', typeof field.detail === 'string' && field.detail.length > 0 && stringWidth(field.detail) <= 160, `${field.detail?.length ?? 0}`)
  check('悬停详情不再展示命中率', !/命中/.test(field.detail ?? ''), field.detail ?? '')
  check('可点击字段带悬停说明（宿主硬规则）', typeof field.onClick === 'function' && (field.detail ?? '') !== '')
}

// 点击回调：宿主在无 Chat 控制器消费时返回 false（不是抛错），也不能冒 warn。
let clickError
try {
  field?.onClick?.()
} catch (error) {
  clickError = error
}
check('点击字段打开台账：回调不抛', clickError === undefined, String(clickError))

// ── 4. 侧栏面板 ───────────────────────────────────────────────────────────
// list() 有 caller 校验（只返回调用者自己的面板），插件用的是它自己 inject 的
// context；检查侧改用宿主 facade，等价于侧栏实际看到的那一份。
const hostPanels = panelsMod.getHostPanelRuntime(root.get('tuiPanels'))
const listed = hostPanels?.list() ?? []
const panel = listed.find(entry => entry.id.endsWith(':ledger'))
check('台账面板注册成功（<pluginId>:ledger）', panel !== undefined, JSON.stringify(listed.map(entry => entry.id)))
if (panel !== undefined) {
  check('面板标题', panel.title === 'DS 官价台账', panel.title)
  check('面板来源是 plugin', panel.source === 'plugin', String(panel.source))
}

// ── 5. 台账：共享事件日志；旧存储只读 open() ─────────────────────────────
check('插件调用了 0.17.0 的 storage.open(ctx)（只读旧台账）', openCalls >= 1, `calls=${openCalls}`)
if (openCalls >= 1) {
  check('直挂行 open() 被宿主拒绝（预期）', openError !== undefined, String(openError))
  check('拒绝码可识别', ['COMPONENT_NOT_ADMITTED', 'PERMISSION_NOT_GRANTED', 'STORAGE_UNAVAILABLE'].includes(openError?.code), String(openError?.code))
}
const instancesDir = join(dataDir, 'instances')
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (existsSync(instancesDir) && readdirSync(instancesDir).some(name => name.endsWith('.jsonl'))) break
  await new Promise(resolve => setTimeout(resolve, 50))
}
const instanceFiles = existsSync(instancesDir)
  ? readdirSync(instancesDir).filter(name => name.endsWith('.jsonl'))
  : []
check('事件日志写到 instances/*.jsonl', instanceFiles.length >= 1, JSON.stringify(instanceFiles))
if (instanceFiles.length > 0) {
  const lines = readFileSync(join(instancesDir, instanceFiles[0]), 'utf8').trim().split('\n').filter(Boolean)
  const first = JSON.parse(lines[0])
  check('事件记在 ollama-pro 的模型名下', first.p === 'ollama-pro' && first.m === 'deepseek-v4-pro:0813', JSON.stringify({ p: first.p, m: first.m }))
  check('事件时间保留原值', first.t === time, String(first.t))
}
check('不再写旧的整份 ledger.json', !existsSync(ledgerFile))

check('接纳过程没有 warn（没有被拒收）', warnings.length === 0, warnings.join(' | '))

await fiber.dispose()
await new Promise(resolve => setTimeout(resolve, 30))
check('卸载后底栏字段撤下', statusStore.getFieldSnapshot().length === 0, String(statusStore.getFieldSnapshot().length))
check('卸载后面板撤下', hostPanels !== undefined && hostPanels.list().length === 0, JSON.stringify(hostPanels?.list().map(entry => entry.id) ?? null))

rmSync(storageDir, { recursive: true, force: true })
rmSync(dataDir, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
