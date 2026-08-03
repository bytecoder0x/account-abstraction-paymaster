// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IQuoterV2} from "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";

/**
 * @title MockUniswapV3Factory
 * @notice Records which (token, fee) pairs have a pool, so the swapper can be tested without a
 *         live Uniswap deployment.
 */
contract MockUniswapV3Factory {
  mapping(bytes32 key => address pool) private _pools;

  function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
    _pools[_key(tokenA, tokenB, fee)] = pool;
  }

  function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
    return _pools[_key(tokenA, tokenB, fee)];
  }

  function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
    (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

    return keccak256(abi.encodePacked(token0, token1, fee));
  }
}

/**
 * @title MockQuoterV2
 * @notice Quotes at a fixed rate, and can be made to revert to exercise the swapper's fallback.
 */
contract MockQuoterV2 {
  /// @notice Output per 1e18 of input.
  uint256 public rate = 1e18;
  bool public shouldRevert;

  error QuoterFailed();

  function setRate(uint256 newRate) external {
    rate = newRate;
  }

  function setShouldRevert(bool value) external {
    shouldRevert = value;
  }

  function quoteExactInputSingle(
    IQuoterV2.QuoteExactInputSingleParams memory params
  ) external view returns (uint256 amountOut, uint160, uint32, uint256) {
    if (shouldRevert) revert QuoterFailed();

    return ((params.amountIn * rate) / 1e18, 0, 0, 0);
  }
}

/**
 * @title MockSwapRouter
 * @notice Pulls `amountIn` and pays out at a fixed rate from its own balance. Must be funded
 *         with the output token before use.
 */
contract MockSwapRouter {
  using SafeERC20 for IERC20;

  /// @notice Output per 1e18 of input.
  uint256 public rate = 1e18;
  bool public shouldRevert;

  error RouterFailed();

  function setRate(uint256 newRate) external {
    rate = newRate;
  }

  function setShouldRevert(bool value) external {
    shouldRevert = value;
  }

  function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
    if (shouldRevert) revert RouterFailed();

    amountOut = (params.amountIn * rate) / 1e18;
    if (amountOut < params.amountOutMinimum) revert RouterFailed();

    IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
    IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
  }
}
