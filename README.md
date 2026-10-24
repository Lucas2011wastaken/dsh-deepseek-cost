# dsh-deepseek-cost

给 **ollama-pro 上的 DeepSeek 模型**套上 **DeepSeek 官方计价系统**，把结果显示在
dsh-tui 的**底栏字段**（提示框下方那行，紧跟内建 model/token/cost），并在右侧栏给一个
**跨 TUI 实例共享的台账面板**（输入 / 缓存读 / 输出 + 官价），同时展示
**Ollama Cloud 的 5h / 周 / 付费月配额**。

> 这是 dsh-tui 插件系统的压测件：它只用公开接缝（`session/event` +
> `ctx.tuiStatus.setField` + `ctx.tuiPanels`），不改主包一行代码。

## 0.5.0 改了什么

- **多开 TUI 终于能统计了**：台账从「整份 JSON 读改写」换成**每进程一个
  append-only JSONL**，启动/定时增量合并其他实例的文件；两个 TUI 同时记账不会
  再互相覆盖。
- **区间按真实时间算**：事件自带时间戳，`本周` 对齐 **Ollama 周限**
  （`weekly.resets_at - 7d`），`本月` 对齐 **付费月**（新套餐用 `period`，老套餐用
  `billing.anchor`，都没有则自然月并在面板标注）。
- **Ollama 配额**：接官方 `GET https://ollama.com/api/balance`，老套餐显示 5h/周
  剩余百分比与重置倒计时，新套餐显示月度余额/额度/周期；60s 轮询，多实例共享
  缓存 + 租约。
- **移除缓存命中率**：内置底栏是「主会话最后一次请求」，插件里任何累计口径都
  会和它不一致；现在面板和悬停详情都不再显示命中率。
- **本会话按活跃会话**：面板用 `host.snapshot().sessionId` 取当前会话；底栏字段
  取「最近活跃的主会话」。其它并行会话/子代理只进今日/本周/本月/累计。

## 面板长什么样

```text
 ollama-pro                        ▼ 谷
 ──────────────────────────────────────
 本会话 #a1b2                     ¥3.42
 输入 12.7k  缓存读 7.6k  输出 3.2k
 ─────────────Ollama 配额──────────────
 5h   剩 75.0% ██████░░    2h00m 后重置
 周   剩 40.0% ███░░░░░     3d0h 后重置
 账户级 · 含非 DS 模型
 ─────────────────口径─────────────────
           官价    输入  缓存读    输出
 今日     ¥8.12   35.0k   21.0k    9.8k
 本周    ¥42.30    182k   96.0k   42.0k
 本月    ¥95.10    314k    180k   88.0k
 累计   ¥130.55    616k    302k    128k
 周=Ollama 周限 · 月=付费月
 ──────────────────────────────────────
 北京 工作日 9-12/14-18
 现在谷 · 1d13h 后转峰
 台账 共享日志 · 3 实例 · 12s 前更新
```

窄面板（<40 列）自动切成金额 + 相对条排版。配额不可用（没 key/401/断网）时
保留旧值标「旧数据」，或者显示一行原因，不会让整块面板消失。

## 多 TUI 实例怎么工作

```text
~/.dsh-tui/deepseek-cost/
├── instances/
│   ├── 20261024-193012-4821-a1b2.jsonl   # 每个 TUI 进程只追加自己的
│   └── ...
├── quota.json          # /api/balance 缓存，60s TTL，多实例共享
├── quota.lock          # 单飞租约：同一时刻只有一个实例真正发请求
├── migrated.json       # 旧台账一次性迁移标记
└── ledger.json         # 旧文件后端，迁移后只读保留（不会删）
```

- 一行一笔：`{"t":..., "sid":"...", "p":"ollama-pro", "m":"...", "pk":1, "i":..., "cr":..., "cw":..., "o":...}`；
- 每个进程只写自己的文件，`O_APPEND` 追加，跨进程没有「后写覆盖先写」；
- 启动/每 `storage.refreshMs`（默认 10s）按 `mtime/size` 增量读其他文件；
  自己的文件不重复扫描；
- 半行 JSON 直接忽略；文件被截断/压缩（size 变小）时整体重建一次；
- 每个进程启动时裁剪自己超过 `keepDays` 的事件，并清掉超过保留期的死实例文件；
- `本会话` 不跨实例（会话 id 本来就是进程内唯一）；只有时间窗汇总跨实例。

