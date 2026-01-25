// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockDEXNoRevert
 * @notice Mock DEX that DOES NOT check minAmountOut - for testing ArbitrageVault's slippage guard
 * @dev This allows testing the vault's "Insufficient sUSDe received (slippage)" guard
 *      by having the DEX return less than minAmountOut WITHOUT reverting
 */
contract MockDEXNoRevert {
    using SafeERC20 for IERC20;

    IERC20 public immutable usde;
    IERC20 public immutable sUsde;

    // Exchange rate: sUSDe per USDe (scaled by 1e18)
    uint256 public exchangeRate;

    constructor(address _usde, address _sUsde, uint256 _initialRate) {
        usde = IERC20(_usde);
        sUsde = IERC20(_sUsde);
        exchangeRate = _initialRate;
    }

    /**
     * @notice Swaps USDe for sUSDe WITHOUT checking minAmountOut
     * @param amountIn Amount of USDe to swap
     * @param minAmountOut IGNORED - does not check this parameter
     * @return amountOut Amount of sUSDe received
     * @dev This allows the swap to succeed even if amountOut < minAmountOut
     *      so that ArbitrageVault's guard can be tested
     */
    function swap(
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        // Calculate sUSDe amount to return
        amountOut = (amountIn * exchangeRate) / 1e18;

        // NOTE: Does NOT check minAmountOut!
        // This is intentional - allows testing vault's slippage guard

        // Transfer USDe from caller
        usde.safeTransferFrom(msg.sender, address(this), amountIn);

        // Transfer sUSDe to caller (even if less than minAmountOut)
        require(sUsde.balanceOf(address(this)) >= amountOut, "DEX: insufficient sUSDe liquidity");
        sUsde.safeTransfer(msg.sender, amountOut);

        return amountOut;
    }

    /**
     * @notice Updates exchange rate
     * @param newRate New exchange rate (scaled by 1e18)
     */
    function setExchangeRate(uint256 newRate) external {
        exchangeRate = newRate;
    }
}
