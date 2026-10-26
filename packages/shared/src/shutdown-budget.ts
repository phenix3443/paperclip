/**
 * The stop budget of a Paperclip server, measured from the moment the main
 * process receives SIGTERM. The server spends at most the work deadline on
 * its own work (scheduler quiescence, hot-restart preparation, run drain,
 * finalizers), then runs the teardown steps in their fixed slots and exits
 * before the service manager's stop timeout sends SIGKILL.
 *
 * `renderSystemdUnit` writes `TimeoutStopSec`; a CLI test asserts that the
 * exit watchdog plus the margin equals it, so neither side can change alone.
 */
export const SHUTDOWN_WORK_DEADLINE_MAX_MS = 200_000;
export const SHUTDOWN_WORK_DEADLINE_MIN_MS = 10_000;

export const SHUTDOWN_TEARDOWN_CAPS_MS = {
  httpListenerClose: 5_000,
  appServices: 15_000,
  pendingFailureReports: 10_000,
  databaseClose: 10_000,
  embeddedPostgresStop: 45_000,
  flush: 5_000,
} as const;

export const SHUTDOWN_TEARDOWN_TOTAL_MS = Object.values(SHUTDOWN_TEARDOWN_CAPS_MS).reduce(
  (sum, cap) => sum + cap,
  0,
);

/** Armed on signal receipt; exits the process if the sequence has not. */
export const SHUTDOWN_WATCHDOG_MS = SHUTDOWN_WORK_DEADLINE_MAX_MS + SHUTDOWN_TEARDOWN_TOTAL_MS;

/** Covers the exit itself and timer skew under load. */
export const SHUTDOWN_STOP_MARGIN_MS = 10_000;
