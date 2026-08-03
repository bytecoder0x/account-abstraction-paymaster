import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeFunctionData,
  getAddress,
  hashMessage,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { network } from "hardhat";

import { deployFixture, type Fixture } from "../../lib/fixture.js";
import { buildUserOp, encodeExecute } from "../../lib/user-op.js";

const connection = await network.getOrCreate();
const { viem, networkHelpers } = connection;
const fixture = () => deployFixture(connection);

const ERC1271_VALID = "0x1626ba7e";
const ERC1271_INVALID = "0xffffffff";
const SIG_VALIDATION_FAILED = 1n;
const SIG_VALIDATION_SUCCESS = 0n;

const countData = (counter: { abi: Abi }) =>
  encodeFunctionData({ abi: counter.abi, functionName: "count" });

const countCall = (counter: { abi: Abi; address: Address }) => ({
  target: counter.address,
  value: 0n,
  data: countData(counter),
});

const asOwner = ({ accountOwner }: Fixture) =>
  viem.getWalletClient(accountOwner.address, { account: accountOwner });

async function simulateValidateUserOp(fx: Fixture, signature: `0x${string}`) {
  const userOp = buildUserOp({
    sender: fx.account.address,
    nonce: await fx.entryPoint.read.getNonce([fx.account.address, 0n]),
    callData: encodeExecute(fx.account.abi, fx.counter.address, 0n, countData(fx.counter)),
  });
  const userOpHash = await fx.entryPoint.read.getUserOpHash([userOp]);

  const { result } = await fx.publicClient.simulateContract({
    address: fx.account.address,
    abi: fx.account.abi,
    functionName: "validateUserOp",
    args: [{ ...userOp, signature }, userOpHash, 0n],
    account: fx.entryPoint.address,
  });

  return result;
}

