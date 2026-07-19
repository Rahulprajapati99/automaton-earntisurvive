/**
 * x402 Seller Gate
 *
 * The buyer side of x402 already exists in conway/x402.ts. This is the other
 * half: the automaton as merchant. It emits 402 Payment Required challenges
 * and verifies signed EIP-3009 TransferWithAuthorization payloads before any
 * work is performed.
 *
 * Verification is off-chain (signature recovery + nonce replay check).
 * Moving the money on-chain happens asynchronously in settlement.ts, so a
 * paying customer never waits on Base block times.
 */

import { parseSignature, recoverTypedDataAddress, type Address } from "viem";
import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ReceivedPaymentRow, X402PaymentPayload } from "./types.js";

type DatabaseType = BetterSqlite3.Database;

export const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

export const CHAIN_IDS: Record<string, number> = {
  "eip155:8453": 8453,
  "eip155:84532": 84532,
};

/** USDC has 6 decimals; 1 cent = 10^4 atomic units. */
export const ATOMIC_PER_CENT = 10_000n;

export interface PaymentChallenge {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: string;
    requiredDeadlineSeconds: number;
    usdcAddress: string;
  }>;
}

/**
 * Build the 402 response body for a service.
 * Emits x402Version 2 with atomic (6-decimal) amounts — unambiguous, and
 * parsed correctly by the buyer client in conway/x402.ts.
 */
export function buildPaymentChallenge(
  priceCents: number,
  payToAddress: string,
  network: string = "eip155:8453",
): PaymentChallenge {
  const usdcAddress = USDC_ADDRESSES[network];
  if (!usdcAddress) throw new Error(`Unsupported network: ${network}`);
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: (BigInt(priceCents) * ATOMIC_PER_CENT).toString(),
        payToAddress,
        requiredDeadlineSeconds: 300,
        usdcAddress,
      },
    ],
  };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  paymentId?: string;
  payer?: string;
  amountCents?: number;
}

function parsePayload(raw: string): X402PaymentPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch {
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const p = decoded as X402PaymentPayload;
  const auth = p?.payload?.authorization;
  if (
    !p?.payload?.signature ||
    !auth?.from ||
    !auth?.to ||
    !auth?.value ||
    !auth?.nonce ||
    auth?.validAfter === undefined ||
    auth?.validBefore === undefined
  ) {
    return null;
  }
  return p;
}

/**
 * Verify a signed payment authorization for a service request.
 *
 * Checks, in order: payload shape, network support, recipient, amount,
 * time window, EIP-712 signature recovery, and nonce replay. On success the
 * authorization is persisted as pending_settlement (which also burns the
 * nonce atomically via the UNIQUE constraint).
 */
export async function verifyAndStorePayment(
  db: DatabaseType,
  rawPaymentHeader: string,
  expected: {
    priceCents: number;
    payToAddress: string;
    serviceId: string;
    network?: string;
  },
): Promise<VerifyResult> {
  const payload = parsePayload(rawPaymentHeader);
  if (!payload) {
    return { ok: false, error: "Malformed X-Payment payload" };
  }

  const network = expected.network ?? "eip155:8453";
  if (payload.network !== network) {
    return { ok: false, error: `Wrong network: expected ${network}, got ${payload.network}` };
  }
  const usdcAddress = USDC_ADDRESSES[network];
  const chainId = CHAIN_IDS[network];
  if (!usdcAddress || !chainId) {
    return { ok: false, error: `Unsupported network: ${network}` };
  }
  if (payload.scheme !== "exact") {
    return { ok: false, error: `Unsupported scheme: ${payload.scheme}` };
  }

  const auth = payload.payload.authorization;

  if (auth.to.toLowerCase() !== expected.payToAddress.toLowerCase()) {
    return { ok: false, error: "Payment recipient does not match this automaton's address" };
  }

  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return { ok: false, error: "Non-numeric authorization fields" };
  }

  const requiredAtomic = BigInt(expected.priceCents) * ATOMIC_PER_CENT;
  if (value < requiredAtomic) {
    return {
      ok: false,
      error: `Insufficient payment: ${value} atomic USDC offered, ${requiredAtomic} required`,
    };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (validAfter > now) {
    return { ok: false, error: "Authorization not yet valid" };
  }
  // Require enough remaining validity to settle on-chain afterwards.
  if (validBefore < now + 30n) {
    return { ok: false, error: "Authorization expired or expires too soon" };
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
    return { ok: false, error: "Invalid nonce format" };
  }

  // Recover the signer of the EIP-712 TransferWithAuthorization message.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId,
        verifyingContract: usdcAddress,
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
        from: auth.from as Address,
        to: auth.to as Address,
        value,
        validAfter,
        validBefore,
        nonce: auth.nonce as `0x${string}`,
      },
      signature: payload.payload.signature,
    });
  } catch {
    return { ok: false, error: "Signature recovery failed" };
  }

  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false, error: "Signature does not match payer address" };
  }

  const amountCents = Number(value / ATOMIC_PER_CENT);
  const paymentId = ulid();
  try {
    db.prepare(
      `INSERT INTO x402_received_payments
         (id, nonce, payer, amount_cents, service_id, network, authorization_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_settlement')`,
    ).run(
      paymentId,
      auth.nonce.toLowerCase(),
      auth.from.toLowerCase(),
      amountCents,
      expected.serviceId,
      network,
      JSON.stringify(payload),
    );
  } catch (err: any) {
    // UNIQUE(nonce) violation = replay attempt
    if (String(err?.message || err).includes("UNIQUE")) {
      return { ok: false, error: "Payment nonce already used (replay rejected)" };
    }
    throw err;
  }

  return { ok: true, paymentId, payer: auth.from.toLowerCase(), amountCents };
}

export function getPaymentsByStatus(
  db: DatabaseType,
  status: ReceivedPaymentRow["status"],
  limit: number = 100,
): ReceivedPaymentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM x402_received_payments WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(status, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    nonce: r.nonce,
    payer: r.payer,
    amountCents: r.amount_cents,
    serviceId: r.service_id,
    network: r.network,
    authorizationJson: r.authorization_json,
    status: r.status,
    txHash: r.tx_hash,
    error: r.error,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  }));
}

export function markPaymentStatus(
  db: DatabaseType,
  id: string,
  status: ReceivedPaymentRow["status"],
  fields?: { txHash?: string; error?: string },
): void {
  db.prepare(
    `UPDATE x402_received_payments
     SET status = ?, tx_hash = COALESCE(?, tx_hash), error = ?,
         settled_at = CASE WHEN ? = 'settled' THEN datetime('now') ELSE settled_at END
     WHERE id = ?`,
  ).run(status, fields?.txHash ?? null, fields?.error ?? null, status, id);
}

export { parseSignature };
