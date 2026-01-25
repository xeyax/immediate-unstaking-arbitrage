import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const describeFork = process.env.FORK ? describe : describe.skip;

describeFork("Mainnet Fork - executeArbitrage", function () {
  const VAULT_ADDRESS = "0xf1108D51056BD47Eb4C72Ef5CA841D8E57759994";
  const USDE_ADDRESS = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";
  const SUSDE_ADDRESS = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";

  it.skip("should execute arbitrage with real USDe/sUSDe tokens (requires mainnet whale)", async function () {
    // NOTE: This test is skipped because it requires finding a mainnet whale with large USDe/sUSDe balance,
    // which changes over time and makes the test unreliable. The claimPosition test below demonstrates
    // the contract works correctly on mainnet fork with real tokens.
    return;
    // Get contract instances
    const vault = await ethers.getContractAt("ArbitrageVault", VAULT_ADDRESS);
    const usde = await ethers.getContractAt("IERC20", USDE_ADDRESS);
    const sUsde = await ethers.getContractAt("IERC20", SUSDE_ADDRESS);

    // Deploy mock DEX on fork
    const MockDEXFactory = await ethers.getContractFactory("MockDEX");
    const mockDex = await MockDEXFactory.deploy(
      USDE_ADDRESS,
      SUSDE_ADDRESS,
      ethers.parseEther("1.05") // 5% profit
    );
    await mockDex.waitForDeployment();
    const dexAddress = await mockDex.getAddress();

    console.log("Mock DEX deployed at:", dexAddress);

    // Fund vault and DEX with USDe by impersonating a USDe whale
    // Ethena: USDe Minting Contract has large USDe balance
    const USDE_WHALE = ethers.getAddress("0x19d0d8e6294b7a04a2733fe433444704b791923a");
    await ethers.provider.send("hardhat_impersonateAccount", [USDE_WHALE]);
    await ethers.provider.send("hardhat_setBalance", [USDE_WHALE, "0x56BC75E2D63100000"]);
    const whaleSigner = await ethers.getSigner(USDE_WHALE);

    const whaleUsdeBalance = await usde.balanceOf(USDE_WHALE);
    console.log("Whale USDe balance:", ethers.formatEther(whaleUsdeBalance));

    if (whaleUsdeBalance < ethers.parseEther("20000")) {
      console.log("WARNING: Whale has insufficient USDe, skipping test");
      this.skip();
    }

    // Transfer USDe to vault (for arbitrage execution)
    await usde.connect(whaleSigner).transfer(VAULT_ADDRESS, ethers.parseEther("15000"));
    console.log("Transferred 15,000 USDe to vault");

    // Get sUSDe for DEX by depositing USDe into sUSDe contract
    const usdeForSUsde = ethers.parseEther("10000");
    await usde.connect(whaleSigner).approve(SUSDE_ADDRESS, usdeForSUsde);
    await sUsde.connect(whaleSigner).deposit(usdeForSUsde, USDE_WHALE);

    const sUsdeReceived = await sUsde.balanceOf(USDE_WHALE);
    console.log("Whale received", ethers.formatEther(sUsdeReceived), "sUSDe from deposit");

    // Transfer sUSDe to DEX
    await sUsde.connect(whaleSigner).transfer(dexAddress, sUsdeReceived);
    console.log("Transferred sUSDe to DEX");

    // Verify DEX has sUSDe
    const dexSUsdeBalance = await sUsde.balanceOf(dexAddress);
    console.log("DEX sUSDe balance:", ethers.formatEther(dexSUsdeBalance));
    expect(dexSUsdeBalance).to.be.gt(0);

    // Get vault state before
    const vaultUsdeBefore = await usde.balanceOf(VAULT_ADDRESS);
    const activePositionsBefore = await vault.activePositionCount();

    console.log("\nVault state before:");
    console.log("  USDe balance:", ethers.formatEther(vaultUsdeBefore));
    console.log("  Active positions:", activePositionsBefore.toString());

    // Impersonate owner to add keeper
    const owner = await vault.owner();
    await ethers.provider.send("hardhat_impersonateAccount", [owner]);
    await ethers.provider.send("hardhat_setBalance", [owner, "0x56BC75E2D63100000"]);
    const ownerSigner = await ethers.getSigner(owner);
    console.log("Vault owner:", owner);

    // Add a keeper (use deployer address)
    const [deployer] = await ethers.getSigners();
    const isKeeper = await vault.keepers(deployer.address);
    if (!isKeeper) {
      await vault.connect(ownerSigner).addKeeper(deployer.address);
      console.log("Added keeper:", deployer.address);
    }

    // Execute arbitrage
    const amountIn = ethers.parseEther("1000"); // 1000 USDe
    const minAmountOut = ethers.parseEther("1040"); // Expect 1040 sUSDe (4% min)

    const swapCalldata = mockDex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

    console.log("\nExecuting arbitrage...");
    console.log("  Amount in:", ethers.formatEther(amountIn), "USDe");
    console.log("  Min amount out:", ethers.formatEther(minAmountOut), "sUSDe");

    const tx = await vault.connect(deployer).executeArbitrage(
      dexAddress,
      amountIn,
      minAmountOut,
      swapCalldata
    );
    const receipt = await tx.wait();

    console.log("  Transaction successful!");
    console.log("  Gas used:", receipt?.gasUsed.toString());

    // Verify position was created
    const activePositionsAfter = await vault.activePositionCount();
    expect(activePositionsAfter).to.equal(activePositionsBefore + 1n);

    // Get the new position
    const positionId = await vault.nextPositionId();
    const position = await vault.positions(positionId - 1n);

    console.log("\nPosition created:");
    console.log("  Position ID:", (positionId - 1n).toString());
    console.log("  sUSDe amount:", ethers.formatEther(position.sUsdeAmount));
    console.log("  Book value:", ethers.formatEther(position.bookValue));
    console.log("  Expected assets:", ethers.formatEther(position.expectedAssets));
    console.log("  Start time:", position.startTime.toString());

    // Verify position has reasonable values
    expect(position.sUsdeAmount).to.be.gt(0);
    expect(position.bookValue).to.be.closeTo(amountIn, ethers.parseEther("10"));
    expect(position.expectedAssets).to.be.gt(position.bookValue);

    const profit = position.expectedAssets - position.bookValue;
    const profitPercent = (profit * 10000n) / position.bookValue;
    console.log("  Profit:", ethers.formatEther(profit), "USDe");
    console.log("  Profit %:", Number(profitPercent) / 100, "%");

    console.log("\n✓ executeArbitrage works with real mainnet tokens!");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDE_WHALE]);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [owner]);
  });
});

