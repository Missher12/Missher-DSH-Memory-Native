# 验证记录 — @missher/dsh-memory 0.1.0

- 环境：DeepSeek Harness Desktop，profile `desktop`；Node 24.21.0（DSH 自带 runtime）
- 日期：2026-10-31
- 原则：只记录实际执行过的检查；未执行项列在最后，不当作已通过。

## 1. 单元测试

```
/Users/missher/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node --test tests/*.test.js
```

结果：**85 / 85 通过**，0 失败（exit 0）。

覆盖：CJK bigram 分词、记录校验/敏感信息拒绝、JSONL 权威的写入/revision/墓碑/压缩/损坏行跳过、
BM25 检索与过滤、抽取响应解析、召回融合与 token 预算、捕获管线（ADD/UPDATE/去重/预算/中断 turn/长对话分块/近重复合并/回合内增量抽取）、
面板契约（list/stats/activity/update/removeMemory/rebuild）、配置默认值与钳制、激活冒烟（事件接线 + 数据目录创建）。

## 2. 安装与激活

`plugin_manager install_bundle`（linked 目录安装）：

- `application: applied`，`changed: true`，`warnings: []`
- 运行时 `systemPrompt` 中出现插件 guidance 段（说明记忆是数据不是指令）
- 插件创建 `~/.dsh/dsh-memory/`；`panel-transport.json` 记录 `transport: "typert"`

`node --check` 覆盖 `index.js`、`client.js`、`host/remote.js`、`host/remote-contract.js`；`node -e "import('./index.js')"` 正常导出。

## 3. 自动记忆（真实会话）

- 当前累计 **17 条**记忆：14 active / 3 candidate；覆盖 preference / fact / decision / episode。
- 权威文件：`~/.dsh/dsh-memory/global/memories.jsonl` 与 `projects/DSH-Memory-c9287021b1b1/memories.jsonl`。
- 每条为完整 revision 快照，含 confidence、importance、observedAt、revision、contentHash。
- 去重：相同 `contentHash` 不重复写入；敏感内容（`sk-…`、`password=`、私钥块）被拒绝（单测覆盖）。

## 4. 上下文注入（真实轮次）

- 真实会话的 user 消息中出现 `<memory-context source="dsh-memory" …>` 块，含 `id@revision`。
- 幂等：每个 step 先剥离 `source.kind=memory & source.plugin=dsh-memory` 的旧消息，再追加一条。
- 预算：默认 600 token；`compileMemoryContext` 在放不下时返回 null（不注入半截内容）。

## 5. 面板 RPC（真实 Host 网关）

插件激活时通过 `ctx.typertGateway.invoke` 对自身服务做一次自检，结果写入 `panel-transport.json`：

```json
{
  "transport": "typert",
  "selfTest": {
    "ok": true,
    "value": { "active": 14, "candidate": 3, "total": 17, "projects": 1, "captureEnabled": true, "injectEnabled": true },
    "list": { "ok": true, "total": 16, "items": 1 }
  }
}
```

调用日志：`panel-calls.jsonl` 记录 `stats` 与 `list` 两次真实分发（`ok:true`）。
说明服务注册、网关查找、参数 wire（`{input}`）与结果返回均可用。

### 5.1 浏览器端真实调用（20:16 修复后）

首次刷新后，客户端在挂载 Remote 时报错：

```
client api: method "dshMemory/remove" conflicts with its namespace service
```

原因：客户端命名空间服务 `RemoteNamespaceService` 自身有 `remove` 方法（Cordis Service 语义），
端点不能同名。修复：端点 `remove` 改名为 `removeMemory`（host 契约、Remote 服务、客户端描述符、
测试同步更新，85/85 通过）。

修复后客户端 HMR 重载，`panel-calls.jsonl` 出现浏览器来源的独立 `stats` 调用
（`at=1793448993138`，无成对 `list`，与启动自检区分）；`settings.section` 中 `id=memory` 仍在。
这证明 **浏览器 → Typert 网关 → 插件服务** 的完整链路已通。

补充一次只读的 list 探针（临时把预热调用改为 `list {scope:'global',limit:1}`，HMR 生效后立即还原）：

- `at=1793449040971` 浏览器来源 `list` 调用成功（size 6）——面板主数据路径（列表）端到端可用；
- 还原后 `at=1793449051516` 浏览器来源 `stats` 调用成功——客户端已回到正式版本。

另外，修复前面板在应用内确实渲染出了不可用态（用户看到的「记忆面板暂不可用 / Host 未提供记忆 RPC」），
说明组件能在真实 Settings 容器中挂载并显示状态卡；修复后列表视图的应用内观感仍待用户确认。

## 6. 面板渲染与交互（组件夹具）

用 React 18 UMD + 实时主题 token 搭建本地渲染夹具（数据为模拟），逐项检查：

