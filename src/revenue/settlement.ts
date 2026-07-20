/**
 * Payment Settlement
 *
 * Verified authorizations are IOUs until the USDC actually moves. This module
 * submits stored EIP-3009 TransferWithAuthorization payloads to the USDC
 * contract on Base, pulling the funds into the automaton's wallet.
 *
 * Anyone may submit a transferWithAuthorization — the recipient pays gas, the
 * payer pays nothing extra. The automaton needs a small ETH balance on Base
 * for gas; settlement failures are recorded and retried on the next pass.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type BetterSqlite3 from "better-sqlite3";
import type { X402PaymentPayload } from "./types.js";
import { getPaymentsByStatus, markPaymentStatus, USDC_ADDRESSES } from "./x402-gate.js";
import { recordEarning } from "./ledger.js";
import { recordSale } from "./catalog.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;

const logger = createLogger("revenue.settlement");

const CHAINS: Record<string, typeof base | typeof baseSepolia> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface SettlementResult {
  attempted: number;
  settled: number;
  failed: number;
  expired: number;
  settledCents: number;
  errors: string[];
}

/**
 * Settle all pending payment authorizations on-chain.
 *
 * Ledger entries are written at settlement time (not verification time), so
 * revenue numbers only ever reflect money that actually arrived.
 */
export async function settlePendingPayments(
  db: DatabaseType,
  account: PrivateKeyAccount,
  options?: { rpcUrl?: string; maxPerRun?: number },
): Promise<SettlementResult> {
  const pending = getPaymentsByStatus(db, "pending_settlement", options?.maxPerRun ?? 25);
  const result: SettlementResult = {
    attempted: 0,
    settled: 0,
    failed: 0,
    expired: 0,
    settledCents: 0,
    errors: [],
  };

  for (const payment of pending) {
    result.attempted++;
    let payload: X402PaymentPayload;
    try {
      payload = JSON.parse(payment.authorizationJson);
    } catch {
      markPaymentStatus(db, payment.id, "failed", { error: "Corrupt stored authorization" });
      result.failed++;
      continue;
    }

    const auth = payload.payload.authorization;
    const now = Math.floor(Date.now() / 1000);
    if (Number(auth.validBefore) <= now) {
      markPaymentStatus(db, payment.id, "expired", {
        error: "Authorization deadline passed before settlement",
      });
      result.expired++;
      continue;
    }

    const chain = CHAINS[payment.network];
    const usdcAddress = USDC_ADDRESSES[payment.network];
    if (!chain || !usdcAddress) {
      markPaymentStatus(db, payment.id, "failed", {
        error: `Unsupported network: ${payment.network}`,
      });
      result.failed++;
      continue;
    }

    try {
      const rpcUrl = options?.rpcUrl || process.env.AUTOMATON_RPC_URL || undefined;
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl, { timeout: 30_000 }),
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, { timeout: 30_000 }),
      });

      const { v, r, s } = parseSignature(payload.payload.signature);

      const txHash = await walletClient.writeContract({
        address: usdcAddress as Address,
        abi: TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from as Address,
          auth.to as Address,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as `0x${string}`,
          Number(v ?? 27),
          r,
          s,
        ],
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000,
      });

      if (receipt.status !== "success") {
        markPaymentStatus(db, payment.id, "failed", {
          txHash,
          error: "Settlement transaction reverted",
        });
        result.failed++;
        result.errors.push(`${payment.id}: tx reverted (${txHash})`);
        continue;
      }

      markPaymentStatus(db, payment.id, "settled", { txHash });
      recordEarning(db, {
        serviceId: payment.serviceId,
        amountCents: payment.amountCents,
        payer: payment.payer,
        source: "x402_storefront",
        reference: txHash,
      });
      recordSale(db, payment.serviceId, payment.amountCents);
      result.settled++;
      result.settledCents += payment.amountCents;
      logger.info("Settled x402 payment", {
        paymentId: payment.id,
        amountCents: payment.amountCents,
        txHash,
      });
    } catch (err: any) {
      const message = err?.shortMessage || err?.message || String(err);
      // Leave as pending for retry on transient errors; the next pass
      // will expire it if the deadline lapses in the meantime.
      result.failed++;
      result.errors.push(`${payment.id}: ${message}`);
      logger.warn("Settlement attempt failed; will retry", {
        paymentId: payment.id,
        error: message,
      });
    }
  }

  return result;
}
