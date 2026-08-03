import { formatEther, getAddress, parseEther, parseUnits, type Address } from "viem";
import { network } from "hardhat";

import { ENTRY_POINT_V08 } from "../lib/constants.js";
import { saveDeployment } from "../lib/deployments.js";
import {
  accountOwnerAccount,
  accountSalt,
  isLocalChain,
  paymasterSignerAccount,
} from "../lib/env.js";

const DEFAULT_DEPOSIT_ETH = "0.05";
const FEE_TOKEN_SUPPLY = parseUnits("1000", 6);
const ROUTER_LIQUIDITY = parseUnits("1000000", 6);
const DEMO_POOL_FEE = 500;
const DEMO_POOL = "0x000000000000000000000000000000000000dEaD";
const SLIPPAGE_BPS = 100n;

const deploy = async () => {
  const connection = await network.getOrCreate();
  const { viem } = connection;

  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  const signer = paymasterSignerAccount(chainId);
  const deposit = parseEther(process.env.PAYMASTER_DEPOSIT_ETH ?? DEFAULT_DEPOSIT_ETH);

  console.log(`Network: ${connection.networkName} (chain ${chainId})`);
  console.log(`Deployer: ${deployer.account.address}`);

  const entryPoint = isLocalChain(chainId)
    ? (await viem.deployContract("EntryPoint")).address
    : getAddress(ENTRY_POINT_V08);
  console.log(`EntryPoint: ${entryPoint}`);

  const factory = await viem.deployContract("SmartAccountFactory", [entryPoint]);
  console.log(`SmartAccountFactory: ${factory.address}`);
  console.log(`  implementation: ${await factory.read.ACCOUNT_IMPLEMENTATION()}`);

  const paymaster = await viem.deployContract("VerifyingPaymaster", [
    entryPoint,
    deployer.account.address,
    signer.address,
  ]);
  console.log(`VerifyingPaymaster: ${paymaster.address}`);
  console.log(`  authorized signer: ${signer.address}`);

  const counter = await viem.deployContract("TestCounter");
  console.log(`TestCounter: ${counter.address}`);

  const hash = await paymaster.write.deposit({ value: deposit });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Paymaster deposit: ${formatEther(await paymaster.read.getDeposit())} ETH`);

  let feeToken: Address | undefined;
  let swapper: Address | undefined;

  // Local chains get a mock fee token and a mock Uniswap V3 behind the swapper, so both the
  // ERC-20 settlement and the fee swap can be demonstrated without a live DEX.
  if (isLocalChain(chainId)) {
    const owner = accountOwnerAccount(chainId);
    const account = await factory.read.getAddress([owner.address, accountSalt()]);

    const token = await viem.deployContract("MockERC20", ["Fee Token", "FEE", 6]);
    const canonical = await viem.deployContract("MockERC20", ["Canonical USD", "CUSD", 6]);
    const uniswapFactory = await viem.deployContract("MockUniswapV3Factory");
    const quoter = await viem.deployContract("MockQuoterV2");
    const router = await viem.deployContract("MockSwapRouter");
    const feeSwapper = await viem.deployContract("FeeSwapper", [
      paymaster.address,
      canonical.address,
      uniswapFactory.address,
      router.address,
      quoter.address,
      deployer.account.address,
      SLIPPAGE_BPS,
    ]);

    await token.write.mint([account, FEE_TOKEN_SUPPLY]);
    await canonical.write.mint([router.address, ROUTER_LIQUIDITY]);
    await uniswapFactory.write.setPool([
      token.address,
      canonical.address,
      DEMO_POOL_FEE,
      DEMO_POOL,
    ]);
    await paymaster.write.setSwapper([feeSwapper.address]);
    await paymaster.write.setSwapEnabled([true]);

    feeToken = getAddress(token.address);
    swapper = getAddress(feeSwapper.address);

    console.log(`MockERC20 fee token: ${feeToken} (minted to ${account})`);
    console.log(
      `FeeSwapper: ${swapper} -> canonical ${canonical.address}, pool fee ${DEMO_POOL_FEE}`,
    );
  }

  const path = await saveDeployment({
    chainId,
    entryPoint: getAddress(entryPoint),
    factory: getAddress(factory.address),
    paymaster: getAddress(paymaster.address),
    counter: getAddress(counter.address),
    feeToken,
    swapper,
  });
  console.log(`Saved ${path}`);
};

deploy().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
