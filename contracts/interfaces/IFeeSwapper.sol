// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IFeeSwapper
 * @notice Converts fee tokens collected by the paymaster into its canonical token.
 */
interface IFeeSwapper {
  /**
   * @notice Emitted when a fee token was swapped for the canonical token.
   * @param tokenIn The fee token that was sold.
   * @param amountIn The amount of `tokenIn` sold.
   * @param amountOut The amount of canonical token received by the paymaster.
   */
  event SwapSucceeded(address indexed tokenIn, uint256 amountIn, uint256 amountOut);

  /**
   * @notice Emitted when a swap was skipped or failed, leaving the fee token with the paymaster.
   * @param tokenIn The fee token that was not sold.
   * @param amountIn The amount that was not sold.
   * @param reason The encoded revert reason, or the encoded selector of the check that failed.
   */
  event SwapFailed(address indexed tokenIn, uint256 amountIn, bytes reason);

  /**
   * @notice Emitted when the maximum tolerated slippage is updated.
   * @param slippageBps The new slippage, in basis points.
   */
  event SlippageUpdated(uint256 slippageBps);

  /**
   * @notice Swaps a fee token held by the paymaster for the canonical token.
   * @dev Best effort: never reverts, so it cannot fail the UserOperation that triggered it.
   *      On success the canonical token is sent to the paymaster; otherwise the fee token
   *      stays with (or is returned to) the paymaster.
   * @param tokenIn The fee token to sell.
   * @param amountIn The amount to sell.
   * @param poolFee The Uniswap V3 pool fee tier to route through.
   */
  function swapCollectedFee(address tokenIn, uint256 amountIn, uint24 poolFee) external;

  /**
   * @notice Whether a pool exists for `tokenIn` against the canonical token at `poolFee`.
   * @param tokenIn The fee token to sell.
   * @param poolFee The Uniswap V3 pool fee tier.
   * @return True when the swap can be routed.
   */
  function isSwapAvailable(address tokenIn, uint24 poolFee) external view returns (bool);

  /**
   * @notice The token every fee is converted into.
   * @return The canonical token address.
   */
  function canonicalToken() external view returns (address);
}
