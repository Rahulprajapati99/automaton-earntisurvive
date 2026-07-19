/**
 * Revenue Engine
 *
 * The seller side of the automaton's economy: a service catalog, an
 * x402-payment-gated storefront, on-chain settlement, an income ledger,
 * and the heartbeat tasks that keep money flowing while the agent sleeps.
 */

export * from "./types.js";
export * from "./ledger.js";
export * from "./catalog.js";
export {
  buildPaymentChallenge,
  verifyAndStorePayment,
  getPaymentsByStatus,
  markPaymentStatus,
  USDC_ADDRESSES,
  ATOMIC_PER_CENT,
} from "./x402-gate.js";
export { settlePendingPayments } from "./settlement.js";
export {
  Storefront,
  getActiveStorefront,
  setActiveStorefront,
} from "./storefront.js";
export { createRevenueTools } from "./tools.js";
export { settleX402PaymentsTask, revenueReportTask } from "./tasks.js";
