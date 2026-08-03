// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Freely mintable ERC-20 used as the fee token in tests.
 */
contract MockERC20 is ERC20 {
  uint8 private immutable _DECIMALS;

  /**
   * @notice Deploys the token.
   * @param name_ Token name.
   * @param symbol_ Token symbol.
   * @param decimals_ Number of decimals the token uses.
   */
  constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
    _DECIMALS = decimals_;
  }

  /// @inheritdoc ERC20
  function decimals() public view override returns (uint8) {
    return _DECIMALS;
  }

  /**
   * @notice Mints tokens to any address.
   * @param to Recipient of the minted tokens.
   * @param amount Amount to mint.
   */
  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
