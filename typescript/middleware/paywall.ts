/** Paywall middleware — returns 402 or verifies X-PAYMENT header via facilitator. */

import { resolveNetwork } from "../networks";
import type {
  PaymentRequiredResponse,
  PaymentRequirement,
  PaymentStorage,
  PaywallConfig,
  PaywallMiddleware,
  PaywallRequest,
  PaywallResponse,
} from "../types";
import {
  settlePaymentWithFacilitator,
  verifyPaymentWithFacilitator,
} from "./facilitator-client";


export function createPaywallMiddleware(
  config: PaywallConfig,
  storage?: PaymentStorage,
  onStorageError?: (err: Error) => void,
): PaywallMiddleware {
  const networkInfo = resolveNetwork(config.network);

  // Pre-build the payment requirement template.
  // Uses "upto" scheme to match the facilitator's EVM verification.
  // Includes extra fields (name, version) so the client can reconstruct
  // the correct EIP-712 domain for the Permit signature.
  const requirementTemplate: PaymentRequirement = {
    scheme: "upto",
    network: networkInfo.caip2,
    maxAmountRequired: config.amount.toString(),
    resource: "",  // Will be set per-request
    description: config.description,
    mimeType: config.mimeType,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    asset: networkInfo.usdcAddress,
    extra: {
      name: networkInfo.usdcDomainName,
      version: networkInfo.usdcPermitVersion,
    },
  };

  return async (
    req: PaywallRequest,
    res: PaywallResponse,
    next: () => void,
  ): Promise<void> => {
    // Check for X-PAYMENT header (also accepted as "payment" by facilitator)
    const paymentHeader = getHeader(req, "x-payment");

    if (!paymentHeader) {
      // No payment provided — return 402 with requirements
      const resource = req.url ?? "/";
      const requirement = { ...requirementTemplate, resource };
      const paymentRequired: PaymentRequiredResponse = {
        x402Version: 2,
        accepts: [requirement],
      };

      const encoded = Buffer.from(
        JSON.stringify(paymentRequired),
      ).toString("base64");

      res
        .setHeader("Payment-Required", encoded)
        .setHeader("x-402", encoded)
        .status(402)
        .json({
          error: "Payment Required",
          message: config.description,
          x402Version: 2,
        });
      return;
    }

    // Build requirement for this request
    const requirement: PaymentRequirement = {
      ...requirementTemplate,
      resource: req.url ?? "/",
    };

    // Verify the payment with the facilitator
    const verifyResult = await verifyPaymentWithFacilitator(
      paymentHeader,
      config.facilitatorUrl,
      requirement,
    );

    if (!verifyResult.valid) {
      res.status(402).json({
        error: "Payment Invalid",
        reason: verifyResult.reason ?? "Payment verification failed",
      });
      return;
    }

    // Settle the payment
    const settleResult = await settlePaymentWithFacilitator(
      paymentHeader,
      config.facilitatorUrl,
      requirement,
    );

    // Record incoming payment if storage is provided
    if (storage && verifyResult.payer) {
      const id = `x402_in_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
      await storage
        .recordPayment({
          id,
          direction: "incoming",
          counterparty: verifyResult.payer,
          amount: config.amount,
          network: networkInfo.caip2,
          txHash: settleResult.txHash ?? "",
          resource: req.url ?? "/",
          status: settleResult.success ? "confirmed" : "pending",
          createdAt: new Date().toISOString(),
          metadata: {},
        })
        .catch((err: Error) => {
          if (onStorageError) {
            onStorageError(err);
          }
        });
    }

    // Set response headers with tx hash / session ID if available
    if (settleResult.txHash) {
      // Primary: x-upto-session-id for "upto" scheme
      res.setHeader("x-upto-session-id", settleResult.txHash);
      // Backward-compatible alias
      res.setHeader("X-PAYMENT-RESPONSE", settleResult.txHash);
    }

    // Payment verified — proceed to handler
    next();
  };
}

/** Case-insensitive header lookup. */
function getHeader(req: PaywallRequest, name: string): string | undefined {
  const headers = req.headers;
  const lowerName = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      if (Array.isArray(value)) {
        return value[0];
      }
      return value;
    }
  }

  return undefined;
}
