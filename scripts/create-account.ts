import { network } from "hardhat";

import { loadDeployment } from "../lib/deployments.js";
import { accountOwnerAccount, accountSalt } from "../lib/env.js";

const createAccount = async () => {
  const { viem } = await network.getOrCreate();

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deployment = await loadDeployment(chainId);

  const owner = accountOwnerAccount(chainId);
  const salt = accountSalt();

  const factory = await viem.getContractAt("SmartAccountFactory", deployment.factory);
  const address = await factory.read.getAddress([owner.address, salt]);

  console.log(`Owner: ${owner.address}`);
  console.log(`Salt: ${salt}`);
  console.log(`Counterfactual address: ${address}`);

  if ((await publicClient.getCode({ address })) !== undefined) {
    console.log("Already deployed");
    return;
  }

  const hash = await factory.write.createAccount([owner.address, salt]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Account deployed: ${receipt.transactionHash} (gas used: ${receipt.gasUsed})`);

  const account = await viem.getContractAt("SmartAccount", address);
  console.log(`Owner on chain: ${await account.read.owner()}`);
};

createAccount().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
