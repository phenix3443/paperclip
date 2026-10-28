# Reviewer assignment：upstream #16966 与 fork 第四片的契约对照

日期：2026-10-28 UTC。此文是源码研究与交付包装候选，不是独立代码审核决定，不批准新实现或部署。

## 固定版本与取证边界

| 对象 | 固定版本 |
| --- | --- |
| 当前 upstream/master | `65fa1cd617b43a45c9d22e10480f4fb6e52dbd21` |
| upstream PR #16966 head | `3803bcb898e1ea73f0a2358f92a1dc1cd6011dae` |
| #16966 的 PR base / 与当前 master 的 merge-base | `ee29e2850d0edc6cf11be9a8166a7829bce9c311` |
| fork 第四片基线 | `ef5a32b032672a88934c1975dc7ba43bd1f4c113` |
| 本次研究开始时 fork head | `b2f45e5d99bbe54f58c567ef20e8ec546ca9c324` |

研究通过本地 `git show`、`git diff`、`git grep` 读取上述一手源码；远端版本由宿主 Git 获取。没有切换或重指向任务分支。`git diff ee29e2850d0edc6cf11be9a8166a7829bce9c311...3803bcb898e1ea73f0a2358f92a1dc1cd6011dae --stat` 为 10 文件、970 insertions / 12 deletions。该规模是已有 PR 的事实，不是新建同规模贡献的授权。

