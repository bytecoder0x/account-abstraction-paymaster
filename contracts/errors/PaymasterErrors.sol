// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice Reverts when `paymasterAndData` is shorter than the fixed layout the paymaster expects.
 * @param length The actual length supplied in the UserOperation.
 */
error InvalidPaymasterDataLength(uint256 length);

/**
 * @notice Reverts when the postOp context does not match the length written during validation.
 * @param length The actual context length.
 */
error InvalidContextLength(uint256 length);

/**
 * @notice Reverts when the sponsored account cannot cover the token fee it agreed to pay.
 * @param token The ERC-20 token used for the fee.
 * @param account The sponsored account.
 */
error InsufficientTokenAllowance(address token, address account);

/**
 * @notice Reverts when a token-mode sponsorship is signed with a zero exchange rate.
 */
error InvalidExchangeRate();

/**
 * @notice Reverts when the batch withdraw arrays have different lengths.
 * @param tokensLength Length of the `tokens` array.
 * @param amountsLength Length of the `amounts` array.
 */
error ArrayLengthMismatch(uint256 tokensLength, uint256 amountsLength);
