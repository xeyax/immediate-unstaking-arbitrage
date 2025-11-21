## ADR-003 — Position Accounting Model

**Status**: Implemented (Updated 2025-11-21)
**Date**: 2025-11-06 (Updated: 2025-11-21)
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-04, FR-05

### Context

The vault must track multiple concurrent unstaking positions to calculate NAV accurately and enable claiming matured positions. Per ADR-002, NAV calculation requires time-weighted accrual for fair profit recognition. Each position has a 7-day cooldown before becoming claimable.

The challenge is efficiently calculating NAV while preserving individual position information needed for claim operations and ensuring profit accrual stops exactly at COOLDOWN_PERIOD (7 days) regardless of keeper claiming speed.

### Decision (Updated 2025-11-21)

Track individual positions using **FIFO range-based iteration** for NAV calculation. Positions are claimed in FIFO order (oldest first), maintaining active positions in a continuous range `[firstActivePositionId, nextPositionId)`. NAV calculation iterates through this range (limited by MAX_ACTIVE_POSITIONS = 50) and calculates time-weighted profit with per-position capping at COOLDOWN_PERIOD. This ensures NAV is always accurate regardless of when keepers claim matured positions, with bounded and predictable gas costs, while being simpler than array-based tracking.

### Options Considered

**FIFO Range-Based Iteration (chosen - 2025-11-21 update)**
Track active positions in continuous range `[firstActivePositionId, nextPositionId)`. Positions must be claimed in FIFO order (oldest first). NAV calculation iterates through this range (bounded by MAX_ACTIVE_POSITIONS = 50). Trade-offs: Perfect NAV accuracy with no keeper-timing dependency, simplest possible logic (no array management), predictable gas cost (~100k for 50 positions); requires FIFO claim order but this is natural for positions with identical 7-day cooldown periods.

**Array-Based Iteration (2025-11-20, replaced 2025-11-21)**
Store each position in array; iterate all active positions during NAV calculation with bounded maximum (MAX_ACTIVE_POSITIONS = 50). For each position, calculate time-weighted profit capped at COOLDOWN_PERIOD. Trade-offs: Perfect NAV accuracy with no keeper-timing dependency, allows any claim order; requires swap-and-pop array management adding ~40 lines of code and extra storage slots. **Replaced with FIFO approach for simplicity.**

**Accrual Rate Approach (originally chosen, replaced 2025-11-20)**
Maintain aggregate accrual rate representing profit accumulation speed. NAV calculation is O(1). Trade-offs: Very gas-efficient (~5k); discovered critical bug where matured-but-unclaimed positions inflate the rate, causing NAV to grow beyond expected profit and creating unfair advantage for withdrawers; requires keeper to claim promptly for accuracy. **Replaced due to rate inflation bug.**

**Aggregate Only**
Track only total book value and total expected profit; no individual positions. Trade-offs: Very low gas cost; fails FR-04 requirement to track individual positions for claiming, prevents per-position profit analysis.

### Consequences (Updated 2025-11-21)

**Core Principle**
- Active positions maintained in FIFO range `[firstActivePositionId, nextPositionId)`
- NAV calculation iterates positions and sums: `bookValue + min(timeElapsed, COOLDOWN_PERIOD) × expectedProfit / COOLDOWN_PERIOD`
- Each position's profit accrues for exactly 7 days, then stops (regardless of claim timing)
- Position claiming is FIFO-only (oldest position first) - simplest possible implementation

**Key Requirements**
- Position struct stores: sUsdeAmount, bookValue, expectedAssets, startTime, claimed, proxyContract
- NAV calculation is O(N) where N ≤ MAX_ACTIVE_POSITIONS (50)
- No keeper-timing dependency - NAV is always accurate
- FIFO claim order enforced (`claimPosition()` has no positionId parameter)
- Contract upgradability can handle Ethena protocol issues if needed

**Trade-offs**
- Gas cost: ~100k for NAV with 50 positions (vs ~110k with array approach)
- Total deposit/withdraw: ~200k gas (simpler than array-based ~210k)
- Code simplicity: ~50 lines less than array approach (no swap-and-pop, no index tracking, no emergency skip)
- Storage savings: No array storage, no mapping for reverse index lookup
- Limitation: FIFO claim order required (but natural for identical cooldown periods)
- Benefit: Perfect accuracy, no rate inflation bugs, no keeper dependency, simplest possible implementation
- Invariant: Position profit never accrues beyond COOLDOWN_PERIOD
- Ethena protocol dependency: If Ethena fails, contract upgrade required (vs emergency skip function)

### On-Chain Implementation Notes (Updated 2025-11-21)

