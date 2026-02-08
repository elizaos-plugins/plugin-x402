/**
 * @elizaos/plugin-x402
 *
 * x402 HTTP payment protocol plugin for ElizaOS.
 * Enables agents to send and receive crypto payments (USDC on EVM chains)
 * using the x402 protocol standard.
 *
 * @see https://www.x402.org/
 */

import type {
  IAgentRuntime,
  Plugin,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";

import { checkPaymentHistoryAction } from "./actions/check-payment-history";
import { setPaymentPolicyAction } from "./actions/set-payment-policy";
import { payForServiceAction } from "./actions/pay-for-service";
import { paymentBalanceProvider } from "./providers/payment-balance";
import { agentCardRoute } from "./routes/agent-card";
import { X402Service } from "./services/x402-service";
import { formatUsd } from "./utils";

// Re-export public API
export { X402Service } from "./services/x402-service";
export { EvmPaymentSigner } from "./client/signer";
export { createFetchWithPayment } from "./client/fetch-with-payment";
export { createPaywallMiddleware } from "./middleware/paywall";
export {
  verifyPaymentWithFacilitator,
  settlePaymentWithFacilitator,
} from "./middleware/facilitator-client";
export { PolicyEngine } from "./policy/engine";
export { CircuitBreaker } from "./policy/circuit-breaker";
export { MemoryPaymentStorage } from "./storage/memory";
export { SqlitePaymentStorage } from "./storage/sqlite";
export { PostgresPaymentStorage } from "./storage/postgres";
export { NETWORK_REGISTRY, resolveNetwork, networkKeyFromCaip2 } from "./networks";
export { payForServiceAction } from "./actions/pay-for-service";
export { checkPaymentHistoryAction } from "./actions/check-payment-history";
export { setPaymentPolicyAction } from "./actions/set-payment-policy";
export { agentCardRoute } from "./routes/agent-card";
export { paymentBalanceProvider } from "./providers/payment-balance";
export { formatUsd, truncateAddress, usdToBaseUnits, ONE_DAY_MS } from "./utils";
export type * from "./types";

/** GET /x402/summary — Return 24h payment summary as JSON */
async function handleSummary(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = runtime.getService<X402Service>("x402_payment");
  if (!service || !service.isActive()) {
    res.status(503).json({ error: "x402 service not active" });
    return;
  }

  const summary = await service.getSummary();
  res.status(200).json({
    wallet: service.getWalletAddress() ?? "",
    network: service.getNetwork(),
    totalSpent: formatUsd(summary.totalSpent),
    totalSpentRaw: summary.totalSpent.toString(),
    totalEarned: formatUsd(summary.totalEarned),
    totalEarnedRaw: summary.totalEarned.toString(),
    outgoingCount: summary.outgoingCount,
    incomingCount: summary.incomingCount,
    windowMs: summary.windowMs,
    circuitBreaker: service.getCircuitBreakerState(),
  });
}

/** GET /x402/history — Return recent payment transactions */
async function handleHistory(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = runtime.getService<X402Service>("x402_payment");
  if (!service || !service.isActive()) {
    res.status(503).json({ error: "x402 service not active" });
    return;
  }

  const limitStr =
    (Array.isArray(req.query?.limit)
      ? req.query.limit[0]
      : req.query?.limit) ?? "20";
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 100);

  const transactions = await service.getRecentTransactions(limit);

  // Serialize BigInt amounts as strings for JSON transport
  const serialized = transactions.map((txn) => ({
    id: txn.id,
    direction: txn.direction,
    counterparty: txn.counterparty,
    amount: txn.amount.toString(),
    amountUsd: formatUsd(txn.amount),
    network: txn.network,
    txHash: txn.txHash,
    resource: txn.resource,
    status: txn.status,
    createdAt: txn.createdAt,
    metadata: txn.metadata,
  }));

  res.status(200).json({ transactions: serialized, count: serialized.length });
}

/** GET /x402/export — Export all payments as CSV */
async function handleExport(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = runtime.getService<X402Service>("x402_payment");
  if (!service || !service.isActive()) {
    res.status(503).json({ error: "x402 service not active" });
    return;
  }

  const transactions = await service.getRecentTransactions(10000);

  const csvHeader =
    "id,direction,counterparty,amount_base_units,amount_usd,network,tx_hash,resource,status,created_at";
  const csvRows = transactions.map(
    (txn) =>
      `${txn.id},${txn.direction},${txn.counterparty},${txn.amount.toString()},${formatUsd(txn.amount)},${txn.network},${txn.txHash},${escapeCSV(txn.resource)},${txn.status},${txn.createdAt}`,
  );

  const csv = [csvHeader, ...csvRows].join("\n");

  if (res.setHeader) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="x402-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
  }
  res.send(csv);
}

/** Escape a value for CSV (wrap in quotes if it contains commas or quotes) */
function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const x402Plugin: Plugin = {
  name: "x402",
  description:
    "x402 HTTP payment protocol - send and receive crypto payments (USDC on EVM chains)",

  config: {
    X402_PRIVATE_KEY: null,
    X402_NETWORK: null,
    X402_PAY_TO: null,
    X402_FACILITATOR_URL: null,
    X402_MAX_PAYMENT_USD: null,
    X402_MAX_TOTAL_USD: null,
    X402_ENABLED: null,
  },

  services: [X402Service],
  actions: [payForServiceAction, checkPaymentHistoryAction, setPaymentPolicyAction],
  providers: [paymentBalanceProvider],

  routes: [
    agentCardRoute,
    {
      type: "GET" as const,
      path: "/x402/summary",
      name: "x402-summary",
      public: false,
      handler: handleSummary,
    },
    {
      type: "GET" as const,
      path: "/x402/history",
      name: "x402-history",
      public: false,
      handler: handleHistory,
    },
    {
      type: "GET" as const,
      path: "/x402/export",
      name: "x402-export",
      public: false,
      handler: handleExport,
    },
  ],
};

export default x402Plugin;
