/**
 * Action: Check payment history.
 *
 * Allows the agent to review its x402 payment history,
 * including spending summaries and recent transactions.
 */

import type {
  Action,
  ActionExample,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { X402Service } from "../services/x402-service";

import { ONE_DAY_MS, formatUsd, truncateAddress } from "../utils";

export const checkPaymentHistoryAction: Action = {
  name: "CHECK_PAYMENT_HISTORY",
  description:
    "Check x402 payment history including spending summary and recent transactions. Use when asked about payment activity, spending, or earnings.",

  similes: [
    "check payments",
    "payment history",
    "spending summary",
    "how much have I spent",
    "payment transactions",
    "show payments",
  ],

  parameters: [
    {
      name: "limit",
      description: "Maximum number of recent transactions to show (default: 10)",
      required: false,
      schema: { type: "number" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<X402Service>("x402_payment");
    return !!service && service.isActive();
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService<X402Service>("x402_payment");

    if (!service || !service.isActive()) {
      logger.warn(
        "[x402] CHECK_PAYMENT_HISTORY: Service not available or inactive",
      );
      if (callback) {
        await callback({
          text: "Payment tracking is not active. The x402 payment service is not configured.",
          actions: [],
        });
      }
      return { success: false, error: "x402 service not available" };
    }

    const params = (options as Record<string, Record<string, string | number> | undefined> | undefined)?.parameters;
    const limit = typeof params?.limit === "number" ? params.limit : 10;

    try {
      // Get 24h summary
      const summary = await service.getSummary(ONE_DAY_MS);
      const recentTxns = await service.getRecentTransactions(limit);

      const lines: string[] = [];

      // Header
      const walletAddress = service.getWalletAddress();
      const network = service.getNetwork();
      lines.push(`**Payment Summary** (${network})`);
      lines.push(
        `Wallet: ${walletAddress ? truncateAddress(walletAddress) : "N/A"}`,
      );
      lines.push("");

      // 24h summary
      lines.push("**Last 24 Hours:**");
      lines.push(
        `- Spent: ${formatUsd(summary.totalSpent)} (${summary.outgoingCount} transactions)`,
      );
      lines.push(
        `- Earned: ${formatUsd(summary.totalEarned)} (${summary.incomingCount} transactions)`,
      );

      const net = summary.totalEarned - summary.totalSpent;
      const netDisplay =
        net < 0n ? `-${formatUsd(-net)}` : `+${formatUsd(net)}`;
      lines.push(`- Net: ${netDisplay}`);
      lines.push("");

      // Circuit breaker status
      lines.push(
        `Circuit Breaker: ${service.getCircuitBreakerState()}`,
      );
      lines.push("");

      // Recent transactions
      if (recentTxns.length > 0) {
        lines.push(`**Recent Transactions** (last ${recentTxns.length}):`);
        for (const txn of recentTxns) {
          const direction = txn.direction === "outgoing" ? "SENT" : "RECV";
          const counterpartyDisplay = truncateAddress(txn.counterparty);
          const time = new Date(txn.createdAt).toLocaleString();
          lines.push(
            `- [${direction}] ${formatUsd(txn.amount)} ${txn.direction === "outgoing" ? "to" : "from"} ${counterpartyDisplay} — ${txn.resource || "N/A"} (${time}) [${txn.status}]`,
          );
        }
      } else {
        lines.push("No recent transactions.");
      }

      const responseText = lines.join("\n");

      if (callback) {
        await callback({
          text: responseText,
          actions: [],
        });
      }

      return {
        success: true,
        text: responseText,
        data: {
          totalSpent: formatUsd(summary.totalSpent),
          totalEarned: formatUsd(summary.totalEarned),
          outgoingCount: summary.outgoingCount,
          incomingCount: summary.incomingCount,
          recentTransactionCount: recentTxns.length,
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        `[x402] CHECK_PAYMENT_HISTORY: Failed: ${errorMessage}`,
      );
      if (callback) {
        await callback({
          text: `Failed to retrieve payment history: ${errorMessage}`,
          actions: [],
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "How much have you spent today?",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "Let me check my payment history for today.",
          actions: ["CHECK_PAYMENT_HISTORY"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "user",
        content: {
          text: "Show me your recent payment transactions",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "Here are my recent x402 payment transactions.",
          actions: ["CHECK_PAYMENT_HISTORY"],
        },
      } as ActionExample,
    ],
  ],
};
