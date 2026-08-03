import { parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkConnection } from "hardhat/types/network";

// Throwaway keys for local runs only.
export const ACCOUNT_OWNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const PAYMASTER_SIGNER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

export const ACCOUNT_SALT = 0n;
export const POOL_FEE = 500;
export const SLIPPAGE_BPS = 100n;

export async function deployFixture(connection: NetworkConnection) {
  const { viem } = connection;

  const publicClient = await viem.getPublicClient();
  const [deployer, beneficiary, stranger] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  const accountOwner = privateKeyToAccount(ACCOUNT_OWNER_KEY);
  const paymasterSigner = privateKeyToAccount(PAYMASTER_SIGNER_KEY);

  const entryPoint = await viem.deployContract("EntryPoint");
  const factory = await viem.deployContract("SmartAccountFactory", [entryPoint.address]);
  const paymaster = await viem.deployContract("VerifyingPaymaster", [
    entryPoint.address,
    deployer.account.address,
    paymasterSigner.address,
  ]);
  const counter = await viem.deployContract("TestCounter");
  const token = await viem.deployContract("MockERC20", ["Fee Token", "FEE", 6]);
  const canonical = await viem.deployContract("MockERC20", ["Canonical USD", "CUSD", 6]);

  const uniswapFactory = await viem.deployContract("MockUniswapV3Factory");
  const quoter = await viem.deployContract("MockQuoterV2");
  const router = await viem.deployContract("MockSwapRouter");
  const swapper = await viem.deployContract("FeeSwapper", [
    paymaster.address,
    canonical.address,
    uniswapFactory.address,
    router.address,
    quoter.address,
    deployer.account.address,
    SLIPPAGE_BPS,
  ]);

  // Wired but left disabled: the swap tests turn it on and register the pool themselves.
  await paymaster.write.setSwapper([swapper.address]);
  await canonical.write.mint([router.address, parseUnits("1000000", 6)]);

  const accountAddress = await factory.read.getAddress([accountOwner.address, ACCOUNT_SALT]);
  await factory.write.createAccount([accountOwner.address, ACCOUNT_SALT]);
  const account = await viem.getContractAt("SmartAccount", accountAddress);

  await paymaster.write.deposit({ value: parseEther("10") });
  await deployer.sendTransaction({ to: accountOwner.address, value: parseEther("1") });
  await token.write.mint([accountAddress, parseUnits("1000", 6)]);

  return {
    publicClient,
    deployer,
    beneficiary,
    stranger,
    chainId,
    accountOwner,
    paymasterSigner,
    entryPoint,
    factory,
    account,
    accountAddress,
    paymaster,
    counter,
    token,
    canonical,
    uniswapFactory,
    quoter,
    router,
    swapper,
  };
}

export type Fixture = Awaited<ReturnType<typeof deployFixture>>;
