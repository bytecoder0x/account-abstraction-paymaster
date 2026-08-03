// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice Reverts when a swap is triggered by an address other than the paymaster.
 * @param caller The address that attempted the call.
 */
error NotPaymaster(address caller);

/**
 * @notice Reverts when the configured slippage exceeds 100%.
 * @param slippageBps The rejected slippage, in basis points.
 */
error InvalidSlippage(uint256 slippageBps);
