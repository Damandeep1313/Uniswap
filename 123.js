require('dotenv').config();
const { ethers } = require('ethers');

// Ensure environment variables are set
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Please set RPC_URL and PRIVATE_KEY in .env");
  process.exit(1);
}

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Addresses and ABI
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)"
];

async function main() {
  // Create contract instance
  const daiContract = new ethers.Contract(DAI_ADDRESS, ERC20_ABI, wallet);

  // Amount to approve: 1000 DAI (use a large number if you want a one-time approval)
  const amountToApprove = ethers.utils.parseEther("3.85");

  console.log(`Approving Uniswap V3 Router to spend ${ethers.utils.formatUnits(amountToApprove, 18)} DAI...`);

  // Send approve transaction
  const approveTx = await daiContract.approve(UNISWAP_V3_ROUTER_ADDRESS, amountToApprove);
  console.log("Approval transaction sent:", approveTx.hash);

  // Wait for transaction confirmation
  const receipt = await approveTx.wait();
  console.log("Approval confirmed in block:", receipt.blockNumber);

  console.log("Approved router to spend DAI!");
}

main().catch((error) => {
  console.error("Error approving DAI:", error);
  process.exit(1);
});
