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

## 44. Codex 评审 P0：完整采集、证据更新、共享遗忘（2026-11-04）

- **持久采集**：新增 `host/capture-journal.js`。每条允许采集的消息先写入 `<root>/capture/sources/src_<hash>.json`（0600，写入后立即回读校验全文）；长消息按字符区间分段，所有分段落盘为 `capture/tasks.jsonl` 任务（`cap_<hash>`，含 segment.index/total、sourceIds、route）。不再有单消息 4000 字符截断、缓冲移除旧消息、只取前三段或预算耗尽直接跳过。
- **任务状态与恢复**：任务区分 `pending / running / done / partial / failed / unknown / skipped` 与 `callState: not-sent / requested / completed / failed / unknown`。进程重启时，`requested` 任务改为 `unknown`（不自动重发），未发送任务回到 `pending`；`captureRetry` 需要显式调用，`unknown` 还需 `confirmUnknown=true`。预算不足的任务保持 `pending`，不增加丢弃计数或假成功。
- **证据**：记录新增 `captureKey`、`captureTaskId`、`evidenceRole`、`quoted`；`sourceRefs` 增加 sourceId、角色、时间、摘录（≤240 字）。抽取 prompt 要求模型返回 `[src_…]` evidence；没有用户直接证据的条目落为 candidate，助手推测/引用/用户转述不会被写成用户确认事实。UPDATE/合并会用 `mergeSourceRefs` 保留旧证据。
- **替换安全**：SUPERSEDE 先构建并校验新记录、写入新记录，成功后才把旧记录标记 superseded；新项被拒绝或写入失败时旧记录保持 active。重复 turn 靠确定性 task/source id 与 `captureKey` 去重；A→B→A 保留三条历史，最新 A active。
- **共享与遗忘**：项目键仍来自 cwd，同一项目跨会话共享、其他项目不可见；global 才跨项目。`MemoryStore.listAll({includeDeleted:true})` 供删除守卫使用，待处理任务遇到同内容 tombstone 跳过；画像只聚合 active；删除不改写/删除知识笔记或用户 vault 文件。面板「捕获与注入」显示待处理/未知/失败/完成计数，并提供手动重试入口。
- **统计口径**：`stats` 新增 `capture` 计数与 `deleted`；usage 的 `tokens` 保留为估算 prompt token，provider 返回的输入/输出/总用量另存为 `extractProvider*`，缺失字段为 null 而非 0。截断输出任务标记 `partial`，不当作整段完成。
- **评测**：`scripts/eval-recall.mjs` 保留 30 题回归，新增 11 题独立难例（长消息首/中/尾、超过三段、跨会话、多事实组合、语义改写、时间更新、无答案）。明确 `precisionAtMost5` 与标准 `precisionAt5`；输出 `kind: retrieval-only`，不冒充真实模型回答测试。
- **检查**：测试 **212/212** 通过；eval 回归 hit@5 1.000、precisionAtMost5 0.989、必要证据覆盖 0.640、错误召回 1 题、注入率 1.00；难例必要证据覆盖 0.917、错误召回 3/11、无答案误注入 0/2、注入率 0.818。新增故障/恢复/幂等/证据/scope 测试 30 余项。
- **界面夹具**：harness 捕获与注入页显示「采集队列：待处理 1 · 未知 1 · 失败 0 · 完成 3」、重试按钮与 Provider 用量行，`__errors=[]`；截图 `docs/demo/v10-capture-queue.png`。
- **未验证/限制**：按本轮边界未安装、重启真实宿主，未做真实 profile 与真实模型端到端验证；provider usage 依赖模型流返回 usage，真实 provider 字段覆盖情况未实测；source 文件按完整原文保留（受本地磁盘约束），尚未做自动清理；面板重试 UI 仅通过静态检查与客户端契约测试，未在真实页面点击验证。

## 45. Codex 复核返工（2026-11-04）

针对 `docs/tasks/codex-reliability-review.test.mjs` 的 7 个隔离实测缺口逐项返工；该文件原样保留并已 7/7 通过，同时把稳定用例并入 `tests/capture-recovery.test.js`。

1. **同 native message id 重放**：`sourceIdOf` 不再把处理时钟计入身份；优先使用 `messageId`，其次使用宿主事件 `seq`/`time`，三者都没有时才用 role+text 退化并记录 `identityKind`。同 id 稍后重投不会再生成新 source/task。
2. **turn/end 后异步入队前退出**：turn/end 同步写 `capture-turns.jsonl` intake（session、projectKey、sourceIds、explicit、route、状态），异步只负责路由/分段；重启 `resume()` 先恢复 pending intake，再建 task，不再产生孤儿原文。
3. **跨项目同内容**：`#apply` 的去重、tombstone、target 校验改为按 `global` / `project:<key>` 作用域分桶；项目 A 删除或已有同内容事实不再阻止项目 B。
4. **partial 恢复**：`retry(partial)` 返回 ok，清除旧结果并标记 `completion`，显式重跑时把输出上限翻倍；partial 仍不等于 done，也不会自动重试。未实现按剩余片段自动拆分。
5. **completed 结果恢复**：请求前持久化 `requested`；模型返回后先把 `resultText/resultUsage/truncated` fsync 到 task，再解析/应用。重启时 `running+completed+resultText` 走本地重放（0 次模型调用）；completed 但无结果标记 unknown，绝不当作 not-sent 自动重发。
6. **来源级遗忘**：tombstone 记录的 `sourceRefs.sourceId` 会阻止同来源的待处理改写复活；只封禁该来源，不封禁整个项目；用户以新来源显式“记住”同内容允许重新记录，后台自动任务仍被 tombstone hash 阻止。
7. **替换中断**：新记录 append 前写 `capture-replacements.jsonl` intent；append 成功、旧项 superseded 失败时启动协调按 intent 完成旧项失效；replacement 缺失则 abort，旧项保持有效。恢复只做本地写入，不再调用模型。

同链路补充：
- `capture.minTurnChars` 恢复生效（低于阈值且非显式记忆的 turn 记 skipped intake，不建 task）。
- `index.js` 在启动 2s 后、每 5 分钟、以及设置保存后调用 `capture.resume()`；下一天预算和解除预算不再依赖测试专用 flush。
- journal/source/intake/replacement 写入改为 fsync + 原子 rename；requested/completed 在模型请求与应用前落盘；损坏 journal 行计入 `status.health.corruptTasks` 与 `status.degraded`，不再静默宣称完整恢复。
- 正式测试：**212/212** 通过（`tests/capture-recovery.test.js` 9 项、`tests/capture-reliability.test.js` 若干恢复/来源测试）。Codex 前一轮 7/7 通过，新增两项见 §46。

仍未验收/限制：
- 按任务边界没有安装、重启真实宿主，没有使用真实 profile 或真实模型做端到端；真实宿主的 `session/event` envelope 身份字段仅依据仓库调研资料（`messageId`/`seq`/`time` 依次退化），未在真实事件流采样核对。
- 来源原文保留尚无自动清理/容量上限，长期磁盘增长未验收。
- partial 补全仍是同一分段重试并提高输出上限，没有按已应用条目拆分剩余工作。
- 替换协调旧限制已由 §46 的当前进程回退/索引隐藏处理；store 完全不可写时仍只能保持 degraded 并在恢复时修复。
- 检索难例是固定检索测试，不代表真实模型回答正确率。

## 46. 最终复核：替换一致性与来源确认（2026-11-04）

- **live 生效视图**：新增 `supersedeRecord`：先走 `store.update`，失败时回退到 store 现有锁/fsync 的 `append(nextRevision(...))`；两条路径都失败时把旧记录从内存索引移除、replacement intent 保持 pending，并保留 degraded/恢复状态。`#apply` 在应用前也会协调 pending intent。当前进程不再同时用两条矛盾 active 事实回答，新用例在未重建 pipeline 的情况下同时核对 store 与 index。
- **来源类别**：消息来源 `source.kind/form` 随 source 落盘并写入 evidence `sourceRefs`；只有 `role=user && source.kind=user` 才算用户亲口确认。`model-selection` 等内部 `role=user` 上下文保留为内部上下文（prompt 标注、候选处理），不能仅凭 role 或词重合变成 active 用户事实；缺失来源按 unknown 保守处理。
- **夹具与检查**：`tests/capture-recovery.test.js` 已同步 Codex 最新 9 条用例；正式测试夹具补 `role`/`source:{kind:'user'}`，没有把非用户负例改成用户来源。Codex 命令 9/9 通过；正式测试 **212/212**。
- **未验收**：真实宿主安装/重启、真实 profile、真实模型端到端仍未执行；真实事件 envelope 的来源字段来自静态源码核对与夹具，不是线上采样；替换回退路径在 store 写入完全不可用时只能隐藏索引并标 degraded，store 文件可能仍保留双 active 直到恢复。

## 47. Codex 独立验收与原子替换修正（2026-11-04）

- Codex 经原 DSH 会话完成一轮开发及两轮返工，独立复测 7 条、随后 9 条问题用例。进一步查明 §46 的 update→append 回退仍使用同一底层写路径，且实际 degraded 计算未覆盖 pending replacement；因此该实现不能作为存储故障下的一致性保证。
- 用临时目录上的真实 MemoryStore/CapturePipeline，向 `fs.writeSync` 注入 EIO；修复前可复现权威文件已新增替代项、旧项仍 active。测试只使用模拟模型，无真实模型请求或真实记忆数据。
- `MemoryStore.replace` 现在在现有进程锁内刷新状态，保留文件历史，将旧项失效与新项写入同一临时文件，fsync 后原子 rename，再发布缓存和索引。提交前任何写入失败都不发布其中一半；该路径不再依赖 §46 的索引隐藏或再次 append 补救。原来的已保存模型结果仍用于显式本地重试，避免再次请求模型。
- `tests/atomic-replacement.test.js` 已观察到修复前失败、修复后通过：核对原文件未变、内存与索引一致、重开存储结果、历史保留，以及恢复仅使用 1 次模拟模型请求。旧单写入模拟用例随替换入口更新，核心断言保留。
- 最终执行 `node --test --test-reporter=spec tests/*.test.js`：**213/213 通过**，包括正式的 9 条复核回归；日志在被忽略的 `docs/tasks/codex-final-tests-20261104.log`。文档与 diff 格式检查通过。
- 仍未安装/重启真实宿主，未做真实 profile 与模型端到端验收。partial 仍为显式提高输出预算重试；原文容量治理、50k 性能及同作用域文件原子重写的成本尚未验收。不能据此宣称全部原生功能或真实回答质量已通过。

## 48. 原生安装与 50k 容量/性能实测（2026-11-05，历史；性能/容量结论由 §50 复测取代）

- **安装**：从本仓库源码打包 `@missher/dsh-memory@0.2.0-native.20261105`，先移除旧 link 安装，再经 `plugin_manager.install_bundle` 安装并从 profile 回读为真实 tarball（非 link）；正常重载 applied。随后源码继续修改，最终重新打包 `0.2.1-native.20261105` 并安装；profile 回读 `node_modules/@missher/dsh-memory/package.json` 为 `0.2.1-native.20261105`，pnpm-lock 为同名 tarball（非 link）。客户端 inspect 的 `settings.section` occupants 包含 `memory`（active），panel-transport 当前走受支持的 web-server fallback（`selfTest` 为 false，原因 transport is web-server；Typert 绑定失败原因未在产品中暴露，未绕过鉴权排查）。
- **真实模型链路（部分）**：通过 `session_scratch` 创建隔离 QA 会话，`session_send` 投递消息由真实宿主/真实 provider 处理。测试消息 7771 字符（<8000，单段），真实抽取调用 1 次，provider 返回 input 2316 / output 56 / total 2628；因来源是 `session-bridge`（非 `source.kind=user`），按来源门控未写成 active 用户事实，`resultText` 明确 `skipReason`。这验证了非用户来源门控和真实 provider usage，但没有完成“用户亲口长消息 3 段以上”的验收。
- **未完成的原生项**：DSH Web GUI 有 loopback 鉴权，独立浏览器无法进入设置页；未绕过鉴权。因不能从用户键盘直接向 QA 会话发送 >8000 字符的 user-role 消息，长消息只到 7771 字符/1 段；跨会话同项目、真实设置页队列/重试、真实遗忘注入均未完成。`sourceKind=session-bridge` 的 QA 输入按设计不产生 active 用户事实，不能当作用户长消息验收。
- **容量治理（已由 §50 取代）**：早期实现曾按 30 天保留期回收 done 来源；该策略已移除，用户原文改为全量保留 + gzip 压缩。任务/回合/替换账本超阈值时保留最新 revision 压缩；`status.storage` 暴露来源数/字节/任务数/回合数；面板捕获页显示来源数与体积。测试见 `tests/capture-capacity.test.js`：有引用来源保留、旧孤儿删除、窗口内不删。
- **50k 性能（真实测，Intel i9-9880H / 16GB，隔离临时 50k JSONL）**：store 冷加载 **405ms**、索引构建 **926ms**、启动可用 **1331ms**、搜索中位 **29.33ms**、p95 **38.98ms**、heap **160MB**、磁盘 **27.7MB**。相对旧基线（1028ms 构建、p95 99.19ms、heap 110MB），检索 p95 明显下降，但构建/启动与 heap 未达到 ≤300ms/≤150MB 目标；未通过少测数据或 warm-index 冒充。合成 bench（无 store 加载）为构建 1046ms、p95 38.63ms、heap 95MB。
- **检查**：`node --test tests/*.test.js` **215/215**；`node scripts/eval-recall.mjs` 回归 hit@5 1.000 / 必要证据覆盖 0.640 / precisionAtMost5 0.989；难例覆盖 0.917、无答案误注入 0/2。
- **限制（§50 已取代部分）**：真实用户键盘长消息、同项目跨会话注入/回答、设置页按钮点击、真实遗忘后另一会话注入由 Codex 后续验收；早期容量删除策略已移除；来源原文现在全量保留并压缩。