| 检查 | 结果 |
|---|---|
| 列表/统计/筛选/搜索框渲染 | 正常，无 JS 错误 |
| 卡片分区（B 方案） | 指标卡（4 列大数字 + 状态胶囊同排）、活动卡、筛选卡、列表卡统一 12px 圆角 / 0.5px 边框 / 14px 内距 |
| 筛选工具栏 | ≥560px 单行网格（三个筛选项 + 搜索 + 刷新/重建索引）；<560px 切两行填满：第一行三个筛选项等宽，第二行搜索 + 两个按钮 |
| 列表条目 | 每条独立卡片，左侧 2px 类型色条（偏好蓝 / 事实青 / 决策紫 / 片段金），标签与操作同行 |
| 窄宽 430px | 指标换行、筛选与按钮折行，无横向溢出 |
| 记忆活动热力图（53 周 × 7 天，5 级强度） | 正常；每日/每周/累计三种视图、月标签、悬浮日期提示 |
| 配色菜单（跟随主题 + 5 预设 + 自定义色） | 正常；选择后 CSS 变量与格子上色立即生效，偏好持久化 |
| 活动洞察条 | 与使用统计插件一致的等宽分栏、数值上/标签下、居中带分隔线 |
| 用户画像卡（v0.3） | 偏好聚类为画像，显示证据条数与置信度；无画像时不渲染 |
| 胶囊不缩不竖排 | 类型/状态/标签胶囊固定宽度（34×20），747/560/430px 下均不换行 |
| 指标区 C 方案 | ≥480px 两张卡片并排（1.6fr + 1fr）；两张卡指标布局完全一致：≥620 同行、480–620 数值上/标签下、<480 同行；无状态胶囊 |
| 指标卡一致性 | 735/560/520/430 四档 leftDir 与 rightDir 相同（row/column/column/row），无溢出 |
| 字体统一 | 两张卡数值均 20/28、标签均 12/18（实测 computed style 一致） |
| 状态胶囊移除 | 指标区不再渲染自动捕获/上下文注入胶囊；活动卡只剩热力图 |
| 设计基线 | docs/design-requirements.md：卡片 12/0.5/14、单行优先、折行铺满、窄宽无横向滚动 |
| 类型分类页签 | 全部/偏好/事实/决策/片段 + 各类型条数，点击即筛 |
| 分页 | 每页 10/20/50 条可选，上一页/下一页与「第 x / y 页 · 共 n 条」 |
| 编辑弹窗打开、保存（update 调用） | 正常，弹窗关闭并提示「记忆已更新」 |
| 弹窗 Esc 关闭 | 正常（dialog 1 → 0） |
| 批准候选（update status=active） | 正常，提示「候选已批准」，行状态从「待审」刷新为「生效」 |
| 双确认删除（remove 调用） | 正常，第二次点击后提示「记忆已删除」 |
| 空态 | 显示「还没有记忆 / 聊一会儿，或在对话里说『记住这个』」 |
| 错误态 | 显示错误卡片与「重试」，统计显示「—」，不白屏 |
| 540px / 430px 窄宽 | 工具栏动作整组换行并右对齐；统计卡在 430px 下 4 列自适应（minmax 96px）；热力图在 430px 下自适应 6px 单元格，无横向溢出 |
| 深色主题 | 卡片/文字/状态色对比正常 |
| 主题 token 缺失 | 46 处 `var()` 已加 fallback（圆角/阴影/边框/三级文字），无样式塌陷 |

截图：`docs/images/panel-light.png`、`panel-edit.png`、`panel-dark.png`、`panel-error.png`（夹具渲染，非应用内截图）。

## 7. 性能

```
node scripts/bench-recall.mjs
```

5000 条合成记忆：建索引 ~120ms；200 次查询中位 **4.7ms**、p95 **8.8ms**、最大 **10.9ms**。
达到「召回 < 50ms」目标；写入为 append，不阻塞对话（捕获在后台链上串行执行）。

## 8. 未验证项（需要真实页面/重启）

1. **应用内视觉**：夹具验证了组件自身渲染与 token fallback，浏览器端 RPC 已通；真实 Settings 容器里的
   最终观感仍待用户打开面板确认（本次修复后尚未截图）。
2. **卸载后的客户端槽位**：Host 侧卸载/重装循环已验证（见 §9），但「卸载后浏览器槽位消失」仍需要刷新页面确认。

已消除：
- 浏览器端首次真实调用——20:16 修复 `remove` 命名冲突后，浏览器来源 `stats` 已出现在 `panel-calls.jsonl`。
- 重启后加载——应用重启后插件于 20:16:25 重新激活，`panel-transport.json` 自检通过；客户端 HMR 后 RPC 可用。

## 9. 安装 / 卸载循环（Host 侧）

在 20:18 执行了一次完整的卸载 → 重装循环：

| 步骤 | 结果 |
|---|---|
| `remove_bundle` | `application: applied`；profile `package.json` 中 `@missher/dsh-memory` 依赖被移除（仅剩 TDAI） |
| 卸载后运行时 | 插件 guidance 从系统提示中消失；本轮消息不再出现 dsh-memory 的 `<memory-context>` 块 |
| 数据保留 | `~/.dsh/dsh-memory/` 完整保留：global + 项目 JSONL（34 行项目记录）、`panel-transport.json` 未被删除 |
| `install_bundle` | `application: applied`，`warnings: []`；依赖恢复 |
| 重装后激活 | 20:18:28 重新激活，`panel-transport.json` 自检 `stats`+`list` 通过（list total=34） |

说明：卸载只移除插件，不删除记忆数据；重装后数据自动重新加载。
客户端槽位在卸载后是否从已打开页面消失，仍需刷新页面观察（未验证）。

### 5.2 记忆活动 RPC（20:26 新增）

面板新增 `activity` 端点（近一年按本地日期聚合，5 种级别由 Client 渲染）。发布时用同样的临时探针方式验证：

- 临时把客户端预热调用改为 `activity {scope:'project',days:371}`，HMR 重载后 `panel-calls.jsonl` 连续出现
  `{"method":"activity","ok":true,"size":5}`（`at=1793463999501`、`at=1793464000340`）；
- 还原为 `stats` 后 `at=1793464009706` 的浏览器来源 stats 调用成功。

