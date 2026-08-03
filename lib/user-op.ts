import {
  concatHex,
  encodeFunctionData,
  numberToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Account } from "viem/accounts";

import { DEFAULT_GAS_FEES, DEFAULT_GAS_LIMITS } from "./constants.js";

export interface UserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

export type GasLimits = typeof DEFAULT_GAS_LIMITS;
export type GasFees = typeof DEFAULT_GAS_FEES;

/** Terms the paymaster signs. A zero `token` sponsors the operation outright. */
export interface Sponsorship {
  validUntil: number;
  validAfter: number;
  token: Address;
  exchangeRate: bigint;
  poolFee: number;
}

export const FREE_SPONSORSHIP: Sponsorship = {
  validUntil: 0,
  validAfter: 0,
  token: zeroAddress,
  exchangeRate: 0n,
  poolFee: 0,
};

export const SPONSORSHIP_TYPES = {
  SponsorshipRequest: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "validUntil", type: "uint48" },
    { name: "validAfter", type: "uint48" },
    { name: "token", type: "address" },
    { name: "exchangeRate", type: "uint256" },
    { name: "poolFee", type: "uint24" },
  ],
} as const;

export function packUints(high: bigint, low: bigint): Hex {
  return concatHex([numberToHex(high, { size: 16 }), numberToHex(low, { size: 16 })]);
}

export function encodeExecute(abi: Abi, target: Address, value: bigint, data: Hex): Hex {
  return encodeFunctionData({ abi, functionName: "execute", args: [target, value, data] });
}

export function encodeExecuteBatch(abi: Abi, calls: Call[]): Hex {
  return encodeFunctionData({ abi, functionName: "executeBatch", args: [calls] });
}

export function encodeInitCode(factory: Address, abi: Abi, owner: Address, salt: bigint): Hex {
  return concatHex([
    factory,
    encodeFunctionData({ abi, functionName: "createAccount", args: [owner, salt] }),
  ]);
}

export function buildUserOp(params: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  initCode?: Hex;
  gasLimits?: Partial<GasLimits>;
  gasFees?: Partial<GasFees>;
}): UserOp {
  const limits = { ...DEFAULT_GAS_LIMITS, ...params.gasLimits };
  const fees = { ...DEFAULT_GAS_FEES, ...params.gasFees };

  return {
    sender: params.sender,
    nonce: params.nonce,
    initCode: params.initCode ?? "0x",
    callData: params.callData,
    // High 16 bytes first in both packed words.
    accountGasLimits: packUints(limits.verificationGasLimit, limits.callGasLimit),
    preVerificationGas: limits.preVerificationGas,
    gasFees: packUints(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** 184 bytes: paymaster | gas limits | validUntil | validAfter | token | rate | poolFee | sig. */
export function encodePaymasterAndData(params: {
  paymaster: Address;
  sponsorship: Sponsorship;
  signature: Hex;
  gasLimits?: Partial<GasLimits>;
}): Hex {
  const limits = { ...DEFAULT_GAS_LIMITS, ...params.gasLimits };
  const { validUntil, validAfter, token, exchangeRate, poolFee } = params.sponsorship;

  return concatHex([
    params.paymaster,
    numberToHex(limits.paymasterVerificationGasLimit, { size: 16 }),
    numberToHex(limits.paymasterPostOpGasLimit, { size: 16 }),
    numberToHex(validUntil, { size: 6 }),
    numberToHex(validAfter, { size: 6 }),
    token,
    numberToHex(exchangeRate, { size: 32 }),
    numberToHex(poolFee, { size: 3 }),
    params.signature,
  ]);
}

export async function signSponsorship(params: {
  signer: Account;
  paymaster: Address;
  chainId: number;
  userOp: UserOp;
  sponsorship: Sponsorship;
}): Promise<Hex> {
  const { signer, paymaster, chainId, userOp, sponsorship } = params;

  if (!signer.signTypedData) throw new Error("signer cannot sign typed data");

  return signer.signTypedData({
    domain: { name: "VerifyingPaymaster", version: "1", chainId, verifyingContract: paymaster },
    types: SPONSORSHIP_TYPES,
    primaryType: "SponsorshipRequest",
    message: {
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      ...sponsorship,
    },
  });
}

export async function signUserOp(
  client: PublicClient,
  entryPoint: { address: Address; abi: Abi },
  owner: Account,
  userOp: UserOp,
): Promise<UserOp> {
  const hash = (await client.readContract({
    address: entryPoint.address,
    abi: entryPoint.abi,
    functionName: "getUserOpHash",
    args: [userOp],
  })) as Hex;

  // EntryPoint v0.8 returns an EIP-712 digest, so it is signed as-is, without an EIP-191 prefix.
  if (!owner.sign) throw new Error("owner cannot sign raw hashes");

  return { ...userOp, signature: await owner.sign({ hash }) };
}

export async function createSponsoredUserOp(params: {
  publicClient: PublicClient;
  entryPoint: { address: Address; abi: Abi };
  paymaster: Address;
  paymasterSigner: Account;
  owner: Account;
  sender: Address;
  callData: Hex;
  chainId: number;
  sponsorship?: Sponsorship;
  initCode?: Hex;
  gasLimits?: Partial<GasLimits>;
  gasFees?: Partial<GasFees>;
  nonce?: bigint;
}): Promise<UserOp> {
  const { publicClient, entryPoint, paymaster, sponsorship = FREE_SPONSORSHIP } = params;

  const nonce =
    params.nonce ??
    ((await publicClient.readContract({
      address: entryPoint.address,
      abi: entryPoint.abi,
      functionName: "getNonce",
      args: [params.sender, 0n],
    })) as bigint);

  const userOp = buildUserOp({ ...params, nonce });

  // The sponsor signs first: the account signature covers the resulting paymasterAndData.
  const signature = await signSponsorship({
    signer: params.paymasterSigner,
    paymaster,
    chainId: params.chainId,
    userOp,
    sponsorship,
  });

  return signUserOp(publicClient, entryPoint, params.owner, {
    ...userOp,
    paymasterAndData: encodePaymasterAndData({
      paymaster,
      sponsorship,
      signature,
      gasLimits: params.gasLimits,
    }),
  });
}
