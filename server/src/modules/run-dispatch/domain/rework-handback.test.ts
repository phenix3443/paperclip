import { describe, expect, it } from "vitest";
import { isNativeReworkHandback } from "./rework-handback.js";

const executor = "agent-executor";
const handback = {
  status: "in_progress",
  assigneeAgentId: executor,
  assigneeUserId: null,
  executionState: {
    status: "changes_requested",
    returnAssignee: { type: "agent", agentId: executor },
  },
};

describe("isNativeReworkHandback", () => {
  it("holds when changes were requested and the work is back with its executor", () => {
    expect(isNativeReworkHandback(handback, executor)).toBe(true);
  });

  it.each([
    ["another run agent", handback, "agent-other"],
    ["a pending review", { ...handback, executionState: { ...handback.executionState, status: "pending" } }, executor],
    ["an issue not in progress", { ...handback, status: "in_review" }, executor],
    ["a user assignee", { ...handback, assigneeUserId: "user-1" }, executor],
    ["a different assignee", { ...handback, assigneeAgentId: "agent-other" }, executor],
    [
      "a user return assignee",
      { ...handback, executionState: { status: "changes_requested", returnAssignee: { type: "user", userId: "user-1" } } },
      executor,
    ],
    [
      "a return assignee for another agent",
      { ...handback, executionState: { status: "changes_requested", returnAssignee: { type: "agent", agentId: "agent-other" } } },
      executor,
    ],
    ["no execution state", { ...handback, executionState: null }, executor],
  ])("does not hold for %s", (_label, issue, agentId) => {
    expect(isNativeReworkHandback(issue, agentId)).toBe(false);
  });
});