热力图组件在夹具中验证：371 个格子、13 个月份标签（首个不完整月份不标注）、浅色/深色/430px 下均无溢出。

## 10. 长对话与去重（v2 增强）

- **分块抽取**：`turn/end` 的 transcript 超过 `extraction.maxInputTokens * 2` 字符时按消息切成最多 3 块，
  每块独立抽取后合并应用；额外块计入每日调用预算，预算耗尽时记录告警并保留已抽取部分。
- **近重复合并**：新增条目与同 kind/同作用域记录做 token-set Jaccard 相似度比较，≥ 0.9 时不再新增，
  改为更新已有记录（取更长内容、标签并集、置信度 +0.05 封顶 1、重要度取大、刷新 observedAt）。
  阈值经样本校准：仅标点差异 0.96、npm/pnpm 差异 0.875，确保不会把相反事实合并。
- **回合内增量抽取**：缓冲超过 20000 字符时立即对已有前缀抽取一次（每回合最多 2 次），
  再清空已抽取部分；这样上下文压缩或被中断的长回合也不会丢失早期内容。预算不足时不清空缓冲。
- 单测覆盖：近重复合并（1 条记录、置信度 ≥0.85）、长对话 2 块、预算中途停止（仅 1 次调用）、
  超长回合在 turn/end 前已产生抽取。

## 11. v0.3 越用越懂

- **L2 主题**：`records.topic`（≤48 字）由抽取 prompt 生成，参与 BM25 索引与面板 patch；旧记录可为空。
- **L3 画像**：`host/profile.js` 仅聚合 active 且 confidence ≥ 0.55 的偏好；同 topic 或 token Jaccard ≥ 0.42 聚成一条 trait；
  每条带 evidence（最多 8 条记录 id + 原文 + 更新时间）、max confidence、lastSeenAt；按 `confidence × 0.5^(age/60d)` 排序，上限 10 条。
- **画像注入**：`agent/pre-step` 的 `<memory-context>` 在记忆条目前加「用户画像」小节，最多 3 条 / 460 字符，仍受 600 token 预算约束。
- **浏览器端画像 RPC**：临时把客户端预热调用改为 `profile` 后，HMR 重载触发浏览器来源的
  `{"method":"profile","ok":true,"size":3}`（`at=1793546595943`，无成对 stats/list），随后已还原为 stats；
  证明客户端描述符挂载与画像调用在真实页面可用。
- **衰减**：召回 recency 改为按类型半衰期（偏好 60 天、决策/事实/片段 90 天）。
- **灰区去重**：偏好/决策在 Jaccard ≥ 0.85（长度比 ≥ 0.75）合并，其它类型仍为 0.9；合并时置信度 +0.05、标签并集、重要度取大。
- 测试：93/93（新增 profile 5 个、灰区 1 个、profile RPC 1 个）。

## 12. v0.4 数据安全与冲突修正（2026-11-02）

- **写安全**：`MemoryStore.append` 在跨进程锁内执行，写入后 `fsync`；压缩前在锁内重新读取并合并，
  避免旧快照覆盖并发追加；同一 revision 冲突时自动递增。
- **坏行隔离**：解析失败的行写入 `corrupt-lines.jsonl`（带文件、时间、原文），压缩不再静默抹掉。
- **schema 版本**：`SCHEMA_VERSION = 2`；旧版本打开时迁移并落盘，更新版本直接拒绝。
- **导出/导入/备份**：`exportData()` / `importData()`（按 revision 去重、支持 dry-run）/ `backup()`。
- **冲突修正**：相似语句若数字值或否定不一致（如 Node 22 → 24），不再合并，旧记录 SUPERSEDE，
  新记录 `supersedesId` 指向旧记录。
- **评测**：`scripts/eval-recall.mjs`，30 条标注 case，hit@5 = 1.000、MRR = 0.983、precision@5 = 0.225（单相关项基线）。
- 测试：99/99（store 新增 5 个、capture 新增 1 个）。

## 13. 越用越懂闭环（2026-11-02）

- **反馈写回**：`applyUpdate` 把面板操作转成记忆信号——候选批准 → confidence +0.1、importance +0.05；
  内容被编辑 → importance +0.05；固定 → importance = max(当前, 0.9)。单测覆盖三种信号。
- **召回门控**：`hasMeaningfulMatch` 要求至少一个长度 ≥2 的命中 token（bigram/长词）；
  实测「你好 / 好的 / 今天天气」只命中单字，过滤后不注入；「记忆 / 设计文档 / Typert remove」等正常命中保留。
- **续问**：`isFollowUpQuery` 识别「继续/好的/然后呢」等短句，优先用上一条用户消息检索，失败再回退当前句。
- 测试 102/102；评测 hit@5 = 1.000、MRR = 0.983 不降级；重装 applied，自检 163 条记录、profile 6 traits。

## 14. 自维护（v0.5）

- 模块：`host/maintenance.js`；启动 4 秒后执行一次，之后按 `maintenance.intervalHours`（默认 24h）循环；计时器 unref，不阻止进程退出。
- 动作：按 `retention.episodeDays`（默认 90）归档低置信度（<0.75）旧 episode，跳过固定与高置信；每日备份（`backups/`）；只保留最近 7 份；写 `maintenance.json`。
- 实测：重装后自动执行 `{archived: 0, backedUp: backups/memories-2026-11-01T16-26-45-314Z.json, pruned: 0}`（无超期低置信 episode，备份成功）。
- 测试：105/105（maintenance 3 个、config 扩展）。

## 15. 设置可写（v0.5）

