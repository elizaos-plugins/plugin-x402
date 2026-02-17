/**
 * Core X402 payment service for ElizaOS.
 *
 * Manages wallet configuration, payment signing, policy enforcement,
 * circuit breaking, and payment tracking. Provides a fetch wrapper
 * that auto-handles 402 Payment Required responses.
 */

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

import { EvmPaymentSigner } from "../client/signer";
import {
  createFetchWithPayment,
  type X402Fetch,
} from "../client/fetch-with-payment";
import { resolveNetwork } from "../networks";
import { CircuitBreaker } from "../policy/circuit-breaker";
import { PolicyEngine } from "../policy/engine";
import { MemoryPaymentStorage } from "../storage/memory";
import { SqlitePaymentStorage } from "../storage/sqlite";
import type {
  PaymentPolicy,
  PaymentRecord,
  PaymentSigner,
  PaymentStorage,
  PaymentSummary,
  X402ServiceConfig,
} from "../types";

import { ONE_DAY_MS, usdToBaseUnits } from "../utils";

const DEFAULT_FACILITATOR_URL = "https://facilitator.daydreams.systems";

const DEFAULTS = {
  network: "base",
  maxPaymentUsd: 1.0,
  maxTotalUsd: 10.0,
} as const;

export class X402Service extends Service {
  static serviceType = "x402_payment" as const;
  capabilityDescription = "x402 HTTP payment protocol - send and receive crypto payments";

