/**
 * Service Catalog
 *
 * What the automaton sells. Each service has a price in cents and a handler
 * that produces the deliverable. The catalog is stored in SQLite so the agent
 * can add, reprice, or retire services at runtime via tools.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { RevenueServiceRow, ServiceHandlerKind } from "./types.js";

type DatabaseType = BetterSqlite3.Database;

const VALID_HANDLERS: ServiceHandlerKind[] = ["inference", "echo"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Seed services: honest, deliverable-over-HTTP work priced in cents.
 * The agent can reprice or replace these; they exist so the storefront
 * has something to sell the moment it comes up.
 */
export const DEFAULT_SERVICES: Array<{
  id: string;
  name: string;
  description: string;
  priceCents: number;
  handler: ServiceHandlerKind;
  config: Record<string, unknown>;
}> = [
  {
    id: "summarize",
    name: "Text Summarization",
    description:
      "Send any text (article, doc, thread); get a tight, faithful summary back.",
    priceCents: 5,
    handler: "inference",
    config: {
      systemPrompt:
        "You are a summarization service. Summarize the user's text faithfully and concisely. Output only the summary.",
      maxInputChars: 40_000,
    },
  },
  {
    id: "code-review",
    name: "Code Review",
    description:
      "Send a diff or source file; get a review covering bugs, risks, and concrete fixes.",
    priceCents: 25,
    handler: "inference",
    config: {
      systemPrompt:
        "You are a code review service. Review the submitted code for correctness bugs, security issues, and improvements. Be specific and actionable. Output only the review.",
      maxInputChars: 60_000,
    },
  },
  {
    id: "extract-json",
    name: "Structured Data Extraction",
    description:
      "Send unstructured text plus a description of the fields you want; get clean JSON back.",
    priceCents: 10,
    handler: "inference",
    config: {
      systemPrompt:
        "You are a data extraction service. The user provides text and desired fields. Respond with only valid JSON containing the extracted fields. Use null for fields not present in the text.",
      maxInputChars: 40_000,
    },
  },
];

function rowToService(r: any): RevenueServiceRow {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(r.config || "{}");
  } catch {
    config = {};
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: r.price_cents,
    handler: VALID_HANDLERS.includes(r.handler) ? r.handler : "echo",
    config,
    enabled: r.enabled === 1,
    timesSold: r.times_sold,
    totalEarnedCents: r.total_earned_cents,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function upsertService(
  db: DatabaseType,
  service: {
    id: string;
    name: string;
    description?: string;
    priceCents: number;
    handler?: ServiceHandlerKind;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
): void {
  if (!SLUG_RE.test(service.id)) {
    throw new Error(
      `Invalid service id "${service.id}": must be a lowercase slug (a-z, 0-9, hyphens)`,
    );
  }
  if (!Number.isInteger(service.priceCents) || service.priceCents <= 0) {
    throw new Error(`Invalid price: ${service.priceCents} (must be a positive integer of cents)`);
  }
  const handler = service.handler ?? "inference";
  if (!VALID_HANDLERS.includes(handler)) {
    throw new Error(`Invalid handler "${handler}": must be one of ${VALID_HANDLERS.join(", ")}`);
  }
  db.prepare(
    `INSERT INTO revenue_services (id, name, description, price_cents, handler, config, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       price_cents = excluded.price_cents,
       handler = excluded.handler,
       config = excluded.config,
       enabled = excluded.enabled,
       updated_at = datetime('now')`,
  ).run(
    service.id,
    service.name,
    service.description ?? "",
    service.priceCents,
    handler,
    JSON.stringify(service.config ?? {}),
    (service.enabled ?? true) ? 1 : 0,
  );
}

export function getService(
  db: DatabaseType,
  id: string,
): RevenueServiceRow | undefined {
  const row = db
    .prepare(`SELECT * FROM revenue_services WHERE id = ?`)
    .get(id) as any | undefined;
  return row ? rowToService(row) : undefined;
}

export function listServices(
  db: DatabaseType,
  enabledOnly: boolean = false,
): RevenueServiceRow[] {
  const rows = (
    enabledOnly
      ? db.prepare(`SELECT * FROM revenue_services WHERE enabled = 1 ORDER BY id`)
      : db.prepare(`SELECT * FROM revenue_services ORDER BY id`)
  ).all() as any[];
  return rows.map(rowToService);
}

export function setServiceEnabled(
  db: DatabaseType,
  id: string,
  enabled: boolean,
): boolean {
  const result = db
    .prepare(
      `UPDATE revenue_services SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

/** Bump sales counters after a completed, paid request. */
export function recordSale(
  db: DatabaseType,
  id: string,
  amountCents: number,
): void {
  db.prepare(
    `UPDATE revenue_services
     SET times_sold = times_sold + 1,
         total_earned_cents = total_earned_cents + ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(amountCents, id);
}

/** Insert default services for any slug not already present. */
export function seedDefaultServices(db: DatabaseType): number {
  let seeded = 0;
  for (const svc of DEFAULT_SERVICES) {
    const existing = getService(db, svc.id);
    if (!existing) {
      upsertService(db, svc);
      seeded++;
    }
  }
  return seeded;
}
