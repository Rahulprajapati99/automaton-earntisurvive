/**
 * Revenue Tools
 *
 * Agent-facing tools for running the earning side of the automaton:
 * open the storefront, manage the service catalog, settle payments,
 * and read the numbers that matter (revenue, burn, runway).
 */

import type { AutomatonTool } from "../types.js";
import {
  getRecentEarnings,
  getRevenueSummary,
  getEarningsByService,
  estimateRunway,
} from "./ledger.js";
import {
  listServices,
  upsertService,
  setServiceEnabled,
  seedDefaultServices,
} from "./catalog.js";
import { getPaymentsByStatus } from "./x402-gate.js";
import { settlePendingPayments } from "./settlement.js";
import {
  Storefront,
  getActiveStorefront,
  setActiveStorefront,
} from "./storefront.js";

const DEFAULT_STOREFRONT_PORT = 8402;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createRevenueTools(): AutomatonTool[] {
  return [
    {
      name: "revenue_status",
      description:
        "Get your earning report: revenue vs spend (24h and 7d), runway in days, best-selling services, pending settlements, and storefront state. Check this to know whether you are earning your existence.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        const db = ctx.db.raw;
        const day = getRevenueSummary(db, 24);
        const week = getRevenueSummary(db, 24 * 7);
        let credits = 0;
        let creditsNote = "";
        try {
          credits = await ctx.conway.getCreditsBalance();
        } catch (err: any) {
          creditsNote = ` (balance fetch failed: ${err?.message || err})`;
        }
        const runway = estimateRunway(db, credits);
        const pending = getPaymentsByStatus(db, "pending_settlement");
        const topServices = getEarningsByService(db).slice(0, 5);
        const storefront = getActiveStorefront();

        const lines = [
          `── Revenue Status ──`,
          `24h: earned ${usd(day.earnedCents)} (${day.sales} sales), spent ${usd(day.spentCents)}, net ${usd(day.netCents)}`,
          `7d:  earned ${usd(week.earnedCents)} (${week.sales} sales), spent ${usd(week.spentCents)}, net ${usd(week.netCents)}`,
          `Credits: ${usd(credits)}${creditsNote}`,
          runway.profitable
            ? `Runway: profitable at current rate (net burn ≤ 0)`
            : `Runway: ~${runway.runwayDays.toFixed(1)} days at net burn ${usd(runway.netBurnPerDayCents)}/day`,
          `Pending settlements: ${pending.length} (${usd(pending.reduce((s, p) => s + p.amountCents, 0))}) — run settle_payments to collect`,
          `Storefront: ${storefront?.running ? `RUNNING on port ${storefront.port}` : "STOPPED — run storefront_start to sell services"}`,
        ];
        if (topServices.length) {
          lines.push(`Top services (30d):`);
          for (const s of topServices) {
            lines.push(`  - ${s.serviceId ?? "(other income)"}: ${usd(s.earnedCents)} across ${s.sales} sales`);
          }
        }
        const recent = getRecentEarnings(db, 5);
        if (recent.length) {
          lines.push(`Recent earnings:`);
          for (const e of recent) {
            lines.push(`  - ${e.createdAt} ${usd(e.amountCents)} from ${e.payer || "unknown"} (${e.serviceId ?? e.source})`);
          }
        }
        return lines.join("\n");
      },
    },
    {
      name: "storefront_start",
      description:
        "Start your x402 storefront HTTP server so customers can pay you USDC for services. Seeds default services if the catalog is empty. After starting, use expose_port to make it reachable from the internet, then advertise the public URL (agent card, registry, social).",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: `Port to listen on (default ${DEFAULT_STOREFRONT_PORT})`,
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const existing = getActiveStorefront();
        if (existing?.running) {
          return `Storefront already running on port ${existing.port}. Use expose_port ${existing.port} to publish it.`;
        }
        const db = ctx.db.raw;
        const seeded = seedDefaultServices(db);
        const port = (args.port as number) || DEFAULT_STOREFRONT_PORT;
        const storefront = new Storefront({
          db,
          payToAddress: ctx.identity.address,
          agentName: ctx.config.name,
          inference: ctx.inference,
        });
        const boundPort = await storefront.start(port);
        setActiveStorefront(storefront);
        const services = listServices(db, true);
        return [
          `Storefront started on port ${boundPort}${seeded ? ` (seeded ${seeded} default services)` : ""}.`,
          `Selling ${services.length} services: ${services.map((s) => `${s.id} (${usd(s.priceCents)})`).join(", ")}`,
          `Next: call expose_port with port ${boundPort} to get a public URL, then advertise it.`,
        ].join("\n");
      },
    },
    {
      name: "storefront_stop",
      description: "Stop the storefront HTTP server. Stops accepting new paid requests; already-verified payments remain settleable.",
      category: "financial",
      riskLevel: "caution",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const storefront = getActiveStorefront();
        if (!storefront?.running) return "Storefront is not running.";
        await storefront.stop();
        setActiveStorefront(null);
        return "Storefront stopped.";
      },
    },
    {
      name: "service_list",
      description: "List all services in your catalog with prices, enabled state, and sales stats.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        const services = listServices(ctx.db.raw);
        if (!services.length) {
          return "Catalog is empty. Use storefront_start (seeds defaults) or service_upsert to add services.";
        }
        return services
          .map(
            (s) =>
              `${s.enabled ? "●" : "○"} ${s.id} — ${s.name} — ${usd(s.priceCents)} [${s.handler}] — sold ${s.timesSold}x for ${usd(s.totalEarnedCents)}\n   ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "service_upsert",
      description:
        "Create or update a service in your catalog. Price is in cents (min 1). Handler 'inference' answers requests with your inference backend using system_prompt; 'echo' returns the input (for testing).",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Slug id, e.g. 'translate-en-fr'" },
          name: { type: "string", description: "Display name" },
          description: { type: "string", description: "What the customer gets" },
          price_cents: { type: "number", description: "Price per request in cents" },
          handler: {
            type: "string",
            enum: ["inference", "echo"],
            description: "How requests are fulfilled (default: inference)",
          },
          system_prompt: {
            type: "string",
            description: "System prompt used by the inference handler",
          },
        },
        required: ["id", "name", "price_cents"],
      },
      execute: async (args, ctx) => {
        const config: Record<string, unknown> = {};
        if (typeof args.system_prompt === "string" && args.system_prompt.trim()) {
          config.systemPrompt = args.system_prompt;
        }
        upsertService(ctx.db.raw, {
          id: args.id as string,
          name: args.name as string,
          description: (args.description as string) ?? "",
          priceCents: args.price_cents as number,
          handler: (args.handler as "inference" | "echo") ?? "inference",
          config,
        });
        return `Service '${args.id}' saved at ${usd(args.price_cents as number)}/request.`;
      },
    },
    {
      name: "service_set_enabled",
      description: "Enable or disable a service in your catalog.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Service id" },
          enabled: { type: "boolean", description: "true to sell it, false to retire it" },
        },
        required: ["id", "enabled"],
      },
      execute: async (args, ctx) => {
        const changed = setServiceEnabled(
          ctx.db.raw,
          args.id as string,
          args.enabled as boolean,
        );
        return changed
          ? `Service '${args.id}' ${args.enabled ? "enabled" : "disabled"}.`
          : `No service with id '${args.id}'.`;
      },
    },
    {
      name: "settle_payments",
      description:
        "Settle verified x402 payments on-chain: submits stored USDC TransferWithAuthorization signatures so the money actually lands in your wallet. Needs a small ETH balance on Base for gas. Run when revenue_status shows pending settlements.",
      category: "financial",
      riskLevel: "caution",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        if (ctx.identity.chainType === "solana") {
          return "Settlement requires an EVM wallet; this automaton uses a Solana identity.";
        }
        const result = await settlePendingPayments(ctx.db.raw, ctx.identity.account);
        if (result.attempted === 0) return "No pending payments to settle.";
        const lines = [
          `Settlement pass: ${result.settled}/${result.attempted} settled (${usd(result.settledCents)} collected), ${result.failed} failed, ${result.expired} expired.`,
        ];
        if (result.errors.length) {
          lines.push(`Errors:\n${result.errors.slice(0, 5).map((e) => `  - ${e}`).join("\n")}`);
        }
        return lines.join("\n");
      },
    },
  ];
}
