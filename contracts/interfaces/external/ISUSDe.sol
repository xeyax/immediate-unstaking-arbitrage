// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ISUSDe
 * @notice Interface for sUSDe token (staked USDe)
 * @dev sUSDe is an ERC-4626 style token that accrues value over time
 * Address on Ethereum Mainnet: 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497
 */
interface ISUSDe is IERC20 {
    /**
     * @notice Cooldown info for an address
     * @param cooldownEnd Timestamp when cooldown completes
     * @param underlyingAmount Amount of USDe that will be claimable
     */
    struct UserCooldown {
        uint104 cooldownEnd;
        uint152 underlyingAmount;
    }

    /**
     * @notice Initiate cooldown to prepare for unstaking
     * @param assets Amount of sUSDe to unstake
     */
    function cooldownAssets(uint256 assets) external returns (uint256 shares);

    /**
     * @notice Initiate cooldown by shares
     * @param shares Amount of shares to unstake
     */
    function cooldownShares(uint256 shares) external returns (uint256 assets);

    /**
     * @notice Claim unstaked assets after cooldown completes
     * @param receiver Address to receive the USDe
     */
    function unstake(address receiver) external;

    /**
     * @notice Get cooldown info for an address
     * @param owner Address to query
     * @return UserCooldown struct with cooldown details
     */
    function cooldowns(address owner) external view returns (UserCooldown memory);

    /**
     * @notice Get the cooldown duration in seconds
     * @return Duration of cooldown period
     */
    function cooldownDuration() external view returns (uint24);

    /**
     * @notice Convert sUSDe amount to USDe amount
     * @param shares Amount of sUSDe
     * @return assets Equivalent amount of USDe
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Convert USDe amount to sUSDe amount
     * @param assets Amount of USDe
     * @return shares Equivalent amount of sUSDe
     */
    function convertToShares(uint256 assets) external view returns (uint256 shares);
}
