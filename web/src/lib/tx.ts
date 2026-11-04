"use client";

import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  keccak256,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PrivateKeyAccount,
  type TransactionReceipt,
} from "viem";

import { whizzAbi } from "./abi";
import { monadTestnet, publicClient, WHIZZ_ADDRESS } from "./chain";
import { statsStore } from "./stats";

type WriteFn = ContractFunctionName<typeof whizzAbi, "nonpayable" | "payable">;

/**
 * Monad charges the gas LIMIT you set, not the gas you actually use.
 * So instead of a generous default limit we estimate, add a small safety
 * buffer, and cache it per function (except sendSnap, whose cost depends on
 * the photo size).
 */
const gasCache = new Map<string, bigint>();
const BUFFER_PCT = 115n;

/**
 * Gas price cache. Fetching fees costs 1–2 RPC round trips (200–600ms each
 * from a phone), so we fetch once and refresh in the background.
 */
type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
let fees: Fees | null = null;
let feesAt = 0;
const FEES_TTL_MS = 15_000;

async function getFees(): Promise<Fees> {
  if (!fees || Date.now() - feesAt > FEES_TTL_MS) {
    const f = await publicClient.estimateFeesPerGas();
    fees = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    feesAt = Date.now();
  }
  return fees;
}

/** Call once on app start so the first snap doesn't wait for a fee lookup. */
export function warmUp() {
  void getFees().catch(() => {});
}

export class WhizzTxError extends Error {}

const isInsufficientBalance = (e: unknown) => /insufficient balance|insufficient funds/i.test(String((e as Error)?.message ?? e));
const isRateLimited = (e: unknown) => /429|rate limit/i.test(String((e as Error)?.message ?? e));
const isAlreadyKnown = (e: unknown) => /already known|nonce too low|known transaction/i.test(String((e as Error)?.message ?? e));

/**
 * FAST PATH — one network round trip per transaction:
 *  1. sign locally (cached gas price, local nonce, cached gas limit)
 *  2. `eth_sendRawTransactionSync` (EIP-7966): Monad's RPC sends the tx AND
 *     returns the receipt in the same call — no receipt polling.
 * Falls back to send + poll if the sync call fails for a non-revert reason.
 */
async function sendSigned(serializedTransaction: Hex): Promise<TransactionReceipt> {
  // A brand-new wallet's gas money can take a few blocks to become spendable
  // on Monad (execution runs slightly behind consensus) — retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      return await publicClient.sendRawTransactionSync({ serializedTransaction, throwOnReceiptRevert: false, timeout: 15_000 });
    } catch (err) {
      if (isInsufficientBalance(err) && attempt < 12) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (isInsufficientBalance(err)) throw err;
      // HTTP 429 = rejected before processing, so resending the same signed tx is safe.
      if (isRateLimited(err) && attempt < 6) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** Math.min(attempt, 4) + Math.random() * 300));
        continue;
      }
      // Sync method unavailable / flaky: broadcast normally (ignore "already known"
      // in case the sync call did broadcast) and poll for the receipt by hash.
      await publicClient.sendRawTransaction({ serializedTransaction }).catch((e) => {
        if (!isAlreadyKnown(e)) throw e;
      });
      return publicClient.waitForTransactionReceipt({
        hash: keccak256(serializedTransaction),
        pollingInterval: 100,
        timeout: 20_000,
      });
    }
  }
}

/**
 * Shared send path for EVERY transaction (contract calls and plain MON transfers):
 * cached fees → local nonce → sign → one-call send → scoreboard stats.
 * `started` is when the user tapped, so the scoreboard measures the full wait.
 */
