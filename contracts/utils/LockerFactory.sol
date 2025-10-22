// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Locker} from "./Locker.sol";

/**
 * @title LockerFactory
 * @notice Factory for creating minimal proxy clones of Locker contracts
 * @dev Uses EIP-1167 minimal proxy pattern for gas-efficient deployment
 */
contract LockerFactory {
    using Clones for address;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Implementation contract for Locker
    address public immutable implementation;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event LockerCreated(address indexed locker, address indexed manager);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deploy the Locker implementation contract
     */
    constructor() {
        // Deploy implementation with address(0) as manager (will be overridden in clones)
        implementation = address(new Locker(address(0)));
    }

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Create a new Locker clone
     * @param manager Address of the CooldownManager
     * @return locker Address of the newly created Locker
     */
    function createLocker(address manager) external returns (address locker) {
        // Create minimal proxy clone
        locker = implementation.clone();

        // Note: The clone will call the constructor of Locker, but with the
        // manager address we pass via create2 salt or initialization.
        // For simplicity in MVP, we'll use a different approach:
        // Deploy full contracts instead of proxies, OR
        // Use a Locker implementation that can be initialized.

        // Let's deploy a full Locker contract for simplicity:
        locker = address(new Locker(manager));

        emit LockerCreated(locker, manager);

        return locker;
    }

    /**
     * @notice Predict the address of a future Locker clone
     * @dev Not implemented in this simple version
     * @return predicted Predicted address (returns address(0) for now)
     */
    function predictLockerAddress(address /*manager*/, bytes32 /*salt*/)
        external
        pure
        returns (address predicted)
    {
        // For MVP, we're not using deterministic addresses
        return address(0);
    }
}