- `host/settings.js`：`settings.json` 持久化；只接受 5 个字段（captureEnabled / injectEnabled / injectMaxTokens / retentionEpisodeDays / maintenanceEnabled），写入时钳制范围。
- 激活时 settings 覆盖 bundle 配置；面板 `updateSettings` RPC 写入后重新 resolveConfig 并 `capture.setConfig()`，无需重启即可生效。
- `stats` 返回当前预算/保留天数/自维护开关与上次维护摘要，面板「记忆设置」卡展示并保存。
- 测试 111/111（settings 4 个、capture setConfig 1 个、updateSettings 1 个）。
- 实测：重装后 stats 含 maintenance 字段（上次归档 0、备份路径 188KB），设置文件待用户首次保存后生成。

## 16. 导出 / 导入 / 备份入口（v0.5）

- RPC 新增 `exportData` / `importData` / `backup`：导出返回 `{schemaVersion, global, projects}`；导入按 revision 去重、支持 dry-run、导入后重建索引；备份返回落盘路径。
- 面板「记忆设置」底部新增三个次按钮，导出触发 JSON 下载，导入读本地 JSON 并提示导入/跳过条数，备份提示写入路径。
- 测试 112/112（store 导出/导入/备份已有单测，本轮新增面板操作往返 1 个）。
- 浏览器 mock 实测：按钮渲染为「导出 / 导入 / 立即备份」，点击备份返回提示「备份已写入 /tmp/mock-backup.json」，无 JS 错误。
- 重装 applied，自检 175 条记录。

## 17. 设置卡分组重排与热力图 tooltip 修正（2026-11-02）

- 设置卡改为分组：捕获与注入 / 保留与维护 / 数据，每组带小标题；每项一行，名称左、控件右；组间 16px + 分隔线，组内行高 34px。
- 「导出 / 导入 / 立即备份」移入独立的「数据」组；「保存设置」单独在卡片底部右对齐。
- 热力图 tooltip：水平位置按卡片宽度钳制（左右各 8px），首行单元格改为向下显示，不再遮住头部「每日/每周/累计」；`max-width: min(240px, calc(100% - 16px))`。
- 活动头部在 <560 容器允许换行。
- 浏览器 mock 实测：735/560/520/430 四档设置卡与活动卡 `scrollWidth-clientWidth = 0`；标签/控件左右对齐；tooltip 在 520 宽下左右均落在卡片内（首行与末列均验证）。
- 仅客户端改动，已 touch client.js；实际面板需刷新一次加载新布局。

## 18. 设置区去掉卡片容器（2026-11-02）

- 「记忆设置」不再使用 `dsh-memory-card`：无边框、无底色、无圆角，直接平铺；内容左右缩进 14px，与上方卡片内容对齐。
- 分组、每项一行、名称左控件右、数据操作独立成组、保存按钮页脚均保持不变。
- 浏览器 mock 实测：`border-width=0px`、`background=transparent`、`border-radius=0px`；设置区左边缘与活动卡内容对齐（371 vs 372，1px 为卡片边框）；735 与 430 宽均无横向溢出；430 宽下每行 402px、数据按钮不换行溢出。
- 仅客户端改动，已 touch client.js；实际面板刷新后生效。

## 19. 控件与行高统一（2026-11-02）

- 根因：输入框 `height:28px` 使用 content-box，加 0.5px 边框后实际 29px；设置行 `min-height:34px`，带分隔线的行加 1px 变成 35px，导致 34/35 混排。
- 修复：输入框/下拉 `box-sizing:border-box;height:28px;padding:3px 8px`；数字输入加 `box-sizing:border-box`；设置行固定 `height:36px;box-sizing:border-box`（分隔线计入高度）。
- 实测 735/520/430 三档：设置行全部 36px，输入框/下拉/按钮全部 28px，勾选框 16px，设置区无横向溢出；顶部两张指标卡在各档等高。

## 20. 设置卡外框恢复与行高再统一（2026-11-02）

- 按反馈恢复「记忆设置」卡片外框：0.5px 边框、12px 圆角、14px 内距、bg-layer-3，与其他卡片一致。
- 行高系统：分组标题 18px、设置行 36px（含分隔线，box-sizing:border-box）、控件 28px（输入/下拉/按钮）、数据组按钮行 36px、保存按钮 28px。
- 实测 735 宽：5 行设置全部 36px，数据按钮行 36px，数字输入 28px，分组标题 18px，卡片边框 0.5px，无横向溢出。
- 已重装 bundle（remove+install 均 applied），确保面板加载最新客户端；仍需用户刷新一次页面。
- 说明：实际 GUI 需要 dsh web 的认证 URL 才能打开，代理无法在未授权的新浏览器会话中直接截图验证真实面板。

## 21. 记忆设置独立 demo（2026-11-02）

- 新增 `demo/memory-settings/index.html`：单文件、零依赖，含开关/数字输入/保存/导出/导入/备份/明暗主题/735-520-430 宽度切换。
- 实测：6 行设置均 48px（430 宽下 46px），开关 22px、数字输入 32px、按钮 32px、保存按钮 32px；三档宽度均无横向溢出；头部徽标与标题顶对齐。
- 交互实测：切换后「有未保存的更改」+ 保存可用；保存后显示「已保存 · HH:MM」与 toast；备份 toast 带路径；导入 JSON 提示「已导入 3 条」；深浅主题切换正常。
- 截图：`docs/demo/settings-735.png`、`settings-520.png`、`settings-430.png`、`settings-dark.png`。
- 本地预览：`http://127.0.0.1:64420`（`python3 -m http.server 64420`）。

