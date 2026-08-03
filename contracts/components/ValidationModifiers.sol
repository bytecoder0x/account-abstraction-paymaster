// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ZeroAddress} from "../errors/SmartAccountErrors.sol";

/**
 * @title ValidationModifiers
 * @notice Small reusable argument checks shared by the project contracts.
 */
abstract contract ValidationModifiers {
  /**
   * @notice Reverts if the given address is the zero address.
   * @param addr The address to validate.
   */
  modifier nonZeroAddress(address addr) {
    if (addr == address(0)) revert ZeroAddress();
    _;
  }
}
