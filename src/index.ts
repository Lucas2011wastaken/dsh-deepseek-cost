/**
 * deepseek-cost —— 给 ollama-pro 上的 DeepSeek 模型套上 DeepSeek 官方计价系统。
 *
 * 为什么需要它：dsh-tui 内建的花费估算（`src/deepseekPricing.ts`）只对
 * `deepseek-official` 路由渲染，且价目表按前缀匹配、认不出 ollama 的
 * `deepseek-v4.1-flash` / `deepseek-v4-pro:0813`。本插件在**不改主包**的前提下，
 * 用官方价目给 ollama-pro 的用量记账，并把结果放回 TUI：
 *
 *  - 底栏字段：`ctx.tuiStatus.setField`（提示框下方那行，紧跟内建 model/cost；
 *    悬停给 token/金额明细，点击打开台账面板）；宿主没有这个加法时回退到
 *    `ctx.tuiStatus.set`（提示框上方一行）；
 *  - 侧栏台账：`ctx.tuiPanels`，本会话/今日/本周/本月/累计 × 输入/缓存读/输出 × 官价；
 *  - Ollama 配额：`GET /api/balance`（老套餐 session/weekly，新套餐 monthly period）。
 *
 * 多开：每进程一个 append-only JSONL（`instances/<id>.jsonl`），启动/定时增量
 * 读取其他实例的文件；「本会话」只算当前进程/当前会话，跨实例只汇总时间窗。
 *
 * 设计取舍：
 *  - **零运行时依赖**：没有 JSX、没有 YAML 库、没有 npm import。
 *  - 只读会话事件，不 append 到会话：不会让会话不可 resume。
 *  - 认不出的模型只报 token 不给金额（宁可不显示，不给错数）。
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only：解析 `session/event` / `session/disposed` 的 cordis 事件声明。
import type {} from '@deepseek-ai/dsh-session'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Config, deepseekPeakRule, DEFAULT_PANEL_ID, DEFAULT_STATUS_KEY, resolveConfig } from './config.js'
import { readBillingAnchorFile } from './billing.js'
import { expandHome, migrateLegacyDoc, UsageLog, type UsageEvent } from './events.js'
import { addSlots, normalizeDoc, summarize, ZERO_SLOTS, type DayLedger, type LedgerDoc, type MoneySummary } from './ledger.js'
import { isPeak, type CostSlots, type TokenCounts } from './pricing.js'
import { QuotaClient } from './quota.js'
import { buildRangeSet, parseAnchor } from './ranges.js'
import { createLedgerPanel, type PanelRangeView, type PanelSnapshotData, type PanelStore } from './panel.js'
import { statusFieldDetail, statusFieldText, statusLineText } from './render.js'
import { eventTimeOf, isSubagentSession, routeOf, sessionIdOf, usageOf } from './tracker.js'

export const name = 'deepseek-cost'
export { Config }
export type { CostConfig } from './config.js'

// ── 宿主服务的结构视图（只声明用到的部分，不 import 主包运行时）──────────

/** 宿主 `TuiStatusFieldOptions` 的结构视图（只声明用到的部分）。 */
interface TuiStatusFieldOptionsLike {
  readonly slot?: 'left-tail' | 'right-head' | 'right-tail'
  readonly tone?: 'dim' | 'accent' | 'success' | 'warning' | 'error'
  readonly maxCells?: number
  readonly minColumns?: number
  readonly detail?: string
  readonly onClick?: () => void
}

interface TuiStatusLike {
  set(key: string, text: string | number | boolean | undefined): (() => void) | undefined
  /** 接缝十一的加法：底栏键控字段（宿主版本足够新时才有）。 */
  setField?(
    key: string,
    text: string | number | boolean | undefined,
    options?: TuiStatusFieldOptionsLike,
  ): (() => void) | undefined
}

interface TuiPanelSummaryLike {
  readonly id: string
  readonly title?: string
}

interface TuiPanelsLike {
  register(descriptor: {
    readonly apiVersion: 1
    readonly id: string
    readonly title: string
    readonly icon?: string
    readonly minColumns?: number
    readonly order?: number
    readonly component?: unknown
  }): (() => void) | undefined
  /** 老宿主可能没有 list/open：没有就不给字段挂点击。 */
  list?(): readonly TuiPanelSummaryLike[]
  open?(id: string): boolean
}

/** `storage.dsh/v1alpha1#LocalStorage` 的句柄形状（只读旧台账用）。 */
interface TuiPluginStorageHandle {
  get(input: { key: string }): Promise<{ value: unknown | null }>
}

