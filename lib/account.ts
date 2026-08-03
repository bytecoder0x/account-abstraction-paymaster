import { encodeFunctionData, erc20Abi, type Abi, type Address, type Hex } from "viem";

interface AccountContract {
  address: Address;
  abi: Abi;
}

interface Writer {
  writeContract: (args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }) => Promise<Hex>;
}

/** Sends an ERC-20 approval through the account's own `execute`, signed by its owner. */
export function approveFromAccount(
  owner: Writer,
  account: AccountContract,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<Hex> {
  return owner.writeContract({
    address: account.address,
    abi: account.abi,
    functionName: "execute",
    args: [
      token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    ],
  });
}
