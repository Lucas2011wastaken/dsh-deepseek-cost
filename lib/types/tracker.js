/**
 * 会话事件 → 计价输入的纯解析层。
 *
 * 数据源（接缝一 · 会话事件）：
 *  - `request/header`：请求头快照，`data.header.config` 带 provider + model
 *    （见 @deepseek-ai/dsh-llm 的 LlmCallConfig），是"这笔用量属于谁"的归属源；
 *  - `request/context`：注册路由元数据，也带 provider/model（作为兜底归属源）；
 *  - `assistant/message`：**唯一**携带 `usage` 的持久事件（DSH 没有独立的
 *    usage 事件），`usage` 缺省表示适配器没报账，跳过而不是记 0。
 *
 * 全部按不可信输入解析：形状不对就返回 undefined，绝不抛错。
 */
import { countsOf } from './pricing.js';
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
/** 事件类型（不可信）。 */
export function eventTypeOf(event) {
    return isRecord(event) ? nonEmptyString(event['type']) : undefined;
}
/** 事件时间（ms），缺失时返回 undefined。 */
export function eventTimeOf(event) {
    if (!isRecord(event))
        return undefined;
    const time = event['time'];
    return typeof time === 'number' && Number.isFinite(time) ? time : undefined;
}
/**
 * 从 `request/header` / `request/context` 里读路由归属。
 * provider 与 model 必须同时拿到才算数 —— 拿一半会把用量记到别人的价目上。
 */
export function routeOf(event) {
    const type = eventTypeOf(event);
    if (type !== 'request/header' && type !== 'request/context')
        return undefined;
    if (!isRecord(event))
        return undefined;
    const data = event['data'];
    if (!isRecord(data))
        return undefined;
    if (type === 'request/header') {
        const header = data['header'];
        if (!isRecord(header))
            return undefined;
        const config = header['config'];
        if (!isRecord(config))
            return undefined;
        const provider = nonEmptyString(config['provider']);
        const model = nonEmptyString(config['model']);
        return provider === undefined || model === undefined ? undefined : { provider, model };
    }
    const provider = nonEmptyString(data['provider']);
    const model = nonEmptyString(data['model']);
    return provider === undefined || model === undefined ? undefined : { provider, model };
}
/** 从 `assistant/message` 读一笔用量；无 usage / 全零返回 undefined。 */
export function usageOf(event) {
    if (eventTypeOf(event) !== 'assistant/message')
        return undefined;
    if (!isRecord(event))
        return undefined;
    const data = event['data'];
    if (!isRecord(data))
        return undefined;
    const usage = data['usage'];
    if (!isRecord(usage))
        return undefined;
    const counts = countsOf({
        inputTokens: numberField(usage['inputTokens']),
        outputTokens: numberField(usage['outputTokens']),
        cacheReadTokens: numberField(usage['cacheReadTokens']),
        cacheWriteTokens: numberField(usage['cacheWriteTokens']),
    });
    const total = counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
    return total > 0 ? counts : undefined;
}
function numberField(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** 该会话是否为子代理子会话（用于分侧展示）。 */
export function isSubagentSession(session) {
    if (!isRecord(session))
        return false;
    const header = session['header'];
    if (!isRecord(header))
        return false;
    return header['origin'] === 'subagent' || (typeof header['delegationDepth'] === 'number' && header['delegationDepth'] > 0);
}
/** 会话标识（日志/诊断用）。 */
export function sessionIdOf(session) {
    if (!isRecord(session))
        return '';
    return nonEmptyString(session['id']) ?? '';
}