### 21.1 分隔线与行内容垂直居中修正

- 用户反馈「注入预算」未在上下两条分隔线正中间：原因是分组分隔线带 20px margin，线跑到了行下方 20px 处，视觉带比行本身高，内容看起来偏上。
- 修正：分隔线改为紧贴行边界（`.group + .group { margin-top:0; border-top; padding-top:22px }`，`.card-foot` 同），视觉带 = 行高。
- 实测 735/520/430：行高 48/48/46，标签与数字控件中心相对分隔线带中心偏移 0.5px（1px 边框导致），三档无横向溢出。

## 22. 设置区按 demo 重造并接入真实面板（2026-11-02）

- 真实面板「记忆设置」替换为 demo 设计：卡片外框 + 头部（标题/维护摘要/自动维护徽标）+ 三组（捕获与注入 / 保留与维护 / 数据）+ 底部状态与保存按钮。
- 控件：开关 40×22、数字输入框 32px（带 token/天 单位）、数据按钮 32px、保存按钮 32px；行高 735/520 为 48px、430 为 46px；分隔线紧贴行边界，行内容居于两线正中。
- 状态：改动后「有未保存的更改」+ 保存可用；保存成功显示「已保存 · HH:MM」与提示；保存后重新拉取 stats。
- 实测 735/520/430：行 48/48/46、开关 22、数字 32、按钮 32/30（430）、无横向溢出；面板 mock 保存交互通过。
- 变更文件：client.js（客户端），已 touch；主机侧无改动，无需重装（为刷新缓存仍执行 remove+install）。

## 23. Token 效率（2026-11-02）

- 注入块：默认 `maxTokens` 600→360、`maxItems` 12→6、`minScore` 0.15→0.2；短续问预算 220；`formatMemoryLine` 去掉 id/scope/日期/置信度，只保留 `- [类型] 内容`（≤140 字）；画像限 2 条并去重。
- 抽取 prompt：RULES 固定开销 579→360 token；旧记忆 12→6 条、每条 ≤80 字；transcript 上限 16000 字符；capture 分块上限对齐 16000 字符。
- GUIDANCE：125→66 token。
- 实测（真实 182 条库 + 抽样 5 查询）：注入均值 542→329（-39%）；抽取 4k transcript + 旧记忆 2393→1851（-23%）；按 4 次注入 + 1 次抽取估算单轮 4686→3233（-31%）。
- 面板设置卡显示「上次注入 X/预算 token」；`stats.lastInjection` 由 pre-step 写入。
- 测试 115/115（新增 token 相关 2 个 + telemetry 1 个）；eval hit@5 1.000 不降；bench 5k p95 8.31→6.38ms。

## 24. 召回门控 v2 + 画像防误合并（2026-11-03）

- 审计（只读 teammate）：弱相关多词查询在旧门控下仍注入 7/12；归一化 fused top1 结构下限 0.715，minScore 0.2 无法过滤。画像同 topic 直接合并、反义/否定被静默覆盖。
- 门控：`classifyRecallHits` 使用内容 bigram 贡献和 S_bi、区分度 D、加权覆盖率 cov（按 query term idf 加权），阈值按 I1=idf(df=1,N) 缩放（drop 0.49·I1、soft 0.86·I1、auto 2.1·I1、D_min 0.4·I1、cov 0.5）。
- 实测（真实库 254 条）：`设计文档` 3 条 auto、`Typert remove 端点` 4 条、`记忆 设置` 2 条；`数据库迁移/翻译/灰度发布/用户头像/越存越慢/怎么让召回` 全部 0 注入；灰区写 `recall-gate.jsonl`（不存原始 query，只存 hash）。
- 评测改为走生产门控：hit@5 1.000、precision@5 0.978、MRR 0.983。
- 画像：similarity 改 bigram Jaccard；同 topic 阈值 0.5、跨 topic/无 topic 0.62；否定极性、反义对、数字冲突不合并；新增 3 个测试（反义/否定/同主题不同事）。
- 测试 121/121。

## 25. v0.6.1 收尾：续问两条消息、topic 软加分、多相关项评测（2026-11-03）

- 续问：`recallQueries` 对 followUp 依次尝试「上一条 + 当前」合并查询、上一条、当前；实测「召回门控怎么定」+「继续」→ 合并查询命中 6 条 auto，top1 为门控记录。
- topic 软加分：`rankHits` 增加 `topicHint`（取 auto 命中中出现 ≥2 次的主题），命中 +0.05；测试覆盖。
- 评测：CASES 扩展为多相关项（19 个 case 2 条相关项），走生产门控后 hit@5 1.000、precision@5 0.989、MRR 1.000。
- 测试 123/123；重装 applied，自检 total=205；5k bench p95 9.26ms。

## 26. v0.7 回收站 / 批量 / 版本历史 / 主题筛选（2026-11-03）

- Store：新增 `history(id)`（读原始 JSONL 全 revision）与 `purge(id)`（锁内重写文件、物理删除全部 revision、目录 fsync）。
- RPC：`restoreMemory`、`purgeMemory`、`history`、`restoreRevision`、`bulkAction`（archive/delete/restore，逐条失败返回）；`list` 支持 `status=deleted` 与 `topic`（含 `__none__`），返回 `topicCounts`。
- 面板：已删除视图、恢复/彻底删除（二次确认）、历史弹层与恢复此版本、行复选框与批量条、主题下拉筛选；全部走真实 RPC。
- 测试 129/129；harness 实测：回收站 1 行、历史 r2/r1、批量条「已选 2 条」、主题选项依赖/存储/注入且过滤生效，`__errors=[]`。
- 截图：`docs/demo/v07-recycle.png`、`v07-history.png`、`v07-topic.png`。
- 重装 applied，激活自检通过。

