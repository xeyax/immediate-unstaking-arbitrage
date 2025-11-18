// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IStakedUSDe.sol";
import "./interfaces/IUSDe.sol";

/**
 * @title UnstakeProxy
 * @notice Minimal proxy contract that enables concurrent unstaking operations
 * @dev Each proxy can hold one active unstake at a time; vault manages multiple proxies
 *
 * Architecture:
 * - Vault deploys multiple UnstakeProxy instances via factory pattern
 * - Each proxy acts as independent participant in Ethena protocol
 * - Vault allocates free proxy for each arbitrage operation
 * - Proxy initiates unstake and claims after 7-day cooldown
 *
 * Security:
 * - Owned by vault contract only
 * - No fund storage (sUSDe in, USDe out per operation)
 * - Simple delegation to Ethena protocol
 */
contract UnstakeProxy is Ownable {
    // ============ Immutable State ============

    /// @notice Ethena's Staked USDe contract
    IStakedUSDe public immutable stakedUsde;

    /// @notice Ethena's USDe stablecoin contract
    IUSDe public immutable usde;

    // ============ Events ============

    /// @notice Emitted when unstake is initiated
    event UnstakeInitiated(uint256 shares, uint256 expectedAssets);

    /// @notice Emitted when USDe is claimed after cooldown
    event UsdeClaimed(uint256 amount, address receiver);

    // ============ Constructor ============

    /**
     * @notice Creates new UnstakeProxy instance
     * @param _stakedUsde Address of Ethena's sUSDe contract
     * @param _usde Address of Ethena's USDe contract
     * @param _vault Address of vault contract (becomes owner)
     */
    constructor(address _stakedUsde, address _usde, address _vault) Ownable(_vault) {
        require(_stakedUsde != address(0), "Invalid sUSDe address");
        require(_usde != address(0), "Invalid USDe address");
        require(_vault != address(0), "Invalid vault address");

        stakedUsde = IStakedUSDe(_stakedUsde);
        usde = IUSDe(_usde);
    }

    // ============ External Functions ============

    /**
     * @notice Initiates unstaking operation via Ethena protocol
     * @dev Vault must transfer sUSDe to this proxy before calling
     * @param shares Amount of sUSDe shares to unstake
     * @return expectedAssets Expected USDe amount after 7-day cooldown
     */
    function initiateUnstake(uint256 shares) external onlyOwner returns (uint256 expectedAssets) {
        require(shares > 0, "Shares must be > 0");

        // Verify proxy received sUSDe
        uint256 balance = stakedUsde.balanceOf(address(this));
        require(balance >= shares, "Insufficient sUSDe balance");

        // Call Ethena to initiate cooldown
        // This burns sUSDe and locks USDe in silo for 7 days
        expectedAssets = stakedUsde.cooldownShares(shares, address(this));

        emit UnstakeInitiated(shares, expectedAssets);
    }

    /**
     * @notice Claims USDe after cooldown period completes
     * @dev Can only be called after 7-day cooldown expires
     * @param receiver Address to receive claimed USDe (typically vault)
     */
    function claimUnstake(address receiver) external onlyOwner {
        require(receiver != address(0), "Invalid receiver");

        // Get balance before claim
        uint256 balanceBefore = usde.balanceOf(address(this));

        // Call Ethena to claim matured USDe
        // This transfers USDe from silo to this proxy
        stakedUsde.unstake(address(this));

        // Calculate received amount
        uint256 balanceAfter = usde.balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;

        require(received > 0, "No USDe claimed");

        // Transfer USDe to receiver (vault)
        usde.transfer(receiver, received);

        emit UsdeClaimed(received, receiver);
    }

    /**
     * @notice Emergency function to recover tokens sent by mistake
     * @dev Only callable by owner (vault)
     * @param token Address of token to recover
     * @param amount Amount to recover
     * @param receiver Address to receive recovered tokens
     */
    function recoverTokens(address token, uint256 amount, address receiver) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(receiver != address(0), "Invalid receiver");
        require(amount > 0, "Amount must be > 0");

        IERC20(token).transfer(receiver, amount);
    }
}
