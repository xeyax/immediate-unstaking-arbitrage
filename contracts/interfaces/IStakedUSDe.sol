// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IStakedUSDe
 * @notice Interface for Ethena's Staked USDe (sUSDe) contract
 * @dev Extends ERC4626 standard with cooldown mechanism for unstaking
 */
interface IStakedUSDe is IERC20 {
    /**
     * @notice Initiates cooldown period for unstaking shares
     * @dev After 7-day cooldown, can call unstake() to claim USDe
     * @param shares Amount of sUSDe shares to unstake
     * @param owner Address initiating the cooldown
     * @return assets Expected amount of USDe that will be received after cooldown
     */
    function cooldownShares(uint256 shares, address owner) external returns (uint256 assets);

    /**
     * @notice Initiates cooldown period for unstaking assets
     * @dev Alternative to cooldownShares - specify USDe amount instead of shares
     * @param assets Amount of USDe assets to receive
     * @param owner Address initiating the cooldown
     * @return shares Amount of sUSDe shares burned
     */
    function cooldownAssets(uint256 assets, address owner) external returns (uint256 shares);

    /**
     * @notice Claims USDe after cooldown period completes
     * @dev Must be called after 7-day cooldown period
     * @param receiver Address to receive the claimed USDe
     */
    function unstake(address receiver) external;

    /**
     * @notice Converts sUSDe shares to USDe assets at current exchange rate
     * @dev Used for NAV calculation and profit estimation
     * @param shares Amount of sUSDe shares
     * @return assets Equivalent amount of USDe
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Converts USDe assets to sUSDe shares at current exchange rate
     * @param assets Amount of USDe assets
     * @return shares Equivalent amount of sUSDe shares
     */
    function convertToShares(uint256 assets) external view returns (uint256 shares);

    /**
     * @notice Gets the cooldown duration in seconds
     * @return Duration of cooldown period (typically 7 days = 604800 seconds)
     */
    function cooldownDuration() external view returns (uint24);
}