interface TuiPluginStorageLike {
  open?(ctx: Context): TuiPluginStorageHandle
  get?(input: { key: string }): Promise<{ value: unknown | null }>
}

/** 面板尺寸/主题由宿主注入，这里只用到 width/height/React/ui。 */
type PanelComponent = (props: never) => unknown

const LEDGER_KEY = 'ledger:v1'

/**
 * 把 `ctx.tuiPluginStorage` 解析成只读句柄。
 *
 * 优先 0.17.0 的 `open(ctx)`；没有 `open` 的老形状/测试桩再退回服务上的
 * `get`。任何一步抛错都返回 `undefined`，由调用方降级——存储失败绝不该
 * 影响记账本身。
 */
function openStorageHandle(service: TuiPluginStorageLike, caller: Context | undefined): TuiPluginStorageHandle | undefined {
  if (typeof service.open === 'function' && caller !== undefined) {
    try {
      const handle = service.open(caller)
      if (handle !== undefined && handle !== null) return handle
    } catch {
      // 没有准入身份 / 未授权 / 契约未声明：预期路径，回落文件。
      return undefined
    }
  }
  if (typeof service.get === 'function') return service as TuiPluginStorageHandle
  return undefined
}

function safeGet<T>(ctx: Context, serviceName: string): T | undefined {
  try {
    return ctx.get(serviceName, false) as T | undefined
  } catch {
    return undefined
  }
}

// ── 插件入口 ──────────────────────────────────────────────────────────

/** 一个会话的实时状态（路由归属 + 稳定 id）。 */
interface SessionState {
  readonly id: string
  provider: string
  model: string
  subagent: boolean
}

