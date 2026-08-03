import {
  encodeFunctionData,
  erc20Abi,
  formatEther,
  maxUint256,
  zeroAddress,
  type Address,
} from "viem";
import { network } from "hardhat";

import { approveFromAccount } from "../lib/account.js";
import { SPONSORSHIP_VALIDITY } from "../lib/constants.js";
import { loadDeployment } from "../lib/deployments.js";
import { accountOwnerAccount, accountSalt, paymasterSignerAccount } from "../lib/env.js";
import {
  createSponsoredUserOp,
  encodeExecute,
  encodeInitCode,
  type Sponsorship,
} from "../lib/user-op.js";

const SWAP_GAS_LIMITS = { paymasterPostOpGasLimit: 500_000n };

const feeTokenAddress = (deployed?: Address): Address => {
  const token = (process.env.FEE_TOKEN as Address | undefined) ?? deployed;

  if (!token) throw new Error("FEE_EXCHANGE_RATE is set but no FEE_TOKEN is available.");

  return token;
};

const sendSponsoredUserOp = async () => {
  const { viem } = await network.getOrCreate();

  const publicClient = await viem.getPublicClient();
  const [bundler] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  const deployment = await loadDeployment(chainId);

  const owner = accountOwnerAccount(chainId);
  const paymasterSigner = paymasterSignerAccount(chainId);
  const salt = accountSalt();

  const entryPoint = await viem.getContractAt("EntryPoint", deployment.entryPoint);
  const factory = await viem.getContractAt("SmartAccountFactory", deployment.factory);
  const paymaster = await viem.getContractAt("VerifyingPaymaster", deployment.paymaster);
  const counter = await viem.getContractAt("TestCounter", deployment.counter);

  const sender = await factory.read.getAddress([owner.address, salt]);
  const account = await viem.getContractAt("SmartAccount", sender);
  const isDeployed = (await publicClient.getCode({ address: sender })) !== undefined;

  // A non-zero FEE_EXCHANGE_RATE switches from free sponsorship to ERC-20 settlement.
  const exchangeRate = BigInt(process.env.FEE_EXCHANGE_RATE ?? "0");
  const feeToken = exchangeRate === 0n ? undefined : feeTokenAddress(deployment.feeToken);

  const poolFee = Number(process.env.FEE_POOL_FEE ?? "0");
  const sponsorship: Sponsorship = {
    validUntil: Math.floor(Date.now() / 1000) + SPONSORSHIP_VALIDITY,
    validAfter: 0,
    token: feeToken ?? zeroAddress,
    exchangeRate,
    poolFee,
  };

  // Swapping the collected fee does not fit in the default postOp budget.
  const gasLimits = poolFee === 0 ? undefined : SWAP_GAS_LIMITS;

  console.log(`Smart account: ${sender} (${isDeployed ? "deployed" : "counterfactual"})`);
  console.log(`Mode: ${feeToken ? `ERC-20 ${feeToken} @ ${sponsorship.exchangeRate}` : "free"}`);
  console.log(`Paymaster deposit: ${formatEther(await paymaster.read.getDeposit())} ETH`);

  if (feeToken && isDeployed) {
    const allowance = await publicClient.readContract({
      address: feeToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [sender, paymaster.address],
    });

    if (allowance === 0n) {
      const ownerClient = await viem.getWalletClient(owner.address, { account: owner });
      const approval = await approveFromAccount(
        ownerClient,
        account,
        feeToken,
        paymaster.address,
        maxUint256,
      );
      await publicClient.waitForTransactionReceipt({ hash: approval });
      console.log(`Approved the paymaster to pull ${feeToken}`);
    }
  }

  const userOp = await createSponsoredUserOp({
    publicClient,
    entryPoint,
    paymaster: paymaster.address,
    paymasterSigner,
    owner,
    sender,
    chainId,
    sponsorship,
    gasLimits,
    initCode: isDeployed
      ? undefined
      : encodeInitCode(factory.address, factory.abi, owner.address, salt),
    callData: encodeExecute(
      account.abi,
      counter.address,
      0n,
      encodeFunctionData({ abi: counter.abi, functionName: "count" }),
    ),
  });

  console.log(`UserOperation hash: ${await entryPoint.read.getUserOpHash([userOp])}`);

  const feeBalance = (owner: Address) =>
    feeToken
      ? publicClient.readContract({
          address: feeToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        })
      : Promise.resolve(0n);

  const counterBefore = await counter.read.counters([sender]);
  const depositBefore = await paymaster.read.getDeposit();
  const feeBefore = await feeBalance(sender);

  const hash = await entryPoint.write.handleOps([[userOp], bundler.account.address]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const paid = depositBefore - (await paymaster.read.getDeposit());

  console.log(`Included: ${receipt.transactionHash} (gas used: ${receipt.gasUsed})`);
  console.log(`Counter: ${counterBefore} -> ${await counter.read.counters([sender])}`);
  console.log(`Paymaster paid: ${formatEther(paid)} ETH`);

  if (feeToken) {
    console.log(`Fee charged: ${feeBefore - (await feeBalance(sender))} token units`);
  }

  console.log(
    `Account balance: ${formatEther(await publicClient.getBalance({ address: sender }))} ETH`,
  );
};

sendSponsoredUserOp().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
