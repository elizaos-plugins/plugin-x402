/**
 * Shared utility functions for the x402 plugin.
 */

/** 24 hours in milliseconds */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Format USDC base units (6 decimals) as human-readable USD string */
export function formatUsd(baseUnits: bigint): string {
  const dollars = Number(baseUnits) / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

/** Truncate an Ethereum address for display (e.g. "0x1234...5678") */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Convert whole USD dollars to USDC base units (6 decimals) */
export function usdToBaseUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}