## 27. v0.7 收尾：原子批量、标签、diff、主题合并（2026-11-03）

- 批量：`bulkAction` 支持 archive/delete/restore/tag；默认 atomic，任一失败即回滚已成功项并返回 `rolledBack`；面板批量条新增「标签」弹层，失败/回滚有独立提示。
- 历史：每个 revision 显示与上一版的字符级 diff（删除/新增片段），恢复旧版本写成新 revision。
- 主题：`topicSuggestions` 按 bigram Jaccard≥0.5 或包含关系给出合并建议；`mergeTopics` 合并记录主题；面板列表头「合并建议」弹层。
- 实测 harness：diff「删除：最初版本 / 新增：旧版本曾」；合并建议「部署（2）→ 部署流程（3）」；标签弹层提交后「已处理 2 条」；`__errors=[]`。
- 宽度：735/520/430 列表框与工具栏 `scrollWidth-clientWidth=0`。
- 测试 132/132；重装 applied，自检通过。

## 28. 稳定性与抗崩溃（2026-11-03）

- 激活隔离：`apply()` 中 root/store/index 初始化包 try/catch，存储不可用时只记 warning 并禁用插件，不向 Host 抛错（新增测试：dataDir 指向文件 → 不抛且不注册 hook）。
- hook 隔离：`agent/pre-step` 的记忆检索/注入整段 try/catch，异常时返回原始 decision；`session/event`、维护定时器、panel 自检、dispose 均有 catch。新增测试：agent.session getter 抛错时 pre-step 仍返回 decision。
- 数据：坏行隔离、schema 校验、锁内重写、fsync 已有测试；提取 LLM 失败/无路由时 capture 跳过不抛。
- 压测：2000 次 pre-step + 4000 个 session 事件（含每 20 条 turn/end），0 异常，耗时 2.36s，heap 38MB。
- 规模：5k 记录 build ~90–185ms、p95 6–11ms；50k 记录 build 772ms、p95 125ms、heap 290MB（不崩，但超出 v0.8 的 50ms 目标，列为优化项）。
- 测试 134/134；重装 applied，自检通过，真实数据 5 个项目、320 行未受影响。

## 29. Obsidian DLC（2026-11-03）

- 模块 `host/obsidian.js`：一条记忆 = 一个 Markdown 文件，YAML frontmatter 保存 id/kind/scope/projectKey/status/topic/tags/confidence/importance/revision/时间；正文为 content。
- 导出幂等（内容相同跳过），生成 `_index.md`；导入只处理 `dsh_memory: true` 且 id/kind/scope 合法的笔记，按 id 更新、不重复创建、不删除 vault 文件。
- RPC：`obsidianExport` / `obsidianImport`（支持 dryRun）/ `obsidianStatus`；设置新增 `obsidianVaultPath`、`obsidianFolder` 并持久化。
- 面板「记忆设置 → Obsidian」：vault 路径、文件夹、导出/导入按钮；735/520/430 无溢出。
- 真实库实测：357 条记忆导出 357 个 md + `_index.md`，dry-run 导入预览 357 条 update；测试 141/141；重装 applied，激活自检通过。
- 截图：`docs/demo/v08-obsidian.png`。

## 30. 知识图谱 + 知识提升（2026-11-03）

- `host/knowledge.js`：`buildKnowledgeGraph` 按 topic 聚合，topic 为 hub、共享 tag 为边；`promoteMemoryToKnowledge` 写 `knowledge/<id>.md`；`listKnowledgeNotes` 读回并作为 note 节点。
- RPC：`knowledgeGraph`（scope/project/all）、`knowledgePromote`；面板「知识图谱」标签、SVG 星座图、节点详情、提升按钮。
- harness：4 个 topic hub、7 个记忆节点、7 条边；点击节点显示详情；提升后提示「已写入知识笔记」；735/520/430 无溢出；`__errors=[]`。
- 测试 146/146；重装 applied，激活自检通过。
- 截图：`docs/demo/v08-knowledge.png`。

## 31. 知识图谱修复 + 画像节点（2026-11-03）

- 线上问题：`Remote method knowledgeGraph is not mounted`。根因是客户端 `METHODS` 描述符列表漏注册 `knowledgeGraph`（host 方法存在，但客户端 mount 时没有 descriptor），不是数据问题。
- 修复：客户端 METHODS + RESULT_TYPES 补 `knowledgeGraph`、`knowledgePromote`、`obsidianExport/Import/Status`；激活自检增加 `knowledgeGraph` 调用。
- 自检：`knowledge: {ok:true, memories:367, topics:231}`，`panel-calls.jsonl` 出现 `knowledgeGraph ok`。
- 图谱改进：主题 hub 上限 24（多余合并为「其他」）；新增「用户画像」hub 与 12 条 trait 节点、证据连线（type=profile）。
- 测试 147/147；重装 applied。

## 32. 四标签页 + 知识库 + 描述符回归测试（2026-11-03）

- 线上 `knowledgeGraph is not mounted` 根因：客户端 METHODS 描述符漏注册；已补 knowledgeGraph/knowledgePromote/obsidian*/knowledgeList，并新增 `tests/panel-methods.test.js`：断言 host `PANEL_METHODS` 与 client `METHODS`、`RESULT_TYPES` 完全对齐，防止再次出现「Host 有、面板没挂」。
- 标签页：记忆 / 知识图谱 / 知识库 / 设置；设置卡片移入独立 tab；知识库 tab 列出提升出的笔记、vault 路径、同步按钮。
- 图谱：topic hub 上限 24（多余合并「其他」），新增「用户画像」hub + trait 节点 + 证据连线。
- harness：四标签可切换、知识库 2 条笔记、设置四组完整；735/520/430 无溢出；`__errors=[]`。
- 测试 149/149；重装 applied，自检 knowledge ok。

