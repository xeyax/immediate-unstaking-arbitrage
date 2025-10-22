// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICooldownManager
 * @notice Interface for managing locker pool and cooldown batches
 * @dev Manages a pool of locker addresses, ensuring 1 active batch per locker
 */
interface ICooldownManager {
    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Result returned when opening a new cooldown
     * @param batchId Sequential batch identifier
     * @param locker Address of the assigned locker
     * @param claimId Protocol-specific claim identifier
     * @param t0 Timestamp when cooldown started
     * @param t1 Timestamp when cooldown completes
     * @param expectedBase Expected amount of base asset at maturity
     */
    struct OpenCooldownResult {
        uint256 batchId;
        address locker;
        bytes32 claimId;
        uint64 t0;
        uint64 t1;
        uint256 expectedBase;
    }

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event CooldownOpened(
        uint256 indexed batchId,
        address indexed locker,
        bytes32 claimId,
        uint256 amountStake,
        uint64 t0,
        uint64 t1
    );

    event CooldownClaimed(
        uint256 indexed batchId,
        address indexed locker,
        uint256 amountReceived
    );

    event LockerAdded(address indexed locker);
    event LockerRemoved(address indexed locker);

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Open a new cooldown by assigning a free locker and requesting unstake
     * @param amountStake Amount of staked tokens to unstake
     * @param extraData Additional data for adapter (unused in MVP)
     * @return res OpenCooldownResult containing batch details
     */
    function openCooldown(uint256 amountStake, bytes calldata extraData)
        external
        returns (OpenCooldownResult memory res);

    /**
     * @notice Claim a matured batch and mark locker as free
     * @param batchId The batch ID to claim
     * @return amountBaseReceived Amount of base asset received
     */
    function claim(uint256 batchId) external returns (uint256 amountBaseReceived);

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get next available free locker
     * @return Address of the next free locker
     */
    function nextFreeLocker() external view returns (address);

    /**
     * @notice Check if a locker is currently free
     * @param locker Address to check
     * @return True if locker is free
     */
    function isLockerFree(address locker) external view returns (bool);

    /**
     * @notice Get total number of lockers in the pool
     * @return Total number of lockers
     */
    function lockerCount() external view returns (uint256);
}
