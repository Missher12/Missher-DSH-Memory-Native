# Evidence recall and navigation implementation plan

> Use executing-plans. The user authorized the existing GPT-6-Luna MAX chat for backend development; the coordinating chat owns client UI, independent acceptance and installation. Do not create new chats or subagents.

**Goal:** Complete the five approved recall upgrades and replace overlapping navigation with five useful entry points, then install and verify in DSH.

**Architecture:** Preserve JSONL authority, persisted capture tasks, exact source evidence and native plugin installation. Add scoped evidence retrieval and time-aware selection around the existing recall path. Use the current host model only for bounded missing-evidence work; verified local evidence remains usable without it.

**Tech stack:** Existing JavaScript ESM, DSH/Cordis/Typert, React client, local JSONL/Markdown.

**Spec:** The user's approval of the five upgrade recommendations in this chat, plus existing `docs/superpowers/specs/2026-11-06-memory-upgrade-design.md` for provenance, scope, budgets and failure semantics. Current UI authority is `/Users/missher/Documents/Codex-File/Deepseek-Corids/AGENTS.md` (DSH native, not old glass style).

## Constraints

- Work in `/Users/missher/Documents/Deepseek-File/DSH-Memory`, starting from 1.0.0. Preserve other work and original data/settings. No push, release, persona, MSE or Context changes.
- Backend chat owns `index.js`, `host/`, backend tests and evaluators. Coordinating chat owns `client.js`, UI previews, acceptance and installation. Agree on new wire shapes before client integration.
- Every retrieved evidence item must retain project/scope, identity/revision, exact source and time. Recheck deletion and scope before injection. Obsidian notes cannot resurrect forgotten content or silently broaden scope.
- No new external database or compulsory large model download. General paraphrase handling must not be a test-specific synonym list. Semantic selection may use one bounded current-host model pass when local lookup lacks evidence.
- Ordinary successful local recall has zero extra model calls. At most one additional selection/rewrite request per real user turn, bounded by existing budget, persisted identity/result, cancellation and unknown-result handling. No retry of unknown paid requests.
- Only the coordinating chat installs through the real manager after other sessions and capture work are idle. Use isolated QA data and remove only those test records.

## Tasks

- [x] **1 — Object and time correctness.** Add production pre-step regressions for a different object's same attribute, natural paraphrase, relative/date history, current versus superseded facts and reason/condition changes. Resolve effective time separately from when evidence was recorded; preserve unknowns rather than fabricate dates. Reject unrelated object/attribute evidence at root as well as child queries.
- [x] **2 — Unified scoped evidence.** Retrieve eligible knowledge/Obsidian notes and direct original source passages alongside memory records. Preserve full notes and raw sources; add rebuildable incremental lookup, not a full scan on every prompt. Existing unbound notes remain viewable and are not guessed into a project; UI must let the user choose recall scope. Deleted, opted-out, quoted or sensitive sources are excluded. Exact snippets must match the current source on read and before injection.
- [x] **3 — Paraphrases and missing-evidence completion.** Keep literal/version/path lookup fast. Automatically fill uncovered question slots with verified local sources and, only when useful, one current-host model selection/rewrite. Validate all returned identifiers and verbatim evidence. No model-generated facts may become authority. Report actual covered and missing items, known/unknown request state and actual usage.
- [x] **4 — Project brief.** Derive an automatically refreshed project overview of active facts/constraints, confirmed decisions with reasons, historical replacements and unresolved candidates/conflicts, each with record/source references. No invented summary facts or personality. Refresh/invalidate on update, removal, import and sync; page through large collections. Expose a native `projectBrief` operation for the client with scoped input and bounded output.
- [x] **5 — Navigation and native UI.** Five top-level views: 记忆 / 项目档案 / 知识 / 活动 / 设置. Memory contains records and 用户偏好; knowledge contains 笔记 and 关系图; activity contains extraction progress and recall usage; settings contains capture/recall options, retention, data/backup and Obsidian sync. Preserve every existing operation, confirmations, errors, i18n and keyboard use. Settings use native label-left/control-right rows. Avoid duplicated sync controls and overlapping names.
- [x] **6 — Acceptance and install.** Backend tests focus on new behavior, known 40-question regression and a small newly held-out set. Reuse 50k tools because retrieval/index paths change; compare contents and actual runtime/query latency without claiming whole-host 300ms startup. Review real components at desktop/narrow widths and light/dark themes. Package candidate above 1.0.0, install through manager, verify runtime and files, then real current-model sessions for normal capture, compound/paraphrased recall, correction/history, scoped knowledge note, project isolation and forgetting. Update public evidence with honest limitations.

## Research failures to retain as regressions

- Stored `项目采用 PostgreSQL 16.3 作为数据库。`: literal database query works, `关系型持久层最终选用了哪款产品？` has no injection.
- A snapshot retention old=17 days valid from now−50d to now−10d, current=29 days from now−10d: current query works; `三周前青鹿快照保留期限是多少？` and `以前青鹿快照保留期限是多少？` produced no evidence in the small production-path test.
- A knowledge note contains `白鹭项目的构建工具是 Vite 8.4.2。`: its query misses the note and injects the unrelated database memory above. Fix the false positive and implement scoped note retrieval.

## Review focus

- Short follow-ups must keep the right entity and requested time without inheriting tool/internal content.
- Legacy sources and notes with incomplete provenance must not acquire broad permission by migration.
- Multiple pre-step calls, host cancellation/restart and late results must not repeat paid selection or revive deleted evidence.
- Unknown claims, contradictory evidence, unrelated same-named objects and stale Obsidian copies must remain distinguishable.
- The larger evidence catalog must not block ordinary chat or require loading whole source files on every query.

Completed 2026-11-07: `1.1.0-native.20261107.3` installed and active. Real capture, compound/paraphrase recall, correction/history, knowledge scope, cross-project isolation and forgetting verified. QA data removed and Obsidian automatic sync restored. Public results and limits: `docs/verification.md` §74. No push or release.