## 33. 知识图谱交互升级（2026-11-03）

- 工具条：搜索、`−`/`+`/`重置`、当前主题 chip；画布支持拖动平移、滚轮缩放（0.4–3x）。
- 点击主题 hub 只看该主题；过滤时下方出现结果列表，点列表项选中节点。
- 节点透明热区 12px，触屏/鼠标都可点；保留键盘 Enter/Space。
- harness：缩放 transform 1→1.25；搜索 JSONL 后节点 7→1 且结果列表出现；主题 chip「主题：存储 ×」；735/520/430 工具栏无溢出。
- 测试 149/149；重装 applied。
- 截图：`docs/demo/v09-graph-tools.png`。

## 34. 记忆设置二级标签（2026-11-03）

- 设置页四组标题改为二级标签：捕获与注入 / 保留与维护 / 数据 / Obsidian；一次只展示一组，底部「保存设置」仍一次保存全部字段。
- harness：四个子标签可切换，捕获组 3 行、保留组 2 行、数据组 3 按钮、Obsidian 组 vault/文件夹/2 按钮；735/520/430 子标签与设置卡均无溢出。
- 测试 149/149；重装 applied。
- 截图：`docs/demo/v09-settings-tabs.png`。

## 35. 设置分组提升为一级标签（2026-11-03）

- 一级标签变为：记忆 / 知识图谱 / 知识库 / 捕获与注入 / 保留与维护 / 数据 / Obsidian；「设置」一级 tab 移除。
- 每个分组页复用设置卡，只显示该组；底部「保存设置」仍一次保存全部字段；未保存状态提示保留。
- 窄宽标签自动换行：735/520 单行（35px），430 两行（65px），无横向溢出。
- 测试 149/149；重装 applied。
- 截图：`docs/demo/v09-top-tabs.png`。

## 36. 用户画像一级标签（2026-11-03）

- 一级标签新增「用户画像」，位置在「记忆」之后；原记忆页画像卡移除，避免重复。
- 画像页展示全部 trait（最多 10 条）：类型、证据数、置信度，并列出最多 3 条证据原文。
- harness：8 个一级标签；画像页 2 条 trait；735 单行 35px、520/430 两行 65px，无横向溢出；`__errors=[]`。
- 测试 149/149；重装 applied。
- 截图：`docs/demo/v09-profile-tab.png`。

## 37. 一级标签点击换行修复（2026-11-03）

- 现象：点选 Obsidian 标签时标签栏重新换行。原因：激活态 `font-weight:600` 让选中的长标签变宽，行宽越界触发重排。
- 修复：所有一级标签统一 `font-weight:600`（不再只在选中时加粗），内距 12→9px；空态/选中态只改背景与颜色，宽度恒定。
- 实测：735/620/600/560/540/520 均单行 35px，切到 Obsidian 高度不变；430 固定两行 65px（宽度所限，稳定不跳）。
- 测试 149/149；重装 applied。截图：`docs/demo/v09-tabs-520.png`。

## 38. 标签栏与卡片对齐居中（2026-11-03）

- 标签栏由 fit-content 改为 `width:100%` + `justify-content:center`，与下方卡片同宽（735/600/520/430 实测 tabsWidth=cardWidth）。
- 统一标签字号/行高/字重/内距；735–520 单行 35px，430 两行 65px；无横向溢出。
- 测试 149/149；重装 applied。截图：`docs/demo/v09-tabs-unified.png`。

## 39. 滚动条稳定（2026-11-03）

- 问题：切换标签时内容高度变化，滚动条出现/消失导致页面横向抖动。
- 修复：对包含 `.dsh-memory-root` 的祖先滚动容器应用 `scrollbar-gutter: stable`（含 html/body 兜底）。
- harness：把面板放进固定高度滚动容器，切换记忆/用户画像/Obsidian 时 `scrollbar-gutter` 计算为 `stable`，`clientWidth` 恒为 520；滚动高度 2005/520/539 变化但宽度不动。
- 测试 149/149；重装 applied。

## 40. Token 预算 v2 第一批（2026-11-03）

- 自适应注入预算：`adaptiveInjectionBudget(base, hits, followUp)`：1 命中 200、3 命中 256、6 命中 352，续问 220；不再固定吃满 360。
- 抽取遥测：capture 记录 `{promptTokens, transcriptChars, chunks, calls, items, applied}`，`stats.lastExtraction` 返回；设置摘要显示「抽取 N token」。
- 已有增量抽取：回合内缓冲达到 20000 字符先抽取并清空缓冲，turn/end 只提取剩余消息。
- 测试 152/152（+ 自适应预算、抽取遥测、stats 遥测）；eval hit@5 1.000 / precision@5 0.989 不降。
- 重装 applied，自检知识图谱 ok。

## 41. Token 预算 v2 第二批：输出收紧 + 7 天趋势（2026-11-03）