## 49. 提炼完整性、容量真回收与搜索复测（2026-11-05，历史；最终策略见 §50）

- **提炼完整性**：`MAX_MEMORIES_PER_PASS=4` 达到时不再把该段标 done，而是保留已应用条目、把原覆盖范围按字符连续拆成两个持久化子任务（`parentTaskId`、`depth`、确定性 task id），直至最小 1200 字符/深度 4；子任务在同一 drain 内继续。输出截断（length/max-tokens 且有文本）同样走拆分；空文本 `max-tokens` 视为已知容量事件，拆分而不标记 failed/unknown，也不整段重发。`extraction.maxOutputTokens` 默认 400→800，避免真实 provider 把 JSON 输出预算压空。历史 12 条真实 `max-tokens` failed 任务保留原 callState/reason，不自动重付；需要人工 `retry`。
- **测试**：`tests/capture-completeness.test.js` 用一个 >3 段、10 个头中尾事实的源和“每次最多 4 条”的模拟模型，验证所有事实最终 active、存在 parent/child 任务且不重复记录；另一个空 max-tokens 用例验证递归拆分、状态 partial/complete、不 failed。模拟结果不代表真实模型全量提炼。
- **容量（§50 取代）**：现在不再删除任何用户 source；全量保留并 gzip 压缩。`capture.maintain()` 压缩来源并压缩账本，source id/task id 不变。`tests/capture-capacity.test.js` 覆盖压缩后逐字读回、旧内联压缩、账本身份保留。
- **搜索**：移除不准确的“inverted candidate pruning”注释；保留 topK min-heap、BM25 常量预计算、作用域/状态/遗忘过滤。50k 冷测（Intel i9-9880H/16GB，隔离临时 JSONL）store 405ms、index 926ms、启动 1331ms、p95 38.98ms、heap 160MB、磁盘 27.7MB；p95 达标，heap/启动未达标。尝试过真实倒排 postings，实测 p95 60–66ms、heap 150–160MB、构建更慢，已回退，保留简单扫描+topK。
- **最终安装**：重新打包 `0.2.2-native.20261105` 并安装；profile 回读版本/锁/核心文件哈希一致，重载 applied（panel-transport 为 web-server fallback）。
- **测试**：`node --test tests/*.test.js` **218/218**；eval 指标保持（回归 hit@5 1.000 / 必要证据覆盖 0.640 / precisionAtMost5 0.989；难例覆盖 0.917 / 无答案误注入 0/2）。
- **仍限制**：真实用户 keyboard 长消息、同项目跨会话、GUI 设置点击、真实遗忘注入仍由 Codex 后续原生 QA；capacity 未在真实 50k 数据上执行；启动/heap 目标未达；未提交 Git。

## 50. 最终修复：父任务归并、length 已知结束、全量原文压缩（2026-11-05，性能旧口径由 §53 取代）

- **父任务归并**：`#settleAll` 在 drain 开始与结束运行，只有所有直接子任务均为 `done`/`skipped` 才把 `partial` 父任务改为 `done`；failed/unknown/叶子 partial 阻止归并；多级与重启后一致。已纳入 `tests/capture-completeness.test.js`（多级 cascading + 阻塞状态）。
- **length 空输出**：`#collect` 对任何收到的终止 `finish`（含 `length`、`max-tokens`）设 `completed=true`，未知只留给缺失 finish/断网；空 length 走已定义拆分，不再标 unknown。Codex 原两项 review 用例现已通过，回归已移入 `tests/capture-completeness.test.js`。
- **内部段不付费**：任务来源若没有 `role=user && sourceKind=user`（兼容旧 `unknown`）的直接用户证据，直接标 `skipped`/`callState=not-sent`，不请求模型；runtime-context / skill-catalog / memory / plugin 内容 / bridge 单独不生成用户事实。`tests/capture-completeness.test.js` 用 runtime-context + assistant 段断言 0 次模型调用。
- **原文压缩**：新来源写 `<id>.json.gz`（gzip level 6）+ `<id>.json` 元数据（id/kind/hash/bytes），`readSource` 透明解压并校验 sha256；不再按 30 天删除 done/skipped 用户原文，source id、task id、sourceRefs 全部保留。维护时压缩旧内联 `.json`，仍可逐字读回。临时目录测试证明压缩后体积明显下降且 `readSource` 字节相等；真实源未做删除实验，未改旧 TDAI/MSE/Context。
- **性能新测（本轮，Intel i9-9880H/16GB，完整 50k JSONL）**：store 冷加载 **365ms**、index 构建 **675ms**、启动 **1040ms**、搜索中位 **21.92ms**、p95 **28.51ms**、heap **130MB**、磁盘 27.7MB。p95/heap 达标；启动仍高于 300ms，主因 store 365ms + 全量索引构建；未实现持久化索引缓存，未再用更慢的 postings 方案。合成 bench：构建 798ms、p95 32.85ms、heap 104MB。
- **原子替换 50k**：同作用域单条替换 **1091ms**、重写 28.7MB；旧记录 superseded、新记录 active、仅一条 active。保留 Codex §47 原子事务修复。
- **真实 QA 复用（Codex 独立证据，不是本轮新发请求）**：31,537 字符 user 来源原文逐字回读相等，9 个事实/偏好全覆盖；同项目新会话真实注入命中头中尾 3 项、无工具调用。另 52,709 字符在进入模型前被 MSE `prepare()` 的 32,768 上限以 `invalid_prompt` 拒绝，未产生模型消耗；这是外部入口限制，不归因于 Memory，也不宣称无限长。
- **测试**：`node --test tests/*.test.js` **223/223**；最终安装 `0.2.3-native.20261105`。

## 51. 查询分页修复与最终 0.2.4（2026-11-05，性能/索引由 §53 取代）

- **分页**：`listMemories` 的查询分支不再用 `PANEL_LIMIT.max` 截断 `index.search`；改为取完整匹配集后再按 kind/topic/status 过滤、计算 total 并 slice 当前页。单页仍 ≤200，total/offset 对全部匹配负责。新增 `tests/remote.test.js` 250 条匹配分页回归：第一页 200、第二页 50、total=250、ID 并集 250。Codex `docs/tasks/codex-native-pagination-review.test.mjs` 已通过。
- **标签**：捕获页 storage 文案从“任务版本数”改为“任务数”，不再把最新任务条数误报为 revision 数。
- **测试**：`node --test tests/*.test.js` **224/224**；Codex continuation review 2/2 通过；分页 review 1/1 通过。
- **性能/容量复测**（本轮，50k 完整 JSONL，Intel i9-9880H/16GB）：store 365ms、index 675ms、启动 1040ms、p95 28.51ms、heap 130MB、磁盘 27.7MB；50k 同作用域原子替换 1091ms、重写 28.7MB，旧 superseded/新 active 且仅一条 active。启动未达 300ms，未实现持久索引缓存；未使用更慢的 postings。
- **安装**：最终打包 `0.2.4-native.20261105` 并经插件管理器安装/重载；版本、lock、核心文件哈希回读一致。未新增真实模型请求，真实 QA 复用 Codex 证据（31,537 字符逐字保存、9/9 覆盖；同项目新会话头中尾 3 项注入；跨项目全局偏好命中且项目事实不泄漏；删除后新会话不注入；无工具调用）。52,709 字符被 MSE `prepare()` 的 32,768 入口限制以 `invalid_prompt` 拒绝，未产生模型消耗，不归因 Memory。
- **限制**：捕获任务仍可能有叶子 partial；启动/heap 持久化索引未落地；gzip 只对 source 文件透明压缩，不改变任务/账本结构；真实 50k 未做清理/压缩实验（仅临时目录）。

## 52. 短写安全与 gzip 发布顺序（2026-11-05）

- **短写修复**：`writeAtomic` / `appendDurable` 改为按 Buffer 字节偏移循环调用 `writeSync`，每次核对返回字节数；返回 0/无进展立即失败。原子临时文件失败不 rename、不发布元数据；append 失败回滚到原文件大小，避免留下截断的 task/turn 身份行。
- **压缩发布顺序**：压缩旧内联 source 时，先写 gzip，读回 gunzip 并核对 sha256 与原文完全相等，之后才用元数据替换内联正文；元数据写后再次 `readSource` 校验，失败则恢复原内联正文。故障路径保留原文，不发布删除 text 的元数据。
- **回归**：Codex `docs/tasks/codex-source-short-write-review.test.mjs` 通过；正式测试新增合法半量短写、0 进度短写失败、旧内联恢复、压缩/读回四种（`tests/capture-capacity.test.js`）。`node --test tests/*.test.js` **226/226**。
- **真实运行时说明**：profile 0.2.4 文件已匹配，但安装后运行中的维护仍把旧 QA source 保持内联（`compressed` 未设置，94,207 磁盘字节），说明宿主热重载仍复用旧依赖/模块；本轮只安装 0.2.5 并保存回执，不主动重启正在执行本会话的宿主。Codex 空闲后正常重启，需以真实 gzip 格式/新采集行为复验，不把本轮安装当压缩已生效。
- **安装**：`0.2.5-native.20261105`，最终包 `dsh-memory-0.2.5-native.20261105.tgz`；安装后回读版本/核心文件哈希。真实 source 未注入故障，未在真实记忆上做压缩/清理实验。
- **保留限制**：启动 1040ms 未达 300ms；持久索引缓存未落地；叶子最小子段仍可能 partial；MSE 32,768 入口限制不归因 Memory。

## 53. 紧凑数值索引与真实分页（2026-11-05，churn/分页修复由 §54 取代）

- **索引表示**：每文档改为 `Int32Array` 词项 id + `Uint16Array` 词频，词项用数值字典；热点查询走 postings（term id → slot/tf 数组）累加 BM25，不再为每文档保留 `Map<string, tf>` 全扫描。JSONL 仍是唯一权威，索引可随时重建；upsert/remove/rebuild 同步维护 slot、df、postings（批量删除后重建 postings）。
- **分页**：新增 `MemoryIndex.searchPage`，一次扫描统计 total/kindCounts/topicCounts，只为 `offset+limit` 的页构建 hit 对象；`listMemories` 查询分支改用该接口，单页 ≤200，250 条 total/offset 回归与 Codex pagination review 通过。不再构造完整 50k hits/termScores。
- **公开 50k 冷进程 benchmark**（`scripts/bench-storage.mjs 50000`，父进程生成/子进程加载，OS 页缓存未清，非 warm-index）：store **588.51ms**、index **1320.92ms**、indexReady **1909.42ms**、firstQuery **28.18ms**、中位 **8.91ms**、p95 **19.48ms**、heapAfterQueries **238.71MB**、GC 后 **115.88MB**、indexSizeAfterGc **50000**、磁盘 **30.03MiB**、50000 同作用域原子替换 **844.02ms** 且重开正确。热查询和 GC 后内存较旧口径明显下降；indexBuild/indexReady 仍高于旧口径，启动目标未达，未用缩小数据/old warm 数字冒充。
- **短写**：`writeAtomic`/`appendDurable` 循环写完、0 进度失败回滚；gzip 先读回/哈希验证再发布元数据（§52）。
- **测试**：`node --test tests/*.test.js` **226/226**；recall eval 保持 hit@5 1.000 / 必要证据覆盖 0.640 / precisionAtMost5 0.989；hard 0.917、无答案误注入 0/2。
- **真实运行**：0.2.5 已由 Codex 重启后验证真实 gzip/提炼/注入/遗忘；本轮不改真实记忆、不发真实模型请求。0.2.6 安装后若热重载仍复用旧模块，需 Codex 重启复验 gzip 与索引行为。
- **安装**：最终包 `0.2.6-native.20261105` 已由插件管理器安装（`applied`），profile package/lock/核心文件哈希匹配；未主动重启宿主，若热重载复用旧模块需 Codex 正常重启复验。
- **限制**：indexBuild/indexReady 未达 ≤300ms；未引入持久索引缓存；叶子最小子段仍可能 partial；MSE 32,768 入口限制不归因 Memory。

## 54. 索引churn回收、确定性分页与截断无JSON补全（2026-11-05）

- **Churn 容量**：`upsert` 在派生槽位超过 `2×live + 64` 时用存活记录重建全部派生结构（slots/lengths/docTerms/docFreqs/词项字典/postings）；1 条记录更新 5000 次后查询 scratch 分配 ≤4096，`size=1`，旧词项不可查。正式回归在 `tests/search.test.js`。
- **确定性分页**：heap 的 `worse/better`、边界替换与最终排序统一使用全序：score 降序、updatedAt 降序、id 升序。350 条同分同时间混合词频、每页 37 条不再重复/遗漏；250 条 total/kind/topic 分页回归保持。
- **截断无 JSON**：`#applyStoredResult` 在 `meta.truncated=true` 且 `parseExtraction` 抛错时，不再 failed；保留原付费 `resultText/resultUsage`，按原覆盖范围拆分有界子任务，父任务 partial，子任务完成后 `settleAll` 归并。未截断坏 JSON 仍 failed；unknown/网络不明不自动重发；叶子如实 partial。合成解释性文本 + 长度终止 + 临时 MemoryStore 用例，不含真实 MSE 正文。
- **公开 50k 复测**：完整数据在新子进程加载，OS 文件缓存未清；Codex 独立复测的完整数值见 §56，后续分词优化数值见 §64，避免把后续版本的测量回填为本阶段结果。
- **测试**：`node --test tests/*.test.js` **229/229**；Codex index-churn review 2/2、short-write 1/1、pagination 1/1、continuation 2/2；recall eval 保持。
- **安装**：打包 `0.2.7-native.20261105` 并经插件管理器安装（applied），profile package/核心文件哈希一致；未主动重启，热重载可能复用旧模块，待 Codex 空闲正常重启复验。真实 QA 证据复用 Codex（31,534 字/9 项、跨会话/遗忘）未重发模型。
- **限制**：indexReady 1856ms 未达 300ms，无持久索引缓存；叶子仍可能 partial；真实 0.2.7 运行态待重启验收。

## 55. remove 回收与截断 usage 补齐（2026-11-05）

