import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  maxUint256,
  parseEther,
  parseUnits,
  zeroAddress,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { network } from "hardhat";

import { approveFromAccount } from "../../lib/account.js";
import { deployFixture, type Fixture } from "../../lib/fixture.js";
import {
  FREE_SPONSORSHIP,
  SPONSORSHIP_TYPES,
  buildUserOp,
  createSponsoredUserOp,
  encodeExecute,
  encodePaymasterAndData,
  signSponsorship,
  type Sponsorship,
  type UserOp,
} from "../../lib/user-op.js";

const connection = await network.getOrCreate();
const { viem, networkHelpers } = connection;
const fixture = () => deployFixture(connection);

const ZERO_HASH = `0x${"00".repeat(32)}` as const;
const MAX_COST = parseEther("0.01");

function parseValidationData(validationData: bigint) {
  return {
    sigFailed: (validationData & ((1n << 160n) - 1n)) === 1n,
    validUntil: Number((validationData >> 160n) & 0xffffffffffffn),
    validAfter: Number((validationData >> 208n) & 0xffffffffffffn),
  };
}

const countCallData = (fx: Fixture) =>
  encodeExecute(
    fx.account.abi,
    fx.counter.address,
    0n,
    encodeFunctionData({ abi: fx.counter.abi, functionName: "count" }),
  );

const sponsoredUserOp = (fx: Fixture, sponsorship?: Sponsorship) =>
  createSponsoredUserOp({
    publicClient: fx.publicClient,
    entryPoint: fx.entryPoint,
    paymaster: fx.paymaster.address,
    paymasterSigner: fx.paymasterSigner,
    owner: fx.accountOwner,
    sender: fx.account.address,
    callData: countCallData(fx),
    chainId: fx.chainId,
    sponsorship,
  });

const validate = (fx: Fixture, userOp: UserOp) =>
  fx.publicClient.simulateContract({
    address: fx.paymaster.address,
    abi: fx.paymaster.abi,
    functionName: "validatePaymasterUserOp",
    args: [userOp, ZERO_HASH, MAX_COST],
    account: fx.entryPoint.address,
  });

