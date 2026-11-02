# 记忆插件调研：别人怎么做到「越用越懂」，以及 Jev / Laya 决策模型接入

> 调研时间 2026-11；只作为设计参考，不引入任何外部运行时依赖。
> 我们的边界不变：本地优先、明文 JSONL、零依赖、索引可重建。

## 1. 主流路线（七条）

| 路线 | 代表 | 核心做法 | 可借鉴点 |
|---|---|---|---|
| 通用 Memory API | Mem0、Memobase、Redis Agent Memory | 抽取 → 存储 → 检索，`ADD/UPDATE/DELETE` 更新语义，user/agent/session 作用域 | 我们已有 ADD/UPDATE/SUPERSEDE/NOOP；可补 user 级 profile |
| 时序知识图谱 | Zep / Graphiti | 实体关系 + 时间有效期，事实冲突走失效 | 我们已有 valid_from/valid_to；图谱暂不做 |
| Memory-Native Agent | Letta / MemGPT | Agent 自己管理上下文与分层记忆（core/archival） | 我们的「预算内上下文编译」同源 |
| 自进化 / Persona | dsh-self-improved、mem0 用户画像 | L0 捕获 → L1 抽取 → L2 场景 → L3 人格；巩固、衰减、纠正、技能合成 | **最值得抄的骨架**：见第 2 节 |
| 记忆控制模型 | Jev-Mem、jev-agent-memory | 小决策模型做路由/挑选/预算，文本模型只负责写 | 见第 3 节 |
| 伴侣向记忆 | memory-trigger | 情绪标签、召回衰减、`memory_evolve` 复盘 | 情绪钩子可做「召回理由」字段 |
| 评测与去重 | LoCoMo、LongMemEval、ironcurtain 设计文档 | 三层去重（精确 → LLM 边界判断 → 矛盾检测/supersede） | 我们可从 Jaccard 升级到这套 |

