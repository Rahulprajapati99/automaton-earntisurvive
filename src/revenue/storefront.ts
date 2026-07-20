/**
 * Revenue Storefront
 *
 * An HTTP server that sells the automaton's services to anyone — human or
 * agent — over the open internet, paid per request via x402.
 *
 * Flow per sale:
 *   POST /services/:id without payment  -> 402 + payment requirements
 *   POST /services/:id with X-Payment   -> verify signature off-chain,
 *                                          do the work, return the result
 *   heartbeat settlement pass           -> move the USDC on-chain
 *
 * Zero new dependencies: node:http only. The automaton exposes the port with
 * its existing expose_port tool to go public.
 */

import http from "node:http";
import type BetterSqlite3 from "better-sqlite3";
import type { InferenceClient } from "../types.js";
import type { RevenueServiceRow } from "./types.js";
import { getService, listServices } from "./catalog.js";
import { buildPaymentChallenge, verifyAndStorePayment } from "./x402-gate.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;

const logger = createLogger("revenue.storefront");

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_INPUT_CHARS = 40_000;

export interface StorefrontOptions {
  db: DatabaseType;
  /** Automaton wallet address — where payments must be made out to. */
  payToAddress: string;
  /** Automaton display name, shown on the index page. */
  agentName: string;
  network?: string;
  inference?: InferenceClient;
}

export class Storefront {
  private server: http.Server | null = null;
  private readonly db: DatabaseType;
  private readonly payToAddress: string;
  private readonly agentName: string;
  private readonly network: string;
  private readonly inference?: InferenceClient;
  private boundPort: number | null = null;

  constructor(options: StorefrontOptions) {
    this.db = options.db;
    this.payToAddress = options.payToAddress;
    this.agentName = options.agentName;
    this.network = options.network ?? "eip155:8453";
    this.inference = options.inference;
  }

  get port(): number | null {
    return this.boundPort;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(port: number): Promise<number> {
    if (this.server) {
      throw new Error(`Storefront already running on port ${this.boundPort}`);
    }
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        logger.error(
          "Unhandled storefront error",
          err instanceof Error ? err : new Error(String(err)),
        );
        if (!res.headersSent) {
          this.json(res, 500, { error: "Internal error" });
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    const address = server.address();
    this.boundPort =
      typeof address === "object" && address ? address.port : port;
    logger.info("Storefront listening", { port: this.boundPort });
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", () => resolve(null));
    });
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/" || path === "/services")) {
      const services = listServices(this.db, true).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        priceCents: s.priceCents,
        priceUsd: (s.priceCents / 100).toFixed(2),
        endpoint: `/services/${s.id}`,
      }));
      this.json(res, 200, {
        agent: this.agentName,
        payTo: this.payToAddress,
        network: this.network,
        protocol: "x402",
        usage:
          "POST /services/{id} with a JSON body {\"input\": \"...\"}. First call returns 402 with payment requirements; retry with a signed X-Payment header.",
        services,
      });
      return;
    }

    const serviceMatch = path.match(/^\/services\/([a-z0-9-]+)$/);
    if (serviceMatch && req.method === "POST") {
      await this.handleServiceRequest(req, res, serviceMatch[1]);
      return;
    }

    this.json(res, 404, { error: "Not found. GET / lists available services." });
  }

  private async handleServiceRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    serviceId: string,
  ): Promise<void> {
    const service = getService(this.db, serviceId);
    if (!service || !service.enabled) {
      this.json(res, 404, { error: `Unknown service: ${serviceId}` });
      return;
    }

    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader || typeof paymentHeader !== "string") {
      this.json(
        res,
        402,
        buildPaymentChallenge(service.priceCents, this.payToAddress, this.network),
      );
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.json(res, 413, { error: `Body too large (max ${MAX_BODY_BYTES} bytes)` });
      return;
    }

    let input = "";
    try {
      const parsed = JSON.parse(body || "{}");
      input = typeof parsed.input === "string" ? parsed.input : "";
    } catch {
      this.json(res, 400, { error: "Body must be JSON: {\"input\": \"...\"}" });
      return;
    }
    if (!input.trim()) {
      this.json(res, 400, { error: "Missing \"input\" field in request body" });
      return;
    }
    const maxChars =
      typeof service.config.maxInputChars === "number"
        ? service.config.maxInputChars
        : DEFAULT_MAX_INPUT_CHARS;
    if (input.length > maxChars) {
      this.json(res, 400, {
        error: `Input too long for this service (max ${maxChars} chars)`,
      });
      return;
    }

    // Verify payment BEFORE doing any work.
    const verification = await verifyAndStorePayment(this.db, paymentHeader, {
      priceCents: service.priceCents,
      payToAddress: this.payToAddress,
      serviceId: service.id,
      network: this.network,
    });
    if (!verification.ok) {
      this.json(res, 402, {
        error: `Payment rejected: ${verification.error}`,
        ...buildPaymentChallenge(service.priceCents, this.payToAddress, this.network),
      });
      return;
    }

    let output: string;
    try {
      output = await this.runHandler(service, input);
    } catch (err: any) {
      // Work failed after payment verification: void the authorization so
      // settlement never pulls money for undelivered work.
      const { markPaymentStatus } = await import("./x402-gate.js");
      markPaymentStatus(this.db, verification.paymentId!, "failed", {
        error: `Service execution failed: ${err?.message || String(err)}`,
      });
      this.json(res, 500, {
        error: "Service execution failed; your payment will not be settled.",
      });
      return;
    }

    logger.info("Paid request served", {
      serviceId: service.id,
      payer: verification.payer,
      amountCents: verification.amountCents,
    });
    this.json(res, 200, {
      ok: true,
      service: service.id,
      paymentId: verification.paymentId,
      result: output,
    });
  }

  private async runHandler(
    service: RevenueServiceRow,
    input: string,
  ): Promise<string> {
    switch (service.handler) {
      case "inference": {
        if (!this.inference) {
          throw new Error("Inference backend unavailable");
        }
        const systemPrompt =
          typeof service.config.systemPrompt === "string"
            ? service.config.systemPrompt
            : `You provide the "${service.name}" service: ${service.description}. Respond with only the deliverable.`;
        const response = await this.inference.chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: input },
          ],
          { maxTokens: 2048, temperature: 0.2 },
        );
        const content = response.message?.content?.trim();
        if (!content) throw new Error("Empty inference response");
        return content;
      }
      case "echo":
        return input;
      default:
        throw new Error(`Unknown handler: ${service.handler}`);
    }
  }
}

// ─── Runtime singleton ────────────────────────────────────────────
// The agent starts/stops the storefront via tools; one instance per process.

let activeStorefront: Storefront | null = null;

export function getActiveStorefront(): Storefront | null {
  return activeStorefront;
}

export function setActiveStorefront(storefront: Storefront | null): void {
  activeStorefront = storefront;
}
