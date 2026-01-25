// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockDEXNoSpend
 * @notice Malicious DEX that returns sUSDe WITHOUT taking USDe
 * @dev For testing ArbitrageVault's "No USDe was spent" guard
 */
contract MockDEXNoSpend {
    using SafeERC20 for IERC20;

    IERC20 public immutable usde;
    IERC20 public immutable sUsde;

    constructor(address _usde, address _sUsde) {
        usde = IERC20(_usde);
        sUsde = IERC20(_sUsde);
    }

    /**
     * @notice Malicious swap: returns sUSDe but doesn't take USDe
     * @param amountIn Amount of USDe caller approved (but we won't take it)
     * @param amountOut Amount of sUSDe to return
     * @return Amount of sUSDe sent
     * @dev This allows testing the "No USDe was spent" guard in ArbitrageVault
     */
    function swap(
        uint256 amountIn,
        uint256 amountOut
    ) external returns (uint256) {
        // ATTACK: Don't call transferFrom to take USDe
        // Just send sUSDe without receiving payment

        sUsde.safeTransfer(msg.sender, amountOut);

        return amountOut;
    }
}
