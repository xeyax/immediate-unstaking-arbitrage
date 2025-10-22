// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Vault} from "../contracts/core/Vault.sol";
import {CooldownManager} from "../contracts/core/CooldownManager.sol";
import {SUSDeAdapter} from "../contracts/adapters/SUSDeAdapter.sol";
import {LockerFactory} from "../contracts/utils/LockerFactory.sol";
import {Locker} from "../contracts/utils/Locker.sol";

/**
 * @title DeployVault
 * @notice Deployment script for sUSDe arbitrage vault system
 * @dev Deploy order: Adapter → CooldownManager → Lockers → Vault
 */
contract DeployVault is Script {
    // Ethereum Mainnet addresses
    address constant USDE = 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3;
    address constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;

    // Configuration
    uint256 constant INITIAL_LOCKER_COUNT = 5;
    string constant VAULT_NAME = "Arbitrage Vault sUSDe";
    string constant VAULT_SYMBOL = "avSUSDe";

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying from:", deployer);
        console2.log("USDe:", USDE);
        console2.log("sUSDe:", SUSDE);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy SUSDeAdapter
        console2.log("\n1. Deploying SUSDeAdapter...");
        SUSDeAdapter adapter = new SUSDeAdapter(
            USDE,
            SUSDE,
            address(0) // Will set CooldownManager later
        );
        console2.log("SUSDeAdapter deployed at:", address(adapter));

        // 2. Deploy CooldownManager
        console2.log("\n2. Deploying CooldownManager...");
        CooldownManager cooldownManager = new CooldownManager(
            address(adapter),
            deployer // Admin
        );
        console2.log("CooldownManager deployed at:", address(cooldownManager));

        // Note: Need to redeploy adapter with correct cooldownManager address
        // or use a setter pattern. For simplicity, redeploying:
        console2.log("\n2a. Redeploying SUSDeAdapter with correct CooldownManager...");
        adapter = new SUSDeAdapter(
            USDE,
            SUSDE,
            address(cooldownManager)
        );
        console2.log("SUSDeAdapter redeployed at:", address(adapter));

        // 3. Redeploy CooldownManager with correct adapter
        console2.log("\n3. Redeploying CooldownManager with correct adapter...");
        cooldownManager = new CooldownManager(
            address(adapter),
            deployer
        );
        console2.log("CooldownManager redeployed at:", address(cooldownManager));

        // 4. Deploy Vault
        console2.log("\n4. Deploying Vault...");
        Vault vault = new Vault(
            USDE,
            VAULT_NAME,
            VAULT_SYMBOL,
            address(cooldownManager),
            address(adapter),
            deployer // Admin and keeper
        );
        console2.log("Vault deployed at:", address(vault));

        // 5. Grant VAULT_ROLE to Vault in CooldownManager
        console2.log("\n5. Granting VAULT_ROLE to Vault...");
        bytes32 VAULT_ROLE = keccak256("VAULT_ROLE");
        cooldownManager.grantRole(VAULT_ROLE, address(vault));
        console2.log("VAULT_ROLE granted");

        // 6. Deploy LockerFactory
        console2.log("\n6. Deploying LockerFactory...");
        LockerFactory lockerFactory = new LockerFactory();
        console2.log("LockerFactory deployed at:", address(lockerFactory));

        // 7. Create initial lockers
        console2.log("\n7. Creating initial lockers...");
        address[] memory lockerAddresses = new address[](INITIAL_LOCKER_COUNT);

        for (uint256 i = 0; i < INITIAL_LOCKER_COUNT; i++) {
            address locker = lockerFactory.createLocker(address(cooldownManager));
            lockerAddresses[i] = locker;
            console2.log("Locker", i + 1, "deployed at:", locker);

            // Add locker to CooldownManager
            cooldownManager.addLocker(locker);
            console2.log("Locker", i + 1, "added to CooldownManager");
        }

        // 8. Configuration summary
        console2.log("\n=== Deployment Summary ===");
        console2.log("Deployer:", deployer);
        console2.log("SUSDeAdapter:", address(adapter));
        console2.log("CooldownManager:", address(cooldownManager));
        console2.log("Vault:", address(vault));
        console2.log("LockerFactory:", address(lockerFactory));
        console2.log("Lockers created:", INITIAL_LOCKER_COUNT);

        console2.log("\n=== Next Steps ===");
        console2.log("1. Whitelist DEX routers in Vault:");
        console2.log("   vault.setRouterWhitelist(ROUTER_ADDRESS, true)");
        console2.log("\n2. Update parameters if needed:");
        console2.log("   vault.setParameters(minProfitBps, maxUnstakeTime, depositCap, perfFeeBps)");
        console2.log("\n3. Grant additional KEEPER roles if needed:");
        console2.log("   vault.grantRole(KEEPER_ROLE, KEEPER_ADDRESS)");

        vm.stopBroadcast();

        // Save deployment addresses to file
        string memory deploymentInfo = string.concat(
            "VAULT_ADDRESS=", vm.toString(address(vault)), "\n",
            "COOLDOWN_MANAGER_ADDRESS=", vm.toString(address(cooldownManager)), "\n",
            "ADAPTER_ADDRESS=", vm.toString(address(adapter)), "\n",
            "LOCKER_FACTORY_ADDRESS=", vm.toString(address(lockerFactory)), "\n"
        );

        vm.writeFile(".env.deployment", deploymentInfo);
        console2.log("\nDeployment addresses saved to .env.deployment");
    }
}
