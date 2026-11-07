# 主流 Agent Memory 系统调研笔记

> 调研时间：2026-10-31。用于 DSH 记忆插件的设计决策，不是产品测评。
> 本文保留当时的路线判断。Mem0 现行 OSS/Platform 区别及 OpenViking 当前检索实现，以 [2026-11-07 源码对照与升级建议](memory-upgrade-comparison-20261107.md) 为准；不要将下文早期 Mem0 更新流程视为现行所有版本的保证。
> 主要来源：[主流 Agent Memory 系统全景（2026-08）](https://github.com/cdavid817/awesome-agent-tutorial)、Mem0 论文与文档、Zep/Graphiti、Letta、Cognee、LangMem、A-MEM、Claude memory tool 等（见文末）。

## 1. 先划清边界

| 机制 | 保存什么 | 会主动演进吗 | 算完整 Memory 吗 |
|---|---|---|---|
| Context Window | 当前 prompt、最近消息、工具结果 | 否 | 否 |
| Compaction / Summary | 被压缩的历史 | 少量 | 否 |
| Session | 会话消息与基础状态 | 通常否 | 部分 |
| Checkpoint | 工作流状态、游标 | 否 | 部分 |
| RAG | 文档、网页、数据库知识 | 通常只读 | 否 |
| Agent Memory | 用户事实、偏好、经历、决策、经验、技能 | **是** | 是 |
| Fine-tuning | 模型参数里的知识与行为 | 离线 | 参数记忆 |

结论：**Memory 的本质是"在需要时把正确、可信、适用的信息重新注入有限上下文"**，不是把聊天记录无限堆进向量库。

## 2. 七条技术路线

### 2.1 通用 Memory API —— Mem0、Redis Agent Memory、Memobase

- **定位**：给已有 Agent 快速加长期记忆的 SDK / 服务。
- **写入流程**（Mem0 典型）：对话 → LLM 事实抽取 → 检索相关旧记忆 → 比较新旧 → `ADD / UPDATE / DELETE / NOOP` → 存储 + 索引。
- **优点**：接入成本低；作用域（user/agent/run）清晰；生态广。
- **缺点**：复杂程序性记忆与运行时状态要自建；抽取质量依赖 prompt 与模型；来源追踪/权限/删除传播需额外设计。
- **适用**：客服、个人助手、教育陪伴类，需要快速个性化。

### 2.2 时序知识图谱 —— Zep / Graphiti

- **定位**：把对话/文档/业务事件变成"实体—关系—带有效期的事实"。
- **核心表达**：
  ```
  USES_DATABASE(User, PostgreSQL)  valid_from=2025-01-01  valid_to=2026-02-28
  USES_DATABASE(User, SQLite)      valid_from=2026-03-01  valid_to=null
  ```
- **优点**：新旧事实不混淆；多跳、关系推理强；召回路径可解释。
- **缺点**：图构建、实体消歧成本高；查询链路复杂；简单偏好场景属于过度设计。
- **适用**：长期个人助手、CRM、企业知识、复杂项目 Agent。

### 2.3 Memory-Native Runtime —— Letta / MemGPT

- **定位**：把上下文窗口当"主存"，外部存储当"磁盘"，Agent 主动管理记忆。
- **分层**：Core Memory Blocks（身份/用户画像/长期约束）→ Recent Conversation → Archival Memory（按需检索）→ External（文件/DB/MCP）。
- **优点**：分层清晰；适合长期运行、跨天跨周的自治 Agent；支持共享 Memory Block。
- **缺点**：是 Runtime 而非轻量 SDK，迁移成本高；Agent 自主改核心记忆需要治理与验证。

### 2.4 反思与经验学习 —— Hindsight、LangMem

- **Hindsight**：`retain`（保存经历）→ `recall`（召回）→ `reflect`（形成 Mental Model）；记忆类型分 Observation / World Fact / Experience Fact / Mental Model。
- **LangMem**：语义、情景、程序性记忆；热路径（Agent 主动调用工具）与后台路径（分析历史对话）两种写入。
- **优点**：能从成功/失败中提炼可复用经验，长期收益高。
- **缺点**：反思不是事实，错误归因会污染后续决策；需要证据、置信度、适用条件、验证状态。

### 2.5 知识与数据记忆 —— Cognee、Supermemory

- **Cognee**：`remember → recall → improve → forget` 的 ECL 管道，文档/对话 → 向量 + 关系 + 知识图谱，支持本体与自定义实体。
- **Supermemory**：统一 Context Infrastructure，覆盖 Memory、Retrieval、User Profile、Connectors、多模态。
- **优点**：多源数据统一、企业知识工程能力强。
- **缺点**：对轻量对话记忆偏重；平台/数据模型耦合明显。

### 2.6 一体化 Runtime —— Backboard

Memory + Thread/State + RAG + 模型路由 + MCP 一套托管。接入快，但平台绑定范围大，自定义底层数据模型自由度有限。

### 2.7 Memory OS 与前沿研究 —— MemOS、MemoryOS、A-MEM

- **MemOS**：把文本记忆、激活记忆、参数记忆纳入统一生命周期（Generated → Activated → Merged → Archived → Frozen）。
- **MemoryOS**：短期 → 中期（会话主题）→ 长期（用户画像与稳定事实）分层聚合。
- **A-MEM**：Zettelkasten 式笔记网络，新记忆与旧记忆建立链接，链接/标签随新信息演化。
- **共同趋势**：从"检索—注入"走向"观察 → 检索 → 批判适用性 → 重构经验 → 行动 → 评估 → 更新"。

## 3. 文件型记忆（Coding Agent 特别相关）

- **Claude Code**：`CLAUDE.md`（用户显式维护的项目规则）+ Auto Memory（Agent 积累的项目经验）。
- **Codex**：分层 `AGENTS.md`（长期规则）+ Memories（历史上下文）+ Skills（可复用流程）+ MCP（外部连接）。
- **优点**：本地优先、可直接查看/编辑、可 Git 审计、迁移成本低、与仓库天然绑定。
- **缺点**：大规模语义检索弱；时间/冲突建模有限；跨项目共享不便；文件大了要分层和摘要。
- **工程模式**：**Markdown/JSONL/YAML 是权威事实，SQLite/FTS/向量/图是可删除、可重建的派生索引**。

## 4. 共性架构与数据模型

### 4.1 流水线

```
事件日志 → 写入策略（显式/热路径/后台）→ 归一化 → 去重与冲突检测
→ 时间有效性 → 作用域与权限 → 权威存储 + 派生索引
→ 检索（关键词/向量/图/时间）→ 融合重排 → Context Compiler → 注入
```

### 4.2 MemoryRecord（推荐字段）

```yaml
id, tenant_id, user_id, workspace_id, project_id, agent_id, session_id
kind: profile | fact | episode | decision | procedure | reflection | artifact
content, structured_payload
source_refs[], source_type
observed_at            # 系统何时看到
valid_from, valid_to   # 事实何时成立/失效
confidence, importance, sensitivity
status: candidate | active | superseded | expired | archived | deleted
ttl_seconds, version, supersedes_id, content_hash, created_at, updated_at
```

三个时间字段是重点：只有 `created_at` 无法表达迟到事件、历史导入和事实回溯。

### 4.3 更新语义

`ADD / UPDATE / SUPERSEDE / INVALIDATE / MERGE / NOOP / DELETE`。

### 4.4 作用域

`Tenant → Organization → User Private / Workspace Shared → Project Shared / Agent Private / Session Temporary`。
检索必须先做确定的 ACL/Scope 过滤，再做检索和重排，避免"先全库搜索、再过滤"。

### 4.5 Context Compiler

不要 Top-K 原样拼接。按 token 预算组织，并给每条附：记忆类型、作用域、有效时间、来源、置信度、召回原因、是否允许覆盖。

## 5. Benchmark 怎么读

常见 LoCoMo 数字（Single-Hop / Multi-Hop / Open Domain / Temporal / Overall）只能作为参考：

- 数据子集、是否过滤 adversarial、回答模型、Judge Prompt、系统版本、Top-K 策略、是否调参、是否独立复现都不同；
- 排行榜说明"特定条件下的表现"，不等于"生产更优"。

更有用的指标：写入 Precision/Recall、重复率、检索 Recall@K / nDCG、新旧事实替换准确率、注入 token 数与有效比例、任务成功率、跨作用域泄露率、删除传播时间、召回延迟。

## 6. 对我们的启示（决定写进设计）

1. 采用 **CoALA 四分类 + 双作用域**，但只保留 preference / fact / decision / episode 四类，避免过度建模。
2. 采用 **后台自动抽取 + 显式优先** 双路径；抽取结果带置信度，低置信度进 candidate。
3. 采用 **ADD/UPDATE/SUPERSEDE/NOOP** 四操作，冲突显式处理。
4. 采用 **observed_at / valid_from / valid_to** 三时间字段。
5. 采用 **JSONL 权威 + 进程内 BM25 派生索引**（文件型记忆 + 可重建索引的折中，无数据库依赖）。
6. 采用 **混合打分 + Context Compiler**（BM25 + 时间 + 重要度 + 置信度，600 token 预算）。
7. 采用 **"数据不是指令"** 的注入格式与来源标记，降低 prompt 注入风险。
8. 保留 **删除传播、导出、revision 审计**，这是能否长期用的分水岭。
9. 暂缓：向量/图索引、程序性记忆自动晋升、反思闭环、多 Agent 共享治理。

## 7. 参考资料

- Mem0 论文：https://arxiv.org/abs/2504.19413
- Mem0 文档：https://docs.mem0.ai/core-concepts/memory-operations
- Zep / Graphiti：https://github.com/getzep/graphiti
- Letta（MemGPT）：https://docs.letta.com
- A-MEM：https://arxiv.org/abs/2502.12110
- Cognee：https://github.com/topoteretes/cognee
- LangMem：https://www.langchain.com/blog/langmem-sdk-launch
- Claude memory tool：https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- 主流 Agent Memory 全景（中文综述，2026-08）：https://github.com/cdavid817/awesome-agent-tutorial
