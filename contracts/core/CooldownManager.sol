// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICooldownManager} from "../interfaces/ICooldownManager.sol";
import {ISUSDeAdapter} from "../interfaces/ISUSDeAdapter.sol";

/**
 * @title CooldownManager
 * @notice Manages a pool of locker addresses for cooldown batches
 * @dev Ensures 1 active batch per locker, routes calls to staking adapter
 */
contract CooldownManager is ICooldownManager, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Information about a batch
     * @param locker Address holding the position
     * @param claimId Protocol-specific claim identifier
     * @param t0 Start timestamp
     * @param t1 Maturity timestamp
     * @param expectedBase Expected amount of base asset
     * @param claimed Whether batch has been claimed
     */
    struct Batch {
        address locker;
        bytes32 claimId;
        uint64 t0;
        uint64 t1;
        uint256 expectedBase;
        bool claimed;
    }

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Role for vault (can open cooldowns and claim)
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    /// @notice Staking adapter for protocol integration
    ISUSDeAdapter public immutable adapter;

    /// @notice Array of all lockers in the pool
    address[] public lockers;

    /// @notice Mapping to check if address is a valid locker
    mapping(address => bool) public isLocker;

    /// @notice Mapping from locker to its current batch ID (0 if free)
    mapping(address => uint256) public lockerBatch;

    /// @notice Counter for generating batch IDs
    uint256 public nextBatchId;

    /// @notice Mapping from batch ID to batch info
    mapping(uint256 => Batch) public batches;

    /// @notice Index of next locker to check for availability (round-robin)
    uint256 private nextLockerIndex;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NoFreeLocker();
    error LockerAlreadyExists();
    error LockerNotFound();
    error BatchNotFound();
    error BatchAlreadyClaimed();
    error BatchNotMatured();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize CooldownManager
     * @param _adapter Address of the staking adapter
     * @param admin Address to grant admin role
     */
    constructor(address _adapter, address admin) {
        adapter = ISUSDeAdapter(_adapter);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        nextBatchId = 1; // Start batch IDs from 1
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Add a new locker to the pool
     * @param locker Address of the locker to add
     */
    function addLocker(address locker) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isLocker[locker]) revert LockerAlreadyExists();

        lockers.push(locker);
        isLocker[locker] = true;

        emit LockerAdded(locker);
    }

    /**
     * @notice Remove a locker from the pool (must be free)
     * @param locker Address of the locker to remove
     */
    function removeLocker(address locker) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isLocker[locker]) revert LockerNotFound();
        if (lockerBatch[locker] != 0) revert NoFreeLocker(); // Can't remove active locker

        // Remove from array (swap with last and pop)
        uint256 length = lockers.length;
        for (uint256 i = 0; i < length; i++) {
            if (lockers[i] == locker) {
                lockers[i] = lockers[length - 1];
                lockers.pop();
                break;
            }
        }

        isLocker[locker] = false;

        emit LockerRemoved(locker);
    }

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc ICooldownManager
     */
    function openCooldown(uint256 amountStake, bytes calldata /* extraData */)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (OpenCooldownResult memory res)
    {
        // Find next free locker
        address locker = nextFreeLocker();
        if (locker == address(0)) revert NoFreeLocker();

        // Generate new batch ID
        uint256 batchId = nextBatchId++;

        // Mark locker as busy
        lockerBatch[locker] = batchId;

        // Transfer sUSDe from vault to this contract
        address stakeToken = adapter.stakeToken();
        IERC20(stakeToken).safeTransferFrom(msg.sender, address(this), amountStake);

        // Approve adapter to spend sUSDe
        IERC20(stakeToken).forceApprove(address(adapter), amountStake);

        // Request unstake via adapter
        (bytes32 claimId, uint64 t1, uint256 expectedBase) =
            adapter.requestUnstake(locker, amountStake);

        // Store batch info
        batches[batchId] = Batch({
            locker: locker,
            claimId: claimId,
            t0: uint64(block.timestamp),
            t1: t1,
            expectedBase: expectedBase,
            claimed: false
        });

        emit CooldownOpened(batchId, locker, claimId, amountStake, uint64(block.timestamp), t1);

        // Return result
        res = OpenCooldownResult({
            batchId: batchId,
            locker: locker,
            claimId: claimId,
            t0: uint64(block.timestamp),
            t1: t1,
            expectedBase: expectedBase
        });

        return res;
    }

    /**
     * @inheritdoc ICooldownManager
     */
    function claim(uint256 batchId)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 amountBaseReceived)
    {
        Batch storage batch = batches[batchId];

        if (batch.locker == address(0)) revert BatchNotFound();
        if (batch.claimed) revert BatchAlreadyClaimed();
        if (block.timestamp < batch.t1) revert BatchNotMatured();

        // Mark as claimed and free the locker
        batch.claimed = true;
        lockerBatch[batch.locker] = 0;

        // Claim via adapter (sends USDe to msg.sender = vault)
        amountBaseReceived = adapter.claim(batch.locker, batch.claimId, msg.sender);

        emit CooldownClaimed(batchId, batch.locker, amountBaseReceived);

        return amountBaseReceived;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc ICooldownManager
     */
    function nextFreeLocker() public view override returns (address) {
        uint256 length = lockers.length;
        if (length == 0) return address(0);

        // Round-robin search starting from nextLockerIndex
        for (uint256 i = 0; i < length; i++) {
            uint256 idx = (nextLockerIndex + i) % length;
            address locker = lockers[idx];
            if (lockerBatch[locker] == 0) {
                return locker;
            }
        }

        return address(0); // No free lockers
    }

    /**
     * @inheritdoc ICooldownManager
     */
    function isLockerFree(address locker) external view override returns (bool) {
        return isLocker[locker] && lockerBatch[locker] == 0;
    }

    /**
     * @inheritdoc ICooldownManager
     */
    function lockerCount() external view override returns (uint256) {
        return lockers.length;
    }

    /**
     * @notice Get batch details
     * @param batchId Batch ID to query
     * @return batch Batch struct
     */
    function getBatch(uint256 batchId) external view returns (Batch memory batch) {
        return batches[batchId];
    }
}