- **remove 回收**：`#maybeCompact` 从 `upsert` 抽为私有方法，`remove` 在每次删除后执行同一阈值回收；清空/大量遗忘后 slots/lengths/docTerms/docFreqs/零 df 词典/postings 一并重建。5000 条删除 4999 条后查询 scratch ≤4096，剩下 1 条仍可查；无需再写一条才回收。
- **截断 usage**：`#applyStoredResult` 的“truncated 且无 JSON”catch 在拆分后复用一条最小 `onExtraction` 通知：`items/applied/rejected=0`、`truncated=1`、`status=partial`、`calls` 与 `usage` 来自原付费结果；replay 时 `calls=0`。父任务账本保留 `resultUsage`，usage 总量与 calls 不再少记。未截断坏 JSON 仍 failed，unknown/网络不明不自动重发。
- **正式回归**：新增 remove 回收、截断父 usage 通知断言；Codex index-churn review 第三例、truncated-usage review 均通过。`node --test tests/*.test.js` **230/230**。
- **性能**：不重复运行公开 50k；沿用 Codex 独立复测 p95 **18.61ms**、indexReady 约 **1.88s**、heapAfterQueries **211.86MB**、GC 后 **115.88MB**（GC 后不是峰值）且 index 仍 50000；启动 300ms 目标仍未达，未声称达标。
- **安装**：`0.2.8-native.20261105` 打包安装，回读版本/文件哈希；未重启、未发真实模型请求，重启验收交 Codex。

## 56. Codex 独立原生验收与本轮结论（2026-11-05）

- **最终运行版本**：DSH 在原开发会话完成开发、打包与插件管理器安装。Codex 回读 desktop profile 的 `0.2.8-native.20261105`，确认入口、客户端、capture/journal、RPC、索引和 store 与本仓库代码逐字一致。所有会话和提炼任务空闲后落盘重启意图，正常退出/启动宿主；新进程 Typert 的 stats/list/profile/knowledge 自检通过。未切换默认模型，未修改 MSE、Context 或旧 TDAI 项目，未推送/发布。
- **真实长消息**：通过原生 `session/prompt`，使用当前宿主 `deepseek-account/deepseek-flash`，输入来源实测为 `user`，发送 **31,536 字符**。完整原文 gzip 读回逐字一致，根分段的范围连续覆盖全文；首、中、尾 **9/9** 项测试信息成为有效记忆（5 条项目记忆、1 条全局偏好）。共 3 个根任务及 2 个自动子任务：4 次真实提炼完成，1 段纯内部上下文未请求模型并 skipped；父任务在子任务完成后正确结束。原始回执和 provider usage 已保存。
- **跨会话召回**：另一会话的提问不含答案；真实 `source.kind=memory` 事件注入了仓库代号、构建节点别名、归档桶名，最终回答三项命中，工具调用为 0。另一个项目的会话只注入全局报告结束标记，项目专属代号未注入，回答“不记得”。
- **遗忘**：通过原生 `removeMemory` 遗忘项目代号后，在未见过新代号的另一会话提问；该值不再进入 pre-step 注入，最终回答“不记得”，工具调用为 0。随后仅通过同一原生接口清理其余 5 条本轮测试记忆；QA 项目/全局无剩余有效测试记忆，设置与默认模型和基线一致。此前及本轮 QA 任务合计 done 17 / skipped 2，无 pending/running/failed/unknown。测试会话与审计原文保留，不声称物理擦除了全部测试痕迹。
- **来源容量**：0.2.5 激活时曾冷态核对 150 条既有原文，压缩后逐条正文哈希一致；原文 336,417 字节，对应 gzip + 元数据 208,092 字节。0.2.8 新长消息再次验证完整读回。测试填充文本重复率较高，不能将其压缩率推广到所有真实对话。原文不按时间自动删除；磁盘仍有限。
- **独立复现与修复**：先复现同分分页 350 条只覆盖 175 个唯一 id、连续更新/批量遗忘后残留槽位、截断无 JSON 停止补全、截断父调用漏计 usage，修复后用相同输入通过。最终改动的 search/capture-completeness/usage 及独立复现 **28/28**；前一版相关 search/scope/remote/recovery 复核 **67/67**。DSH 记录完整套件 **230/230**，Codex 未为未变代码重复整套测试。
- **完整 50k 测量**：公开 `scripts/bench-storage.mjs 50000` 使用完整、单一正确项目作用域 JSONL；父进程生成，新的子进程加载，**没有清 OS 文件缓存**。Codex 实测 store 617.73ms、index 1257.68ms、可检索 1875.41ms、首查询 37.05ms、中位 8.92ms、p95 **18.61ms**；查询结束时 heap **211.86MiB**，GC 后保留 **115.88MiB** 且索引仍含 50,000 条；磁盘 **30.03MiB**。同作用域原子替换 966.59ms，重开验证旧项失效、新项有效且数量不变。测量在 0.2.7 完成，0.2.8 仅补 remove/upsert 回收和截断 usage，未改此初建/查询路径，按要求复用该证据。相同数据旧索引 p95 为 69.28ms、GC 后 165.28MiB，但启动较旧的 1376.85ms 变慢；这是查询/保留内存收益与初始化成本的取舍，不能称全部性能目标达标。
- **原生页面边界**：0.2.5 已观察正常 Memory 页面、队列/容量读数，无横向溢出或错误；后续客户端未改。0.2.8 使用真实宿主 RPC 与模型验收上述链路，没有再次执行完整 UI/卸载循环。
- **仍有限制**：启动 300ms 目标未达；查询后 heap 不是 150MiB 以下，GC 后数值不是峰值。固定检索回归必要证据覆盖 0.640；11 个难例覆盖 0.917、错误召回 3 题、无答案误注入 0/2，最终 hard MRR 为 0.889（稳定同分排序改变了顺序），不代表任意问题的真实回答质量。已知持续截断达到拆分边界仍保留 partial；真正结果未知不自动重发。当前宿主 MSE 在 Memory 前拒绝超过 32,768 字符的单次 prompt，本轮未修改该限制。
- **当时的历史任务状态（后续恢复见 §64）**：最后重启前已有 failed 18 / partial 1，之后本轮 QA 未新增失败。前 17 个失败来自早期输出预算问题，新增的截断无 JSON 子任务已定位并修复未来处理路径；原历史失败及被阻塞的父任务保留，未自动付费重跑，也未通过改账本清零来伪装恢复。用户原有记忆未被测试清理操作删除。

原始意图、回执、测试日志、事件和 proof 保存在忽略的 `docs/tasks/codex-native-qa-20261105/`；这里仅记录不含用户原文的公开结论。真实宿主对合成 QA 内容的验收、临时目录的合成故障测试、固定检索评测和 50k 合成容量测试分别陈述。


## 57. 干净打包与 0.2.9 元信息核验（2026-11-05）

- **根因**：旧打包命令直接 `cp` + macOS `tar`，把 AppleDouble `._*` 与 `com.apple.provenance` PAX/xattr 带入 tarball；monkey-patch 无法解决，必须换打包流程。
- **修复**：新增 `scripts/pack-plugin.py`：显式文件白名单、Python `tarfile` USTAR（无 PAX/xattr）、过滤 `._*`/`.DS_Store`/`__MACOSX`/`.tmp`，打包后回读校验成员、AppleDouble magic、locale 必须仅 `en.json`/`zh.json`，输出 sha256。`package.json` 增加 `pack` 脚本。
- **0.2.9 包核验**：`dsh-memory-0.2.9-native.20261105.tgz`，sha256 `babf0ccc53ed04b4518c984469945087deaa6a364ad67ec604c3fe93167306e4`；28 个成员，无 `._*`、无 PAX/xattr；locale 只有 `en.json`/`zh.json`。安装后 profile locale 同样只有这两个文件，插件管理器 bundle 列表显示 `@missher/dsh-memory 0.2.9-native.20261105`、`include:dsh-memory` active，未再出现非法 locale 元信息。
- **安装**：插件管理器 `application: applied`；未主动重启；`docs/tasks/native-install-0.2.9.json` 记录版本、包 SHA256、locale、元信息与待重启状态。未改宿主忽略非法文件，也未手改 profile package/cordis。
- **测试**：230/230；本轮未发真实模型请求、未重试历史任务、未改真实原文。

## 58. 历史恢复时间守卫与遗忘授权（2026-11-05）

- **观察时间**：`#apply` 不再使用处理时钟；每条 item 的 `observedAt` 取选中用户证据的原始 `at`（多个取最新；无用户时间时保守使用已知证据时间/处理时钟）。`buildRecord` 新增 `observedAt` 选项。
- **旧来源保护**：旧来源的 UPDATE/SUPERSEDE 在目标 `observedAt` 更新时不再覆盖目标，而是保存为 `candidate` 历史；ADD 命中自动相似替换时同样保护；同内容 merge 保留较新观察时间。有效旧信息因此可见而不改写较新事实。
- **遗忘授权**：`manual=true` 不再等于用户重新授权；只有 `task.explicit===true` 且来源时间明确晚于 tombstone 才允许恢复相同内容。旧来源/手动重试尊重 source tombstone 与 content tombstone，不会复活用户已遗忘内容。
- **提示时间**：提炼 transcript 每个来源带 `来源时间 ISO`，避免把旧“现在”解释成恢复当天。
- **回归**：`tests/capture-time-guard.test.js` 用 T1 旧来源排队、T2 现有事实、T3 恢复，覆盖 UPDATE/SUPERSEDE/ADD 自动相似三条路径，目标保持 active/T2、旧值保留 candidate/T1；另有用例验证删除后 manual 恢复不复活。`node --test tests/*.test.js` **232/232**；既有 230 项保持。
- **真实恢复**：未执行任何真实任务；逐项计划见 `docs/tasks/history-recovery-plan-20261105.md`，恢复由 Codex 安装后执行。
- **安装**：最终包 **0.2.10-native.20261105** 已打包安装并保存回执；未主动重启、未发真实模型请求。

## 59. 启动分词优化与历史恢复缺口（2026-11-05）

- **启动热路径**：`tokenize` 改用 code-point 数值区间快路径（CJK/ASCII word），去掉每字符两次正则；保留 NFKC、大小写折叠、CJK unigram+bigram、词频与顺序语义。`tokenize` 回归通过。公开 50k 同数据/查询：index **1089ms**（旧 1258ms）、indexReady **1676ms**（旧 1875ms基线 / 上轮 1711ms）、store **587ms**、firstQuery **33.37ms**、p95 **17.89ms**、heapAfterQueries **211.87MB**、GC 后 **115.87MB**（index 50000 仍可达）、磁盘 30.03MiB、替换 **767.82ms** 重开正确。启动 300ms 目标仍未达；首次/后续未用缓存冒充。
- **历史时间守卫范围**：上一版 `staleSource` 看整个 scope，导致无关新记录把全部旧 ADD 打成 candidate；现在仅 UPDATE/SUPERSEDE 目标或 `#findSimilar` 同一事实冲突做时间保护，无关旧事实按正常置信度 active 并保留 T1 observedAt。`codex-history-safety-review` **5/5**。
- **保存截断恢复**：`retry` 对 `resultTruncated=true && callState=completed` 的已保存结果先本地 replay/split，父 attempts 不增加、原 resultText/usage 保留；已有 child 的 partial 父只递归恢复未完成叶子，不重发 done 子任务；manual 子任务继承 `manual=true`，不全局放宽预算；unknown 仍不自动重发。`codex-saved-truncation-recovery-review` 通过。
- **恢复计划**：`docs/tasks/history-recovery-plan-20261105.md` 明确 3 条纯 assistant 本地 skipped、`cap_7c024...` 本地 replay split、14 条 known empty max-tokens 显式 manual 恢复、父 `cap_99d607...` 等所有孩子结算；本阶段未执行真实任务/未发模型请求。
- **测试**：`node --test tests/*.test.js` **232/232**；既有 recall eval 保持 hit@5 1.000 / coverage 0.640 / precisionAtMost5 0.989。
- **安装**：0.2.11 干净包已打包安装（见回执）；未重启、未改真实任务。

## 60. 完成标记与有界补全（2026-11-05）

- **complete 标记**：抽取协议新增完整 JSON 布尔 `complete`；`parseExtraction` 返回 `true/false/undefined`。`complete:true` 且 provider 未截断时，恰好 4 条也直接 done；provider `length/max-tokens` 截断永远 partial；旧结果无标记仍按 4 条上限保守处理，不被强制改成 done。
- **有界补全**：无法继续按字符拆分（密集小段/已到最小粒度）的 partial 会创建持久化补全子任务（`completionOf`、`completionDepth`、`appliedContents`），最多 2 轮。补全 prompt 带「本段已应用，勿重复」以及已应用事实，要求只输出遗漏；子任务继承 manual 授权，但全局预算不变。
- **无进展/未知**：补全轮 `applied=0` 时停止自动补全并保留真实 partial 原因；unknown 不自动重发；done/skipped 子任务不重发；父任务仅在全部孩子 done/skipped 后 settle。旧 partial 的显式 retry 保留原付费 `resultText/attempts/usage`，不重发整个父段。
- **防编造**：prompt 明确禁止把 assistant 文本提到的项目名/实体加到用户未指定的事实；补全同样受来源门控与 tombstone 约束。
- **测试**：新增 `tests/capture-completion-marker.test.js` 覆盖 4 条 complete=true、complete=false 有界补全、provider 截断不可伪完成、无进展停止、旧 partial 显式重试保留结果。全量 **239/239**；`docs/tasks/codex-history-safety-review` 5/5、`codex-saved-truncation-recovery-review` 通过。
- **启动实测**：tokenize code-point 快路径后公开 50k：store 587ms、index 1089ms、indexReady **1676ms**、firstQuery 33.37ms、p95 **17.89ms**、heapAfterQueries **211.87MB**、GC 后 **115.87MB**（index 50000 仍可达）；启动 300ms 目标仍未达。
- **恢复计划**：`docs/tasks/history-recovery-plan-20261105.md` 已按 19 条真实任务列出 3 条纯 assistant skipped、1 条 saved truncation split、14 条 known empty max-tokens manual、父任务孩子结算；本轮未执行真实恢复、未发真实模型请求。
- **安装**：0.2.13 干净包由插件管理器安装；未重启，Codex 重启后执行真实恢复/QA。

