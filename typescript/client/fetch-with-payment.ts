/** Fetch wrapper that handles 402 Payment Required by signing and retrying. */

import type { CircuitBreaker } from "../policy/circuit-breaker";
import type { PolicyEngine } from "../policy/engine";
import type {
  PaymentRecord,
  PaymentRequiredResponse,
  PaymentRequirement,
  PaymentSigner,
  PaymentStorage,
} from "../types";

/** Logger interface matching ElizaOS logger shape */
interface Logger {
  info(msg: string): void;
  info(obj: Record<string, string | number | boolean>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, string | number | boolean>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, string | number | boolean>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, string | number | boolean>, msg: string): void;
}

export interface FetchWithPaymentOptions {
  signer: PaymentSigner;
  policyEngine: PolicyEngine;
  circuitBreaker: CircuitBreaker;
  storage: PaymentStorage;
  logger: Logger;
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `x402_${timestamp}_${random}`;
}

function parsePaymentRequired(
  response: Response,
): PaymentRequiredResponse | null {
  // The facilitator middleware sends the payment requirement as:
  //   - "payment-required" header (primary in x402 v2)
  //   - "x-402" header (backward-compatible alias)
  //   - "x-payment-required" header (legacy alias)
  // Fetch API Headers.get() is case-insensitive per spec.
  const headerValue =
    response.headers.get("payment-required") ??
    response.headers.get("x-402") ??
    response.headers.get("x-payment-required");

  if (!headerValue) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    return JSON.parse(decoded) as PaymentRequiredResponse;
  } catch {
    // Try direct JSON parse (some servers may not base64-encode)
    try {
      return JSON.parse(headerValue) as PaymentRequiredResponse;
    } catch {
      return null;
    }
  }
}

/** Select a payment option matching our network. */
function selectPaymentOption(
  accepts: PaymentRequirement[],
  signerNetworkId: string,
): PaymentRequirement | null {
  // Only select options that match our network — never fall back to
  // a different chain, as that would produce invalid signatures
  const matching = accepts.find((a) => a.network === signerNetworkId);
  return matching ?? null;
}

/** A fetch-compatible function that also handles x402 402 responses. */
export type X402Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createFetchWithPayment(
  options: FetchWithPaymentOptions,
): X402Fetch {
  const { signer, policyEngine, circuitBreaker, storage, logger } = options;

  return async function fetchWithPayment(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Make the initial request
    logger.debug(`[x402] Making request to ${url}`);
    const initialResponse = await fetch(input, init);

    // If not 402, return as-is
    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    logger.info(`[x402] Received 402 Payment Required from ${url}`);

    // Parse the payment requirement
    const paymentRequired = parsePaymentRequired(initialResponse);
    if (!paymentRequired) {
      logger.error(
        "[x402] Could not parse payment requirement header from 402 response",
      );
      return initialResponse;
    }

    if (
      !paymentRequired.accepts ||
      paymentRequired.accepts.length === 0
    ) {
      logger.error("[x402] No payment options in 402 response");
      return initialResponse;
    }

    // Select a payment option
    const requirement = selectPaymentOption(
      paymentRequired.accepts,
      signer.networkId,
    );
    if (!requirement) {
      logger.error("[x402] No compatible payment option found");
      return initialResponse;
    }

    const amount = BigInt(requirement.maxAmountRequired);
    logger.info(
      `[x402] Payment required: ${amount} to ${requirement.payTo} on ${requirement.network}`,
    );

    // Check policy BEFORE signing
    const policyResult = await policyEngine.evaluateOutgoing({
      amount,
      recipient: requirement.payTo,
      resource: url,
    });

    if (!policyResult.allowed) {
      logger.warn(`[x402] Payment blocked by policy: ${policyResult.reason}`);
      return initialResponse;
    }

    // Check circuit breaker
    const breakerResult = circuitBreaker.check(amount);
    if (!breakerResult.allowed) {
      logger.warn(
        `[x402] Payment blocked by circuit breaker: ${breakerResult.reason}`,
      );
      return initialResponse;
    }

    // Sign the payment
    let paymentHeader: string;
    try {
      paymentHeader = await signer.buildPaymentHeader(requirement);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      logger.error(`[x402] Failed to sign payment: ${message}`);
      circuitBreaker.recordFailure();
      return initialResponse;
    }

    // Retry request with payment header.
    // "X-PAYMENT" is an accepted alias for "Payment" in the facilitator middleware.
    logger.info("[x402] Retrying request with X-PAYMENT header");
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("X-PAYMENT", paymentHeader);

    const retryInit: RequestInit = {
      ...init,
      headers: retryHeaders,
    };

    let retryResponse: Response;
    try {
      retryResponse = await fetch(input, retryInit);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      logger.error(`[x402] Retry request failed: ${message}`);
      circuitBreaker.recordFailure();
      return initialResponse;
    }

    // Read session ID for "upto" scheme (primary response header)
    // and fall back to legacy X-PAYMENT-RESPONSE for backward compatibility.
    const sessionId =
      retryResponse.headers.get("x-upto-session-id") ??
      retryResponse.headers.get("X-PAYMENT-RESPONSE") ??
      "";

    // Record the payment
    const record: PaymentRecord = {
      id: generateId(),
      direction: "outgoing",
      counterparty: requirement.payTo,
      amount,
      network: requirement.network,
      txHash: sessionId,
      resource: url,
      status: retryResponse.ok ? "confirmed" : "failed",
      createdAt: new Date().toISOString(),
      metadata: {
        scheme: requirement.scheme,
        description: requirement.description,
      },
    };

    try {
      await storage.recordPayment(record);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      logger.error(`[x402] Failed to record payment: ${message}`);
    }

    if (retryResponse.ok) {
      circuitBreaker.recordSuccess(amount);
      logger.info(
        `[x402] Payment successful: ${amount} to ${requirement.payTo}`,
      );
    } else {
      circuitBreaker.recordFailure();
      logger.warn(
        `[x402] Payment request returned ${retryResponse.status} after payment`,
      );
    }

    return retryResponse;
  };
}