**旧台账迁移**：启动时读插件存储的 `ledger:v1` 与 `<dir>/ledger.json`，合并后把
每天的峰/谷桶各合成一条「日初时刻」事件。金额完全精确；只有历史区间的边界按日
近似。迁移是幂等的（目标文件存在就不重写）。升级后请把**所有** TUI 实例都重启
一遍；旧版本进程写的是旧文档，不会进新事件日志。

## Ollama 配额

官方接口：[`GET https://ollama.com/api/balance`](https://docs.ollama.com/api/balance.md)。

老套餐（session/weekly）：

```json
{
  "included": {
    "session": { "remaining_percent": 75, "resets_at": "2026-10-24T15:00:00Z" },
    "weekly":  { "remaining_percent": 40, "resets_at": "2026-10-26T00:00:00Z" }
  },
  "purchased": { "balance_usd": 0 }
}
```

新套餐返回 `balance_usd` / `allowance_usd` / `period {from, until}`。插件两种都认。

- **凭据**：优先 `process.env` 的 `OLLAMA_PRO_API_KEY` / `OLLAMA_API_KEY`，其次
  `~/.dsh/.credentials.yaml` 的 `refs.<NAME>`。只读、只在内存里持有，不写日志、
  不写缓存文件。
- **轮询**：默认 60s（接口限流 10 次/分钟，官方建议每分钟一次）；多实例用
  `quota.json` + `quota.lock` 单飞，避免重复打接口。
- **错误**：401/403 显示「API key 无权限」并暂停 5 分钟；429 按 `Retry-After`
  退避；503/网络错误保留旧值标「旧数据」。
- **口径**：配额是**账户级、含 glm/kimi 等非 DS 模型**的；下面的官价表只算
  DeepSeek 模型。两者不是同一个口径，面板上已分别标注。
- **网络权限**：dsh 的权限词表里没有「网络」项，`ctx.web.fetch` 也不能带
  Bearer 头，所以这里用全局 `fetch` 直连 `ollama.com`；不想联网可设
  `quota.enabled: false`。

## 区间口径

| 行 | 窗口 |
| --- | --- |
| 本会话 | 当前活跃会话（面板） / 最近主会话（底栏字段） |
| 今日 | 北京时间当天 00:00 → 现在 |
| 本周 | 有 `weekly.resets_at`：`[resets_at - 7d, resets_at)`；否则北京时间周一 00:00，标注「自然周」 |
| 本月 | 新套餐 `period.from → period.until`；老套餐 `billing.anchor` 按月推算；否则自然月，标注「自然月」 |
| 累计 | 保留期内全部事件 |

老套餐的 `weekly.resets_at` 只给下一次重置时间；插件按「周窗口固定 7 天」把它
减 7 天当起点。如果哪天 Ollama 改成滚动窗口，这个区间就等价于「最近 7 天」，
标签仍然成立。

老套餐的 `/api/balance` 没有 monthly `period`；`billing.anchor` 不填时，面板会显示
`月=自然月` 并附一行 `付费月未配置 · billing.anchor`，提醒你去配置订阅续费日。

## 为什么没有命中率

内置底栏的 `缓存 xx%` 用的是 `channel.lastUsage`，即**主会话最后一次请求**；
插件之前的侧栏是「插件挂载后本进程所有会话累计」。两者公式相同，但时间和范围
都不同，放在一起只会让人困惑。0.5.0 把命中率从面板和悬停详情里**彻底移除**；
需要看缓存效果时，直接看内置底栏那一格即可。

## 配置

所有键都有默认值；坏值回落到默认（`Config` 是本包自实现的 Standard Schema）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `providers` | `['ollama-pro']` | 哪些 provider 按官方口径记账；其它 provider 的用量**不进账** |
| `models` | `{}` | 显式模型归类覆盖：`{'某个怪 id': pro}` |
| `status.enabled` | `true` | 是否显示官价 |
| `status.placement` | `auto` | `auto`：宿主有 `setField` 就用底栏、否则回退状态行；`footer`：只在底栏；`line`：旧状态行 |
| `status.slot` | `left-tail` | 底栏槽位 `left-tail` / `right-head` / `right-tail` |
| `status.tone` | `dim` | 语义色；出现未计价 token 时强制 `warning` |
| `status.maxCells` | `28` | 字段 cell 上限（宿主夹到 1…32） |
| `status.minColumns` | `0` | 终端窄于此列数时不显示该字段 |
| `status.detail` | `true` | 悬停时给 token/金额明细 |
| `status.click` | `true` | 点击（全屏）打开台账面板 |
| `status.label` | `DS官价` | 字段前缀 |
| `status.showWindow` | `true` | 显示 峰/谷 |
| `panel.enabled` | `true` | 是否注册台账面板 |
| `panel.title` / `panel.icon` | `DS 官价台账` / `◈` | 图标必须**恰好 1 个 cell**，宽字形会自动退成无图标 |
| `storage.enabled` | `true` | 多实例共享台账总开关；false = 只放内存 |
| `storage.dir` | `~/.dsh-tui/deepseek-cost` | 事件日志/配额缓存目录 |
| `storage.refreshMs` | `10000` | 扫描其他实例文件的间隔（ms） |
| `storage.keepDays` | `45` | 事件保留天数 |
| `quota.enabled` | `true` | 是否轮询 Ollama 配额 |
| `quota.apiKeyEnv` | `['OLLAMA_PRO_API_KEY','OLLAMA_API_KEY']` | 依次尝试的 env/凭据名 |
| `quota.credentialsFile` | `~/.dsh/.credentials.yaml` | DSH 凭据文件 |
| `quota.baseUrl` | `https://ollama.com` | 配额接口根地址 |
| `quota.pollMs` | `60000` | 轮询间隔（夹到 30s…600s） |
| `quota.timeoutMs` | `8000` | 单次请求超时 |
| `billing.anchor` | `''` | 老套餐付费月锚点，ISO 8601，例如 `2026-09-15T09:30:00+08:00`；留空 = 自然月 |
| `billing.timezone` | `Asia/Shanghai` | 当前实现按固定 UTC+8 计算，保留此键用于文档 |
| `holidays` | `[]`（用内置 2026 表） | 覆盖中国法定节假日表 |
| `debug` | `false` | 打印完整解析后配置到日志（不含凭据） |

## 计价口径

```
费用 = 输入(未命中) × 未命中价
     + 缓存读(命中) × 命中价
     + 缓存写入     × 未命中价      // 官方口径：写入按未命中计，展示上并入「输入」
     + 输出         × 输出价        // reasoning 已含在 outputTokens 内，不另计
（以上按百万 token 计，峰/谷分别取价；每笔用量按**事件发生时刻**落桶）
```

台账按 `provider|model` 分键；事件里保留原始 token 与峰/谷标记，金额不会因为
当前时段变化被重新定价。

## 安装

### A. 从 GitHub 安装（推荐）

```sh
/plugin install github:Lucas2011wastaken/dsh-deepseek-cost
# 或命令行等价：
dsh plugin --profile dsh-tui add github:Lucas2011wastaken/dsh-deepseek-cost
```

bundle patch 用包名 `dsh-deepseek-cost`，Loader 会从 profile 的 `node_modules`
解析到 `lib/types/index.js`；`lib/` 已随仓库提交，安装时不需要构建。

### B. 本地路径（开发）

```sh
/plugin install /absolute/path/to/dsh-deepseek-cost
# 或
dsh plugin --profile dsh-tui add /absolute/path/to/dsh-deepseek-cost
```

### C. `--patch` 直挂（不经过安装）

把 `cordis.patch.yml` 的 `insert` 段抄进 profile 的 `cordis.patch.yml`，并把
`name` 改成：

```yaml
name: 'file:///absolute/path/to/dsh-deepseek-cost/lib/types/index.js'
```

直挂行没有准入身份，`tuiPluginStorage.open()` 会被拒，旧台账只能从
`~/.dsh-tui/deepseek-cost/ledger.json` 读；正式使用请走 A/B。

## 仓库结构

```text
.
├── src/                     # TypeScript 源码
├── lib/types/               # 构建产物（提交，安装直接用）
├── test/                    # 纯函数测试 + 宿主集成测试
├── scripts/                 # link-deps / smoke-host
├── cordis.patch.yml         # bundle patch（包名行名）
├── dsh-plugin.json          # Community v0.15 Manifest
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
└── .github/workflows/ci.yml # 纯函数测试 + 运行时 import 冒烟
```

## 兼容性（对照 dsh-tui 0.17.0）

以下结论由 `node scripts/smoke-host.mjs` 对着本机安装的
`@deepseek-harness-tui/dsh-tui@0.17.0` 实跑（清单、底栏字段、面板、旧存储
`open()`、事件日志、卸载清理）。

| 接缝 | 0.17.0 状态 | 本插件 |
| --- | --- | --- |
| `tuiStatus.setField` | 0.17.0 新增 | 默认走它；槽位/色调/`maxCells`/`detail`/点击全部被接纳 |
| `tuiStatus.set` | 签名不变 | `placement: line` 与老宿主回退 |
| `tuiPanels.register / list / open` | 签名不变；面板 props 有 `Divider`/`ScrollBox`/`useAnimationTime` 等 | 用到 `Divider`/`ScrollBox`/`useAnimationTime`/`host.notify`，缺席项自动降级 |
| `tuiPluginStorage.open(ctx)` | 0.15 起唯一入口 | 只在迁移时读旧台账；拿不到句柄就只读文件 |
| `sidePanel.panels` | 0.17.0 起是精确集合 | 面板需在 `/settings` 里勾选 |
| `statusBar.pluginFieldsOrder` | 0.17.0 新增 | 字段被隐藏/换槽属正常路径 |

## 已知边界

1. **本会话的起点**：事件日志从插件挂载之后开始记；装插件之前的历史会话没有
   逐会话事件，只有旧台账的日桶（迁移进 `累计/本月`，但不进「本会话」）。
   升级后第一笔新请求会补齐当前会话。
2. **多实例的可见延迟**：默认 10s 扫一次其他实例文件；另一个 TUI 刚记的账最多
   10s 后出现在你的今日/累计里。`storage.refreshMs` 可调小。
3. **旧台账迁移**：每天峰/谷各一条日初事件，金额精确；若历史用量跨周限/付费月
   的边界，旧数据只能按日近似。插件存储与文件后端两处旧文档会合并，若两处记录
   过同一段用量，可能重复计入，需人工核对。
4. **周/月锚点**：老套餐没有 monthly period，`billing.anchor` 不填时「本月」是
   自然月并在面板标注；`weekly.resets_at` 按固定 7 天窗口反推起点。
5. **配额是账户级**：`/api/balance` 的 5h/周剩余量包含 glm/kimi 等非 DS 模型，
   也可能包含 web search/fetch；下面的官价表只算 DS 模型。两者不要直接相减。
6. **配额轮询是插件直连网络**：没有走宿主 fetch 服务（后者不支持自定义 Bearer
   头），凭据只在内存中使用，不落盘、不写日志。
7. **"本会话"= 当前活跃会话**（面板）/ 最近主会话（底栏）。其它并行主会话与
   子代理只进时间窗汇总。

## 数据来源

- DeepSeek 官方价目（人民币）：<https://api-docs.deepseek.com/quick_start/pricing>
- 峰谷规则与法定节假日：同上页脚注；节假日表与
  [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
  的 `HOLIDAY_VALLEY` 对齐（33 天，2026 年；每年 11 月需更新）
- Ollama 余额/配额：<https://docs.ollama.com/api/balance>
- Ollama 账户用量（未接入，留作对账）：<https://docs.ollama.com/api/cloud-usage>

> 这是**估算**而不是账单：价格可能变动，实际扣费以 DeepSeek 官方/你的接入方为准。

## 开发

需要本机装好 dsh-tui（提供 `@deepseek-ai/cordis`、`@deepseek-harness-tui/dsh-tui`
的类型与集成测试运行时）。

```sh
sh scripts/link-deps.sh                              # 链类型依赖（仅开发期）
~/path/to/dsh-TUI/node_modules/.bin/tsc -p tsconfig.json
npm run test:unit                                    # 纯函数测试，无需宿主
npm run test:host                                    # 需要本机 dsh 安装
npm run smoke:host                                   # 对着已安装的 dsh-tui 跑真实接缝
```

`lib/types/` 是提交进仓库的构建产物；改完源码后重新 `tsc` 并一起提交，否则
GitHub 安装拿到的还是旧 `lib/`。

测试覆盖：事件线格式、多实例增量合并、半行/截断/裁剪、旧台账迁移、峰谷/周末/
节假日、模型归类、计价公式、两槽分桶、配额 legacy/monthly 解析、凭据读取、
429 退避、周限/付费月区间、宽/窄面板渲染、底栏字段与卸载清理。

## License

MIT，见 [LICENSE](./LICENSE)。安全与凭据处理见 [SECURITY.md](./SECURITY.md)。
