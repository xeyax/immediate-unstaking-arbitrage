// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Counter} from "../contracts/Counter.sol";

/**
 * @title Deploy Script
 * @notice Deployment script for the Counter contract
 * @dev Run with: forge script script/Deploy.s.sol:DeployScript --rpc-url <your_rpc_url> --broadcast --verify
 */
contract DeployScript is Script {
    function run() public returns (Counter) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);
        
        Counter counter = new Counter();
        console.log("Counter deployed at:", address(counter));
        
        vm.stopBroadcast();
        
        return counter;
    }
}

