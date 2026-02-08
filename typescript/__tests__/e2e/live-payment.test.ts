/**
 * x402 Payment E2E Tests
 *
 * Tests 1-10 run ALWAYS (local crypto only, no external deps).
 * RPC tests gated behind: BASE_SEPOLIA_RPC=<url>
 * Facilitator tests gated behind: TEST_FACILITATOR_URL=<url>
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createPublicClient, http, type Hex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const PAY_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

describe("x402 Payment E2E", () => {
  const account = privateKeyToAccount(TEST_KEY);

  it("should derive correct address", () => { expect(account.address).toBe(EXPECTED_ADDRESS); });

  it("should sign ERC-2612 Permit", async () => {
    const sig = await account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 84532n, verifyingContract: BASE_SEPOLIA_USDC },
      types: PERMIT_TYPES, primaryType: "Permit",
      message: { owner: account.address, spender: PAY_TO, value: 10000n, nonce: 0n, deadline: BigInt(Math.floor(Date.now()/1000)+3600) },
    });
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(sig.length).toBe(132);
  });

  it("should verify Permit signature", async () => {
    const deadline = BigInt(Math.floor(Date.now()/1000)+3600);
    const domain = { name: "USD Coin", version: "2", chainId: 84532n, verifyingContract: BASE_SEPOLIA_USDC };
    const message = { owner: account.address, spender: PAY_TO, value: 10000n, nonce: 0n, deadline };
    const sig = await account.signTypedData({ domain, types: PERMIT_TYPES, primaryType: "Permit", message });
    expect(await verifyTypedData({ address: account.address, domain, types: PERMIT_TYPES, primaryType: "Permit", message, signature: sig })).toBe(true);
  });

  it("should build valid x402 v2 upto header", async () => {
    const { EvmPaymentSigner } = await import("../../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_KEY, "base-sepolia");
    const h = await signer.buildPaymentHeader({ scheme: "upto", network: "eip155:84532", maxAmountRequired: "10000", resource: "https://t.com", description: "t", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 300, asset: BASE_SEPOLIA_USDC, extra: { name: "USD Coin", version: "2", nonce: "0" } });
    const d = JSON.parse(Buffer.from(h, "base64").toString());
    expect(d.x402Version).toBe(2);
    expect(d.accepted.scheme).toBe("upto");
    expect(d.payload.authorization.from).toBe(EXPECTED_ADDRESS);
    expect(d.payload.authorization.nonce).toBe("0");
  });

  it("should verify header signature matches payer", async () => {
    const { EvmPaymentSigner } = await import("../../client/signer.js");
    const signer = new EvmPaymentSigner(TEST_KEY, "base-sepolia");
    const h = await signer.buildPaymentHeader({ scheme: "upto", network: "eip155:84532", maxAmountRequired: "10000", resource: "https://t.com", description: "t", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 300, asset: BASE_SEPOLIA_USDC, extra: { name: "USD Coin", version: "2", nonce: "0" } });
    const d = JSON.parse(Buffer.from(h, "base64").toString());
    const a = d.payload.authorization;
    expect(await verifyTypedData({ address: a.from as Hex, domain: { name: "USD Coin", version: "2", chainId: 84532n, verifyingContract: BASE_SEPOLIA_USDC }, types: PERMIT_TYPES, primaryType: "Permit", message: { owner: a.from as Hex, spender: a.to as Hex, value: BigInt(a.value), nonce: BigInt(a.nonce), deadline: BigInt(a.validBefore) }, signature: d.payload.signature as Hex })).toBe(true);
  });

  it("should enforce policy limits", async () => {
    const { PolicyEngine } = await import("../../policy/engine.js");
    const { MemoryPaymentStorage } = await import("../../storage/memory.js");
    const s = new MemoryPaymentStorage();
    const e = new PolicyEngine({ outgoing: { maxPerTransaction: 100_000n, maxTotal: 1_000_000n, windowMs: 86400000, maxTransactions: 50, allowedRecipients: [], blockedRecipients: [] }, incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] } }, s);
    expect((await e.evaluateOutgoing({ amount: 10_000n, recipient: PAY_TO, resource: "t" })).allowed).toBe(true);
    expect((await e.evaluateOutgoing({ amount: 200_000n, recipient: PAY_TO, resource: "t" })).allowed).toBe(false);
  });

  it("should trip circuit breaker on anomaly", async () => {
    const { CircuitBreaker } = await import("../../policy/circuit-breaker.js");
    const b = new CircuitBreaker({ maxPaymentsPerMinute: 100, anomalyMultiplier: 5, cooldownMs: 5000, recentWindowSize: 10 });
    for (let i = 0; i < 5; i++) { b.check(10_000n); b.recordSuccess(10_000n); }
    expect(b.check(1_000_000n).allowed).toBe(false);
    expect(b.getState()).toBe("open");
  });

  it("should handle full fetchWithPayment mock flow", async () => {
    const { EvmPaymentSigner } = await import("../../client/signer.js");
    const { createFetchWithPayment } = await import("../../client/fetch-with-payment.js");
    const { PolicyEngine } = await import("../../policy/engine.js");
    const { CircuitBreaker } = await import("../../policy/circuit-breaker.js");
    const { MemoryPaymentStorage } = await import("../../storage/memory.js");
    const storage = new MemoryPaymentStorage();
    const signer = new EvmPaymentSigner(TEST_KEY, "base-sepolia");
    const pe = new PolicyEngine({ outgoing: { maxPerTransaction: 1_000_000n, maxTotal: 10_000_000n, windowMs: 86400000, maxTransactions: 100, allowedRecipients: [], blockedRecipients: [] }, incoming: { minPerTransaction: 0n, allowedSenders: [], blockedSenders: [] } }, storage);
    const enc = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "upto", network: "eip155:84532", maxAmountRequired: "10000", resource: "https://m.test/d", description: "T", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 300, asset: BASE_SEPOLIA_USDC, extra: { name: "USD Coin", version: "2", nonce: "0" } }] })).toString("base64");
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_i: RequestInfo|URL, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response("{}", { status: 402, headers: { "Payment-Required": enc } });
      const h = init?.headers instanceof Headers ? init.headers.get("x-payment") : (init?.headers as Record<string,string>)?.["X-PAYMENT"];
      expect(h).toBeTruthy();
      const p = JSON.parse(Buffer.from(h!, "base64").toString());
      expect(p.accepted.scheme).toBe("upto");
      return new Response('{"data":"ok"}', { status: 200 });
    }) as typeof fetch;
    try {
      const noop = () => {};
      const f = createFetchWithPayment({ signer, policyEngine: pe, circuitBreaker: new CircuitBreaker(), storage, logger: { info: noop, warn: noop, error: noop, debug: noop } as never });
      const r = await f("https://m.test/d");
      expect(r.status).toBe(200);
      expect(n).toBe(2);
      expect((await storage.getRecords()).length).toBe(1);
    } finally { globalThis.fetch = orig; }
  });

  it("should produce different sigs for different deadlines", async () => {
    const { EvmPaymentSigner } = await import("../../client/signer.js");
    const s = new EvmPaymentSigner(TEST_KEY, "base-sepolia");
    const r = (t: number) => ({ scheme: "upto", network: "eip155:84532", maxAmountRequired: "10000", resource: "t", description: "t", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: t, asset: BASE_SEPOLIA_USDC, extra: { name: "USD Coin", version: "2", nonce: "0" } });
    const d1 = JSON.parse(Buffer.from(await s.buildPaymentHeader(r(300)), "base64").toString());
    const d2 = JSON.parse(Buffer.from(await s.buildPaymentHeader(r(600)), "base64").toString());
    expect(d1.payload.signature).not.toBe(d2.payload.signature);
  });

  it("should record payment with correct data in storage", async () => {
    const { MemoryPaymentStorage } = await import("../../storage/memory.js");
    const s = new MemoryPaymentStorage();
    await s.recordPayment({ id: "x", direction: "outgoing", counterparty: PAY_TO, amount: 500000n, network: "eip155:84532", txHash: "0xabc", resource: "https://t.com", status: "confirmed", createdAt: new Date().toISOString(), metadata: { scheme: "upto" } });
    expect(await s.getTotal("outgoing")).toBe(500000n);
    expect(await s.getCount("outgoing")).toBe(1);
    const recs = await s.getRecords();
    expect(recs[0].metadata.scheme).toBe("upto");
  });

  // RPC-gated tests
  const rpcUrl = process.env.BASE_SEPOLIA_RPC;
  const describeRpc = rpcUrl ? describe : describe.skip;
  describeRpc("On-chain (Base Sepolia)", () => {
    let pub: ReturnType<typeof createPublicClient>;
    beforeAll(() => { pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }); });
    it("should read USDC balance", async () => { expect(typeof await pub.readContract({ address: BASE_SEPOLIA_USDC, abi: [{ inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }], functionName: "balanceOf", args: [account.address] })).toBe("bigint"); });
    it("should read USDC nonce", async () => { expect(typeof await pub.readContract({ address: BASE_SEPOLIA_USDC, abi: [{ inputs: [{ name: "o", type: "address" }], name: "nonces", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }], functionName: "nonces", args: [account.address] })).toBe("bigint"); });
  });

  const facUrl = process.env.TEST_FACILITATOR_URL;
  const describeFac = facUrl ? describe : describe.skip;
  describeFac("Live Facilitator", () => {
    it("should verify payment with facilitator", async () => {
      const { EvmPaymentSigner } = await import("../../client/signer.js");
      const { verifyPaymentWithFacilitator } = await import("../../middleware/facilitator-client.js");
      const s = new EvmPaymentSigner(TEST_KEY, "base-sepolia");
      const req = { scheme: "upto", network: "eip155:84532", maxAmountRequired: "10000", resource: "t", description: "t", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 300, asset: BASE_SEPOLIA_USDC, extra: { name: "USD Coin", version: "2", nonce: "0" } };
      const result = await verifyPaymentWithFacilitator(await s.buildPaymentHeader(req), facUrl!, req);
      if (result.valid) expect(result.payer).toBe(EXPECTED_ADDRESS);
    });
  });
});
