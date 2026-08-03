// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";

import {IVerifyingPaymaster} from "./interfaces/IVerifyingPaymaster.sol";
import {IFeeSwapper} from "./interfaces/IFeeSwapper.sol";
import {ApproveManager} from "./components/ApproveManager.sol";
import {ValidationModifiers} from "./components/ValidationModifiers.sol";
import {NotEntryPoint} from "./errors/SmartAccountErrors.sol";
import {
  InvalidPaymasterDataLength,
  InsufficientTokenAllowance,
  InvalidExchangeRate
} from "./errors/PaymasterErrors.sol";

/**
 * @title VerifyingPaymaster
 * @notice Sponsors UserOperations that carry an EIP-712 signature from an authorized signer.
 * @dev Two sponsorship modes, selected by the `token` field of `paymasterAndData`:
 *
 *      - `token == address(0)` — the operation is fully sponsored. Validation returns an empty
 *        context, so the EntryPoint skips `postOp` entirely.
 *      - `token != address(0)` — the account repays the sponsorship in that ERC-20 at the signed
 *        `exchangeRate`, charged in `postOp` against the gas actually consumed. When a
 *        `FeeSwapper` is configured, the collected fee is converted to the canonical token in
 *        the same `postOp`, best effort.
 *
 *      Staking (`addStake`) is available for production use but not required: validation reads
 *      only immutable and owner-set state, plus the fee token's balance/allowance of the sender,
 *      which are sender-associated slots under ERC-7562.
 */