需求来源是 [fork #133](https://github.com/phenix3443/paperclip/issues/133) 的 `Upstream delivery packaging` 和 [获批修订方案](https://github.com/phenix3443/paperclip/blob/4dea5cabb41256a359c73f7a93e2fe796e7bde62/doc/plans/2026-10-28-reviewer-lease-continuation.md)。上游 PR 的正文只说明作者目标，以下结论追溯到实现或测试代码。

## 判断

**目前不能认定 #16966 与获批 fork 契约等价。** #16966 确实保存被执行持有挡住的 wake，并提供并发恢复、startup、drain、空闲与外层事务测试；但它的核心阶段适用性谓词只比较 status、stage ID 和参与者，不保存或比较完整 review generation。相同 stage/participant 的 submission、policy、decision 或真实责任人变化，需要另有证据才能排除旧 receipt 继续投递。这个缺口不同于新增 topic 这一架构差别；后者本身不证明上游存在 bug。

源码证据：[queue.ts:254–269](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L254)，以及复用该谓词的 [run-control.ts:846](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/run-control.ts#L846)、[queue.ts:3168](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L3168) 和 [queue.ts:4384](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L4384)。

## Covered / missing / dependency 映射

此表的 covered 仅表示源码与提交内测试存在对应路径。研究助手没有运行这些测试；实际执行结果由本任务执行者另行回填，不能把静态覆盖当作成功验收。

| 保证 | 状态 | 具体证据与边界 |
| --- | --- | --- |
| 被前一 executor 持有挡住的 handoff 持久化 | covered，范围不同 | #16966 的 [queue.ts:3391–3469](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L3391) 对无 recovery action 的 `execution_owner_active` 写入 `deferred_issue_execution`，并在写入前注册事务通知。它覆盖普通 assignment/changes-requested 等更广 wake，不是 fork 的保留 namespace、内部 pending-review producer。 |
| 清理后原 reviewer 一次 successor | covered 的基本情形；更强等价仍待证 | [ownership 测试:133–165](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-execution-ownership-wait.test.ts#L133) 并发调用 resume 后断言一个 queued run；[run-control.ts:852–887](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/run-control.ts#L852) 避免在之后已 started/queued 的 turn 上重复派发，并使用 receipt UUID key。不同 receipt、不同 actor、同一完整 submission 的等价，不应仅由该单例测试推出。 |
| 过时 stage / participant / terminal task 不投递 | covered | [queue.ts:254–269](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L254)；[测试:393–454](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-execution-ownership-wait.test.ts#L393) 只列 stage、participant、completed/closed 等变更。 |
| 完整 review generation 不被旧 receipt 重新解释 | missing：可识别的源码差距，需动态反例确认影响 | receipt 保存 stage 上下文，但没有保存完整 policy/state/assignee/responsible digest；适用性谓词的 issue 类型连 `executionPolicy` 与 `responsibleUserId` 都不包含。对照 fork [reviewer-assignment-continuation.ts](https://github.com/phenix3443/paperclip/blob/b2f45e5d99bbe54f58c567ef20e8ec546ca9c324/server/src/services/heartbeat/reviewer-assignment-continuation.ts)：内部 producer 保存 generation，consumer 锁内重算并退休过时代际。 |
| 原 actor 和当前权限 | dependency / partial | #16966 [run-control.ts:877–887](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/run-control.ts#L877) 用 receipt 自己的 actor 重新进入 ordinary admission；[queue.ts:2879–2913](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/queue.ts#L2879) 重新读取 receipt 并比较精确 payload。它不是完整 immutable source-run/authority snapshot 的证明，也不等于绕过现有授权；更强权限矩阵需实测。 |
| legacy executor 实际 cleanup 顺序 | covered 的已有测试 | [process-recovery 测试:1912 起](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-process-recovery.test.ts#L1912) 通过真实 heartbeat service、受控 adapter cancellation 和 releaseForRun barrier 断言 source 已 terminal/锁已释放但 lease 尚存时不派发，放开 lease 后得到一个 successor。它使用 provider/release mocks，不能据此称为真实 native PRP process/workspace 测试。 |
| native process 先/后 workspace 结算 | dependency / 未证明等价 | #16966 [heartbeat.ts:3923–3939](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat.ts#L3923) 在 finalization 不再 scheduled 时按 issue 通知恢复，并由 ordinary execution blocker 再检查；PR diff 没有 native finalization/process-stop owner 的对应改动。其 worker 会再次恢复，所以不能仅因没有直接 hook 就断言必然丢失；仍需真实 PRP/进程双顺序反例或通过证据。fork 对应证据在 `heartbeat-process-recovery.test.ts` 的 reviewer late-stop 两例。 |
| producer 外层 commit / rollback | covered 的已有测试 | 写入前通知见 queue.ts:3428；[ownership 测试:532–548](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-execution-ownership-wait.test.ts#L532) 覆盖嵌套事务 outer settlement/rollback；不能外推出 successor 关联失败、提交后响应丢失、native stop callback 失败的全部语义。 |
| startup / 双 worker / drain / shutdown | covered 的已有测试 | [测试:522–568](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-execution-ownership-wait.test.ts#L522)；[index.ts:1340](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/index.ts#L1340) 注册 shared coordinator duty。 |
| 无 unfinished 时不循环 SQL | covered 的已有测试，deadline 契约不同 | [测试:507–520](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/__tests__/heartbeat-execution-ownership-wait.test.ts#L507) 比较持久层调用计数；[run-control.ts:931–937](https://github.com/paperclipai/paperclip/blob/3803bcb898e1ea73f0a2358f92a1dc1cd6011dae/server/src/services/heartbeat/run-control.ts#L931) 无 pending 返回 null，否则 `updatedAt+30s`。这与 fork 15–300s bounded backoff 不同；二者都不能仅按“有定时器”判定 idle polling。 |
| 保留原 policy/state/decision/count/真实 responsible | 未证明完整等价 | PR 的 resume/adoption 不直接执行 review transition，这是正面证据；但其提交内 ownership 测试没有覆盖同 stage 的 full generation 变化及逐值保存完整 review/decision 历史。需要测试，不把“没有显式写 policy”当作所有路径都不修改 authority 的证明。 |

## 当前 master 与其他上游贡献的依赖

在 `65fa1cd617b43a45c9d22e10480f4fb6e52dbd21` 上，对 `server/src/services` 与 `server/src/index.ts` 搜索 `executionOwnershipWaits`、`resumeExecutionOwnershipWait`、`reviewerAssignmentGeneration`、`issueExecutionGeneration`、`_paperclipReviewerAssignmentContinuation` 均无匹配。这只证明这组已识别 owner/contract 尚未存在，不是对所有可能等价实现的穷尽证明。

因此，不能把 fork 第四片单独 cherry-pick 到当前 master；也不能把 #18012、#18039、#18060 的标题或最终摘要当作完整 intent owner。#16966 目前的持久 receipt、resume/adoption 入口与它自己的 base 存在明确代码依赖。任何最小补丁必须重核其最终 merge SHA 与届时 master，而不是把当前 open head 当成已成立的合并事实。

## 单一保证的包装候选（待批准，不实施）

候选保证：**同 stage、同 participant 的旧 reviewer handoff receipt 不得投递改变后的 review submission。** 先运行反例：park 原 receipt，改变 `executionState.reviewRequest`（保持 stage/participant），释放原 lease，调用真实 resume；断言旧 receipt 退休且没有 successor，并保留未改变时的一次投递对照。进一步 policy/decision/identity 的范围只在这一 full-generation 保证内扩展，不顺带更换 scheduler、namespace 或整套架构。

最小文件集合候选：

1. `server/src/services/heartbeat/queue.ts`：在现有 issue 锁内、首次 park 时从 DB 生成完整 canonical generation；resume/adoption 的同一 owner 谓词比较它。禁止从 caller payload 接受 generation authority；重复信号不能悄悄把旧 receipt 改成新 submission。
2. `server/src/services/heartbeat/run-control.ts`：若需多读 `executionPolicy`/identity，只向既有 eligibility/admission 传递必要的当前值；不另写一套快照策略。
3. `server/src/modules/wake-queue/adapters/postgres.ts`：若普通 drain 可触及该 class，须在排序/limit 前及受锁写入边界调用同一 generation 合同或 delegate；不能只保护 owning resume，也不能建立 module→service 循环依赖。
4. `server/src/__tests__/heartbeat-execution-ownership-wait.test.ts`：加入 unchanged 正向对照与 submission/policy/decision/identity 改变的表驱动反例、ordinary adoption 反例。

预计增量约 190–280 行（生产逻辑约 80–120 行，测试约 110–160 行），不是已测量 diff；批准前应以精确方案和真实 diff 预算复核。不得为了满足行数删掉必要验证。

**master 前提尚未成立：** 上述三个改动点依赖 #16966 的 receipt/resume owner。当前 master 没有它，不能把此候选当作现在可独立编译的 master 修复。建议 CTO 选择：在 #16966 的最终实现进入 master 后，重新固定 base 并批准该小补丁；或明确批准与该 PR 作者协调复用其现有 PR 的增量方式。没有这一步，既不创建竞争性的巨大 master PR，也不把 pending 合并写成已完成依赖。若需要一个“现在立即可独立编译、无 #16966 前提”的不同保证，须另做重复贡献核对与范围批准，不能把已有 #18060 的 queued-generation 工作重新提交为本片。

这只是包装候选。是否是独立上游缺口、最终文件/行数、master 前提和贡献形式，均需实际反例证据与 CTO 批准；本研究没有创建 Issue、PR、评审意见或外部状态。

## 实际测试记录

主执行者通过宿主 `git archive 3803bcb898e1ea73f0a2358f92a1dc1cd6011dae` 导出纯源码到本 run 的 `$TMPDIR/upstream16966`；在该快照独立执行 offline install 和 SDK/shared 构建。没有把 fork 的 node_modules 或源码挂入快照。临时安装的 lockfile 漂移不属于被审源码，也没有提交/发布。

1. 原样执行 `timeout 180 pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-execution-ownership-wait.test.ts`：**25 passed**，36.08 秒。该证据只覆盖提交内25项测试，不等于完整fork契约。
2. 仅在临时快照测试文件增加反例，生产源码不变：`seed()` → `parkWake()` → 仅更新 `executionState.reviewRequest.instructions`（stage和participant不变）→ `releaseLease()` → `resumeExecutionOwnershipWaits()` → 断言零 successor、旧receipt取消。与原始第一个正向test一起运行：`timeout 180 pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-execution-ownership-wait.test.ts -t 'obsolete submission|parks a stage handoff'`。
3. 实际结果：**1 failed / 1 passed / 24 filtered**，21.75 秒；反例 `expected length 0 / actual 1`。旧receipt确实产生了一个 queued successor。另一次只运行反例的探针输出确认 status=queued，executionStage.reviewRequest 仍是旧指令；没有观察 provider 执行。因此full-generation缺口已动态证实，不能认定等价。没有给上游生产代码打补丁，没有创建/发布新的Issue或PR。

反例测试本身是取证探针，不是已提交上游的测试。归档报告随本任务生成的artifact提供，实际日志不能被“源码中有测试”替代。这个结论只确证同stage/participant的submission变化缺口；其他generation维度、native释放双顺序、两receipt同submission的跨actor场景仍是明确未充分验证项，不推断全部已复现。

fork新head `d49e3db3b8eb717aabe2f6e745eab457432ccd4d` 修复连续review stage的source来源绑定；本报告不替代其CI、跨类型独审或上游包装批准。后续最小补丁必须先获得CTO对master前提/独立可编译范围的明确批准。

## 可重放的临时测试增量

下面仅为测试探针；在固定 PR head 的测试文件内增加，不修改生产源码：

```diff
--- head3803bcb/heartbeat-execution-ownership-wait.test.ts
+++ probe/heartbeat-execution-ownership-wait.test.ts
@@ -163,6 +163,18 @@
     await heartbeat.resumeExecutionOwnershipWaits({ companyId: f.companyId, issueId: f.issueId });
     await heartbeat.resumeQueuedRuns();
     expect(await nextAgentIssueRuns(f)).toHaveLength(1);
+  });
+
+  it("does not deliver an obsolete submission with the same stage and reviewer", async () => {
+    const f = await seed();
+    const { heartbeat, parked } = await parkWake(f);
+    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
+    await db.update(issues).set({ executionState: { ...before!.executionState!,
+      reviewRequest: { instructions: "Review a newer submission instead" } } }).where(eq(issues.id, f.issueId));
+    await releaseLease(f);
+    await heartbeat.resumeExecutionOwnershipWaits({ companyId: f.companyId, issueId: f.issueId });
+    expect(await nextAgentIssueRuns(f)).toHaveLength(0);
+    expect((await nextAgentWakes(f)).find(row => row.id === parked.id)?.status).toBe("cancelled");
   });
 
   it("parks a plain assignment handoff the same way", async () => {
```
