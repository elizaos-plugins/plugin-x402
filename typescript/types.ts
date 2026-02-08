// x402 plugin types. All monetary amounts are bigint in USDC base units (6 decimals, $1 = 1_000_000n).

// Network registry

/** Supported EVM network descriptor */
export interface NetworkInfo {
  /** CAIP-2 chain identifier (e.g. "eip155:8453") */
  caip2: string;
  /** EVM numeric chain ID */
  chainId: number;
  /** Human-readable network name */
  name: string;
  /** USDC token contract address on this chain */
  usdcAddress: `0x${string}`;
  /** USDC EIP-712 domain name — "USD Coin" on Ethereum mainnet, "USDC" on Base/testnets */
  usdcDomainName: string;
  /** USDC ERC-2612 permit version string (typically "2") */
  usdcPermitVersion: string;
}


// Payment records & directions

/** Direction of a payment relative to this agent */
export type PaymentDirection = "outgoing" | "incoming";

/** Payment status */
export type PaymentStatus = "pending" | "confirmed" | "failed" | "refunded";

/** A single payment record persisted to storage */
export interface PaymentRecord {
  id: string;
  direction: PaymentDirection;
  counterparty: string;
  /** Amount in USDC base units (6 decimals) */
  amount: bigint;
  /** CAIP-2 network identifier */
  network: string;
  txHash: string;
  resource: string;
  status: PaymentStatus;
  createdAt: string;
  metadata: Record<string, string>;
}

/** Summary of payment activity over a time window */
export interface PaymentSummary {
  /** Total spent (outgoing) in USDC base units */
  totalSpent: bigint;
  /** Total earned (incoming) in USDC base units */
  totalEarned: bigint;
  outgoingCount: number;
  incomingCount: number;
  windowMs: number;
}

// Payment policies

/** Limits applied to outgoing (agent-pays) transactions */
export interface OutgoingLimit {
  /** Maximum amount per single transaction in USDC base units */
  maxPerTransaction: bigint;
  /** Maximum total amount within `windowMs` in USDC base units */
  maxTotal: bigint;
  /** Time window in milliseconds for the total limit */
  windowMs: number;
  /** Maximum number of transactions within `windowMs` */
  maxTransactions: number;
  /** Allowed recipient addresses (empty = allow all) */
  allowedRecipients: string[];
  /** Blocked recipient addresses */
  blockedRecipients: string[];
}

/** Limits applied to incoming (agent-receives) transactions */
export interface IncomingLimit {
  /** Minimum amount to accept per transaction in USDC base units */
  minPerTransaction: bigint;
  /** Allowed sender addresses (empty = allow all) */
  allowedSenders: string[];
  /** Blocked sender addresses */
  blockedSenders: string[];
}

/** Full payment policy configuration */
export interface PaymentPolicy {
  outgoing: OutgoingLimit;
  incoming: IncomingLimit;
}

// Storage interface