export function apply(ctx: Context, rawConfig: unknown = {}): void {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const dsRule = deepseekPeakRule(config)
  const storageDir = expandHome(config.storage.dir)
  const legacyFile = join(storageDir, 'ledger.json')
  // 付费月锚点：config 非空优先；否则读 <storage.dir>/billing-anchor，
  // 让用户不必改 profile 的 cordis.patch.yml。
  const billingAnchorText = config.billing.anchor.trim() !== ''
    ? config.billing.anchor
    : readBillingAnchorFile(storageDir)
  const billingAnchorMs = parseAnchor(billingAnchorText)

  // 服务在 apply 时还不存在，所以用 inject 捕获；迁移时再尝试读旧台账。
  let storageService: TuiPluginStorageLike | undefined
  let storageCaller: Context | undefined
  ctx.inject(['tuiPluginStorage'] as never, ((storageCtx: Context) => {
    storageService = safeGet<TuiPluginStorageLike>(storageCtx, 'tuiPluginStorage')
    storageCaller = storageCtx
  }) as never)

  const log = new UsageLog({ dir: storageDir, keepDays: config.storage.keepDays, persist: config.storage.enabled })
  const quota = new QuotaClient(config.quota, storageDir)
  const sessions = new Map<object, SessionState>()
  let anonymousSession = 0

  /** 面板/状态行的失效计数：任何数据变化都 +1。 */
  let version = 0
  const listeners = new Set<() => void>()
  const notify = (): void => {
    version += 1
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅者抛错不影响其他订阅者，也不影响台账本身。
      }
    }
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  quota.subscribe(notify)

  const sessionStateFor = (session: unknown): SessionState => {
    const key = (session ?? {}) as object
    let state = sessions.get(key)
    if (state === undefined) {
      anonymousSession += 1
      state = {
        id: sessionIdOf(session) || `local-${anonymousSession.toString(36)}`,
        provider: '',
        model: '',
        subagent: isSubagentSession(session),
      }
      sessions.set(key, state)
    }
    return state
  }

  /**
   * 读取旧台账：插件存储 + 文件后端两处都试，合并后一次性迁移成事件。
   * `open()` 需要准入身份；直挂行会抛错，此时只读文件。
   */
  const loadLegacyDoc = async (): Promise<LedgerDoc | undefined> => {
    if (!config.storage.enabled) return undefined
    const docs: LedgerDoc[] = []
    const storage = storageService
    const caller = storageCaller
    if (storage !== undefined && caller !== undefined) {
      const handle = openStorageHandle(storage, caller)
      if (handle !== undefined) {
        try {
          const result = await handle.get({ key: LEDGER_KEY })
          if (result.value !== null && result.value !== undefined) {
            docs.push(normalizeDoc(result.value, Date.now()))
          }
        } catch {
          // 未准入/被撤销：换文件来源。
        }
      }
    }
    try {
      const text = await readFile(legacyFile, 'utf8')
      docs.push(normalizeDoc(JSON.parse(text), Date.now()))
    } catch {
      // 没有旧文件是正常路径。
    }
    const merged = docs.reduce<LedgerDoc | undefined>((into, doc) => {
      if (into === undefined) return doc
      return mergeDocs(into, doc)
    }, undefined)
    return merged !== undefined && Object.keys(merged.days).length > 0 ? merged : undefined
  }

  // ── 初始化：建目录、载入旧事件、迁移旧台账、启动配额轮询 ─────────────
  let initialized = false
  const ensureInitialized = (): void => {
    if (initialized) return
    initialized = true
    void (async () => {
      // 给服务行一点时间挂载（apply 早于宿主服务行）。
      if (storageService === undefined) await new Promise(resolve => setTimeout(resolve, 60))
      await log.init()
      if (config.storage.enabled) {
        const legacy = await loadLegacyDoc()
        if (legacy !== undefined) {
          await migrateLegacyDoc(legacy, { dir: storageDir, instancesDir: log.instancesDir })
          await log.refresh()
        }
      }
      notify()
      publishStatus()
      await quota.start()
      notify()
    })().catch(() => {
      // 初始化失败只影响历史/配额；当前进程的实时记账仍可用。
    })
  }

  // ── 面板快照 ─────────────────────────────────────────────────────────

  const buildSnapshot = (): PanelSnapshotData => {
    ensureInitialized()
    const nowMs = Date.now()
    const quotaSnapshot = quota.getSnapshot()
    const rangeSet = buildRangeSet(nowMs, quotaSnapshot, billingAnchorMs)
    const ranges: PanelRangeView[] = [
      { id: 'today', label: '今日', summary: log.summaryOfWindow(rangeSet.today.from, rangeSet.today.to), from: rangeSet.today.from, to: rangeSet.today.to, note: rangeSet.today.note },
      { id: 'week', label: '本周', summary: log.summaryOfWindow(rangeSet.week.from, rangeSet.week.to), from: rangeSet.week.from, to: rangeSet.week.to, note: rangeSet.week.note },
      { id: 'month', label: '本月', summary: log.summaryOfWindow(rangeSet.month.from, rangeSet.month.to), from: rangeSet.month.from, to: rangeSet.month.to, note: rangeSet.month.note },
      { id: 'all', label: '累计', summary: log.summaryOfWindow(rangeSet.all.from, rangeSet.all.to), from: rangeSet.all.from, to: rangeSet.all.to, note: rangeSet.all.note },
    ]
    return {
      providers: config.providers,
      sessions: log.sessionViews(),
      lastMainSessionId: log.lastMain,
      ranges,
      peakRule: dsRule,
      nowMs,
      quota: quotaSnapshot,
      quotaReason: config.quota.enabled ? quota.getReason() : '',
      storage: config.storage.enabled ? 'shared-log' : 'memory',
      instances: log.instances,
      updatedAt: log.lastUpdatedAt,
      note: config.providers.length === 0 ? 'providers 为空：不会记账' : '',
    }
  }

  let snapshot: { version: number; data: PanelSnapshotData } | undefined
  const getSnapshot = (): PanelSnapshotData => {
    if (snapshot === undefined || snapshot.version !== version) {
      snapshot = { version, data: buildSnapshot() }
    }
    return snapshot.data
  }
  const panelStore: PanelStore = { subscribe, get: getSnapshot }

  // ── 状态行 / 底栏字段（接缝十一）────────────────────────────────────

  /** 打开台账面板（面板注册成功且宿主给了 list/open 才有）。 */
  let openLedger: (() => void) | undefined

  interface StatusTarget {
    readonly mode: 'footer' | 'line'
    set(text: string | undefined, options: TuiStatusFieldOptionsLike | undefined): void
  }
  let statusTarget: StatusTarget | undefined
  let lastStatusKey: string | undefined
  /** 是否真的写过一次：零用量时一个 set 都不发（内建 cost 槽同纪律）。 */
  let published = false

  const publishStatus = (): void => {
    const target = statusTarget
    if (target === undefined) return
    let text: string | undefined
    let options: TuiStatusFieldOptionsLike | undefined
    try {
      ensureInitialized()
      const sid = log.lastMain
      // 不把旧台账迁移出来的匿名事件算进「本会话」。
      const summary: MoneySummary = sid === '' ? summarize({}) : log.summaryOfSession(sid)
      const input = {
        summary,
        peakRule: dsRule,
        nowMs: Date.now(),
        label: config.status.label,
        showWindow: config.status.showWindow,
      }
      if (target.mode === 'footer') {
        // 可点必须同时有说明（宿主硬规则），所以 click 打开时 detail 强制带上。
        const clickable = config.status.click && openLedger !== undefined
        const detail = config.status.detail || clickable
          ? statusFieldDetail({ ...input, clickable })
          : undefined
        text = statusFieldText(input)
        options = {
          slot: config.status.slot,
          // 认不出的模型只报 token 不给金额 —— 用 warning 把这件事故意露出来。
          tone: summary.unpricedTokens > 0 ? 'warning' : config.status.tone,
          maxCells: config.status.maxCells,
          minColumns: config.status.minColumns,
          ...(detail === undefined ? {} : { detail }),
          ...(clickable && detail !== undefined
            ? { onClick: () => { openLedger?.() } }
            : {}),
        }
      } else {
        text = statusLineText(input)
      }
    } catch {
      return
    }
    const next = text === '' ? undefined : text
    // 还没写过、这次也没内容：不发调用（避免首帧一次无意义的清除）。
    if (next === undefined && !published) return
    // 文本与选项一起比较：面板注册后多出点击时，即使金额没变也要重设一次。
    const key = `${next ?? ''}\u0000${statusOptionsKey(options)}`
    if (key === lastStatusKey) return
    lastStatusKey = key
    published = true
    try {
      target.set(next, options)
    } catch {
      // 状态行被撤下/拒绝：静默降级，面板仍然可用。
    }
  }

  ctx.inject(['tuiStatus'] as never, ((statusCtx: Context) => {
    if (!config.status.enabled) return
    const status = safeGet<TuiStatusLike>(statusCtx, 'tuiStatus')
    if (status === undefined) return
    const canFooter = typeof status.setField === 'function'
    if (config.status.placement === 'footer' && !canFooter) {
      // 明确要求底栏而宿主给不了：不偷偷换到提示框上方，只告警。
      ctx.logger?.warn?.('[deepseek-cost] status.placement=footer，但本宿主没有 tuiStatus.setField：状态字段不显示')
      return
    }
    const footer = config.status.placement !== 'line' && canFooter
    if (!footer && typeof status.set !== 'function') return
    // disposer 由**第一次成功的写入**给出，所以零用量时一个 set 都不发。
    let handle: (() => void) | undefined
    statusTarget = {
      mode: footer ? 'footer' : 'line',
      set(text, options) {
        try {
          handle = footer
            ? status.setField?.(DEFAULT_STATUS_KEY, text, options) ?? handle
            : status.set(DEFAULT_STATUS_KEY, text) ?? handle
        } catch {
          // 忽略：展示是纯副作用，失败不影响记账。
        }
      },
    }
    publishStatus()
    statusCtx.effect(() => () => {
      statusTarget = undefined
      lastStatusKey = undefined
      published = false
      try {
        handle?.()
      } catch {
        // 清理失败不抛。
      }
    }, 'deepseek-cost status')
  }) as never)

  // ── 侧栏台账面板 ────────────────────────────────────────────────────

  ctx.inject(['tuiPanels'] as never, ((panelCtx: Context) => {
    if (!config.panel.enabled) return
    const panels = safeGet<TuiPanelsLike>(panelCtx, 'tuiPanels')
    if (panels === undefined) return
    let dispose: (() => void) | undefined
    try {
      dispose = panels.register({
        apiVersion: 1,
        id: DEFAULT_PANEL_ID,
        title: config.panel.title,
        ...(config.panel.icon === '' ? {} : { icon: config.panel.icon }),
        minColumns: config.panel.minColumns,
        order: config.panel.order,
        component: createLedgerPanel(panelStore) as unknown as PanelComponent,
      })
    } catch (error) {
      ctx.logger?.warn?.(`[deepseek-cost] tuiPanels.register failed: ${String(error)}`)
      return
    }
    // 宿主给面板加 `<pluginId>:` 前缀，注册后用 list() 读回最终 id。
    try {
      const listed = typeof panels.list === 'function' ? panels.list() : []
      const own = listed.find(entry => entry.id.endsWith(`:${DEFAULT_PANEL_ID}`))
        ?? (listed.length === 1 ? listed[0] : undefined)
      if (own !== undefined && typeof panels.open === 'function') {
        const open = panels.open.bind(panels)
        const id = own.id
        openLedger = () => {
          try {
            open(id)
          } catch {
            // 打开失败不影响展示；下一帧照常。
          }
        }
        // 字段可能已经先写上去过（无点击版），这里补一次带点击的重设。
        publishStatus()
      }
    } catch {
      // list 抛错：字段仍可用，只是不可点。
    }
    panelCtx.effect(() => () => {
      openLedger = undefined
      try {
        dispose?.()
      } catch {
        // 清理失败不抛。
      }
    }, 'deepseek-cost panel')
  }) as never)

  // ── 会话事件折叠（接缝一，只读）─────────────────────────────────────

  ctx.on('session/event', ((session: unknown, event: unknown) => {
    const route = routeOf(event)
    if (route !== undefined) {
      const state = sessionStateFor(session)
      state.subagent = isSubagentSession(session)
      if (config.providers.includes(route.provider)) {
        state.provider = route.provider
        state.model = route.model
      } else {
        // 非目标 provider：清掉归属，避免把别的路由的用量记到 DS 价目上。
        state.provider = ''
        state.model = ''
      }
      return
    }
    const usage = usageOf(event)
    if (usage === undefined) return
    const state = sessions.get((session ?? {}) as object)
    if (state === undefined || state.provider === '' || state.model === '') return
    state.subagent = isSubagentSession(session)
    const timeMs = eventTimeOf(event) ?? Date.now()
    const eventRecord: UsageEvent = {
      t: timeMs,
      sid: state.id,
      provider: state.provider,
      model: state.model,
      subagent: state.subagent,
      peak: isPeak(dsRule, timeMs),
      counts: usage,
    }
    ensureInitialized()
    log.append(eventRecord)
    publishStatus()
    notify()
  }) as never)

  ctx.on('session/disposed' as never, ((session: unknown) => {
    sessions.delete((session ?? {}) as object)
    publishStatus()
    notify()
  }) as never)

  // ── 定时器：跨实例增量刷新 + 峰谷翻转 + 旧文件裁剪 ──────────────────

  let lastPruneAt = 0
  const refreshTimer = setInterval(() => {
    if (!config.storage.enabled) return
    void log.refresh().then((changed) => {
      if (changed) {
        publishStatus()
        notify()
      }
      if (Date.now() - lastPruneAt > 86_400_000) {
        lastPruneAt = Date.now()
        void log.pruneOwn()
        void log.pruneDead()
      }
    })
  }, config.storage.refreshMs)
  refreshTimer.unref?.()

  const heartbeat = setInterval(() => {
    publishStatus()
    notify()
  }, 60_000)
  heartbeat.unref?.()

  ctx.effect(() => () => {
    clearInterval(refreshTimer)
    clearInterval(heartbeat)
    quota.stop()
    void log.flush()
  }, 'deepseek-cost lifecycle')

  ctx.logger?.info?.(
    `[deepseek-cost] providers=${config.providers.join(',') || '(none)'} status=${config.status.enabled ? config.status.placement : 'off'} panel=${String(config.panel.enabled)} storage=${config.storage.enabled ? 'shared-log' : 'memory'} quota=${String(config.quota.enabled)}`,
  )
  if (config.debug) {
    ctx.logger?.info?.(`[deepseek-cost] config=${JSON.stringify(config)}`)
  }
  void ensureInitialized()
}

