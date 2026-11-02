export const EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY = "lifecycleGeneration";
export const EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY = "reopenPendingConsumption";

export function readExecutionWorkspaceLifecycleGeneration(metadata: Record<string, unknown> | null | undefined): number {
  const raw = metadata?.[EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export function metadataHasReopenPendingConsumption(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY] === true;
}
