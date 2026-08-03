import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

import { ACCOUNT_OWNER_KEY, PAYMASTER_SIGNER_KEY } from "./fixture.js";

const LOCAL_CHAIN_IDS = new Set([31337]);

export const isLocalChain = (chainId: number) => LOCAL_CHAIN_IDS.has(chainId);

function readKey(name: string, localFallback: Hex, chainId: number): PrivateKeyAccount {
  const value = process.env[name];

  if (!value) {
    if (!isLocalChain(chainId)) throw new Error(`${name} must be set to run on chain ${chainId}.`);

    console.warn(`${name} is not set — using the local development key.`);
    return privateKeyToAccount(localFallback);
  }

  return privateKeyToAccount(value.startsWith("0x") ? (value as Hex) : (`0x${value}` as Hex));
}

export const paymasterSignerAccount = (chainId: number) =>
  readKey("PAYMASTER_SIGNER_PRIVATE_KEY", PAYMASTER_SIGNER_KEY, chainId);

export const accountOwnerAccount = (chainId: number) =>
  readKey("ACCOUNT_OWNER_PRIVATE_KEY", ACCOUNT_OWNER_KEY, chainId);

export const accountSalt = () => BigInt(process.env.ACCOUNT_SALT ?? "0");
