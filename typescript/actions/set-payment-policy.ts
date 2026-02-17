/**
 * Action: SET_PAYMENT_POLICY
 *
 * Allows the agent to manage its payment policies via natural language.
 * Supports setting per-transaction and daily limits, as well as
 * blocking/allowing specific recipient addresses.
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
import { usdToBaseUnits } from "../utils";

interface PolicyParams {
  maxPerPaymentUsd?: number;
  maxDailyUsd?: number;
  blockRecipient?: string;
  allowRecipient?: string;
}

export const setPaymentPolicyAction: Action = {
  name: "SET_PAYMENT_POLICY",
  description:
    "Manage payment policies for the x402 payment service. Set per-transaction limits, daily spending limits, or block/allow specific recipient addresses.",

  similes: [
    "set payment policy",
    "update payment limits",
    "change spending limit",
    "block recipient",
    "allow recipient",
    "set max payment",
    "set daily limit",
    "payment policy",
  ],

  parameters: [
    {
      name: "maxPerPaymentUsd",
      description:
        "Maximum amount in USD for a single outgoing payment (e.g. 5.0 for $5.00)",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "maxDailyUsd",
      description:
        "Maximum total USD spend per day (e.g. 50.0 for $50.00)",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "blockRecipient",
      description:
        "Ethereum address to add to the blocklist (payments to this address will be rejected)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "allowRecipient",
      description:
        "Ethereum address to add to the allowlist (when allowlist is non-empty, only listed addresses can receive payments)",
      required: false,
      schema: { type: "string" },
    },
  ],

        validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    	const __avTextRaw = typeof message?.content?.text === 'string' ? message.content.text : '';
    	const __avText = __avTextRaw.toLowerCase();
    	const __avKeywords = ['set', 'payment', 'policy'];
    	const __avKeywordOk =
    		__avKeywords.length > 0 &&
    		__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    	const __avRegex = new RegExp('\\b(?:set|payment|policy)\\b', 'i');
    	const __avRegexOk = __avRegex.test(__avText);
    	const __avSource = String(message?.content?.source ?? message?.source ?? '');
    	const __avExpectedSource = '';
    	const __avSourceOk = __avExpectedSource
    		? __avSource === __avExpectedSource
    		: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    	const __avOptions = options && typeof options === 'object' ? options : {};
    	const __avInputOk =
    		__avText.trim().length > 0 ||
    		Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
    		Boolean(message?.content && typeof message.content === 'object');

    	if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
    		return false;
    	}

    	const __avLegacyValidate = async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<X402Service>("x402_payment");
    return !!service && service.isActive();
  };
    	try {
    		return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    	} catch {
    		return false;
    	}
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
      logger.warn("[x402] SET_PAYMENT_POLICY: Service not available or inactive");
      if (callback) {
        await callback({
          text: "I'm unable to update payment policies right now. The x402 payment service is not configured or is inactive.",
          actions: [],
        });
      }
      return { success: false, error: "x402 service not available" };
    }

    // Extract parameters
    const rawParams = (
      options as Record<string, Record<string, unknown> | undefined> | undefined
    )?.parameters as PolicyParams | undefined;

    const maxPerPaymentUsd = rawParams?.maxPerPaymentUsd;
    const maxDailyUsd = rawParams?.maxDailyUsd;
    const blockRecipient = rawParams?.blockRecipient;
    const allowRecipient = rawParams?.allowRecipient;

    // Validate that at least one parameter was provided
    if (
      maxPerPaymentUsd === undefined &&
      maxDailyUsd === undefined &&
      !blockRecipient &&
      !allowRecipient
    ) {
      if (callback) {
        await callback({
          text: "Please specify at least one policy change: maxPerPaymentUsd, maxDailyUsd, blockRecipient, or allowRecipient.",
          actions: [],
        });
      }
      return { success: false, error: "No policy parameters provided" };
    }

    const changes: string[] = [];

    try {
      // Apply per-transaction limit
      if (maxPerPaymentUsd !== undefined) {
        if (maxPerPaymentUsd <= 0) {
          if (callback) {
            await callback({
              text: "maxPerPaymentUsd must be a positive number.",
              actions: [],
            });
          }
          return { success: false, error: "Invalid maxPerPaymentUsd" };
        }
        service.updatePolicy({
          outgoing: {
            maxPerTransaction: usdToBaseUnits(maxPerPaymentUsd),
          } as never,
        });
        changes.push(`Max per-payment limit set to $${maxPerPaymentUsd.toFixed(2)}`);
        logger.info(
          `[x402] SET_PAYMENT_POLICY: maxPerTransaction set to $${maxPerPaymentUsd}`,
        );
      }

      // Apply daily total limit
      if (maxDailyUsd !== undefined) {
        if (maxDailyUsd <= 0) {
          if (callback) {
            await callback({
              text: "maxDailyUsd must be a positive number.",
              actions: [],
            });
          }
          return { success: false, error: "Invalid maxDailyUsd" };
        }
        service.updatePolicy({
          outgoing: {
            maxTotal: usdToBaseUnits(maxDailyUsd),
          } as never,
        });
        changes.push(`Daily spending limit set to $${maxDailyUsd.toFixed(2)}`);
        logger.info(
          `[x402] SET_PAYMENT_POLICY: maxTotal (daily) set to $${maxDailyUsd}`,
        );
      }

      // Block a recipient
      if (blockRecipient) {
        service.updatePolicy({
          outgoing: {
            blockedRecipients: [blockRecipient],
          } as never,
        });
        changes.push(`Blocked recipient: ${blockRecipient}`);
        logger.info(
          `[x402] SET_PAYMENT_POLICY: blocked recipient ${blockRecipient}`,
        );
      }

      // Allow a recipient
      if (allowRecipient) {
        service.updatePolicy({
          outgoing: {
            allowedRecipients: [allowRecipient],
          } as never,
        });
        changes.push(`Added to allowlist: ${allowRecipient}`);
        logger.info(
          `[x402] SET_PAYMENT_POLICY: allowed recipient ${allowRecipient}`,
        );
      }

      const summary = changes.join("\n- ");
      if (callback) {
        await callback({
          text: `Payment policy updated:\n- ${summary}`,
          actions: [],
        });
      }

      return {
        success: true,
        text: `Payment policy updated: ${changes.join("; ")}`,
        data: {
          maxPerPaymentUsd: maxPerPaymentUsd ?? null,
          maxDailyUsd: maxDailyUsd ?? null,
          blockRecipient: blockRecipient ?? null,
          allowRecipient: allowRecipient ?? null,
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        `[x402] SET_PAYMENT_POLICY: Failed to update policy: ${errorMessage}`,
      );
      if (callback) {
        await callback({
          text: `Failed to update payment policy: ${errorMessage}`,
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
          text: "Set the maximum payment per transaction to $5",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "I'll set the per-transaction limit to $5.00.",
          actions: ["SET_PAYMENT_POLICY"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "user",
        content: {
          text: "Limit my daily spending to $50 and block payments to 0xDEAD...BEEF",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "I'll set the daily limit to $50 and block that address.",
          actions: ["SET_PAYMENT_POLICY"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "user",
        content: {
          text: "Allow payments only to 0x1234567890abcdef1234567890abcdef12345678",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "Adding that address to the payment allowlist.",
          actions: ["SET_PAYMENT_POLICY"],
        },
      } as ActionExample,
    ],
  ],
};
