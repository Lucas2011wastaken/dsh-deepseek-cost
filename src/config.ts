/**
 * 配置解析：每个键都有默认值，坏值一律回落到默认值，绝不抛错
 * （插件缺失/配置写错时行为退化为"什么都没发生"，不能拖垮 TUI 启动）。
 *
 * `Config` 是本包自己实现的 Standard Schema（`~standard`）—— 生态契约要求
 * 插件导出 `Config`，而本插件的卖点之一是**零运行时依赖**（插件从任意路径
 * 挂载都能 import 成功），所以不为一个 schema 去拉 @deepseek-ai/schemastery。
 * cordis 的 `resolveConfig` 只用 `Config['~standard'].validate()`，这个形状
 * 就够了。
 */

import { CN_HOLIDAYS_2026, DEEPSEEK_PEAK, type PeakRule, type PriceClass } from './pricing.js'

/** 底栏字段的三个槽位（与宿主 `TuiStatusFieldSlot` 同值）。 */
export type StatusSlot = 'left-tail' | 'right-head' | 'right-tail'

/** 底栏字段的语义色（与宿主 `TuiStatusFieldTone` 同值）。 */
export type StatusTone = 'dim' | 'accent' | 'success' | 'warning' | 'error'

/**
 * 写到哪里：
 *  - `auto`（默认）：宿主支持 `tuiStatus.setField` 就用**底栏字段**，否则退回
 *    `tuiStatus.set`（提示框上方那行）；
 *  - `footer`：只用底栏字段；宿主没有这个接口就干脆不显示（不偷偷换位置）；
 *  - `line`：只用旧的状态行，保持 0.1.x 的行为。
 */
export type StatusPlacement = 'auto' | 'footer' | 'line'

export const STATUS_PLACEMENTS: readonly StatusPlacement[] = Object.freeze(['auto', 'footer', 'line'])
export const STATUS_SLOTS: readonly StatusSlot[] = Object.freeze(['left-tail', 'right-head', 'right-tail'])
export const STATUS_TONES: readonly StatusTone[] = Object.freeze(['dim', 'accent', 'success', 'warning', 'error'])

export interface StatusLineConfig {
  /** 是否显示官价。 */
  readonly enabled: boolean
  readonly placement: StatusPlacement
  /** 底栏槽位：默认 `left-tail`，紧跟内建 model/token/cost 之后。 */
  readonly slot: StatusSlot
  /** 底栏字段色；出现未计价 token 时自动升级为 `warning`。 */
  readonly tone: StatusTone
  /** 底栏字段 cell 上限（宿主硬上限 32）。 */
  readonly maxCells: number
  /** 终端窄于此列数时不渲染该字段（0 = 一直显示）。 */
  readonly minColumns: number
  /** 悬停时在补充行给出 token/金额明细。 */
  readonly detail: boolean
  /** 点击字段打开台账面板（需要面板已注册；仅全屏模式有鼠标）。 */
  readonly click: boolean
  /** 是否显示峰/谷标记。 */
  readonly showWindow: boolean
  /** 标签前缀。 */
  readonly label: string
}

export interface PanelUiConfig {
  readonly enabled: boolean
  readonly title: string
  /** 显示宽度必须为 1 个 cell；留空则不设图标。 */
  readonly icon: string
  readonly minColumns: number
  readonly order: number
}

/** 多实例共享台账（每进程一个 append-only JSONL）。 */
export interface StorageConfig {
  readonly enabled: boolean
  /** 台账目录；`instances/`、`quota.json` 都在其下。 */
  readonly dir: string
  /** 扫描其他实例文件的间隔（ms）。 */
  readonly refreshMs: number
  /** 保留天数。 */
  readonly keepDays: number
}

/** Ollama Cloud 配额轮询。 */
export interface QuotaConfig {
  readonly enabled: boolean
  /** 依次尝试的环境变量/凭据名。 */
  readonly apiKeyEnv: readonly string[]
  /** DSH 凭据文件；`~` 会展开。 */
  readonly credentialsFile: string
  readonly baseUrl: string
  readonly pollMs: number
  readonly timeoutMs: number
}

/** 付费月锚点（老套餐没有 monthly period 时用）。 */
export interface BillingConfig {
  /** ISO 8601，例如 `2026-09-15T09:30:00+08:00`；空串 = 没有锚点。 */
  readonly anchor: string
  readonly timezone: string
}

