# 将上游 master 6dcf4160dd 合入 fork develop 的方案

日期：2026-10-30。需求与验收：[Issue #242](https://github.com/phenix3443/paperclip/issues/242)。
本文件是待独立审核的方案，不是合并代码、迁移数据库或部署的执行记录。
只通过文档 PR 合入 `develop`；方案获批、PR 合并且 #242 关闭后，后续实现任务才能开始。

## 问题与范围

Paperclip 管理公司内的任务、运行、审核与交付。自动同步报告 52 个冲突文件，涉及相同持久化记录的多个消费者。
整体接受任一侧会丢失 fork 修复或上游新增的事件驱动恢复。此次集成必须保留两侧行为、公司隔离、审核门禁和已有历史。

本轮只定义处理与验收，不解决运行代码冲突，不生成或执行迁移，不发布 payload，不重启服务。
不新增功能，不借合并重构模块，不改变停止、预算、审批或默认三轮审核语义；已有功能即使历史标题为 feat 也不能借机删除。
对历史 fork 功能的去留另行决定，本次集成保留已合入的行为。后续发现无法同时成立的语义冲突时交 CTO 决定，不能自行弱化门禁。

使用者需要：

1. 实现者能按固定输入复现冲突，知道每个 Module 的责任和测试 Seam。
2. 评审者能从原修复、最终差异和回归证据确认两侧行为仍成立。
3. 运维能从旧数据库试迁移证据判断是否部署，并在失败时恢复匹配的代码、数据和密钥。
4. 当前任务的独立评审者只批准明确文档 SHA，后续代码和发布各自审核，不能复用本轮批准。

## 固定版本与已核实事实

| 角色 | 完整 SHA |
| --- | --- |
| fork develop，方案分析基线 D | `ef5f04157907ecf96a7698afb4daac3aee899b64` |
| fork master / 固定上游输入 S | `6dcf4160dd56d05795143a38bc2348e826dda12f` |
| merge base B | `70c864633744cd96c0dc7394d631fc7119cd17d2` |

本轮用宿主 Git 获取 origin 的 master/develop，用 `git merge-base D S` 和
`git merge-tree --write-tree --name-only D S` 分析。后者退出 1 表示存在冲突，列出恰好 52 个路径；没有 checkout 或执行实际 merge。
临时冲突树为 `13580e3062eb7dc21ec0a3a8c1200330b473a12f`，只是诊断对象，不是候选交付 commit。
52 是冲突文件数，不是冲突块数或最终修改文件数。自动合并路径也需审阅，尤其新提取的消费者、client.ts、CI 和生命周期注册。

实现开工时记录实际最新 develop D2、方案合并 SHA 和固定 S。D2 必须包含获批方案；执行分支从 D2 开始，S 不随 master 漂移。
重跑 merge-base、冲突清单、迁移映射和 fork 修复清单；文档合并造成的 D2 变化可按差异说明，若新增运行代码、迁移或语义冲突，先补充方案并重新审核。
不移动当前方案任务分支；实现使用其原生任务分配的隔离 worktree。不得在 canonical checkout 合并。

## 处理原则与实施顺序

保留上游的 Module 划分，按其 Interface 接入 fork 保证。Seam 优先使用真实 route、assembled heartbeat、数据库迁移入口；
imports 的并集只是起点，必须审查新消费者中的查询、写入和事务责任。Adapter 不另建审核或授权策略。
`ordinaryWakeRequestPredicate` / `ordinaryWakeRunPredicate` 隔离普通回执和 reviewer intent；
上游提取了函数时，将必要隔离移到新的实际查询拥有者，不能仅保留失去用途的 import。

1. 先检查两侧全量差异、历史修复和迁移身份，保存 manifest。
2. 合并固定 S，先完成 SQL 改名、journal/snapshot 与 client 文件名集合，再处理调度与身份。
3. 接着处理审核、审批、恢复、评论与聊天；通知必须在同一事务中先注册再写入，不增设常驻轮询。
4. 最后处理 UI、工作流、文档和夹具，检查所有自动合并路径；每个额外适配用单独说明的 commit。
5. 定向测试、完整远端 CI、独立代码审核；冲突解决必须保留 merge commit 的 S 祖先，不能 squash 成失去迁移来源证明的单父实现提交。
6. 审核后按获批 head 合入 develop，再由 CTO 安排 ops 的备份、试迁移、发布和独立验收。

下表覆盖默认 merge-tree 的全部 52 个冲突路径。路径均相对仓库根目录。
“保留”要求两侧契约同时成立；各组验收见后面的回归矩阵。

## 52 个冲突的分系统处理

### CI 与文档（3）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 01 | `.github/workflows/pr.yml` | 保留 fork 本地 `./.github/workflows/pr-trusted.yml`，执行当前候选代码的 fork 检查；加入上游 `full-ci` labeled 触发条件并保留 profile-ci。不能直接调用 upstream master 的浮动工作流而漏掉 fork server-source 检查。 |
| 02 | `.github/workflows/refresh-lockfile.yml` | 合并 develop push 与上游 schedule、release-age、报告锁、held artifact；保留按 base 分开的分支和显式 `--base`。上游 bot token/`--admin` 合并路径不能作用于 develop，也不在本任务新增凭据/绕过者；master 专用路径须沿用实际授权，缺少 app 配置时只产出 PR、停止自动合并。 |
| 03 | `doc/DEVELOPING.md` | 保留 managed Git package assets、child stdin error 文档，同时加入上游 Cloud startup configuration；更新调度提取与 CI 说明到实际实现。 |

### 数据库（5）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 04 | `packages/db/src/migrations/meta/0390_snapshot.json` | 接受其被后续快照替代，不恢复旧 snapshot；具体保留集见迁移节。 |
| 05 | `packages/db/src/migrations/meta/0399_snapshot.json` | 提取 fork schema delta 后由合并态 0421 snapshot 替代，不把旧 0399 直接改名充当最终 schema。 |
| 06 | `packages/db/src/migrations/meta/0412_snapshot.json` | snapshot rename/delete 识别不构成业务迁移；最终它不在最新五个集合内，删除。 |
| 07 | `packages/db/src/migrations/meta/_journal.json` | 使用上游原历史，追加 fork 0417–0421；原 when/SQL 哈希保留，见精确表。 |
| 08 | `packages/db/src/schema/issue_comments.ts` | 合并 import，保留 fork agent clientRequestId 唯一索引及上游字段/索引；保留 uniqueIndex，不能因上游删 import 而删约束。 |

### 调度、身份与进程生命周期（15）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 09 | `server/src/__tests__/heartbeat-dependency-scheduling.test.ts` | 上游 external DB 支持与 fork continuationCwd 初始化同时保留；finally 清理只清理本夹具。 |
| 10 | `server/src/__tests__/heartbeat-task-drain-admission-release.test.ts` | 保留 issueComments、issueThreadInteractions、plugins 并集和所有断言；不能只修 import 后跳过用例。 |
| 11 | `server/src/index.ts` | 合并 captureSystemdNotifySocket、adapter/Cloud 初始化和上游 worker 注册/stop；匹配新 worker handle，保留有界 shutdown 与 pending settlement，不再调用已被提取/删除的 unsubscribe。 |
| 12 | `server/src/modules/active-run-watchdog/adapters/postgres.ts` | 普通回执隔离与上游 delivery/native/external 通知都保留；watchdog 不得领取/取消 reviewer intent。 |
| 13 | `server/src/modules/external-agents/muse.ts` | 保留普通回执谓词与新 Muse terminal settlement condition，核对实际查询仍使用二者的适用条件。 |
| 14 | `server/src/modules/run-dispatch/adapters/postgres.ts` | 保留 fork authorizationService、review addressee admission、普通回执隔离；合入 workspace recovery、queued comment IDs、pre-dispatch wait 验证和通知。不得扩大代理权限。 |
| 15 | `server/src/modules/wake-queue/adapters/postgres.ts` | 普通队列继续排除 reviewer namespace，接入上游 external/native/chat 通知；保留 pending interaction / explicit blocker 等待，不错误升级。 |
| 16 | `server/src/modules/wake-queue/adapters/queued-comment-postgres.ts` | 同时保留 namespace、coalesced inline input 与上游 queued comment context/通知；一个 comment 对应一个原有身份，不丢输入或重复唤醒。 |
| 17 | `server/src/services/heartbeat.ts` | 保留 fork `runIdentityInitializationInput`，外包上游 timePreparation；将 queuedCommentIds 等上游输入适配进该 Interface，不能丢 inline provenance。合入新恢复 worker 注册，不搬回 coordinator。 |
| 18 | `server/src/services/heartbeat/agent-status.ts` | 状态刷新同时保留普通回执隔离与 agentTimers 通知，评审等待不被普通队列误判为活跃工作。 |
| 19 | `server/src/services/heartbeat/queue.ts` | 保留 dependencyAdmission 唯一持久责任人、blocked-cycle key、monitor 原子 consume、review identity settle、reconciliation revalidate 与上游事务通知；恢复已有 dispatch receipt 不重复创建 run。各路径在同一写事务注册通知，不能按文本拼接生成两套候选/恢复逻辑。 |
| 20 | `server/src/services/heartbeat/recovery.ts` | 采用上游 scheduledRetryCancellation owner 与 skip 选项，移除被替代的重复扫描；fork `replayPendingShutdownSettlements` 义务继续由原有恢复路径承担。测试 restart/取消竞争，不能为了保留义务恢复空闲轮询。 |
| 21 | `server/src/services/heartbeat/run-control.ts` | 采用上游事务+returning 的实际取消计数，查询与最终 CAS 都加普通回执隔离，保留 notifyChatInboundWakeNotices；并发已领取或绑定 run 的回执不能被误取消。 |
| 22 | `server/src/services/heartbeat/run-lifecycle.ts` | 上游行锁/事务/通知与 fork `status != cancelled`、普通回执谓词共同成立；late settlement 不复活撤销权限，停止与环境 lease 结算保持独立。 |
| 23 | `server/src/services/heartbeat/scheduling.ts` | 合并 nextTimerHeartbeatAt、新 getSchedulingSuppression(fresh?) 与 fork enqueueMonitorWakeup / monitor retry；原子 monitor admission 已 consume 时不得再二次 UPDATE，非原子路径保留上游 issueMonitors 事务通知。 |

### 审核、审批、任务与恢复（15）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 24 | `server/src/__tests__/approvals-service.test.ts` | approvals/companies/issueApprovals 与 installDatabaseWorkSignals 全保留；使用同一事务对象并等待外层 commit。 |
| 25 | `server/src/routes/issues.ts` | 保留普通回执隔离；上游 board clientRequestId receipt recovery 在授权后幂等完成引用/活动/外部同步；fork 跨任务 continuation 分类先于 closed workspace reopen，不能把已接受 receipt 再次执行为新工作。 |
| 26 | `server/src/services/approvals.ts` | requestRevision/resubmit 保留 lockIssuesLinkedToApproval 和上游 `{approvalId}` 通知范围；同一 writeApprovalChange 事务锁任务后更新，门禁改变不得与 admission 交错。 |
| 27 | `server/src/services/companies.ts` | 普通回执隔离、retireReviewerIntents、reconciliation authority lock 与上游通知并存；公司取消/停用撤销真实权限，不能跨公司清理。 |
| 28 | `server/src/services/issue-approvals.ts` | 保留 fork insertIssueApprovalLinks 的锁序和去重；在上游 writeApprovalChange 传 `{issueIds}`，外层 rollback 不派发。 |
| 29 | `server/src/services/issue-recovery-actions.ts` | 保留 crossTaskContinuations 队列通知及上游 native recovery/export 通知；exhaust/resolve/rebind 的所有分支都须保留各自触发，owner repair 仅在执行真正释放后结算。 |
| 30 | `server/src/services/issue-tree-control.ts` | 普通回执过滤同时用于 select/update/returning；保留上游事务 chat 通知与 fork reviewer 退役路径。子树 Stop 后不得从另一队列补启动。 |
| 31 | `server/src/services/issues.ts` | fork quota monitor installation、executionContinuation 通知与上游 agentTimers 通知分别按各自条件执行，不能以一个 if/else 替代另一条件；保留追加 review stage、blocked hold、returnAssignee 和全部 decisions。 |
| 32 | `server/src/services/native-runtime/native-review-dispatch.ts` | 保留 namespace fence 和上游 chat milestone 通知；原生 review 使用专用 intent，普通消费者不得代领。 |
| 33 | `server/src/services/native-runtime/native-safe-replacement.ts` | 保留 namespace 与 status/export 通知，替换前验证 owner/lease，不因终态结果推断资源已释放。 |
| 34 | `server/src/services/native-runtime/native-workspace-reconstruction.ts` | 普通回执隔离与 delivery/export 通知并存；保留 admitted workspace contract，不按新配置重新解释旧运行。 |
| 35 | `server/src/services/native-runtime/paperclip-runner-tool-authority.ts` | 同时保留 namespace 与 requiredQualityReviewSchema；工具权限继续由当前公司、run、responsibleUserId 和授权来源决定。 |
| 36 | `server/src/services/native-runtime/status-decision-committer.ts` | 合并 fork namespace 和上游 assessment/completion/finalization 锁、ownership 检查及通知；状态提交不得跳过保存义务或替代独立审核。 |
| 37 | `server/src/services/preserved-result-finalization.ts` | 普通回执谓词与 nativeFinalizationWork 通知并存；已接受结果仅补保存/清理，不重跑 provider。 |
| 38 | `server/src/services/recovery/service.ts` | 保留 ReviewQuotaMonitorHeld，合入上游 boundRunIssueId 和持久 adapter failure classification；classifiedParticipantRun 与新持久分类只做一次有效归类，不覆盖审核参与者身份或计数。 |

### 评论、聊天与工具（12）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 39 | `server/src/services/agent-conversations.ts` | 普通回执隔离和 delivery/export 通知并存，保持 conversation owner/终态结算。 |
| 40 | `server/src/services/chat-channels/failed-run-retry.ts` | 采用上游 createFailedRetryNotices 提取；将 fork ordinary predicate 移入其真实查询，保留 projectSafeChatPublication 与 own execution release marker 在仍需的调用；不并列保留两套 notice 扫描。 |
| 41 | `server/src/services/chat-channels/inbound/wakeups.ts` | 普通回执隔离与 chat inbound 通知共同保留，供应商输入不绕过共享授权。 |
| 42 | `server/src/services/chat-channels/interactions/continuations.ts` | 保留 namespace，采用上游 scoped deadline/coordinator；interaction addressee 的回复只能唤醒获授权参与者，不把等待当审核通过。 |
| 43 | `server/src/services/chat-channels/slack/session-stop.ts` | Slack stop 继续排除 reviewer intent；上游 chat notice 注册在实际写事务中。 |
| 44 | `server/src/services/chat-run-publications.ts` | 保留普通回执隔离，采用上游 publication policy、projection window、native progress；保留 safe publication 去重，不泄漏私有输入。 |
| 45 | `server/src/services/question-response-delivery.ts` | namespace 与 chat milestone 通知都保留，回答来源、目标 interaction 和公司绑定不变。 |
| 46 | `server/src/services/slack-conversation-lifecycle.ts` | 采用上游 readSettlement 提取，把 fork ordinary predicate 落在 readSettlement 实际查询；保留 endpoint→task 锁序、已发布响应、native committed finalization、无新输入/未完成会话/门禁的全部条件。 |
| 47 | `server/src/services/slack-conversation-state.ts` | 普通回执隔离和 delivery/external settlement 通知并存，不把传输结果当执行权限。 |
| 48 | `server/src/services/task-interruption-presentation.ts` | 合并 isNull 和普通回执谓词，保留 Stop/预计取消呈现，不错误发布 reviewer intent 的中断。 |
| 49 | `server/src/services/task-retry.ts` | fork 普通回执+deferred CAS 与上游 write(tx)/外部会话通知合成同一路径；max-turn continuation 已提交时复用，不因其锁再次拒绝或重发。 |
| 50 | `server/src/services/tool-gateway.ts` | 使用 insertIssueApprovalLinks 锁序，加上游 `{issueIds}` 通知参数；保留 delegate 工具发现权限和按 token 暴露 capability，不扩大审批权限。 |

### UI 列表（2）

| 编号 | 文件 | 决议 |
| --- | --- | --- |
| 51 | `ui/src/components/IssuesList.tsx` | 先从 savedViewState+routineTasksOnly 得到上游有效 viewState，再由该值派生 statusFilter 并触发 fork onStatusFilterChange；保留 blocked inbox Responsible/Project/Workspace、子任务、列显隐和 tooltip。 |
| 52 | `ui/src/components/LegacyIssuesList.tsx` | 与新列表保持同一过滤契约；不删 legacy 回归。routine URL 覆盖仅作用于 Tasks，其余集合继续保存设置。 |

## fork 修复保留与回归矩阵

下列来源是 D 的真实提交/PR，不以题目中的 fix/feat 判断是否保留。实现者在 PR 附“来源→最终路径→测试结果”，
全量比较 `git diff B D` 和 `git diff D2 HEAD`；此表列出重点保证，不能把表外的自动合并内容视为获准删除。
只有证明上游包含相同保证且相关回归通过，才能删除重复实现，并解释替代位置。

| 来源（短 SHA / fork PR） | 必须保留的可观察行为 | 测试入口或证据 |
| --- | --- | --- |
| ef5f041579 #174、6cda8f0c46、a3e51336ea #219、d4e335a89d #211 | 每个 blocked cycle 的依赖唤醒只有一个持久 admission owner；执行/cleanup 释放后补发一次；restart 恢复 receipt，不额外建 run | heartbeat-dependency-scheduling、heartbeat-dependency-crash、native-dependency-wake-cycles、heartbeat-task-drain-admission-release |
| ef5a32b032 #168、53eee6a8d8 #153、85851e9bf3 #143、5a627cd5c3 #137、de749e29d6 #154 | reviewer intent 不混入普通回执；事务内消费/退役；保留原 action 权限，永久取消不复活 | heartbeat-reviewer-intent-{consumer,transactions,retirement,capacity}、heartbeat-reviewer-identity-admission、reviewer-continuation-evidence |
| fdf8f24f75 #232、19e5dde47c #57、b6eb9ad8cb #51、5860ae8d03 #123、76b124702f #129、a87e288a86 #225、cde5bbe2b4 #151 | pending interaction addressee 能在 review 接续；显式 blocker/Board hold 不升级或清空评审；完成后追加 stage 仍运行；返修改派同步 returnAssignee | interaction-addressee-review-dispatch-postgres、issue-review-hold-routes、issue-review-policy、issue-stalled-review-decision-routes、decided-review-reassignment |
| 8f036b0316 #227、41dcd690e1 #213、df7e23e51d #52 | coalesced 评论保留完整输入和身份；已提交 max-turn retry 不重发；同任务回入按目标上下文授权 | heartbeat-queued-comment-inline、issue-queued-comments-routes、run-identity、task-retry、chat-failed-run-retry-boundary |
| b011dfde0f #172、a07b4311a0 #109、ec7c991015 | accounting 通知仅在最外层 commit 后；workspace session 复用 admission tx；审批/链接变更锁住任务，阻止竞争 admission | approvals-service、approval-routes-idempotency、heartbeat admission-pool、db work-signals 测试及对应 accounting 测试 |
| 81cb1b201b #81、773d1cc4ed #69、6d74176932 #50、8a5465c402 #26、752ef59498 | recovery admission 锁/expected snapshot/decision/hash/公司/owner 重新校验；target-bound successor 仅在自己的 run reopen；确认 Stop 后允许明确取消；资源释放后才恢复 | issue-recovery-actions、legacy-workspace-restore-recovery、heartbeat-process-recovery、execution-control-work |
| 2cb165cfd7、ef2f4565b4、5c487108d5、447204a39d #16、9b6e7c9fc4 #43、ec471de0ee #23 | expiration 硬预算、child Git drain、SSH/HTTPS 身份、端口区分、pending_cleanup lease 结算 | git-workspace-expiration / restoration / heartbeat cleanup 相关现有测试；不改其预算以消除失败 |
| 63dfd8b491 #28、94d523ac7b #18、e14463c448 #21、2998d573ca #32 | 有界 shutdown；reused PID/PGID 和未启动 legacy run 的 Stop 证据；无 termination receipt 时不伪造确认 | shutdown、shutdown-budget、shutdown-http-admission、heartbeat-process-recovery |
| a5d02e09b9 #46、2377075fc9 #30、a68841ee82 #45、d718a61f93 #166、d19a8ea895 #128 | delegated run 工具发现；token capability 限制；连接 ready/策略写入唤醒；已满足 access request 退役 | tool-gateway-service、tool-gateway-discovery-http、连接 policy / access request 对应测试 |
| #192/#194/#199/#201/#223、#197/#203/#205/#207/#209/#217/#221 | stalled chain 的 private/external/stopped/addressee 责任人准确；列、分组、父子层次、状态、hover 和 toggle 保留 | IssuesList.test.tsx 与 blocked inbox/attention 相关测试；浏览器矩阵见下文 |
| #34/#41/#44/#181/#188/#200、5951299269、46f8ebd099、24059589dd #10 | CI payload、server source/test 分项目 typecheck、build gap、staging UI 和 managed assets；child stdin 错误不终止服务 | CI job 与产物 manifest；adapter-utils server-utils；managed package 相关现有测试 |

## 数据库：编号、SQL 身份与 metadata 链

上游 S 最高 idx/编号为 0416；fork 独有的五份 SQL 当前编号 0395–0399。
不能只处理 Git 冲突：五个同号不同名 SQL 会自动并存却违反迁移编号约束。
上游历史 SQL 与 journal 条目保持原样；fork 按原相对顺序 `git mv` 到 0417–0421，连空白、换行、statement-breakpoint 都不改。

### fork 精确映射

| 当前 SQL | 新 SQL | SHA-256（原字节不变） | journal when（保留） |
| --- | --- | --- | --- |
| `0395_aromatic_loki.sql` | `0417_aromatic_loki.sql` | `f7f8da4d04b7b2c6d87b1d8b31f438a27715727e19eab7d6b1252ff30f892f87` | 1792809786245 |
| `0396_melted_hydra.sql` | `0418_melted_hydra.sql` | `8ce631d5c1dda67a32135ed4ca4c38aee1ba82b470e69f79f755f10edeb17c3a` | 1793109921370 |
| `0397_purple_sue_storm.sql` | `0419_purple_sue_storm.sql` | `44ab97136e6634ac9e9be9a9f7ec5bf7c8bf20566271dddbcf01e329aeb163f7` | 1793124505405 |
| `0398_young_garia.sql` | `0420_young_garia.sql` | `17debea737c743049555aa56a5ba2189e624a143c09ec5260bb3508a2ef473bd` | 1793130317685 |
| `0399_messy_chimera.sql` | `0421_messy_chimera.sql` | `30dea19f19e0c7a00b8c8d44957a2638db45f6d6421e9c0cb2276ccd1c3c3cd1` | 1793154577343 |

同步改 `packages/db/src/client.ts` 的 `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` 三项：
0395→0417、0398→0420、0399→0421，其余上游 concurrent 项全保留。
遗漏会让 `CREATE INDEX CONCURRENTLY` 进入事务，fresh install 失败；必须同时测试 invalid index 的恢复。
更新所有按旧文件名读取的测试/fixture（当前 `packages/db/src/client.test.ts` 已有五项硬编码），旧历史的 hash/when 不改。

### 上游新增 SQL manifest

下列 22 项在 S 取 SHA-256；实现时全部逐字节对比 S，不改名、不改 SQL。此表连同 fork 五项共 27 个不同哈希。

| 上游 SQL | SHA-256 |
| --- | --- |
| `0395_tranquil_firestar.sql` | `b575a422e1b350ab6851c17134f3e841e3906a7193767efd3c9e76b662c54204` |
| `0396_tan_paladin.sql` | `e2ded975c2f745715dc7d5f4ae985412bbb06d45f2ef339d2c939e0146cd8b7c` |
| `0397_known_madrox.sql` | `d5d4fa67d8255447f2d2d94b513e5ffb99c4987e0ca31d2b704d0ceb4a9ee811` |
| `0398_yielding_random.sql` | `249a0611b1597a2180603cba73e64a418cb1ecb0d50596b4c6c819b7d6986e5f` |
| `0399_ambitious_onslaught.sql` | `ad80d7544180745d43d64370b9fd45f14c7e66d4b7e9933c23ce0ce157f4e506` |
| `0400_absent_phantom_reporter.sql` | `429618800711d65eebd45911d439e02d9eaac970e63b5f483882eb6e432403cd` |
| `0401_yummy_ultimates.sql` | `60d5b508283bab4bdba8241c140975977763ccdf2a6a33ac1ef389b46b9c9b9d` |
| `0402_ancient_malice.sql` | `492e0c2c5ad7feb73620511d8c362ddc19dcbddb6bea0a7a959548b63142793a` |
| `0403_natural_cerise.sql` | `4c7d7358e0bf71b092c5eeb150fd1381bc5e5ac0a4d27bc5ca1fb4e6abfa6ea8` |
| `0404_tense_silver_sable.sql` | `00152905013958644985c10f77f39737dac63af8410e97df46d9c3557ab27777` |
| `0405_harsh_avengers.sql` | `f5d572832f396d636757cea2981d05dca6703e22bc0fef0f46657cd6ecd62e3d` |
| `0406_zippy_war_machine.sql` | `fcc031b03501e39fe9dfce486f24c6bc07af20a678cb563d16132dd8ff1684e1` |
| `0407_greedy_star_brand.sql` | `d38c20a5225cb15cb0716db8c62eb709ad12f18d59a3fd3c4d711597b9501a8c` |
| `0408_short_red_skull.sql` | `1fd80331c4dee1683b298521690b5aa27c1ad5cf5ef77358b3c4ad8819ea2949` |
| `0409_uneven_zuras.sql` | `f475429affd5f208cdfae5856a72567badaf726315aa4c23e7eb9d4f89b7d469` |
| `0410_freezing_kinsey_walden.sql` | `b400773767be261270d9ff1bf00cfeea767fb90a56bce2f39ffbf3258525e967` |
| `0411_real_scrambler.sql` | `bfd76ca8c38cddc427ab8c1f3a30ac113ca59e04c934a34137fe8697dfb9a622` |
| `0412_tearful_squadron_supreme.sql` | `b4904e217f672b8fb030b57cfc22c0c9b15861136dec7a6f0852df0d8a920d09` |
| `0413_tired_kronos.sql` | `08cde7fe620ba83045065c86bac93618a5eef26606f44d5ffbfebcd3a435cb9c` |
| `0414_closed_edwin_jarvis.sql` | `dcdcb9562e4f6602776fd23245b6891014343d52604b25c003658ae364578f05` |
| `0415_zippy_zemo.sql` | `796077754ab08208b83a497934adfa580c6ba1d8f7e61b46d4cb74fef534064e` |
| `0416_salty_domino.sql` | `ed2ae0b4a9b58e200abec2dd8448d7bd187d64d7a31f69fb156ca494a3bd5fd6` |

### journal 与 snapshot

- 取 S 的完整 `_journal.json`，保持所有既有条目和历史 idx 缺口，追加 idx 417–421；tag 为新名，version="7"、breakpoints=true、when 用上表原值。
  D 有 398 条、S 有 415 条，合并后应有 420 条，不能把“末 idx+1”当 entry 数量，也不能填补历史缺口或按 when 重新排序。
- 用 B 的 `0394_snapshot.json`、D 的 `0399_snapshot.json`、S 的 `0416_snapshot.json` 做递归三方 schema 合并，排除顶层 id/prevId；同 key 两侧不兼容修改必须停止，不任取一侧。
  本轮内存试算零 key 冲突：302 / 304 / 305 张表合成 307 张。只是 JSON 可合并证据，不是 SQL 已执行证明。
- 新最终文件为 `0421_snapshot.json`，包含 upstream schema 与 fork 两表 `execution_reconciliation_receipts`、`issue_document_decisions`、companies authority、authorization_evidence 及 fork 唯一/等待索引。
  新 snapshot 使用新 UUID，prevId=`bbaeecd8-ff3f-4e70-a069-291bf3dc97bb`（S 0416 id）。不要复用旧 fork snapshot id 或将它只改 prevId。
- 最终仅留 `0413_snapshot.json`、`0414_snapshot.json`、`0415_snapshot.json`、`0416_snapshot.json`、`0421_snapshot.json`。
  0413–0416 原字节和 ID 全保留，链为 0413 `5690a14a-f9cc-41a6-af51-c27f688f4ef6` → 0414 `27c9008c-60e3-449b-9630-9e4977fad444` → 0415 `dce41524-29a3-4552-ba5d-f0abefbf1ea1` → 0416 → 新 0421。
  0413 的 prevId 仍是已剪枝 0412 的 `3b8bb508-028d-4154-abdd-af870f1f3ca6`；剪枝不改历史链。
- 运行既有 prune:snapshots，删除多余 snapshot，绝不删 SQL 或 journal 历史。无需给 SQL-only 的 0417–0420 发明 snapshot。
  metadata 重建沿用 #96 已有受审三方 JSON 方法，不在宿主运行 db:generate（它编译 db）；普通新增 schema 仍走仓库生成流程，在 CI 完成。
- CI 执行 check:migrations、snapshot drift、全新库建库与历史升级。schema diff 必须为空；出现生成 DDL 差异先修 metadata/契约，不能用新空迁移掩盖。

### 已执行迁移如何识别，以及停止条件

实际入口是 `packages/db/src/client.ts` 的 inspectMigrations/applyPendingMigrations。
标准 Drizzle history 是 `(id,hash,created_at)`，旧 fork SQL 的 hash 映射到新名即可认定已执行。
不能只比较最新 created_at：这会漏掉夹在历史中的上游迁移。
manual apply 按 journal idx 排序，新记录时间使用 max(latest+1,when)；保留旧 when 不意味着重排现存数据库历史。

`loadAppliedMigrations` 遇到 name 列先按 name；name+hash 的旧名可能 guard 跳过 SQL 却始终 pending，name-only 可能重放 SQL。
因此实际库存在任何 name 列、未知 hash、重复身份、缺失/invalid index 或不能解释的 schema 漂移，都暂停发布交 ops/CTO，不能直接改生产 history 或伪造 receipt。
不得假定线上就是 D：ops 在发布前记录真实 served SHA、数据库版本、history 表形状及非敏感 hash/时间，核对需要哪些迁移。

验证升级的三个主要起点：

1. 空库：完整上游链后执行五份 fork SQL，最终 schema/约束/index 全部有效。
2. 真实 D 历史：重放 D 原 SQL/journal 建库，保留五个旧 hash，升级候选应只执行上游 0395–0416 共 22 份；旧 fork 五份 hash 各一条且无副作用重放。
3. 历史 fork 0372–0376 已执行，或只执行其前缀的旧库：沿用 client.test.ts 历史 schema replay 方法，不能在最终 schema 上伪造 history 冒充升级；升级仅执行真正缺失项。

每个起点 seed 两公司任务、评论/附件身份、审核 decisions、recovery/continuation receipts 和 delivery_unknown 聊天记录。
比较迁移前后保留列值、外键/索引、行数和回执；与 fresh 最终 schema 比较；再次 apply 必须零 pending、history 和业务行不变。
partial/unjournaled DDL 与 invalid concurrent index 沿用既有修复能力测试，不自动扩大 live 修复授权。
已读上游新增 SQL：0395/0414 为 activity 索引，0396 为 voice cleanup 字段/数据更新，0397–0403 为聊天恢复索引，0404/0405 为 preferences/interaction 幂等表，0406–0413 为运行/指令/发布恢复索引，0415 为 skill 包存储/删除队列，0416 重建取消工作区保留索引。
0413 和 fork 0420 同属 issue_comments 但索引名称与 predicate 不同，二者必须保留；heartbeat_runs 等共同引用也不能误判为重复迁移。
上游新增迁移触碰同表时按列、索引和数据 UPDATE predicate 核对顺序；真实旧库与 fresh schema 等价是放行门槛，不能仅凭对象名搜索声称安全。

## 验证计划与 CI 门槛

本轮文档检查仅证明冲突/manifest/方案覆盖，未执行 runtime 测试、试迁移或部署。
下列是实现阶段必须执行并附结果的检查，不能把命令列表写成已通过。

### 本地只跑受影响 Vitest

在实现任务 worktree 用 `timeout 600s pnpm exec vitest run <file...>`，按上面矩阵分批选择文件，记录命令、exit、用例数、耗时、源码 SHA 和失败日志。
需要依赖产物时仅用获准的 `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`。
不在宿主跑整包 tsc、typecheck、pnpm build、vite build，不增大 Node heap、不绕过 wrapper。
运行超过本轮余量的 DB 集成套件交 CI。fixtures 必须启用真实 Postgres，不把 root/平台限制导致的 skip 计作通过。

最小第一批为以下实际现存文件，随后按修改点扩展到矩阵中的 assembled regression：

```sh
timeout 600s pnpm exec vitest run server/src/__tests__/heartbeat-dependency-scheduling.test.ts server/src/__tests__/heartbeat-task-drain-admission-release.test.ts server/src/__tests__/native-dependency-wake-cycles.test.ts
timeout 600s pnpm exec vitest run server/src/__tests__/heartbeat-queued-comment-inline.test.ts server/src/__tests__/interaction-addressee-review-dispatch-postgres.test.ts server/src/__tests__/approvals-service.test.ts
timeout 600s pnpm exec vitest run packages/db/src/client.test.ts packages/db/src/migration-snapshot-drift.test.ts
```

审批测试额外覆盖外层 rollback/commit、跨公司拒绝、link 与 admission 并发；reviewer 测试覆盖 namespace 混合回执、reassignment、quota、追加 stage、第三轮门禁。
调度覆盖首次生产、并发、crash、drain/resume、restart、取消和无工作安静态，核对持久效果而非只断言通知调用。
上游新增/提取 Module 的对应现有测试保留，不能因未出现在 52 个冲突中而遗漏。

### GitHub CI

1. fork PR 运行本地 reusable workflow；保留 #181/#188 server source/test project typecheck、缓存正确性和 build-gaps，不能回退为只检查 release registry。
2. 集成 PR 用 `full-ci` 请求全量测试、typecheck、build；核对 routing/plan 的实际 forceReason、job 日志和执行范围。
   PR caller 的 labeled 条件、ci-routing、相关选择脚本一起适配。不能标签存在而 gate 仍降级成文档/affected-only。
   缺失、skipped、cancelled、过期 SHA 的结果都不算全量证明。
3. 在 GitHub runner 执行仓库完整 `pnpm -r typecheck`、`pnpm test:run`、`pnpm build` 或逐项覆盖它们全部范围的现有完整 lanes，记录 workflow/run/job URL 与 head SHA。
   另保留 migration-order、SQL safety、snapshot drift、token gates、映射检查和必要的 built-runtime 校验。
4. 迁移顺序使用 `.github/scripts/check-pr-migration-order.mjs <D2> <head> <CI可信master>`；完整 history 证明 S 是实际 merge parent，新增上游 SQL blob 等于该 parent，fork 0417–0421 在其后。
   不扩宽 trusted 豁免，不关闭 migration gate，不用 PR 自报 trusted SHA。即使 origin master 后移，也必须证明固定 S 祖先与 SQL 身份。
5. 自动合并 `pr-trusted.yml`、ci-routing、setup actions、scripts/ci、tsconfigs、package scripts 都做语义复核。
   新 test selection/cache fallback 不得让旧 fork regressions 被漏选；此次 full-ci 使用全量 fallback。
6. refresh-lockfile 保留上游供应链 release-age/报告校验能力，但 develop 仍只开 PR，由正常独立评审合并；不能新增 bypass actor 或因为缺 secret 放宽规则。
   generated PR 正文/模板也不能新增工具署名。锁文件不手改；需要更新依赖时用原工作流另开 PR，合并后重新验证当前候选。
7. 保留 deploy-packages 与 staging UI 工作流。方案文档 PR 的绿色检查仅是文档门槛；实现 PR 的绿色检查和 develop-push payload 是后续独立证据。

### UI 和浏览器验收

实现阶段只要改两个列表，就运行受影响 UI tests 和 `pnpm check:token-gates`。
通过 ai-team `scripts/paperclip/browser.sh` 在隔离测试后端验证 Tasks/Inbox（新/legacy 列表）、routine 链接与保存过滤、Clear/刷新/翻页、
Responsible 显隐和姓名 hover、external/private/stopped/addressee、父子任务、三个 grouping 维度与 outline toggle 状态。
桌面/手机 × 浅色/深色，保留检查脚本、report.json、console error 和截图，发布到关联任务可下载 artifact。
近期上游 Coordinator 紧凑加载/聊天历史分页不能被恢复旧列表破坏；按其现有 journey 和网络请求核对没有回退到全量加载。
浏览器套件只为此次 UI/集成风险 opt-in，不要求宿主跑整套 release smoke。桌面应用、真机或读屏才需要人操作。

## 发布前备份、试迁移与回滚门槛

发布责任是 CTO 安排的 ops；本方案不执行发布。运行依据为 ai-team
`docs/paperclip/patched-release.md`、`async-collaboration.md` 与当前 runbook。
历史 runbook 若仍写 mini/退役 operator 路径，以当前 netcup 部署源与角色授权为准，不恢复旧轮询或取 Board token。

### 发布前必须齐全的证据

- 方案 PR 已审核合并；实现 PR 独立跨类型审核获批 SHA H，当前 PR head=H。贡献者、每轮决定、默认 maxReviewRounds=3 及 responsibleUserId 保留；换 SHA 重审。
- 实现 PR 用保留祖先的 merge 方式合并，记录 merge SHA M（可以不同于 H）；不得 squash/rebase 丢掉 S 的实际合入祖先。方案文档 PR 可按仓库惯例 squash。完整 CI 明确覆盖 H/合并候选，部署包来自成功的 M develop-push。
- ops 记录线上旧 SHA P、保留 payload 与 rollback record、空闲磁盘（服务 home 和工作目录各至少 15 GiB）、drain 状态及真实 DB history。
  不清理他人 worktree、缓存或回执来凑空间；磁盘不足停止。
- 用原生 database backup 保存迁移前 SQL，记录路径、SHA-256、时间、数据库版本、可解压/可恢复结果，并按当前备份流程保存在独立加密备份目标。
  同时保存匹配配置、secret master key、agent homes/必要文件和安装 manifest；不要把秘密上传到公开 PR。
- 在隔离验证库恢复这份 SQL，用候选迁移入口试迁移，记录 before/pending/after、27 项 SQL manifest、约束/index、保留数据和幂等第二次 apply。
  禁止启动指向生产连接或具备真实外部发送能力的第二个 scheduler。试库名称/连接经过隔离核验，结束清理自建库与进程。
- 验证库启动候选 payload，通过两公司权限、评论上下文、依赖释放、reviewer 交接/返修、审批阻塞、Stop/恢复和列表 journey。
  代码回滚兼容性要用旧 P payload 在迁移后的副本读写实际核心流程验证；“新增列看似兼容”不是证据。
- 用完整 reviewed release tuple 绑定 repository=`phenix3443/paperclip`、M、workflowId、runId、artifactId、artifactDigest；
  `deploy.py --approved-sha M --release-input <immutable reviewed JSON> --check` 成功，记录 manifest、ZIP 和 package hashes。
  任一字段改变重新评审；--check 不等于发布批准。部署重复验证并按原流程备份、激活、`service restart --wait` 和 exact served commit 验证。

### 何时停、如何退

任何 hash/metadata/试迁移差异、name history、CI 缺项、未知权限扩大、drain/lease 不清楚、备份不可恢复、payload 来源不匹配，都停止激活，保留具体证据交 CTO/ops。
不改 SQL hash、history、review decisions 或预算来消除阻碍。

1. 激活前失败：保持旧服务与旧 rollback record，不触碰生产数据库；已完成备份继续保留。
2. 代码已切换但迁移未开始：由 ops 按记录运行 `deploy.py --rollback --check` 和 `--rollback`，核对 installed/served P 与 health。
3. 数据库已迁移：`deploy.py --rollback` 只退代码，不能逆转 SQL。只有旧 P 在迁移后副本通过兼容性验证时，才允许原生代码回滚保留新 schema。
4. 不兼容或迁移中断：停止新写入/运行派发，保留失败现场与失败后的另份备份，由 CTO 明确授权数据库恢复；ops 将迁移前 SQL、匹配 payload/config/master key 恢复为同一检查点。
   恢复会丢失检查点之后的数据，先列时间窗口、评论/决定/外部发送影响，不能静默丢弃或重放。原生恢复后核对 history、两公司数据、审核历史与外部 delivery_unknown，不盲目补发。
5. 发布后核对 `/api/health` exact commit=M（按当前身份可读字段）、实际 provider 一次成功、上述关键 journey 与无重复派发；失败交 ops，不能以 health=200 声称验收完成。
   需要跨小时观察时交宿主 observation 作业，附命令、SHA、窗口/截止、日志/status.json 和一次终态通知；模型 run 不轮询等待。

## 交付验收清单

方案任务：文档只改本方案；52 路径覆盖、固定 SHA/manifest/链可复算；独立审核精确 PR head；PR 合入 develop、#242 关闭后任务才最终完成。
提交方案进入原生 review 不代表满足最终交付，也不解除实现任务前置门禁。

实现任务：每个子系统的来源→适配→回归可追踪；27 个 SQL hash 不变、journal 420 条、最新五 snapshot 及 schema drift 合格；
真实 D 和更旧库升级/重入通过；本地定向结果、完整 CI、浏览器证据与代码审核版本一致；经 PR 合入 develop。
发布任务：备份可恢复、试迁移通过、旧 payload 兼容或 DB 恢复方案获准、release tuple 审核与 exact SHA 一致；ops 发布后由未参与实现者验收。
任何未完成项都按实际证据登记，不能把本轮方案中的未来检查当作已执行结果。
