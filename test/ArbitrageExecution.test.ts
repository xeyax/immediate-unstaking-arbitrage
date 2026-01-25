import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ArbitrageVault,
  MockERC20,
  MockStakedUSDe,
  MockDEX
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ArbitrageVault - Phase 5: Arbitrage Execution", function () {
  let vault: ArbitrageVault;
  let usde: MockERC20;
  let sUsde: MockStakedUSDe;
  let dex: MockDEX;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let user1: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days

  beforeEach(async function () {
    [owner, keeper, user1, feeRecipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usde = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usde.waitForDeployment();

    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    sUsde = await MockStakedUSDeFactory.deploy(await usde.getAddress(), COOLDOWN_PERIOD);
    await sUsde.waitForDeployment();

    // Deploy vault
    const VaultFactory = await ethers.getContractFactory("ArbitrageVault");
    vault = await VaultFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      feeRecipient.address
    );
    await vault.waitForDeployment();

    // Deploy mock DEX with 5% discount (1 USDe = 1.05 sUSDe)
    const MockDEXFactory = await ethers.getContractFactory("MockDEX");
    dex = await MockDEXFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      ethers.parseEther("1.05") // 5% discount
    );
    await dex.waitForDeployment();

    // Mint tokens
    await usde.mint(owner.address, INITIAL_SUPPLY);
    await usde.mint(user1.address, INITIAL_SUPPLY);
    await sUsde.mint(await dex.getAddress(), INITIAL_SUPPLY); // DEX liquidity
    await usde.mint(await sUsde.getAddress(), INITIAL_SUPPLY); // For unstaking

    // Setup vault
    await vault.deployProxies(5);
    await vault.addKeeper(keeper.address);

    // User1 deposits 10000 USDe for vault liquidity
    await usde.connect(user1).approve(await vault.getAddress(), ethers.parseEther("10000"));
    await vault.connect(user1).deposit(ethers.parseEther("10000"), user1.address);
  });

  describe("Successful Arbitrage Execution", function () {
    it("should execute arbitrage successfully", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045"); // Expect ~1050 with 5% discount

      // Encode swap calldata
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const tx = await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      await expect(tx).to.emit(vault, "ArbitrageExecuted");
      await expect(tx).to.emit(vault, "PositionOpened");

      // Check position was created
      expect(await vault.activePositionCount()).to.equal(1);
      expect(await vault.nextPositionId()).to.equal(1);
    });

    it("should measure bookValue correctly via balance delta", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");

      const balanceBefore = await usde.balanceOf(await vault.getAddress());
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const balanceAfter = await usde.balanceOf(await vault.getAddress());
      const actualSpent = balanceBefore - balanceAfter;

      // Verify bookValue in position matches actual spent
      const position = await vault.getPosition(0);
      expect(position.bookValue).to.equal(actualSpent);
      expect(position.bookValue).to.be.closeTo(amountIn, 1); // Within 1 wei
    });

    it("should get expectedAssets from Ethena", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");

      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const position = await vault.getPosition(0);

      // expectedAssets should come from Ethena (MockStakedUSDe returns sUsde amount * 1e18)
      // With 1050 sUSDe received, expectedAssets should be ~1050 USDe
      expect(position.expectedAssets).to.be.closeTo(
        ethers.parseEther("1050"),
        ethers.parseEther("1")
      );
    });

    it("should emit ArbitrageExecuted event with correct data", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");

      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const tx = await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "ArbitrageExecuted"
      ) as any;

      expect(event).to.not.be.undefined;
      expect(event?.args?.positionId).to.equal(0);
      expect(event?.args?.dexTarget).to.equal(await dex.getAddress());
      expect(event?.args?.usdeSpent).to.be.closeTo(amountIn, 1);
      expect(event?.args?.sUsdeReceived).to.be.closeTo(ethers.parseEther("1050"), ethers.parseEther("1"));
      expect(event?.args?.expectedProfit).to.be.gt(0);
    });

    it("should allocate proxy and initiate unstake", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");

      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const position = await vault.getPosition(0);

      // Proxy should be allocated and busy
      expect(position.proxyContract).to.not.equal(ethers.ZeroAddress);
      expect(await vault.proxyBusy(position.proxyContract)).to.be.true;
    });

    it("should update NAV correctly after arbitrage", async function () {
      const navBefore = await vault.totalAssets();

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // NAV should be approximately the same (bookValue spent, but position opened)
      const navAfter = await vault.totalAssets();
      expect(navAfter).to.be.closeTo(navBefore, ethers.parseEther("1"));
    });
  });

  describe("Input Validation", function () {
    it("should reject if not called by keeper", async function () {
      const swapCalldata = dex.interface.encodeFunctionData("swap", [
        ethers.parseEther("1000"),
        ethers.parseEther("1045")
      ]);

      await expect(
        vault.connect(user1).executeArbitrage(
          await dex.getAddress(),
          ethers.parseEther("1000"),
          ethers.parseEther("1045"),
          swapCalldata
        )
      ).to.be.revertedWith("Caller is not a keeper");
    });

    it("should reject zero DEX target", async function () {
      const swapCalldata = "0x";

      await expect(
        vault.connect(keeper).executeArbitrage(
          ethers.ZeroAddress,
          ethers.parseEther("1000"),
          ethers.parseEther("1045"),
          swapCalldata
        )
      ).to.be.revertedWith("Invalid DEX target");
    });

    it("should reject zero amountIn", async function () {
      const swapCalldata = "0x";

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          0,
          ethers.parseEther("1045"),
          swapCalldata
        )
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("should reject zero minAmountOut", async function () {
      const swapCalldata = "0x";

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          ethers.parseEther("1000"),
          0,
          swapCalldata
        )
      ).to.be.revertedWith("Min amount out must be > 0");
    });

    it("should reject if insufficient USDe balance", async function () {
      const amountIn = ethers.parseEther("20000"); // More than vault has
      const minAmountOut = ethers.parseEther("21000");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Insufficient USDe balance");
    });

    it("should reject if no proxies available", async function () {
      // Fill all 5 proxies
      for (let i = 0; i < 5; i++) {
        const swapCalldata = dex.interface.encodeFunctionData("swap", [
          ethers.parseEther("100"),
          ethers.parseEther("105")
        ]);
        await vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          ethers.parseEther("100"),
          ethers.parseEther("105"),
          swapCalldata
        );
      }

      // Try 6th arbitrage - should fail
      const swapCalldata = dex.interface.encodeFunctionData("swap", [
        ethers.parseEther("100"),
        ethers.parseEther("105")
      ]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          ethers.parseEther("100"),
          ethers.parseEther("105"),
          swapCalldata
        )
      ).to.be.revertedWith("No proxies available");
    });

    it("should reject if no proxies deployed", async function () {
      // Deploy fresh vault WITHOUT calling deployProxies()
      const VaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const freshVault = await VaultFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress(),
        feeRecipient.address
      );
      await freshVault.waitForDeployment();

      // Mint tokens and setup
      await usde.mint(await freshVault.getAddress(), ethers.parseEther("10000"));
      await freshVault.addKeeper(keeper.address);

      const swapCalldata = dex.interface.encodeFunctionData("swap", [
        ethers.parseEther("1000"),
        ethers.parseEther("1050")
      ]);

      // Try to execute arbitrage
      await expect(
        freshVault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          ethers.parseEther("1000"),
          ethers.parseEther("1050"),
          swapCalldata
        )
      ).to.be.revertedWith("No proxies deployed");
    });
  });

  describe("Slippage Protection", function () {
    it("should reject if sUSDe received < minAmountOut (DEX reverts)", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1100"); // Too high (expecting ~1050)

      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // DEX will revert, causing executeArbitrage to revert with "Swap failed"
      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Swap failed");
    });

    it("should reject if sUSDe received < minAmountOut (vault guard)", async function () {
      // Deploy DEX that doesn't check minAmountOut (to test vault's guard)
      const MockDEXNoRevertFactory = await ethers.getContractFactory("MockDEXNoRevert");
      const dexNoRevert = await MockDEXNoRevertFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress(),
        ethers.parseEther("1.04")  // 4% profit - low rate
      );
      await dexNoRevert.waitForDeployment();

      // Mint sUSDe to DEX
      await sUsde.mint(await dexNoRevert.getAddress(), ethers.parseEther("100000"));

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1050"); // Expecting 5% profit

      const swapCalldata = dexNoRevert.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // DEX will return 1040 sUSDe (4% profit)
      // But minAmountOut is 1050 sUSDe
      // Vault's guard should catch this
      await expect(
        vault.connect(keeper).executeArbitrage(
          await dexNoRevert.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Insufficient sUSDe received (slippage)");
    });

    it("should succeed with reasonable minAmountOut", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1040"); // 4% slippage tolerance

      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.emit(vault, "ArbitrageExecuted");
    });
  });

  describe("Profit Threshold Validation", function () {
    it("should reject if profit below minimum threshold", async function () {
      // Set high profit threshold (5% = 500 basis points)
      await vault.setMinProfitThreshold(500);

      // DEX offers only 1% profit (1 USDe = 1.01 sUSDe)
      await dex.setExchangeRate(ethers.parseEther("1.01"));

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1005");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Profit below minimum threshold");
    });

    it("should accept if profit meets threshold", async function () {
      // Set profit threshold to 0.1% (default = 10 basis points)
      await vault.setMinProfitThreshold(10);

      // DEX offers 5% profit
      await dex.setExchangeRate(ethers.parseEther("1.05"));

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.emit(vault, "ArbitrageExecuted");
    });
  });

  describe("Swap Execution", function () {
    it("should revert if swap fails", async function () {
      // Make DEX fail swaps
      await dex.setShouldFail(true);

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Swap failed");
    });

    it("should handle partial USDe spend (less than amountIn)", async function () {
      // In real DEX, might spend slightly less than amountIn
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");

      const swapCalldata = dex.interface.encodeFunctionData("swap", [
        amountIn - 1n, // Spend 1 wei less
        minAmountOut
      ]);

      const tx = await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "ArbitrageExecuted"
      ) as any;

      // bookValue should be actual amount spent
      expect(event?.args?.usdeSpent).to.be.lt(amountIn);
      expect(event?.args?.usdeSpent).to.equal(amountIn - 1n);
    });
  });

  describe("Integration with Position Tracking", function () {
    it("should create position that can be claimed after cooldown", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Fast forward past cooldown
      await time.increase(COOLDOWN_PERIOD + 1);

      // Position should be claimable
      expect(await vault.isPositionClaimable(0)).to.be.true;

      // Claim position
      await expect(vault.connect(keeper).claimPosition())
        .to.emit(vault, "PositionClaimed");

      expect(await vault.activePositionCount()).to.equal(0);
    });

    it("should handle multiple sequential arbitrage executions", async function () {
      const amountIn = ethers.parseEther("500");
      const minAmountOut = ethers.parseEther("520");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // Execute 3 arbitrages
      for (let i = 0; i < 3; i++) {
        await vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        );
      }

      expect(await vault.activePositionCount()).to.equal(3);
      expect(await vault.nextPositionId()).to.equal(3);
      expect(await vault.firstActivePositionId()).to.equal(0);
    });

    it("should correctly update NAV during position lifecycle", async function () {
      const navInitial = await vault.totalAssets();

      // Execute arbitrage
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // NAV should be similar (spent USDe, but opened position with bookValue)
      const navAfterOpen = await vault.totalAssets();
      expect(navAfterOpen).to.be.closeTo(navInitial, ethers.parseEther("1"));

      // Fast forward 3.5 days (half cooldown)
      await time.increase(COOLDOWN_PERIOD / 2);

      // NAV should have increased due to accrued profit
      const navMidway = await vault.totalAssets();
      expect(navMidway).to.be.gt(navAfterOpen);

      // Fast forward remaining cooldown
      await time.increase(COOLDOWN_PERIOD / 2 + 1);

      // Claim position
      await vault.connect(keeper).claimPosition();

      // NAV should have increased by full profit
      const navFinal = await vault.totalAssets();
      expect(navFinal).to.be.gt(navInitial);
      expect(navFinal).to.be.closeTo(
        navInitial + ethers.parseEther("50"), // ~5% profit on 1000
        ethers.parseEther("5")
      );
    });
  });

  describe("Security: Allowance Management", function () {
    it("should reset allowance to 0 after swap", async function () {
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const dexAddress = await dex.getAddress();
      const vaultAddress = await vault.getAddress();

      // Allowance should be 0 before
      expect(await usde.allowance(vaultAddress, dexAddress)).to.equal(0);

      await vault.connect(keeper).executeArbitrage(
        dexAddress,
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // CRITICAL: Allowance should be 0 after swap (not accumulated!)
      expect(await usde.allowance(vaultAddress, dexAddress)).to.equal(0);
    });

    it("should not accumulate allowance over multiple arbitrages", async function () {
      const amountIn = ethers.parseEther("100");
      const minAmountOut = ethers.parseEther("105");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const dexAddress = await dex.getAddress();
      const vaultAddress = await vault.getAddress();

      // Execute 3 arbitrages
      for (let i = 0; i < 3; i++) {
        await vault.connect(keeper).executeArbitrage(
          dexAddress,
          amountIn,
          minAmountOut,
          swapCalldata
        );

        // After each arbitrage, allowance should be 0
        expect(await usde.allowance(vaultAddress, dexAddress)).to.equal(0);
      }
    });

    it("should prevent malicious keeper from retaining allowance", async function () {
      // Scenario: Malicious keeper uses their own "DEX" to get allowance
      // After executeArbitrage completes, they should NOT be able to steal funds

      const amountIn = ethers.parseEther("100");
      const minAmountOut = ethers.parseEther("105");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const dexAddress = await dex.getAddress();
      const vaultAddress = await vault.getAddress();

      await vault.connect(keeper).executeArbitrage(
        dexAddress,
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // CRITICAL: Allowance should be 0 after swap
      const allowance = await usde.allowance(vaultAddress, dexAddress);
      expect(allowance).to.equal(0);

      // Verify DEX cannot steal funds via transferFrom
      // Give DEX some ETH and impersonate it
      await ethers.provider.send("hardhat_setBalance", [dexAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [dexAddress]);
      const dexSigner = await ethers.getSigner(dexAddress);

      // DEX should NOT be able to call transferFrom (allowance is 0)
      await expect(
        usde.connect(dexSigner).transferFrom(
          vaultAddress,
          keeper.address,
          ethers.parseEther("1")
        )
      ).to.be.revertedWithCustomError(usde, "ERC20InsufficientAllowance");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [dexAddress]);
    });
  });

  describe("Edge Cases", function () {
    it("should reject if USDe balance doesn't decrease after swap (using MockMaliciousDEX)", async function () {
      // Test the guard: balanceAfter >= balanceBefore (balance increased or stayed same)
      // Uses MockMaliciousDEX in IncreaseBalance mode: returns USDe to caller

      const MaliciousDEXFactory = await ethers.getContractFactory("MockMaliciousDEX");
      const maliciousDex = await MaliciousDEXFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress()
      );
      await maliciousDex.waitForDeployment();

      // Set to IncreaseBalance mode: takes USDe but then returns MORE than amountIn
      await maliciousDex.setAttackMode(1); // AttackMode.IncreaseBalance

      // Fund malicious DEX with tokens
      await usde.mint(await maliciousDex.getAddress(), ethers.parseEther("10000"));
      await sUsde.mint(await maliciousDex.getAddress(), ethers.parseEther("10000"));

      const amountIn = ethers.parseEther("1000");
      const amountOut = ethers.parseEther("1050");
      const swapCalldata = maliciousDex.interface.encodeFunctionData("swap", [amountIn, amountOut]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await maliciousDex.getAddress(),
          amountIn,
          amountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Balance increased after swap");
    });

    it("should reject if no sUSDe received", async function () {
      // Set DEX rate to 0 (no sUSDe output)
      await dex.setExchangeRate(0);

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = 1; // Even 1 wei
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // DEX will revert with "insufficient output amount", causing "Swap failed"
      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Swap failed");
    });

    it("should reject if no sUSDe received from swap (guard test)", async function () {
      // Deploy malicious DEX that accepts USDe but gives 0 sUSDe
      const MaliciousDEXFactory = await ethers.getContractFactory("MockDEX");
      const maliciousDex = await MaliciousDEXFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress(),
        0  // exchangeRate = 0 (gives 0 sUSDe output)
      );
      await maliciousDex.waitForDeployment();

      const amountIn = ethers.parseEther("1000");
      const swapCalldata = maliciousDex.interface.encodeFunctionData("swap", [
        amountIn,
        0  // DEX expects minAmountOut in calldata
      ]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await maliciousDex.getAddress(),
          amountIn,
          1,  // minAmountOut = 1 wei (must be > 0 to pass input validation)
          swapCalldata
        )
      ).to.be.revertedWith("No sUSDe received from swap");
    });

    it("should reject if USDe balance increases after swap (malicious DEX)", async function () {
      // Deploy malicious DEX that returns USDe instead of taking it
      const MaliciousDEXFactory = await ethers.getContractFactory("MockMaliciousDEX");
      const maliciousDex = await MaliciousDEXFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress()
      );
      await maliciousDex.waitForDeployment();

      // Set attack mode to return USDe (increase balance)
      await maliciousDex.setAttackMode(1); // IncreaseBalance

      // Mint tokens to malicious DEX
      await usde.mint(await maliciousDex.getAddress(), ethers.parseEther("10000"));
      await sUsde.mint(await maliciousDex.getAddress(), ethers.parseEther("10000"));

      const amountIn = ethers.parseEther("1000");
      const amountOut = ethers.parseEther("1050");
      const swapCalldata = maliciousDex.interface.encodeFunctionData("swap", [
        amountIn,
        amountOut
      ]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await maliciousDex.getAddress(),
          amountIn,
          amountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Balance increased after swap");
    });

    it("should reject if no USDe was spent (malicious DEX doesn't take payment)", async function () {
      // Deploy malicious DEX that returns sUSDe but doesn't take USDe
      const MaliciousDEXFactory = await ethers.getContractFactory("MockDEXNoSpend");
      const maliciousDex = await MaliciousDEXFactory.deploy(
        await usde.getAddress(),
        await sUsde.getAddress()
      );
      await maliciousDex.waitForDeployment();

      // Mint sUSDe to malicious DEX
      await sUsde.mint(await maliciousDex.getAddress(), ethers.parseEther("10000"));

      const amountIn = ethers.parseEther("1000");
      const amountOut = ethers.parseEther("1050");
      const swapCalldata = maliciousDex.interface.encodeFunctionData("swap", [
        amountIn,
        amountOut
      ]);

      await expect(
        vault.connect(keeper).executeArbitrage(
          await maliciousDex.getAddress(),
          amountIn,
          amountOut,
          swapCalldata
        )
      ).to.be.revertedWith("No USDe was spent");
    });

    // NOTE: "Spent more than amountIn" guard is unreachable in current implementation
    // because vault sets allowance = amountIn (line 962), so DEX cannot take more
    // The guard exists as a safety check for future code changes
    // If this becomes reachable, add test here
  });

  describe("Security: Donation Attack Prevention", function () {
    it("should measure sUSDe delta, not absolute balance (prevents donation attack)", async function () {
      // ATTACK SCENARIO:
      // 1. Attacker donates sUSDe to vault before keeper's swap
      // 2. Keeper executes bad swap that returns very little sUSDe
      // 3. WITHOUT FIX: sUsdeReceived = totalBalance (inflated by donation)
      // 4. WITH FIX: sUsdeReceived = delta only (donation ignored)

      const donationAmount = ethers.parseEther("1000");
      const vaultAddress = await vault.getAddress();

      // Step 1: Attacker donates sUSDe directly to vault
      await sUsde.mint(vaultAddress, donationAmount);

      // Verify donation is there
      const sUsdeBalanceBefore = await sUsde.balanceOf(vaultAddress);
      expect(sUsdeBalanceBefore).to.equal(donationAmount);

      // Step 2: Execute normal arbitrage
      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1045");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      const tx = await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Step 3: Verify sUsdeReceived is only the swap delta, NOT total balance
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "ArbitrageExecuted"
      ) as any;

      // With 5% discount: 1000 USDe → ~1050 sUSDe
      const sUsdeFromSwap = event?.args?.sUsdeReceived;

      // CRITICAL: sUsdeReceived should be ~1050, NOT 1050 + 1000 (donation)
      expect(sUsdeFromSwap).to.be.closeTo(ethers.parseEther("1050"), ethers.parseEther("5"));
      expect(sUsdeFromSwap).to.be.lt(donationAmount + ethers.parseEther("1050"));
    });

    it("should reject swap that returns no sUSDe even with pre-existing balance", async function () {
      // ATTACK SCENARIO:
      // 1. Attacker donates large amount of sUSDe to vault
      // 2. Keeper executes EMPTY swap (returns 0 sUSDe)
      // 3. WITHOUT FIX: Would pass because totalBalance > minAmountOut
      // 4. WITH FIX: Fails because delta = 0

      const donationAmount = ethers.parseEther("5000");
      const vaultAddress = await vault.getAddress();

      // Step 1: Large donation
      await sUsde.mint(vaultAddress, donationAmount);

      // Step 2: Set DEX to return 0 sUSDe
      await dex.setExchangeRate(0);

      const amountIn = ethers.parseEther("100");
      const minAmountOut = 1; // Very low threshold
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // Step 3: Should fail because delta = 0 (regardless of donation)
      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.reverted; // Will revert with "Swap failed" or "No sUSDe received from swap"
    });

    it("should correctly record position with actual swap amount, not inflated balance", async function () {
      // Verify position tracking uses delta, not absolute balance

      const donationAmount = ethers.parseEther("2000");
      const vaultAddress = await vault.getAddress();

      // Donate sUSDe to vault
      await sUsde.mint(vaultAddress, donationAmount);

      // Execute arbitrage
      const amountIn = ethers.parseEther("500");
      const minAmountOut = ethers.parseEther("520");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Check position
      const position = await vault.getPosition(0);

      // sUsdeAmount should be ~525 (5% discount on 500), NOT 2525 (donation + swap)
      expect(position.sUsdeAmount).to.be.closeTo(ethers.parseEther("525"), ethers.parseEther("5"));
      expect(position.sUsdeAmount).to.be.lt(donationAmount);
    });

    it("should not allow unprofitable swap to pass validation via donation", async function () {
      // ATTACK SCENARIO:
      // 1. Attacker donates sUSDe to inflate apparent profit
      // 2. Keeper executes UNPROFITABLE swap
      // 3. WITHOUT FIX: expectedAssets calculated from inflated sUsdeReceived → profit check passes
      // 4. WITH FIX: expectedAssets based on actual swap delta → profit check fails

      const donationAmount = ethers.parseEther("10000");
      const vaultAddress = await vault.getAddress();

      // Step 1: Large donation
      await sUsde.mint(vaultAddress, donationAmount);

      // Step 2: Set high profit threshold
      await vault.setMinProfitThreshold(500); // 5%

      // Step 3: Set DEX to very bad rate (0.5% profit only)
      await dex.setExchangeRate(ethers.parseEther("1.005"));

      const amountIn = ethers.parseEther("1000");
      const minAmountOut = ethers.parseEther("1000"); // Low threshold to not fail on slippage
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // Step 4: Should fail profit threshold because delta gives only 0.5% profit
      await expect(
        vault.connect(keeper).executeArbitrage(
          await dex.getAddress(),
          amountIn,
          minAmountOut,
          swapCalldata
        )
      ).to.be.revertedWith("Profit below minimum threshold");
    });
  });
});