/**
 * 底栏选项的稳定指纹：文本没变但 tone/slot/detail/可点性变了时，仍要重设一次。
 * 只拼接展示用字段，不碰回调。
 */
function statusOptionsKey(options: TuiStatusFieldOptionsLike | undefined): string {
  if (options === undefined) return ''
  return [
    options.slot ?? '',
    options.tone ?? '',
    String(options.maxCells ?? ''),
    String(options.minColumns ?? ''),
    options.detail ?? '',
    options.onClick === undefined ? '' : 'click',
  ].join('|')
}

/** 把两处旧台账（插件存储 + 文件）合并成一份；同一天同一模型相加。 */
function mergeDocs(into: LedgerDoc, from: LedgerDoc): LedgerDoc {
  const days: Record<string, DayLedger> = { ...into.days }
  for (const [dateKey, day] of Object.entries(from.days)) {
    const merged: DayLedger = { ...(days[dateKey] ?? {}) }
    for (const [key, slots] of Object.entries(day)) {
      const existing = merged[key]
      // 两个后端可能记录过同一份台账；完全相同的桶不再相加。
      if (existing !== undefined && sameSlots(existing, slots)) continue
      merged[key] = addSlots(existing ?? ZERO_SLOTS, slots)
    }
    days[dateKey] = merged
  }
  return { ...into, since: Math.min(into.since, from.since), days }
}

function sameCounts(a: TokenCounts, b: TokenCounts): boolean {
  return a.input === b.input
    && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite
    && a.output === b.output
}

function sameSlots(a: CostSlots, b: CostSlots): boolean {
  return sameCounts(a.peak, b.peak) && sameCounts(a.idle, b.idle)
}