describe("VerifyingPaymaster", () => {
  describe("configuration", () => {
    it("stores the owner, EntryPoint and signer given at construction", async () => {
      const { paymaster, deployer, paymasterSigner, entryPoint } =
        await networkHelpers.loadFixture(fixture);

      assert.equal(getAddress(await paymaster.read.owner()), getAddress(deployer.account.address));
      assert.equal(getAddress(await paymaster.read.signer()), getAddress(paymasterSigner.address));
      assert.equal(getAddress(await paymaster.read.entryPoint()), getAddress(entryPoint.address));
    });

    it("rejects a zero owner or signer", async () => {
      const { entryPoint, deployer } = await networkHelpers.loadFixture(fixture);

      await assert.rejects(
        viem.deployContract("VerifyingPaymaster", [
          entryPoint.address,
          zeroAddress,
          deployer.account.address,
        ]),
      );
      await assert.rejects(
        viem.deployContract("VerifyingPaymaster", [
          entryPoint.address,
          deployer.account.address,
          zeroAddress,
        ]),
      );
    });

    it("lets the owner rotate the signer", async () => {
      const { paymaster, publicClient } = await networkHelpers.loadFixture(fixture);
      const newSigner = privateKeyToAccount(generatePrivateKey());

      const hash = await paymaster.write.setSigner([newSigner.address]);
      await publicClient.waitForTransactionReceipt({ hash });

      assert.equal(getAddress(await paymaster.read.signer()), getAddress(newSigner.address));
      await viem.assertions.emit(hash, paymaster, "SignerUpdated");
    });

    it("rejects a signer rotation from anyone but the owner", async () => {
      const { paymaster, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: paymaster.address,
          abi: paymaster.abi,
          functionName: "setSigner",
          args: [stranger.account.address],
        }),
        paymaster,
        "OwnableUnauthorizedAccount",
      );
    });

    it("rejects the zero address as signer", async () => {
      const { paymaster } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        paymaster.write.setSigner([zeroAddress]),
        paymaster,
        "ZeroAddress",
      );
    });
  });

  describe("EntryPoint deposit and stake", () => {
    it("tracks the deposit made at setup", async () => {
      const { paymaster } = await networkHelpers.loadFixture(fixture);

      assert.equal(await paymaster.read.getDeposit(), parseEther("10"));
    });

    it("lets the owner withdraw the deposit", async () => {
      const { paymaster, stranger, publicClient } = await networkHelpers.loadFixture(fixture);
      const before = await publicClient.getBalance({ address: stranger.account.address });

      const hash = await paymaster.write.withdrawTo([stranger.account.address, parseEther("4")]);
      await publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await paymaster.read.getDeposit(), parseEther("6"));
      assert.equal(
        await publicClient.getBalance({ address: stranger.account.address }),
        before + parseEther("4"),
      );
    });

    it("rejects a withdrawal from anyone but the owner", async () => {
      const { paymaster, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: paymaster.address,
          abi: paymaster.abi,
          functionName: "withdrawTo",
          args: [stranger.account.address, parseEther("1")],
        }),
        paymaster,
        "OwnableUnauthorizedAccount",
      );
    });

    it("lets the owner stake in the EntryPoint", async () => {
      const { paymaster, entryPoint, publicClient } = await networkHelpers.loadFixture(fixture);

      const hash = await paymaster.write.addStake([86_400], { value: parseEther("1") });
      await publicClient.waitForTransactionReceipt({ hash });

      const info = await entryPoint.read.getDepositInfo([paymaster.address]);
      assert.equal(info.stake, parseEther("1"));
      assert.equal(info.staked, true);
    });
  });

  describe("paymasterAndData", () => {
    it("round-trips the encoded fields", async () => {
      const { paymaster, token } = await networkHelpers.loadFixture(fixture);
      const sponsorship: Sponsorship = {
        validUntil: 1_800_000_000,
        validAfter: 1_700_000_000,
        token: token.address,
        exchangeRate: 12345n,
        poolFee: 3000,
      };
      const signature = `0x${"11".repeat(65)}` as Hex;

      const [validUntil, validAfter, decodedToken, exchangeRate, poolFee, decodedSignature] =
        await paymaster.read.parsePaymasterAndData([
          encodePaymasterAndData({ paymaster: paymaster.address, sponsorship, signature }),
        ]);

      assert.equal(validUntil, sponsorship.validUntil);
      assert.equal(validAfter, sponsorship.validAfter);
      assert.equal(getAddress(decodedToken), getAddress(token.address));
      assert.equal(exchangeRate, sponsorship.exchangeRate);
      assert.equal(poolFee, sponsorship.poolFee);
      assert.equal(decodedSignature, signature);
    });

    it("rejects data of the wrong length", async () => {
      const { paymaster } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomErrorWithArgs(
        paymaster.read.parsePaymasterAndData([`0x${"00".repeat(52)}`]),
        paymaster,
        "InvalidPaymasterDataLength",
        [52n],
      );
    });

    it("computes the same EIP-712 digest on chain and off chain", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = buildUserOp({
        sender: fx.account.address,
        nonce: await fx.entryPoint.read.getNonce([fx.account.address, 0n]),
        callData: countCallData(fx),
      });
      const sponsorship: Sponsorship = { ...FREE_SPONSORSHIP, validUntil: 1_800_000_000 };

      const onChain = await fx.paymaster.read.getHash([
        userOp,
        sponsorship.validUntil,
        sponsorship.validAfter,
        sponsorship.token,
        sponsorship.exchangeRate,
        sponsorship.poolFee,
      ]);

      const offChain = hashTypedData({
        domain: {
          name: "VerifyingPaymaster",
          version: "1",
          chainId: fx.chainId,
          verifyingContract: fx.paymaster.address,
        },
        types: SPONSORSHIP_TYPES,
        primaryType: "SponsorshipRequest",
        message: {
          sender: userOp.sender,
          nonce: userOp.nonce,
          initCode: userOp.initCode,
          callData: userOp.callData,
          accountGasLimits: userOp.accountGasLimits,
          preVerificationGas: userOp.preVerificationGas,
          gasFees: userOp.gasFees,
          ...sponsorship,
        },
      });

      assert.equal(onChain, offChain);
    });
  });

  describe("validatePaymasterUserOp", () => {
    it("accepts an operation signed by the authorized signer", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const sponsorship: Sponsorship = {
        ...FREE_SPONSORSHIP,
        validUntil: 1_900_000_000,
        validAfter: 1_600_000_000,
      };

      const { result } = await validate(fx, await sponsoredUserOp(fx, sponsorship));
      const [context, validationData] = result;

      assert.deepEqual(parseValidationData(validationData), {
        sigFailed: false,
        validUntil: sponsorship.validUntil,
        validAfter: sponsorship.validAfter,
      });
      assert.equal(context, "0x", "a free sponsorship must not schedule postOp");
    });

    it("flags a signature from an unauthorized signer without reverting", async () => {
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

      const { result } = await validate(fx, userOp);
      assert.equal(parseValidationData(result[1]).sigFailed, true);
    });

    it("flags a signature that does not match the operation it is attached to", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = buildUserOp({
        sender: fx.account.address,
        nonce: await fx.entryPoint.read.getNonce([fx.account.address, 0n]),
        callData: countCallData(fx),
      });
      const signature = await signSponsorship({
        signer: fx.paymasterSigner,
        paymaster: fx.paymaster.address,
        chainId: fx.chainId,
        userOp,
        sponsorship: FREE_SPONSORSHIP,
      });

      const { result } = await validate(fx, {
        ...userOp,
        paymasterAndData: encodePaymasterAndData({
          paymaster: fx.paymaster.address,
          sponsorship: { ...FREE_SPONSORSHIP, validUntil: 1_900_000_000 },
          signature,
        }),
      });

      assert.equal(parseValidationData(result[1]).sigFailed, true);
    });

    it("rejects a caller other than the EntryPoint", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomErrorWithArgs(
        fx.stranger.writeContract({
          address: fx.paymaster.address,
          abi: fx.paymaster.abi,
          functionName: "validatePaymasterUserOp",
          args: [await sponsoredUserOp(fx), ZERO_HASH, MAX_COST],
        }),
        fx.paymaster,
        "NotEntryPoint",
        [getAddress(fx.stranger.account.address)],
      );
    });

    it("rejects a token-mode operation the account cannot pay for", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const sponsorship: Sponsorship = {
        ...FREE_SPONSORSHIP,
        token: fx.token.address,
        exchangeRate: parseUnits("3000", 6),
      };

      await viem.assertions.revertWithCustomError(
        validate(fx, await sponsoredUserOp(fx, sponsorship)),
        fx.paymaster,
        "InsufficientTokenAllowance",
      );
    });

    it("returns a postOp context once the account has approved the fee token", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const sponsorship: Sponsorship = {
        ...FREE_SPONSORSHIP,
        token: fx.token.address,
        exchangeRate: parseUnits("3000", 6),
      };

      await approveFeeToken(fx);

      const { result } = await validate(fx, await sponsoredUserOp(fx, sponsorship));

      assert.notEqual(result[0], "0x");
      assert.equal(parseValidationData(result[1]).sigFailed, false);
    });
  });

  describe("postOp", () => {
    it("rejects a caller other than the EntryPoint", async () => {
      const { paymaster, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: paymaster.address,
          abi: paymaster.abi,
          functionName: "postOp",
          args: [0, `0x${"00".repeat(128)}`, 0n, 0n],
        }),
        paymaster,
        "NotEntryPoint",
      );
    });
  });

  describe("withdrawTokens", () => {
    it("lets the owner sweep collected fee tokens", async () => {
      const { paymaster, token, stranger, deployer, publicClient } =
        await networkHelpers.loadFixture(fixture);

      await token.write.mint([paymaster.address, parseUnits("50", 6)]);

      const partial = await paymaster.write.withdrawTokens([
        token.address,
        stranger.account.address,
        parseUnits("20", 6),
      ]);
      await publicClient.waitForTransactionReceipt({ hash: partial });

      const sweep = await paymaster.write.withdrawTokens([
        token.address,
        deployer.account.address,
        maxUint256,
      ]);
      await publicClient.waitForTransactionReceipt({ hash: sweep });

      assert.equal(await token.read.balanceOf([stranger.account.address]), parseUnits("20", 6));
      assert.equal(await token.read.balanceOf([deployer.account.address]), parseUnits("30", 6));
      assert.equal(await token.read.balanceOf([paymaster.address]), 0n);
    });

    it("rejects a sweep from anyone but the owner", async () => {
      const { paymaster, token, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: paymaster.address,
          abi: paymaster.abi,
          functionName: "withdrawTokens",
          args: [token.address, stranger.account.address, 1n],
        }),
        paymaster,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});

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
