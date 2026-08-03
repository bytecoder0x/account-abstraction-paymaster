// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";

/**
 * @title IVerifyingPaymaster
 * @notice Events and errors of the verifying paymaster.
 */
interface IVerifyingPaymaster is IPaymaster {
  /**
   * @notice Emitted when the authorized signer is changed.
   * @param previousSigner The signer being replaced.
   * @param newSigner The signer that will authorize sponsorships from now on.
   */
  event SignerUpdated(address indexed previousSigner, address indexed newSigner);

  /**
   * @notice Emitted for every sponsored UserOperation.
   * @param sender The sponsored account.
   * @param userOpHash Hash of the sponsored UserOperation.
   * @param token The ERC-20 used to repay the sponsorship, or the zero address for a
   *        fully sponsored operation.
   * @param tokenAmount The amount of `token` charged, zero for a fully sponsored operation.
   */
  event UserOperationSponsored(
    address indexed sender,
    bytes32 indexed userOpHash,
    address indexed token,
    uint256 tokenAmount
  );

  /**
   * @notice Emitted when the fee swapper is set or replaced.
   * @param swapper The contract that will convert collected fees from now on.
   */
  event SwapperUpdated(address indexed swapper);

  /**
   * @notice Emitted when the fee swap performed in `postOp` is enabled or disabled.
   * @param enabled True when collected fees are swapped.
   */
  event SwapEnabledUpdated(bool enabled);

  /**
   * @notice Emitted when the owner withdraws collected fee tokens.
   * @param token The token withdrawn.
   * @param recipient The address receiving the tokens.
   * @param amount The amount withdrawn.
   */
  event TokensWithdrawn(address indexed token, address indexed recipient, uint256 amount);
}
