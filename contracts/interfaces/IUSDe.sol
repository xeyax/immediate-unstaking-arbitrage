// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUSDe
 * @notice Interface for Ethena's USDe stablecoin
 * @dev Standard ERC20 token interface, no special methods required
 */
interface IUSDe is IERC20 {
    // USDe is a standard ERC20 token
    // All required methods are inherited from IERC20
}