**Position Struct**
```solidity
struct Position {
    uint256 sUsdeAmount;        // sUSDe shares in unstake
    uint256 bookValue;          // USDe paid to acquire sUSDe
    uint256 expectedAssets;     // Expected USDe from Ethena (returned by cooldownShares)
    uint256 startTime;          // When unstake initiated
    bool claimed;               // Whether position has been claimed
    address proxyContract;      // Which UnstakeProxy holds this unstake (see ADR-008)
}
```

**Active Position Tracking (FIFO Range)**
```solidity
uint256 public firstActivePositionId;         // First unclaimed position ID
uint256 public nextPositionId;                // Next position ID to assign (also last+1)
uint256 public constant MAX_ACTIVE_POSITIONS = 50;  // Gas cost bound
mapping(uint256 => Position) public positions; // Position ID → Position data

// Active positions are in continuous range [firstActivePositionId, nextPositionId)
// FIFO invariant: no gaps in this range (all positions unclaimed)
```

**Opening Position**
- Call proxy to initiate unstake; proxy calls `cooldownShares()` which returns expected USDe amount
- Validate: expectedAssets >= bookValue (prevent negative profit positions)
- Check: (nextPositionId - firstActivePositionId) < MAX_ACTIVE_POSITIONS
- Store position with all tracking data including assigned proxy (per ADR-008)
- Assign positionId = nextPositionId++

**Claiming Position (FIFO)**
- Claim oldest position: positionId = firstActivePositionId
- Retrieve proxy address from position struct
- Call proxy to claim unstake from Ethena protocol (see ADR-008)
- Mark position as claimed
- Increment firstActivePositionId++ (move to next position)
- Release proxy

**NAV Calculation (Bounded O(N))**
```solidity
NAV = idleAssets + Σ(bookValue[i] + accruedProfit[i]) for i in [firstActivePositionId, nextPositionId)

where for each position i:
    timeElapsed = min(block.timestamp - startTime[i], COOLDOWN_PERIOD)
    expectedProfit[i] = expectedAssets[i] - bookValue[i]
    accruedProfit[i] = expectedProfit[i] × timeElapsed / COOLDOWN_PERIOD
```

Gas cost: N × ~2,000 gas ≈ 100k for N=50, acceptable for deposit/withdraw operations.

**Error Handling - Ethena Protocol Dependency**
- Vault is 100% dependent on Ethena staking/unstaking functionality
- If Ethena contract calls fail (e.g., convertToAssets(), cooldownShares(), cooldownAssets()):
  - Transactions revert with Ethena error message
  - No fallback or recovery mechanism possible on-chain
  - Vault operations halt until Ethena protocol resumes normal operation
- No mitigation strategy beyond Ethena protocol reliability
- Depositors assume Ethena protocol risk when using vault

### Implementation Change History

**2025-11-21: Simplified to FIFO Range-Based Iteration**

*Reason:* Array-based iteration (implemented 2025-11-20) worked correctly but required additional complexity: swap-and-pop logic for array management, reverse index mapping for O(1) removal, and ~40 extra lines of code.

*Solution:* FIFO range-based approach eliminates array management entirely by enforcing FIFO claim order. Since all positions have identical 7-day cooldown, FIFO is the natural claim order anyway.

*Impact:*
- Code complexity reduced: -50 lines (removed swap-and-pop, index tracking, emergency skip)
- Storage reduced: no array, no reverse index mapping
- Gas cost improved: ~210k → ~200k for deposit/withdraw
- Trade-off: FIFO claim order required (but natural for identical cooldowns)
- Removed: emergency functions - rely on contract upgradability instead

*Compatibility:* Fully implements ADR-002 formula. Only affects claim ordering, not NAV calculation accuracy.

---

**2025-11-20: Switched from O(1) Accrual Rate to Bounded Iteration**

*Reason:* Original O(1) accrual rate approach had a critical bug where matured-but-unclaimed positions kept contributing to the rate, causing NAV inflation when new positions opened. Attempts to fix with caps didn't address root cause.

*Solution:* Bounded iteration approach with MAX_ACTIVE_POSITIONS limit provides perfect accuracy with acceptable gas costs and no keeper-timing dependency.

*Impact:*
- Gas cost increased: ~100k → ~210k for deposit/withdraw
- Accuracy improved: approximate → perfect
- Eliminated: rate inflation bug, keeper timing dependency
- Added: position count limit (50, sufficient for realistic operations)

*Compatibility:* Fully implements ADR-002 formula. The specific accounting method (iteration vs accrual rate) is an implementation detail; the NAV formula itself is unchanged.

### Dependencies

- ADR-001: ERC-4626 totalAssets() must incorporate position values.
- ADR-002: NAV uses time-weighted formula (implementation method is flexible).

### References

- [Ethena sUSDe Documentation](https://docs.ethena.fi/)
- FR-04: Unstaking Position Tracking
- FR-05: Share Value Calculation
- Implementation: contracts/ArbitrageVault.sol (bounded iteration NAV)
