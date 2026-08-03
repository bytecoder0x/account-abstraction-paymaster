import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { erc20Abi, parseEther } from "viem";
import { network } from "hardhat";

import { MAINNET, WETH_ABI, WETH_USDC_POOL_FEE } from "../../lib/mainnet.js";

const SLIPPAGE_BPS = 100n;
const SWAP_AMOUNT = parseEther("1");

const skip = process.env.MAINNET_RPC_URL
  ? false
  : "MAINNET_RPC_URL is not set — skipping the mainnet fork tests";

describe("FeeSwapper on a mainnet fork", { skip }, () => {
  it("swaps WETH for USDC through the real router", async () => {
    const { viem } = await network.create({ network: "mainnetFork", chainType: "l1" });

    const publicClient = await viem.getPublicClient();
    const [operator] = await viem.getWalletClients();

    // The swapper pulls from whatever it was told is the paymaster, so an EOA stands in for it.
    const swapper = await viem.deployContract("FeeSwapper", [
      operator.account.address,
      MAINNET.usdc,
      MAINNET.uniswapV3Factory,
      MAINNET.uniswapV3Router,
      MAINNET.uniswapV3Quoter,
      operator.account.address,
      SLIPPAGE_BPS,
    ]);

    assert.equal(await swapper.read.isSwapAvailable([MAINNET.weth, WETH_USDC_POOL_FEE]), true);
    assert.equal(await swapper.read.isSwapAvailable([MAINNET.weth, 42]), false);

    const wrap = await operator.writeContract({
      address: MAINNET.weth,
      abi: WETH_ABI,
      functionName: "deposit",
      value: SWAP_AMOUNT,
    });
    await publicClient.waitForTransactionReceipt({ hash: wrap });

    const approve = await operator.writeContract({
      address: MAINNET.weth,
      abi: WETH_ABI,
      functionName: "approve",
      args: [swapper.address, SWAP_AMOUNT],
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });

    const hash = await swapper.write.swapCollectedFee([
      MAINNET.weth,
      SWAP_AMOUNT,
      WETH_USDC_POOL_FEE,
    ]);
    await publicClient.waitForTransactionReceipt({ hash });

    const usdc = await publicClient.readContract({
      address: MAINNET.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [operator.account.address],
    });
    const weth = await publicClient.readContract({
      address: MAINNET.weth,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [operator.account.address],
    });

    assert.equal(weth, 0n, "the whole fee should have been sold");
    assert.ok(usdc > 0n, "the swap should have produced USDC");
    await viem.assertions.emit(hash, swapper, "SwapSucceeded");
  });

  it("leaves the fee untouched when the pool does not exist", async () => {
    const { viem } = await network.create({ network: "mainnetFork", chainType: "l1" });

    const publicClient = await viem.getPublicClient();
    const [operator] = await viem.getWalletClients();

    const swapper = await viem.deployContract("FeeSwapper", [
      operator.account.address,
      MAINNET.usdc,
      MAINNET.uniswapV3Factory,
      MAINNET.uniswapV3Router,
      MAINNET.uniswapV3Quoter,
      operator.account.address,
      SLIPPAGE_BPS,
    ]);

    const wrap = await operator.writeContract({
      address: MAINNET.weth,
      abi: WETH_ABI,
      functionName: "deposit",
      value: SWAP_AMOUNT,
    });
    await publicClient.waitForTransactionReceipt({ hash: wrap });

    // 42 is not a real Uniswap V3 fee tier, so no pool can exist.
    const hash = await swapper.write.swapCollectedFee([MAINNET.weth, SWAP_AMOUNT, 42]);
    await publicClient.waitForTransactionReceipt({ hash });

    const weth = await publicClient.readContract({
      address: MAINNET.weth,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [operator.account.address],
    });

    assert.equal(weth, SWAP_AMOUNT);
    await viem.assertions.emit(hash, swapper, "SwapFailed");
  });
});