## 61. 分段意图、消息开头语境与同源事实（2026-11-05）

- **明确保存意图**：`task.explicit` 已从 turn intake 传到每个分段；本轮把它传入提炼 prompt。所有分段（含 from>0 的尾段）都看到“明确保存意图”，不再只看尾部中性填充。
- **尾段语境**：from>0 的 entry 会附带同一 source 的前 600 字「消息开头语境（仅供解释，不是本次证据）」，实际 evidence 范围/offset/provenance 不变；模型不得从语境区写证据。
- **同源优先上下文**：prompt 的已有记忆先取当前项目/global 中 sourceRefs 命中本任务 source ids 的 active/candidate（最多 6 条），再补通用 search；去重后送入，避免同 source 前面根段已提炼事实在尾段丢失，也不重复写入。
- **短标识规则**：prompt 明确用户要求长期保存的项目名、代号、配置标识即使很短/像测试内容也要保存；纯填充可忽略；secret/scope/遗忘约束不覆盖。
- **split 子任务**：`#scheduleContinuations` 现在继承 `appliedContents`，避免子段再返回父段同 4 条改写；补全仍最多 2 轮。
- **测试**：新增 `tests/capture-segment-context.test.js` 3 项，覆盖尾段意图/开头语境、同源已提炼事实优先、explicit=false 不注入保存意图；相关 capture/extract/time/source 回归 **35/35**。按指示未重跑完整 suite/benchmark。
- **安装**：0.2.15 干净包安装并回读，未重启、未发真实模型请求；真实恢复/QA 仍由 Codex 重启后执行。

## 62. 内部来源证据隔离与混合证据（2026-11-05）

- **模型输入隔离**：`#processTask` 先从模型可见 entries 中剔除 `role=user` 且 `sourceKind` 非 `user`/`unknown` 的内部消息（memory/runtime/skill/tool/bridge 等）；正常 assistant 上下文保留；仅内部消息的段仍直接 skipped。消息开头 context 同样只从过滤后的 entries 构造。
- **落库独立防守**：`#evidenceFor` 仅允许真实用户/正常 assistant；用户证据除了词覆盖，还要求 statement 中的实体标识与数字都在用户原文出现（避免“只有问句、没有值”的 user 消息确认内部 memory 值）。模型显式引用内部 source 且无真实用户支持时整条 rejected；混合 user+assistant 只有 assistant 匹配时为 candidate，不能仅因同批有 user 升级 active。
- **时间/provenance**：observedAt 只取真实用户证据 at；internal user 时间不再参与；遗忘 tombstone 仍需更新用户来源才可重新授权。
- **回归**：新增 `tests/capture-internal-evidence.test.js` 3 项：user 问句 + internal memory 引用被拒、mixed user+assistant 为 candidate、真实 user 值 + internal 注入仍 active。相关 extract/capture/segment/time 回归 **38/38**。
- **安装**：0.2.17 干净包安装并回读；未重启、未发真实模型/QA/恢复请求。真实 final-recall 会话与旧混合样例验证由 Codex 重启后完成。

## 63. 内部来源引用无条件拒绝（2026-11-05）

- `host/capture.js` 的 `citedInternal` 守卫改为**无条件拒绝**：只要模型显式引用了 memory/runtime/skill/tool/bridge 等内部 user 来源，该条结果即 rejected，不再允许用户问句的词覆盖为其授权。
- 保持其他证据选择逻辑不变；真实用户事实只要只引用真实 user id，即使同回合存在内部 memory 注入仍可正常 active。
- Codex 新增纯中文偏好回归与实坏返回回放，相关内部来源用例 **5/5**，前置相关 **30 项**未回退；按指示未重跑整套/性能。
- 本轮仅打包安装 0.2.18，未重启、未发真实模型请求、未操作真实数据/历史恢复。

## 64. Codex 最终原生复核：元信息、启动、历史恢复与遗忘（2026-11-05）

- **最终安装与元信息**：由原 DSH 开发会话打包安装 `0.2.18-native.20261105`。Codex 用 Python tarfile 回读实际包：无 AppleDouble `._*`、无 PAX 扩展属性，locale 仅 `en.json`/`zh.json`；安装时 27 个文件与共享源码及 desktop profile 逐字一致。所有会话和提炼调用空闲后正常退出/启动宿主，新进程 Typert 自检通过，`include:dsh-memory` 为 active。真实插件页显示该版本、1 个组件运行中，无包元信息错误。随后仅更新公开文档，未推送/发布。
- **启动优化的独立测量**：同一完整 50,000 条 JSONL、同一查询集，新子进程加载，未清 OS 文件缓存。分词 code-point 快路径后 store 500.83ms、index 919ms、可检索 1419.83ms（此前 1875.41ms，约下降 24%）、首查询 26.28ms、中位 7.95ms、p95 17.53ms；查询结束 heap 211.89MiB，GC 后 115.87MiB 且索引仍含 50,000 条；磁盘 30.03MiB。同作用域原子替换 702.15ms，重开正确。这是 Memory 数据加载与索引就绪时间，不是整个 DSH 的启动时间，也不是磁盘冷缓存测量。后续证据校验改动未碰此路径，未重复跑 benchmark。
- **历史任务实际处理**：原 18 个 failed 和 1 个受阻 partial 已逐项核对。15 个原失败恢复成功，3 个只含助手/内部来源的原失败本地 skipped、未新增模型调用，受阻父任务随子任务完成而 done；原 19 项最终为 16 done / 3 skipped。包含拆分/补全子任务的恢复族共 27 项，22 done / 5 skipped，无遗留 pending/running/partial/failed/unknown。已保存的截断结果先本地重放，不重新发送原付费父段；只有已知失败且经用户授权的任务创建新调用，本次恢复新增 20 次 provider 提炼尝试。
- **恢复结果与原数据**：新增 69 条 active、2 条 candidate；最初恢复中出现的 4 条重复改写已通过原生批量归档处理，保留正确原记录。恢复前 90 条来源原文长度与正文哈希保持，既有有效记录未被恢复修改，原 16 条 deleted 墓碑保持。原调用结果、usage、attempts 与来源时间保留，未改账本来伪装清零。`exportData` 不包含墓碑，因此墓碑核对使用恢复基线时刻的权威 revision，而不是把导出中缺失当作删除失效。
- **真实长消息与召回**：0.2.14 的 30,684 字符试验先发现尾段遗漏 3 项；修复明确保存意图、同消息开头语境和同源已知事实后，0.2.15 用新标记重测。完整原文 gzip 逐字读回、根范围连续覆盖全文，首/中/尾及全局偏好 10/10 项提炼为 4 条有效记忆；3 个根任务加 2 个子任务全部结算，4 次真实提炼、1 段内部内容未调用模型。另一会话实际 `source.kind=memory` 注入首中尾值，最终回答全部命中；另一项目只收到 global 偏好，项目代码未注入且答“不记得”；删除项目代码后另一会话不再收到该值。问题不含答案，均无工具调用。后续来源门控用相关分段/提炼回归复核，未在每次打包后重复相同长消息付费测试。
- **收尾发现并修好的两个问题**：重启时把手动恢复和明确保存任务误计入自动每日预算，导致 3 个 QA 后续任务滞留；0.2.16 持久化自动调用计数、保留手动重试前已用自动预算，3 项在实际 reload 后自动完成，各 1 次调用，未提高用户上限。它们又暴露了内部 memory 注入被混入用户证据、把已遗忘 global 偏好重新写回的问题。0.2.17 排除模型输入中的内部来源，Codex 额外复现纯中文偏好仍可穿过词覆盖校验；0.2.18 无条件拒绝显式引用内部来源的结果。正常用户直接给出的事实仍可保存，助手建议不能仅因同批有用户问句成为 active；来源时间不取内部注入时间。
- **最终版本的真实全局遗忘**：0.2.18 正常重启后，在未见过该偏好值的既有 QA 会话只询问名称，不提供答案。原生事件中没有注入被删值，模型回答“不记得”，工具调用 0；随后自动提炼完成，未再次创建该偏好。QA 项目及全局新增记录均已通过原生接口清理，按 QA taskId/sourceRefs 复核无剩余有效测试记忆、无既有记录被加入 QA 证据；测试会话、来源和任务审计保留。
- **必要回归**：分阶段复核完成标记/恢复 40/40、分段来源 3/3、配额及相关 capture/recovery 54/54。内部来源修改后相关 reliability/time/segment/source 30 项通过；独立真实坏返回重放最初因测试工具误用不存在的 `store.create` 未执行，改用实际 `buildRecord`/`append` 后通过。最后纯中文来源修复后，内部来源 4 项及同一真实坏返回的隔离重放合计 5/5。重放使用假 provider，不产生新的真实模型调用。旧 0.2.13 全套 239/239 是当时结果，未冒充最终版本的整套重跑。
- **最终运行与页面**：原生队列 total 87、done 61、skipped 26；pending/running/partial/failed/unknown 均 0。浏览器打开真实宿主「设置 → 记忆 → 捕获与注入」，显示待处理 0、未知 0、失败 0、完成 61，自动捕获/注入开启、预算 360；七项用户设置及宿主默认模型与本轮基线一致。仅删除本轮 QA 的有效记忆，没有清空用户数据；未动 MSE、Context、旧 TDAI 项目或默认模型。
- **仍有边界**：50k 索引就绪未达到 300ms，查询后 heap 仍高于 150MiB，GC 后保留量不能当峰值；未引入持久索引缓存。持续截断且有界补全无进展仍如实 partial，真正未知的付费调用不盲目重发。宿主 MSE 的 32,768 字符单次入口限制未修改；上述是当前宿主模型对合成 QA 内容的实测，不代表所有模型、任意措辞或无限容量的记忆质量。

私有回执、真实来源、原生事件和独立 proof 位于被忽略的 `docs/tasks/codex-startup-history-qa-20261105/`；公开文档只保留结果与测量口径。浏览器、原生模型、假 provider 故障重放与合成 50k 性能测试分别陈述。

## 65. 50k 启动与首问：派生缓存候选包（2026-11-05）

- 候选版本 `0.2.19-native.20261105-fast1`。本节是隔离目录、固定时间、全新 Node 24.22.1 进程的测试；OS 文件缓存未清空。没有修改真实 desktop profile、真实记忆或调用模型。本候选包尚未做原生安装和真实宿主验收。
- JSONL 仍是权威数据。首次启动完整读取最新 revision、建立原 BM25 索引并准备画像/图谱，然后自动写入权限为 0600 的派生缓存；正常写入后合并刷新，缓存缺失、损坏、V8 版本或权威文件状态变化时重建。跨进程文件新建、同字节数修改、替换和删除通过文件状态检测；物理 purge 同步移除旧派生文件。画像按原聚类、证据和时间衰减规则提前准备，时间跨越未来记录时更新排序。

| 完整 50,000 条测量 | 实测 |
|---|---:|
| 首次无缓存：store / 索引 / 画像与图谱准备 | 374.06 / 687.71 / 58.84 ms |
| 首次生成缓存额外耗时 / 从打开到插件 `apply` 返回 | 645.06 / 1771.64 ms |
| 缓存重开：3 个新进程到全部索引就绪 | 250.71 / 249.05 / 250.95 ms |
| 缓存重开：3 次实际 `agent/pre-step` 钩子 | 39.10 / 40.05 / 40.61 ms |
| 包含模拟 gateway 五项自检的打开到首问完成 | 373.60 / 366.98 / 374.15 ms |
| 缓存重开后 200 次搜索中位 / p95 | 5.72 / 14.14 ms |
| 同一语料旧版 0.2.18 搜索中位 / p95 | 5.78 / 12.77 ms |
| 权威 JSONL / 附加缓存 | 33,135,280 / 37,334,210 字节（31.60 / 35.60 MiB） |
| 同作用域 50k 原子替换 / 替换后新进程缓存重开 | 803.18 / 268.93 ms |

- 缓存重开达到“索引就绪 300ms”目标的三次单机测量；首次无缓存及包含 gateway 自检的首问总耗时均未达 300ms。缓存生成是同步工作，50k 数据写入后的自动缓存刷新也可能暂时占用事件循环；以上不是整个 DSH 启动或真实磁盘冷缓存指标。gateway 测试以隔离 shim 调用真实 panel backend 和 `agent/pre-step`，不是原生 Typert 宿主测试。三次重开 gateway 的 `profile` 为 1.00–1.23ms、`knowledgeGraph` 为 15.60–17.55ms，未把全量画像聚类或图谱构建推迟到第一问。
- 完整性：50,000 条原文逐条与权威 JSONL 相同，50,000 条唯一数字词均指向其记录；200 次完整查询结果及额外 3 个分页与已安装的只读 0.2.18 包在同一固定时刻逐项一致。替换后新进程仍有 50,000 条 active、50,001 条含 superseded 的索引记录，旧记录 superseded、新记录 active，历史可读。此前同一固定语料的旧版实际钩子正例用时 131,982.15ms，与当时新路径注入文本完全一致；最终迭代复用该旧版结果，未再重复旧版画像计算。另用 1,200 条混合记录、4 个时刻和 3 个画像条数与旧包逐项对照，统计和全局图谱一致。
- 增量、删除、物理 purge、导入、面板修改、项目隔离、外部同大小修改/项目增删、缓存损坏/缺失、未来时间及缓存刷新时文件系统错误均有隔离回归。相关检查此前 117/117；最终画像与缓存路径变更后针对性复核 30/30。检索 eval 的固定集 hit@5 为 1.000、必要证据覆盖 0.640、precisionAtMost5 为 0.989；hard 必要证据覆盖 0.917，1 条 hard 问题仍缺一项证据，无答案误注入 0/2，不能视为真实模型验收。
- 可复跑入口：`scripts/bench-startup.mjs 50000`（默认只读本机已装 0.2.18；`DSH_MEMORY_REFERENCE` 可指定参考包）、`scripts/compare-reference.mjs`、`tests/startup-cache.test.js` 和 `tests/profile-cache.test.js`。原始本机数值在被忽略的 `docs/tasks/codex-startup-cache-50k-delivery-20261105.json`；旧版实际钩子原始数值在 `docs/tasks/codex-startup-cache-50k-20261105.json`。干净候选包使用 `scripts/pack-plugin.py` 生成，需由主会话独立复核、安装并完成真实宿主测试。
- 候选包回读：`dsh-memory-0.2.19-native.20261105-fast1.tgz` 共 30 个成员、21 个 host JS，所有文件与当前源码逐字一致，包含 `host/startup.js` 和 `host/cache-records.js`，无 AppleDouble 或 PAX。解包到独立临时目录后，实际钩子产生记忆注入，另一个全新进程命中缓存并检索到同一记录。

