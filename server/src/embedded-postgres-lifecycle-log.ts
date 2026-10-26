// PostgreSQL's own shutdown and startup lines are the proof of a normal stop
// (stop_proof.py in ai-team). Embedded PostgreSQL output otherwise stays in an
// in-memory buffer, so these few lines are logged even without verbose logs.
const LIFECYCLE_PATTERNS = [
  /received (?:fast|smart|immediate) shutdown request/,
  /database system is shut down/,
  /database system was shut down at /,
  /database system was not properly shut down/,
  /database system was interrupted/,
  /automatic recovery in progress/,
];

export function isEmbeddedPostgresLifecycleLine(line: string): boolean {
  return LIFECYCLE_PATTERNS.some((pattern) => pattern.test(line));
}
