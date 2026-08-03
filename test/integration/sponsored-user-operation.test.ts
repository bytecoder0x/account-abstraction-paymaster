import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { network } from "hardhat";

import { approveFromAccount } from "../../lib/account.js";
import { POOL_FEE, deployFixture, type Fixture } from "../../lib/fixture.js";
import {
  FREE_SPONSORSHIP,
  createSponsoredUserOp,
  encodeExecute,
  encodeExecuteBatch,
  encodeInitCode,
  type GasLimits,
  type Sponsorship,
  type UserOp,
} from "../../lib/user-op.js";

// Swapping inside postOp costs far more than a plain fee transfer.
const SWAP_GAS_LIMITS = { paymasterPostOpGasLimit: 500_000n };

const connection = await network.getOrCreate();
const { viem, networkHelpers } = connection;
const fixture = () => deployFixture(connection);

const countData = (fx: Fixture) =>
  encodeFunctionData({ abi: fx.counter.abi, functionName: "count" });

const countCallData = (fx: Fixture) =>
  encodeExecute(fx.account.abi, fx.counter.address, 0n, countData(fx));

function sponsoredUserOp(
  fx: Fixture,
  overrides: {
    owner?: typeof fx.accountOwner;
    sponsorship?: Sponsorship;
    gasLimits?: Partial<GasLimits>;
  } = {},
) {
  return createSponsoredUserOp({
    publicClient: fx.publicClient,
    entryPoint: fx.entryPoint,
    paymaster: fx.paymaster.address,
    paymasterSigner: fx.paymasterSigner,
    owner: overrides.owner ?? fx.accountOwner,
    sender: fx.account.address,
    callData: countCallData(fx),
    chainId: fx.chainId,
    sponsorship: overrides.sponsorship,
    gasLimits: overrides.gasLimits,
  });
}

async function handleOps(fx: Fixture, userOp: UserOp) {
  const hash = await fx.entryPoint.write.handleOps([[userOp], fx.beneficiary.account.address]);
  await fx.publicClient.waitForTransactionReceipt({ hash });

  return hash;
}

function expectFailedOp(fx: Fixture, userOp: UserOp, reason: string) {
  return viem.assertions.revertWithCustomErrorWithArgs(
    fx.entryPoint.write.handleOps([[userOp], fx.beneficiary.account.address]),
    fx.entryPoint,
    "FailedOp",
    [0n, reason],
  );
}

