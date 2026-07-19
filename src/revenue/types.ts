/**
 * Revenue Engine Types
 *
 * Seller-side economy: the automaton earns by selling services over HTTP,
 * payment-gated with x402 (EIP-3009 TransferWithAuthorization on USDC).
 */

export type ServiceHandlerKind = "inference" | "echo";

export interface RevenueServiceRow {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  handler: ServiceHandlerKind;
  config: Record<string, unknown>;
  enabled: boolean;
  timesSold: number;
  totalEarnedCents: number;
  createdAt: string;
  updatedAt: string;
}

export type RevenueSource = "x402_storefront" | "transfer" | "manual";

export interface RevenueEntryRow {
  id: string;
  serviceId: string | null;
  amountCents: number;
  payer: string;
  source: RevenueSource;
  reference: string;
  createdAt: string;
}

export type ReceivedPaymentStatus =
  | "pending_settlement"
  | "settled"
  | "failed"
  | "expired";

export interface ReceivedPaymentRow {
  id: string;
  nonce: string;
  payer: string;
  amountCents: number;
  serviceId: string;
  network: string;
  authorizationJson: string;
  status: ReceivedPaymentStatus;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** Signed EIP-3009 authorization as received in the X-Payment header. */
export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

export interface RevenueSummary {
  /** Gross income over the window, cents. */
  earnedCents: number;
  /** Number of paid requests over the window. */
  sales: number;
  /** Total spend (inference + transfers + x402 purchases) over the window, cents. */
  spentCents: number;
  /** earnedCents - spentCents. */
  netCents: number;
  windowHours: number;
}

export interface RunwayEstimate {
  creditBalanceCents: number;
  /** Average net burn per day over the sample window, cents (positive = losing money). */
  netBurnPerDayCents: number;
  /** Days until credits hit zero at current net burn. Infinity if profitable. */
  runwayDays: number;
  profitable: boolean;
}
