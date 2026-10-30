import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
  IssueBlockedInboxSeverity,
} from "@paperclipai/shared";

export type BlockedReasonVariant =
  | "needs_decision"
  | "stalled"
  | "needs_attention"
  | "recovery_required"
  | "external_wait"
  | "owner_paused";

const VARIANT_BY_REASON: Record<IssueBlockedInboxReason, BlockedReasonVariant> = {
  pending_board_decision: "needs_decision",
  pending_user_decision: "needs_decision",
  missing_successful_run_disposition: "needs_decision",
  blocked_chain_stalled: "stalled",
  blocked_by_unassigned_issue: "needs_attention",
  blocked_by_assigned_backlog_issue: "needs_attention",
  blocked_by_cancelled_issue: "needs_attention",
  in_review_without_action_path: "needs_attention",
  invalid_review_participant: "needs_attention",
  open_recovery_issue: "recovery_required",
  external_owner_action: "external_wait",
  blocked_by_uninvokable_assignee: "owner_paused",
};

export const BLOCKED_REASON_VARIANT_ORDER: BlockedReasonVariant[] = [
  "needs_decision",
  "stalled",
  "needs_attention",
  "recovery_required",
  "external_wait",
  "owner_paused",
];

export const BLOCKED_VARIANT_LABELS: Record<BlockedReasonVariant, string> = {
  needs_decision: "Needs decision",
  stalled: "Blocked chain stalled",
  needs_attention: "Needs attention",
  recovery_required: "Recovery required",
  external_wait: "External wait",
  owner_paused: "Owner paused",
};

const REASON_LABELS: Record<IssueBlockedInboxReason, string> = {
  pending_board_decision: "Pending board decision",
  pending_user_decision: "Pending user decision",
  missing_successful_run_disposition: "Pick disposition",
  blocked_chain_stalled: "Blocked chain stalled",
  blocked_by_unassigned_issue: "Unassigned blocker",
  blocked_by_assigned_backlog_issue: "Parked blocker",
  blocked_by_cancelled_issue: "Cancelled blocker",
  in_review_without_action_path: "Review without action path",
  invalid_review_participant: "Invalid review participant",
  open_recovery_issue: "Recovery in progress",
  external_owner_action: "External owner action",
  blocked_by_uninvokable_assignee: "Owner paused",
};

const SEVERITY_RANK: Record<IssueBlockedInboxSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export type BlockedInboxBadgeTone = "muted" | "amber" | "red";

export function blockedReasonVariant(reason: IssueBlockedInboxReason): BlockedReasonVariant {
  return VARIANT_BY_REASON[reason] ?? "needs_attention";
}

export function blockedReasonLabel(reason: IssueBlockedInboxReason): string {
  return REASON_LABELS[reason] ?? "Stopped";
}

export function blockedVariantLabel(variant: BlockedReasonVariant): string {
  return BLOCKED_VARIANT_LABELS[variant];
}

export function blockedSeverityRank(severity: IssueBlockedInboxSeverity): number {
  return SEVERITY_RANK[severity] ?? 9;
}