describe("sponsored UserOperation", () => {
  it("executes a call and charges the paymaster, not the account", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    const depositBefore = await fx.paymaster.read.getDeposit();

    await handleOps(fx, await sponsoredUserOp(fx));

    assert.equal(await fx.counter.read.counters([fx.account.address]), 1n);
    assert.equal(await fx.publicClient.getBalance({ address: fx.account.address }), 0n);
    assert.equal(await fx.entryPoint.read.balanceOf([fx.account.address]), 0n);
    assert.ok((await fx.paymaster.read.getDeposit()) < depositBefore);
  });

  it("executes a batch in a single operation", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    const call = { target: fx.counter.address, value: 0n, data: countData(fx) };

    const userOp = await createSponsoredUserOp({
      publicClient: fx.publicClient,
      entryPoint: fx.entryPoint,
      paymaster: fx.paymaster.address,
      paymasterSigner: fx.paymasterSigner,
      owner: fx.accountOwner,
      sender: fx.account.address,
      callData: encodeExecuteBatch(fx.account.abi, [call, call]),
      chainId: fx.chainId,
    });
    await handleOps(fx, userOp);

    assert.equal(await fx.counter.read.counters([fx.account.address]), 2n);
  });

  it("deploys the account from initCode and executes in the same operation", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    const owner = privateKeyToAccount(generatePrivateKey());
    const salt = 7n;
    const sender = await fx.factory.read.getAddress([owner.address, salt]);

    assert.equal(await fx.publicClient.getCode({ address: sender }), undefined);

    const userOp = await createSponsoredUserOp({
      publicClient: fx.publicClient,
      entryPoint: fx.entryPoint,
      paymaster: fx.paymaster.address,
      paymasterSigner: fx.paymasterSigner,
      owner,
      sender,
      callData: countCallData(fx),
      chainId: fx.chainId,
      initCode: encodeInitCode(fx.factory.address, fx.factory.abi, owner.address, salt),
    });
    await handleOps(fx, userOp);

    const deployed = await viem.getContractAt("SmartAccount", sender);
    assert.equal(getAddress(await deployed.read.owner()), getAddress(owner.address));
    assert.equal(await fx.counter.read.counters([sender]), 1n);
  });

  it("charges the account in ERC-20 when the sponsorship is token-backed", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    await approveFeeToken(fx);

    const sponsorship: Sponsorship = {
      ...FREE_SPONSORSHIP,
      token: fx.token.address,
      exchangeRate: parseUnits("3000", 6),
    };
    const balanceBefore = await fx.token.read.balanceOf([fx.account.address]);

    const hash = await handleOps(fx, await sponsoredUserOp(fx, { sponsorship }));
    const balanceAfter = await fx.token.read.balanceOf([fx.account.address]);

    assert.equal(await fx.counter.read.counters([fx.account.address]), 1n);
    assert.ok(balanceAfter < balanceBefore);
    assert.equal(
      await fx.token.read.balanceOf([fx.paymaster.address]),
      balanceBefore - balanceAfter,
    );
    await viem.assertions.emit(hash, fx.paymaster, "UserOperationSponsored");
  });

  it("swaps the collected fee into the canonical token when a swapper is enabled", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    await approveFeeToken(fx);
    await enableSwapper(fx);

    const sponsorship: Sponsorship = {
      ...FREE_SPONSORSHIP,
      token: fx.token.address,
      exchangeRate: parseUnits("3000", 6),
      poolFee: POOL_FEE,
    };

    const hash = await handleOps(
      fx,
      await sponsoredUserOp(fx, { sponsorship, gasLimits: SWAP_GAS_LIMITS }),
    );

    // The mock router prices 1:1, so the paymaster ends up holding canonical tokens instead
    // of the fee token it charged.
    assert.equal(await fx.counter.read.counters([fx.account.address]), 1n);
    assert.equal(await fx.token.read.balanceOf([fx.paymaster.address]), 0n);
    assert.ok((await fx.canonical.read.balanceOf([fx.paymaster.address])) > 0n);
    await viem.assertions.emit(hash, fx.swapper, "SwapSucceeded");
  });

  it("keeps the fee token when the swap has no pool to route through", async () => {
    const fx = await networkHelpers.loadFixture(fixture);
    await approveFeeToken(fx);

    const enable = await fx.paymaster.write.setSwapEnabled([true]);
    await fx.publicClient.waitForTransactionReceipt({ hash: enable });

    const sponsorship: Sponsorship = {
      ...FREE_SPONSORSHIP,
      token: fx.token.address,
      exchangeRate: parseUnits("3000", 6),
      poolFee: POOL_FEE,
    };

    await handleOps(fx, await sponsoredUserOp(fx, { sponsorship, gasLimits: SWAP_GAS_LIMITS }));

    assert.equal(await fx.counter.read.counters([fx.account.address]), 1n);
    assert.ok((await fx.token.read.balanceOf([fx.paymaster.address])) > 0n);
    assert.equal(await fx.canonical.read.balanceOf([fx.paymaster.address]), 0n);
  });

  describe("rejected operations", () => {
    it("reports AA24 when the account signature is not the owner's", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const owner = privateKeyToAccount(generatePrivateKey());

      await expectFailedOp(fx, await sponsoredUserOp(fx, { owner }), "AA24 signature error");
    });

    it("reports AA34 when the sponsorship signature is not the authorized signer's", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = await createSponsoredUserOp({
        publicClient: fx.publicClient,
        entryPoint: fx.entryPoint,
        paymaster: fx.paymaster.address,
        paymasterSigner: privateKeyToAccount(generatePrivateKey()),
        owner: fx.accountOwner,
        sender: fx.account.address,
        callData: countCallData(fx),
        chainId: fx.chainId,
      });

      await expectFailedOp(fx, userOp, "AA34 signature error");
    });

    it("reports AA34 for a signer that has been rotated out", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = await sponsoredUserOp(fx);

      const hash = await fx.paymaster.write.setSigner([
        privateKeyToAccount(generatePrivateKey()).address,
      ]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      await expectFailedOp(fx, userOp, "AA34 signature error");
    });

    it("reports AA32 when the sponsorship window has not opened yet", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const now = await networkHelpers.time.latest();
      const sponsorship = { ...FREE_SPONSORSHIP, validUntil: now + 7200, validAfter: now + 3600 };

      await expectFailedOp(
        fx,
        await sponsoredUserOp(fx, { sponsorship }),
        "AA32 paymaster expired or not due",
      );
    });

    it("reports AA32 when the sponsorship window has already closed", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const now = await networkHelpers.time.latest();
      const userOp = await sponsoredUserOp(fx, {
        sponsorship: { ...FREE_SPONSORSHIP, validUntil: now + 60 },
      });

      await networkHelpers.time.increase(120);

      await expectFailedOp(fx, userOp, "AA32 paymaster expired or not due");
    });

    it("reports AA31 when the paymaster's deposit cannot cover the operation", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      const hash = await fx.paymaster.write.withdrawTo([
        fx.deployer.account.address,
        await fx.paymaster.read.getDeposit(),
      ]);
      await fx.publicClient.waitForTransactionReceipt({ hash });

      await expectFailedOp(fx, await sponsoredUserOp(fx), "AA31 paymaster deposit too low");
    });

    it("rejects a replay of an already executed operation", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = await sponsoredUserOp(fx);

      await handleOps(fx, userOp);

      await expectFailedOp(fx, userOp, "AA25 invalid account nonce");
    });
  });
});

async function enableSwapper(fx: Fixture) {
  await fx.uniswapFactory.write.setPool([
    fx.token.address,
    fx.canonical.address,
    POOL_FEE,
    "0x000000000000000000000000000000000000dEaD",
  ]);

  const hash = await fx.paymaster.write.setSwapEnabled([true]);
  await fx.publicClient.waitForTransactionReceipt({ hash });
}

async function approveFeeToken(fx: Fixture) {
  const owner = await viem.getWalletClient(fx.accountOwner.address, { account: fx.accountOwner });
  const hash = await approveFromAccount(
    owner,
    fx.account,
    fx.token.address,
    fx.paymaster.address,
    parseUnits("1000", 6),
  );

  await fx.publicClient.waitForTransactionReceipt({ hash });
}
