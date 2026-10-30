// Kill switch and bound for "ownership park and release" (agentos#1508).
//
// A wake that arrives while the only blocker on its issue is a TERMINAL run
// that still holds its environment lease (or pid) is parked as
// deferred_issue_execution instead of being written as a terminal skipped
// row. The blocking run's own cleanup then drains every parked wake on the
// issue, whichever agent owns it. A parked ownership wake that is never
// drained is converted to the old skipped row after the bound, so the
// existing recovery sweeps see the card again.
//
// PAPERCLIP_OWNERSHIP_WAKE_PARK is read on every call. Default on. Set it to
// "0" (or "false", "off", "no") and restart the service to restore the
// earlier behavior (skip at admission, self-scoped post-cleanup trigger).
// PAPERCLIP_OWNERSHIP_WAKE_PARK_MAX_MS sets the bound (default 120000).

export const OWNERSHIP_WAKE_PARK_ENV = "PAPERCLIP_OWNERSHIP_WAKE_PARK";
export const OWNERSHIP_WAKE_PARK_MAX_MS_ENV = "PAPERCLIP_OWNERSHIP_WAKE_PARK_MAX_MS";
export const OWNERSHIP_WAKE_PARK_CAUSE = "execution_owner_active";
const DEFAULT_MAX_MS = 120_000;

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

export function ownershipWakeParkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OWNERSHIP_WAKE_PARK_ENV]?.trim().toLowerCase();
  return !value || !OFF_VALUES.has(value);
}

export function ownershipWakeParkMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[OWNERSHIP_WAKE_PARK_MAX_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MS;
}

// The promotion stage guard lives in modules/wake-queue/domain/policy.ts
// (ownershipParkedStageStillPending) so the application layer stays free of
// service imports.