## 66. 全文读回后的搜索性能修复候选包（2026-11-05）

- 候选版本 `0.2.19-native.20261105-fast2`。定位确认：fast1 缓存记录读回正文时，先删除再重建全部目标对象属性，V8 检测到该对象由 fast properties 变为 dictionary properties；搜索热路径持有同一对象，因此完整浏览/导出后变慢。fast2 为正常记录预设权威字段顺序，填充时保留快速属性；字段缺失、旧式或额外字段等非标准结构仍走通用路径以保持真实字段和序列化顺序。
- 直接修改仍立即反映在当前对象和搜索过滤中，但不是 JSONL revision：缓存刷新发现未提交的直接修改时不写入不一致的派生快照；后续重新打开以权威 JSONL 为准。如果用户通过现有 compact 等操作将修改写入 JSONL，缓存可以正常重建。初次读取的普通对象使用内存中的 SHA-256 摘要识别未提交修改，避免长期保留整个 JSONL 文本；该摘要不写入权威文件。
- 同一固定时间、原始完整 50,000 条，分别先逐条深度读回并比较 JSON 字段顺序，再执行相同 10 个查询预热及 30 个计时查询；新旧结果及额外 3 个分页完全一致。各项为全新 Node 24.22.1 进程，OS 文件缓存未清空，未操作真实 profile：

| 版本 | 全文读回后搜索中位数 | p95 | 缓存重开时间 |
|---|---:|---:|---:|
| 0.2.18 参考 | 7.75 ms | 16.08 ms | 不适用 |
| 已安装 fast1，只读参考 | 12.89 / 14.84 ms | 33.43 / 36.94 ms | 422.89 / 258.62 ms |
| fast2 候选，3 次新进程 | 5.71 / 7.93 / 5.26 ms | 12.51 / 17.81 / 13.40 ms | 259.50 / 394.42 / 277.13 ms |

- fast2 在该语料上消除了全文读回后的明显搜索回退；重开有两次低于 300ms、一次为 394.42ms，不能宣称稳定低于目标。fast2 还直接复用了 fast1 生成的缓存，完整读回后搜索中位 5.49ms、p95 12.48ms，该次打开 317.49ms。首次无缓存构建 fast2 为 2398.67ms，同轮 fast1 为 2146.22ms；负载和首次缓存生成成本均包含在内。非标准字段顺序或结构使用通用物化路径，若大量数据均为此类结构，全文读回后的性能可能不同。
- 相关测试 `83/83` 通过，涵盖普通及非标准结构的属性顺序、直接赋值/删除/定义属性、嵌套修改、未提交改动的缓存防护、正式 compact 后重开、外部变化、分页及原子替换。`scripts/compare-reference.mjs` 使用保留的只读 0.2.18 包时，1,200 条混合记录的画像、统计和全局图谱对照通过；`scripts/bench-materialized.mjs` 可复跑本次全文读回测试。原始数值保存在被忽略的 `docs/tasks/fast2-materialization-final.json`；没有为追求目标筛掉超标样本。
- 打包回读：fast2 `.tgz` 共 30 个成员、21 个 host JS，全部文件与当前源码逐字一致，无 AppleDouble 或 PAX。临时目录中先由只读 fast1 包创建缓存，解包后的 fast2 直接命中该缓存；直接修改、正式 revision、再次全新进程重开及实际召回钩子均通过。未安装候选包或改动真实 profile。
- 后续独立复核发现并修复 compact 提交直接正文修改后倒排仍是旧词的问题：实际有记录变化时同步重建索引；普通未改变记录的压缩不重新分词。隔离回归覆盖已缓存与首次构建两条路径，验证提交后立即及新进程重开后新正文/新标签可检索、旧词不再命中；相关检查 **34/34** 通过。
- 升级安全：旧 format 6 缓存本身可能已经包含上述错误倒排，因此现改为 format 7，首次启动自动从 JSONL 重建；随后新进程命中新缓存。已在临时目录用已安装的只读 fast1 包构造错误旧缓存，验证新版本首次拒绝旧缓存并正确检索、第二次命中新缓存且结果正确。上文“直接复用 fast1 缓存”的结果属于修复前版本，现已不适用；上文 50k 性能数字也来自修复前，按要求未重复整套基准。

## 67. fast2 实际安装与独立验收（2026-11-05）

- 按用户指定，在独立 GPT-6.1 Terra / max 会话完成开发，主会话独立检查并负责安装和原生验证。复核先后发现完整读回后的搜索性能回退，以及 compact 提交新正文后仍使用旧倒排的问题，两项均修复后才交付最终包。
- `0.2.19-native.20261105-fast2` 已经插件管理器安装到实际 desktop profile，并在会话和捕获调用空闲时正常重启。包内 29 个文件逐字核对源码，安装后另核对 26 个运行及 locale 文件。原生 Typert 自检通过，插件 fiber 为 active，包元信息校验正常，实际派生缓存为 format 7。
- 升级前后 8 个权威 JSONL 文件的内容摘要相同，原生导出的 566 条既有记忆逐项一致。七项现有设置及宿主默认模型也已核对。测试结束后再次逐项比较了原有记录，测试新增记忆通过原生删除接口清理完成。

使用已安装包进行独立容量测试，语料为隔离的完整 50,000 条数据。每次使用新 Node 24.22.1 进程，保留 OS 文件缓存。在测得打开耗时后，逐条比较全部正文，再预热并计时搜索。三次查询结果也逐项一致。

| 最终已安装 fast2 | 首次构建 | 缓存重开 1 | 缓存重开 2 |
|---|---:|---:|---:|
| 打开至全部索引可检索 | 2193.68 ms | 244.97 ms | 249.52 ms |
| 逐条原文比较 | 50,000 条通过 | 50,000 条通过 | 50,000 条通过 |
| 全文读回后搜索中位数 | 5.25 ms | 8.29 ms | 6.26 ms |
| 全文读回后搜索 p95 | 11.12 ms | 19.36 ms | 14.72 ms |

- 两次最终缓存重开低于 300ms。开发期间同机出现过 394.42ms 等负载样本，详见 §66。性能目标仍受机器负载和数据结构影响。首次构建含约 1025ms 缓存生成成本，自动缓存刷新仍为同步工作，数据量大时可能短暂占用事件循环。这里测量的是插件存储和索引可用时间，整个应用启动及模型回复有各自的额外耗时。
- 最终版原生测试采用宿主当前默认的 `qwen-token-plan / qwen3.7-plus`。在一个隔离 QA 会话提供两项新项目事实，完整用户消息落入来源日志，自动提炼完成并生成含两项值的 active 记录。另一个既有 QA 会话只询问事实名称，原生事件中出现实际 `source.kind=memory` 注入，最终回答准确包含两项值，工具调用为 0。两次提炼均完成，测试记录删除后原生搜索不再返回测试值。
- compact 回归由主会话先独立复现，再独立复测。修改正文并显式 compact 后，立即查询和缓存重开都命中新词，旧词查询为空。开发会话相关定向检查为 34/34，此前 materialization 相关检查为 83/83。容量数据、隔离回归与真实模型对话分别提供证据。
- 本轮另外发现另一项目在 fast2 安装前已产生 12 条 `Qwen3.8-Flash` partial 任务，包含拆分与有界补全子任务，记录原因均为输出预算耗尽且无可用文本。安装前后的这组状态一致，最终读取仍为 partial 12。此次启动优化没有完成这组提炼恢复。最终全局队列为 total 111、done 71、skipped 28、partial 12，pending/running/failed/unknown 均为 0。

安装回执、原文逐条比较、独立容量数值及真实事件证明保存在忽略目录 `docs/tasks/codex-terra-50k-fast2-20261105/`。公开记录只包含测量结果和范围。README 在验收后更新，已安装包中的运行文件核对证据仍对应本次最终包。
- 上述修复后的 fast2 已重新打包并回读：30 个成员、21 个 host JS 与源码一致，无 AppleDouble/PAX；解包到临时目录后，以只读 fast1 构造带错误倒排的旧缓存，验证新包拒绝旧缓存、重建后查询正确，再次修改正文并 compact 后立即及新进程命中新缓存时查询均正确。


## 68. 真实 Obsidian 往返与属性兼容修复（2026-11-05）

- `0.2.20-native.20261105-obsidian1` 已通过插件管理器安装到 desktop profile。实际 Obsidian 为 1.15.0，在用户已打开的 vault 中使用独立 QA 文件夹测试；没有把全部真实记忆导出到 vault。测试过程不调用模型。
- 原生导出产生 Markdown，在 Obsidian 中实际修改正文，并用属性编辑器添加标签。Obsidian 将标签改写成标准 YAML 列表后，旧解析器导回得到空标签，问题已在真实宿主复现。现在使用共享的标准 YAML 解析器（精确依赖 `yaml@2.9.1`），记忆和知识笔记均支持块式标签、引号字段；无效 YAML 笔记跳过。同步同时修复 kind 未更新、候选记录被默认提升为 active、重复导入仍增加 revision 的问题。
- 安装新版后，通过真实 Typert 接口导回同一份 Obsidian 编辑过的文件，正文新值与两个标签均正确；旧值的独有查询词不再命中。再次导入报告 updated 0 / skipped 1，记录及 revision 不变。临时导出目录中的第二次导出写入 0。
- 通过原生接口提升 QA 记忆为知识笔记，导出后在 vault 修改同名文件，导入准确报告 conflict 1，宿主原文保持不变；新增知识笔记导入成功，标签、主题和双链解析正确。项目图谱出现知识节点和对应 wiki 连线。全局图谱超过 24 个主题时会将小主题汇总到“其他”，未独立展示的主题不会生成单独的 wiki 连线；这属于现有图谱展示规则，不能据此声称所有双链都在全局图谱中可见。
- 回归检查：`tests/obsidian.test.js`、`tests/knowledge-sync.test.js`、`tests/knowledge-edit.test.js` 共 **20/20**；`tests/remote.test.js` 中 Obsidian/knowledge 定向检查 **6/6**。新增用例先复现失败再修复通过。上述为自动化检查，前述 Obsidian 编辑与真实原生接口调用另有实际记录；没有把它们混称为完整 GUI 按钮验收。
- 包含新增依赖的安装产物回读通过，无 AppleDouble/PAX。正常退出后首次由 macOS 启动返回 `-609`，随后从原生应用入口恢复启动，真实 Typert 自检通过、fiber active、元信息无错误。升级前后 8 个权威 JSONL 文件与包含 QA 的 567 条记录一致，既有设置及默认模型一致。
- 测试完成后，将已打开的 vault 配置为默认路径，正式同步文件夹为 `DSH Memory`，通过原生设置接口保存并读回持久化配置。同步仍由面板的导出/导入动作触发。只删除本轮 QA 的 1 条有效记忆、5 个 Markdown 文件及空测试文件夹，并清除本轮临时同步摘要；有效记录恢复为 566 条，其他设置未变。记忆删除保留正常 tombstone 和测试审计，不宣称擦除全部历史痕迹。
- 本版未修改存储与索引实现，也没有重跑 50k 性能基准；§67 的性能数字仍仅对应上一版。本轮未处理既有模型提炼 partial 任务，也未推送或发布。

私有回执位于忽略目录 `docs/tasks/codex-obsidian-qa-20261105/` 与 `docs/tasks/codex-obsidian-install-20261105/`，包含实际属性编辑文件、原生导入/导出结果、知识冲突结果、安装与清理验证。公开记录不包含真实记忆正文或用户 vault 路径。


## 69. Obsidian 自动同步与完整图谱安装验收（2026-11-05）

实际安装版本 `0.2.21-native.20261105-auto1`。所有会话空闲后，通过插件管理器安装到 desktop profile，并正常退出、重新启动 DSH。原生 Typert 自检通过、fiber active、元信息无错误；28 个运行、locale 和 package 文件与已验收源码逐字一致。升级前后 8 个权威文件、569 条原有记忆、七项设置和宿主默认模型一致。

