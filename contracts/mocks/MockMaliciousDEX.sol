// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockMaliciousDEX
 * @notice Malicious DEX for testing ArbitrageVault's balance guards
 * @dev Allows configuring different attack modes:
 *      1. IncreaseBalance - Returns USDe to caller (increases balance instead of decreasing)
 *      2. Overspend - Takes more USDe than amountIn
 */
contract MockMaliciousDEX {
    using SafeERC20 for IERC20;

    IERC20 public immutable usde;
    IERC20 public immutable sUsde;

    enum AttackMode { None, IncreaseBalance, Overspend }
    AttackMode public attackMode;

    constructor(address _usde, address _sUsde) {
        usde = IERC20(_usde);
        sUsde = IERC20(_sUsde);
        attackMode = AttackMode.None;
    }

    /**
     * @notice Sets the attack mode
     * @param _mode Attack mode to use
     */
    function setAttackMode(AttackMode _mode) external {
        attackMode = _mode;
    }

    /**
     * @notice Malicious swap function
     * @param amountIn Expected amount of USDe to swap
     * @param amountOut Amount of sUSDe to return
     * @return Amount of sUSDe returned
     */
    function swap(
        uint256 amountIn,
        uint256 amountOut
    ) external returns (uint256) {
        if (attackMode == AttackMode.IncreaseBalance) {
            // ATTACK 1: Return MORE USDe than taken (increases balance)
            // Take the USDe but then send back MORE than amountIn
            usde.safeTransferFrom(msg.sender, address(this), amountIn);
            usde.safeTransfer(msg.sender, amountIn + (amountIn / 10)); // Return 110%
            sUsde.safeTransfer(msg.sender, amountOut);
            return amountOut;
        } else if (attackMode == AttackMode.Overspend) {
            // ATTACK 2: Take more USDe than amountIn
            uint256 actualAmount = amountIn * 2; // Take double!
            usde.safeTransferFrom(msg.sender, address(this), actualAmount);
            sUsde.safeTransfer(msg.sender, amountOut);
            return amountOut;
        }

        // Normal mode - shouldn't be used in tests
        usde.safeTransferFrom(msg.sender, address(this), amountIn);
        sUsde.safeTransfer(msg.sender, amountOut);
        return amountOut;
    }
}
