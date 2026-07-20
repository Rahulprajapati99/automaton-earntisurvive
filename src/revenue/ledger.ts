/**
 * Revenue Ledger
 *
 * Income tracking and the numbers that decide survival:
 * revenue vs burn, and how many days of runway remain.
 *
 * Income lives in revenue_entries (written here). Spend is read from the
 * existing spend_tracking table (written by the spend tracker on transfers,
 * x402 purchases, and inference).
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  RevenueEntryRow,
  RevenueSource,
  RevenueSummary,
  RunwayEstimate,
} from "./types.js";

type DatabaseType = BetterSqlite3.Database;

export function recordEarning(
  db: DatabaseType,
  entry: {
    serviceId?: string | null;
    amountCents: number;
    payer?: string;
    source?: RevenueSource;
    reference?: string;
  },
): string {
  if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
    throw new Error(`Invalid earning amount: ${entry.amountCents}`);
  }
  const id = ulid();
  db.prepare(
    `INSERT INTO revenue_entries (id, service_id, amount_cents, payer, source, reference)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.serviceId ?? null,
    entry.amountCents,
    entry.payer ?? "",
    entry.source ?? "x402_storefront",
    entry.reference ?? "",
  );
  return id;
}

export function getRecentEarnings(
  db: DatabaseType,
  limit: number = 50,
): RevenueEntryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM revenue_entries ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, limit))) as any[];
  return rows.map((r) => ({
    id: r.id,
    serviceId: r.service_id,
    amountCents: r.amount_cents,
    payer: r.payer,
    source: r.source,
    reference: r.reference,
    createdAt: r.created_at,
  }));
}

/**
 * Revenue vs spend over a trailing window.
 */
export function getRevenueSummary(
  db: DatabaseType,
  windowHours: number = 24,
): RevenueSummary {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const earned = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
       FROM revenue_entries WHERE created_at >= ?`,
    )
    .get(cutoff) as { total: number; n: number };

  const spent = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM spend_tracking WHERE created_at >= ?`,
    )
    .get(cutoff) as { total: number };

  return {
    earnedCents: earned.total,
    sales: earned.n,
    spentCents: spent.total,
    netCents: earned.total - spent.total,
    windowHours,
  };
}

/**
 * Estimate how long the automaton survives at the current net burn rate.
 *
 * Burn is sampled over `sampleDays` and averaged per day. If the automaton
 * earns more than it spends, runway is Infinity (profitable).
 */
export function estimateRunway(
  db: DatabaseType,
  creditBalanceCents: number,
  sampleDays: number = 7,
): RunwayEstimate {
  const summary = getRevenueSummary(db, sampleDays * 24);
  // Guard against a fresh database with almost no history: use at least
  // one day so a few minutes of spend doesn't extrapolate to a wild rate.
  const netBurnPerDayCents = Math.round(-summary.netCents / Math.max(1, sampleDays));

  const profitable = netBurnPerDayCents <= 0;
  const runwayDays = profitable
    ? Infinity
    : creditBalanceCents / netBurnPerDayCents;

  return {
    creditBalanceCents,
    netBurnPerDayCents,
    runwayDays,
    profitable,
  };
}

/**
 * Earnings grouped by service, best sellers first.
 */
export function getEarningsByService(
  db: DatabaseType,
  windowHours: number = 24 * 30,
): Array<{ serviceId: string | null; earnedCents: number; sales: number }> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const rows = db
    .prepare(
      `SELECT service_id, COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n
       FROM revenue_entries WHERE created_at >= ?
       GROUP BY service_id ORDER BY total DESC`,
    )
    .all(cutoff) as any[];
  return rows.map((r) => ({
    serviceId: r.service_id,
    earnedCents: r.total,
    sales: r.n,
  }));
}
