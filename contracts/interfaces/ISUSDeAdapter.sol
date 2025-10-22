// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ISUSDeAdapter
 * @notice Interface for sUSDe staking protocol adapter
 * @dev Encapsulates integration with sUSDe unstaking mechanism
 */
interface ISUSDeAdapter {
    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event UnstakeRequested(
        address indexed locker,
        bytes32 indexed claimId,
        uint256 amountStake,
        uint256 expectedBase,
        uint64 maturityTime
    );

    event UnstakeClaimed(
        address indexed locker,
        bytes32 indexed claimId,
        address indexed receiver,
        uint256 amountReceived
    );

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get the base asset address (USDe)
     * @return Address of USDe token
     */
    function baseAsset() external view returns (address);

    /**
     * @notice Get the stake token address (sUSDe)
     * @return Address of sUSDe token
     */
    function stakeToken() external view returns (address);

    /**
     * @notice Preview unstake to get expected base amount and ETA
     * @param amountStake Amount of sUSDe to unstake
     * @return amountBase Expected USDe amount at maturity
     * @return etaSeconds Time until unstake completes (in seconds)
     */
    function previewUnstake(uint256 amountStake)
        external
        view
        returns (uint256 amountBase, uint256 etaSeconds);

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Request unstake on behalf of a locker
     * @dev Transfers sUSDe from msg.sender to locker, then requests unstake
     * @param locker Address that will hold the unstaking position
     * @param amountStake Amount of sUSDe to unstake
     * @return claimId Protocol-specific claim identifier
     * @return t1 Timestamp when unstake completes
     * @return expectedBase Expected USDe amount at maturity
     */
    function requestUnstake(address locker, uint256 amountStake)
        external
        returns (bytes32 claimId, uint64 t1, uint256 expectedBase);

    /**
     * @notice Claim matured unstake from a locker
     * @param locker Address that holds the unstaking position
     * @param claimId Protocol-specific claim identifier
     * @param receiver Address to receive the USDe
     * @return amountBaseReceived Actual USDe amount received
     */
    function claim(address locker, bytes32 claimId, address receiver)
        external
        returns (uint256 amountBaseReceived);
}