- 抽取输出收紧：`MAX_MEMORIES_PER_PASS` 6→4，prompt 改为「最多输出 4 条」「content ≤120 字」，`extraction.maxOutputTokens` 默认 600→400。
- 截断可恢复：`parseExtraction` 在 JSON 不完整时用 `salvageMemories` 扫描 `memories` 数组中已闭合的对象，保留前导完整条目；capture 接受 `finish=length`（文本非空时）并在遥测里记 `truncated`，不再整轮丢弃。
- 用量日志：`<root>/usage.jsonl` 每次注入/抽取追加一行，仅含 `{at,kind,tokens,items,budget|applied,calls}`，不写 prompt/查询/记忆内容；超过 256KB 压到最近 2000 行，坏行与未知类型跳过，写失败不影响回合。
- 7 天序列：`readUsage(root,{days,now})` 返回补零的本地日历日、`totals`（注入/抽取次数与 token、抽取写入数、超预算次数）、`avgInjectTokens`、`peakInjectTokens`；`computeStats` 以 `stats.usage` 返回。
- 面板：捕获与注入 tab 的设置项下方新增「Token 用量 · 近 7 天」分组柱状图（注入/抽取双柱、日期轴、图例、平均注入、超预算提醒），总量右对齐；无数据时显示空态提示，不渲染空图。
- harness：14 根柱、7 个日期标签（10/28–11/03）、总量 5210 token、图例「注入 1686 / 抽取 3524 / 平均 281/回合」，`__errors=[]`，trend 651×161，无横向溢出。
- 测试 **161/161**（+usage-log 6、截断抽取 1、stats usage 1、config/extract 期望更新）；eval hit@5 1.000 / precision@5 0.989 不降。
- 重装 applied；`panel-transport.json` 自检 ok，`stats` 已返回 `usage.windowDays=7`。
- 截图：`docs/demo/v09-token-trend.png`。

## 42. v0.10 知识笔记编辑器（2026-11-04）

- 新增 host API：`readKnowledgeNote` / `saveKnowledgeNote`（`host/knowledge.js`），RPC 为 `knowledgeNote` / `knowledgeSave`，已同步 `PANEL_METHODS`、PanelRemote、客户端 `METHODS`/`RESULT_TYPES`。
- 编辑模型：正文首个非空行作为标题，其余为可编辑正文；frontmatter 按原顺序重写，`dsh_knowledge`、`memoryId`、未知字段全部保留，topic/tags 更新；topic 变化时若正文存在自动生成的 `- [[旧主题]]` 链接则一并替换。
- 安全：文件名仅允许 `<name>.md`（拒绝 `../` 与目录分隔符），标题 ≤200 字、正文 ≤100KB、标签去重 ≤20 个；临时文件 + rename 原子写入，模式 0600。
- 冲突：保存携带 `expectedMtimeMs`，与磁盘 mtime 不一致时返回 `{saved:false,reason:'conflict',current}`，不写文件；面板显示警告并给出「重新加载」。
- 客户端：知识库列表每行可点开编辑弹窗（标题/主题/标签/正文），Esc 与遮罩关闭，保存后刷新列表与图谱；打开失败、保存失败、冲突均有独立提示。
- 单测 **170/170**（+knowledge-edit 8、+contract 1）；eval hit@5 1.000 / precision@5 0.989 不降。
- harness：打开首条笔记回填 title/topic/tags/body；改标题+正文保存后弹窗关闭、列表标题更新、显示「笔记已保存。」；强制冲突时出现「文件已被外部修改…」与「重新加载」，重新加载恢复磁盘标题；弹窗 520px（430 宽为 398px），`__errors=[]`，`scrollWidth=430` 无横向溢出。
- 截图：`docs/demo/v10-knowledge-list.png`、`docs/demo/v10-knowledge-editor.png`、`docs/demo/v10-knowledge-editor-430.png`。

## 43. v0.10 知识双向同步 + vault 笔记入图谱（2026-11-04）

- 新增 `exportKnowledgeToVault` / `importKnowledgeFromVault` / `listVaultKnowledgeNotes`（`host/obsidian.js`）：知识笔记整批同步到 `<vault>/<folder>/knowledge/`，导出内容逐字不变、相同文件跳过；导入只接收带 `dsh_knowledge: true` 的 `.md`，同名且内容不同计为 conflict，**不覆盖**本地编辑；`_index.md` 等私有文件忽略。
- 新增 RPC `knowledgeSync({direction:'export'|'import'})`，已同步 `PANEL_METHODS`、PanelRemote、客户端 `METHODS`/`RESULT_TYPES`。
- 图谱：`buildKnowledgeGraph` 支持 `source:'vault'` 的笔记节点（`vault:<file>`，青色）与本地知识节点（`note:<file>`，蓝色），并按 `[[wiki link]]` 连接已有主题 hub（`type:'wiki'` 虚线）；与本地同名文件去重；`memoryCount` 改为只统计记忆节点，新增 `noteCount`。
- 客户端：知识库增加「同步知识到 Obsidian / 从 Obsidian 导入知识」按钮，成功显示导入/导出/跳过/冲突计数；图谱增加记忆/知识笔记/Vault 笔记图例，选中 vault 笔记显示「导入知识库后可编辑」。
- 单测 **176/176**（+knowledge-sync 5、+contract 1）；eval hit@5 1.000 / precision@5 0.989。
- harness：导出提示「已导出 1 条 · 跳过 1 条。」；图谱 `vaultCircles=1`、`knowledgeCircles=1`、`wikiEdges=1`，搜索 Vault 后详情类型显示「Vault 笔记」；735/430 `__errors=[]`，scrollWidth=430 无溢出。
- 截图：`docs/demo/v10-knowledge-sync.png`、`docs/demo/v10-knowledge-sync-430.png`、`docs/demo/v10-graph-vault.png`。