export function compareBlockedAttention(
  a: IssueBlockedInboxAttention,
  b: IssueBlockedInboxAttention,
): number {
  const sevDiff = blockedSeverityRank(a.severity) - blockedSeverityRank(b.severity);
  if (sevDiff !== 0) return sevDiff;
  const aSince = a.stoppedSinceAt ? new Date(a.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const bSince = b.stoppedSinceAt ? new Date(b.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const sinceDiff = aSince - bSince;
  return Number.isFinite(sinceDiff) ? sinceDiff : 0;
}

export interface BlockedInboxIssueRow {
  issue: Issue;
  attention: IssueBlockedInboxAttention;
  variant: BlockedReasonVariant;
  reasonLabel: string;
  stoppedAtMs: number | null;
}

export type BlockedInboxGroupBy = "none" | "blocker_type" | "responsible" | "project" | "workspace";
export type BlockedInboxSort = "urgency" | "most_recent" | "longest_stopped";

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = [
  ["none", "None"],
  ["blocker_type", "Blocker type"],
  ["responsible", "Responsible"],
  ["project", "Project"],
  ["workspace", "Workspace"],
];

/** Group options for the blocked inbox; Workspace needs isolated workspaces, like the other inbox tabs. */
export function blockedInboxGroupOptions(isolatedWorkspacesEnabled: boolean): readonly [BlockedInboxGroupBy, string][] {
  return BLOCKED_GROUP_OPTIONS.filter(([value]) => value !== "workspace" || isolatedWorkspacesEnabled);
}

export const BLOCKED_INBOX_GROUP_BY_KEY = "paperclip:inbox:blocked-group-by";

export function loadBlockedInboxGroupBy(): BlockedInboxGroupBy {
  try {
    const raw = localStorage.getItem(BLOCKED_INBOX_GROUP_BY_KEY);
    return BLOCKED_GROUP_OPTIONS.some(([value]) => value === raw) ? (raw as BlockedInboxGroupBy) : "none";
  } catch {
    return "none";
  }
}

export function saveBlockedInboxGroupBy(groupBy: BlockedInboxGroupBy) {
  try {
    localStorage.setItem(BLOCKED_INBOX_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export const BLOCKED_SORT_OPTIONS: readonly [BlockedInboxSort, string][] = [
  ["urgency", "Most urgent"],
  ["most_recent", "Most recent"],
  ["longest_stopped", "Longest stopped"],
];

export interface BlockedInboxGroup {
  key: string;
  label: string;
  rows: BlockedInboxIssueRow[];
  /** Set when grouped by blocker type. */
  variant?: BlockedReasonVariant;
}

/** Resolves the group of a row for the Responsible, Project and Workspace groupings. */
export interface BlockedInboxGroupResolvers {
  ownerLabel?: (row: BlockedInboxIssueRow) => string | null;
  projectName?: (projectId: string) => string | null;
  workspaceGroup?: (issue: Issue) => { key: string; label: string };
}

const NO_GROUP_KEYS = new Set(["owner:unknown", "project:none", "workspace:none"]);

function blockedRowGroup(
  row: BlockedInboxIssueRow,
  groupBy: Exclude<BlockedInboxGroupBy, "none" | "blocker_type">,
  resolvers: BlockedInboxGroupResolvers,
): { key: string; label: string } {
  if (groupBy === "responsible") {
    const owner = row.attention.owner;
    const label = resolvers.ownerLabel?.(row) ?? null;
    if (!label) return { key: "owner:unknown", label: "Unknown" };
    if (owner.type === "agent" && owner.agentId) return { key: `owner:agent:${owner.agentId}`, label };
    if (owner.type === "user" && owner.userId) return { key: `owner:user:${owner.userId}`, label };
    return { key: `owner:${owner.type}:${label}`, label };
  }
  if (groupBy === "project") {
    const projectId = row.issue.projectId;
    if (!projectId) return { key: "project:none", label: "No project" };
    return { key: `project:${projectId}`, label: resolvers.projectName?.(projectId) ?? "Unknown project" };
  }
  return resolvers.workspaceGroup?.(row.issue) ?? { key: "workspace:none", label: "No workspace" };
}

export function buildBlockedInboxRows(issues: readonly Issue[]): BlockedInboxIssueRow[] {
  const rows: BlockedInboxIssueRow[] = [];
  for (const issue of issues) {
    const attention = issue.blockedInboxAttention;
    if (!attention) continue;
    rows.push({
      issue,
      attention,
      variant: blockedReasonVariant(attention.reason),
      reasonLabel: blockedReasonLabel(attention.reason),
      stoppedAtMs: attention.stoppedSinceAt ? new Date(attention.stoppedSinceAt).getTime() : null,
    });
  }
  return rows;
}

function issueTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function blockedRowRecencyMs(row: BlockedInboxIssueRow): number {
  return row.stoppedAtMs ?? issueTimestampMs(row.issue.updatedAt) ?? 0;
}

function compareBlockedRowsByTitle(a: BlockedInboxIssueRow, b: BlockedInboxIssueRow): number {
  const byTitle = a.issue.title.localeCompare(b.issue.title);
  if (byTitle !== 0) return byTitle;
  return a.issue.id.localeCompare(b.issue.id);
}

export function compareBlockedRows(
  a: BlockedInboxIssueRow,
  b: BlockedInboxIssueRow,
  sort: BlockedInboxSort = "urgency",
): number {
  if (sort === "most_recent") {
    const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
    if (recencyDiff !== 0) return recencyDiff;
    const attentionDiff = compareBlockedAttention(a.attention, b.attention);
    if (attentionDiff !== 0) return attentionDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  if (sort === "longest_stopped") {
    const aStopped = a.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const bStopped = b.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const stoppedDiff = aStopped - bStopped;
    if (stoppedDiff !== 0) return stoppedDiff;
    const severityDiff = blockedSeverityRank(a.attention.severity) - blockedSeverityRank(b.attention.severity);
    if (severityDiff !== 0) return severityDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  const attentionDiff = compareBlockedAttention(a.attention, b.attention);
  if (attentionDiff !== 0) return attentionDiff;
  const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
  if (recencyDiff !== 0) return recencyDiff;
  return compareBlockedRowsByTitle(a, b);
}

export function sortBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxIssueRow[] {
  return [...rows].sort((a, b) => compareBlockedRows(a, b, sort));
}

/**
 * Groups rows for the blocked inbox. Blocker type keeps the canonical variant order. The other groupings
 * sort groups by label and put the catch-all group (Unknown, No project, No workspace) last.
 * Rows keep the given sort inside each group.
 */
export function groupBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
  groupBy: Exclude<BlockedInboxGroupBy, "none"> = "blocker_type",
  resolvers: BlockedInboxGroupResolvers = {},
): BlockedInboxGroup[] {
  if (groupBy === "blocker_type") {
    const buckets = new Map<BlockedReasonVariant, BlockedInboxIssueRow[]>();
    for (const row of rows) {
      const list = buckets.get(row.variant) ?? [];
      list.push(row);
      buckets.set(row.variant, list);
    }
    const groups: BlockedInboxGroup[] = [];
    for (const variant of BLOCKED_REASON_VARIANT_ORDER) {
      const list = buckets.get(variant);
      if (!list || list.length === 0) continue;
      const sorted = sortBlockedInboxRows(list, sort);
      groups.push({ key: variant, variant, label: BLOCKED_VARIANT_LABELS[variant], rows: sorted });
    }
    return groups;
  }

  const buckets = new Map<string, { label: string; rows: BlockedInboxIssueRow[] }>();
  for (const row of rows) {
    const { key, label } = blockedRowGroup(row, groupBy, resolvers);
    const bucket = buckets.get(key) ?? { label, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([aKey, a], [bKey, b]) => {
      const catchAll = Number(NO_GROUP_KEYS.has(aKey)) - Number(NO_GROUP_KEYS.has(bKey));
      if (catchAll !== 0) return catchAll;
      return a.label.localeCompare(b.label) || aKey.localeCompare(bKey);
    })
    .map(([key, bucket]) => ({ key, label: bucket.label, rows: sortBlockedInboxRows(bucket.rows, sort) }));
}

export interface BlockedInboxTreeNode {
  row: BlockedInboxIssueRow;
  children: BlockedInboxTreeNode[];
}

/**
 * Nests sorted rows under their parent issue when the parent is in the same list.
 * Roots and each child list keep the input order. A row whose parent is absent stays a root.
 * A parent cycle cannot hide rows: its members stay roots.
 */
export function nestBlockedInboxRows(rows: readonly BlockedInboxIssueRow[]): BlockedInboxTreeNode[] {
  const byId = new Map(rows.map((row) => [row.issue.id, row]));
  const parentOf = (row: BlockedInboxIssueRow): BlockedInboxIssueRow | null => {
    const parentId = row.issue.parentId;
    if (!parentId || parentId === row.issue.id) return null;
    return byId.get(parentId) ?? null;
  };
  const inCycle = (row: BlockedInboxIssueRow): boolean => {
    const seen = new Set<string>([row.issue.id]);
    for (let parent = parentOf(row); parent; parent = parentOf(parent)) {
      if (seen.has(parent.issue.id)) return true;
      seen.add(parent.issue.id);
    }
    return false;
  };
  const nodes = new Map(rows.map((row) => [row.issue.id, { row, children: [] as BlockedInboxTreeNode[] }]));
  const roots: BlockedInboxTreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.issue.id)!;
    const parent = inCycle(row) ? null : parentOf(row);
    if (parent) nodes.get(parent.issue.id)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function blockedRowMatchesSearch(row: BlockedInboxIssueRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.issue.title,
    row.issue.identifier ?? "",
    row.attention.owner.label ?? "",
    row.attention.action.label,
    row.attention.action.detail ?? "",
    row.reasonLabel,
    row.attention.leafIssue?.identifier ?? "",
    row.attention.leafIssue?.title ?? "",
    row.attention.recoveryIssue?.identifier ?? "",
    row.attention.recoveryIssue?.title ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function blockedBadgeTone(rows: readonly BlockedInboxIssueRow[]): BlockedInboxBadgeTone {
  if (rows.length === 0) return "muted";
  let highest: IssueBlockedInboxSeverity = "low";
  for (const row of rows) {
    if (blockedSeverityRank(row.attention.severity) < blockedSeverityRank(highest)) {
      highest = row.attention.severity;
    }
  }
  if (highest === "critical") return "red";
  if (highest === "high") return "amber";
  return "muted";
}

export function formatStoppedAge(stoppedSinceAt: string | null, now: number = Date.now()): string {
  if (!stoppedSinceAt) return "stopped";
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return "stopped";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "stopped just now";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `stopped ${m}m`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return `stopped ${h}h`;
  }
  if (seconds < 86_400 * 7) {
    const d = Math.floor(seconds / 86_400);
    return `stopped ${d}d`;
  }
  if (seconds < 86_400 * 30) {
    const w = Math.floor(seconds / (86_400 * 7));
    return `stopped ${w}w`;
  }
  const mo = Math.floor(seconds / (86_400 * 30));
  return `stopped ${mo}mo`;
}
