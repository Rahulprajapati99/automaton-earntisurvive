/**
 * Revenue Heartbeat Tasks
 *
 * Money collection must not depend on the agent being awake. These tasks run
 * on the heartbeat daemon: settle verified payments on-chain, and watch
 * revenue vs burn — waking the agent when the numbers demand attention.
 */

import type { TickContext, HeartbeatLegacyContext } from "../types.js";
import { getRevenueSummary, estimateRunway } from "./ledger.js";
import { getPaymentsByStatus } from "./x402-gate.js";
import { settlePendingPayments } from "./settlement.js";
import { getActiveStorefront } from "./storefront.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("revenue.tasks");

/** Wake the agent when runway drops below this many days. */
const RUNWAY_WAKE_THRESHOLD_DAYS = 5;

export async function settleX402PaymentsTask(
  _ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
): Promise<{ shouldWake: boolean; message?: string }> {
  const db = taskCtx.db.raw;
  const pending = getPaymentsByStatus(db, "pending_settlement", 1);
  if (pending.length === 0) return { shouldWake: false };

  if (taskCtx.identity.chainType === "solana") {
    return {
      shouldWake: true,
      message:
        "Pending x402 payments exist but this automaton has a Solana wallet; settlement needs manual handling.",
    };
  }

  const result = await settlePendingPayments(db, taskCtx.identity.account);
  logger.info("Heartbeat settlement pass", {
    attempted: result.attempted,
    settled: result.settled,
    failed: result.failed,
  });

  if (result.settled > 0) {
    taskCtx.db.setKV(
      "last_settlement",
      JSON.stringify({
        settled: result.settled,
        settledCents: result.settledCents,
        at: new Date().toISOString(),
      }),
    );
  }

  // Persistent failures need the agent's judgment (likely: no gas on Base).
  if (result.failed > 0 && result.settled === 0) {
    return {
      shouldWake: true,
      message: `Settlement failing for ${result.failed} payment(s): ${result.errors[0] ?? "unknown error"}. Likely out of gas ETH on Base.`,
    };
  }
  return { shouldWake: false };
}

export async function revenueReportTask(
  ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
): Promise<{ shouldWake: boolean; message?: string }> {
  const db = taskCtx.db.raw;
  const day = getRevenueSummary(db, 24);
  const runway = estimateRunway(db, ctx.creditBalance);
  const storefront = getActiveStorefront();

  const snapshot = {
    day,
    runwayDays: Number.isFinite(runway.runwayDays) ? runway.runwayDays : null,
    profitable: runway.profitable,
    storefrontRunning: storefront?.running ?? false,
    timestamp: new Date().toISOString(),
  };
  taskCtx.db.setKV("last_revenue_report", JSON.stringify(snapshot));

  if (!runway.profitable && runway.runwayDays < RUNWAY_WAKE_THRESHOLD_DAYS) {
    const storefrontHint = storefront?.running
      ? "Storefront is up but not covering burn — consider repricing, new services, or promotion."
      : "Storefront is DOWN — start it (storefront_start) and expose it to earn.";
    return {
      shouldWake: true,
      message: `Runway ~${runway.runwayDays.toFixed(1)} days (net burn $${(runway.netBurnPerDayCents / 100).toFixed(2)}/day, 24h revenue $${(day.earnedCents / 100).toFixed(2)}). ${storefrontHint}`,
    };
  }
  return { shouldWake: false };
}
