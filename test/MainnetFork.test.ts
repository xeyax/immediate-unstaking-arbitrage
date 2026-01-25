import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const describeFork = process.env.FORK ? describe : describe.skip;

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
