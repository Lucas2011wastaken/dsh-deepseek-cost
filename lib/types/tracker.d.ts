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
import { type TokenCounts } from './pricing.js';
export interface RouteInfo {
    readonly provider: string;
    readonly model: string;
}
/** 事件类型（不可信）。 */
export declare function eventTypeOf(event: unknown): string | undefined;
/** 事件时间（ms），缺失时返回 undefined。 */
export declare function eventTimeOf(event: unknown): number | undefined;
/**
 * 从 `request/header` / `request/context` 里读路由归属。
 * provider 与 model 必须同时拿到才算数 —— 拿一半会把用量记到别人的价目上。
 */
export declare function routeOf(event: unknown): RouteInfo | undefined;
/** 从 `assistant/message` 读一笔用量；无 usage / 全零返回 undefined。 */
export declare function usageOf(event: unknown): TokenCounts | undefined;
/** 该会话是否为子代理子会话（用于分侧展示）。 */
export declare function isSubagentSession(session: unknown): boolean;
/** 会话标识（日志/诊断用）。 */
export declare function sessionIdOf(session: unknown): string;