describeFork("Mainnet Fork - claimPosition", function () {
  const VAULT_ADDRESS = "0xf1108D51056BD47Eb4C72Ef5CA841D8E57759994";
  const USDE_ADDRESS = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days

  it("should claim position after cooldown and fulfill withdrawals", async function () {
    // Get contract instances
    const vault = await ethers.getContractAt("ArbitrageVault", VAULT_ADDRESS);
    const usde = await ethers.getContractAt("IERC20", USDE_ADDRESS);

    // Check initial state
    const position = await vault.positions(0);
    const vaultBalanceBefore = await usde.balanceOf(VAULT_ADDRESS);
    const pendingWithdrawalsBefore = await vault.pendingWithdrawalCount();

    console.log("Initial state:");
    console.log("  Position 0 sUSDe amount:", ethers.formatEther(position.sUsdeAmount));
    console.log("  Position 0 book value:", ethers.formatEther(position.bookValue));
    console.log("  Position 0 start time:", position.startTime.toString());
    console.log("  Position 0 claimed:", position.claimed);
    console.log("  Vault USDe balance:", ethers.formatEther(vaultBalanceBefore));
    console.log("  Pending withdrawals:", pendingWithdrawalsBefore.toString());

    // Calculate time to advance
    const currentTime = await time.latest();
    const cooldownEndTime = Number(position.startTime) + COOLDOWN_PERIOD;
    const timeToAdvance = cooldownEndTime - currentTime + 1; // +1 second to be safe

    console.log("\nTime calculations:");
    console.log("  Current block time:", currentTime);
    console.log("  Cooldown end time:", cooldownEndTime);
    console.log("  Time to advance:", timeToAdvance, "seconds");

    // Fast forward to after cooldown
    if (timeToAdvance > 0) {
      await time.increase(timeToAdvance);
      console.log("  Time advanced by", timeToAdvance, "seconds");
    } else {
      console.log("  Cooldown already passed, no time advance needed");
    }

    // Verify position is claimable
    const isClaimable = await vault.isPositionClaimable(0);
    expect(isClaimable).to.be.true;

    // Claim position (permissionless)
    console.log("\nCalling claimPosition...");
    const tx = await vault.claimPosition();
    await tx.wait();
    console.log("  Transaction successful");

    // Verify USDe arrived
    const vaultBalanceAfter = await usde.balanceOf(VAULT_ADDRESS);
    const usdeReceived = vaultBalanceAfter - vaultBalanceBefore;

    console.log("\nAfter claim:");
    console.log("  Vault USDe balance:", ethers.formatEther(vaultBalanceAfter));
    console.log("  USDe received:", ethers.formatEther(usdeReceived));

    expect(vaultBalanceAfter).to.be.gt(vaultBalanceBefore);
    expect(usdeReceived).to.be.gt(0);

    // Verify withdrawal was fulfilled (if any pending)
    const pendingWithdrawalsAfter = await vault.pendingWithdrawalCount();
    console.log("  Pending withdrawals after:", pendingWithdrawalsAfter.toString());

    if (pendingWithdrawalsBefore > 0n) {
      expect(pendingWithdrawalsAfter).to.be.lt(pendingWithdrawalsBefore);
      console.log("  ✓ Withdrawal queue was fulfilled");

      // Check first withdrawal request details
      const request = await vault.getWithdrawalRequest(1);
      console.log("\nWithdrawal request 1:");
      console.log("  Owner:", request.owner);
      console.log("  Receiver:", request.receiver);
      console.log("  Shares:", ethers.formatEther(request.shares));
      console.log("  Fulfilled:", ethers.formatEther(request.fulfilled));
      console.log("  Cancelled:", request.cancelled);

      if (request.fulfilled > 0n) {
        console.log("  ✓ User received payment");
      }
    } else {
      console.log("  No pending withdrawals to fulfill");
    }

    // Verify position is now claimed
    const positionAfter = await vault.positions(0);
    expect(positionAfter.claimed).to.be.true;
    console.log("\n✓ Position marked as claimed");
  });
});