- 新增可关闭的自动双向同步，宿主运行时在上一轮结束后约 5 秒检查一次；默认关闭，避免升级替用户导出数据。本用户已要求启用，现已在原生设置界面开启并保存到已配置的 vault。同步基线按记忆数据目录与目标目录独立持久化；单边修改同步，双边修改或删除冲突保持原件，并保留双方副本。界面可比较全文后选择版本，过期选择会被拒绝。被替换的文件放入 `_history`，冲突副本放入 `_conflicts`，不自动清理这些恢复内容。已遗忘的记录不会从旧笔记重新导回。
- 图谱不再把小主题合并成“其他”，全量图谱查询绕过启动预览的 1,000 条限制，搜索和分页覆盖全部当前记录。新增笔记之间、记忆正文内的双链、带路径/标题锚点/别名显示文字的链接及 Markdown 内链；显示可点击的出链、反链和未解析目标。处理范围为插件记忆和同步目录中的知识笔记，不扫描用户整个 vault 的所有私人笔记。
- 自动同步 8 个行为用例通过，涵盖更改导入/导出、记忆笔记重命名、重复同步无额外 revision、重启保留冲突、过期冲突选择、错误 YAML 保留、遗忘防复活、知识笔记冲突/删除以及无 RPC 触发的定时同步。配置/设置、激活、客户端方法契约和定向 RPC 检查通过。图谱 8 个用例通过，包含 1,250 条全量分页/尾部搜索、超过 24 个小主题、双链/反链与页码失效恢复。知识同步/编辑 14 个用例沿用本轮通过结果，未重复整套测试。
- ego-browser 使用实际 `client.js`、隔离 MemoryStore/同步控制器与真实面板后端检查界面，数据为 125 条合成记忆和测试笔记：开关保存、展开双方全文并选择 Obsidian 版本、第二页 101–128 项、跨页搜索、小主题、链接跳到另一页并显示反链通过。520px 图谱页面 document scrollWidth 与 viewport 相等。该环境使用 HTTP 测试传输，不属于原生宿主 GUI 验收。
- 真实自动往返：独立 QA 记忆由后台定时器导出；在 Obsidian 1.15.0 实际编辑 Markdown 正文后，不点同步按钮，原生 Memory 查询自动读到新值（revision 2）。再从原生 Memory 修改正文，Obsidian 已打开页面自动刷新为新值。知识笔记从 vault 自动导入、原生编辑后自动导出也通过；含锚点和显示别名的原有双链未被文件替换改写，Obsidian 实际点击能打开更新后的目标正文。
- 真实冲突：暂停同步后分别修改同一 QA 记忆的两侧，恢复自动同步后出现一项冲突，两份原件未被覆盖，双方副本均存在。在原生设置展开全文并选择 Obsidian 版本后，Memory 正确更新、冲突归零，双方恢复副本仍保留。该操作只处理 QA 冲突。
- 真实图谱：两个独立 QA 知识笔记被后台自动导入后，原生接口与原生页面均显示单独小主题、A→B 出链、B→A 反链与未解析目标。点击出链正确切换到 B，并显示返回 A 的正反链接。1,250 条分页覆盖和跨页跳转仍分别依据前述自动化与隔离浏览器结果，不宣称做了相同规模的真实 GUI 数据写入。
- 清理与终态：经原生删除接口遗忘 QA 记忆，后台自动将其 vault 文件移入历史，未重新导回；仅删除本轮两份 QA 知识笔记及自有恢复副本。最终原有 569 条记录逐项比较一致，正式 vault 中对应 569 个文件的正文、范围、类型、主题、标签、状态、置信度和重要度均逐项匹配。原生设置显示自动同步开启、冲突 0；实际同步 errors 0，插件继续 active。
- 仍有原先的提炼任务：total 149、pending 3、running 0、done 74、partial 39、failed 0、unknown 0、skipped 33。三个 pending 均为 `not-sent`、每日提取预算已用尽，升级前后逐项保留；本轮没有调高预算、重发或处理这些既有任务。
- 范围限制：自动同步需要 DSH 运行；首次 50k 完整同步耗时、长期运行及极端并发编辑未实测。本版未改变存储与召回实现、未重跑 50k 性能基准，没有调用额外模型、修改 MSE/Context、推送或发布。

私有脚本、实际自动往返/冲突/图谱/清理回执和浏览器图像在 `docs/tasks/obsidian-auto-20261105/`。插件管理器安装回执、重启自检和升级前后对照在 `docs/tasks/codex-obsidian-auto-install-20261105/`。这些目录由 Git 忽略，公开文档不含用户记忆正文。README 在验收后更新，运行文件核验对应实际安装包。

## 70. 排队与空输出 partial 恢复及原生验收（2026-11-05–06）

- 起始原生快照为 167 个任务：pending 21、partial 39、done 74、skipped 33、running/failed/unknown 均为 0。用户此前看到的 3 个 pending 仍在其中，后来又增加 18 个；39 个 partial 包含父任务和子任务，实际为 8 个未完成末级分段，另有一棵树依赖原排队子任务。
- 根因由代码和真实回执交叉确认：旧版把 max-tokens/length 且无正文的结果继续拆分并补全，消耗自动配额；自动补全字段缺失使额度翻倍未生效。宿主自定义 Qwen 路由的 off 映射为不发送推理参数，实际仍生成 reasoning-delta。首个恢复请求在 4096 上限下产出完整 JSON，使用 outputTokens 3534；旧 800 上限不能容纳这次真实推理与正文。旧空输出路径没有保存 usage，无法补算旧请求费用，不声称旧调用免费。
- 修改：默认输出上限 4096，补全额外余量实际传给宿主；无正文终止记录 finish/usage/推理字符数并暂停同路由相同额度的连续调用。显式恢复创建确定 ID 的缺失段子任务，保留旧付费回执，已完成分支和 unknown 不自动重发。恢复再次无正文则停止。旧版空输出祖先消耗的补全轮次只纠正一次，有效结果仍受有界补全与无进展保护。
- 明确不保存记忆，以及没有要求记住的虚构验收材料，在请求模型前跳过；长消息后段和旧付费结果本地重放同样遵守。来源保留，跳过不写成成功提炼；任务实际状态和次数保留。原生面板显示 partial，提供末级任务恢复入口，未知结果要求显式确认。
- 定向检查：最后一轮恢复/完整标记/内部证据 22/22 通过。此前相关检查 140 项中的两个失败分别为旧的空输出拆分预期、UPDATE 测试原文缺失其模型声称的事实；按新行为及实际用户证据修正后复测通过。未重复 50k 性能基准、Obsidian 全套或无关模块检查。
- 最终 `0.2.22-native.20261105-recovery2` 已在其他会话与捕获调用空闲后通过插件管理器安装，并正常退出、重启。28 个运行/locale/package 文件与源码匹配，fiber active、元信息无错误、Typert 自检通过。两次安装各自核对了当时的 569 / 631 条既有记录、权威文件、用户设置及宿主默认模型均未因升级改变。最终包 SHA-256 为 `92492b445956e49cd742b742ee5409e39567588ce4315a67169eeddfcb621248`；验收后的 README 更新不改变该已安装包。
- 逐项核对：原 3 个 pending 均 done，39 个 partial 及其缺失分支均已完成。起始 21 个 pending 中，6 个完成，15 个明确禁止保存或仅为虚构验收的任务在本地 skipped、模型调用为 0；期间新增的 6 个真实排队任务也已完成。没有删除任务或强改状态清零。最终原生账本为 **188 个任务：done 138、skipped 50，pending/running/partial/failed/unknown 全部为 0**；原生「设置 → 记忆 → 捕获与注入」刷新后显示相同的完成数和四项零计数。
- 调用审计：起始所有已发送任务的 attempts、原结果文本和原 usage 逐项保持。恢复过程新增 23 次实际提取调用，分别为未发送的排队任务及必要的缺失段/补全子任务；没有重发已成功分支或结果未知的请求。它们不是免费恢复，仍按 provider 的真实用量计费。另有 3 次 QA 对话及其 2 次分段提取；QA 召回/遗忘轮明确禁止保存，均为零次提取的 skipped。每日自动预算未提高，未来达到预算的新任务仍会等待下一周期或显式恢复。
- 最终版真实模型验收使用当时的宿主默认模型，仅设置隔离 QA 会话，不改变全局默认：17,407 字符用户消息逐字保存，两个连续分段完整覆盖原文，两次自动提取均 done；位于首、中、尾的 3 项事实全部成为 active 记忆。输入明确要求记住，验证的是显式记忆的自动分段路径，没有把它描述为耗尽日预算后的普通对话自动提取。
- 另一 QA 会话只询问事实名称，没有给出答案；原生事件出现实际 `source.kind=memory` 注入，三项值均在注入和模型回答中。通过原生删除接口清理这三条测试记录后，第三个会话无这三项注入，回答“不记得”。三次对话均无工具调用。自动 Obsidian 同步后对应的三个正式 Markdown 文件已移出同步目录，原生查询未重新出现测试记忆；同步保持开启，errors/conflicts 均为 0。这是实际宿主和模型结果，与前述自动化测试分开记录。

私有逐项 intent、receipt、模型终止回执、安装核验和最终 `final-proof.json` 位于 Git 忽略目录 `docs/tasks/capture-resolution-20261105/`。原始来源与恢复历史保留，只有本轮三条 QA 记忆经原生接口删除；未推送或发布。本轮没有重复容量、长期运行或全部 provider 的测试，不能据此保证任意模型、任意长度或所有查询都能完美提炼召回。

## 71. P0/P1：pnpm 与 Node 组合召回的原生验收（2026-11-06–07）

- **先复现，再修复。** 两个隔离的 DSH 会话分别写入项目的 pnpm 和 Node 版本，各自提炼成功。第一版装到真实宿主后，新的读会话同时询问两项，模型答出 pnpm，却回答“Node：不记得”。两条事实都在库里；漏项发生在构造回答前的记忆文本时。问句附带的答题格式、禁用工具和不保存指令干扰了事实匹配。
- **P0 和 P1 的变化。** P0 直接评估交给模型的文本，区分必需、可替代、仅相关和禁止出现的证据；保留旧的记录 ID 指标。P1 将问题中的事实与答题指令分开，识别共用属性和版本号。问题含多个对象时，先为每个对象选一条有依据的事实，再用剩余额度补充；召回本身不新增模型调用。
- **离线结果。** 捕获、激活、召回相关检查 51/51 通过。[独立 40 题评测](../scripts/eval-recall-heldout.mjs)中，必需事实找回 47/48；复合题答全 15/16，单项题 16/16，8 道无依据、遗忘或隔离题均未注入。旧版在这 40 题的总分相同。仍有一个具体漏项：“每日快照时间、保留期限分别是什么？”能找回保留期限，但漏掉时间 03:17。这些数字衡量注入文本，不代表 40 次真实模型回答。
- **安装与盲测。** 通过 DSH 插件管理器安装 `0.2.23-native.20261107-recall2`（包 SHA-256：`64e9c6795cb73e49f01c86f9f1d6dffc223b07c25e8f31c7b2996db8e206a286`）。宿主重启后插件 active，自检通过，32 个安装文件与验收包一致。保留之前写入的两条记忆，另开一个全新 DSH 会话，用第一次失败的原句提问，没有带版本号。模型回答 **pnpm：9.12.3；Node：22.13.1**。宿主实际只注入了这两项记忆；工具调用 0，“不要保存这次问答”产生的新提炼任务 0。
- **清理边界。** 用插件原生接口移除两条 QA 记忆。清理后原有 649 条记录逐条一致，原有 11 个范围的数据文件内容和宿主默认设置均未变。未推送或发布。

## 72. 快照多项召回与 P2 原句证据（2026-11-07）

两个隔离的真实 DSH 会话验证了普通聊天写入和跨会话问答。第一个会话说“我们决定把星湾快照改到每天 04:26 执行，快照保留 23 天，因为原时段会撞上票据归档写入。”没有要求记住。宿主默认的 DeepSeek Flash 完成了一次普通自动提炼。活动决策的来源是用户消息，原文按 UTF-16 区间 `[11, 59)` 切出，与保存的引文逐字一致。

第二个全新会话只问“星湾快照每天几点执行、保留多久、为什么改？”，并要求不用工具、不保存问答。原生事件显示插件注入了一条决策原文。回答同时给出了 **每天 04:26、保留 23 天、原时段与票据归档写入冲突**。工具调用和本轮新增提炼任务均为零。随后经插件接口移除唯一一条测试记忆，该隔离项目的活动记录回到零。

- 召回先确定问题中的对象，再用它查执行时刻、保留时长和原因。原 40 题的必需事实从 47/48 提高至 48/48，复合题完整 16/16，8 道负例均无注入。另用其他任务的时间和保留期限作干扰，实际 pre-step 只带回指定对象的三项。这里的离线数字衡量交给模型的文本。
- 普通短决定可以进入原有自动提炼额度。提炼器返回来源和原话，插件核对原文后保存位置。决策保留整句的原因、否定和条件。找不到可靠定位的决策留作候选。兼容旧来源及已保存的提炼结果。相关测试 151 项通过，另有一项专门验证短决定、疑问、假设和禁止保存的差别，通过。
- `0.2.24-native.20261107-evidence1` 通过插件管理器安装。正常重启后插件 active、Typert 自检通过，32 个文件与验收包一致。升级前后原有 658 条记录和 12 个范围的数据文件一致。
- 补测使用隔离的 50,000 条记录和新 Node 进程。候选版两次命中缓存，打开到索引可用约 705 / 991 ms，普通查询的 pre-step p95 约 52 / 45 ms。两个样本均超过 300 ms 打开目标。同次旧版缓存打开约 802 ms。数据来自工作中的同一台机器，样本量不足以判定两版的速度差。

## 73. 大库启动、原句补查与真实宿主验收（2026-11-07）

`0.2.25-native.20261107-local.2` 已通过 DSH 插件管理器安装到 desktop profile。正式包 SHA-256 为 `cb538d3244c4b9e3b4fe831d11517d368de94a0902d934cb8851eb295f0aecca`。重启后 34 个文件与包一致，插件 active，Typert 自检通过。第一步升级前后原有 662 条记录一致。第二步升级时逐项保留了这 662 条及一条新建的 QA 记录。