describe("SmartAccount", () => {
  describe("execute", () => {
    it("lets the owner call a target directly", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const owner = await asOwner(fx);

      const hash = await owner.writeContract({
        address: fx.account.address,
        abi: fx.account.abi,
        functionName: "execute",
        args: [fx.counter.address, 0n, countData(fx.counter)],
      });
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.counter.read.counters([fx.account.address]), 1n);
    });

    it("forwards native currency with the call", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      await fx.deployer.sendTransaction({ to: fx.account.address, value: parseEther("1") });

      const owner = await asOwner(fx);
      const hash = await owner.writeContract({
        address: fx.account.address,
        abi: fx.account.abi,
        functionName: "execute",
        args: [fx.counter.address, parseEther("0.5"), "0x"],
      });
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(
        await fx.publicClient.getBalance({ address: fx.counter.address }),
        parseEther("0.5"),
      );
    });

    it("rejects a caller that is neither the EntryPoint nor the owner", async () => {
      const { account, counter, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomErrorWithArgs(
        stranger.writeContract({
          address: account.address,
          abi: account.abi,
          functionName: "execute",
          args: [counter.address, 0n, countData(counter)],
        }),
        account,
        "NotEntryPointOrOwner",
        [getAddress(stranger.account.address)],
      );
    });
  });

  describe("executeBatch", () => {
    it("performs every call in order", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const owner = await asOwner(fx);
      const call = countCall(fx.counter);

      const hash = await owner.writeContract({
        address: fx.account.address,
        abi: fx.account.abi,
        functionName: "executeBatch",
        args: [[call, call, call]],
      });
      await fx.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await fx.counter.read.counters([fx.account.address]), 3n);
    });

    it("reverts the whole batch when one call fails", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const owner = await asOwner(fx);
      const failing = {
        target: fx.counter.address,
        value: 0n,
        data: encodeFunctionData({ abi: fx.counter.abi, functionName: "fail" }),
      };

      await viem.assertions.revertWithCustomError(
        owner.writeContract({
          address: fx.account.address,
          abi: fx.account.abi,
          functionName: "executeBatch",
          args: [[countCall(fx.counter), failing]],
        }),
        fx.account,
        "ExecuteError",
      );

      assert.equal(await fx.counter.read.counters([fx.account.address]), 0n);
    });

    it("rejects a caller that is neither the EntryPoint nor the owner", async () => {
      const { account, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: account.address,
          abi: account.abi,
          functionName: "executeBatch",
          args: [[]],
        }),
        account,
        "NotEntryPointOrOwner",
      );
    });
  });

  describe("isValidSignature (ERC-1271)", () => {
    it("accepts a signature produced by the owner", async () => {
      const { account, accountOwner } = await networkHelpers.loadFixture(fixture);
      const signature = await accountOwner.signMessage({ message: "hello" });

      assert.equal(
        await account.read.isValidSignature([hashMessage("hello"), signature]),
        ERC1271_VALID,
      );
    });

    it("rejects a signature from a different key without reverting", async () => {
      const { account } = await networkHelpers.loadFixture(fixture);
      const impostor = privateKeyToAccount(keccak256(toHex("impostor")));
      const signature = await impostor.signMessage({ message: "hello" });

      assert.equal(
        await account.read.isValidSignature([hashMessage("hello"), signature]),
        ERC1271_INVALID,
      );
    });

    it("rejects a malformed signature without reverting", async () => {
      const { account } = await networkHelpers.loadFixture(fixture);

      assert.equal(
        await account.read.isValidSignature([hashMessage("hello"), "0xdeadbeef"]),
        ERC1271_INVALID,
      );
    });
  });

  describe("validateUserOp", () => {
    it("returns SIG_VALIDATION_SUCCESS for the owner's signature", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const userOp = buildUserOp({
        sender: fx.account.address,
        nonce: await fx.entryPoint.read.getNonce([fx.account.address, 0n]),
        callData: encodeExecute(fx.account.abi, fx.counter.address, 0n, countData(fx.counter)),
      });
      const userOpHash = await fx.entryPoint.read.getUserOpHash([userOp]);

      const { result } = await fx.publicClient.simulateContract({
        address: fx.account.address,
        abi: fx.account.abi,
        functionName: "validateUserOp",
        args: [
          { ...userOp, signature: await fx.accountOwner.sign({ hash: userOpHash }) },
          userOpHash,
          0n,
        ],
        account: fx.entryPoint.address,
      });

      assert.equal(result, SIG_VALIDATION_SUCCESS);
    });

    it("returns SIG_VALIDATION_FAILED instead of reverting on a wrong signature", async () => {
      const fx = await networkHelpers.loadFixture(fixture);
      const impostor = privateKeyToAccount(keccak256(toHex("impostor")));
      const signature = await impostor.sign({ hash: keccak256(toHex("anything")) });

      assert.equal(await simulateValidateUserOp(fx, signature), SIG_VALIDATION_FAILED);
    });

    it("returns SIG_VALIDATION_FAILED instead of reverting on a malformed signature", async () => {
      const fx = await networkHelpers.loadFixture(fixture);

      assert.equal(await simulateValidateUserOp(fx, "0xdeadbeef"), SIG_VALIDATION_FAILED);
    });

    it("rejects a caller other than the EntryPoint", async () => {
      const { account, entryPoint, stranger } = await networkHelpers.loadFixture(fixture);
      const userOp = buildUserOp({
        sender: account.address,
        nonce: await entryPoint.read.getNonce([account.address, 0n]),
        callData: "0x",
      });

      await viem.assertions.revert(
        stranger.writeContract({
          address: account.address,
          abi: account.abi,
          functionName: "validateUserOp",
          args: [userOp, keccak256(toHex("hash")), 0n],
        }),
      );
    });
  });

  describe("initialization", () => {
    it("cannot be initialized twice", async () => {
      const { account, stranger } = await networkHelpers.loadFixture(fixture);

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: account.address,
          abi: account.abi,
          functionName: "initialize",
          args: [stranger.account.address],
        }),
        account,
        "InvalidInitialization",
      );
    });

    it("locks the shared implementation against direct initialization", async () => {
      const { factory, stranger } = await networkHelpers.loadFixture(fixture);
      const implementation = await viem.getContractAt(
        "SmartAccount",
        await factory.read.ACCOUNT_IMPLEMENTATION(),
      );

      await viem.assertions.revertWithCustomError(
        stranger.writeContract({
          address: implementation.address,
          abi: implementation.abi,
          functionName: "initialize",
          args: [stranger.account.address],
        }),
        implementation,
        "InvalidInitialization",
      );
    });

    it("rejects the zero EntryPoint at construction", async () => {
      await networkHelpers.loadFixture(fixture);

      await assert.rejects(viem.deployContract("SmartAccountFactory", [zeroAddress]));
    });
  });

  it("accepts native currency", async () => {
    const { account, deployer, publicClient } = await networkHelpers.loadFixture(fixture);

    await deployer.sendTransaction({ to: account.address, value: parseEther("2") });

    assert.equal(await publicClient.getBalance({ address: account.address }), parseEther("2"));
  });

  it("reports the interfaces it implements", async () => {
    const { account } = await networkHelpers.loadFixture(fixture);

    assert.equal(await account.read.supportsInterface([ERC1271_VALID]), true);
    assert.equal(await account.read.supportsInterface(["0x01ffc9a7"]), true);
    assert.equal(await account.read.supportsInterface([ERC1271_INVALID]), false);
  });
});
