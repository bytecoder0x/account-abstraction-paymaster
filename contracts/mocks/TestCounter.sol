// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title TestCounter
 * @notice Trivial target contract used by the tests to observe that a UserOperation executed.
 */
contract TestCounter {
  /// @notice Number of successful `count()` calls per caller.
  mapping(address caller => uint256 count) public counters;

  /// @notice Reverts with this message when `fail()` is called.
  error CounterFailed();

  /// @notice Increments the caller's counter.
  function count() external {
    counters[msg.sender]++;
  }

  /// @notice Always reverts. Used to test failing calls inside a batch.
  function fail() external pure {
    revert CounterFailed();
  }

  /// @notice Accepts native currency so value-carrying calls can be tested.
  receive() external payable {}
}
