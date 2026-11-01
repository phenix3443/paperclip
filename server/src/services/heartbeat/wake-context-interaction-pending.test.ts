import { describe, expect, it } from "vitest";
import { enrichWakeContextSnapshot } from "./run-preparation.js";

const enrich = (reason: string | null, payload: Record<string, unknown> | null, contextSnapshot: Record<string, unknown> = {}) =>
  enrichWakeContextSnapshot({ contextSnapshot, reason, source: "automation", triggerDetail: "system", payload }).contextSnapshot;

describe("enrichWakeContextSnapshot for a pending card", () => {
  it("carries the card id from the payload so dispatch can recognize the addressee", () => {
    const context = enrich("interaction_pending", { issueId: "issue-1", interactionId: "card-1", interactionKind: "ask_user_questions" });
    expect(context).toMatchObject({ wakeReason: "interaction_pending", issueId: "issue-1", interactionId: "card-1", interactionKind: "ask_user_questions" });
  });

  it("keeps a card id the caller already put in the snapshot", () => {
    const context = enrich("interaction_pending", { interactionId: "card-from-payload" }, { interactionId: "card-from-context" });
    expect(context.interactionId).toBe("card-from-context");
  });

  it("copies nothing for other wake reasons, so a stale card id cannot turn a plain wake into an addressee wake", () => {
    expect(enrich("issue_commented", { issueId: "issue-1", commentId: "c1", interactionId: "card-1" })).not.toHaveProperty("interactionId");
    expect(enrich("interaction_pending", { issueId: "issue-1" })).not.toHaveProperty("interactionId");
  });

  it("does not make the wake look like a resolved-interaction continuation", () => {
    const context = enrich("interaction_pending", { issueId: "issue-1", interactionId: "card-1" });
    expect(context).not.toHaveProperty("interactionStatus");
    expect(context).not.toHaveProperty("mutation");
  });
});
