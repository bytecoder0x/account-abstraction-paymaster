import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, maxUint256, parseUnits, zeroAddress } from "viem";
import { network } from "hardhat";

import { POOL_FEE, SLIPPAGE_BPS, deployFixture, type Fixture } from "../../lib/fixture.js";

const connection = await network.getOrCreate();
const { viem, networkHelpers } = connection;
const fixture = () => deployFixture(connection);

const FEE_AMOUNT = parseUnits("10", 6);
const POOL = "0x000000000000000000000000000000000000dEaD";

async function standaloneSwapper(fx: Fixture) {
  const operator = fx.deployer.account.address;
  const swapper = await viem.deployContract("FeeSwapper", [
    operator,
    fx.canonical.address,
    fx.uniswapFactory.address,
    fx.router.address,
    fx.quoter.address,
    operator,
    SLIPPAGE_BPS,
  ]);

  await fx.token.write.mint([operator, FEE_AMOUNT]);
  await fx.token.write.approve([swapper.address, maxUint256]);

  return swapper;
}

async function registerPool(fx: Fixture, fee = POOL_FEE) {
  const hash = await fx.uniswapFactory.write.setPool([
    fx.token.address,
    fx.canonical.address,
    fee,
    POOL,
  ]);
  await fx.publicClient.waitForTransactionReceipt({ hash });
}

describe("FeeSwapper", () => {
  describe("configuration", () => {
    it("exposes the wiring it was constructed with", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      assert.equal(getAddress(await fx.swapper.read.PAYMASTER()), getAddress(fx.paymaster.address));
      assert.equal(
        getAddress(await fx.swapper.read.canonicalToken()),
        getAddress(fx.canonical.address),
      );
      assert.equal(await fx.swapper.read.slippageBps(), SLIPPAGE_BPS);
    });

    it("rejects a zero dependency or impossible slippage at construction", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const wiring = [
        fx.canonical.address,
        fx.uniswapFactory.address,
        fx.router.address,
        fx.quoter.address,
        fx.deployer.account.address,
      ] as const;

      await assert.rejects(
        viem.deployContract("FeeSwapper", [zeroAddress, ...wiring, SLIPPAGE_BPS]),
      );
      await assert.rejects(
        viem.deployContract("FeeSwapper", [fx.paymaster.address, ...wiring, 10_000n]),
      );
    });

    it("lets the owner change the slippage but rejects 100% or more", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      const hash = await fx.swapper.write.setSlippage([250n]);
      await fx.publicClient.waitForTransactionReceipt({ hash });
      assert.equal(await fx.swapper.read.slippageBps(), 250n);

      await viem.assertions.revertWithCustomErrorWithArgs(
        fx.swapper.write.setSlippage([10_000n]),
        fx.swapper,
        "InvalidSlippage",
        [10_000n],
      );
    });

    it("rejects a slippage change from anyone but the owner", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        fx.stranger.writeContract({
          address: fx.swapper.address,
          abi: fx.swapper.abi,
          functionName: "setSlippage",
          args: [1n],
        }),
        fx.swapper,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("isSwapAvailable", () => {
    it("follows the pool registered in the factory", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      assert.equal(await fx.swapper.read.isSwapAvailable([fx.token.address, POOL_FEE]), false);

      await registerPool(fx);

      assert.equal(await fx.swapper.read.isSwapAvailable([fx.token.address, POOL_FEE]), true);
      assert.equal(await fx.swapper.read.isSwapAvailable([fx.token.address, 3000]), false);
    });
  });

  describe("swapCollectedFee", () => {
    it("rejects a caller other than the paymaster", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomErrorWithArgs(
        fx.stranger.writeContract({
          address: fx.swapper.address,
          abi: fx.swapper.abi,
          functionName: "swapCollectedFee",
          args: [fx.token.address, FEE_AMOUNT, POOL_FEE],
        }),
        fx.swapper,
        "NotPaymaster",
        [getAddress(fx.stranger.account.address)],
      );
    });

    it("swaps the fee into the canonical token, minus slippage", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      // Mock rate is 1:1, so the router pays out the full amount while the quote was reduced
      // by the slippage tolerance — the swap clears its own minimum.
      assert.equal(await fx.canonical.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), 0n);
      await viem.assertions.emit(hash, swapper, "SwapSucceeded");
    });

    it("skips the swap when no pool exists", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });

    it("skips the swap when the fee is already the canonical token", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);

      const hash = await swapper.write.swapCollectedFee([
        fx.canonical.address,
        FEE_AMOUNT,
        POOL_FEE,
      ]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });

    it("skips the swap when the quoter reverts", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);
      await fx.quoter.write.setShouldRevert([true]);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });

    it("skips the swap when the quoter prices the fee at zero", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);
      await fx.quoter.write.setRate([0n]);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });

    it("returns the fee when the router reverts", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);
      await fx.router.write.setShouldRevert([true]);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      assert.equal(await fx.canonical.read.balanceOf([fx.deployer.account.address]), 0n);
      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });

    it("returns the fee when the router cannot meet the quoted minimum", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const swapper = await standaloneSwapper(fx);
      await registerPool(fx);

      // Router pays half of what the quoter promised, so amountOutMinimum is not met.
      await fx.router.write.setRate([parseUnits("0.5", 18)]);

      const hash = await swapper.write.swapCollectedFee([fx.token.address, FEE_AMOUNT, POOL_FEE]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.token.read.balanceOf([fx.deployer.account.address]), FEE_AMOUNT);
      await viem.assertions.emit(hash, swapper, "SwapFailed");
    });
  });
});