export interface CostConfig {
  readonly enabled: boolean
  /** 哪些 provider 按"这是 DS 官方计费口径"来记账。 */
  readonly providers: readonly string[]
  /** 显式模型归类覆盖：模型 id（可带 `:tag`）→ `flash` / `pro`。 */
  readonly models: Readonly<Record<string, PriceClass>>
  readonly status: StatusLineConfig
  readonly panel: PanelUiConfig
  readonly storage: StorageConfig
  readonly quota: QuotaConfig
  readonly billing: BillingConfig
  /** 覆盖内置的中国法定节假日表（非空即整体替换）。 */
  readonly holidays: readonly string[]
  /** 输出诊断日志（stderr，走 DSH_TUI_DEBUG 之外的自有开关）。 */
  readonly debug: boolean
}

export const DEFAULT_STATUS_KEY = 'deepseek-cost'
/** 侧栏台账面板的单段 slug（宿主会加 `<pluginId>:` 前缀）。 */
export const DEFAULT_PANEL_ID = 'ledger'

export const DEFAULT_CONFIG: CostConfig = Object.freeze({
  enabled: true,
  providers: Object.freeze(['ollama-pro']),
  models: Object.freeze({}),
  status: Object.freeze({
    enabled: true,
    placement: 'auto' as StatusPlacement,
    slot: 'left-tail' as StatusSlot,
    tone: 'dim' as StatusTone,
    maxCells: 28,
    minColumns: 0,
    detail: true,
    click: true,
    showWindow: true,
    label: 'DS官价',
  }),
  // 图标必须恰好 1 个 cell：宿主对 `tuiPanels.register` 的 icon 做
  // `stringWidth(icon) === 1` 校验，宽字形（emoji/CJK）会让**整个面板**被拒收。
  panel: Object.freeze({ enabled: true, title: 'DS 官价台账', icon: '◈', minColumns: 28, order: 50 }),
  storage: Object.freeze({
    enabled: true,
    dir: '~/.dsh-tui/deepseek-cost',
    refreshMs: 10_000,
    keepDays: 45,
  }),
  quota: Object.freeze({
    enabled: true,
    apiKeyEnv: Object.freeze(['OLLAMA_PRO_API_KEY', 'OLLAMA_API_KEY']),
    credentialsFile: '~/.dsh/.credentials.yaml',
    baseUrl: 'https://ollama.com',
    pollMs: 60_000,
    timeoutMs: 8_000,
  }),
  billing: Object.freeze({ anchor: '', timezone: 'Asia/Shanghai' }),
  holidays: Object.freeze([] as string[]),
  debug: false,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < min || value > max) return fallback
  return value
}

function integerOr(value: unknown, fallback: number, min: number, max: number): number {
  const resolved = numberOr(value, fallback, min, max)
  return Number.isInteger(resolved) ? resolved : fallback
}

/**
 * 面板图标是否恰好占 1 个 cell（宿主 `stringWidth(icon) === 1` 才收）。
 * 不追求完整的 Unicode 宽度表：只把会造成 2 cell 的常见区段拒掉，其余按 1
 * 放行——误拒的后果只是没有图标，误收的后果是整个面板不出现。
 */
function isSingleCellIcon(value: string): boolean {
  const points = [...value]
  if (points.length !== 1) return false
  const code = points[0]?.codePointAt(0) ?? 0
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
  if (code < 0x1100) return true
  return !(
    code <= 0x115f // Hangul Jamo
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf) // CJK 部首/符号/假名/汉字
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul 音节
    || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容汉字
    || (code >= 0xfe30 && code <= 0xfe4f) // CJK 兼容形式
    || (code >= 0xff00 && code <= 0xff60) // 全角形式
    || (code >= 0xffe0 && code <= 0xffe6) // 全角符号
    || (code >= 0x1f000 && code <= 0x1faff) // 麻将/扑克/emoji
    || (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展
  )
}

/** 图标留空是合法的（不设图标）；给了宽字形则退成"无图标"而不是丢面板。 */
function iconOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  if (value === '') return ''
  return isSingleCellIcon(value) ? value : ''
}

function oneOf<T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** 允许显式空串（如 billing.anchor 表示"没有锚点"）。 */
function stringOrEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function stringListOr(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return out.length > 0 ? Object.freeze(out) : fallback
}

function priceClassesOr(value: unknown): Readonly<Record<string, PriceClass>> {
  if (!isRecord(value)) return DEFAULT_CONFIG.models
  const out: Record<string, PriceClass> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === 'flash' || raw === 'pro') out[key] = raw
  }
  return Object.freeze(out)
}

