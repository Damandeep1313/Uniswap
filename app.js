require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Load ABIs
const routerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3RouterABI.json'), 'utf8'));
const quoterAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3QuoterABI.json'), 'utf8'));

// Environment variables
const RPC_URL = process.env.RPC_URL;
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const feeTiers = [500, 3000, 10000, 15000]; // Fee tiers in ascending order

// Increase gas limit for more complex trades
const MAX_GAS_LIMIT = ethers.BigNumber.from(500000);

// WETH mainnet address
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/**
 * Returns the token address.
 * Special case: if user says "eth", return WETH_ADDRESS.
 * Otherwise, assume the token string is already the correct address.
 * @param {string} tokenStr Token or address
 * @returns {string} Token address
 */
function findTokenAddress(tokenStr) {
  const lowerStr = tokenStr.toLowerCase();
  if (lowerStr === 'eth') {
    // Use WETH address for ETH swaps
    return WETH_ADDRESS;
  } else {
    // Assume user has provided a valid token contract address
    return tokenStr;
  }
}

/**
 * Gets the best quote for swapping tokens.
 * @param {object} provider Ethers.js provider instance
 * @param {string} tokenInAddress Address of input token
 * @param {string} tokenOutAddress Address of output token
 * @param {string} amountInWei Amount of input token in wei
 * @returns {object} Best fee tier and quoted output amount
 */
async function getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei) {
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);
  
  for (let fee of feeTiers) {
    try {
      const amountOut = await quoter.callStatic.quoteExactInputSingle(
        tokenInAddress,
        tokenOutAddress,
        fee,
        amountInWei,
        0
      );
      console.log(`Fee tier ${fee} gives output: ${ethers.utils.formatUnits(amountOut, 18)}`);
      return { fee, amountOut };
    } catch (error) {
      console.error(`Fee tier ${fee} failed: ${error.message}`);
      continue; // Try the next fee tier
    }
  }
  throw new Error("No valid liquidity pool found for the specified tokens.");
}

/**
 * Calculates slippage dynamically based on token volatility and user-defined limits.
 * Here, we've increased the base and max slippage for more volatile or illiquid pairs.
 * @param {string} tokenIn Input token (symbol or address)
 * @param {string} tokenOut Output token (symbol or address)
 * @returns {number} Slippage tolerance
 */
function calculateSlippage(tokenIn, tokenOut) {
  const BASE_SLIPPAGE = 0.01; // 1%
  const MAX_SLIPPAGE = 0.1;   // 10%

  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();

  // Simple example logic:
  if (inLower === 'eth' && outLower === 'usdt') {
    // Low volatility / stable pair
    return BASE_SLIPPAGE; 
  } else if (inLower === 'eth' || outLower === 'eth') {
    // Adjust for volatility if ETH is involved
    return Math.min(BASE_SLIPPAGE * 2, MAX_SLIPPAGE);
  } else {
    // Potentially illiquid or volatile pair
    return MAX_SLIPPAGE;
  }
}

// API Endpoints

/**
 * Swap tokens endpoint.
 * Requires a private key in the Authorization header.
 * Example request:
 * curl -X POST http://localhost:8000/swap \
 *  -H "Content-Type: application/json" \
 *  -H "Authorization: 0xYOUR_PRIVATE_KEY" \
 *  -d '{"amountIn":"0.0002","tokenIn":"eth","tokenOut":"0x...TOKEN_ADDRESS..."}'
 */
app.post('/swap', async (req, res) => {
  const { authorization } = req.headers;
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!authorization) {
    return res.status(401).json({ error: "Private key required in Authorization header" });
  }
  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(authorization, provider);

    const tokenInAddress = findTokenAddress(tokenIn);
    const tokenOutAddress = findTokenAddress(tokenOut);
    const amountInWei = ethers.utils.parseEther(amountIn);

    // If tokenIn is "eth", we send ETH as `value`, and skip ERC20 checks.
    let valueToSend = ethers.BigNumber.from(0);
    if (tokenIn.toLowerCase() === 'eth') {
      valueToSend = amountInWei;
    } else {
      // If tokenIn is an ERC-20, we must have balance and allowance
      const tokenContract = new ethers.Contract(tokenInAddress, [
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address owner) view returns (uint256)",
        "function approve(address spender, uint256 amount) public returns (bool)"
      ], wallet);

      // Check balance
      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance.lt(amountInWei)) {
        return res.status(400).json({ error: "Insufficient token balance." });
      }

      // Check allowance
      const allowance = await tokenContract.allowance(wallet.address, UNISWAP_V3_ROUTER_ADDRESS);
      if (allowance.lt(amountInWei)) {
        const approveTx = await tokenContract.approve(
          UNISWAP_V3_ROUTER_ADDRESS,
          ethers.constants.MaxUint256
        );
        await approveTx.wait();
        console.log("Approval complete.");
      }
    }

    // Get the best quote
    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);
    const dynamicSlippage = calculateSlippage(tokenIn, tokenOut);
    const amountOutMinimum = amountOut.mul(100 - dynamicSlippage * 100).div(100);

    const router = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);

    const params = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      fee,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300, // 5-minute deadline
      amountIn: amountInWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    // Execute the transaction
    const swapTx = await router.exactInputSingle(params, {
      gasLimit: MAX_GAS_LIMIT,
      value: valueToSend
    });
    const receipt = await swapTx.wait();
    res.status(200).json({ transactionHash: receipt.transactionHash });
  } catch (error) {
    console.error("Error executing swap:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Quote tokens endpoint.
 * Provides the estimated amount of output token for a given input token amount.
 * Example request:
 * curl -X POST http://localhost:8000/quote \
 *  -H "Content-Type: application/json" \
 *  -d '{"amountIn":"0.0002","tokenIn":"eth","tokenOut":"0x...TOKEN_ADDRESS..."}'
 */
app.post('/quote', async (req, res) => {
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const tokenInAddress = findTokenAddress(tokenIn);
    const tokenOutAddress = findTokenAddress(tokenOut);
    const amountInWei = ethers.utils.parseEther(amountIn);

    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);
    const amountOutFormatted = ethers.utils.formatUnits(amountOut, 18);

    return res.status(200).json({ feeTier: fee, amountOut: amountOutFormatted });
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