async function signAndSend(opts: {
  account: PrivateKeyAccount;
  to: `0x${string}`;
  data?: Hex;
  value?: bigint;
  gas: bigint;
  label: string;
  started: number;
}): Promise<TransactionReceipt> {
  const { account, to, data, value, gas, label, started } = opts;

  let receipt: TransactionReceipt;
  try {
    const { maxFeePerGas, maxPriorityFeePerGas } = await getFees();
    const nonce = await account.nonceManager!.consume({
      address: account.address,
      chainId: monadTestnet.id,
      client: publicClient,
    });
    const signed = await account.signTransaction({
      chainId: monadTestnet.id,
      type: "eip1559",
      to,
      data,
      value: value ?? 0n,
      gas,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    try {
      receipt = await sendSigned(signed);
    } catch (e) {
      // The tx never made it on-chain, so its nonce is unused — resync from the chain.
      account.nonceManager!.reset({ address: account.address, chainId: monadTestnet.id });
      throw e;
    }
  } catch (e) {
    statsStore.resolvePending(); // nothing confirmed — just clear the ⏳ counter
    throw e;
  }

  statsStore.resolvePending({
    hash: receipt.transactionHash,
    label,
    latencyMs: Math.round(performance.now() - started),
    gasUsed: receipt.gasUsed,
    gasLimit: gas,
    gasPrice: receipt.effectiveGasPrice,
    block: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new WhizzTxError(`${label} reverted on-chain`);
  return receipt;
}

export async function writeWhizz<F extends WriteFn>(opts: {
  account: PrivateKeyAccount;
  functionName: F;
  args: ContractFunctionArgs<typeof whizzAbi, "nonpayable" | "payable", F>;
  value?: bigint;
  label?: string;
}): Promise<TransactionReceipt> {
  if (!WHIZZ_ADDRESS) throw new WhizzTxError("Contract not deployed yet — run the deploy script.");
  const { account, functionName, args, value, label = functionName } = opts;

  const data = encodeFunctionData({ abi: whizzAbi, functionName, args } as never);
  const cacheable = functionName !== "sendSnap";

  statsStore.addPending();
  const started = performance.now();
  let resolved = false;
  try {
    let gas = cacheable ? gasCache.get(functionName) : undefined;
    if (!gas) {
      // estimateGas simulates the call, so a revert (e.g. "SnapExpired") surfaces here, before paying.
      const estimate = await publicClient.estimateContractGas({
        address: WHIZZ_ADDRESS,
        abi: whizzAbi,
        functionName,
        args,
        account,
        value,
      } as never);
      gas = (estimate * BUFFER_PCT) / 100n;
      if (cacheable) gasCache.set(functionName, gas);
    }
    resolved = true; // signAndSend records the stats from here on
    return await signAndSend({ account, to: WHIZZ_ADDRESS, data, value, gas, label, started });
  } catch (err) {
    if (!resolved) statsStore.resolvePending();
    throw new WhizzTxError(friendlyError(err));
  }
}

/** A plain MON transfer always uses exactly this much gas (when sent to a normal wallet). */
export const TRANSFER_GAS = 21_000n;
/** Kept back on "Max" so a rounding or fee wobble can never make the send fail. */
const MAX_SEND_MARGIN = 1_000_000_000_000_000n; // 0.001 MON

/**
 * The most this wallet can send right now: balance minus the gas it will be
 * charged (Monad bills gas LIMIT × max fee) minus a small safety margin.
 */
export async function maxSendable(balance: bigint): Promise<bigint> {
  const { maxFeePerGas } = await getFees();
  const max = balance - TRANSFER_GAS * maxFeePerGas - MAX_SEND_MARGIN;
  return max > 0n ? max : 0n;
}

/** Send MON from the in-app wallet to any address (Withdraw). */
export async function sendMon(opts: {
  account: PrivateKeyAccount;
  to: `0x${string}`;
  value: bigint;
}): Promise<TransactionReceipt> {
  const { account, to, value } = opts;
  statsStore.addPending();
  const started = performance.now();
  let resolved = false;
  try {
    // Sending to a normal wallet (no contract code) costs exactly 21,000 gas —
    // the same amount maxSendable() reserves. Monad's estimate pads transfers
    // (~21,165) and Monad bills the full limit, so we use the exact figure.
    // A contract recipient may need more: estimate it and add the usual buffer.
    const code = await publicClient.getCode({ address: to });
    const isContract = code !== undefined && code !== "0x";
    const gas = isContract
      ? ((await publicClient.estimateGas({ account, to, value })) * BUFFER_PCT) / 100n
      : TRANSFER_GAS;
    resolved = true;
    return await signAndSend({ account, to, value, gas, label: "withdraw", started });
  } catch (err) {
    if (!resolved) statsStore.resolvePending();
    throw new WhizzTxError(friendlyError(err));
  }
}

/** Turns viem errors into short, human messages (custom error names from the contract). */
export function friendlyError(err: unknown): string {
  if (err instanceof WhizzTxError) return err.message;
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      return ERROR_TEXT[revert.data.errorName] ?? revert.data.errorName;
    }
    if (/insufficient funds/i.test(err.message)) return "Not enough MON for gas — tap 'Get gas'.";
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

const ERROR_TEXT: Record<string, string> = {
  InvalidName: "Names are 3–20 chars: a-z, 0-9, _",
  NameTaken: "That name is taken 😬",
  InvalidRecipient: "Can't send to that user",
  InvalidDuration: "Pick a valid timer",
  NotRecipient: "This snap isn't for you",
  NotParticipant: "You're not in this snap",
  SnapExpired: "Too late — this snap went poof 💨",
  SnapNotExpired: "Not expired yet",
  NothingLeft: "Nothing left in this snap",
  UnknownSnap: "Snap not found",
  UnknownRain: "Rain not found",
  InvalidDrops: "Total must split evenly into drops",
  RainOver: "This rain is over ☀️",
  AlreadyCaught: "You already caught a drop 💧",
  CannotCatchOwnRain: "Can't catch your own rain",
  RainStillActive: "Rain is still going",
  TransferFailed: "Transfer failed",
  NoSuchUser: "No Whizz user with that name",
  AlreadyFriends: "You're already friends 🤝",
  NotFriends: "You're not friends",
  TooManyFriends: "Friend list is full (500 max)",
};
