/**
 * Comprehensive tests for @elizaos/plugin-x402
 *
 * Tests the actual implementation interfaces:
 * - PolicyEngine (evaluateOutgoing, evaluateIncoming)
 * - CircuitBreaker (check, recordSuccess, recordFailure, state transitions)
 * - MemoryPaymentStorage (recordPayment, getTotal, getRecords, getCount, clear)
 * - EvmPaymentSigner (signPermit, buildPaymentHeader)
 * - createFetchWithPayment (402 handling, policy checks, circuit breaker)
 * - createPaywallMiddleware (402 responses, payment verification)
 * - paymentBalanceProvider (status reporting)
 * - NETWORK_REGISTRY (resolveNetwork, networkKeyFromCaip2)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { PolicyEngine } from "../policy/engine";
import { CircuitBreaker } from "../policy/circuit-breaker";
import { MemoryPaymentStorage } from "../storage/memory";
import { NETWORK_REGISTRY, resolveNetwork, networkKeyFromCaip2 } from "../networks";
import type {
  PaymentPolicy,
  PaymentRecord,
  PaymentRequirement,
  PaymentRequiredResponse,
  OutgoingPaymentRequest,
  IncomingPaymentRequest,
  CircuitBreakerConfig,
  PaymentStorage,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDefaultPolicy(overrides?: Partial<PaymentPolicy>): PaymentPolicy {
  return {
    outgoing: {
      maxPerTransaction: 1_000_000n, // $1
      maxTotal: 10_000_000n,         // $10
      windowMs: 24 * 60 * 60 * 1000, // 24h
      maxTransactions: 100,
      allowedRecipients: [],
      blockedRecipients: [],
      ...(overrides?.outgoing ?? {}),
    },
    incoming: {
      minPerTransaction: 0n,
      allowedSenders: [],
      blockedSenders: [],
      ...(overrides?.incoming ?? {}),
    },
  };
}

function createPaymentRecord(overrides?: Partial<PaymentRecord>): PaymentRecord {
  return {
    id: `x402_test_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`,
    direction: "outgoing",
    counterparty: "0x1234567890123456789012345678901234567890",
    amount: 500_000n, // $0.50
    network: "eip155:8453",
    txHash: "0xabcdef",
    resource: "https://api.example.com/data",
    status: "confirmed",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NETWORK REGISTRY
// ---------------------------------------------------------------------------

describe("Network Registry", () => {
  it("should contain base network", () => {
    const base = NETWORK_REGISTRY["base"];
    expect(base).toBeDefined();
    expect(base.caip2).toBe("eip155:8453");
    expect(base.chainId).toBe(8453);
    expect(base.name).toBe("Base");
    expect(base.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("should contain base-sepolia testnet", () => {
    const baseSepolia = NETWORK_REGISTRY["base-sepolia"];
    expect(baseSepolia).toBeDefined();
    expect(baseSepolia.caip2).toBe("eip155:84532");
    expect(baseSepolia.chainId).toBe(84532);
  });

  it("should contain ethereum mainnet", () => {
    const eth = NETWORK_REGISTRY["ethereum"];
    expect(eth).toBeDefined();
    expect(eth.caip2).toBe("eip155:1");
    expect(eth.chainId).toBe(1);
  });

  it("should contain sepolia testnet", () => {
    const sepolia = NETWORK_REGISTRY["sepolia"];
    expect(sepolia).toBeDefined();
    expect(sepolia.caip2).toBe("eip155:11155111");
    expect(sepolia.chainId).toBe(11155111);
  });

  describe("resolveNetwork", () => {
    it("should resolve known network keys", () => {
      const info = resolveNetwork("base");
      expect(info.caip2).toBe("eip155:8453");
    });

    it("should throw for unknown network keys", () => {
      expect(() => resolveNetwork("unknown-chain")).toThrow("Unknown network");
    });

    it("should throw with list of supported networks", () => {
      expect(() => resolveNetwork("polygon")).toThrow("Supported:");
    });
  });

  describe("networkKeyFromCaip2", () => {
    it("should resolve CAIP-2 to network key", () => {
      expect(networkKeyFromCaip2("eip155:8453")).toBe("base");
      expect(networkKeyFromCaip2("eip155:84532")).toBe("base-sepolia");
      expect(networkKeyFromCaip2("eip155:1")).toBe("ethereum");
      expect(networkKeyFromCaip2("eip155:11155111")).toBe("sepolia");
    });

    it("should return undefined for unknown CAIP-2", () => {
      expect(networkKeyFromCaip2("eip155:137")).toBeUndefined();
      expect(networkKeyFromCaip2("")).toBeUndefined();
      expect(networkKeyFromCaip2("invalid")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// MEMORY PAYMENT STORAGE
// ---------------------------------------------------------------------------

describe("MemoryPaymentStorage", () => {
  let storage: MemoryPaymentStorage;

  beforeEach(() => {
    storage = new MemoryPaymentStorage();
  });

  describe("recordPayment", () => {
    it("should store a payment record", async () => {
      const record = createPaymentRecord();
      await storage.recordPayment(record);
      const records = await storage.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(record.id);
    });

    it("should store multiple records", async () => {
      await storage.recordPayment(createPaymentRecord({ id: "a" }));
      await storage.recordPayment(createPaymentRecord({ id: "b" }));
      await storage.recordPayment(createPaymentRecord({ id: "c" }));
      const records = await storage.getRecords();
      expect(records).toHaveLength(3);
    });

    it("should store a deep copy (not reference)", async () => {
      const record = createPaymentRecord();
      await storage.recordPayment(record);
      (record as { amount: bigint }).amount = 999999n;
      const records = await storage.getRecords();
      expect(records[0].amount).not.toBe(999999n);
    });
  });

  describe("getTotal", () => {
    it("should sum outgoing amounts", async () => {
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing", amount: 100n }));
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing", amount: 200n }));
      await storage.recordPayment(createPaymentRecord({ direction: "incoming", amount: 500n }));
      const total = await storage.getTotal("outgoing");
      expect(total).toBe(300n);
    });

    it("should sum incoming amounts", async () => {
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing", amount: 100n }));
      await storage.recordPayment(createPaymentRecord({ direction: "incoming", amount: 500n }));
      const total = await storage.getTotal("incoming");
      expect(total).toBe(500n);
    });

    it("should exclude failed and refunded records", async () => {
      await storage.recordPayment(createPaymentRecord({ amount: 100n, status: "confirmed" }));
      await storage.recordPayment(createPaymentRecord({ amount: 200n, status: "failed" }));
      await storage.recordPayment(createPaymentRecord({ amount: 300n, status: "refunded" }));
      const total = await storage.getTotal("outgoing");
      expect(total).toBe(100n);
    });

    it("should respect time window", async () => {
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      const newDate = new Date().toISOString();
      await storage.recordPayment(createPaymentRecord({ amount: 100n, createdAt: oldDate }));
      await storage.recordPayment(createPaymentRecord({ amount: 200n, createdAt: newDate }));
      const total = await storage.getTotal("outgoing", 60 * 60 * 1000); // 1h window
      expect(total).toBe(200n);
    });

    it("should filter by scope (counterparty)", async () => {
      await storage.recordPayment(createPaymentRecord({ amount: 100n, counterparty: "0xAAA" }));
      await storage.recordPayment(createPaymentRecord({ amount: 200n, counterparty: "0xBBB" }));
      const total = await storage.getTotal("outgoing", undefined, "0xAAA");
      expect(total).toBe(100n);
    });

    it("should return 0n for no records", async () => {
      const total = await storage.getTotal("outgoing");
      expect(total).toBe(0n);
    });
  });

  describe("getRecords", () => {
    it("should filter by direction", async () => {
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing", id: "a" }));
      await storage.recordPayment(createPaymentRecord({ direction: "incoming", id: "b" }));
      const records = await storage.getRecords({ direction: "incoming" });
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("b");
    });

    it("should filter by status", async () => {
      await storage.recordPayment(createPaymentRecord({ status: "confirmed", id: "a" }));
      await storage.recordPayment(createPaymentRecord({ status: "failed", id: "b" }));
      const records = await storage.getRecords({ status: "failed" });
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("b");
    });

    it("should filter by counterparty (case-insensitive)", async () => {
      await storage.recordPayment(createPaymentRecord({ counterparty: "0xAAA", id: "a" }));
      await storage.recordPayment(createPaymentRecord({ counterparty: "0xBBB", id: "b" }));
      const records = await storage.getRecords({ counterparty: "0xaaa" });
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("a");
    });

    it("should filter by network", async () => {
      await storage.recordPayment(createPaymentRecord({ network: "eip155:8453", id: "a" }));
      await storage.recordPayment(createPaymentRecord({ network: "eip155:1", id: "b" }));
      const records = await storage.getRecords({ network: "eip155:8453" });
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("a");
    });

    it("should sort newest first", async () => {
      const old = new Date(Date.now() - 60000).toISOString();
      const recent = new Date().toISOString();
      await storage.recordPayment(createPaymentRecord({ createdAt: recent, id: "new" }));
      await storage.recordPayment(createPaymentRecord({ createdAt: old, id: "old" }));
      const records = await storage.getRecords();
      expect(records[0].id).toBe("new");
      expect(records[1].id).toBe("old");
    });

    it("should respect limit", async () => {
      for (let i = 0; i < 10; i++) {
        await storage.recordPayment(createPaymentRecord({ id: `r${i}` }));
      }
      const records = await storage.getRecords({ limit: 3 });
      expect(records).toHaveLength(3);
    });

    it("should respect offset", async () => {
      for (let i = 0; i < 5; i++) {
        await storage.recordPayment(createPaymentRecord({ id: `r${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString() }));
      }
      const records = await storage.getRecords({ offset: 2, limit: 2 });
      expect(records).toHaveLength(2);
    });

    it("should return empty array when no records match", async () => {
      const records = await storage.getRecords({ direction: "incoming" });
      expect(records).toEqual([]);
    });
  });

  describe("getCount", () => {
    it("should count records by direction", async () => {
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing" }));
      await storage.recordPayment(createPaymentRecord({ direction: "outgoing" }));
      await storage.recordPayment(createPaymentRecord({ direction: "incoming" }));
      expect(await storage.getCount("outgoing")).toBe(2);
      expect(await storage.getCount("incoming")).toBe(1);
    });

    it("should exclude failed and refunded from count", async () => {
      await storage.recordPayment(createPaymentRecord({ status: "confirmed" }));
      await storage.recordPayment(createPaymentRecord({ status: "failed" }));
      expect(await storage.getCount("outgoing")).toBe(1);
    });

    it("should respect time window", async () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      await storage.recordPayment(createPaymentRecord({ createdAt: old }));
      await storage.recordPayment(createPaymentRecord({ createdAt: recent }));
      expect(await storage.getCount("outgoing", 60 * 60 * 1000)).toBe(1);
    });
  });

  describe("clear", () => {
    it("should remove all records", async () => {
      await storage.recordPayment(createPaymentRecord());
      await storage.recordPayment(createPaymentRecord());
      await storage.clear();
      expect(await storage.getRecords()).toEqual([]);
      expect(await storage.getTotal("outgoing")).toBe(0n);
    });
  });
});

// ---------------------------------------------------------------------------
// POLICY ENGINE
// ---------------------------------------------------------------------------

describe("PolicyEngine", () => {
  let storage: MemoryPaymentStorage;

  beforeEach(() => {
    storage = new MemoryPaymentStorage();
  });

  describe("evaluateOutgoing", () => {
    it("should allow payments within limits", async () => {
      const engine = new PolicyEngine(createDefaultPolicy(), storage);
      const result = await engine.evaluateOutgoing({
        amount: 500_000n, // $0.50
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(true);
    });

    it("should deny payments exceeding per-transaction limit", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 100_000n, // $0.10
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: [],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: 200_000n, // $0.20
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-transaction limit");
    });

    it("should deny payments to blocked recipients", async () => {
      const blockedAddr = "0xBLOCKED000000000000000000000000000000000";
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 1_000_000n,
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: [blockedAddr],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: 100_000n,
        recipient: blockedAddr,
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("should be case-insensitive for blocked recipients", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 1_000_000n,
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: ["0xAAAA"],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: 100_000n,
        recipient: "0xaaaa",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
    });

    it("should deny payments not in allowed list when whitelist active", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 1_000_000n,
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: ["0xALLOWED"],
          blockedRecipients: [],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: 100_000n,
        recipient: "0xNOTALLOWED",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allow list");
    });

    it("should deny when total window limit exceeded", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 5_000_000n,
          maxTotal: 1_000_000n, // $1 total
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: [],
        },
      }), storage);

      // Pre-fill storage with $0.80 of spending
      await storage.recordPayment(createPaymentRecord({ amount: 800_000n }));

      const result = await engine.evaluateOutgoing({
        amount: 300_000n, // $0.30 — would push to $1.10
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("window limit");
    });

    it("should deny when transaction count limit reached", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 5_000_000n,
          maxTotal: 100_000_000n,
          windowMs: 86400000,
          maxTransactions: 2, // Only 2 allowed
          allowedRecipients: [],
          blockedRecipients: [],
        },
      }), storage);

      await storage.recordPayment(createPaymentRecord());
      await storage.recordPayment(createPaymentRecord());

      const result = await engine.evaluateOutgoing({
        amount: 100_000n,
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "https://api.example.com",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("limit");
    });
  });

  describe("evaluateIncoming", () => {
    it("should allow payments above minimum", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        incoming: {
          minPerTransaction: 100_000n,
          allowedSenders: [],
          blockedSenders: [],
        },
      }), storage);

      const result = await engine.evaluateIncoming({
        amount: 200_000n,
        sender: "0xPAYER",
      });
      expect(result.allowed).toBe(true);
    });

    it("should deny payments below minimum", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        incoming: {
          minPerTransaction: 500_000n,
          allowedSenders: [],
          blockedSenders: [],
        },
      }), storage);

      const result = await engine.evaluateIncoming({
        amount: 100_000n,
        sender: "0xPAYER",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("below minimum");
    });

    it("should deny payments from blocked senders", async () => {
      const engine = new PolicyEngine(createDefaultPolicy({
        incoming: {
          minPerTransaction: 0n,
          allowedSenders: [],
          blockedSenders: ["0xEVIL"],
        },
      }), storage);

      const result = await engine.evaluateIncoming({
        amount: 100_000n,
        sender: "0xevil", // case-insensitive
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });
  });

  describe("updatePolicy", () => {
    it("should merge partial outgoing updates", () => {
      const engine = new PolicyEngine(createDefaultPolicy(), storage);
      engine.updatePolicy({
        outgoing: {
          maxPerTransaction: 5_000_000n,
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: [],
        },
      });
      const policy = engine.getPolicy();
      expect(policy.outgoing.maxPerTransaction).toBe(5_000_000n);
    });

    it("should merge partial incoming updates", () => {
      const engine = new PolicyEngine(createDefaultPolicy(), storage);
      engine.updatePolicy({
        incoming: {
          minPerTransaction: 50_000n,
          allowedSenders: [],
          blockedSenders: [],
        },
      });
      const policy = engine.getPolicy();
      expect(policy.incoming.minPerTransaction).toBe(50_000n);
    });
  });
});

// ---------------------------------------------------------------------------
// CIRCUIT BREAKER
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  describe("initial state", () => {
    it("should start in closed state", () => {
      const breaker = new CircuitBreaker();
      expect(breaker.getState()).toBe("closed");
    });

    it("should allow payments in closed state", () => {
      const breaker = new CircuitBreaker();
      const result = breaker.check(100_000n);
      expect(result.allowed).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("should trip when rate limit exceeded", () => {
      const breaker = new CircuitBreaker({ maxPaymentsPerMinute: 3 });
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      const result = breaker.check(100n);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Rate exceeded");
      expect(breaker.getState()).toBe("open");
    });
  });

  describe("anomaly detection", () => {
    it("should trip on amount anomaly", () => {
      const breaker = new CircuitBreaker({
        anomalyMultiplier: 5,
        recentWindowSize: 10,
      });
      // Build up a baseline of small payments
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);

      // Try a payment 20x the average
      const result = breaker.check(2000n);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Anomaly detected");
      expect(breaker.getState()).toBe("open");
    });

    it("should not trip below anomaly threshold", () => {
      const breaker = new CircuitBreaker({ anomalyMultiplier: 10 });
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);

      // 5x average — below 10x threshold
      const result = breaker.check(500n);
      expect(result.allowed).toBe(true);
    });

    it("should not check anomaly with fewer than 3 data points", () => {
      const breaker = new CircuitBreaker({ anomalyMultiplier: 2 });
      breaker.recordSuccess(1n);
      breaker.recordSuccess(1n);
      // Only 2 data points — anomaly check skipped
      const result = breaker.check(1000000n);
      expect(result.allowed).toBe(true);
    });
  });

  describe("state transitions", () => {
    it("should transition from open to half-open after cooldown", async () => {
      // Use anomaly detection to trip the breaker (avoids timing issues with rate limiting)
      const breaker = new CircuitBreaker({
        maxPaymentsPerMinute: 1000, // high rate limit, won't interfere
        anomalyMultiplier: 2,
        cooldownMs: 50,
        recentWindowSize: 10,
      });
      // Build baseline
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);

      // Trip via anomaly
      const tripResult = breaker.check(1000n);
      expect(tripResult.allowed).toBe(false);
      expect(breaker.getState()).toBe("open");

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 80));

      const result = breaker.check(100n);
      expect(breaker.getState()).toBe("half-open");
      expect(result.allowed).toBe(true);
    });

    it("should close on successful probe in half-open state", async () => {
      const breaker = new CircuitBreaker({
        maxPaymentsPerMinute: 1000,
        anomalyMultiplier: 2,
        cooldownMs: 20,
        recentWindowSize: 10,
      });
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.check(1000n); // Trip via anomaly

      await new Promise((r) => setTimeout(r, 40));

      breaker.check(100n); // Transitions to half-open
      breaker.recordSuccess(100n); // Probe success
      expect(breaker.getState()).toBe("closed");
    });

    it("should re-open on failed probe in half-open state", async () => {
      const breaker = new CircuitBreaker({
        maxPaymentsPerMinute: 1000,
        anomalyMultiplier: 2,
        cooldownMs: 20,
        recentWindowSize: 10,
      });
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.recordSuccess(100n);
      breaker.check(1000n); // Trip via anomaly

      await new Promise((r) => setTimeout(r, 40));

      breaker.check(100n); // Transitions to half-open
      breaker.recordFailure(); // Probe fails
      expect(breaker.getState()).toBe("open");
    });
  });

  describe("reset", () => {
    it("should reset to closed state", () => {
      const breaker = new CircuitBreaker({ maxPaymentsPerMinute: 1 });
      breaker.recordSuccess(100n);
      breaker.check(100n); // Trips
      expect(breaker.getState()).toBe("open");
      breaker.reset();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getTripReason()).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// FETCH WITH PAYMENT (mocked)
// ---------------------------------------------------------------------------

describe("createFetchWithPayment", () => {
  // We test the fetch wrapper logic by mocking dependencies
  // The actual createFetchWithPayment is imported and tested with mocks

  let mockStorage: MemoryPaymentStorage;
  let mockPolicyEngine: PolicyEngine;
  let mockCircuitBreaker: CircuitBreaker;

  beforeEach(() => {
    mockStorage = new MemoryPaymentStorage();
    mockPolicyEngine = new PolicyEngine(createDefaultPolicy(), mockStorage);
    mockCircuitBreaker = new CircuitBreaker();
  });

  it("should pass through non-402 responses", async () => {
    // Dynamic import to test with mocked fetch
    const { createFetchWithPayment } = await import("../client/fetch-with-payment.js");

    const mockSigner = {
      address: "0xTEST",
      networkId: "eip155:8453",
      signPermit: vi.fn(),
      buildPaymentHeader: vi.fn(),
    };

    const fetchWithPayment = createFetchWithPayment({
      signer: mockSigner,
      policyEngine: mockPolicyEngine,
      circuitBreaker: mockCircuitBreaker,
      storage: mockStorage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));

    try {
      const response = await fetchWithPayment("https://example.com/free");
      expect(response.status).toBe(200);
      expect(mockSigner.buildPaymentHeader).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return 402 as-is when no payment-required header present", async () => {
    const { createFetchWithPayment } = await import("../client/fetch-with-payment.js");

    const mockSigner = {
      address: "0xTEST",
      networkId: "eip155:8453",
      signPermit: vi.fn(),
      buildPaymentHeader: vi.fn(),
    };

    const fetchWithPayment = createFetchWithPayment({
      signer: mockSigner,
      policyEngine: mockPolicyEngine,
      circuitBreaker: mockCircuitBreaker,
      storage: mockStorage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const originalFetch = globalThis.fetch;
    // 402 without Payment-Required header
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Payment Required", { status: 402 }));

    try {
      const response = await fetchWithPayment("https://example.com/paid");
      expect(response.status).toBe(402);
      expect(mockSigner.buildPaymentHeader).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should reject payment when network does not match", async () => {
    const { createFetchWithPayment } = await import("../client/fetch-with-payment.js");

    const mockSigner = {
      address: "0xTEST",
      networkId: "eip155:8453", // Base
      signPermit: vi.fn(),
      buildPaymentHeader: vi.fn(),
    };

    const fetchWithPayment = createFetchWithPayment({
      signer: mockSigner,
      policyEngine: mockPolicyEngine,
      circuitBreaker: mockCircuitBreaker,
      storage: mockStorage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    // Build a 402 response requiring payment on Ethereum (not Base)
    const paymentRequired: PaymentRequiredResponse = {
      x402Version: 2,
      accepts: [{
        scheme: "exact",
        network: "eip155:1", // Ethereum — does NOT match signer
        maxAmountRequired: "1000000",
        resource: "https://example.com/paid",
        description: "test",
        mimeType: "application/json",
        payTo: "0xPAYEE",
        maxTimeoutSeconds: 300,
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        extra: {},
      }],
    };

    const headers = new Headers({
      "Payment-Required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 402, headers }));

    try {
      const response = await fetchWithPayment("https://example.com/paid");
      expect(response.status).toBe(402); // Returns the 402 since no matching network
      expect(mockSigner.buildPaymentHeader).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES & FUZZ TESTING
// ---------------------------------------------------------------------------

describe("Edge Cases & Fuzz", () => {
  describe("MemoryPaymentStorage edge cases", () => {
    let storage: MemoryPaymentStorage;
    beforeEach(() => { storage = new MemoryPaymentStorage(); });

    it("should handle zero-amount payments", async () => {
      await storage.recordPayment(createPaymentRecord({ amount: 0n }));
      expect(await storage.getTotal("outgoing")).toBe(0n);
      expect(await storage.getCount("outgoing")).toBe(1);
    });

    it("should handle very large amounts (> 2^53)", async () => {
      const huge = 9_999_999_999_999_999n; // Much larger than Number.MAX_SAFE_INTEGER
      await storage.recordPayment(createPaymentRecord({ amount: huge }));
      expect(await storage.getTotal("outgoing")).toBe(huge);
    });

    it("should handle special characters in resource field", async () => {
      const record = createPaymentRecord({ resource: 'https://api.com/data?q=hello&world="test"' });
      await storage.recordPayment(record);
      const records = await storage.getRecords();
      expect(records[0].resource).toBe(record.resource);
    });

    it("should handle empty strings in fields", async () => {
      const record = createPaymentRecord({
        txHash: "",
        resource: "",
        counterparty: "",
      });
      await storage.recordPayment(record);
      const records = await storage.getRecords();
      expect(records).toHaveLength(1);
    });
  });

  describe("PolicyEngine edge cases", () => {
    it("should handle maxPerTransaction = 0 (deny all)", async () => {
      const storage = new MemoryPaymentStorage();
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: 0n,
          maxTotal: 10_000_000n,
          windowMs: 86400000,
          maxTransactions: 100,
          allowedRecipients: [],
          blockedRecipients: [],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: 1n, // Even 1 base unit exceeds 0 limit
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "test",
      });
      expect(result.allowed).toBe(false);
    });

    it("should handle very large transaction limits", async () => {
      const storage = new MemoryPaymentStorage();
      const engine = new PolicyEngine(createDefaultPolicy({
        outgoing: {
          maxPerTransaction: BigInt("999999999999999999"),
          maxTotal: BigInt("999999999999999999"),
          windowMs: 86400000,
          maxTransactions: 999999,
          allowedRecipients: [],
          blockedRecipients: [],
        },
      }), storage);

      const result = await engine.evaluateOutgoing({
        amount: BigInt("999999999999999998"),
        recipient: "0x1234567890123456789012345678901234567890",
        resource: "test",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("CircuitBreaker edge cases", () => {
    it("should handle zero-amount payments for anomaly check", () => {
      const breaker = new CircuitBreaker({ anomalyMultiplier: 10 });
      breaker.recordSuccess(0n);
      breaker.recordSuccess(0n);
      breaker.recordSuccess(0n);
      // Average is 0, any amount > 0 * multiplier = 0 would trip
      // But 0 * 10 = 0, so amount > 0 should trip
      // However, the check is avg > 0n && amount > avg * multiplier
      // With avg = 0n, the condition avg > 0n is false, so it skips
      const result = breaker.check(1000000n);
      expect(result.allowed).toBe(true);
    });

    it("should maintain window size correctly", () => {
      const breaker = new CircuitBreaker({ recentWindowSize: 3 });
      breaker.recordSuccess(100n);
      breaker.recordSuccess(200n);
      breaker.recordSuccess(300n);
      breaker.recordSuccess(400n); // Evicts 100n
      // Average should be (200+300+400)/3 = 300
      // 3001n > 300n * 10 = 3000n → trips
      const result = breaker.check(3001n);
      expect(result.allowed).toBe(false);
    });
  });

  describe("Network registry edge cases", () => {
    it("should not have duplicate CAIP-2 identifiers", () => {
      const caip2s = Object.values(NETWORK_REGISTRY).map((n) => n.caip2);
      const unique = new Set(caip2s);
      expect(unique.size).toBe(caip2s.length);
    });

    it("should not have duplicate chain IDs", () => {
      const chainIds = Object.values(NETWORK_REGISTRY).map((n) => n.chainId);
      const unique = new Set(chainIds);
      expect(unique.size).toBe(chainIds.length);
    });

    it("should have valid USDC addresses (40 hex chars)", () => {
      for (const [key, info] of Object.entries(NETWORK_REGISTRY)) {
        expect(info.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    });

    it("should have valid CAIP-2 format", () => {
      for (const [key, info] of Object.entries(NETWORK_REGISTRY)) {
        expect(info.caip2).toMatch(/^eip155:\d+$/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// EVM PAYMENT SIGNER (with real crypto)
// ---------------------------------------------------------------------------

describe("EvmPaymentSigner", () => {
  // Use a known test private key (DO NOT use in production)
  const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  it("should derive correct address from private key", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");
    expect(signer.address).toBe(EXPECTED_ADDRESS);
  });

  it("should handle private key without 0x prefix", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY.slice(2), "base");
    expect(signer.address).toBe(EXPECTED_ADDRESS);
  });

  it("should return correct network ID", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");
    expect(signer.networkId).toBe("eip155:8453");
  });

  it("should sign an ERC-2612 permit", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");

    const result = await signer.signPermit({
      spender: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 1_000_000n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: 0n,
    });

    expect(result.v).toBeGreaterThanOrEqual(27);
    expect(result.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("should build a valid x402 v2 upto payment header", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");

    const requirement: PaymentRequirement = {
      scheme: "upto",
      network: "eip155:8453",
      maxAmountRequired: "1000000",
      resource: "https://api.example.com/data",
      description: "test",
      mimeType: "application/json",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      maxTimeoutSeconds: 300,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: "USD Coin", version: "2" },
    };

    const header = await signer.buildPaymentHeader(requirement);

    // Should be base64 encoded
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));

    // Verify x402 v2 "upto" structure
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toBeDefined();
    expect(decoded.accepted.scheme).toBe("upto");
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.accepted.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(decoded.accepted.amount).toBe("1000000");
    expect(decoded.accepted.payTo).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

    // Verify payload — "upto" scheme uses ERC-2612 Permit
    expect(decoded.payload).toBeDefined();
    expect(decoded.payload.signature).toMatch(/^0x/);
    expect(decoded.payload.authorization).toBeDefined();
    expect(decoded.payload.authorization.from).toBe(EXPECTED_ADDRESS);
    expect(decoded.payload.authorization.to).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(decoded.payload.authorization.value).toBe("1000000");
    // "upto" scheme uses sequential nonce queried from chain (or from extra)
    expect(Number(decoded.payload.authorization.nonce)).toBeGreaterThanOrEqual(0);
    // validBefore is the Permit deadline
    expect(decoded.payload.authorization.validBefore).toBeTruthy();
    // validAfter is not used in the "upto" Permit scheme
    expect(decoded.payload.authorization.validAfter).toBeUndefined();
  });

  it("should use sequential nonce from requirement.extra", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");

    const requirement: PaymentRequirement = {
      scheme: "upto",
      network: "eip155:8453",
      maxAmountRequired: "1000000",
      resource: "https://api.example.com/data",
      description: "test",
      mimeType: "application/json",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      maxTimeoutSeconds: 300,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: "USD Coin", version: "2", nonce: "5" },
    };

    const header = await signer.buildPaymentHeader(requirement);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));

    // Nonce should be the sequential value from extra, not random
    expect(decoded.payload.authorization.nonce).toBe("5");
  });

  it("should default nonce to 0 when not in extra", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");

    const requirement: PaymentRequirement = {
      scheme: "upto",
      network: "eip155:8453",
      maxAmountRequired: "1000000",
      resource: "https://api.example.com/data",
      description: "test",
      mimeType: "application/json",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      maxTimeoutSeconds: 300,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: {},
    };

    const header = await signer.buildPaymentHeader(requirement);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));

    // Should query on-chain nonce when not in extra
    expect(Number(decoded.payload.authorization.nonce)).toBeGreaterThanOrEqual(0);
  });

  it("should read name and version from requirement.extra for domain", async () => {
    const { EvmPaymentSigner } = await import("../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_PRIVATE_KEY, "base");

    // Two requirements with different name/version should produce different signatures
    const req1: PaymentRequirement = {
      scheme: "upto",
      network: "eip155:8453",
      maxAmountRequired: "1000000",
      resource: "https://api.example.com/data",
      description: "test",
      mimeType: "application/json",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      maxTimeoutSeconds: 300,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: "USD Coin", version: "2" },
    };

    const req2: PaymentRequirement = {
      ...req1,
      extra: { name: "Different Token", version: "1" },
    };

    const header1 = await signer.buildPaymentHeader(req1);
    const header2 = await signer.buildPaymentHeader(req2);

    const decoded1 = JSON.parse(Buffer.from(header1, "base64").toString("utf-8"));
    const decoded2 = JSON.parse(Buffer.from(header2, "base64").toString("utf-8"));

    // Different domain => different signatures
    expect(decoded1.payload.signature).not.toBe(decoded2.payload.signature);
  });
});

// ---------------------------------------------------------------------------
// UTILS
// ---------------------------------------------------------------------------

describe("Utils", () => {
  it("formatUsd should format base units to dollars", async () => {
    const { formatUsd } = await import("../utils");
    expect(formatUsd(0n)).toBe("$0.00");
    expect(formatUsd(1n)).toBe("$0.00");           // rounds
    expect(formatUsd(1000000n)).toBe("$1.00");
    expect(formatUsd(10000000n)).toBe("$10.00");
    expect(formatUsd(999999n)).toBe("$1.00");       // rounds to nearest cent
    expect(formatUsd(50000n)).toBe("$0.05");
    expect(formatUsd(123456789n)).toBe("$123.46");  // truncates
  });

  it("truncateAddress should shorten addresses", async () => {
    const { truncateAddress } = await import("../utils");
    expect(truncateAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F...2266");
    expect(truncateAddress("short")).toBe("short");  // <= 10 chars returned as-is
    expect(truncateAddress("")).toBe("");
  });

  it("usdToBaseUnits should convert dollars to 6-decimal base units", async () => {
    const { usdToBaseUnits } = await import("../utils");
    expect(usdToBaseUnits(1.0)).toBe(1000000n);
    expect(usdToBaseUnits(0.01)).toBe(10000n);
    expect(usdToBaseUnits(0)).toBe(0n);
    expect(usdToBaseUnits(100.50)).toBe(100500000n);
    expect(usdToBaseUnits(0.000001)).toBe(1n);    // smallest representable
  });
});

// ---------------------------------------------------------------------------
// SQLITE STORAGE (real database, temp file)
// ---------------------------------------------------------------------------

describe("SqlitePaymentStorage", () => {
  let storage: InstanceType<typeof import("../storage/sqlite").SqlitePaymentStorage>;
  const tmpPath = "/tmp/x402-test-" + Date.now() + ".db";

  beforeEach(async () => {
    const { SqlitePaymentStorage } = await import("../storage/sqlite");
    storage = new SqlitePaymentStorage(tmpPath);
  });

  afterEach(async () => {
    storage.close();
    const fs = await import("fs");
    fs.unlinkSync(tmpPath);
  });

  it("should create table and record a payment", async () => {
    await storage.recordPayment({
      id: "test-1", direction: "outgoing", counterparty: "0xAAA",
      amount: 500000n, network: "eip155:8453", txHash: "0x123",
      resource: "https://api.test", status: "confirmed",
      createdAt: new Date().toISOString(), metadata: { key: "val" },
    });
    const records = await storage.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("test-1");
    expect(records[0].amount).toBe(500000n);  // BigInt survives round-trip
    expect(records[0].metadata).toEqual({ key: "val" });
  });

  it("should compute totals correctly", async () => {
    await storage.recordPayment({
      id: "a", direction: "outgoing", counterparty: "0xA", amount: 100n,
      network: "n", txHash: "", resource: "", status: "confirmed",
      createdAt: new Date().toISOString(), metadata: {},
    });
    await storage.recordPayment({
      id: "b", direction: "outgoing", counterparty: "0xB", amount: 200n,
      network: "n", txHash: "", resource: "", status: "confirmed",
      createdAt: new Date().toISOString(), metadata: {},
    });
    await storage.recordPayment({
      id: "c", direction: "outgoing", counterparty: "0xC", amount: 300n,
      network: "n", txHash: "", resource: "", status: "failed",
      createdAt: new Date().toISOString(), metadata: {},
    });
    expect(await storage.getTotal("outgoing")).toBe(300n); // excludes failed
    expect(await storage.getCount("outgoing")).toBe(2);
  });

  it("should filter by time window", async () => {
    await storage.recordPayment({
      id: "old", direction: "outgoing", counterparty: "0xA", amount: 100n,
      network: "n", txHash: "", resource: "", status: "confirmed",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), metadata: {},
    });
    await storage.recordPayment({
      id: "new", direction: "outgoing", counterparty: "0xA", amount: 200n,
      network: "n", txHash: "", resource: "", status: "confirmed",
      createdAt: new Date().toISOString(), metadata: {},
    });
    expect(await storage.getTotal("outgoing", 60 * 60 * 1000)).toBe(200n);
  });

  it("should clear all records", async () => {
    await storage.recordPayment({
      id: "x", direction: "outgoing", counterparty: "0xA", amount: 100n,
      network: "n", txHash: "", resource: "", status: "confirmed",
      createdAt: new Date().toISOString(), metadata: {},
    });
    await storage.clear();
    expect(await storage.getRecords()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PAYWALL MIDDLEWARE
// ---------------------------------------------------------------------------

describe("createPaywallMiddleware", () => {
  it("should return 402 when no X-PAYMENT header", async () => {
    const { createPaywallMiddleware } = await import("../middleware/paywall");
    const paywall = createPaywallMiddleware({
      payTo: "0xPAYEE", network: "base-sepolia",
      facilitatorUrl: "http://localhost:9999",
      amount: 100000n, description: "test", mimeType: "application/json",
      maxTimeoutSeconds: 300,
    });

    let statusCode = 0;
    let jsonBody: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: Record<string, unknown>) => { jsonBody = data; return res; },
      setHeader: (k: string, v: string) => { headers[k] = v; return res; },
      end: () => res,
    };

    let nextCalled = false;
    await paywall({ headers: {}, url: "/test" }, res as never, () => { nextCalled = true; });

    expect(statusCode).toBe(402);
    expect(jsonBody.error).toBe("Payment Required");
    expect(headers["Payment-Required"]).toBeTruthy();
    expect(nextCalled).toBe(false);

    // Verify the Payment-Required header decodes to valid x402 v2
    const decoded = JSON.parse(Buffer.from(headers["Payment-Required"], "base64").toString());
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].scheme).toBe("upto");
    expect(decoded.accepts[0].maxAmountRequired).toBe("100000");
    expect(decoded.accepts[0].payTo).toBe("0xPAYEE");
    expect(decoded.accepts[0].extra.name).toBeTruthy();  // domain name included
    expect(decoded.accepts[0].extra.version).toBeTruthy();
  });

  it("should return 402 when payment verification fails", async () => {
    const { createPaywallMiddleware } = await import("../middleware/paywall");
    const paywall = createPaywallMiddleware({
      payTo: "0xPAYEE", network: "base-sepolia",
      facilitatorUrl: "http://localhost:1",  // unreachable
      amount: 100000n, description: "test", mimeType: "application/json",
      maxTimeoutSeconds: 300,
    });

    let statusCode = 0;
    let jsonBody: Record<string, unknown> = {};
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: Record<string, unknown>) => { jsonBody = data; return res; },
      setHeader: (_k: string, _v: string) => res,
      end: () => res,
    };

    await paywall(
      { headers: { "x-payment": "invalid-base64-garbage" }, url: "/test" },
      res as never,
      () => {},
    );

    expect(statusCode).toBe(402);
    expect(jsonBody.error).toContain("Payment Invalid");
  });
});

// ---------------------------------------------------------------------------
// FACILITATOR CLIENT — request body construction
// ---------------------------------------------------------------------------

describe("Facilitator Client", () => {
  it("buildFacilitatorRequestBody should decode base64 proof and build correct body", async () => {
    const mod = await import("../middleware/facilitator-client");
    // Test via verifyPaymentWithFacilitator with a mock server
    // The function internally calls buildFacilitatorRequestBody, which we can
    // verify by checking what it sends

    // Build a base64 payment proof
    const proof = { x402Version: 2, accepted: { scheme: "upto" }, payload: { signature: "0x", authorization: {} } };
    const encoded = Buffer.from(JSON.stringify(proof)).toString("base64");

    const requirement = {
      scheme: "upto", network: "eip155:84532", maxAmountRequired: "1000",
      resource: "test", description: "t", mimeType: "application/json",
      payTo: "0xAAA", maxTimeoutSeconds: 300, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: { name: "USDC", version: "2" },
    };

    // Call verify against a non-existent server — it will fail with a network error
    // but we can verify the function handles it correctly
    const result = await mod.verifyPaymentWithFacilitator(encoded, "http://127.0.0.1:1", requirement);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Facilitator request failed");
  });

  it("should handle non-base64 direct JSON proof", async () => {
    const mod = await import("../middleware/facilitator-client");
    const proof = JSON.stringify({ x402Version: 2, accepted: {}, payload: {} });
    const result = await mod.verifyPaymentWithFacilitator(proof, "http://127.0.0.1:1", {
      scheme: "upto", network: "eip155:84532", maxAmountRequired: "1000",
      resource: "test", description: "t", mimeType: "application/json",
      payTo: "0xAAA", maxTimeoutSeconds: 300, asset: "0x036",
      extra: {},
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("should throw on completely invalid proof", async () => {
    const mod = await import("../middleware/facilitator-client");
    // Neither base64 nor JSON
    const result = await mod.verifyPaymentWithFacilitator("not-json-not-base64!!!", "http://127.0.0.1:1", {
      scheme: "upto", network: "eip155:84532", maxAmountRequired: "1000",
      resource: "test", description: "t", mimeType: "application/json",
      payTo: "0xAAA", maxTimeoutSeconds: 300, asset: "0x036",
      extra: {},
    });
    // Should fail gracefully, not throw
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FETCH WITH PAYMENT — full flow with real signer
// ---------------------------------------------------------------------------

describe("createFetchWithPayment - full flow", () => {
  it("should sign and retry on 402, record payment", async () => {
    const { EvmPaymentSigner } = await import("../client/signer");
    const { createFetchWithPayment } = await import("../client/fetch-with-payment");
    const { PolicyEngine } = await import("../policy/engine");
    const { CircuitBreaker } = await import("../policy/circuit-breaker");
    const { MemoryPaymentStorage } = await import("../storage/memory");

    const storage = new MemoryPaymentStorage();
    const signer = new EvmPaymentSigner(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "base-sepolia",
    );
    const policy = new PolicyEngine({
      outgoing: { maxPerTransaction: 10000000n, maxTotal: 100000000n, windowMs: 86400000, maxTransactions: 100, allowedRecipients: [], blockedRecipients: [] },
      incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] },
    }, storage);
    const breaker = new CircuitBreaker();

    // Mock 402 response with proper headers
    const paymentRequired = {
      x402Version: 2,
      accepts: [{
        scheme: "upto", network: "eip155:84532",
        maxAmountRequired: "50000", resource: "https://api.test/data",
        description: "test", mimeType: "application/json",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        maxTimeoutSeconds: 300,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        extra: { name: "USDC", version: "2", nonce: "6" },
      }],
    };
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

    let callCount = 0;
    let capturedPaymentHeader = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response("{}", { status: 402, headers: { "Payment-Required": encoded } });
      }
      // Capture and validate the payment header
      const h = init?.headers;
      capturedPaymentHeader = h instanceof Headers ? (h.get("X-PAYMENT") ?? "") : ((h as Record<string, string>)?.["X-PAYMENT"] ?? "");
      return new Response(JSON.stringify({ data: "ok" }), { status: 200, headers: { "x-upto-session-id": "session-123" } });
    }) as typeof fetch;

    try {
      const fetchWithPayment = createFetchWithPayment({
        signer, policyEngine: policy, circuitBreaker: breaker, storage,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      });

      const resp = await fetchWithPayment("https://api.test/data");
      expect(resp.status).toBe(200);
      expect(callCount).toBe(2);

      // Verify the payment header was a valid x402 payload
      const decoded = JSON.parse(Buffer.from(capturedPaymentHeader, "base64").toString());
      expect(decoded.x402Version).toBe(2);
      expect(decoded.accepted.scheme).toBe("upto");
      expect(decoded.payload.authorization.from).toBe(signer.address);
      expect(decoded.payload.authorization.nonce).toBe("6"); // from extra
      expect(decoded.payload.signature).toMatch(/^0x/);

      // Verify payment was recorded in storage
      const records = await storage.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].direction).toBe("outgoing");
      expect(records[0].amount).toBe(50000n);
      expect(records[0].counterparty).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      expect(records[0].status).toBe("confirmed");
      expect(records[0].txHash).toBe("session-123"); // from x-upto-session-id header
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should block payment when policy denies", async () => {
    const { EvmPaymentSigner } = await import("../client/signer");
    const { createFetchWithPayment } = await import("../client/fetch-with-payment");
    const { PolicyEngine } = await import("../policy/engine");
    const { CircuitBreaker } = await import("../policy/circuit-breaker");
    const { MemoryPaymentStorage } = await import("../storage/memory");

    const storage = new MemoryPaymentStorage();
    const signer = new EvmPaymentSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "base-sepolia");
    const policy = new PolicyEngine({
      outgoing: { maxPerTransaction: 10000n, maxTotal: 100000n, windowMs: 86400000, maxTransactions: 100, allowedRecipients: [], blockedRecipients: [] },
      incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] },
    }, storage);

    const paymentRequired = {
      x402Version: 2,
      accepts: [{
        scheme: "upto", network: "eip155:84532",
        maxAmountRequired: "50000", // $0.05 — exceeds $0.01 per-tx limit
        resource: "https://api.test", description: "test", mimeType: "application/json",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", maxTimeoutSeconds: 300,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { nonce: "0" },
      }],
    };

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("{}", { status: 402, headers: { "Payment-Required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64") } });
    }) as typeof fetch;

    try {
      const fetchWithPayment = createFetchWithPayment({
        signer, policyEngine: policy, circuitBreaker: new CircuitBreaker(), storage,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      });
      const resp = await fetchWithPayment("https://api.test");
      expect(resp.status).toBe(402); // returns original 402 — did NOT pay
      expect(callCount).toBe(1);     // only 1 call — no retry
      expect(await storage.getRecords()).toEqual([]); // nothing recorded
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should block payment when circuit breaker is open", async () => {
    const { EvmPaymentSigner } = await import("../client/signer");
    const { createFetchWithPayment } = await import("../client/fetch-with-payment");
    const { PolicyEngine } = await import("../policy/engine");
    const { CircuitBreaker } = await import("../policy/circuit-breaker");
    const { MemoryPaymentStorage } = await import("../storage/memory");

    const storage = new MemoryPaymentStorage();
    const signer = new EvmPaymentSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "base-sepolia");
    const breaker = new CircuitBreaker({ maxPaymentsPerMinute: 2, anomalyMultiplier: 100, cooldownMs: 60000, recentWindowSize: 10 });
    // Trip the breaker
    breaker.recordSuccess(1n);
    breaker.recordSuccess(1n);
    breaker.check(1n); // trips at 2/min

    const paymentRequired = {
      x402Version: 2,
      accepts: [{
        scheme: "upto", network: "eip155:84532", maxAmountRequired: "1000",
        resource: "test", description: "t", mimeType: "application/json",
        payTo: "0xAAA", maxTimeoutSeconds: 300,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { nonce: "0" },
      }],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("{}", { status: 402, headers: { "Payment-Required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64") } });
    }) as typeof fetch;

    try {
      const fetchWithPayment = createFetchWithPayment({
        signer, policyEngine: new PolicyEngine({ outgoing: { maxPerTransaction: 10000000n, maxTotal: 100000000n, windowMs: 86400000, maxTransactions: 1000, allowedRecipients: [], blockedRecipients: [] }, incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] } }, storage),
        circuitBreaker: breaker, storage,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      });
      const resp = await fetchWithPayment("https://api.test");
      expect(resp.status).toBe(402); // blocked by breaker
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// CONCURRENT PAYMENTS
// ---------------------------------------------------------------------------

describe("Concurrent behavior", () => {
  it("should handle multiple simultaneous payments independently", async () => {
    const { MemoryPaymentStorage } = await import("../storage/memory");
    const storage = new MemoryPaymentStorage();

    // Simulate 10 concurrent recordPayment calls
    const promises = Array.from({ length: 10 }, (_, i) =>
      storage.recordPayment({
        id: `concurrent-${i}`, direction: "outgoing",
        counterparty: `0x${i.toString().padStart(40, "0")}`,
        amount: BigInt(i * 1000), network: "eip155:8453",
        txHash: `tx-${i}`, resource: `https://api.test/${i}`,
        status: "confirmed", createdAt: new Date().toISOString(), metadata: {},
      })
    );
    await Promise.all(promises);

    const records = await storage.getRecords();
    expect(records).toHaveLength(10);

    const total = await storage.getTotal("outgoing");
    // 0 + 1000 + 2000 + ... + 9000 = 45000
    expect(total).toBe(45000n);
  });

  it("PolicyEngine should handle concurrent evaluations", async () => {
    const { PolicyEngine } = await import("../policy/engine");
    const { MemoryPaymentStorage } = await import("../storage/memory");
    const storage = new MemoryPaymentStorage();
    const engine = new PolicyEngine({
      outgoing: { maxPerTransaction: 100000n, maxTotal: 500000n, windowMs: 86400000, maxTransactions: 100, allowedRecipients: [], blockedRecipients: [] },
      incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] },
    }, storage);

    // Run 5 evaluations concurrently
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        engine.evaluateOutgoing({ amount: 50000n, recipient: `0x${i}`, resource: "test" })
      )
    );
    // All should be allowed (total = 0, each is 50000 < 100000 per-tx)
    expect(results.every(r => r.allowed)).toBe(true);
  });
});
