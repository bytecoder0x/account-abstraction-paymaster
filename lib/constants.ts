import { parseGwei } from "viem";

export const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as const;

export const DEFAULT_GAS_LIMITS = {
  callGasLimit: 300_000n,
  verificationGasLimit: 600_000n,
  preVerificationGas: 100_000n,
  paymasterVerificationGasLimit: 300_000n,
  paymasterPostOpGasLimit: 150_000n,
};

export const DEFAULT_GAS_FEES = {
  maxFeePerGas: parseGwei("10"),
  maxPriorityFeePerGas: parseGwei("1"),
};

export const SPONSORSHIP_VALIDITY = 3600;
