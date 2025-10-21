// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Counter
 * @notice A simple counter contract example for testing
 */
contract Counter {
    uint256 public number;

    /**
     * @notice Sets the number to a new value
     * @param newNumber The new number to set
     */
    function setNumber(uint256 newNumber) public {
        number = newNumber;
    }

    /**
     * @notice Increments the number by 1
     */
    function increment() public {
        number++;
    }

    /**
     * @notice Decrements the number by 1
     */
    function decrement() public {
        require(number > 0, "Counter: cannot decrement below zero");
        number--;
    }
}

