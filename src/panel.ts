/**
 * 侧栏台账面板（接缝：`ctx.tuiPanels`）。
 *
 * 布局：
 *  - 顶部：provider + 当前峰/谷；
 *  - 主卡：当前活跃会话（`host.snapshot().sessionId`）的官价 + 输入/缓存读/输出；
 *  - 配额：Ollama `/api/balance` 的 5h / 周 / 付费月剩余量与重置倒计时；
 *  - 区间表：今日 / 本周 / 本月 / 累计（跨 TUI 实例汇总）；
 *  - 脚注：峰谷窗口与下一次切换、台账后端与实例数、未计价模型。
 *
 * 不再展示缓存命中率：内置底栏是「主会话最后一次请求」，这里的任何累计口径
 * 都会和它不一致，混在一起只会让人困惑。
 *
 * 四条纪律：
 *  1. hook 必须用 props 注入的宿主 React（`props.React`），不能 import 自己的；
 *  2. 元素必须由宿主 React 产出 —— 本文件**不用 JSX**，一律
 *     `React.createElement`，因此编译产物里没有 jsx-runtime 依赖；
 *  3. 组件内唯一的定时源是 `ui.useAnimationTime`（宿主共享时钟，离屏自动暂停）；
 *  4. 数据更新仍走 `useSyncExternalStore` 订阅本插件自己的台账 store。
 */

import type { TuiPanelProps } from '@deepseek-harness-tui/dsh-tui/api'
import type { SessionView } from './events.js'
import type { MoneySummary } from './ledger.js'
import { splitModelKey } from './ledger.js'
import { isPeak, type PeakRule } from './pricing.js'
import type { QuotaLimit, QuotaSnapshot } from './quota.js'
import {
  billedInputTokens,
  formatCny,
  formatCnyCompact,
  formatDuration,
  formatPct,
  formatTokens,
  formatUsd,
  nextPeakSwitch,
  peakWindowLine,
} from './render.js'

export interface PanelRangeView {
  readonly id: 'today' | 'week' | 'month' | 'all'
  readonly label: string
  readonly summary: MoneySummary
  readonly from: number
  readonly to: number
  /** 口径说明：`''` / `Ollama 周限` / `自然周` / `付费月` / `自然月`。 */
  readonly note: string
}

export interface PanelSnapshotData {
  readonly providers: readonly string[]
  readonly sessions: Readonly<Record<string, SessionView>>
  readonly lastMainSessionId: string
  readonly ranges: readonly PanelRangeView[]
  readonly peakRule: PeakRule
  readonly nowMs: number
  readonly quota: QuotaSnapshot | undefined
  readonly quotaReason: string
  readonly storage: 'shared-log' | 'memory'
  readonly instances: number
  readonly updatedAt: number
  readonly note: string
}

/** 面板订阅的只读 store；`get` 必须返回稳定引用（useSyncExternalStore 契约）。 */
export interface PanelStore {
  subscribe: (listener: () => void) => () => void
  get: () => PanelSnapshotData
}

const LABEL_WIDTH = 6
const VALUE_WIDTH = 7
const QUOTA_LABEL_WIDTH = 4
/** 四列表格需要的最小内容宽度（label + 金额 + 3 个 token 列 + 间隙）。 */
const TABLE_MIN_COLUMNS = 38
const MAX_BAR_CELLS = 12
const PAD_X = 1

/** 旧宿主面板没有 `ui.Divider` 时的替身：什么都不画，而不是崩掉整块面板。 */
const NoDivider = (): null => null

function storageLabel(kind: 'shared-log' | 'memory'): string {
  return kind === 'shared-log' ? '共享日志' : '内存'
}

/** 剩余量越高越绿，低于 20% 标红。 */
function quotaTone(remainingPercent: number): 'success' | 'warning' | 'error' {
  if (remainingPercent >= 50) return 'success'
  if (remainingPercent >= 20) return 'warning'
  return 'error'
}

