// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockDEX
 * @notice Simple mock DEX for testing arbitrage execution
 * @dev Swaps USDe for sUSDe at a configurable rate
 */
contract MockDEX {
    using SafeERC20 for IERC20;

    IERC20 public immutable usde;
    IERC20 public immutable sUsde;

    // Exchange rate: sUSDe per USDe (scaled by 1e18)
    // Example: 1.05e18 means 1 USDe = 1.05 sUSDe (5% discount on sUSDe)
    uint256 public exchangeRate;

    bool public shouldFail; // For testing swap failures

    constructor(address _usde, address _sUsde, uint256 _initialRate) {
        usde = IERC20(_usde);
        sUsde = IERC20(_sUsde);
        exchangeRate = _initialRate;
    }

    /**
     * @notice Swaps USDe for sUSDe
     * @param amountIn Amount of USDe to swap
     * @param minAmountOut Minimum sUSDe to receive
     * @return amountOut Amount of sUSDe received
     */
    function swap(
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        require(!shouldFail, "DEX: swap intentionally failed");

        // Calculate sUSDe amount to return
        amountOut = (amountIn * exchangeRate) / 1e18;
        require(amountOut >= minAmountOut, "DEX: insufficient output amount");

        // Transfer USDe from caller
        usde.safeTransferFrom(msg.sender, address(this), amountIn);

        // Transfer sUSDe to caller
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

    /**
     * @notice Sets whether swaps should fail
     * @param _shouldFail True to make swaps fail
     */
    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }
}
