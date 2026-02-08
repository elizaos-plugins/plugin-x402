/**
 * Payment balance provider.
 *
 * Injects current payment state into the agent's context so that the LLM
 * is aware of the agent's spending and earning activity.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { X402Service } from "../services/x402-service";

import { ONE_DAY_MS, formatUsd, truncateAddress } from "../utils";

export const paymentBalanceProvider: Provider = {
  name: "x402_payment_status",
  description:
    "Current x402 payment status including wallet, spending, and earning summary",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ) => {
    const service = runtime.getService<X402Service>("x402_payment");

    if (!service || !service.isActive()) {
      return {
        text: "[Payment Status]\nPayments: Inactive (no wallet configured)",
        values: {
          x402Active: false,
        },
      };
    }

    const walletAddress = service.getWalletAddress();
    const network = service.getNetwork();

    const summary = await service.getSummary(ONE_DAY_MS);

    const netAmount = summary.totalEarned - summary.totalSpent;
    const netDisplay = netAmount < 0n
      ? `-${formatUsd(-netAmount)}`
      : `+${formatUsd(netAmount)}`;

    const statusLines = [
      "[Payment Status]",
      `Wallet: ${walletAddress ? truncateAddress(walletAddress) : "N/A"} (${network})`,
      `24h Spent: ${formatUsd(summary.totalSpent)} (${summary.outgoingCount} txns)`,
      `24h Earned: ${formatUsd(summary.totalEarned)} (${summary.incomingCount} txns)`,
      `Net: ${netDisplay}`,
      `Circuit Breaker: ${service.getCircuitBreakerState()}`,
    ];

    return {
      text: statusLines.join("\n"),
      values: {
        x402Active: true,
        x402Wallet: walletAddress ?? "",
        x402Network: network,
        x402TotalSpent: formatUsd(summary.totalSpent),
        x402TotalEarned: formatUsd(summary.totalEarned),
        x402OutgoingCount: summary.outgoingCount,
        x402IncomingCount: summary.incomingCount,
      },
    };
  },
};