contract VerifyingPaymaster is IVerifyingPaymaster, BasePaymaster, EIP712, ApproveManager, ValidationModifiers {
  using SafeERC20 for IERC20;

  bytes32 public constant SPONSORSHIP_REQUEST_TYPEHASH = keccak256(
    "SponsorshipRequest(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint48 validUntil,uint48 validAfter,address token,uint256 exchangeRate,uint24 poolFee)"
  );

  /// @notice Offset of the paymaster-specific payload inside `paymasterAndData`.
  uint256 private constant DATA_OFFSET = PAYMASTER_DATA_OFFSET;

  /// @notice Exact length of `paymasterAndData`: 52 header + 6 + 6 + 20 + 32 + 3 + 65 signature.
  uint256 private constant PAYMASTER_DATA_LENGTH = 184;

  /// @notice Denominator of `exchangeRate`: the number of fee tokens worth one full ETH.
  uint256 private constant EXCHANGE_RATE_DENOMINATOR = 1e18;

  /// @notice Gas charged on top of `actualGasCost` to cover the `postOp` call itself.
  uint256 private constant POST_OP_GAS_OVERHEAD = 40_000;

  /// @notice Extra gas charged when `postOp` also swaps the collected fee.
  uint256 private constant SWAP_GAS_OVERHEAD = 180_000;

  /// @notice The address whose EIP-712 signature authorizes a sponsorship.
  address public signer;

  /// @notice Converts collected fee tokens into the canonical token. Optional.
  IFeeSwapper public swapper;

  /// @notice Whether `postOp` should attempt a swap of the collected fee.
  bool public swapEnabled;

  /**
   * @notice Deploys the paymaster.
   * @param entryPoint_ The EntryPoint this paymaster serves.
   * @param owner_ The address that administers the paymaster (deposits, stake, signer).
   * @param signer_ The address authorizing sponsorships off-chain.
   */
  constructor(
    IEntryPoint entryPoint_,
    address owner_,
    address signer_
  ) BasePaymaster(entryPoint_) EIP712("VerifyingPaymaster", "1") nonZeroAddress(owner_) nonZeroAddress(signer_) {
    signer = signer_;
    emit SignerUpdated(address(0), signer_);

    if (owner_ != msg.sender) _transferOwnership(owner_);
  }

  /**
   * @notice Replaces the authorized sponsorship signer.
   * @param newSigner The address authorizing sponsorships from now on.
   */
  function setSigner(address newSigner) external onlyOwner nonZeroAddress(newSigner) {
    emit SignerUpdated(signer, newSigner);
    signer = newSigner;
  }

  /**
   * @notice Sets the contract used to convert collected fees into the canonical token.
   * @param newSwapper The swapper address.
   */
  function setSwapper(address newSwapper) external onlyOwner nonZeroAddress(newSwapper) {
    swapper = IFeeSwapper(newSwapper);
    emit SwapperUpdated(newSwapper);
  }

  /**
   * @notice Enables or disables the fee swap performed in `postOp`.
   * @param enabled True to swap collected fees, false to keep them as they are.
   */
  function setSwapEnabled(bool enabled) external onlyOwner {
    swapEnabled = enabled;
    emit SwapEnabledUpdated(enabled);
  }

  /**
   * @notice Withdraws fee tokens collected by the paymaster.
   * @param token The ERC-20 to withdraw.
   * @param recipient The address receiving the tokens.
   * @param amount The amount to withdraw, or `type(uint256).max` for the full balance.
   */
  function withdrawTokens(
    IERC20 token,
    address recipient,
    uint256 amount
  ) external onlyOwner nonZeroAddress(recipient) {
    uint256 value = amount == type(uint256).max ? token.balanceOf(address(this)) : amount;

    token.safeTransfer(recipient, value);
    emit TokensWithdrawn(address(token), recipient, value);
  }

  /**
   * @notice Builds the EIP-712 digest the authorized signer has to sign.
   * @dev Covers every field of the operation except `signature` (produced after the sponsor
   *      signs) and `paymasterAndData` (which carries the sponsor signature itself). The
   *      EIP-712 domain pins the digest to this paymaster and this chain.
   * @param userOp The operation to sponsor.
   * @param validUntil Last timestamp the sponsorship is valid at, or 0 for "indefinitely".
   * @param validAfter First timestamp the sponsorship is valid at.
   * @param token The ERC-20 used to repay the sponsorship, or the zero address to fully sponsor.
   * @param exchangeRate Fee tokens per 1e18 wei of gas cost. Ignored when `token` is zero.
   * @param poolFee Uniswap V3 pool fee tier used to swap the collected fee. Ignored when no
   *        swapper is configured.
   * @return The digest to sign.
   */
  function getHash(
    PackedUserOperation calldata userOp,
    uint48 validUntil,
    uint48 validAfter,
    address token,
    uint256 exchangeRate,
    uint24 poolFee
  ) public view returns (bytes32) {
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            SPONSORSHIP_REQUEST_TYPEHASH,
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            validUntil,
            validAfter,
            token,
            exchangeRate,
            poolFee
          )
        )
      );
  }

  /**
   * @notice Decodes the paymaster-specific part of `paymasterAndData`.
   * @param paymasterAndData The full `paymasterAndData` field of a UserOperation.
   * @return validUntil Last timestamp the sponsorship is valid at.
   * @return validAfter First timestamp the sponsorship is valid at.
   * @return token The fee token, or the zero address for a fully sponsored operation.
   * @return exchangeRate Fee tokens per 1e18 wei of gas cost.
   * @return poolFee Uniswap V3 pool fee tier used to swap the collected fee.
   * @return signature The sponsor's 65-byte ECDSA signature.
   */
  function parsePaymasterAndData(
    bytes calldata paymasterAndData
  )
    public
    pure
    returns (
      uint48 validUntil,
      uint48 validAfter,
      address token,
      uint256 exchangeRate,
      uint24 poolFee,
      bytes calldata signature
    )
  {
    if (paymasterAndData.length != PAYMASTER_DATA_LENGTH) {
      revert InvalidPaymasterDataLength(paymasterAndData.length);
    }

    validUntil = uint48(bytes6(paymasterAndData[DATA_OFFSET:DATA_OFFSET + 6]));
    validAfter = uint48(bytes6(paymasterAndData[DATA_OFFSET + 6:DATA_OFFSET + 12]));
    token = address(bytes20(paymasterAndData[DATA_OFFSET + 12:DATA_OFFSET + 32]));
    exchangeRate = uint256(bytes32(paymasterAndData[DATA_OFFSET + 32:DATA_OFFSET + 64]));
    poolFee = uint24(bytes3(paymasterAndData[DATA_OFFSET + 64:DATA_OFFSET + 67]));
    signature = paymasterAndData[DATA_OFFSET + 67:];
  }

  /// @inheritdoc BasePaymaster
  function _validatePaymasterUserOp(
    PackedUserOperation calldata userOp,
    bytes32 userOpHash,
    uint256 maxCost
  ) internal view override returns (bytes memory context, uint256 validationData) {
    (
      uint48 validUntil,
      uint48 validAfter,
      address token,
      uint256 exchangeRate,
      uint24 poolFee,
      bytes calldata signature
    ) = parsePaymasterAndData(userOp.paymasterAndData);

    bytes32 digest = getHash(userOp, validUntil, validAfter, token, exchangeRate, poolFee);
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);

    // A wrong or malformed sponsor signature is a validation failure, never a revert:
    // reverting here surfaces as `AA33 reverted` and counts against the paymaster's
    // reputation with bundlers.
    if (err != ECDSA.RecoverError.NoError || recovered != signer) {
      return ("", _packValidationData(true, validUntil, validAfter));
    }

    validationData = _packValidationData(false, validUntil, validAfter);

    // Fully sponsored: an empty context makes the EntryPoint skip postOp altogether.
    if (token == address(0)) return ("", validationData);

    if (exchangeRate == 0) revert InvalidExchangeRate();
    _requireTokenFeePayable(token, userOp.sender, exchangeRate, maxCost);

    context = abi.encode(token, exchangeRate, userOp.sender, userOpHash, poolFee);
  }

  /**
   * @inheritdoc BasePaymaster
   * @dev Reached only in token mode. Charges the account for the gas actually consumed,
   *      rounding up so the paymaster is never short-changed, then converts the collected fee
   *      into the canonical token when a swapper is enabled.
   */
  function _postOp(
    PostOpMode /* mode */,
    bytes calldata context,
    uint256 actualGasCost,
    uint256 actualUserOpFeePerGas
  ) internal override {
    (address token, uint256 exchangeRate, address sender, bytes32 userOpHash, uint24 poolFee) = abi.decode(
      context,
      (address, uint256, address, bytes32, uint24)
    );

    // The swap is decided before charging so its gas is billed to the account rather than
    // absorbed by the paymaster.
    IFeeSwapper feeSwapper = _swapperFor(token, poolFee);
    uint256 overhead =
      address(feeSwapper) == address(0) ? POST_OP_GAS_OVERHEAD : POST_OP_GAS_OVERHEAD + SWAP_GAS_OVERHEAD;

    uint256 tokenAmount = _tokenAmount(actualGasCost + overhead * actualUserOpFeePerGas, exchangeRate);

    emit UserOperationSponsored(sender, userOpHash, token, tokenAmount);
    if (tokenAmount == 0) return;

    IERC20(token).safeTransferFrom(sender, address(this), tokenAmount);

    if (address(feeSwapper) != address(0)) {
      _approveMax(token, address(feeSwapper), tokenAmount);
      feeSwapper.swapCollectedFee(token, tokenAmount, poolFee);
    }
  }

  /**
   * @dev The swapper to use for this fee, or the zero address when no swap should happen.
   *      The swapper itself never reverts, so a UserOperation cannot fail because of a swap.
   */
  function _swapperFor(address token, uint24 poolFee) private view returns (IFeeSwapper) {
    IFeeSwapper feeSwapper = swapper;

    if (!swapEnabled || address(feeSwapper) == address(0)) return IFeeSwapper(address(0));
    if (!feeSwapper.isSwapAvailable(token, poolFee)) return IFeeSwapper(address(0));

    return feeSwapper;
  }

  /// @dev Rejects any caller other than the configured EntryPoint, with a typed error.
  function _requireFromEntryPoint() internal view override {
    if (msg.sender != address(entryPoint)) revert NotEntryPoint(msg.sender);
  }

  /**
   * @dev Rejects up front an operation whose account cannot repay the worst-case fee.
   *      Without this the transfer would fail in `postOp`, which reverts the whole operation
   *      while the paymaster is still charged for the gas.
   */
  function _requireTokenFeePayable(address token, address account, uint256 exchangeRate, uint256 maxCost) private view {
    uint256 maxTokenAmount = _tokenAmount(maxCost, exchangeRate);

    if (
      IERC20(token).balanceOf(account) < maxTokenAmount ||
      IERC20(token).allowance(account, address(this)) < maxTokenAmount
    ) {
      revert InsufficientTokenAllowance(token, account);
    }
  }

  /// @dev Converts a wei-denominated gas cost into fee tokens, rounding up.
  function _tokenAmount(uint256 gasCost, uint256 exchangeRate) private pure returns (uint256) {
    return Math.ceilDiv(gasCost * exchangeRate, EXCHANGE_RATE_DENOMINATOR);
  }
}
