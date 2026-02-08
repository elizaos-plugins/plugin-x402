/**
 * Registry of supported EVM networks for x402 payments.
 *
 * IMPORTANT: usdcDomainName MUST match the on-chain EIP-712 domain name
 * returned by the USDC contract's name() function. This varies by chain:
 *   - Ethereum mainnet: "USD Coin"
 *   - Base / Base Sepolia / testnets: "USDC"
 * Using the wrong name produces signatures the on-chain contract rejects.
 */

import type { NetworkInfo } from "./types";

export const NETWORK_REGISTRY: Record<string, NetworkInfo> = {
  base: {
    caip2: "eip155:8453",
    chainId: 8453,
    name: "Base",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDomainName: "USDC",
    usdcPermitVersion: "2",
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    chainId: 84532,
    name: "Base Sepolia",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDomainName: "USDC",
    usdcPermitVersion: "2",
  },
  ethereum: {
    caip2: "eip155:1",
    chainId: 1,
    name: "Ethereum",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDomainName: "USD Coin",
    usdcPermitVersion: "2",
  },
  sepolia: {
    caip2: "eip155:11155111",
    chainId: 11155111,
    name: "Sepolia",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdcDomainName: "USDC",
    usdcPermitVersion: "2",
  },
} as const;

export function resolveNetwork(key: string): NetworkInfo {
  const info = NETWORK_REGISTRY[key];
  if (!info) {
    const supported = Object.keys(NETWORK_REGISTRY).join(", ");
    throw new Error(`Unknown network "${key}". Supported: ${supported}`);
  }
  return info;
}

export function networkKeyFromCaip2(caip2: string): string | undefined {
  for (const [key, info] of Object.entries(NETWORK_REGISTRY)) {
    if (info.caip2 === caip2) {
      return key;
    }
  }
  return undefined;
}