/** 面板组件工厂：闭包持有 store，返回宿主可挂载的组件。 */
export function createLedgerPanel(store: PanelStore): (props: TuiPanelProps) => unknown {
  return function LedgerPanel(props: TuiPanelProps): unknown {
    const React = props.React
    const { Box, Text } = props.ui
    // 新面全部 feature-detect：宿主太老时退化成「无分隔线 / 普通 Box / 不自动刷新」。
    const Divider = props.ui.Divider ?? (NoDivider as TuiPanelProps['ui']['Divider'])
    const ScrollBox = props.ui.ScrollBox ?? (Box as unknown as TuiPanelProps['ui']['ScrollBox'])
    const useAnimationTime = props.ui.useAnimationTime ?? ((): number => 0)
    // 订阅走注入的 React：台账每次变更都会让本组件自己重渲染。
    const data: PanelSnapshotData = React.useSyncExternalStore(store.subscribe, store.get)
    // 宿主唯一的合法定时源：只用来让「x 秒前」和配额倒计时每秒刷新一次。
    useAnimationTime(props.visible ? 1000 : null)
    const nowMs = Date.now()

    // 当前活跃会话：面板宿主直接给 sessionId；老宿主退回「最近主会话」。
    const hostSessionId = typeof props.host?.snapshot === 'function'
      ? props.host.snapshot().sessionId
      : ''
    const activeId = hostSessionId !== '' ? hostSessionId : data.lastMainSessionId
    const session = data.sessions[activeId] ?? data.sessions[data.lastMainSessionId]
    const summary = session?.summary
    const unpricedKeys = summary === undefined ? [] : Object.keys(summary.unpriced)
    const sessionLabel = activeId !== '' ? activeId.slice(0, 6) : ''

    // 未计价模型不是记账错误，但也不该悄悄吞掉：面板不在前台时挂 warning 徽标。
    React.useEffect(() => {
      if (unpricedKeys.length > 0 && !props.focused) props.host?.notify?.('warning', unpricedKeys.length)
      else props.host?.clearBadge?.()
    }, [unpricedKeys.length, props.focused])

    if (!props.visible) return null

    const width = Math.max(12, props.width)
    const bodyWidth = Math.max(10, width - PAD_X * 2)
    const wide = bodyWidth >= TABLE_MIN_COLUMNS
    const peak = isPeak(data.peakRule, nowMs)
    const next = nextPeakSwitch(data.peakRule, nowMs)
    const peakColor = peak ? 'warning' : 'success'
    const children: unknown[] = []

    const tokenText = (key: string, label: string, value: number): unknown =>
      React.createElement(
        Text,
        { key },
        React.createElement(Text, { dimColor: true }, `${label} `),
        formatTokens(value),
      )

    /** 剩余量条：fill = 剩余百分比（不是已用），颜色随剩余量降级。 */
    const quotaBar = (key: string, remainingPercent: number): unknown => {
      const barCells = wide
        ? Math.max(6, Math.min(MAX_BAR_CELLS, bodyWidth - 30))
        : Math.max(3, Math.min(8, bodyWidth - 22))
      const filled = Math.max(0, Math.min(barCells, Math.round((remainingPercent / 100) * barCells)))
      return React.createElement(
        Box,
        { key, flexDirection: 'row', width: barCells, flexShrink: 0 },
        React.createElement(Text, { color: quotaTone(remainingPercent) }, '█'.repeat(filled)),
        React.createElement(Text, { dimColor: true }, '░'.repeat(barCells - filled)),
      )
    }

    const quotaLimitRow = (label: string, limit: QuotaLimit): unknown => {
      const remaining = Math.min(100, Math.max(0, limit.remainingPercent))
      const pct = wide ? `剩 ${formatPct(remaining / 100)}` : `剩${String(Math.round(remaining))}%`
      const reset = limit.resetsAt > nowMs ? formatDuration(limit.resetsAt - nowMs) : '即将'
      return React.createElement(
        Box,
        { key: `q-${label}`, flexDirection: 'row', width: '100%', gap: 1 },
        React.createElement(
          Box,
          { width: QUOTA_LABEL_WIDTH, flexShrink: 0 },
          React.createElement(Text, { dimColor: true }, label),
        ),
        React.createElement(Text, { color: quotaTone(remaining) }, pct),
        quotaBar(`qb-${label}`, remaining),
        React.createElement(
          Box,
          { flexGrow: 1, justifyContent: 'flex-end' },
          React.createElement(Text, { dimColor: true }, wide ? `${reset} 后重置` : reset),
        ),
      )
    }

    const quotaMonthlyRow = (quota: QuotaSnapshot): unknown[] => {
      const included = quota.included
      if (included === undefined) return []
      const fraction = included.allowanceUsd > 0 ? included.balanceUsd / included.allowanceUsd : 0
      const remaining = Math.min(100, Math.max(0, fraction * 100))
      const reset = included.period.until > nowMs ? formatDuration(included.period.until - nowMs) : '即将'
      const amount = wide
        ? `${formatUsd(included.balanceUsd)}/$${String(Math.round(included.allowanceUsd))}`
        : `$${String(Math.round(included.balanceUsd))}/$${String(Math.round(included.allowanceUsd))}`
      const out: unknown[] = [
        React.createElement(
          Box,
          { key: 'q-month', flexDirection: 'row', width: '100%', gap: 1 },
          React.createElement(
            Box,
            { width: QUOTA_LABEL_WIDTH, flexShrink: 0 },
            React.createElement(Text, { dimColor: true }, '本月'),
          ),
          React.createElement(Text, { color: quotaTone(remaining) }, amount),
          quotaBar('qb-month', remaining),
          React.createElement(
            Box,
            { flexGrow: 1, justifyContent: 'flex-end' },
            React.createElement(Text, { dimColor: true }, wide ? `${reset} 后重置` : reset),
          ),
        ),
      ]
      if (quota.purchasedUsd !== undefined && quota.purchasedUsd > 0) {
        out.push(React.createElement(
          Text,
          { key: 'q-purchased', dimColor: true },
          `额外余额 ${formatUsd(quota.purchasedUsd)}`,
        ))
      }
      return out
    }

    // ── 顶部：provider + 当前峰/谷 ─────────────────────────────────────
    children.push(React.createElement(
      Box,
      { key: 'head', flexDirection: 'row', width: '100%', gap: 1 },
      React.createElement(
        Box,
        { flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
        React.createElement(
          Text,
          { bold: true, color: 'accent', wrap: 'truncate-end' },
          data.providers.length > 0 ? data.providers.join(' · ') : '未配置 provider',
        ),
      ),
      React.createElement(Text, { color: peakColor }, peak ? '▲ 峰' : '▼ 谷'),
    ))
    children.push(React.createElement(Divider, { key: 'd-head' }))

    // ── 主卡：当前会话 ────────────────────────────────────────────────
    children.push(React.createElement(
      Box,
      { key: 'hero', flexDirection: 'row', width: '100%', gap: 1 },
      React.createElement(
        Text,
        { dimColor: true },
        React.createElement(Text, { dimColor: true }, '本会话'),
        sessionLabel === '' ? '' : ` #${sessionLabel}`,
      ),
      React.createElement(
        Box,
        { flexGrow: 1, justifyContent: 'flex-end' },
        React.createElement(
          Text,
          { bold: true, color: 'accent' },
          summary === undefined ? '—' : formatCny(summary.officialCny),
        ),
      ),
    ))

    const miss = summary === undefined ? 0 : billedInputTokens(summary.tokens)
    const hit = summary?.tokens.cacheRead ?? 0
    const out = summary?.tokens.output ?? 0
    if (miss + hit + out === 0) {
      children.push(React.createElement(Text, { key: 'empty', dimColor: true }, '尚无用量'))
    } else if (wide) {
      children.push(React.createElement(
        Box,
        { key: 'tokens', flexDirection: 'row', width: '100%', gap: 2 },
        tokenText('t-in', '输入', miss),
        tokenText('t-hit', '缓存读', hit),
        tokenText('t-out', '输出', out),
      ))
    } else {
      children.push(React.createElement(
        Box,
        { key: 'tokens', flexDirection: 'row', width: '100%', gap: 1 },
        tokenText('t-in', '输入', miss),
        React.createElement(Text, { key: 't-sep', dimColor: true }, '·'),
        tokenText('t-out', '输出', out),
      ))
      children.push(React.createElement(
        Text,
        { key: 't-hit', dimColor: true },
        React.createElement(Text, { dimColor: true }, '缓存读 '),
        formatTokens(hit),
      ))
    }

    // ── Ollama 配额 ───────────────────────────────────────────────────
    const quota = data.quota
    if (quota !== undefined) {
      children.push(React.createElement(Divider, { key: 'd-quota', title: 'Ollama 配额' }))
      if (quota.session !== undefined) children.push(quotaLimitRow('5h', quota.session))
      if (quota.weekly !== undefined) children.push(quotaLimitRow('周', quota.weekly))
      if (quota.included !== undefined) children.push(...quotaMonthlyRow(quota))
      children.push(React.createElement(
        Text,
        { key: 'q-scope', dimColor: true, wrap: 'truncate-end' },
        wide ? '账户级 · 含非 DS 模型' : '账户级',
      ))
      if (quota.error !== undefined && quota.error !== '') {
        children.push(React.createElement(
          Text,
          { key: 'q-error', color: 'warning', wrap: 'truncate-end' },
          quota.stale ? `旧数据 · ${quota.error}` : quota.error,
        ))
      }
    } else if (data.quotaReason !== '') {
      children.push(React.createElement(
        Text,
        { key: 'q-reason', dimColor: true, wrap: 'truncate-end' },
        `配额 ${data.quotaReason}`,
      ))
    }

    // ── 区间表：今日 / 本周 / 本月 / 累计 ─────────────────────────────
    if (data.ranges.length > 0) {
      children.push(React.createElement(
        Divider,
        { key: 'd-ranges', title: wide ? '口径' : '今日 · 本周 · 本月 · 累计' },
      ))
      if (wide) {
        children.push(React.createElement(
          Box,
          { key: 'r-head', flexDirection: 'row', width: '100%', gap: 1 },
          React.createElement(Box, { width: LABEL_WIDTH, flexShrink: 0 }),
          React.createElement(
            Box,
            { flexGrow: 1, justifyContent: 'flex-end' },
            React.createElement(Text, { dimColor: true }, '官价'),
          ),
          React.createElement(
            Box,
            { width: VALUE_WIDTH, justifyContent: 'flex-end' },
            React.createElement(Text, { dimColor: true }, '输入'),
          ),
          React.createElement(
            Box,
            { width: VALUE_WIDTH, justifyContent: 'flex-end' },
            React.createElement(Text, { dimColor: true }, '缓存读'),
          ),
          React.createElement(
            Box,
            { width: VALUE_WIDTH, justifyContent: 'flex-end' },
            React.createElement(Text, { dimColor: true }, '输出'),
          ),
        ))
      }
      const maxAmount = Math.max(1, ...data.ranges.map(range => range.summary.officialCny))
      for (const range of data.ranges) {
        const amount = range.summary.officialCny
        if (wide) {
          children.push(React.createElement(
            Box,
            { key: `r-${range.id}`, flexDirection: 'row', width: '100%', gap: 1 },
            React.createElement(
              Box,
              { width: LABEL_WIDTH, flexShrink: 0 },
              React.createElement(Text, { dimColor: true }, range.label),
            ),
            React.createElement(
              Box,
              { flexGrow: 1, justifyContent: 'flex-end' },
              React.createElement(Text, null, formatCnyCompact(amount)),
            ),
            React.createElement(
              Box,
              { width: VALUE_WIDTH, justifyContent: 'flex-end' },
              React.createElement(Text, { dimColor: true }, formatTokens(billedInputTokens(range.summary.tokens))),
            ),
            React.createElement(
              Box,
              { width: VALUE_WIDTH, justifyContent: 'flex-end' },
              React.createElement(Text, { dimColor: true }, formatTokens(range.summary.tokens.cacheRead)),
            ),
            React.createElement(
              Box,
              { width: VALUE_WIDTH, justifyContent: 'flex-end' },
              React.createElement(Text, { dimColor: true }, formatTokens(range.summary.tokens.output)),
            ),
          ))
        } else {
          const barCells = Math.max(3, Math.min(MAX_BAR_CELLS, bodyWidth - LABEL_WIDTH - 11))
          const filled = amount > 0 ? Math.max(1, Math.round((amount / maxAmount) * barCells)) : 0
          children.push(React.createElement(
            Box,
            { key: `r-${range.id}`, flexDirection: 'row', width: '100%', gap: 1 },
            React.createElement(
              Box,
              { width: LABEL_WIDTH, flexShrink: 0 },
              React.createElement(Text, { dimColor: true }, range.label),
            ),
            React.createElement(
              Box,
              { width: 9, justifyContent: 'flex-end' },
              React.createElement(Text, null, formatCnyCompact(amount)),
            ),
            React.createElement(
              Box,
              { flexGrow: 1, justifyContent: 'flex-end' },
              React.createElement(Text, { color: 'accent' }, '▰'.repeat(filled)),
            ),
          ))
        }
      }
      const notes = data.ranges
        .filter(range => range.note !== '')
        .map(range => `${range.id === 'week' ? '周' : '月'}=${range.note}`)
      if (notes.length > 0) {
        children.push(React.createElement(
          Text,
          { key: 'r-note', dimColor: true, wrap: 'truncate-end' },
          notes.join(' · '),
        ))
      }
      if (data.ranges.some(range => range.id === 'month' && range.note === '自然月')) {
        children.push(React.createElement(
          Text,
          { key: 'r-anchor', dimColor: true, wrap: 'truncate-end' },
          '付费月未配置 · billing.anchor',
        ))
      }
    }

    // ── 脚注：峰谷窗口 / 台账 / 未计价 ────────────────────────────────
    children.push(React.createElement(Divider, { key: 'd-foot' }))
    children.push(React.createElement(
      Text,
      { key: 'f-window', dimColor: true, wrap: 'truncate-end' },
      peakWindowLine(data.peakRule),
    ))
    if (next !== undefined) {
      children.push(React.createElement(
        Box,
        { key: 'f-now', flexDirection: 'row', width: '100%', gap: 1 },
        React.createElement(Text, { color: peakColor }, peak ? '现在峰' : '现在谷'),
        React.createElement(Text, { dimColor: true }, '·'),
        React.createElement(
          Text,
          { dimColor: true },
          `${formatDuration(next.atMs - nowMs)} 后转${next.toPeak ? '峰' : '谷'}`,
        ),
      ))
    } else {
      children.push(React.createElement(Text, { key: 'f-now', color: peakColor }, peak ? '现在峰' : '现在谷'))
    }
    children.push(React.createElement(
      Text,
      { key: 'f-store', dimColor: true, wrap: 'truncate-end' },
      `台账 ${storageLabel(data.storage)} · ${String(data.instances)} 实例 · ${data.updatedAt > 0 ? `${formatAgo(nowMs, data.updatedAt)}更新` : '尚无记录'}`,
    ))
    if (session !== undefined && unpricedKeys.length > 0) {
      const entries = Object.entries(session.summary.unpriced)
      const names = entries.slice(0, 2).map(([key]) => splitModelKey(key).model)
      const more = entries.length > names.length ? ` 等 ${String(entries.length)} 个` : ''
      const total = entries.reduce((sum, [, value]) => sum + value, 0)
      children.push(React.createElement(
        Text,
        { key: 'f-unpriced', color: 'warning', wrap: 'truncate-end' },
        `未计价 ${names.join(' · ')}${more} · ${formatTokens(total)} tokens`,
      ))
    }
    if (data.note !== '') {
      children.push(React.createElement(
        Text,
        { key: 'f-note', color: 'warning', wrap: 'truncate-end' },
        data.note,
      ))
    }

    return React.createElement(
      Box,
      {
        flexDirection: 'column',
        width,
        flexShrink: 0,
        paddingLeft: PAD_X,
        paddingRight: PAD_X,
      },
      React.createElement(
        ScrollBox,
        {
          flexDirection: 'column',
          flexGrow: 1,
          maxHeight: Math.max(3, props.height),
        },
        ...children,
      ),
    )
  }
}

function formatAgo(nowMs: number, then: number): string {
  const delta = Math.max(0, nowMs - then)
  if (delta < 5000) return '刚刚'
  if (delta < 60_000) return `${String(Math.round(delta / 1000))}s 前`
  if (delta < 3_600_000) return `${String(Math.round(delta / 60_000))}min 前`
  return `${String(Math.round(delta / 3_600_000))}h 前`
}
