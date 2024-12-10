require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load Router ABI
const routerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3RouterABI.json'), 'utf8'));

// Quoter ABI inline
const quoterAbi = [
    {
        "inputs": [
            {"internalType":"address","name":"tokenIn","type":"address"},
            {"internalType":"address","name":"tokenOut","type":"address"},
            {"internalType":"uint24","name":"fee","type":"uint24"},
            {"internalType":"uint256","name":"amountIn","type":"uint256"},
            {"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}
        ],
        "name":"quoteExactInputSingle",
        "outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],
        "stateMutability":"view",
        "type":"function"
    }
];

// Environment variables
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Please set RPC_URL and PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Uniswap V3 Addresses
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// Token Addresses (Mainnet)
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const fee = 3000; // 0.3% fee tier

// Swap parameters
// Example: 0.0005 ETH (adjust as desired)
const amountInETH = "0.0005";
const amountInWei = ethers.utils.parseEther(amountInETH);

// Slippage tolerance of 1% (0.01)
const SLIPPAGE_TOLERANCE = 0.01;

const recipient = wallet.address;
const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

async function main() {
  console.log(`Getting a quote for swapping ${amountInETH} ETH to DAI...`);

  // Create Quoter Contract
  const quoterContract = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);

  // Get a quote for how much DAI we'd get for that amount of ETH (actually WETH inside the router)
  const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle(
    WETH_ADDRESS,
    DAI_ADDRESS,
    fee,
    amountInWei,
    0
  );

  const quotedDAI = ethers.utils.formatUnits(quotedAmountOut, 18);
  console.log(`Quoted output: ${quotedDAI} DAI for ${amountInETH} ETH`);

  // Apply slippage tolerance. For a 1% tolerance:
  // amountOutMinimum = quotedAmountOut * (1 - 0.01) = quotedAmountOut * 0.99
  const amountOutMinimum = quotedAmountOut.mul(100 - (SLIPPAGE_TOLERANCE * 100)).div(100);
  const minDAI = ethers.utils.formatUnits(amountOutMinimum, 18);

  console.log(`Minimum acceptable output after 1% slippage: ${minDAI} DAI`);

  // Initialize Router Contract
  const routerContract = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);

  // Set swap parameters
  const params = {
    tokenIn: WETH_ADDRESS,
    tokenOut: DAI_ADDRESS,
    fee: fee,
    recipient: recipient,
    deadline: deadline,
    amountIn: amountInWei,
    amountOutMinimum: amountOutMinimum,
    sqrtPriceLimitX96: 0
  };

  console.log("Executing the swap with slippage protection...");
  const swapTx = await routerContract.exactInputSingle(params, {
    value: amountInWei, // Send ETH
    // gasLimit: 500000
  });

  console.log("Swap transaction sent. Waiting for confirmation...");
  const receipt = await swapTx.wait();
  
  console.log("Swap transaction confirmed!");
  console.log("Transaction hash:", receipt.transactionHash);
  console.log(`Check your DAI balance at address: ${recipient}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
