/** In-memory PaymentStorage. Data lost on process exit. */

import type {
  PaymentDirection,
  PaymentFilters,
  PaymentRecord,
  PaymentStorage,
} from "../types";

export class MemoryPaymentStorage implements PaymentStorage {
  private records: PaymentRecord[] = [];

  async recordPayment(record: PaymentRecord): Promise<void> {
    // Deep copy to prevent external mutation from corrupting stored data.
    // metadata is the only nested reference type that needs cloning.
    this.records.push({
      ...record,
      metadata: { ...record.metadata },
    });
  }

  async getTotal(
    direction: PaymentDirection,
    windowMs?: number,
    scope?: string,
  ): Promise<bigint> {
    const cutoff = windowMs
      ? new Date(Date.now() - windowMs).toISOString()
      : undefined;

    let total = 0n;
    for (const r of this.records) {
      if (r.direction !== direction) continue;
      if (cutoff && r.createdAt < cutoff) continue;
      if (scope && r.counterparty !== scope) continue;
      if (r.status === "failed" || r.status === "refunded") continue;
      total += r.amount;
    }
    return total;
  }

  async getRecords(filters?: PaymentFilters): Promise<PaymentRecord[]> {
    let result = [...this.records];

    if (filters) {
      if (filters.direction) {
        result = result.filter((r) => r.direction === filters.direction);
      }
      if (filters.counterparty) {
        result = result.filter(
          (r) =>
            r.counterparty.toLowerCase() ===
            filters.counterparty!.toLowerCase(),
        );
      }
      if (filters.status) {
        result = result.filter((r) => r.status === filters.status);
      }
      if (filters.network) {
        result = result.filter((r) => r.network === filters.network);
      }
      if (filters.since) {
        result = result.filter((r) => r.createdAt >= filters.since!);
      }
      if (filters.until) {
        result = result.filter((r) => r.createdAt <= filters.until!);
      }
    }

    // Sort newest first
    result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  async getCount(
    direction: PaymentDirection,
    windowMs?: number,
  ): Promise<number> {
    const cutoff = windowMs
      ? new Date(Date.now() - windowMs).toISOString()
      : undefined;

    let count = 0;
    for (const r of this.records) {
      if (r.direction !== direction) continue;
      if (cutoff && r.createdAt < cutoff) continue;
      if (r.status === "failed" || r.status === "refunded") continue;
      count++;
    }
    return count;
  }

  async clear(): Promise<void> {
    this.records = [];
  }
}