> 全景参考：[awesome-agent-tutorial 附录O：主流 Agent Memory 系统全景](https://github.com/cdavid817/awesome-agent-tutorial/blob/78b16fa1b76c95100141f6d156e0d3661760f2ce/%E9%99%84%E5%BD%95/%E9%99%84%E5%BD%95O-%E4%B8%BB%E6%B5%81AgentMemory%E7%B3%BB%E7%BB%9F%E5%85%A8%E6%99%AF.md)

## 2. 「越用越懂」的 5 个真正有效的机制

### 2.1 四层记忆金字塔（dsh-self-improved）
[仓库](https://github.com/madage/dsh-self-improved)：L0 原始捕获 → L1 记忆抽取 → L2 场景分组 → L3 用户人格；再叠加巩固、衰减、纠正、技能合成。
- 我们只有 L0/L1（捕获 + 四类记忆），**缺 L2 场景与 L3 人格**。
- 它把「技能合成」也做了——这正是和 MSE 冲突的地方。

### 2.2 带证据的画像（jev-agent-memory 的 profile）
[仓库](https://github.com/hojeongna/jev-agent-memory)：每天最多 3 条 user trait，每条必须带 `kind / statement / confidence / 原文引用 evidence`；代码校验引用必须逐字出现在当天日志；情绪不进 trait；新旧 trait 走 merge/supersede。
- 关键不是「抽取偏好」，而是**证据可审计**：为什么懂你、从哪句话懂的。
- 衰减：profile 用 `confidence × 0.5^(days since last_seen / 60)`，episodic 用 90 天半衰期——旧记忆不删除，只降权。

### 2.3 三层去重与矛盾处理（ironcurtain 设计）
[设计文档](https://github.com/provos/ironcurtain/blob/HEAD/docs/designs/memory-server-comparison.md)：精确匹配 → 余弦边界判断 → LLM 矛盾检测 + supersede 链。
- 我们现在是 Jaccard ≥ 0.9 合并；下一步用「LLM 判定边界 + 矛盾检测」补 0.8–0.9 灰区。
- 矛盾不要静默覆盖，保留 supersede 链（我们已有）。

### 2.4 决策模型做记忆控制（Jev-Mem）
[仓库](https://github.com/libingzheren/Jev-Mem)：小模型（System 1）负责记忆类型、关系判断、查询路由、预算分配、候选打分、证据是否足够；文本模型（System 2）只负责回答。
- 结果：LoCoMo 0.777（论文报告）对比 MAGMA 0.700；建图快 6.6×。
- 可借鉴的是**接口设计**：控制器只输出 typed 决策（noul/choice/score），代码执行检索与预算，不信任模型自由文本。

### 2.5 召回即「有理由的想起」（memory-trigger）
[仓库](https://github.com/riisovo/memory-trigger)：情绪标签、主动回忆、召回后衰减、`memory_evolve` 复盘。
- 可以不抄情绪，但可以给每条注入加「为什么想起它」：命中词/主题/最近提及时间。

## 3. 接入 Jev / Laya 的记忆系统：确实有，而且不止一个

| 项目 | 和 Jev/Laya 的关系 | 做法 |
|---|---|---|
| [Jev-Mem](https://github.com/libingzheren/Jev-Mem) | 原生 Jev，2026-09 起支持 **Laya 本地** 决策后端 | 小模型做记忆关系/检索控制，文本模型回答 |
| [jev-agent-memory](https://github.com/hojeongna/jev-agent-memory) | 原生 Jev | 每条消息先路由主题、再挑 ≤4 条片段 + 画像；Jev 故障回落 FTS5 |
| [edge-jev](https://github.com/ShaneLiu04/edge-jev) | Laya ONNX + 本地 LLM | 端侧快慢双系统运行时，内置长程记忆 |
| [laya-mcp](https://github.com/PerryLink/laya-mcp) | Laya 的 MCP 服务 | 把 `noul/choice/score` 决策暴露成工具，带预算预检与校准 |

**Jev 是什么**：TypeSafe 的 System-1 决策模型，只回答 yes/no、多选、打分（带概率），不能写文本，适合每消息路由。**Laya** 是 Convai 的非自回归决策模型，同样是 typed decision。

**重要警告（laya-mcp README 自己写的）**：
- Laya 基础 checkpoint 在 typed decision 上**接近随机**（英文 0.362，多数类基线 0.461）；
- `score` 最弱（35% vs Jev 70%）；选项超过 ~20 个准确率明显下降；位置偏差真实存在；
- 概率需要用自己的标注做温度校准，否则「confidence」没有意义。

结论：**Laya 不能拿来直接当记忆路由器**，除非先在自己的数据上校准/评测；Jev 质量更好但是云服务（要 key、文本会出本机）。所以我们的接入应该是**可选后端 + 本地回退**，默认仍是本地 BM25。

## 4. 和 MSE / TDAI / dsh-self-improved 的关系

| 组合 | 是否冲突 | 说明 |
|---|---|---|
| **我们 + MSE**（`mse-learning`） | 低 | MSE 注入的是 `[[mse-learned]]` 经验块，我们注入的是 `<memory-context>` 事实/偏好；数据不共享、互不覆盖。代价是上下文里两块注入、token 变多。 |
| **我们 + TDAI** | 中 | 两者都做自动捕获 + 注入，会重复记同一件事、重复注入；建议只留一个注入器。 |
| **我们 + dsh-self-improved** | 高 | 捕获、注入都重叠；对方还做 L2/L3 与技能合成。二选一，或明确分工（它们做人格/技能，我们做可审阅的事实库）。 |
| **dsh-self-improved + MSE** | 高 | 都做「从经验合成技能」，容易重复/互相覆盖。 |

**建议**：把「注入」收敛到一个插件；我们的定位是**可审阅的本地事实/偏好库 + 面板**，不抢技能合成。若同时装，至少把另一方的注入关掉，或把我们的 `inject.enabled` 设为 false 只做记录。

## 5. 对我们 v0.3 / v0.4 的具体建议

### v0.3：把「越用越懂」做实
1. **Profile 层（L3）**：从 preference/decision 聚合成 5–10 条「用户画像」，每条带 confidence、last_seen、evidence（原文 + 日期 + 记录 id）。
2. **证据校验**：画像条目的引用必须能在记忆条目里找到；没有证据不进画像。
3. **时间衰减**：episodic 90 天、profile 60 天半衰期，只降权不删除；`last_seen` 随新证据刷新。
4. **L2 场景分组**：给记忆加 `topic`（如「DSH 插件开发」「部署」），召回先按主题过滤再打分。
5. **三层去重**：Jaccard 精确 → 灰区 LLM 判定 → 矛盾标记 supersede。

### v0.4：可选决策模型路由
1. 定义 `router` 接口：输入当前消息 + 候选记忆 + 预算，输出 `{picked: [id], confidence}`；默认本地 BM25。
2. 可选后端：Jev HTTP（需 key，默认关闭）或 Laya sidecar（本地、需校准）；失败自动回落本地。
3. 决策模型只做路由/挑选，不写文本；所有决策留 trace（`router.jsonl`）可审计。
4. 先用我们自己的 30 条召回测试集对比「本地 BM25 vs Jev vs Laya」，有数据再决定是否默认开启。

## 6. 参考链接
- Mem0: https://github.com/mem0ai/mem0
- Letta: https://github.com/letta-ai/letta
- Zep / Graphiti: https://github.com/getzep/graphiti
- dsh-self-improved: https://github.com/madage/dsh-self-improved
- jev-agent-memory: https://github.com/hojeongna/jev-agent-memory
- Jev-Mem: https://github.com/libingzheren/Jev-Mem
- laya-mcp: https://github.com/PerryLink/laya-mcp
- edge-jev: https://github.com/ShaneLiu04/edge-jev
- memory-trigger: https://github.com/riisovo/memory-trigger
- LoCoMo / LongMemEval 评测思路：见 Jev-Mem README
