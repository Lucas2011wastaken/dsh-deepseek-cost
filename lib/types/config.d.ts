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
import { type PeakRule, type PriceClass } from './pricing.js';
/** 底栏字段的三个槽位（与宿主 `TuiStatusFieldSlot` 同值）。 */
export type StatusSlot = 'left-tail' | 'right-head' | 'right-tail';
/** 底栏字段的语义色（与宿主 `TuiStatusFieldTone` 同值）。 */
export type StatusTone = 'dim' | 'accent' | 'success' | 'warning' | 'error';
/**
 * 写到哪里：
 *  - `auto`（默认）：宿主支持 `tuiStatus.setField` 就用**底栏字段**，否则退回
 *    `tuiStatus.set`（提示框上方那行）；
 *  - `footer`：只用底栏字段；宿主没有这个接口就干脆不显示（不偷偷换位置）；
 *  - `line`：只用旧的状态行，保持 0.1.x 的行为。
 */
export type StatusPlacement = 'auto' | 'footer' | 'line';
export declare const STATUS_PLACEMENTS: readonly StatusPlacement[];
export declare const STATUS_SLOTS: readonly StatusSlot[];
export declare const STATUS_TONES: readonly StatusTone[];
export interface StatusLineConfig {
    /** 是否显示官价。 */
    readonly enabled: boolean;
    readonly placement: StatusPlacement;
    /** 底栏槽位：默认 `left-tail`，紧跟内建 model/token/cost 之后。 */
    readonly slot: StatusSlot;
    /** 底栏字段色；出现未计价 token 时自动升级为 `warning`。 */
    readonly tone: StatusTone;
    /** 底栏字段 cell 上限（宿主硬上限 32）。 */
    readonly maxCells: number;
    /** 终端窄于此列数时不渲染该字段（0 = 一直显示）。 */
    readonly minColumns: number;
    /** 悬停时在补充行给出 token/金额明细。 */
    readonly detail: boolean;
    /** 点击字段打开台账面板（需要面板已注册；仅全屏模式有鼠标）。 */
    readonly click: boolean;
    /** 是否显示峰/谷标记。 */
    readonly showWindow: boolean;
    /** 标签前缀。 */
    readonly label: string;
}
export interface PanelUiConfig {
    readonly enabled: boolean;
    readonly title: string;
    /** 显示宽度必须为 1 个 cell；留空则不设图标。 */
    readonly icon: string;
    readonly minColumns: number;
    readonly order: number;
}
/** 多实例共享台账（每进程一个 append-only JSONL）。 */
export interface StorageConfig {
    readonly enabled: boolean;
    /** 台账目录；`instances/`、`quota.json` 都在其下。 */
    readonly dir: string;
    /** 扫描其他实例文件的间隔（ms）。 */
    readonly refreshMs: number;
    /** 保留天数。 */
    readonly keepDays: number;
}
/** Ollama Cloud 配额轮询。 */
export interface QuotaConfig {
    readonly enabled: boolean;
    /** 依次尝试的环境变量/凭据名。 */
    readonly apiKeyEnv: readonly string[];
    /** DSH 凭据文件；`~` 会展开。 */
    readonly credentialsFile: string;
    readonly baseUrl: string;
    readonly pollMs: number;
    readonly timeoutMs: number;
}
/** 付费月锚点（老套餐没有 monthly period 时用）。 */
export interface BillingConfig {
    /** ISO 8601，例如 `2026-09-15T09:30:00+08:00`；空串 = 没有锚点。 */
    readonly anchor: string;
    readonly timezone: string;
}
export interface CostConfig {
    readonly enabled: boolean;
    /** 哪些 provider 按"这是 DS 官方计费口径"来记账。 */
    readonly providers: readonly string[];
    /** 显式模型归类覆盖：模型 id（可带 `:tag`）→ `flash` / `pro`。 */
    readonly models: Readonly<Record<string, PriceClass>>;
    readonly status: StatusLineConfig;
    readonly panel: PanelUiConfig;
    readonly storage: StorageConfig;
    readonly quota: QuotaConfig;
    readonly billing: BillingConfig;
    /** 覆盖内置的中国法定节假日表（非空即整体替换）。 */
    readonly holidays: readonly string[];
    /** 输出诊断日志（stderr，走 DSH_TUI_DEBUG 之外的自有开关）。 */
    readonly debug: boolean;
}
export declare const DEFAULT_STATUS_KEY = "deepseek-cost";
/** 侧栏台账面板的单段 slug（宿主会加 `<pluginId>:` 前缀）。 */
export declare const DEFAULT_PANEL_ID = "ledger";
export declare const DEFAULT_CONFIG: CostConfig;
/** DeepSeek 官方峰谷规则（节假日可被配置覆盖）。 */
export declare function deepseekPeakRule(config: CostConfig): PeakRule;
/** 把任意输入解析成完整配置。永不抛错。 */
export declare function resolveConfig(raw: unknown): CostConfig;
/**
 * 插件配置 schema：Standard Schema v1 形状，cordis `resolveConfig` 直接用。
 * `validate` 永不返回 issues —— 这个插件的配置不该有能力让 profile 组合失败。
 */
export declare const Config: Readonly<{
    '~standard': Readonly<{
        version: 1;
        vendor: "dsh-deepseek-cost";
        validate: (value: unknown) => {
            value: CostConfig;
        };
    }>;
}>;
