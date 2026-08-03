// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

/**
 * @title ISmartAccount
 * @notice External surface of the ERC-4337 smart account.
 * @dev `execute` and `executeBatch` are inherited from `BaseAccount`; they are restated here so
 *      the account's full ABI is described in one place.
 */
interface ISmartAccount {
  /**
   * @notice A single call performed by the account.
   * @param target The address being called.
   * @param value The amount of native currency forwarded with the call.
   * @param data The calldata of the call.
   */
  struct Call {
    address target;
    uint256 value;
    bytes data;
  }

  /**
   * @notice Emitted once when the account is initialized behind its proxy.
   * @param entryPoint The EntryPoint the account is bound to.
   * @param owner The address allowed to sign UserOperations for this account.
   */
  event SmartAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner);

  /**
   * @notice Sets the account owner. Callable exactly once, by the factory, behind the proxy.
   * @param owner The address allowed to sign UserOperations for this account.
   */
  function initialize(address owner) external;

  /**
   * @notice Executes a single call from the account.
   * @param target The address being called.
   * @param value The amount of native currency forwarded with the call.
   * @param data The calldata of the call.
   */
  function execute(address target, uint256 value, bytes calldata data) external;

  /**
   * @notice Executes a batch of calls from the account, reverting on the first failure.
   * @param calls The calls to perform, in order.
   */
  function executeBatch(Call[] calldata calls) external;

  /**
   * @notice The address allowed to sign UserOperations for this account.
   * @return The account owner.
   */
  function owner() external view returns (address);

  /**
   * @notice The EntryPoint this account is bound to.
   * @return The EntryPoint contract.
   */
  function entryPoint() external view returns (IEntryPoint);
}
