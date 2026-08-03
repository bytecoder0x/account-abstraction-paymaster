// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice Reverts when a required address argument is the zero address.
 */
error ZeroAddress();

/**
 * @notice Reverts when execution is triggered by an address that is neither the EntryPoint
 *         nor the account owner.
 * @param caller The address that attempted the call.
 */
error NotEntryPointOrOwner(address caller);

/**
 * @notice Reverts when a call is not made by the account's EntryPoint.
 * @param caller The address that attempted the call.
 */
error NotEntryPoint(address caller);

/**
 * @notice Reverts when the factory is asked to deploy an account for the zero owner.
 */
error InvalidOwner();
