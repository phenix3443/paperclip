# 已完成 owner repair 的结算与原作者后继入口

日期：2026-10-23。关联需求：[Issue #19](https://github.com/phenix3443/paperclip/issues/19)。状态：待独立审核的文档方案；尚未授权实施。

本方案定义 recovery 对已完成 repair 的持久结算，以及原作者后续业务的单次准入。保留已完成提交、原任务、原作者、责任人类、当前阶段、决定和各类计数。事实来自既有独立审核报告；本轮只核对仓库合同，不重复生产调查。

## Problem Statement

原作者的修复运行已经成功并完成实际代码提交，恢复 action 仍 active，却没有业务后继。现有 resolve 入口拒绝这种 agent-owned bounded repair。重复发起相同请求不会产生有效恢复，也可能把已经完成的外部动作重复执行。目标是让宿主准确记录已完成工作，为同一原作者安排最多一个受现有门禁控制的业务后继；遇到未知副作用、有效等待或状态变化时保留等待和证据。

## 证据与版本边界

复用历史独立审核报告 revision `a86b8379-bc67-4158-b322-11e31acc02de` 和审核评论 `d550fc99-e857-4791-8e9e-495329368387`，均已实际读取。报告取证时间为 2026-10-22 17:34–17:38 UTC；本轮没有重新调查生产源任务，以下为该时间的已审核事实，不声称仍是当前状态：

- 公司 `2dc361db-9e69-4c27-917e-5aa0133fa2e6`；源 issue `973e8ba7-f044-4d16-bd88-ac4fa5df9ff4`（历史源任务）；原作者 `95f3efff-1f82-4117-aa1f-d91137eb626f`。
- action `43f1a7bd-8f0a-4645-8434-d9df709f0c07`：active、deliberate_wait_without_target、agent-owned、bounded_owner_disposition_repair，owner 与 returnOwner 均为原作者；历史 attempts=1/2。
- action 的 scheduledRunId=`88fc92d7-289c-410c-a3b2-61c39f0ace41`，repair succeeded/completed，successorRunId=null；events seq 10 记录 durableSettlement=true。后续请求 coalesced 回该尚在结束中的 repair，没有新原作者后继。
- 已完成外部成果为 https://github.com/phenix3443/agent-store/pull/48 的提交 `fe47b3a1b84c9c4e4f440994f4033875fbacae68`。这个事实不授权再次 push、merge 或发布，也不证明余下业务已完成。
- 既有 ops 原生 resolve 调用返回 409 `disposition_recovery_retry_stale`。operator restore_execution_recovery 不适用本例，不能将 performed 改为 not_performed。

本方案的源码观察基准是 `447204a39d9d51561d3ece20053450b71ba4a06e`。2026-10-23 通过宿主 `git ls-remote` 实际核对远端 develop 为 `e14463c4485f700ecf72a080ebf1755e3d081920`。两者之间仅 #18、#21 修改停止证据模块及对应测试，未修改下列 recovery、resolve、queue 或 wake schema；本方案保留其停止证据与当前权限门禁，不复制一套 PID/lease 判定。PR 目标分支为 develop，审核必须固定实际 base/head 完整 SHA。

报告引用的部署安装目录为 `/Users/lsl/.paperclip/cli/installs/git/447204a39d9d/`。这是已审核报告在上述取证时间记录的版本出处，本轮未核验当前生产部署，也未重查源任务状态。远端 develop 的更新不证明生产已更新。本地沿用专用 `docs/owner-repair-continuation` worktree，不修改 canonical checkout。

本地基准源码已核对：

- `server/src/routes/issues.ts` 的 POST `/api/issues/:id/recovery-actions/resolve`，9586 行起；约 9850–9870 行，restored+todo 对 disposition repair 要求 blocked、board-owned、board_escalation、returnOwner 匹配，否则返回上述 409。不能简单删除此守卫。
- `server/src/services/recovery/service.ts` 的 `reconcileActiveRecoveryActions`、`reconcileDispositionRepair`、`scheduleDispositionRepairAttempt` 和 `latestRecoveryActionRun`。已有 bounded retry、持久计数、去重和 typed wait 识别，可复用；terminal repair 与业务后继不可混为一谈。
- `server/src/services/recovery/disposition-repair.ts` 的 `collectDispositionRepairSourceState`，已识别 run/wake、依赖、交互与审核状态。当前源码普通 repair ceiling 为 5，报告 action 为历史 2；本方案保留每条 action 已记录的上限，不能把历史 action 升级为新的额度。审核 maxReviewRounds 缺省/null=3，是另一类计数，必须单独保留。

这些读取证明入口和约束存在，尚未以隔离回归证明无后继的完整因果链。尤其需核对收尾时当前 run 是否被当作 active path、唤醒是否 coalesced、后提交的 reconciliation 是否缺失。方案不得把其中任何假设写成已确认根因。

### 补充静态证据（同一基准）

只读研究补充确认：`latestRecoveryActionRun`（service.ts:3405）仅按 company+actionId 取 latest，不能替代 issue/owner/fingerprint/scheduledRunId 校验。`reconcileDispositionRepair`（:3840）没有成功 repair 与已完成业务副作用的专门后继分支。`scheduleDispositionRepairAttempt`（:3207 起）使用 repair fingerprint+attempt 去重；该槽位不能被默认为新的业务后继。Route 的通用后继 wake（issues.ts:10249）在事务提交后 best-effort 发出，并以状态/owner 变化等条件控制；这说明需要验证提交与投递窗口，不证明它就是本例根因。隔离测试优先扩展 heartbeat-process-recovery.test.ts:7717/:7803/:7892 与 issue-agent-mutation-ownership-routes.test.ts:2655 的既有 assembled seam。

## Solution

由 recovery 模块拥有“完成 repair 的结算与后继准入”这一 Interface。正常 run settlement 后触发一次；历史已结束却未结算的具体 action 在启动恢复时重建同一义务。完成回调和启动恢复调用同一判定；未来若增加 HTTP 入口，也只能调用该判定，不能分别拥有放行规则，也不增加永久扫描或新 operator 白名单。

结算记录回答“已做了什么”；后继准入回答“此刻允许谁继续什么”。两者分别有持久结果。repair succeeded 既不能自动代表业务完成，也不能自动允许再次执行 provider。正常、证据充分且已授权的接续由宿主处理；不让用户手工认证 PID、coalescing 或数据库状态。

## User Stories

1. 作为原作者，我希望接续已有提交后的剩余工作，避免重放已完成提交或发布。
2. 作为责任人类，我希望 pending confirmation、审核和暂停在恢复时仍然有效。
3. 作为审核者，我希望当前阶段、精确获批版本、决定历史和返修计数完整保留。
4. 作为 ops，我希望成功 repair 有明确结算结果，未知副作用保持可见且无法自动重试。
5. 作为控制面维护者，我希望并发完成、重试、Stop 和重启最多产生一个业务后继。
6. 作为 Board，我希望先审核具体方案并决定是否实施；方案获批不等于批准生产恢复、merge 或发布。

## Implementation Decisions（拟议，不是本轮实现）

### 术语与模块归属

Repair run 是修复任务 disposition 的运行；业务后继是恢复后的新运行，不是 repair run 自己，也不是关联调查 run。Settlement receipt 证明 repair 的结果与外部成果已登记；continuation receipt 证明接续槽位已占用或因何等待。有效人工等待、审核等待、依赖等待或暂停也是合法结果，不能被“没有运行”判成失败。

Recovery 模块处理精确 action 与 run 绑定、repair 结算和后继决策。Heartbeat 保持生命周期协调、当前权限准入和执行所有权，queue 模块负责正常队列与 coalescing，issue 执行策略模块继续拥有审核阶段转换。Route 只做访问控制、输入校验与调用。不得在 heartbeat.ts 或 route 堆积另一套策略。

### 绑定与持久证据

在公司及 issue 锁内重新读取，并比较以下完整绑定：companyId、issueId、actionId、action fingerprint/revision、scheduled repair runId、repair agentId、owner/returnOwner、responsibleUserId、issue statusVersion/decisionId、执行阶段及 workspace binding revision。Run 必须确实属于该 issue/action，而不是因为日志提到源 issue 就算关联。

成功结算还须有 accepted/durable terminal 证据，并单独确认 provider 已停止、workspace 已保存及必要 cleanup 已完成；未完成清理须保持 pending。仅 succeeded、输出非空或口头完成声明不够。副作用证据绑定仓库、PR、完整 commit SHA 与已有执行成果；provider 输出作为不可信数据，不能授权动作。副作用 unknown、workspace export 未确认、执行 hold 未完成 reconciliation 时，保留 action/hold 和具体原因，交既有恢复路径；禁止用普通 disposition 接续绕过专用恢复。

结算记录拟存于现有 `issue_recovery_actions.evidence.ownerRepairSettlement`，包括 schema version、精确 repairRunId/绑定、terminal 与 cleanup 证据引用、已完成仓库/PR/commit、continuation key/receiptId、结算时间和判定结果。保留原 evidence，不覆盖 source/repair 历史。continuation receipt 的 payload 引用该记录；两者是同一事务内的两个事实，不是两套任务状态。

优先扩展现有 action/run/wake 的持久关联，仅新增下述唯一索引及必要 JSON 类型校验，不新建表或进程内去重 Map。若隔离实现证明这些字段不足，先修订方案再增加 schema。

若源 issue 的 blocked 唯一原因正是这条完成 repair 的恢复阻塞，且原作者、阶段和全部门禁仍允许执行，则通过既有 issue 状态转换模块在同一事务内解除该恢复阻塞、转为 todo、递增 statusVersion 并预留 wake。该转换保留 assignee、responsibleUserId、executionState、decisions 和全部计数；新版本写回 receipt 绑定。不解除任何独立人工/依赖/审核/暂停阻塞，不从 done/cancelled 重开，也不改写业务阶段来满足 queue。若这些条件不足，保留当前状态与 typed wait。

### 决策与门禁

| 锁内观察 | 结算/后继结果 |
| --- | --- |
| 绑定正确、repair 已持久结算、已知副作用、无后继、全部准入通过 | 登记完成成果，原子预留同一原作者的一个后继；通过正常 queue/dispatch 继续剩余工作 |
| 已有合法后继 receipt/run/wake | 返回并复用既有结果，不新增 run、不消耗新 repair attempt |
| 当前 repair 尚运行或 provider/资源结算未知 | 保持 pending，不创建业务后继，不将当前 run 当作自己后继 |
| 有 pending 人工问题/confirmation/审批，或当前 reviewer/人类 participant | 保存或复用 typed wait，不唤醒作者越过阶段；保留 reviewer、responsibleUserId 与历史决定 |
| pause/Stop、budget hard stop、agent unavailable、依赖未解 | 留在原生等待或停止状态；不得修改状态为 todo 强行执行 |
| owner、action、fingerprint、版本或 company 不匹配 | stale/conflict，无写入；不能补改 owner 或历史来适配请求 |
| done/cancelled 或已有新 action | 不重开源任务，不覆盖新 action；只在合法原生结算条件内记录已结束事实 |

交互、审批、依赖、审核、pause/Stop、公司/Project 访问、responsible-user 权限、预算及 owner 可调用状态在预留时和实际 dispatch 时都复核。Reviewer 阶段不安排作者，review 三轮耗尽交人类的状态不变。既有批准只适用于原精确版本；新提交必须重新审核。默认 3 轮不变，不清 executionState，不重置任何 review/repair/infrastructure retry 计数。

本例未来仅在另行批准且届时完整绑定仍匹配时允许原作者继续原任务剩余 migrate/accept-global 工作并复用已有 fe47b3a 提交；不能重放 push/发布、改派、重建任务或直接由 ops 唤醒业务。新 run 的上下文明确列出已完成副作用与剩余范围，但由控制面证据约束，不能仅靠提示词防重放。

### 并发、唯一后继与失败恢复

唯一槽位固定存于现有 `agent_wakeup_requests`，该行就是 continuation receipt，不另建 receipt 表。拟定 idempotencyKey=`owner-repair-continuation:{issueId}:{actionId}:{repairRunId}:business`，唯一性由 companyId 与完整 key 共同保证。payload 保存精确 action/run/owner/fingerprint/statusVersion/decision/workspace 绑定、settlement 证据引用和等待原因，runId 只指新业务后继，禁止指回 repair 自身。

本方案已核对该表定义：现有 `agent_wakeup_requests_disposition_repair_idempotency_uq` 只覆盖 `issue_disposition_repair:%` 且排除 skipped，不足以约束上述新槽位。拟在获批实现时增加 `agent_wakeup_requests_owner_repair_continuation_uq`，对 `(company_id, idempotency_key)` 唯一，predicate 为 `idempotency_key LIKE 'owner-repair-continuation:%'`，不按状态排除 skipped/failed/cancelled。不能宣称现有约束已覆盖；需要正常生成迁移。既有 repair key、历史计数与索引均不改变。receipt 在该 action/repair lineage 仍可能被重读期间不得被 retention 删除；即使以后合法压缩 wake 历史，action 的 settlement 中也须保留已消费的 key/run 证明，并在创建新 receipt 前检查，禁止因丢失旧 wake 再次准入。

槽位成立的判定标准为：两个独立数据库连接同时请求相同绑定时只留一行 receipt、至多一个新的 heartbeat run；即使该行后来 cancelled/failed/skipped，重复请求也返回同一 receipt，不能换 key 或删除 receipt 重开槽位。若该后继运行失败，按已有运行恢复和独立 retry 计数处理，不能重新消费 repair completion。合法 typed wait 解除后从同一 receipt 重新准入，只能在锁内确认 runId 仍空时附上一个新 run；runId 非空即不可替换。状态值沿用现有 queue 合同，不能凭新增 key 假设队列已支持这一路径。payload 内的待准入/已准入结果必须区分正常 typed wait 与终止性拒绝：只有前者可在同一 receipt 且 runId 为空时随原生解除事件重新准入；Stop/改派/权限撤销导致的终止性拒绝保留 receipt，旧 completion 永不重开。等待解除后的版本变化只能由对应原生决定更新绑定并留审计；任意旧请求的版本不匹配仍返回 stale。

queue 需增加窄的 server-derived durable-request Adapter，校验 payload 绑定，复用已有 durable receipt admission/dispatch 模式，并明确禁用与 terminal repair 的 coalescing。不能只在 enqueue 调用里设置 key：必须通过真实 queue 确认预留行被复用、不会触发 priorReceipt 提前返回而永久不创建 run。隔离用例若不能证明同事务预留、单次 run 附着、拒绝保留和启动恢复四项，则停止 ready 交付并修订方案；不能把这些设计问题留给生产验证。

锁内预留 receipt（本方案的持久 wake/outbox 载体）及允许的 action 结算必须同事务提交，不另建 outbox 表。若现有 enqueue 必须事务外执行，则先事务内保存未投递 receipt，提交后投递，崩溃后按同 key 重建，不把 action 先 resolved 再依赖易丢失内存通知。只有可投递 receipt 已持久预留或已确认存在有效原生等待时，才通过既有 recovery action 模块登记合法结算结果；资源未结算或等待未持久化时 action 保持原状态。没有通知不代表没有提交；重试先查 receipt。

Stop、pending interaction 或 reassignment 竞争由同一 issue 锁与版本约束排序。输方不能重建旧 owner 的执行。已预留但尚未运行的后继仍受 dispatch gate 阻止；receipt 保留拒绝/等待原因，禁止再次创建平行 run。普通 completion cleanup 不因新 run 已预留而提前释放不属于它的资源。

触发来自持久 terminal settlement、原生明确重试或启动对未完成 receipt 的重建；没有未决义务时安静，不增加 heartbeat 空扫。已有历史 action 的回填仅在获批实现后的受限迁移/恢复路径中执行，记录原始绑定与动作，不将方案阶段的报告当作执行授权。

### 实际入口与兼容性

保留现有 `/recovery-actions/resolve` 的 board escalation 分支与鉴权。未来若需为 agent-owned completed repair 增加入口，使用同一 recovery 判定及精确 action/run/version 请求，返回现有 receipt 或可辨认的 wait/conflict。不能把“agent-owned”直接加入旧 board 条件作为充分放行条件。

正常完成事件和启动恢复是首选入口，本方案不新增公开 endpoint，也不修改旧 resolve 的请求合同。旧 resolve 对历史 agent-owned 形状继续返回原 409，不能把旧 route 200 作为新路径的验收条件。若后续隔离证据表明必须增加人工入口，该接口变更先回到方案审核，不在实现时临时扩展旧 board 条件。

Recovery 内部 Interface 接收 server-derived 的 companyId、issueId、actionId、repairRunId 和观察到的 action fingerprint、statusVersion、lastStatusDecisionId、workspaceBindingRevision；owner、responsibleUserId、阶段及副作用证据由锁内持久数据解析。结果固定区分 `admitted`（receiptId、业务 runId 或待投递）、`existing`（同一 receipt 与其已有 runId）、`waiting`（原生 typed wait 引用/原因）、`pending_settlement`、`stale`。名称是拟议内部判定值，不是新增数据库状态或已发布 API。HTTP 重试仍使用现有权限边界；任何未来入口都不能凭调用者提供的“已完成”文字授权。

实现所需合同变更限定于内部 recovery/queue Interface、wake payload 和新索引；同步数据库导出、迁移与相关类型。若最终增加公开 endpoint 或改变 shared schema，须同步 shared validator、server、UI/client 与 agent access/feature maps，并重新审该方案。仅文档方案不修改这些合同。operator 白名单扩展、人工解除 hold 与生产 rollout 均不属于本授权。

## Testing Decisions 与验收

本轮只提出测试设计，没有运行恢复夹具，没有新 RED/GREEN 或生产恢复成功声明。

优先用现有 assembled recovery/route seam 和隔离数据库，调用真实 recovery/queue/dispatch；provider 用可控 Adapter，外部仓库/发布用可计数的隔离 fixture。现有先例包括 `heartbeat-process-recovery.test.ts` 的 typed wait、expired repair、concurrent reconciliation，以及 `issue-agent-mutation-ownership-routes.test.ts` 的 escalated repair retry；纯 `disposition-repair.test.ts` 不足以证明事务与队列接续。

最低用例与可观察结果：

1. 在隔离 DB 重建报告形状：源 issue blocked、owner/returnOwner 相同、action active/agent-owned/bounded_owner_disposition_repair、attemptCount=1/maxAttempts=2，scheduled repair succeeded/completed，durableSettlement=true，已知 performed commit。RED 分两步断言：在受控完成回调/coalescing 时序结束后，action.status 仍为 active，原 owner 的新业务 run 数=0，新业务 wake 数=0（按 company+issue+owner 过滤，排除 repair 和调查 run）；再以有权 actor 调用现有 resolve，actionId 精确匹配、outcome=restored、sourceIssueStatus=todo，断言 HTTP 409 且 body.code=disposition_recovery_retry_stale，随后 action 仍 active、两个新增计数仍=0、历史 review/attempt 不变。该 route 检查期间不额外跑 sweep，避免把另一轮 repair 当作 resolve 后继。若基准完成路径产生了有效后继，需记录差异并重建时序，不能伪称 RED。获批实现后的同形 fixture 断言 receipt=1、新业务 run=1、wake=1，run.agentId 为原 owner 且 run.id != repairRunId，receipt/run 一一对应，action 只在允许结算时有一条结果；多次回调和请求后这些计数不增，外部 push 计数保持种子值=1，review/attempt 不变。不能把再次 repair 或 route 200 当 GREEN。
2. 已存在后继（queued/running/scheduled/deferred wake）时重复、并发、重启均复用同一 receipt/run。分别覆盖非同 action 的合法业务路径，防止误报无后继。
3. 仅当前 repair 正在收尾、请求 coalesced 回自己：收尾前无新并行 provider；持久 terminal 后产生合法新槽位，不能把 terminal repair 当成业务后继。
4. 未知副作用、仅 succeeded、缺 durable settlement、未完成 workspace export/hold：零新 provider，保留全部证据与 hold。
5. pending human_only confirmation、审批、review participant、changesRequestedCount=3 人类门禁：零作者后继，问题、responsibleUserId、阶段、decisions 与计数逐字段相等。
6. owner/action/run/company/fingerprint/statusVersion/workspace binding 不匹配：返回 stale/denied，零状态改写和外部副作用。
7. Stop/pause、预算或权限撤销分别与预留、commit 后 dispatch 竞争：只有先获有效权限的一方可执行；Stop 获胜后零 provider。依赖解除本身不绕过人类等待。
8. commit 前崩溃全部回滚；commit 后通知前崩溃通过 durable receipt 重放投递；通知失败、重复 delivery、进程重启均不新增槽位或外部动作。
9. 保留历史 action attempts=1/2；重复回读不加额度、不升级为源码普通 ceiling=5；repair 与 infrastructure retry 和 review 次数独立保留。
10. 合法恢复阻塞独占时，状态转换与 receipt 同事务提交；独立人工 blocked、审核 participant 或新 owner 存在时不改 todo。压缩/保留策略重读同一 action 时，已消费 key 仍阻止第二次准入；等待解除与版本变化有原生决定和审计，任意旧请求仍 stale。
11. 无配置、配置但 idle、只保留 completed history 时无新增周期 SQL/network；真实完成事件重新激活一次，结算后安静。该结果不能代替真实宿主休眠验证。

每个用例核对持久 issue/action/run/wake/receipt、owner 和完整 review state，以及 provider/外部动作计数；真实数据库覆盖并发和事务回滚，不能仅用 helper mock。未来实现先跑最窄相关测试并设整体时限，再依仓库 PR-ready 要求完成 typecheck/test/build 与映射检查；超时或缺依赖如实记录，交 CI/原生等待，不在 run 内轮询。

本方案交付验收须具备：同仓 Draft PR、远端 base/head 完整 SHA、仓库方案内容与 plan 精确 revision、一致的源码引用与实际文档检查、自审和原生跨类型独立审核。这些是文档阶段的验收，不表示上述未来隔离测试已执行。审核与 Board 实施批准是后续独立门禁。

## 替代方案

- 删除旧 resolve 的 board 守卫：拒绝。它同时防止 stale owner、终态重开和越过人类等待。
- 人工清 action/hold、改派或重建任务再唤醒：拒绝。丢失历史、重复副作用并扩大运维权限。
- 自动重复同一个 repair 或把成功 run 标为无副作用失败：拒绝。不能证明剩余工作完成，且混淆已执行事实。
- 仅增加 UI Retry 按钮或提示原作者继续：拒绝。缺口在原生持久结算和准入，提示词不提供唯一性。
- 保持现状并由 Board 对每例决定：可作为未实施时的等待策略，保留 ops 责任与证据，不声称已恢复。推荐方案需 Board 明确批准后才进入实现。

## 回滚、交付与后续授权

文档 PR 可关闭或回退，不影响生产。未来代码 rollout 独立授权；关闭新 admission 可阻止新后继，但保留已完成 settlement/receipt 与审计，不删除历史或回滚真实外部 commit。已入队未运行的工作继续服从 Stop/dispatch gates；已经执行的后继先由既有停止/结算流程处理，不能把它当作未执行后重复启动。

文档按精确 PR head 与方案 revision 接受跨类型独立审核；审核通过后，Board 针对该版本决定是否实施。方案审核、PR 合并和实施授权是三个不同事实。未获批准不创建实现任务，不调用源任务恢复；未来生产操作还需独立授权。未合并 PR 与未关闭 Issue 不视作最终交付完成。

## Out of Scope

本轮不实现源码、schema 或迁移，不运行生产恢复、重启或部署，不增加 scheduler，不修改 operator 白名单，不改派/重建源任务，不清 action/hold，不修改审核决定或计数，不重放任何业务 push/发布。

## 实施顺序与停止条件

获批实施后，先在隔离 fixture 验证基准失败形状及反例；随后实现 recovery 判定与同事务 receipt 预留、queue 的单次 run 附着及完成/启动恢复接线；再证明并发、崩溃和 dispatch gate，最后完成迁移检查、合同/文档同步、独立审核与另行授权的 rollout。若基准 RED 无法重建、现有 queue 不能接续预留 receipt、runId 无法单次附着、拒绝/等待不能持久保留，或启动恢复不满足一次性重建，则回到方案修订，不标记代码 ready，也不进入生产试验。

已核对 `doc/GOAL.md`、`doc/PRODUCT.md`、`doc/SPEC-implementation.md` 的任务归属、恢复、审批和预算合同，`doc/DEVELOPING.md` 的 heartbeat 模块归属与验证流程，`doc/DATABASE.md` 的 PostgreSQL/迁移合同，以及 `doc/execution-semantics.md` 的既有 hand-back 与 deliberate-wait 语义。本提议延续这些约束。上述历史 case ID 只用于精确回归映射，不是恢复授权或当前状态声明。
