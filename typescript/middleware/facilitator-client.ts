/** Client for the x402 facilitator service (verify + settle). */

import type { FacilitatorVerifyResult, PaymentRequirement } from "../types";


function buildFacilitatorRequestBody(
  paymentProof: string,
  requirement: PaymentRequirement,
): string {
  // Decode the base64 payment proof back to JSON.
  // Try base64 first, then direct JSON, then give up with a clear error.
  let paymentPayload: Record<string, string | number | boolean | Record<string, string | number>>;
  try {
    const decoded = Buffer.from(paymentProof, "base64").toString("utf-8");
    paymentPayload = JSON.parse(decoded) as Record<string, string | number | boolean | Record<string, string | number>>;
  } catch {
    try {
      paymentPayload = JSON.parse(paymentProof) as Record<string, string | number | boolean | Record<string, string | number>>;
    } catch {
      throw new Error(
        "Payment proof is neither valid base64-encoded JSON nor direct JSON",
      );
    }
  }

  const paymentRequirements = {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.maxAmountRequired,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    extra: requirement.extra,
  };

  return JSON.stringify({ paymentPayload, paymentRequirements });
}


export async function verifyPaymentWithFacilitator(
  paymentProof: string,
  facilitatorUrl: string,
  requirement: PaymentRequirement,
): Promise<FacilitatorVerifyResult> {
  const url = new URL("/verify", facilitatorUrl);

  try {
    const body = buildFacilitatorRequestBody(paymentProof, requirement);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      return {
        valid: false,
        reason: `Facilitator returned ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as {
      isValid?: boolean;
      payer?: string;
      invalidReason?: string;
    };

    return {
      valid: result.isValid === true,
      payer: result.payer,
      reason: result.invalidReason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      reason: `Facilitator request failed: ${message}`,
    };
  }
}


export async function settlePaymentWithFacilitator(
  paymentProof: string,
  facilitatorUrl: string,
  requirement: PaymentRequirement,
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  const url = new URL("/settle", facilitatorUrl);

  try {
    const body = buildFacilitatorRequestBody(paymentProof, requirement);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      return {
        success: false,
        reason: `Facilitator returned ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as {
      success?: boolean;
      transaction?: string;
      network?: string;
      payer?: string;
      errorReason?: string;
    };

    return {
      success: result.success === true,
      txHash: result.transaction,
      reason: result.errorReason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      reason: `Facilitator request failed: ${message}`,
    };
  }
}
