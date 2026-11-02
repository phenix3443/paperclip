import { describe, expect, it } from "vitest";
import { executionDecisionInputsDigest } from "./execution-decision-inputs.js";

describe("executionDecisionInputsDigest", () => {
  it("normalizes missing fields, JSON key order, and database timestamps", async () => {
    const first = {
      executionState: { returnAssignee: { userId: "人", type: "user" }, completedStageIds: ["b", "a"] },
      monitorNextCheckAt: new Date("2026-11-01T00:00:00.000Z"),
    };
    const second = {
      status: null,
      executionState: { completedStageIds: ["b", "a"], returnAssignee: { type: "user", userId: "人" } },
      monitorNextCheckAt: "2026-10-31T20:00:00-04:00",
    };
    expect(await executionDecisionInputsDigest(first)).toBe(await executionDecisionInputsDigest(second));
    expect(await executionDecisionInputsDigest({})).toBe("d61096c126e89184184c6bee9920cec53fdd905848baf7969a6a5bf080327372");
  });
  it.each([
    ["status", "in_review"], ["assigneeAgentId", "agent"], ["assigneeUserId", "user"],
    ["responsibleUserId", "owner"], ["createdByUserId", "creator"],
    ["executionPolicy", { stages: [] }], ["executionState", { changesRequestedCount: 3 }],
    ["monitorNextCheckAt", "2026-12-01T00:00:00Z"], ["monitorWakeRequestedAt", "2026-12-01T00:00:00Z"],
    ["monitorLastTriggeredAt", "2026-12-01T00:00:00Z"], ["monitorAttemptCount", 1],
    ["monitorNotes", "note"], ["monitorScheduledBy", "board"],
  ] as const)("includes %s in the digest", async (key, value) => {
    expect(await executionDecisionInputsDigest({ [key]: value })).not.toBe(await executionDecisionInputsDigest({}));
  });

  it("retains array order and ignores unrelated issue metadata", async () => {
    const digest = await executionDecisionInputsDigest({ executionState: { completedStageIds: ["a", "b"] } });
    expect(await executionDecisionInputsDigest({ executionState: { completedStageIds: ["b", "a"] } })).not.toBe(digest);
    const issue = { executionState: { completedStageIds: ["a", "b"] }, title: "irrelevant" };
    expect(await executionDecisionInputsDigest(issue)).toBe(digest);
  });
});
