import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress } from "viem";
import { network } from "hardhat";

import { ACCOUNT_SALT, deployFixture } from "../../lib/fixture.js";

const connection = await network.getOrCreate();
const { viem, networkHelpers } = connection;
const fixture = () => deployFixture(connection);

describe("SmartAccountFactory", () => {
  it("deploys the account at the address getAddress predicted", async () => {
    const { factory, accountOwner, accountAddress, account } =
      await networkHelpers.loadFixture(fixture);

    assert.equal(getAddress(account.address), getAddress(accountAddress));
    assert.equal(
      getAddress(await factory.read.getAddress([accountOwner.address, ACCOUNT_SALT])),
      getAddress(accountAddress),
    );
  });

  it("initializes the account with the requested owner and EntryPoint", async () => {
    const { account, accountOwner, entryPoint } = await networkHelpers.loadFixture(fixture);

    assert.equal(getAddress(await account.read.owner()), getAddress(accountOwner.address));
    assert.equal(getAddress(await account.read.entryPoint()), getAddress(entryPoint.address));
  });

  it("returns the existing account instead of reverting on a repeated call", async () => {
    const { factory, accountOwner, accountAddress, publicClient } =
      await networkHelpers.loadFixture(fixture);

    const hash = await factory.write.createAccount([accountOwner.address, ACCOUNT_SALT]);
    await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(
      getAddress(await factory.read.getAddress([accountOwner.address, ACCOUNT_SALT])),
      getAddress(accountAddress),
    );
  });

  it("derives a different address per salt and per owner", async () => {
    const { factory, accountOwner, accountAddress, stranger } =
      await networkHelpers.loadFixture(fixture);

    const otherSalt = await factory.read.getAddress([accountOwner.address, ACCOUNT_SALT + 1n]);
    const otherOwner = await factory.read.getAddress([stranger.account.address, ACCOUNT_SALT]);

    assert.notEqual(getAddress(otherSalt), getAddress(accountAddress));
    assert.notEqual(getAddress(otherOwner), getAddress(accountAddress));
  });

  it("rejects the zero owner", async () => {
    const { factory } = await networkHelpers.loadFixture(fixture);

    await viem.assertions.revertWithCustomError(
      factory.write.createAccount([zeroAddress, ACCOUNT_SALT]),
      factory,
      "InvalidOwner",
    );
  });
});
