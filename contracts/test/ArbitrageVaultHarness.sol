// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ArbitrageVault.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArbitrageVaultHarness
 * @notice Test harness for ArbitrageVault that exposes internal functions and adds test helpers
 * @dev This contract should ONLY be used in tests, never deploy to production
 *
 * Purpose:
 * - Expose internal functions (_allocateFreeProxy, _releaseProxy) for unit testing
 * - Provide test helpers for Phase 2 (before executeArbitrage is implemented)
 * - Keep production ArbitrageVault.sol clean of test-only code
 *
 * Lifecycle:
 * - Phase 2-4: Use this harness for testing proxy orchestration
 * - Phase 5+: Switch to testing through executeArbitrage()
 * - Production: Deploy only ArbitrageVault.sol, not this harness
 */
contract ArbitrageVaultHarness is ArbitrageVault {
    using SafeERC20 for IERC20;
    // ============ Constructor ============

    constructor(address usdeToken, address stakedUsdeToken)
        ArbitrageVault(usdeToken, stakedUsdeToken)
    {}

    // ============ Test Helper Functions ============

    /**
     * @notice TEST HELPER: Initiates unstake operation through proxy
     * @param sUsdeAmount Amount of sUSDe to unstake
     * @return expectedAssets Expected USDe amount after cooldown
     * @dev Simulates Phase 5 executeArbitrage() behavior for Phase 2 testing
     *      This function will NOT be in production deployment
     */
    function initiateUnstakeForTesting(uint256 sUsdeAmount)
        external
        onlyOwner
        returns (uint256 expectedAssets)
    {
        require(sUsdeAmount > 0, "Amount must be > 0");

        // Allocate free proxy
        address proxyAddress = _allocateFreeProxy();

        // Transfer sUSDe from vault to proxy
        IERC20(address(stakedUsde)).safeTransfer(proxyAddress, sUsdeAmount);

        // Get proxy instance and initiate unstake
        UnstakeProxy proxy = UnstakeProxy(proxyAddress);
        expectedAssets = proxy.initiateUnstake(sUsdeAmount);

        return expectedAssets;
    }

    /**
     * @notice TEST HELPER: Claims unstake through proxy after cooldown
     * @param proxyAddress Address of proxy to claim from
     * @dev Simulates Phase 4 position claiming for Phase 2 testing
     *      This function will NOT be in production deployment
     */
    function claimUnstakeForTesting(address proxyAddress) external onlyOwner {
        require(proxyAddress != address(0), "Invalid proxy");
        require(proxyBusy[proxyAddress], "Proxy not busy");

        // Claim through proxy
        UnstakeProxy proxy = UnstakeProxy(proxyAddress);
        proxy.claimUnstake(address(this));

        // Release proxy
        _releaseProxy(proxyAddress);
    }
}