/** Filters for querying payment records */
export interface PaymentFilters {
  direction?: PaymentDirection;
  counterparty?: string;
  status?: PaymentStatus;
  network?: string;
  /** Only return records created after this ISO-8601 timestamp */
  since?: string;
  /** Only return records created before this ISO-8601 timestamp */
  until?: string;
  /** Maximum number of records to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/** Persistence layer for payment records */
export interface PaymentStorage {
  /** Record a new payment */
  recordPayment(record: PaymentRecord): Promise<void>;
  /** Sum of amounts for a direction within a time window, optionally scoped to counterparty */
  getTotal(direction: PaymentDirection, windowMs?: number, scope?: string): Promise<bigint>;
  /** Retrieve filtered payment records */
  getRecords(filters?: PaymentFilters): Promise<PaymentRecord[]>;
  /** Count payments for a direction within a time window */
  getCount(direction: PaymentDirection, windowMs?: number): Promise<number>;
  /** Clear all records */
  clear(): Promise<void>;
}

// Service configuration

/** Configuration for the X402 service */
export interface X402ServiceConfig {
  /** EVM private key (hex-encoded, with or without 0x prefix) */
  privateKey: string;
  /** Network key (e.g. "base", "base-sepolia") */
  network: string;
  payTo: string;
  /** Facilitator service URL */
  facilitatorUrl: string;
  /** Maximum USD amount for a single outgoing payment (in whole dollars) */
  maxPaymentUsd: number;
  /** Maximum total USD spend per day (in whole dollars) */
  maxTotalUsd: number;
  enabled: boolean;
}

// Payment signer

/** ERC-2612 permit signature components */
export interface PermitSignature {
  v: number;
  r: string;
  s: string;
}

/** Parameters for signing an ERC-2612 permit */
export interface PermitParams {
  /** Spender address (the facilitator contract) */
  spender: string;
  /** Amount in USDC base units */
  value: bigint;
  /** Permit deadline as a Unix timestamp */
  deadline: bigint;
  /** Current USDC nonce for the owner */
  nonce: bigint;
}

/** Abstraction over the signing mechanism */
export interface PaymentSigner {
  readonly address: string;
  readonly networkId: string;
  /** Sign an ERC-2612 permit */
  signPermit(params: PermitParams): Promise<PermitSignature>;
  /** Build a full x402 payment header from a payment requirement */
  buildPaymentHeader(requirement: PaymentRequirement): Promise<string>;
}

// x402 protocol types

/** Payment requirement returned in a 402 response */
export interface PaymentRequirement {
  /** Scheme identifier (e.g. "exact") */
  scheme: string;
  /** Network identifier (CAIP-2 format) */
  network: string;
  /** Maximum amount payable in USDC base units (string for JSON transport) */
  maxAmountRequired: string;
  /** Resource URL that requires payment */
  resource: string;
  /** Description of what is being paid for */
  description: string;
  /** MIME type of the content behind the paywall */
  mimeType: string;
  /** Address of the payment recipient */
  payTo: string;
  /** Maximum timeout for payment in seconds */
  maxTimeoutSeconds: number;
  /** USDC token contract address */
  asset: string;
  /** Additional extra data */
  extra: Record<string, string>;
}

/** Decoded 402 response payload (the JSON in the PAYMENT-REQUIRED header) */
export interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

/** Result of evaluating a policy */
export interface PolicyResult {
  allowed: boolean;
  reason: string;
}

/** Request to evaluate an outgoing payment against policy */
export interface OutgoingPaymentRequest {
  /** Amount in USDC base units */
  amount: bigint;
  recipient: string;
  resource: string;
}

/** Request to evaluate an incoming payment against policy */
export interface IncomingPaymentRequest {
  /** Amount in USDC base units */
  amount: bigint;
  sender: string;
}

// Circuit breaker

/** Circuit breaker state */
export type CircuitState = "closed" | "open" | "half-open";

/** Configuration for the circuit breaker */
export interface CircuitBreakerConfig {
  /** Maximum payments per minute before tripping */
  maxPaymentsPerMinute: number;
  /** If a single payment exceeds this multiple of the recent average, trip */
  anomalyMultiplier: number;
  /** How long the breaker stays open before transitioning to half-open (ms) */
  cooldownMs: number;
  /** Number of recent payments to use for average calculation */
  recentWindowSize: number;
}

// Paywall middleware

/** Configuration for the paywall middleware */
export interface PaywallConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  /** Amount in USDC base units to charge per request */
  amount: bigint;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
}

/** Result of facilitator verification */
export interface FacilitatorVerifyResult {
  valid: boolean;
  payer?: string;
  txHash?: string;
  reason?: string;
}

/** Paywall middleware function signature */
export type PaywallMiddleware = (
  req: PaywallRequest,
  res: PaywallResponse,
  next: () => void,
) => Promise<void>;

/** Minimal request shape for paywall middleware */
export interface PaywallRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
}

/** Minimal response shape for paywall middleware */
export interface PaywallResponse {
  status: (code: number) => PaywallResponse;
  json: (data: Record<string, string | number | boolean | Record<string, string>[]>) => PaywallResponse;
  setHeader: (name: string, value: string) => PaywallResponse;
  end: () => PaywallResponse;
}
