# Changelog

## 0.5.1 — 2026-10-24

- 付费月锚点支持本地文件覆盖：`<storage.dir>/billing-anchor`（一行 ISO 时间）。
  不需要手改 profile 的 `cordis.patch.yml`；配置里的非空 `billing.anchor` 优先。
- 卸载插件时不会留下 profile 补丁残片；锚点文件和台账一样属于用户数据，
  彻底清理删 `~/.dsh-tui/deepseek-cost/` 即可。

## 0.5.0 — 2026-10-24

- 多 TUI 实例：台账改为每进程一个 append-only JSONL（`storage.dir/instances/`），
  启动/定时增量合并；不再用整份文档读改写，避免后写覆盖先写。
- 区间按事件时间计算：今日、本周（Ollama `weekly.resets_at`）、本月（新套餐
  `period`，老套餐 `billing.anchor`，否则自然月）、累计。
- Ollama 配额：接入 `GET https://ollama.com/api/balance`，展示 5h/周剩余量与
  重置倒计时；新套餐展示月度余额/额度。60s 轮询，多实例共享 `quota.json` +
  `quota.lock` 租约。
- 移除缓存命中率：内置底栏是「主会话最后一次请求」，插件侧栏是累计口径，
  两者混在一起会误导；面板与悬停详情不再展示。
- 本会话按活跃会话（`host.snapshot().sessionId`）；底栏字段按最近主会话。
- 旧台账迁移：插件存储 `ledger:v1` + 文件 `ledger.json` 合并为日初事件；
  金额精确，历史区间边界按日近似；重复迁移幂等。
- 面板改用 `ui.Divider` / `ui.ScrollBox` / `ui.useAnimationTime` /
  `host.notify`，旧宿主缺席时降级。

## 0.4.0 — 2026-10-24

- 侧栏台账重排：本会话主卡 + 今日/本月/累计表；不再手绘 ASCII 表格。
- 去掉 Ollama 金额与「缓存写」展示项；缓存写入并入「输入」（仍按未命中计费）。
- 去掉订阅折算（`$20/月含 $60`）：旧套餐不适用，插件不再猜测档位。
- 计价引擎从「两套时钟 × 四槽」简化为官方峰/谷两槽；旧台账兼容读回。

## 0.3.0 — 2026-10-24

- 修复 `tuiPluginStorage` 入口：改为 `open(ctx) → { get, set, delete }`。
- 新增底栏字段 `tuiStatus.setField`（0.17.0 接缝十一加法）与点击打开台账。
- 面板/存储/状态行在直挂行与准入安装两种路径下的降级处理。

## 0.2.0 / 0.1.0

- 原型：用 DeepSeek 官方价目给 ollama-pro 的 DeepSeek 用量记账，底栏状态行 +
  侧栏台账；双口径（官方/Ollama）与订阅折算。