- **5 万条记忆。** 相同语料、独立 Node 进程和同机交替测量。旧版缓存重开至索引可检索分别为 1341、482、486 ms，新实现为 244、213、199 ms。对应新版本的第一条查询为 45、45、39 ms。改动仅涉及答题提示的最终包独立测得打开 190 ms、第一问 47 ms、30 次索引查询的 p95 为 19 ms。按 ID 和记录顺序回读 50,000 条，序列化后的每一行与权威 JSONL 一致。首次生成新格式缓存还需约 4.6 秒。这些测量使用已有 OS 文件缓存，计时从插件打开数据到索引就绪，宿主启动耗时另算。
- **本地补查。** 时间、保留期限或原因缺失时，最多读取四份当前项目的来源。只有当前有效记录、提炼任务实际授权的记录版本和原文区间均匹配时，才把原句带入本轮回答。权限或归属不明的旧来源只沿用原有摘要。同源记录被遗忘、清理或改写后，补查受到持久标记约束。多个引文含义可能不同时停止补查。这个步骤使用本地索引和原文，不额外请求模型。
- **隔离评测。** 在生产 pre-step 测试中，索引摘要没有“琥珀巡检”，通过核对来源找回了这个原因。另一项目无法取得，删除并清理同源的另一条记录后也无法取得。321 项测试全部通过。最终回答约束改动后，定向 33 项通过，离线 40 题找到 48/48 项必需事实，16/16 道复合题完整，8 道负例均无注入。
- **真实 DSH。** 第一个会话用普通聊天说出栖竹快照的调整，宿主 DeepSeek Flash 自动提炼一次，保存时核对用户原句的位置。第一次盲测的三项值正确，但模型还补出了时区、清理机制和锁竞争。修正版明确了回答范围和本轮禁止提炼状态。保留原测试记忆，另开会话重问同一句，实际回答为每天 **03:52**、保留 **26 天**、原时段会撞上**冷库对账写入**。该轮已有记忆保存着完整决定，宿主直接注入了这一条。
- **隔离与遗忘。** 记忆仍有效时，另一项目的新会话对三项都答不知道。经原生接口只删除一条 QA 记录后，原项目的新会话也对三项都答不知道。三次读取均未调用工具或触发新提炼。真实对话与上述“摘要缺原因”的隔离测试分别核验。


## 74. 证据召回与五入口原生安装验收（2026-11-07）

当前已安装并启用 `1.1.0-native.20261107.3`，工作基线为正式版 1.0.0。本轮沿用既有 GPT-6-Luna MAX 开发会话，协调会话独立审查、补修、安装和验收；未推送或发布。通过当前插件管理器更新同一实例，最终 39 个运行、locale、README 和包元信息文件与验收包一致，fiber active、原生 Typert 自检通过、无元信息错误。最后一次升级前后的 728 条导出记录、16 个权威文件、设置和默认模型一致。期间其他会话正常新增的记录保留，没有用旧数据覆盖。

- 导航整理为 **记忆 / 项目档案 / 知识 / 活动 / 设置**。用户偏好归入记忆，笔记与关系图归入知识，提炼与召回状态归入活动，捕获、注入、保留、备份和 Obsidian 同步归入设置。保留原有操作和删除确认。实际原生设置入口、五个导航、项目档案及展开用户原句已检查；隔离的真实组件预览另查了浅色、深色和 360px 窄容器，没有横向溢出。窄容器结果不冒充原生小窗验收。
- 召回按问题的对象、属性和有效时间分项查证。当前值、旧值和变更原因分别处理；完整原文、明确限定作用域的知识笔记与现有记忆参与检索。原文须有来源授权，笔记须明确选择全局或项目，关联笔记不能扩大父记录范围；删除、失效、越权或变更的证据在注入前重查。项目档案直接分页读取权威记录，可展开来源，不另造模型总结。
- 本地证据不足时，最多追加一次当前宿主路线的有界证据选择，共用每日调用额度。保存请求身份、结果及实际用量，同一回合复用回执，未知付费结果不重发。模型只能选择已有记录和逐字引文，不能把生成的事实写成证据。候选池上限 24 条，不代表全库语义穷举，也不保证任意改写都能找全。
- 实测暴露并修复了三个连接问题：笔记导入后的索引刷新回调名称不一致；一个产品版本错误地覆盖另一个产品的待答项、独立数值引文丢失产品上下文；“项目名……：快照”和“项目名快照”被误判成不同对象。后者只在同一分句内识别明确的项目限定，保留其他项目和竞争对象的拒绝检查；原始引文不改写。知识索引独立按自身语料评估命中，并在发送候选和最终注入前验证文件仍有效。
- 相关检查按修改范围运行：前期修复相关 107/107，后续引文/索引 30/30、最终候选新鲜度 5/5。最终对象关联修复 42/42；修改前两个回归确实失败，修复后通过。最终生产 pre-step 的 40 题找到 **48/48 必需事实，16/16 复合题、16/16 单项题完整，8/8 负例无注入**，无禁止或无关值。另一生产路径评测为 12/12 必需事实、10/10 可答题、限定词保留 1/1。它们衡量注入文本，不是相同数量的真实模型回答；脚本保留的旧原始索引指标仍有漏项，没有冒充生产路径结果。
- 真实 DSH 使用当时默认的 DeepSeek Flash、max 思考配置，仅在隔离 QA 会话选择该路线，未改全局模型。普通对话自动提炼一次后，另一会话同时答对每天 **05:43**、**23 天**及避开夜间账单汇总的原因。通过原生知识导入并编辑的构建笔记由 Vite 8.4.2 改为 **8.5.1**；新的改写问题同时答对 **MariaDB 11.4.7** 与 **Vite 8.5.1**，注入保留产品和版本完整原句。另一项目查询没有获得这些项目私有数据。
- 第二次普通对话把保留期限从 23 天改为 31 天，自动提炼一次，旧决策变为 superseded，新决策保留用户原话和替代关系。最终修复后的全新会话同时答对 **现在 31 天、原来 23 天、月度追溯需要覆盖完整账期**；05:43 的安排仍在原句内。所有读取轮均无工具调用、不产生新提炼。中途失败问答及付费选择回执保留，未把失败覆盖成成功。
- 经插件删除接口仅移除本轮 3 条 QA 记录，清理独立 QA 知识笔记；保留关联旧笔记进行遗忘测试时，新会话无记忆注入，时间、期限、原因和版本均答不知道，关联笔记未使被遗忘的内容复活。随后删除该 QA 关联笔记，恢复先前的 Obsidian 自动同步。最终 QA 项目记录/档案均为 0，自动同步开启且最近一轮无冲突、无错误；捕获账本为 total 280、done 209、skipped 71，pending/running/partial/failed/unknown 全部为 0。
- 容量检查使用隔离 50,000 条记录：新增有效时间字段使旧派生缓存失效，完整重建约 3429 ms；后续独立进程命中缓存，打开约 122 ms、首查约 25 ms、查询 p95 约 15 ms，50,000 条权威记录逐项一致。这是本轮早先索引实现的已有 OS 缓存测量；随后仅针对召回关联与引文作修复，未重复容量基准。不是全 DSH 冷启动 300 ms，也不是 50,000 篇知识笔记或长期压力测试。

私有原生 intent/receipt、失败和修复后问答、安装对照、测试日志、界面图及 `final-proof.json` 保存在 Git 忽略的 `docs/tasks/evidence-navigation-20261107/`。公开记录只包含隔离测试事实和汇总，不含真实记忆正文或 vault 路径。

## 75. 本地可靠性、恢复与隔离验收（2026-11-07）

`1.2.0-native.20261107.0` 已通过原生插件管理器更新同一实例，应用结果为 applied，fiber active、原生 Typert 自检通过。45 个运行、locale、README 和包文件与验收包一致，无需重启。升级前后 16 个权威文件、725 条现存记录、设置及宿主默认模型一致；未推送或发布。本轮按用户选择完善本地插件，不引入团队账号、服务器或外部服务。

- **保存与故障处理。** 设置使用私有临时文件、完整写入、同步和原子替换；损坏或不可读时暂停自动捕获、注入、维护及同步，保留可操作的恢复页面。明确保存完整策略后保留损坏文件并修复。活进程锁不因时间过长被夺走，死亡进程锁可恢复；等待期限使用单调时钟。短写继续补全，追加失败回退到原长度，中断尾行与下一条记录分开。发现大范围文件达到尺寸阈值后每次追加都重写全库，现改为积累足够旧修订才自动压缩；不以丢失现存记忆换速度。
- **完整备份。** 原生“完整备份”保存权威记录及仍保留的修订、删除标记、原文与证据授权、捕获和调用账本、知识、配置及同步状态。缓存、运行令牌、锁、既有备份和外部 Obsidian vault 不在其中；普通 JSON 导出仍用于迁移当前记录。分块复制和校验让出事件循环，来源变化或备份失败不发布不完整结果，也不据此删除旧备份。恢复 CLI 只接受尚不存在的新目标目录，拒绝损坏清单、路径穿越和符号链接；不能找回备份前已被物理清理的历史。
- **导入与边界。** 写入前验证完整输入、schema、记录及范围；无效输入整体拒绝，未来 schema 拒绝，旧合法导出仍可迁移。普通导入不能通过更高 revision 复活本地删除。使用实际宿主提供的 profileContext：desktop 保留原目录，其他 profile 默认独立目录，归属冲突拒绝访问并显示诊断页。诊断仅包含允许的版本、状态码和数量，不含正文、路径或会话标识。这是本机用户与 profile 边界，不是防御同一 OS 用户下恶意程序的强租户隔离。
- **相关检查。** 设置与持久化 25/25、追加与原子替换 19/19、设置恢复 21/21；备份集成 61/61、导入与缓存 27/27、边界与激活 16/16、健康/备份/远程接口 58/58；捕获、Obsidian 和生产召回回归 54/54；维护时钟、边界及原子替换 9/9，冻结墙上时钟下的锁超时 1/1。各组有重叠，不合计为独立测试数。恢复后的未知付费任务保持未知，自动重发次数为 0。已通过且未变的真实模型问答沿用 §74，未为本轮重复计费。
- **实际宿主与恢复。** 原生活动页显示可用及按宿主配置隔离；实际导出脱敏诊断，并在原生设置页点击完整备份。用已安装包的 CLI 校验并恢复到临时新目录，2,749 个文件、3,414,192 字节逐一一致，包含 725 条现存记忆、40 个删除标记和 295 个捕获任务。恢复副本加载后，用已安装的生产 pre-step 处理新会话身份，时间、期限和原因都进入注入文本；另一项目无注入，删除测试记忆后不再召回。这里使用隔离恢复数据和合成 QA 事实，模型调用为 0，不是新的真实模型回答验收。恢复副本与本轮测试数据已清理，真实库未被测试内容改写。
- **页面异常路径。** 临时真实后端配合 HTTP 测试传输验证设置损坏提示、明确保存恢复、目录冲突只显示诊断。浏览器检查无控制台错误或横向溢出；不是官方宿主传输验收。截图文件名虽含 360，实际截图为宽窗，本轮不把它计作 360px 窄窗通过；原生活动、诊断导出和备份操作另有上述实际检查。

隔离的完整 50,000 条语料在独立进程中复核所有正文和序列化字段顺序。首次生成缓存至可用为 **3735.26 ms**；随后命中缓存重开 **195.27 ms**，查询中位 **9.44 ms**、p95 **20.30 ms**。另一次直接存储/索引构建为 2015.39 ms，原子替换后重开仍完整保留 50,000 条。OS 文件缓存未清空，这不是整个 DSH 冷启动，也没有证明所有负载下稳定低于 300 ms；未做百万笔记或长期持续负载验收。

备份时有 15 个待处理任务，仍保留原账本和每日预算约束；已检查的等待项尚未发出付费调用，没有提高预算或以清零伪装完成。其他会话继续产生任务，数量只代表该次快照。公开结果不宣称无限召回、企业认证或等同完整 OpenAI/Claude 平台。私有回执、诊断、恢复逐项对照及本机测量保存在忽略目录 `docs/tasks/local-enterprise-20261107/`。

## 76. P0/P1 完整覆盖、本地语义与原文分段（2026-11-07）

本轮针对当前 `@missher/dsh-memory`，保留原有工作与用户数据，由 Codex 执行；不改旧 TDAI、MSE 或 Context，不推送或发布。

- **多问与统计。** 保留每个显式对象和属性，不再把第五项以后合并、只检索四项或在预算裁剪前统计已覆盖。最多执行 16 个子问题检索，超出范围仍在报告中列出；区分已找到、实际送入、预算省略、仍缺证据及未确认候选。默认条数上限 12，已有显式设置保持。原生测试追加修复了“请逐项简短回答”被算作额外问题、以及“哪一层”丢失前文对象的问题。
- **本地语义。** BM25 与固定版本的 multilingual-e5-small 向量融合，384 维、独立 worker、纯 ONNX WASM。公开模型约 135 MB，首次下载后缓存；原文和问题不发给嵌入服务，不新增付费嵌入 API。向量按项目、模型、内容和修订增量重建，页面显示状态与进度；不可用时保留词法检索。首次初始化和全量向量建库不包含在旧 50k 词法缓存的速度成绩中。
- **完整原文。** 完成回合中允许采集的直接用户来源可授予项目私有分段检索权限；每段最多 420 个 UTF-16 字符并重叠 64，保留原文、范围、哈希和角色。旧文件不会因存在而自动获得新授权，不保存指令、引用开头、敏感内容及非用户来源不获得该权限。注入前重查权限、原文与范围；未提炼原文可注明“用户所述”后引用，不被自动改为已确认事实。
- **成本与遗忘。** 保留当前模型路线、360 token 注入限制及每日调用预算。预算不足时，直接原文和范围内的语义候选明确标注后供回答核对，不虚增覆盖；全局记录仅靠向量分数不能自动进入另一项目的问题，普通事实问题不自动带入沟通偏好。原始消息遗忘阻止全部片段及衍生记忆召回、撤销未发送任务，并拦住在途或已保存结果回写；历史原文与调用凭据按现有审计策略保留。
- **相关检查。** 实现阶段 229/229；追加遗忘队列防复活后 108/108。原生问题先以失败回归定位，修复后的定向组为 39/39、54/54、42/42、26/26；各组有重叠，不相加。最终查询关联的 40 题离线回归为 48/48 必需事实、16/16 多问、16/16 单问完整，8/8 负例无注入。这些衡量生产 pre-step 文本，不是 40 次真实模型回答。
- **真实嵌入与隔离执行。** DSH 自带 Node/worker 加载真实 E5；三个中文改写/中英问题在 120 条干扰记录中均命中预期首位。隔离生产 pre-step 验证 9,480 字原文末尾、多问、项目隔离、来源和向量遗忘；无回答模型调用，不冒充原生聊天验收。

