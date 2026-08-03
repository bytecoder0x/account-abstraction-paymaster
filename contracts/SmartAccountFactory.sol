// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {SmartAccount} from "./SmartAccount.sol";
import {InvalidOwner} from "./errors/SmartAccountErrors.sol";

/**
 * @title SmartAccountFactory
 * @notice Deploys `SmartAccount` proxies at deterministic CREATE2 addresses.
 * @dev The account address depends only on the factory address, the salt, the shared
 *      implementation and the owner, so the same account address is obtained on every chain
 *      where this factory is deployed at the same address.
 *
 *      A UserOperation's `initCode` is `abi.encodePacked(factory, createAccount(owner, salt))`.
 */
contract SmartAccountFactory {
  /// @notice The shared `SmartAccount` implementation every proxy delegates to.
  SmartAccount public immutable ACCOUNT_IMPLEMENTATION;

  /**
   * @notice Emitted when a new account proxy is deployed.
   * @param account The address of the freshly deployed account.
   * @param owner The account owner.
   * @param salt The salt used for the CREATE2 deployment.
   */
  event SmartAccountCreated(address indexed account, address indexed owner, uint256 salt);

  /**
   * @notice Deploys the shared account implementation bound to the given EntryPoint.
   * @param entryPoint The EntryPoint every account created by this factory is bound to.
   */
  constructor(IEntryPoint entryPoint) {
    ACCOUNT_IMPLEMENTATION = new SmartAccount(entryPoint);
  }

  /**
   * @notice Deploys the account for `(owner, salt)`, or returns it if it already exists.
   * @dev Idempotent by design. The EntryPoint runs `initCode` only when the sender has no
   *      code, but `entryPoint.getSenderAddress()` and off-chain tooling call this
   *      speculatively — reverting on the second call would break both.
   * @param owner The address allowed to sign UserOperations for the account.
   * @param salt An arbitrary value distinguishing several accounts of the same owner.
   * @return account The deployed (or already existing) account.
   */
  function createAccount(address owner, uint256 salt) external returns (SmartAccount account) {
    if (owner == address(0)) revert InvalidOwner();

    address predicted = getAddress(owner, salt);
    if (predicted.code.length > 0) return SmartAccount(payable(predicted));

    account = SmartAccount(
      payable(
        new ERC1967Proxy{salt: bytes32(salt)}(
          address(ACCOUNT_IMPLEMENTATION),
          abi.encodeCall(SmartAccount.initialize, (owner))
        )
      )
    );

    emit SmartAccountCreated(address(account), owner, salt);
  }

  /**
   * @notice Computes the counterfactual address of the account for `(owner, salt)`.
   * @param owner The address allowed to sign UserOperations for the account.
   * @param salt An arbitrary value distinguishing several accounts of the same owner.
   * @return The address the account has (or will have) once deployed.
   */
  function getAddress(address owner, uint256 salt) public view returns (address) {
    return
      Create2.computeAddress(
        bytes32(salt),
        keccak256(
          abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(address(ACCOUNT_IMPLEMENTATION), abi.encodeCall(SmartAccount.initialize, (owner)))
          )
        )
      );
  }
}
