/**
 * Real Payment Test Script - Executes REAL on-chain USDC transfer on Base Sepolia
 *
 * USAGE:
 *   export PAYER_PRIVATE_KEY=0x...
 *   export FACILITATOR_PRIVATE_KEY=0x...
 *   export PAY_TO=0x...
 *   export AMOUNT=10000
 *   npx tsx src/__tests__/e2e/real-payment.ts
 */
import { createPublicClient, createWalletClient, http, type Hex, verifyTypedData, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const PAYER_KEY = process.env.PAYER_PRIVATE_KEY;
const FAC_KEY = process.env.FACILITATOR_PRIVATE_KEY ?? PAYER_KEY;
const PAY_TO = process.env.PAY_TO;
const AMT = BigInt(process.env.AMOUNT ?? "10000");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const RPC = "https://sepolia.base.org";

const balAbi = [{ inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }] as const;
const txAuthAbi = [{ inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], name: "transferWithAuthorization", outputs: [], stateMutability: "nonpayable", type: "function" }] as const;
const AUTH_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;

function fmt(a: bigint) { return "$" + formatUnits(a, 6); }
function nonce(): Hex { const b = new Uint8Array(32); crypto.getRandomValues(b); return ("0x" + Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("")) as Hex; }

async function main() {
  console.log("\n=== x402 Real Payment Test (Base Sepolia) ===\n");
  if (!PAYER_KEY) { console.error("Set PAYER_PRIVATE_KEY"); process.exit(1); }
  if (!PAY_TO) { console.error("Set PAY_TO"); process.exit(1); }

  const payer = privateKeyToAccount(PAYER_KEY as Hex);
  const fac = privateKeyToAccount(FAC_KEY as Hex);
  console.log("Payer:", payer.address, "\nFacilitator:", fac.address, "\nPay To:", PAY_TO, "\nAmount:", fmt(AMT));

  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const pBal = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [payer.address] }) as bigint;
  const rBal = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [PAY_TO as Hex] }) as bigint;
  const fEth = await pub.getBalance({ address: fac.address });
  console.log("\nPayer USDC:", fmt(pBal), "| Recipient USDC:", fmt(rBal), "| Fac ETH:", formatUnits(fEth, 18));
  if (pBal < AMT) { console.error("Insufficient USDC"); process.exit(1); }
  if (fEth === 0n) { console.error("Facilitator needs ETH"); process.exit(1); }

  const dl = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const n = nonce();
  const domain = { name: "USD Coin", version: "2", chainId: BigInt(baseSepolia.id), verifyingContract: USDC };
  const msg = { from: payer.address, to: PAY_TO as Hex, value: AMT, validAfter: 0n, validBefore: dl, nonce: n };

  console.log("\nSigning EIP-3009...");
  const sig = await payer.signTypedData({ domain, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: msg });
  const valid = await verifyTypedData({ address: payer.address, domain, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: msg, signature: sig });
  console.log("Sig valid:", valid);
  if (!valid) { console.error("Bad sig!"); process.exit(1); }

  const raw = sig.slice(2);
  const r = ("0x" + raw.slice(0, 64)) as Hex;
  const s = ("0x" + raw.slice(64, 128)) as Hex;
  const v = parseInt(raw.slice(128, 130), 16);

  const wc = createWalletClient({ account: fac, chain: baseSepolia, transport: http(RPC) });
  console.log("\nSettling on-chain...");
  const tx = await wc.writeContract({ address: USDC, abi: txAuthAbi, functionName: "transferWithAuthorization", args: [payer.address, PAY_TO as Hex, AMT, 0n, dl, n, v, r, s] });
  console.log("TX:", tx, "\nhttps://sepolia.basescan.org/tx/" + tx, "\nWaiting...");

  const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("Status:", rcpt.status, "| Block:", rcpt.blockNumber, "| Gas:", rcpt.gasUsed);
  if (rcpt.status !== "success") { console.error("Reverted!"); process.exit(1); }

  const np = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [payer.address] }) as bigint;
  const nr = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [PAY_TO as Hex] }) as bigint;
  console.log("\nPayer:", fmt(pBal), "->", fmt(np), "(" + fmt(pBal - np) + " sent)");
  console.log("Recip:", fmt(rBal), "->", fmt(nr), "(" + fmt(nr - rBal) + " received)");

  if (pBal - np !== AMT || nr - rBal !== AMT) { console.error("Mismatch!"); process.exit(1); }
  console.log("\n" + "=".repeat(50) + "\n  x402 REAL PAYMENT: ALL PASSED\n  " + fmt(AMT) + " transferred | TX: " + tx + "\n" + "=".repeat(50));
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
