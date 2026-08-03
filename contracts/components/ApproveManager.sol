// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ApproveManager
 * @notice Grants an unlimited allowance once instead of approving on every call.
 */
abstract contract ApproveManager {
  using SafeERC20 for IERC20;

  /**
   * @notice Approves `spender` for an unlimited amount when the current allowance is short.
   * @dev `forceApprove` resets the allowance to zero first, so tokens that reject a non-zero
   *      to non-zero approval (such as USDT) are handled.
   * @param token The ERC-20 to approve.
   * @param spender The address allowed to spend.
   * @param amount The amount the current operation needs.
   */
  function _approveMax(address token, address spender, uint256 amount) internal {
    if (IERC20(token).allowance(address(this), spender) < amount) {
      IERC20(token).forceApprove(spender, type(uint256).max);
    }
  }
}