  private signer: PaymentSigner | null = null;
  private policyEngine: PolicyEngine | null = null;
  private circuitBreaker: CircuitBreaker;
  private storage: PaymentStorage;
  private serviceConfig: X402ServiceConfig;
  private fetchWithPayment: X402Fetch | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    // Initialize with safe defaults — real init happens in start()
    this.circuitBreaker = new CircuitBreaker();
    this.storage = new MemoryPaymentStorage();
    this.serviceConfig = {
      privateKey: "",
      network: DEFAULTS.network,
      payTo: "",
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      maxPaymentUsd: DEFAULTS.maxPaymentUsd,
      maxTotalUsd: DEFAULTS.maxTotalUsd,
      enabled: false,
    };
  }

  /**
   * Factory method: create and start the service.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new X402Service(runtime);
    await service.initialize(runtime);
    return service;
  }

  /**
   * Initialize the service with runtime configuration.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Read configuration from runtime settings
    // getSetting returns string | boolean | number | null — coerce to string
    const privateKey = String(runtime.getSetting("X402_PRIVATE_KEY") ?? "");
    const network = String(runtime.getSetting("X402_NETWORK") ?? DEFAULTS.network);
    const payTo = String(runtime.getSetting("X402_PAY_TO") ?? "");
    const facilitatorUrl = String(
      runtime.getSetting("X402_FACILITATOR_URL") ?? DEFAULT_FACILITATOR_URL,
    );
    const maxPaymentUsdRaw = runtime.getSetting("X402_MAX_PAYMENT_USD");
    const maxPaymentUsd = maxPaymentUsdRaw !== null
      ? parseFloat(String(maxPaymentUsdRaw))
      : DEFAULTS.maxPaymentUsd;
    const maxTotalUsdRaw = runtime.getSetting("X402_MAX_TOTAL_USD");
    const maxTotalUsd = maxTotalUsdRaw !== null
      ? parseFloat(String(maxTotalUsdRaw))
      : DEFAULTS.maxTotalUsd;
    const enabledSetting = runtime.getSetting("X402_ENABLED");
    const enabled =
      String(enabledSetting) !== "false" && privateKey.length > 0;

    this.serviceConfig = {
      privateKey,
      network,
      payTo,
      facilitatorUrl,
      maxPaymentUsd: isNaN(maxPaymentUsd) ? DEFAULTS.maxPaymentUsd : maxPaymentUsd,
      maxTotalUsd: isNaN(maxTotalUsd) ? DEFAULTS.maxTotalUsd : maxTotalUsd,
      enabled,
    };

    if (!enabled) {
      logger.info(
        "[x402] Service inactive — no private key configured or explicitly disabled",
      );
      return;
    }

    // Validate network
    try {
      resolveNetwork(network);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[x402] Invalid network configuration: ${message}`);
      this.serviceConfig.enabled = false;
      return;
    }

    // Create signer
    try {
      this.signer = new EvmPaymentSigner(privateKey, network);
      logger.info(
        `[x402] Wallet initialized: ${this.signer.address} on ${network}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[x402] Failed to initialize signer: ${message}`);
      this.serviceConfig.enabled = false;
      return;
    }

    // Security: clear the private key from config now that the signer has it.
    // The signer holds the key internally via viem's account object.
    this.serviceConfig.privateKey = "";

    // Auto-select storage backend
    const dbPath = String(runtime.getSetting("X402_DB_PATH") ?? "");
    if (dbPath) {
      try {
        this.storage = new SqlitePaymentStorage(dbPath);
        logger.info(`[x402] Using SQLite storage at ${dbPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[x402] Failed to initialize SQLite storage: ${message}. Falling back to memory storage.`);
        this.storage = new MemoryPaymentStorage();
      }
    } else {
      logger.info("[x402] Using in-memory storage (set X402_DB_PATH for persistence)");
    }

    // Build default policy
    const policy: PaymentPolicy = {
      outgoing: {
        maxPerTransaction: usdToBaseUnits(this.serviceConfig.maxPaymentUsd),
        maxTotal: usdToBaseUnits(this.serviceConfig.maxTotalUsd),
        windowMs: ONE_DAY_MS,
        maxTransactions: 1000,
        allowedRecipients: [],
        blockedRecipients: [],
      },
      incoming: {
        minPerTransaction: 0n,
        allowedSenders: [],
        blockedSenders: [],
      },
    };

    this.policyEngine = new PolicyEngine(policy, this.storage);
    this.circuitBreaker = new CircuitBreaker();

    // Create the fetch wrapper
    this.fetchWithPayment = createFetchWithPayment({
      signer: this.signer,
      policyEngine: this.policyEngine,
      circuitBreaker: this.circuitBreaker,
      storage: this.storage,
      logger,
    });

    logger.info(
      `[x402] Service active — max per-txn: $${this.serviceConfig.maxPaymentUsd}, max daily: $${this.serviceConfig.maxTotalUsd}`,
    );
  }

  async stop(): Promise<void> {
    logger.info("[x402] Service stopping");
    this.signer = null;
    this.fetchWithPayment = null;
  }

  /**
   * Get a fetch function that automatically handles 402 Payment Required.
   * Returns the standard fetch if the service is inactive.
   */
  getFetchWithPayment(): X402Fetch {
    if (!this.fetchWithPayment) {
      return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    }
    return this.fetchWithPayment;
  }

  /**
   * Get a summary of payment activity.
   * @param windowMs - Time window in milliseconds (default: 24h)
   */
  async getSummary(windowMs: number = ONE_DAY_MS): Promise<PaymentSummary> {
    const [totalSpent, totalEarned, outgoingCount, incomingCount] =
      await Promise.all([
        this.storage.getTotal("outgoing", windowMs),
        this.storage.getTotal("incoming", windowMs),
        this.storage.getCount("outgoing", windowMs),
        this.storage.getCount("incoming", windowMs),
      ]);

    return {
      totalSpent,
      totalEarned,
      outgoingCount,
      incomingCount,
      windowMs,
    };
  }

  /**
   * Get recent payment transactions.
   * @param limit - Maximum number of records to return
   */
  async getRecentTransactions(limit: number = 20): Promise<PaymentRecord[]> {
    return this.storage.getRecords({ limit });
  }

  isActive(): boolean {
    return this.serviceConfig.enabled && this.signer !== null;
  }

  canMakePayments(): boolean {
    return this.isActive() && this.fetchWithPayment !== null;
  }

  updatePolicy(policy: Partial<PaymentPolicy>): void {
    if (this.policyEngine) {
      this.policyEngine.updatePolicy(policy);
      logger.info("[x402] Payment policy updated");
    }
  }

  getWalletAddress(): string | null {
    return this.signer?.address ?? null;
  }

  getNetwork(): string {
    return this.serviceConfig.network;
  }

  getFacilitatorUrl(): string {
    return this.serviceConfig.facilitatorUrl;
  }

  getPayToAddress(): string {
    return this.serviceConfig.payTo;
  }

  getStorage(): PaymentStorage {
    return this.storage;
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
    logger.info("[x402] Circuit breaker reset");
  }
}
