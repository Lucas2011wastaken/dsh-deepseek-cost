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
import { CN_HOLIDAYS_2026, DEEPSEEK_PEAK } from './pricing.js';
export const STATUS_PLACEMENTS = Object.freeze(['auto', 'footer', 'line']);
export const STATUS_SLOTS = Object.freeze(['left-tail', 'right-head', 'right-tail']);
export const STATUS_TONES = Object.freeze(['dim', 'accent', 'success', 'warning', 'error']);
export const DEFAULT_STATUS_KEY = 'deepseek-cost';
/** 侧栏台账面板的单段 slug（宿主会加 `<pluginId>:` 前缀）。 */
export const DEFAULT_PANEL_ID = 'ledger';
export const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    providers: Object.freeze(['ollama-pro']),
    models: Object.freeze({}),
    status: Object.freeze({
        enabled: true,
        placement: 'auto',
        slot: 'left-tail',
        tone: 'dim',
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
    holidays: Object.freeze([]),
    debug: false,
});
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boolOr(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function numberOr(value, fallback, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    if (value < min || value > max)
        return fallback;
    return value;
}
function integerOr(value, fallback, min, max) {
    const resolved = numberOr(value, fallback, min, max);
    return Number.isInteger(resolved) ? resolved : fallback;
}
/**
 * 面板图标是否恰好占 1 个 cell（宿主 `stringWidth(icon) === 1` 才收）。
 * 不追求完整的 Unicode 宽度表：只把会造成 2 cell 的常见区段拒掉，其余按 1
 * 放行——误拒的后果只是没有图标，误收的后果是整个面板不出现。
 */
function isSingleCellIcon(value) {
    const points = [...value];
    if (points.length !== 1)
        return false;
    const code = points[0]?.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
        return false;
    if (code < 0x1100)
        return true;
    return !(code <= 0x115f // Hangul Jamo
        || code === 0x2329 || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf) // CJK 部首/符号/假名/汉字
        || (code >= 0xac00 && code <= 0xd7a3) // Hangul 音节
        || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容汉字
        || (code >= 0xfe30 && code <= 0xfe4f) // CJK 兼容形式
        || (code >= 0xff00 && code <= 0xff60) // 全角形式
        || (code >= 0xffe0 && code <= 0xffe6) // 全角符号
        || (code >= 0x1f000 && code <= 0x1faff) // 麻将/扑克/emoji
        || (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展
    );
}
/** 图标留空是合法的（不设图标）；给了宽字形则退成"无图标"而不是丢面板。 */
function iconOr(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    if (value === '')
        return '';
    return isSingleCellIcon(value) ? value : '';
}
function oneOf(value, fallback, allowed) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
function stringOr(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}
/** 允许显式空串（如 billing.anchor 表示"没有锚点"）。 */
function stringOrEmpty(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}
function stringListOr(value, fallback) {
    if (!Array.isArray(value))
        return fallback;
    const out = value.filter((item) => typeof item === 'string' && item.trim() !== '');
    return out.length > 0 ? Object.freeze(out) : fallback;
}
function priceClassesOr(value) {
    if (!isRecord(value))
        return DEFAULT_CONFIG.models;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === 'flash' || raw === 'pro')
            out[key] = raw;
    }
    return Object.freeze(out);
}
/** DeepSeek 官方峰谷规则（节假日可被配置覆盖）。 */
export function deepseekPeakRule(config) {
    if (config.holidays.length === 0)
        return DEEPSEEK_PEAK;
    return { ...DEEPSEEK_PEAK, holidays: config.holidays };
}
/** 把任意输入解析成完整配置。永不抛错。 */
export function resolveConfig(raw) {
    if (!isRecord(raw))
        return DEFAULT_CONFIG;
    const status = isRecord(raw['status']) ? raw['status'] : {};
    const panel = isRecord(raw['panel']) ? raw['panel'] : {};
    const storage = isRecord(raw['storage']) ? raw['storage'] : {};
    const quota = isRecord(raw['quota']) ? raw['quota'] : {};
    const billing = isRecord(raw['billing']) ? raw['billing'] : {};
    const models = priceClassesOr(raw['models']);
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
    };
}
/**
 * 插件配置 schema：Standard Schema v1 形状，cordis `resolveConfig` 直接用。
 * `validate` 永不返回 issues —— 这个插件的配置不该有能力让 profile 组合失败。
 */
export const Config = Object.freeze({
    '~standard': Object.freeze({
        version: 1,
        vendor: 'dsh-deepseek-cost',
        validate: (value) => ({ value: resolveConfig(value) }),
    }),
});
