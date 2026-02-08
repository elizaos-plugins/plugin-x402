/**
 * Action: Pay for an x402-protected service.
 *
 * Allows the agent to make a request to an x402-protected URL,
 * automatically handling payment if a 402 response is received.
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

export const payForServiceAction: Action = {
  name: "PAY_FOR_SERVICE",
  description:
    "Make a request to an x402-protected URL, automatically paying if required. Use when you need to access a paid API or service that uses the x402 payment protocol.",

  similes: [
    "pay for service",
    "x402 payment",
    "make a paid request",
    "access paid endpoint",
    "pay and fetch",
  ],

  parameters: [
    {
      name: "url",
      description: "The URL of the x402-protected service to access",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "method",
      description: "HTTP method (GET, POST, etc.). Defaults to GET.",
      required: false,
      schema: {
        type: "string",
        enumValues: ["GET", "POST", "PUT", "DELETE"],
      },
    },
    {
      name: "body",
      description: "Optional request body as a JSON string (for POST/PUT)",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<X402Service>("x402_payment");
    return !!service && service.canMakePayments();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService<X402Service>("x402_payment");

    if (!service || !service.canMakePayments()) {
      logger.warn("[x402] PAY_FOR_SERVICE: Service not available or inactive");
      if (callback) {
        await callback({
          text: "I'm unable to make payments right now. The x402 payment service is not configured or is inactive.",
          actions: [],
        });
      }
      return { success: false, error: "x402 service not available" };
    }

    // Extract parameters
    const params = (options as Record<string, Record<string, string> | undefined> | undefined)?.parameters;
    const url = params?.url ?? extractUrlFromMessage(message);
    const method = params?.method ?? "GET";
    const body = params?.body;

    if (!url) {
      logger.warn("[x402] PAY_FOR_SERVICE: No URL provided");
      if (callback) {
        await callback({
          text: "I need a URL to make the paid request. Please provide the URL of the service you want me to access.",
          actions: [],
        });
      }
      return { success: false, error: "No URL provided" };
    }

    logger.info(`[x402] PAY_FOR_SERVICE: Requesting ${method} ${url}`);

    const payFetch = service.getFetchWithPayment();

    try {
      const init: RequestInit = { method };
      if (body && (method === "POST" || method === "PUT")) {
        init.body = body;
        init.headers = { "Content-Type": "application/json" };
      }

      const response = await payFetch(url, init);
      const contentType = response.headers.get("content-type") ?? "";
      let responseText: string;

      if (contentType.includes("application/json")) {
        const json = await response.json();
        responseText = JSON.stringify(json, null, 2);
      } else {
        responseText = await response.text();
      }

      // Truncate very long responses
      const maxLen = 2000;
      const truncated =
        responseText.length > maxLen
          ? `${responseText.slice(0, maxLen)}...\n[Truncated - ${responseText.length} total characters]`
          : responseText;

      if (response.ok) {
        logger.info(
          `[x402] PAY_FOR_SERVICE: Success (${response.status}) from ${url}`,
        );
        if (callback) {
          await callback({
            text: `Successfully accessed ${url} (HTTP ${response.status}):\n\n${truncated}`,
            actions: [],
          });
        }
        return {
          success: true,
          text: `Payment and request successful for ${url}`,
          data: {
            status: response.status,
            url,
            responsePreview: truncated,
          },
        };
      } else {
        logger.warn(
          `[x402] PAY_FOR_SERVICE: Request returned ${response.status} from ${url}`,
        );
        if (callback) {
          await callback({
            text: `Request to ${url} returned HTTP ${response.status}:\n\n${truncated}`,
            actions: [],
          });
        }
        return {
          success: false,
          error: `HTTP ${response.status}`,
          data: {
            status: response.status,
            url,
            responsePreview: truncated,
          },
        };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        `[x402] PAY_FOR_SERVICE: Request failed: ${errorMessage}`,
      );
      if (callback) {
        await callback({
          text: `Failed to access ${url}: ${errorMessage}`,
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
          text: "Can you fetch the data from https://api.example.com/premium/data? It's a paid API.",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "I'll access that paid API for you now.",
          actions: ["PAY_FOR_SERVICE"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "user",
        content: {
          text: "Please make a paid request to https://weather.paid-api.com/forecast",
        },
      } as ActionExample,
      {
        name: "assistant",
        content: {
          text: "Making a paid request to the weather API.",
          actions: ["PAY_FOR_SERVICE"],
        },
      } as ActionExample,
    ],
  ],
};

/**
 * Attempt to extract a URL from the message text.
 */
function extractUrlFromMessage(message: Memory): string | undefined {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content?.text;

  if (!text) return undefined;

  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const matches = text.match(urlRegex);
  return matches?.[0];
}
