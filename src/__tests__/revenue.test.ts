/**
 * Revenue Engine Tests
 *
 * Covers: income ledger math + runway, service catalog validation,
 * seller-side x402 verification (signature, amount, expiry, replay),
 * and the storefront's HTTP payment gate end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { createDatabase } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";
import {
  recordEarning,
  getRevenueSummary,
  estimateRunway,
  getEarningsByService,
} from "../revenue/ledger.js";
import {
  seedDefaultServices,
  upsertService,
  getService,
  listServices,
  setServiceEnabled,
  recordSale,
  DEFAULT_SERVICES,
} from "../revenue/catalog.js";
import {
  buildPaymentChallenge,
  verifyAndStorePayment,
  getPaymentsByStatus,
  markPaymentStatus,
  ATOMIC_PER_CENT,
  USDC_ADDRESSES,
  CHAIN_IDS,
} from "../revenue/x402-gate.js";
import { Storefront } from "../revenue/storefront.js";

let db: AutomatonDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-revenue-test-"));
  db = createDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Sign an EIP-3009 authorization the same way the buyer client does.
async function signAuthorization(
  account: PrivateKeyAccount,
  opts: {
    to: string;
    valueAtomic: bigint;
    network?: string;
    validBefore?: number;
    validAfter?: number;
    nonce?: `0x${string}`;
  },
): Promise<string> {
  const network = opts.network ?? "eip155:8453";
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(opts.validAfter ?? now - 60);
  const validBefore = BigInt(opts.validBefore ?? now + 300);
  const nonce =
    opts.nonce ??
    (`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`);

  const signature = await account.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: CHAIN_IDS[network],
      verifyingContract: USDC_ADDRESSES[network],
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: opts.to as `0x${string}`,
      value: opts.valueAtomic,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    x402Version: 2,
    scheme: "exact",
    network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: opts.to,
        value: opts.valueAtomic.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

const MERCHANT = "0x1111111111111111111111111111111111111111";

// ─── Ledger ─────────────────────────────────────────────────────

describe("revenue ledger", () => {
  it("records earnings and sums them in the summary window", () => {
    recordEarning(db.raw, { serviceId: "summarize", amountCents: 5, payer: "0xabc" });
    recordEarning(db.raw, { serviceId: "code-review", amountCents: 25 });
    const summary = getRevenueSummary(db.raw, 24);
    expect(summary.earnedCents).toBe(30);
    expect(summary.sales).toBe(2);
    expect(summary.netCents).toBe(30);
  });

  it("rejects non-positive and non-integer amounts", () => {
    expect(() => recordEarning(db.raw, { amountCents: 0 })).toThrow();
    expect(() => recordEarning(db.raw, { amountCents: -5 })).toThrow();
    expect(() => recordEarning(db.raw, { amountCents: 1.5 })).toThrow();
  });

  it("subtracts spend_tracking from net", () => {
    recordEarning(db.raw, { amountCents: 100 });
    const now = new Date();
    db.raw
      .prepare(
        `INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day)
         VALUES ('s1', 'inference', 40, 'inference', ?, ?)`,
      )
      .run(now.toISOString().slice(0, 13), now.toISOString().slice(0, 10));
    const summary = getRevenueSummary(db.raw, 24);
    expect(summary.spentCents).toBe(40);
    expect(summary.netCents).toBe(60);
  });

  it("estimates runway as profitable when net is positive", () => {
    recordEarning(db.raw, { amountCents: 500 });
    const runway = estimateRunway(db.raw, 1000);
    expect(runway.profitable).toBe(true);
    expect(runway.runwayDays).toBe(Infinity);
  });

  it("estimates finite runway when burning", () => {
    const now = new Date();
    db.raw
      .prepare(
        `INSERT INTO spend_tracking (id, tool_name, amount_cents, category, window_hour, window_day)
         VALUES ('s1', 'inference', 700, 'inference', ?, ?)`,
      )
      .run(now.toISOString().slice(0, 13), now.toISOString().slice(0, 10));
    // 700 cents over a 7-day sample = 100 cents/day; 1000 credits = 10 days
    const runway = estimateRunway(db.raw, 1000, 7);
    expect(runway.profitable).toBe(false);
    expect(runway.netBurnPerDayCents).toBe(100);
    expect(runway.runwayDays).toBeCloseTo(10, 5);
  });

  it("groups earnings by service, best sellers first", () => {
    recordEarning(db.raw, { serviceId: "a", amountCents: 10 });
    recordEarning(db.raw, { serviceId: "b", amountCents: 50 });
    recordEarning(db.raw, { serviceId: "a", amountCents: 10 });
    const grouped = getEarningsByService(db.raw);
    expect(grouped[0]).toMatchObject({ serviceId: "b", earnedCents: 50, sales: 1 });
    expect(grouped[1]).toMatchObject({ serviceId: "a", earnedCents: 20, sales: 2 });
  });
});

// ─── Catalog ────────────────────────────────────────────────────

describe("service catalog", () => {
  it("seeds default services exactly once", () => {
    expect(seedDefaultServices(db.raw)).toBe(DEFAULT_SERVICES.length);
    expect(seedDefaultServices(db.raw)).toBe(0);
    expect(listServices(db.raw)).toHaveLength(DEFAULT_SERVICES.length);
  });

  it("validates slug, price, and handler", () => {
    expect(() =>
      upsertService(db.raw, { id: "Bad Slug!", name: "x", priceCents: 5 }),
    ).toThrow(/slug/);
    expect(() =>
      upsertService(db.raw, { id: "ok", name: "x", priceCents: 0 }),
    ).toThrow(/price/i);
    expect(() =>
      upsertService(db.raw, {
        id: "ok",
        name: "x",
        priceCents: 5,
        handler: "shell" as any,
      }),
    ).toThrow(/handler/i);
  });

  it("upserts, disables, and records sales", () => {
    upsertService(db.raw, { id: "translate", name: "Translation", priceCents: 15 });
    upsertService(db.raw, { id: "translate", name: "Translation v2", priceCents: 20 });
    let svc = getService(db.raw, "translate")!;
    expect(svc.name).toBe("Translation v2");
    expect(svc.priceCents).toBe(20);

    recordSale(db.raw, "translate", 20);
    svc = getService(db.raw, "translate")!;
    expect(svc.timesSold).toBe(1);
    expect(svc.totalEarnedCents).toBe(20);

    expect(setServiceEnabled(db.raw, "translate", false)).toBe(true);
    expect(listServices(db.raw, true)).toHaveLength(0);
    expect(setServiceEnabled(db.raw, "nope", false)).toBe(false);
  });
});

// ─── x402 Seller Gate ───────────────────────────────────────────

describe("x402 seller gate", () => {
  it("builds a v2 challenge with atomic amounts", () => {
    const challenge = buildPaymentChallenge(25, MERCHANT);
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0].maxAmountRequired).toBe((25n * ATOMIC_PER_CENT).toString());
    expect(challenge.accepts[0].payToAddress).toBe(MERCHANT);
    expect(challenge.accepts[0].scheme).toBe("exact");
  });

  it("accepts a correctly signed payment and stores it pending settlement", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 25n * ATOMIC_PER_CENT,
    });
    const result = await verifyAndStorePayment(db.raw, header, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(true);
    expect(result.amountCents).toBe(25);
    expect(result.payer).toBe(payer.address.toLowerCase());

    const pending = getPaymentsByStatus(db.raw, "pending_settlement");
    expect(pending).toHaveLength(1);
    expect(pending[0].serviceId).toBe("code-review");
  });

  it("rejects underpayment", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 5n * ATOMIC_PER_CENT,
    });
    const result = await verifyAndStorePayment(db.raw, header, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient/);
  });

  it("rejects payment made out to a different recipient", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: "0x2222222222222222222222222222222222222222",
      valueAtomic: 25n * ATOMIC_PER_CENT,
    });
    const result = await verifyAndStorePayment(db.raw, header, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recipient/);
  });

  it("rejects expired authorizations", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 25n * ATOMIC_PER_CENT,
      validBefore: Math.floor(Date.now() / 1000) - 10,
    });
    const result = await verifyAndStorePayment(db.raw, header, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expire/i);
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 25n * ATOMIC_PER_CENT,
    });
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    // Inflate the value after signing
    payload.payload.authorization.value = (100n * ATOMIC_PER_CENT).toString();
    const tampered = Buffer.from(JSON.stringify(payload)).toString("base64");
    const result = await verifyAndStorePayment(db.raw, tampered, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/[Ss]ignature/);
  });

  it("rejects nonce replay", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 25n * ATOMIC_PER_CENT,
    });
    const expected = {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    };
    const first = await verifyAndStorePayment(db.raw, header, expected);
    expect(first.ok).toBe(true);
    const replay = await verifyAndStorePayment(db.raw, header, expected);
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/replay/i);
  });

  it("rejects malformed payloads", async () => {
    const result = await verifyAndStorePayment(db.raw, "not-a-payment", {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Malformed/);
  });

  it("updates payment status transitions", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 25n * ATOMIC_PER_CENT,
    });
    const result = await verifyAndStorePayment(db.raw, header, {
      priceCents: 25,
      payToAddress: MERCHANT,
      serviceId: "code-review",
    });
    markPaymentStatus(db.raw, result.paymentId!, "settled", { txHash: "0xdead" });
    const settled = getPaymentsByStatus(db.raw, "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0].txHash).toBe("0xdead");
    expect(settled[0].settledAt).toBeTruthy();
  });
});

// ─── Storefront HTTP ────────────────────────────────────────────

describe("storefront", () => {
  let storefront: Storefront;
  let baseUrl: string;

  beforeEach(async () => {
    upsertService(db.raw, {
      id: "echo",
      name: "Echo",
      description: "Returns your input",
      priceCents: 10,
      handler: "echo",
    });
    storefront = new Storefront({
      db: db.raw,
      payToAddress: MERCHANT,
      agentName: "test-automaton",
    });
    const port = await storefront.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await storefront.stop();
  });

  it("lists services on GET /", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.agent).toBe("test-automaton");
    expect(body.payTo).toBe(MERCHANT);
    expect(body.services).toHaveLength(1);
    expect(body.services[0].id).toBe("echo");
  });

  it("returns 402 with payment requirements when unpaid", async () => {
    const resp = await fetch(`${baseUrl}/services/echo`, {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
    });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as any;
    expect(body.accepts[0].maxAmountRequired).toBe((10n * ATOMIC_PER_CENT).toString());
    expect(body.accepts[0].payToAddress).toBe(MERCHANT);
  });

  it("serves the request when payment verifies, and stores it for settlement", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 10n * ATOMIC_PER_CENT,
    });
    const resp = await fetch(`${baseUrl}/services/echo`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: JSON.stringify({ input: "hello world" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.result).toBe("hello world");
    expect(getPaymentsByStatus(db.raw, "pending_settlement")).toHaveLength(1);
  });

  it("rejects bad payment with 402 and does not serve", async () => {
    const resp = await fetch(`${baseUrl}/services/echo`, {
      method: "POST",
      headers: { "X-Payment": "garbage" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as any;
    expect(body.error).toMatch(/Payment rejected/);
    expect(getPaymentsByStatus(db.raw, "pending_settlement")).toHaveLength(0);
  });

  it("404s unknown services and disabled services", async () => {
    setServiceEnabled(db.raw, "echo", false);
    const resp = await fetch(`${baseUrl}/services/echo`, {
      method: "POST",
      body: JSON.stringify({ input: "hi" }),
    });
    expect(resp.status).toBe(404);
    const missing = await fetch(`${baseUrl}/services/nope`, {
      method: "POST",
      body: JSON.stringify({ input: "hi" }),
    });
    expect(missing.status).toBe(404);
  });

  it("rejects requests without input", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const header = await signAuthorization(payer, {
      to: MERCHANT,
      valueAtomic: 10n * ATOMIC_PER_CENT,
    });
    const resp = await fetch(`${baseUrl}/services/echo`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    // Nonce must NOT be burned on a rejected request
    expect(getPaymentsByStatus(db.raw, "pending_settlement")).toHaveLength(0);
  });
});