- **安装。** 最终 `1.3.4-native.20261107.0` 通过当前桌面 profile 的原生管理器安装为 applied，fiber active、Typert 自检成功，56 个运行文件与实际验收包一致，无需重启。安装包 SHA-256 为 `0be584afeb9fb3f712f7910ab37725f19d3bd479886494544ae59d2f0e96200c`。同时存在的另一测试 profile 未修改。
- **新会话实测。** 使用原有 DeepSeek Flash / max 路线，不改默认模型。隔离项目明确要求记住八个版本，提炼任务一次完成；另一会话发送的 **9,932 字**消息逐字读回一致，31 个分段覆盖全部范围及最后一句。该长消息因原有每日预算耗尽未发起付费提炼，验证的是尚未提炼的原文路径。中文改写和中英混问实际答对 Node 与 PostgreSQL；最终版的新会话同时答对 **8 个版本、东侧三楼、青瓷柜第三层**，依据来自实际 pre-step 注入，未调用工具。统计为 8 项已确认、2 项原文候选，未把候选冒充已确认覆盖，也未把模型回答结果反填成证据。
- **原生遗忘与隔离。** 最终版另一个项目的新会话没有任何记忆注入，三项均答无依据。原生设置页展开原文、确认“忘记整条原始消息”后，所有片段撤回、未发送的提炼任务变为 skipped，callState 仍为 not-sent；未产生恢复或重复计费。其余唯一一条测试记忆也经插件接口移除。再开一个同项目新会话，两个版本及位置均答不知道，实际注入为空。原生报告与语义状态已查看，554px 报告容器无横向溢出，遗忘后原文从页面消失；不是 mock 页面验收。
- **收尾。** 测试项目现存记录与可召回来源均为 0；原有 **725 条记录逐条一致**，Obsidian 自动同步与其他设置恢复。原 298 个任务的来源、状态、尝试次数和调用结果保持；预算调度刷新了 16 个待处理任务的 revision/updatedAt，不将这些元数据变化说成完全逐字一致。最终账本为 total 300、done 210、skipped 74、pending 16，running/partial/failed/unknown 均为 0。原有 16 项仍因每日预算耗尽而等待，未提高额度、重发历史请求或清零掩盖等待。审计原文和 QA 会话记录保留，测试内容退出召回。

私有日志、失败与修复后的回执、安装比对、原生截图及 `final-proof.json` 位于 Git 忽略的 `docs/tasks/recall-p0-p1-20261107/`，不上传真实记忆正文。本轮不包含关系图多跳、全量语义检索 300ms 或跨所有模型的质量承诺；首次模型加载和全量向量建库仍需时间，不能据少量实测声称无限召回或任何问法都正确。

## 77. 预算续跑、历史等待任务恢复与活动首页（2026-11-07）

- **原因与修复。** 原队列按 UTC 日期计数、依赖五分钟轮询，等待检查反复追加同样的账本修订。现在按本地自然日恢复额度，持久化等待原因与下次时间，并设置零点唤醒；设置变化、宿主重启和睡眠恢复后的轮询仍可接续。零额度或关闭捕获不会假称即将自动继续；结果未知的已发送请求不自动重发。旧调用回执仍计入额度，显式恢复不会抹掉既有消费。
- **真实恢复。** 原 16 项及随后新增 1 项均为 `not-sent`、attempts 0，来源完整且未被遗忘。经原生接口逐项恢复，17 个原任务全部 done、各请求一次。另有 1 次未完成范围的补全和 1 个纯内部上下文片段零调用跳过，共 18 次真实提炼，无原任务重复重发。产生 28 条记录（8 生效、20 待审）；原有 725 条记忆与其余 284 个任务逐条一致。
- **检查。** 首轮相关 113 项中 111 通过；旧自动调用账本兼容和等待文案两处问题修正后，相关 52 项复测全部通过。最终 6 项预算专项再次通过，覆盖本地跨日自动唤醒、重启恢复、零额度、等待记录不重复写、未知请求不重发、UTC 旧回执迁移；各组有重叠，不叠加计数。跨日使用受控时钟测试，没有将其称为真实宿主跨零点观察。
- **安装与界面。** 最终安装 `1.3.6-native.20261107.0`，56 个运行文件与包一致，Typert 自检成功、fiber active，无宿主重启。原生页面检查发现并修正等待时间缺少 locale 参数导致的空白。活动页现在位于首位且默认打开。新的真实 QA 对话进入预算等待后，页面显示本地 11 月 8 日 00:00 自动继续；点击“恢复下一项”后一次提炼完成，页面自行更新待处理为 0。此手动恢复测试与受控跨日测试分开记录。
- **收尾。** QA 原文通过原生遗忘接口退出召回，QA 记录清理；恢复后的 753 条真实记录保持，Obsidian 自动同步、其他设置与默认模型恢复/保持。最终 total 304、done 229、skipped 75，pending/running/partial/failed/unknown 均为 0。没有提高日常自动额度，没有推送或发布。

原始回执、逐项恢复意图、失败/修复日志、安装核验与真实页面证据保存在 Git 忽略的 `docs/tasks/capture-budget-20261107/`。

## 78. 移除关系图界面（2026-11-07）

按用户要求删除关系图入口、绘图组件、页面加载请求、专用状态/样式及相关多语言文案；知识页直接打开笔记，空状态引导至 Obsidian 同步。知识笔记、双链正文和同步保留，后端与 vendor 文件逐一确认沿用已安装版本。

最终安装 `1.3.8-native.20261107.0`，56 个运行文件匹配，Typert 自检和插件 active 通过；753 条记忆、调用队列、配置及默认模型保持。18 项笔记编辑、同步与面板契约检查通过。原生页面确认活动仍为首位及默认页，知识页无关系图入口、二级切换或图谱请求，空状态文案正确。没有新增真实模型调用、推送或发布；原始回执与界面证据在 Git 忽略的 `docs/tasks/remove-graph-20261107/`。

## 79. 记忆入口合并、下拉定位与 Obsidian 阅读层（2026-11-10）

版本：`1.4.0-native.20261110.1`。

- 原生导航为活动 / 记忆 / 项目档案 / 设置，默认活动；笔记并入记忆，与记忆记录和用户偏好并列。存储、召回权限与同步身份未合并。
- 8 处选择器改用锚定控件：菜单限高、滚动、长选项换行、边界内翻转，保留鼠标、方向键、Home/End、Enter、Escape、Tab 与前缀定位。隔离真实 Runtime 页面验证 40 个长项目名、430px 宽度、嵌套编辑弹窗和深色菜单；真实 DSH 设置页验证项目菜单在对话框内、Escape 只关闭菜单、笔记入口正常。
- 37 项相关检查通过（按最后相关源码复测并复用未变检查）：笔记编辑 10、笔记召回边界 2、知识同步 6、面板契约 2、自动同步 8、阅读层 9。阅读层覆盖项目隔离、原文和原因保留、双链目标、改名、无变化不重写、手写补充与修改副本、遗忘传播、目标切换、时效与引用区分、写入中断恢复、符号链接拒绝。`node --check` 与 `git diff --check` 通过。
- 插件管理器原位更新返回 applied；57 个运行文件与安装包一致，版本、enabled、fiber active 与 Typert 自检正常。更新前后核对 763 条记忆、19 个作用域权威文件、现有笔记、用户设置及默认模型一致。随后宿主端点发生变化，重新发现实际 desktop 进程并核验同版仍正常启用；没有强退宿主。
- 真实 Obsidian 1.15.0 自动生成阅读首页、项目/细主题索引，以及决策、知识库、偏好、经历汇集页。实际打开首页 → DSH-Memory 决策汇集 → 原记录，再返回首页，双链解析正常。同步状态无冲突、无错误；此次没有为测试删除真实记忆或发送额外模型请求。
- Demo 含 10 篇虚构 Markdown 笔记，所有双链目标存在，不携带真实数据和可导入记忆标记。目录参考按用途组织的笔记习惯；Demo 的连贯场景、工作流和日记是编辑示例，不宣称当前插件能自动生成同等质量的文章。
- 当前限制：阅读层汇集已有原话，不补写缺失的原因；细碎或过时的主题仍需要治理。真实模型回答质量、全宿主冷启动速度和大容量混合数据性能未在本轮重测。

## 80. 关联召回、主题归并与混合容量（2026-11-10）

版本：`1.5.0-native.20261110.0`。以下分别记录隔离数据、真实宿主与模型回答。

- 有限关系追查连接负责人→请假代班、确定方案→明确原因，保留原句、条件、有效时间和来源依赖。否定、未定方案、同句共现不能建立关系；桥接证据被忘记或未送入上下文时，不把后续关系计入覆盖。
- 修复同一对象“方案快照/方案的快照”的时间与期限漏项，拒绝较长同尾对象。纯回答要求和不保存控制不再混入问项。日常 360 token 预算的隔离 production pre-step 六问，覆盖 6/6；这是注入测试，尚不等于真实模型答对。
- Obsidian 主题只用同范围的名称规范化或当前有效原句中的明确别名归并；候选、引用、未生效/失效来源不证明别名。完整原文、引用、手写补充、修改副本及旧主题跳转保留；生成期间重新复核归并依据。
- 原文分段按来源批量复核，保留逐段范围、原文 hash、内容 hash 和权限检查；命中按对象身份过滤，同 ID 的坏副本不能借用合法副本。模型返回后、最终注入前重新检查。同步扫描和对账复用同一文本解析结果，未改权威存储或冲突规则。
- 监督端执行 50 项相关检查全部通过：开发用例之外的关联/六问/阅读留出 21 项，生产召回集成及原文分段 13 项，Obsidian 自动同步与覆盖统计 16 项；另 4 个完整对象边界断言通过。开发端相关源码检查及 `git diff --check` 通过。重复运行不累计为独立用例。

混合基准使用 Intel i9-9880H、Node 24.22.1、临时独立数据和 vault：50,000 条权威记忆（30k 当前项目、15k 全局、5k 其他项目），5,000 篇完整笔记，10 条各 5,000 字符的长用户原文、250 个授权摘录与 240 个可检索段。完整读回记录/笔记，检查项目隔离正反对照、一次更新和一次遗忘后的旧文本/源笔记/索引清理。脚本为 `scripts/bench-mixed-capacity.mjs`；结果不是用户日常库数据。

| 路径 | 优化前 | 优化后 |
|---|---:|---:|
| 240 段原文授权与内容校验 | 225.99 ms | 11.11 ms |
| Obsidian 初次同步 55,000 篇源笔记 | 149.94 s | 104.41 s |
| 同进程内容未变同步 | 54.52 s | 40.73 s |
| 重开后更新/遗忘增量同步 | 51.19 s | 30.76 s |

缓存重开分别测得 323.03/304.19 ms，未达到稳定低于 300 ms；首次完整构建分别为 6.87/6.05 s。本轮没有修改启动缓存实现，这两项差值不作为代码优化收益。优化后词法稳定查询 p95 为 34.18 ms（重开进程，首查之外 29 次）。没有清空 OS 文件缓存，未测整个 DSH 启动。真实本地嵌入模型仅测 4 段调用和 75 条索引样本：优化后模型初始化约 3.10 s、75 条首次索引约 16.06 s、重开首查约 3.10 s、随后 7 次查询 p95 34.22 ms；不能据此声称全 50k 已向量化或全链路百毫秒。

未解决的容量限制：大库未变同步仍扫描/解析文件，50k 全量向量化和长期内存压力未完成独立验收。此次未新增默认付费模型调用、未扩大原文授权、未恢复关系图或人格模块。

原生安装与问答验收：

- 通过日常 desktop 的插件管理器原位更新，结果 applied，无需重启。版本、enabled、fiber active 与 Typert 自检正常，安装包 57 个运行文件逐一一致。升级前后 19 个作用域权威文件、763 条现存记忆、知识笔记、用户设置和宿主默认模型一致。
- 在独立 QA 项目通过原生导入接口加入 5 条虚构测试记忆，再建新会话，沿用当前宿主的 Qwen3.7 Plus 和日常 360 token 注入上限。负责人、请假代班、已选方案、选择原因、07:26 和 43 天六项均答对；原生事件中的实际注入包含全部五条原句，最终覆盖 6/6。这验证存储后的跨会话召回，不冒充本轮自动采集提炼验收。
- 另一项目的新会话无测试记忆注入、回答无相关记录。通过原生遗忘接口移除负责人及方案的桥接记录，再开同项目新会话，未注入相关关系，回答不知道；剩余代班/原因记录不能绕过缺失的桥接依据。
- 共发送 3 次有独立 requestId/回执的主对话；隔离和遗忘场景各触发 1 次现有自动补查，均无覆盖结果。没有重发结果未知请求、切换默认模型或提高日常额度。问答未调用工具，免保存控制生效；自动捕获任务仍为 329 项，pending/running/partial/failed/unknown 全部为 0。
- 清理仅涉及这 5 条 QA 记忆，QA 有效记录为 0；763 条原有记录逐项保持。恢复原来的 Obsidian 自动同步，后续实际同步无冲突、无错误。原生设置页显示存储可用、活动为首位、当前记忆 763、待处理/失败/待核实均为 0。
- Obsidian 1.15.0 原生应用实际打开阅读首页 → 项目主题目录 → 主题页 → 原记录，双链和反链可用。主题归并的否定、时效、撤销及手写冲突边界由隔离 vault 检查覆盖，未把演示数据写入用户 vault。

安装包 SHA256：`c28e9bc724144557a83cc554b5542ad8bf73b80fc131359dd36e57c4ad519bb5`（3,300,615 字节）。私有原生回执和测试记录位于 Git 忽略的 `docs/tasks/upgrade-supervision-20261110/`；混合基准原始结果位于同样忽略的 `docs/tasks/mixed-capacity-20261110/`。公开文档仅包含方法、虚构案例和汇总。
