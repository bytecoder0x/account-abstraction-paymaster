import { formatEther, parseEther } from "viem";
import { network } from "hardhat";

import { loadDeployment } from "../lib/deployments.js";

const DEFAULT_DEPOSIT_ETH = "0.05";

const depositPaymaster = async () => {
  const { viem } = await network.getOrCreate();

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deployment = await loadDeployment(chainId);

  const amount = parseEther(process.env.PAYMASTER_DEPOSIT_ETH ?? DEFAULT_DEPOSIT_ETH);
  const paymaster = await viem.getContractAt("VerifyingPaymaster", deployment.paymaster);

  console.log(`Paymaster: ${paymaster.address}`);
  console.log(`Deposit before: ${formatEther(await paymaster.read.getDeposit())} ETH`);

  const hash = await paymaster.write.deposit({ value: amount });
  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`Deposited ${formatEther(amount)} ETH: ${hash}`);
  console.log(`Deposit after: ${formatEther(await paymaster.read.getDeposit())} ETH`);
};

depositPaymaster().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
