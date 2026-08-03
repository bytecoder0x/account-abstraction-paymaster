// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS} from "@account-abstraction/contracts/core/Helpers.sol";

import {ISmartAccount} from "./interfaces/ISmartAccount.sol";
import {NotEntryPointOrOwner, ZeroAddress} from "./errors/SmartAccountErrors.sol";

/**
 * @title SmartAccount
 * @notice Minimal ERC-4337 account owned by a single ECDSA key.
 * @dev Deployed behind an ERC-1967 proxy by `SmartAccountFactory`, so `owner` lives in proxy
 *      storage while the implementation is shared by every account.
 *
 *      `execute` and `executeBatch` come from `BaseAccount`; this contract only widens the
 *      caller check so the owner can drive the account directly, without going through a
 *      UserOperation.
 */
contract SmartAccount is BaseAccount, Initializable, IERC1271, IERC165 {
  /// @notice ERC-1271 return value for a valid signature.
  bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

  /// @notice ERC-1271 return value for an invalid signature.
  bytes4 private constant ERC1271_INVALID_SIGNATURE = 0xffffffff;

  /// @notice The address allowed to sign UserOperations for this account.
  address public owner;

  IEntryPoint private immutable _ENTRY_POINT;

  /**
   * @notice Emitted once when the account is initialized behind its proxy.
   * @param entryPoint The EntryPoint the account is bound to.
   * @param owner The address allowed to sign UserOperations for this account.
   */
  event SmartAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner);

  /**
   * @notice Deploys the shared implementation and locks it against direct initialization.
   * @param entryPoint_ The EntryPoint every account created from this implementation is bound to.
   */
  constructor(IEntryPoint entryPoint_) {
    if (address(entryPoint_) == address(0)) revert ZeroAddress();
    _ENTRY_POINT = entryPoint_;
    _disableInitializers();
  }

  /// @notice Accepts native currency so the account can be funded and can pay its own prefund.
  receive() external payable {}

  /**
   * @notice Sets the account owner. Callable exactly once, through the proxy.
   * @param owner_ The address allowed to sign UserOperations for this account.
   */
  function initialize(address owner_) external initializer {
    if (owner_ == address(0)) revert ZeroAddress();
    owner = owner_;
    emit SmartAccountInitialized(_ENTRY_POINT, owner_);
  }

  /// @inheritdoc BaseAccount
  function entryPoint() public view override returns (IEntryPoint) {
    return _ENTRY_POINT;
  }

  /**
   * @notice ERC-1271 signature check against the account owner.
   * @dev Never reverts: callers branch on the returned magic value, so a malformed signature
   *      must produce `0xffffffff` rather than a revert.
   * @param hash The hash that was signed.
   * @param signature The ECDSA signature to verify.
   * @return The ERC-1271 magic value when the signature is the owner's, `0xffffffff` otherwise.
   */
  function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);

    if (err != ECDSA.RecoverError.NoError || recovered != owner) return ERC1271_INVALID_SIGNATURE;
    return ERC1271_MAGIC_VALUE;
  }

  /// @inheritdoc IERC165
  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return
      interfaceId == type(IERC1271).interfaceId ||
      interfaceId == type(IERC165).interfaceId ||
      interfaceId == type(ISmartAccount).interfaceId;
  }

  /**
   * @notice The account's ETH deposit held by the EntryPoint.
   * @return The deposit amount in wei.
   */
  function getDeposit() external view returns (uint256) {
    return _ENTRY_POINT.balanceOf(address(this));
  }

  /// @notice Tops up the account's deposit in the EntryPoint.
  function addDeposit() external payable {
    _ENTRY_POINT.depositTo{value: msg.value}(address(this));
  }

  /**
   * @dev Allows the EntryPoint (UserOperation flow) and the owner (direct calls) to execute.
   */
  function _requireForExecute() internal view override {
    if (msg.sender != address(_ENTRY_POINT) && msg.sender != owner) {
      revert NotEntryPointOrOwner(msg.sender);
    }
  }

  /**
   * @dev Validates that `userOp.signature` is the owner's ECDSA signature over `userOpHash`.
   *      EntryPoint v0.8 already returns an EIP-712 digest from `getUserOpHash`, so the hash is
   *      recovered as-is with no EIP-191 wrapping.
   *
   *      Uses `tryRecover` rather than `recover`: a malformed signature must return
   *      `SIG_VALIDATION_FAILED`, never revert, or the EntryPoint reports `AA23 reverted`
   *      instead of a clean signature failure.
   */
  function _validateSignature(
    PackedUserOperation calldata userOp,
    bytes32 userOpHash
  ) internal view override returns (uint256 validationData) {
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(userOpHash, userOp.signature);

    if (err != ECDSA.RecoverError.NoError || recovered != owner) return SIG_VALIDATION_FAILED;
    return SIG_VALIDATION_SUCCESS;
  }
}
