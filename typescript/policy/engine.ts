/** Payment policy engine. First violation blocks. */

import type {
  IncomingPaymentRequest,
  OutgoingPaymentRequest,
  PaymentPolicy,
  PaymentStorage,
  PolicyResult,
} from "../types";

const ALLOW: PolicyResult = { allowed: true, reason: "" };

function deny(reason: string): PolicyResult {
  return { allowed: false, reason };
}

export class PolicyEngine {
  private policy: PaymentPolicy;
  private storage: PaymentStorage;

  constructor(policy: PaymentPolicy, storage: PaymentStorage) {
    this.policy = policy;
    this.storage = storage;
  }

  updatePolicy(partial: Partial<PaymentPolicy>): void {
    if (partial.outgoing) {
      this.policy.outgoing = { ...this.policy.outgoing, ...partial.outgoing };
    }
    if (partial.incoming) {
      this.policy.incoming = { ...this.policy.incoming, ...partial.incoming };
    }
  }

  getPolicy(): PaymentPolicy {
    return {
      outgoing: { ...this.policy.outgoing },
      incoming: { ...this.policy.incoming },
    };
  }

  async evaluateOutgoing(
    request: OutgoingPaymentRequest,
  ): Promise<PolicyResult> {
    const limits = this.policy.outgoing;

    // 1. Per-transaction limit
    if (request.amount > limits.maxPerTransaction) {
      return deny(
        `Amount ${request.amount} exceeds per-transaction limit of ${limits.maxPerTransaction}`,
      );
    }

    // 2. Blocked recipients
    if (limits.blockedRecipients.length > 0) {
      const normalized = request.recipient.toLowerCase();
      if (
        limits.blockedRecipients.some(
          (addr) => addr.toLowerCase() === normalized,
        )
      ) {
        return deny(`Recipient ${request.recipient} is blocked`);
      }
    }

    // 3. Allowed recipients (whitelist mode)
    if (limits.allowedRecipients.length > 0) {
      const normalized = request.recipient.toLowerCase();
      if (
        !limits.allowedRecipients.some(
          (addr) => addr.toLowerCase() === normalized,
        )
      ) {
        return deny(`Recipient ${request.recipient} is not in the allow list`);
      }
    }

    // 4. Total within time window
    const currentTotal = await this.storage.getTotal(
      "outgoing",
      limits.windowMs,
    );
    if (currentTotal + request.amount > limits.maxTotal) {
      return deny(
        `Total spend would be ${currentTotal + request.amount}, exceeding window limit of ${limits.maxTotal}`,
      );
    }

    // 5. Transaction count within time window
    const currentCount = await this.storage.getCount(
      "outgoing",
      limits.windowMs,
    );
    if (currentCount >= limits.maxTransactions) {
      return deny(
        `Transaction count ${currentCount} has reached the limit of ${limits.maxTransactions}`,
      );
    }

    return ALLOW;
  }

  async evaluateIncoming(
    request: IncomingPaymentRequest,
  ): Promise<PolicyResult> {
    const limits = this.policy.incoming;

    // 1. Minimum per-transaction
    if (request.amount < limits.minPerTransaction) {
      return deny(
        `Amount ${request.amount} is below minimum of ${limits.minPerTransaction}`,
      );
    }

    // 2. Blocked senders
    if (limits.blockedSenders.length > 0) {
      const normalized = request.sender.toLowerCase();
      if (
        limits.blockedSenders.some(
          (addr) => addr.toLowerCase() === normalized,
        )
      ) {
        return deny(`Sender ${request.sender} is blocked`);
      }
    }

    // 3. Allowed senders (whitelist mode)
    if (limits.allowedSenders.length > 0) {
      const normalized = request.sender.toLowerCase();
      if (
        !limits.allowedSenders.some(
          (addr) => addr.toLowerCase() === normalized,
        )
      ) {
        return deny(`Sender ${request.sender} is not in the allow list`);
      }
    }

    return ALLOW;
  }
}
