// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IQuoterV2} from "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";

import {IFeeSwapper} from "./interfaces/IFeeSwapper.sol";
import {ApproveManager} from "./components/ApproveManager.sol";
import {ValidationModifiers} from "./components/ValidationModifiers.sol";
import {NotPaymaster, InvalidSlippage} from "./errors/SwapperErrors.sol";

/**
 * @title FeeSwapper
 * @notice Converts ERC-20 fees collected by the paymaster into a single canonical token
 *         through Uniswap V3.
 * @dev Called from the paymaster's `postOp`, so every failure path is swallowed: a revert here
 *      would fail an already-executed UserOperation while the paymaster still pays for its gas.
 *      Each skipped or failed swap is reported through `SwapFailed` for off-chain monitoring.
 */
contract FeeSwapper is IFeeSwapper, Ownable, ApproveManager, ValidationModifiers {
  using SafeERC20 for IERC20;

  uint256 private constant MAX_BIPS = 10_000;

  /// @notice The paymaster whose fees this contract may swap.
  address public immutable PAYMASTER;

  /// @notice The token every fee is converted into.
  address public immutable override canonicalToken;

  IUniswapV3Factory public immutable FACTORY;
  ISwapRouter public immutable ROUTER;
  IQuoterV2 public immutable QUOTER;

  /// @notice Maximum tolerated slippage against the quote, in basis points.
  uint256 public slippageBps;

  modifier onlyPaymaster() {
    if (msg.sender != PAYMASTER) revert NotPaymaster(msg.sender);
    _;
  }

  /**
   * @param paymaster The paymaster allowed to trigger swaps.
   * @param canonicalToken_ The token every fee is converted into.
   * @param factory Uniswap V3 factory, used to check that a pool exists.
   * @param router Uniswap V3 swap router.
   * @param quoter Uniswap V3 quoter, used to derive the minimum output.
   * @param owner The address allowed to tune the slippage.
   * @param slippageBps_ Initial slippage tolerance, in basis points.
   */
  constructor(
    address paymaster,
    address canonicalToken_,
    address factory,
    address router,
    address quoter,
    address owner,
    uint256 slippageBps_
  )
    Ownable(owner)
    nonZeroAddress(paymaster)
    nonZeroAddress(canonicalToken_)
    nonZeroAddress(factory)
    nonZeroAddress(router)
    nonZeroAddress(quoter)
  {
    if (slippageBps_ >= MAX_BIPS) revert InvalidSlippage(slippageBps_);

    PAYMASTER = paymaster;
    canonicalToken = canonicalToken_;
    FACTORY = IUniswapV3Factory(factory);
    ROUTER = ISwapRouter(router);
    QUOTER = IQuoterV2(quoter);
    slippageBps = slippageBps_;

    emit SlippageUpdated(slippageBps_);
  }

  /**
   * @notice Updates the tolerated slippage.
   * @param newSlippageBps The new slippage, in basis points, below 100%.
   */
  function setSlippage(uint256 newSlippageBps) external onlyOwner {
    if (newSlippageBps >= MAX_BIPS) revert InvalidSlippage(newSlippageBps);

    slippageBps = newSlippageBps;
    emit SlippageUpdated(newSlippageBps);
  }

  /// @inheritdoc IFeeSwapper
  function swapCollectedFee(address tokenIn, uint256 amountIn, uint24 poolFee) external onlyPaymaster {
    if (amountIn == 0 || tokenIn == canonicalToken || !isSwapAvailable(tokenIn, poolFee)) {
      emit SwapFailed(tokenIn, amountIn, "");
      return;
    }

    uint256 amountOutMin = _quote(tokenIn, amountIn, poolFee);
    if (amountOutMin == 0) return;

    IERC20(tokenIn).safeTransferFrom(PAYMASTER, address(this), amountIn);
    _approveMax(tokenIn, address(ROUTER), amountIn);

    try
      ROUTER.exactInputSingle(
        ISwapRouter.ExactInputSingleParams({
          tokenIn: tokenIn,
          tokenOut: canonicalToken,
          fee: poolFee,
          recipient: PAYMASTER,
          deadline: block.timestamp,
          amountIn: amountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0
        })
      )
    returns (uint256 amountOut) {
      emit SwapSucceeded(tokenIn, amountIn, amountOut);
    } catch (bytes memory reason) {
      IERC20(tokenIn).safeTransfer(PAYMASTER, amountIn);
      emit SwapFailed(tokenIn, amountIn, reason);
    }
  }

  /// @inheritdoc IFeeSwapper
  function isSwapAvailable(address tokenIn, uint24 poolFee) public view returns (bool) {
    return FACTORY.getPool(tokenIn, canonicalToken, poolFee) != address(0);
  }

  /// @dev Returns the quoted output minus slippage, or zero when the quote is unusable.
  function _quote(address tokenIn, uint256 amountIn, uint24 poolFee) private returns (uint256) {
    try
      QUOTER.quoteExactInputSingle(
        IQuoterV2.QuoteExactInputSingleParams({
          tokenIn: tokenIn,
          tokenOut: canonicalToken,
          amountIn: amountIn,
          fee: poolFee,
          sqrtPriceLimitX96: 0
        })
      )
    returns (uint256 amountOut, uint160, uint32, uint256) {
      if (amountOut != 0) return (amountOut * (MAX_BIPS - slippageBps)) / MAX_BIPS;

      emit SwapFailed(tokenIn, amountIn, "");
    } catch (bytes memory reason) {
      emit SwapFailed(tokenIn, amountIn, reason);
    }

    return 0;
  }
}
