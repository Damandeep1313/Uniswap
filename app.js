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
const feeTiers = [500, 3000, 10000]; // Fee tiers in ascending order
const MAX_GAS_LIMIT = ethers.BigNumber.from(300000); // Upper limit for gas (300,000 units)

// Token mapping file
const tokenMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapping.json'), 'utf8'));

// Helper functions

/**
 * Finds the address of a token given its symbol or name.
 * @param {string} tokenStr Token name or symbol
 * @returns {string} Token address
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
  throw new Error(`Token not found: ${tokenStr}`);
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
      return { fee, amountOut };
    } catch (error) {
      console.error(`Fee tier ${fee} failed: ${error.message}`);
      continue; // Try the next fee tier
    }
  }
  throw new Error("No valid liquidity pool found.");
}

// API Endpoints

/**
 * Swap tokens endpoint.
 * Requires a private key in the Authorization header.
 */
app.post('/swap', async (req, res) => {
  const { authorization } = req.headers;
  console.log("Authorization Header Received:", authorization);

  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!authorization) return res.status(401).json({ error: "Private key required in Authorization header" });
  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(authorization, provider);
    const tokenInAddress = findTokenAddress(tokenIn);
    const tokenOutAddress = findTokenAddress(tokenOut);
    const amountInWei = ethers.utils.parseEther(amountIn);

    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);

    const router = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);

    const params = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      fee,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: amountInWei,
      amountOutMinimum: amountOut.mul(98).div(100), // 2% slippage
      sqrtPriceLimitX96: 0
    };

    // Estimate gas dynamically and add a buffer
    const estimatedGas = await router.estimateGas.exactInputSingle(params);
    const gasLimitWithBuffer = estimatedGas.mul(120).div(100); // Add 20% buffer
    const gasLimit = gasLimitWithBuffer.lt(MAX_GAS_LIMIT) ? gasLimitWithBuffer : MAX_GAS_LIMIT; // Apply upper limit
    console.log(`Estimated gas: ${estimatedGas.toString()}, Gas limit: ${gasLimit.toString()}`);

    // Execute the transaction
    const swapTx = await router.exactInputSingle(params, { gasLimit });
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
