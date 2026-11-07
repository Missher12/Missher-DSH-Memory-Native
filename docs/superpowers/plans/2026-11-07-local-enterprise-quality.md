# Local Memory Enterprise Quality Implementation Plan

> Execute inline using superpowers:executing-plans. User rules override skill ceremony: no new agents, no unsolicited commits, no repeated passed checks, no separate workflow scaffolding. Preserve the existing accepted uncommitted work.

**Goal:** Deliver the local reliability and operational quality defined by the user-approved local-plugin scope.
**Architecture:** Keep JSONL authority and the existing native panel. Add small persistence/recovery helpers only where used, preserve source and payment ledgers, and report failures without silently changing policy.
**Tech Stack:** Node ESM, fs, current DSH/Cordis/Typert, existing client and Node tests.
**Spec:** `docs/superpowers/specs/2026-11-07-local-enterprise-quality-design.md`.

## Constraints

- Work on `codex/memory-evidence-navigation` over accepted `1.1.0-native.20261107.3`.
- No push/release/new service/persona/MSE/Context change; no edits to real memories for testing.
- Installation only when other host sessions and capture calls are idle, through the current plugin manager.
- Recovery targets new empty directories. Existing authority, settings and request receipts stay intact.

## Review focus

- Corrupt or interrupted settings cannot reactivate a user-disabled function.
- A backup is not a complete recovery if it omits tombstones, evidence grants or unknown paid receipts.
- Concurrent writers and partial writes must not be hidden as successful saves.
- Explicit import is not permission to resurrect a newer local deletion or accept a future schema.
- Missing profile identity and unavailable storage must produce a visible bounded failure, not cross-profile reads.

## Work

- [x] **1. Durable settings and writer safety.** `host/settings.js`, `host/store.js`, a shared `host/persistence.js` where justified; `tests/settings.test.js`, `tests/store.test.js`. Reproduce corrupt/default fallback, rename failure and live stale-lock behavior. Implement atomic fsynced private-file writes, strict persisted settings validation, alive/dead owner handling and full-write loops. Integrate a readable settings failure/recovery state in the native backend without changing configured defaults.
- [x] **2. Complete backup and safe recovery.** New `host/backup.js` plus packaged recovery CLI; integrate `MemoryStore.backup()`, maintenance, native backup operation and its copy. Immutable directory snapshots include authority/history, source/recall barriers, capture/selection ledgers, knowledge, settings and sync state; runtime tokens/caches/locks excluded. Validate manifest/files and stable source set before publication. Restore only into a new empty target, reject symlinks/traversal/corruption. Exercise real isolated backup→restore, forgotten records and unknown requests. Daily pruning occurs only after usable backup availability; errors remain visible.
- [x] **3. Import integrity.** Validate payload and every record before writes in `host/store.js` and `host/remote-contract.js`; keep the current import contract where possible. Reject future schema, malformed revisions/fields, scope conflicts and ordinary resurrection of local deletion. Verify zero mutation for rejected payloads, dry-run/apply agreement and valid old export round-trip.
- [x] **4. Profile boundary and health.** Inspect real host profile API before using it; extend `host/paths.js` and activation only with verified context. Preserve desktop legacy ownership, reject explicit conflicting owners. Add a native health/diagnostic view using existing activity page, bounded counters and fixed error codes; redact private bodies and paths. Verify two isolated host compositions and native displayed status.
- [x] **5. Acceptance and installation.** Relevant regression and previous production recall evaluation; reuse unchanged tests and measure affected capacity paths only. Pack next native candidate, install through manager when idle, compare existing data/settings and runtime files, check native health/backup controls. Restore an isolated complete backup and test recall/isolation/deletion there without issuing unnecessary model requests. Update README/public verification and finish only when this local-quality scope is met.

## Progress

- 2026-11-07: Goal created; user selected local plugin. Existing source proves settings errors fall back to defaults, backups omit history/deletions/evidence, import has no full validation, stale locks rely only on age. Implementation starts with these specific defects; no blanket rewrite.

- Task 1 implementation/checks: corrupt-policy and rename-failure tests failed before fixes; settings now fail closed with a usable recovery panel. Full-policy explicit save preserves malformed file before repair. Live-PID stale-lock, dead-PID recovery and short writes reproduced and fixed. Additional failed-append rollback and interrupted JSONL tail tests reproduced and fixed. Relevant runs: persistence/settings/store/atomic 25/25; append/store/atomic after added cases 19/19; settings recovery/activation 21/21. Logs: ignored `docs/tasks/local-enterprise-20261107/`. UI recovery banner/save state added; final native UI check remains task 5. Candidate NOT installed; live remains 1.1.0-native.20261107.3.
- Task 2 in progress: `host/backup.js` and packaged `host/recovery-cli.js` provide complete snapshot/verify/restore-to-new-dir. Three core round trips pass, including history/deletion/barriers/unknown calls/notes/settings, unique timestamps, corruption and symlink rejection. Still integrate maintenance/legacy backup tests and UI copy. Before integration, make backup work yield so large evidence sets do not block host UI; maintain stable inventory checks and reject concurrently changing sources. Recovery may remain an offline CLI, documented with exact invocation; do not hot-replace the live data root.
- Ruling: stay on the already accepted uncommitted feature branch and preserve prior work; no extra worktree, agents, auto-commits or workflow scaffolding. User explicitly chose local quality and autonomous implementation; no redundant plan approval pause. Snapshot recovery is to a new path only, leaving real records and policy untouched.

- Tasks 2–4 source checks complete: backup integration 61/61; import/cache/store 27/27; boundary/activation 16/16; health/backup/persistence/remote 58/58; capture/Obsidian/recall regression 54/54; clock/boundary/atomic replacement 9/9. Verified actual host `profileContext` (name/dir/home) in packaged profile boot source. Desktop location retained, other profiles default isolated, ownership conflicts get diagnostic-only panel. Backup CLI round trip and restored unknown-call zero resend passed. 50k full corpus search p95 20.78ms; direct first index build 2015.39ms, replacement/readback passed (OS cache retained; not complete host startup). Native install/UI and isolated restored-root acceptance remain Task 5.

- Task 5 completed: installed `1.2.0-native.20261107.0` through the native manager, applied/active and Typert self-test passed; 45 package files match. Preserved 16 authority files, 725 current records, settings and default model. Native UI health, diagnostic export and complete backup checked. Installed recovery CLI restored 2,749 files byte-for-byte; 725 current records, 40 tombstones and 295 capture tasks retained. Installed production pre-step in the isolated restored copy passed fresh-session fact/reason, project isolation and forgetting checks with zero model calls. Temporary recovery data and preview backend cleaned up. Corrupt-policy save and ownership-conflict UI passed in an HTTP preview; screenshots are wide-window evidence, despite their filenames, not 360px native acceptance. Final 50k cache reopen 195.27ms/search p95 20.30ms, first cache build 3735.26ms; OS cache retained. README and public verification §75 describe the bounded result and budget-wait tasks. No new cloud service, commit, push or release.
