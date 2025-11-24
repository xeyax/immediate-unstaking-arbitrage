// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ArbitrageVault.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArbitrageVaultHarness
 * @notice Test harness for ArbitrageVault that exposes internal functions and adds test helpers
 * @dev ⚠️ FOR TESTING ONLY - NEVER deploy to production
 *
 * Purpose:
 * - **Unit testing**: Expose internal functions for isolated component testing
 * - **Edge case testing**: Create specific scenarios not easily reproducible via executeArbitrage()
 * - **Proxy testing**: Direct proxy orchestration tests (Phase 2)
 * - Keep production ArbitrageVault.sol clean of test-only code
 *
 * Usage Pattern (Phase 5+):
 * - **Unit tests**: Use harness to test components in isolation (ProxyOrchestration, PositionTracking, BugFixes)
 * - **Integration tests**: Use production executeArbitrage() (ArbitrageExecution.test.ts)
 * - **Edge cases**: Use harness for scenarios like zero-profit positions, specific timing
 *
 * Deployment:
 * - ✅ Testing: ArbitrageVaultHarness (this contract)
 * - ✅ Production: ArbitrageVault.sol ONLY (no harness!)
 *
 * Test files using harness:
 * - ProxyOrchestration.test.ts (proxy allocation, round-robin)
 * - PositionTracking.test.ts (position lifecycle, NAV calculation edge cases)
 * - BugFixes.test.ts (accrual cap, phantom profit, input validation)
 *
 * Test files using production code:
 * - ArbitrageExecution.test.ts (uses executeArbitrage() - full integration flow)
 */
contract ArbitrageVaultHarness is ArbitrageVault {
    using SafeERC20 for IERC20;
    // ============ Constructor ============

    constructor(address usdeToken, address stakedUsdeToken, address feeRecipient)
        ArbitrageVault(usdeToken, stakedUsdeToken, feeRecipient)
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

    // ============ Phase 4: Position Tracking Test Helpers ============

    /**
     * @notice TEST HELPER: Opens a position with given parameters
     * @param sUsdeAmount Amount of sUSDe being unstaked
     * @param bookValue USDe paid to acquire sUSDe (for testing - must be realistic)
     * @param expectedAssets Expected USDe from Ethena (for testing - will be validated)
     * @return positionId ID of the newly created position
     * @dev Exposes internal _openPosition for direct testing
     *      In production (Phase 5 completed), executeArbitrage() does:
     *      1. Measures actual USDe spent in DEX swap (bookValue via balance delta)
     *      2. Gets actual expectedAssets from proxy.initiateUnstake() return value
     *      3. Calls _openPosition() with trustlessly validated values
     *      For testing, caller must provide realistic values that pass validation:
     *      - expectedAssets >= bookValue (profit must be non-negative)
     *      - bookValue > 0, sUsdeAmount > 0
     */
    function openPositionForTesting(
        uint256 sUsdeAmount,
        uint256 bookValue,
        uint256 expectedAssets
    ) external onlyOwner returns (uint256 positionId) {
        // Allocate proxy
        address proxyAddress = _allocateFreeProxy();

        // Transfer sUSDe to proxy
        IERC20(address(stakedUsde)).safeTransfer(proxyAddress, sUsdeAmount);

        // Initiate unstake through proxy - get actual expected assets from Ethena
        UnstakeProxy proxy = UnstakeProxy(proxyAddress);
        proxy.initiateUnstake(sUsdeAmount);

        // For testing, we use the provided expectedAssets parameter rather than actualExpectedAssets
        // to test various scenarios. In production, executeArbitrage will use actualExpectedAssets.
        // _openPosition will validate that expectedAssets >= bookValue.
        return _openPosition(sUsdeAmount, bookValue, expectedAssets, proxyAddress);
    }

    /**
     * @notice TEST HELPER: Claims a position by its ID
     * @param positionId The ID of the position to claim
     * @dev Exposes internal _claimPosition for direct testing
     *      Used for testing fee collection mechanism and NAV invariants
     */
    function claimPositionForTesting(uint256 positionId) external onlyOwner {
        _claimPosition(positionId);
    }

}
