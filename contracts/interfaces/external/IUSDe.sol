// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUSDe
 * @notice Interface for USDe token
 * @dev Standard ERC20 token interface
 * Address on Ethereum Mainnet: 0x4c9edd5852cd905f086c759e8383e09bff1e68b3
 */
interface IUSDe is IERC20 {
    // USDe is a standard ERC20, no additional functions needed for MVP
}