/** DeepSeek 官方峰谷规则（节假日可被配置覆盖）。 */
export function deepseekPeakRule(config: CostConfig): PeakRule {
  if (config.holidays.length === 0) return DEEPSEEK_PEAK
  return { ...DEEPSEEK_PEAK, holidays: config.holidays }
}

/** 把任意输入解析成完整配置。永不抛错。 */
export function resolveConfig(raw: unknown): CostConfig {
  if (!isRecord(raw)) return DEFAULT_CONFIG
  const status = isRecord(raw['status']) ? raw['status'] : {}
  const panel = isRecord(raw['panel']) ? raw['panel'] : {}
  const storage = isRecord(raw['storage']) ? raw['storage'] : {}
  const quota = isRecord(raw['quota']) ? raw['quota'] : {}
  const billing = isRecord(raw['billing']) ? raw['billing'] : {}
  const models = priceClassesOr(raw['models'])
  return {
    enabled: boolOr(raw['enabled'], DEFAULT_CONFIG.enabled),
    providers: stringListOr(raw['providers'], DEFAULT_CONFIG.providers),
    models,
    status: {
      enabled: boolOr(status['enabled'], DEFAULT_CONFIG.status.enabled),
      placement: oneOf(status['placement'], DEFAULT_CONFIG.status.placement, STATUS_PLACEMENTS),
      slot: oneOf(status['slot'], DEFAULT_CONFIG.status.slot, STATUS_SLOTS),
      tone: oneOf(status['tone'], DEFAULT_CONFIG.status.tone, STATUS_TONES),
      maxCells: integerOr(status['maxCells'], DEFAULT_CONFIG.status.maxCells, 1, 32),
      minColumns: integerOr(status['minColumns'], DEFAULT_CONFIG.status.minColumns, 0, 400),
      detail: boolOr(status['detail'], DEFAULT_CONFIG.status.detail),
      click: boolOr(status['click'], DEFAULT_CONFIG.status.click),
      showWindow: boolOr(status['showWindow'], DEFAULT_CONFIG.status.showWindow),
      label: stringOr(status['label'], DEFAULT_CONFIG.status.label),
    },
    panel: {
      enabled: boolOr(panel['enabled'], DEFAULT_CONFIG.panel.enabled),
      title: stringOr(panel['title'], DEFAULT_CONFIG.panel.title),
      icon: iconOr(panel['icon'], DEFAULT_CONFIG.panel.icon),
      minColumns: numberOr(panel['minColumns'], DEFAULT_CONFIG.panel.minColumns, 12, 64),
      order: numberOr(panel['order'], DEFAULT_CONFIG.panel.order, -1000, 1000),
    },
    storage: {
      enabled: boolOr(storage['enabled'], DEFAULT_CONFIG.storage.enabled),
      dir: stringOr(storage['dir'], DEFAULT_CONFIG.storage.dir),
      refreshMs: integerOr(storage['refreshMs'], DEFAULT_CONFIG.storage.refreshMs, 2_000, 600_000),
      keepDays: numberOr(storage['keepDays'], DEFAULT_CONFIG.storage.keepDays, 1, 3650),
    },
    quota: {
      enabled: boolOr(quota['enabled'], DEFAULT_CONFIG.quota.enabled),
      apiKeyEnv: stringListOr(quota['apiKeyEnv'], DEFAULT_CONFIG.quota.apiKeyEnv),
      credentialsFile: stringOr(quota['credentialsFile'], DEFAULT_CONFIG.quota.credentialsFile),
      baseUrl: stringOr(quota['baseUrl'], DEFAULT_CONFIG.quota.baseUrl),
      pollMs: integerOr(quota['pollMs'], DEFAULT_CONFIG.quota.pollMs, 30_000, 600_000),
      timeoutMs: integerOr(quota['timeoutMs'], DEFAULT_CONFIG.quota.timeoutMs, 1_000, 30_000),
    },
    billing: {
      anchor: stringOrEmpty(billing['anchor'], DEFAULT_CONFIG.billing.anchor),
      timezone: stringOr(billing['timezone'], DEFAULT_CONFIG.billing.timezone),
    },
    holidays: stringListOr(raw['holidays'], DEFAULT_CONFIG.holidays),
    debug: boolOr(raw['debug'], DEFAULT_CONFIG.debug),
  }
}

/**
 * 插件配置 schema：Standard Schema v1 形状，cordis `resolveConfig` 直接用。
 * `validate` 永不返回 issues —— 这个插件的配置不该有能力让 profile 组合失败。
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'dsh-deepseek-cost',
    validate: (value: unknown): { value: CostConfig } => ({ value: resolveConfig(value) }),
  }),
})
