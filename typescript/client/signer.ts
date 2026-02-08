/** EVM payment signer using viem. Produces "upto" scheme payloads with ERC-2612 Permit. */

import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../networks";
import type {
  PaymentRequirement,
  PaymentSigner,
  PermitParams,
  PermitSignature,
} from "../types";

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export class EvmPaymentSigner implements PaymentSigner {
  private account: ReturnType<typeof privateKeyToAccount>;
  private network: string;

  constructor(privateKey: string, network: string) {
    // Normalize private key to have 0x prefix
    const key = privateKey.startsWith("0x")
      ? (privateKey as Hex)
      : (`0x${privateKey}` as Hex);

    this.account = privateKeyToAccount(key);
    this.network = network;
  }

  get address(): string {
    return this.account.address;
  }

  get networkId(): string {
    return resolveNetwork(this.network).caip2;
  }

  /** Sign an ERC-2612 permit for USDC. */
  async signPermit(params: PermitParams): Promise<PermitSignature> {
    const networkInfo = resolveNetwork(this.network);

    const domain = {
      name: networkInfo.usdcDomainName,
      version: networkInfo.usdcPermitVersion,
      chainId: BigInt(networkInfo.chainId),
      verifyingContract: networkInfo.usdcAddress as Hex,
    };

    const message = {
      owner: this.account.address as Hex,
      spender: params.spender as Hex,
      value: params.value,
      nonce: params.nonce,
      deadline: params.deadline,
    };

    const signature = await this.account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message,
    });

    // Parse r, s, v from the 65-byte compact signature (0x + 130 hex chars)
    const raw = signature.slice(2); // remove 0x prefix
    const r = `0x${raw.slice(0, 64)}`;
    const s = `0x${raw.slice(64, 128)}`;
    const v = parseInt(raw.slice(128, 130), 16);

    return { v, r, s };
  }

  /**
   * Build a base64-encoded x402 v2 payment header using "upto" scheme (ERC-2612 Permit).
   *
   * The facilitator's EVM verification expects:
   * - scheme "upto" with ERC-2612 Permit signature
   * - EIP-712 domain: { name, version, chainId, verifyingContract: asset }
   * - name and version come from requirement.extra
   * - nonce is the USDC contract's sequential nonce (from requirement.extra or default 0)
   *
   * NOTE: For production use, the caller should query the USDC contract's
   * nonces(owner) function and pass the result via requirement.extra.nonce.
   * The default of 0 works for fresh wallets that have never used permit.
   */
  async buildPaymentHeader(
    requirement: PaymentRequirement,
  ): Promise<string> {
    const networkInfo = resolveNetwork(this.network);
    const amount = BigInt(requirement.maxAmountRequired);

    // Read name and version from requirement.extra for the EIP-712 domain separator.
    // The facilitator's verification reconstructs the domain from these values.
    const tokenName = requirement.extra?.name ?? networkInfo.usdcDomainName;
    const tokenVersion =
      requirement.extra?.version ?? networkInfo.usdcPermitVersion;

    // Sequential nonce from the USDC contract's nonces(owner) mapping.
    // Defaults to 0 for wallets that have never used permit on this token.
    const nonce = BigInt(requirement.extra?.nonce ?? "0");

    // Deadline for the Permit (Unix timestamp)
    const deadline = BigInt(
      Math.floor(Date.now() / 1000) + requirement.maxTimeoutSeconds,
    );

    // The spender is the facilitator's signer address (payTo in the requirement)
    const spender = requirement.payTo as Hex;

    // Build EIP-712 domain using values from the requirement
    const domain = {
      name: tokenName,
      version: tokenVersion,
      chainId: BigInt(networkInfo.chainId),
      verifyingContract: requirement.asset as Hex,
    };

    const message = {
      owner: this.account.address as Hex,
      spender,
      value: amount,
      nonce,
      deadline,
    };

    // Sign the ERC-2612 Permit
    const signature = await this.account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message,
    });

    // Build the x402 v2 "upto" payment payload matching facilitator's expected structure
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "upto",
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.maxAmountRequired,
        payTo: requirement.payTo,
      },
      payload: {
        authorization: {
          from: this.account.address,
          to: requirement.payTo,
          value: requirement.maxAmountRequired,
          validBefore: deadline.toString(),
          nonce: nonce.toString(),
        },
        signature,
      },
    };

    // Base64 encode the JSON payload
    const jsonString = JSON.stringify(payload);
    return Buffer.from(jsonString).toString("base64");
  }
}
