require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const routerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3RouterABI.json'), 'utf8'));

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

// Env variables
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Please set RPC_URL and PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Uniswap addresses
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// Load token mapping keyed by address
const tokenMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapping.json'), 'utf8'));

// Fee tiers to try (sorted by cost)
const feeTiers = [500, 3000, 10000];
const BASE_SLIPPAGE = 0.005; // 0.5% base slippage
const MAX_SLIPPAGE = 0.03; // 3% max slippage
const deadline = Math.floor(Date.now() / 1000) + 300; // 5-minute deadline

/**
 * Parse user query: "swap 1 eth with niox"
 * Returns { amountIn: '1', tokenIn: 'eth', tokenOut: 'niox' }
 */
function parseUserQuery(query) {
  const parts = query.toLowerCase().split(' ');
  if (parts.length !== 5 || parts[0] !== 'swap' || parts[3] !== 'with') {
    throw new Error("Query format should be: 'swap <amount> <tokenIn> with <tokenOut>'");
  }
  return { amountIn: parts[1], tokenIn: parts[2], tokenOut: parts[4] };
}

/**
 * Given a token string (user input), find matching address by name or symbol.
 * @param {string} tokenStr User input token string (e.g. "niox" or "autonio")
 * @returns {string} The token address
 */
function findTokenAddress(tokenStr) {
  const t = tokenStr.toLowerCase();
  for (const [address, info] of Object.entries(tokenMap)) {
    const nameMatch = info.name.toLowerCase() === t;
    const symbolMatch = info.symbol.toLowerCase() === t;
    if (nameMatch || symbolMatch) {
      return address;
    }
  }
  throw new Error(`Could not find a token with name or symbol matching "${tokenStr}" in mapping.json`);
}

/**
 * Calculates slippage dynamically based on token volatility and user-defined limits.
 * @param {string} tokenIn Input token
 * @param {string} tokenOut Output token
 * @returns {number} Slippage tolerance
 */
function calculateSlippage(tokenIn, tokenOut) {
  if (tokenIn === 'weth' && tokenOut === 'usdt') {
    // Stablecoin pair
    return BASE_SLIPPAGE; // Minimal slippage
  } else if (tokenIn === 'weth' || tokenOut === 'weth') {
    // Volatile token pair
    return Math.min(BASE_SLIPPAGE * 2, MAX_SLIPPAGE); // Adjust for volatility
  } else {
    // Exotic pair
    return MAX_SLIPPAGE; // Higher slippage for illiquid pairs
  }
}

/**
 * Gets a quote for swapping tokens for the best available fee tier.
 * @param {string} tokenInAddress Address of the input token
 * @param {string} tokenOutAddress Address of the output token
 * @param {string} amountInWei Amount of input token in wei
 * @returns {Object} Quote details: { fee, amountOut }
 */
async function getBestQuote(tokenInAddress, tokenOutAddress, amountInWei) {
  const quoterContract = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);
  for (let fee of feeTiers) {
    try {
      const amountOut = await quoterContract.callStatic.quoteExactInputSingle(
        tokenInAddress,
        tokenOutAddress,
        fee,
        amountInWei,
        0
      );
      console.log(`Fee tier ${fee} gives output: ${ethers.utils.formatUnits(amountOut, 18)}`);
      return { fee, amountOut };
    } catch (err) {
      console.log(`Fee tier ${fee} failed: ${err.message}`);
    }
  }
  throw new Error("No valid pools available for this token pair.");
}

async function main() {
  const userQuery = "swap 0.0005 WETH with BNB"; // Example query
  const { amountIn, tokenIn, tokenOut } = parseUserQuery(userQuery);

  // Find addresses
  const tokenInAddress = findTokenAddress(tokenIn);
  const tokenOutAddress = findTokenAddress(tokenOut);

  console.log(`TokenIn (${tokenIn.toUpperCase()}): ${tokenInAddress}`);
  console.log(`TokenOut (${tokenOut.toUpperCase()}): ${tokenOutAddress}`);

  const amountInWei = ethers.utils.parseEther(amountIn);

  const wethContract = new ethers.Contract(tokenInAddress, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) public returns (bool)"
  ], wallet);

  const balance = await wethContract.balanceOf(wallet.address);
  console.log(`Balance: ${ethers.utils.formatEther(balance)} ${tokenIn.toUpperCase()}`);
  if (balance.lt(amountInWei)) throw new Error("Insufficient token balance.");

  const allowance = await wethContract.allowance(wallet.address, UNISWAP_V3_ROUTER_ADDRESS);
  console.log(`Allowance: ${ethers.utils.formatEther(allowance)}`);
  if (allowance.lt(amountInWei)) {
    console.log("Insufficient allowance. Approving...");
    const approveTx = await wethContract.approve(UNISWAP_V3_ROUTER_ADDRESS, ethers.constants.MaxUint256);
    await approveTx.wait();
    console.log("Approval complete.");
  }

  console.log(`Finding the best quote for swapping ${amountIn} ${tokenIn.toUpperCase()} to ${tokenOut.toUpperCase()}...`);

  const { fee, amountOut } = await getBestQuote(tokenInAddress, tokenOutAddress, amountInWei);
  const dynamicSlippage = calculateSlippage(tokenIn, tokenOut);
  const amountOutMinimum = amountOut.mul(100 - (dynamicSlippage * 100)).div(100);

  console.log(`Using dynamic slippage: ${dynamicSlippage * 100}%`);
  console.log(`Executing the swap with fee tier ${fee} and slippage protection...`);

  const routerContract = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);

  const params = {
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    fee: fee,
    recipient: wallet.address,
    deadline: deadline,
    amountIn: amountInWei,
    amountOutMinimum: amountOutMinimum,
    sqrtPriceLimitX96: 0
  };

  const swapTx = await routerContract.exactInputSingle(params, {
    gasLimit: ethers.utils.hexlify(300000) // Manual gas limit
  });

  console.log("Swap transaction sent. Waiting for confirmation...");
  const receipt = await swapTx.wait();

  console.log("Swap transaction confirmed!");
  console.log("Transaction hash:", receipt.transactionHash);
  console.log(`Check your ${tokenOut.toUpperCase()} balance at address: ${wallet.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
