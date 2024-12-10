const { keccak256 } = require('@ethersproject/solidity');
const { getAddress } = require('@ethersproject/address');

// Uniswap V3 factory and pool init code hash on Ethereum mainnet
const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const POOL_INIT_CODE_HASH = '0xe34f4def8b9951b4b0f4aaf0a3cbe9dc9f7a76bb2fa938612efb8e4e0d4b1d3e';

/**
 * Compute the Uniswap V3 Pool address for given tokens and fee tier.
 * @param {string} tokenA - Checksummed address of token A
 * @param {string} tokenB - Checksummed address of token B
 * @param {number} fee - The fee tier (e.g., 500, 3000, 10000)
 * @returns {string} The Uniswap V3 Pool address
 */
function getPoolAddress(tokenA, tokenB, fee) {
  // Validate and normalize addresses to checksummed form
  const addressA = getAddress(tokenA);
  const addressB = getAddress(tokenB);

  // Determine token0 and token1 by lex order
  const [token0, token1] = addressA.toLowerCase() < addressB.toLowerCase()
    ? [addressA, addressB]
    : [addressB, addressA];

  // Compute salt as keccak256(token0, token1, fee)
  const salt = keccak256(['address', 'address', 'uint24'], [token0, token1, fee]);

  // Encode for create2: keccak256(0xff + factory + salt + init_code_hash)
  const create2Inputs = ['bytes', 'address', 'bytes32', 'bytes32'];
  const create2Values = ['0xff', FACTORY_ADDRESS, salt, POOL_INIT_CODE_HASH];
  const create2Hash = keccak256(create2Inputs, create2Values);

  // Pool address is the last 20 bytes of create2Hash
  return getAddress(`0x${create2Hash.slice(-40)}`);
}

// Example usage with WETH and USDC on mainnet, and a 0.3% fee tier:
const tokenA = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH (checksummed)
const tokenB = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI (checksummed)
const fee = 3000;

const poolAddr = getPoolAddress(tokenA, tokenB, fee);
console.log('Uniswap V3 Pool Address:', poolAddr);
