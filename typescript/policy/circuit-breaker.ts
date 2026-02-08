/** Circuit breaker: trips on excessive rate or anomalous amount, with cooldown/half-open probe. */

import type { CircuitBreakerConfig, CircuitState } from "../types";

/** Default circuit breaker configuration */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxPaymentsPerMinute: 50,
  anomalyMultiplier: 10,
  cooldownMs: 60_000,
  recentWindowSize: 20,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private config: CircuitBreakerConfig;

  private recentTimestamps: number[] = [];

  private recentAmounts: bigint[] = [];

  private trippedAt: number = 0;

  private lastTripReason: string = "";

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  check(amount: bigint): { allowed: boolean; reason: string } {
    const now = Date.now();

    // If open, check if cooldown has elapsed
    if (this.state === "open") {
      if (now - this.trippedAt >= this.config.cooldownMs) {
        this.state = "half-open";
      } else {
        return {
          allowed: false,
          reason: `Circuit breaker is OPEN: ${this.lastTripReason}. Resets in ${Math.ceil((this.config.cooldownMs - (now - this.trippedAt)) / 1000)}s`,
        };
      }
    }

    // Rate check: count payments in the last 60 seconds
    const oneMinuteAgo = now - 60_000;
    this.recentTimestamps = this.recentTimestamps.filter(
      (t) => t > oneMinuteAgo,
    );
    if (this.recentTimestamps.length >= this.config.maxPaymentsPerMinute) {
      this.trip(`Rate exceeded: ${this.recentTimestamps.length} payments in the last minute`);
      return { allowed: false, reason: this.lastTripReason };
    }

    // Anomaly check: compare against rolling average
    if (this.recentAmounts.length >= 3) {
      const sum = this.recentAmounts.reduce((a, b) => a + b, 0n);
      const avg = sum / BigInt(this.recentAmounts.length);
      if (avg > 0n && amount > avg * BigInt(this.config.anomalyMultiplier)) {
        this.trip(
          `Anomaly detected: payment of ${amount} is >${this.config.anomalyMultiplier}x the average of ${avg}`,
        );
        return { allowed: false, reason: this.lastTripReason };
      }
    }

    return { allowed: true, reason: "" };
  }

  recordSuccess(amount: bigint): void {
    const now = Date.now();
    this.recentTimestamps.push(now);

    // Maintain a sliding window of recent amounts
    this.recentAmounts.push(amount);
    if (this.recentAmounts.length > this.config.recentWindowSize) {
      this.recentAmounts.shift();
    }

    // Successful probe in half-open → close
    if (this.state === "half-open") {
      this.state = "closed";
      this.lastTripReason = "";
    }
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      this.trip("Probe payment failed in half-open state");
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getTripReason(): string {
    return this.lastTripReason;
  }

  reset(): void {
    this.state = "closed";
    this.lastTripReason = "";
    this.trippedAt = 0;
  }

  private trip(reason: string): void {
    this.state = "open";
    this.trippedAt = Date.now();
    this.lastTripReason = reason;
  }
}
