// validation.service.js
require('dotenv').config();
const dalService = require("./dal.service");
const oracleService = require("./oracle.service");
const ethers = require("ethers");
const fs = require("fs");
const axios = require("axios");

// Initialize constants from environment
const VALIDATION_THRESHOLD = process.env.VALIDATION_THRESHOLD || 0.05; // Default 5% tolerance
const POSITION_INACTIVITY_DAYS = process.env.POSITION_INACTIVITY_DAYS || 7; // Default 7 days
const VALIDATION_API_URL = process.env.VALIDATION_API_URL || null;

// Set up connection to Ethereum node if needed
const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || "https://rpc.ankr.com/eth_sepolia");

/**
 * Validates a position movement decision
 * @param {Object} position The position being moved
 * @param {string} action Type of action ("restake" or "returnToPool")
 * @param {number} currentPrice Current ETH price
 * @returns {Object} Validation result with success flag and attestation
 */
async function validatePositionMovement(position, action, currentPrice) {
  try {
    // Get a second price source to compare with
    const chainlinkPrice = await getChainlinkPrice();
    
    // Validate that the prices match within acceptable range
    const priceValid = validatePrices(currentPrice, chainlinkPrice);
    if (!priceValid.success) {
      return { 
        success: false, 
        reason: "Price validation failed",
        details: priceValid.details
      };
    }
    
    // Validate the position is in the correct state for the action
    const positionValid = validatePositionState(position, action, currentPrice);
    if (!positionValid.success) {
      return {
        success: false,
        reason: "Position state invalid for requested action",
        details: positionValid.details
      };
    }
    
    // If we get here, validation passed - generate attestation
    const attestation = await generateAttestation(position, action, currentPrice);
    
    return {
      success: true,
      attestation: attestation
    };
  } catch (err) {
    console.error("Validation error:", err?.message);
    return {
      success: false,
      reason: "Validation error",
      details: err?.message
    };
  }
}

/**
 * Validates that the current price is accurately determined by comparing multiple sources
 */
async function validatePrices(binancePrice, chainlinkPrice) {
  // Calculate the difference percentage
  const priceDiff = Math.abs(binancePrice - chainlinkPrice) / chainlinkPrice;
  
  // If the difference is more than our threshold, reject
  if (priceDiff > VALIDATION_THRESHOLD) {
    return {
      success: false,
      details: {
        binancePrice: binancePrice,
        chainlinkPrice: chainlinkPrice,
        difference: priceDiff,
        threshold: VALIDATION_THRESHOLD
      }
    };
  }
  
  return { success: true };
}

/**
 * Validates a position is in the correct state for the requested action
 */
function validatePositionState(position, action, currentPrice) {
  // Convert ticks to prices for easier reasoning
  const lowerPrice = tickToPrice(position.lowerTick);
  const upperPrice = tickToPrice(position.upperTick);
  
  // Check if position is currently active (price within range)
  const isActive = (currentPrice >= lowerPrice && currentPrice <= upperPrice);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const inactiveDuration = currentTimestamp - position.lastActiveTimestamp;
  const inactivityThreshold = POSITION_INACTIVITY_DAYS * 24 * 60 * 60; // days to seconds
  
  if (action === "restake") {
    // For restaking, position must be inactive and for the minimum threshold time
    if (isActive) {
      return {
        success: false,
        details: {
          reason: "Position is currently active and cannot be restaked",
          currentPrice: currentPrice,
          priceRange: `${lowerPrice}-${upperPrice}`
        }
      };
    }
    
    if (inactiveDuration < inactivityThreshold) {
      return {
        success: false,
        details: {
          reason: "Position has not been inactive long enough to be restaked",
          inactiveDuration: `${Math.floor(inactiveDuration / 86400)} days`,
          required: `${POSITION_INACTIVITY_DAYS} days`
        }
      };
    }
    
    if (position.isRestaked) {
      return {
        success: false,
        details: {
          reason: "Position is already restaked"
        }
      };
    }
  } else if (action === "returnToPool") {
    // For returning to pool, position must be active and currently restaked
    if (!isActive) {
      return {
        success: false,
        details: {
          reason: "Position is not active and should remain restaked",
          currentPrice: currentPrice,
          priceRange: `${lowerPrice}-${upperPrice}`
        }
      };
    }
    
    if (!position.isRestaked) {
      return {
        success: false,
        details: {
          reason: "Position is not currently restaked"
        }
      };
    }
  }
  
  return { success: true };
}

/**
 * Generate an attestation for the validated action
 */
async function generateAttestation(position, action, currentPrice) {
  // Create the attestation data
  const attestationData = {
    positionId: position.id,
    owner: position.owner,
    action: action,
    timestamp: Math.floor(Date.now() / 1000),
    priceAtValidation: currentPrice,
    validatorAddress: process.env.VALIDATOR_ADDRESS,
    validationDetails: {
      lowerTick: position.lowerTick,
      upperTick: position.upperTick,
      isRestaked: position.isRestaked,
      lastActiveTimestamp: position.lastActiveTimestamp
    }
  };
  
  // Sign the attestation if we have a validator private key
  if (process.env.VALIDATOR_PRIVATE_KEY) {
    const wallet = new ethers.Wallet(process.env.VALIDATOR_PRIVATE_KEY);
    const messageHash = ethers.solidityPackedKeccak256(
      ["string", "bytes32", "address", "string", "uint256", "uint256"],
      [
        "RESTAKING_ATTESTATION",
        attestationData.positionId,
        attestationData.owner,
        attestationData.action,
        attestationData.timestamp,
        ethers.parseUnits(attestationData.priceAtValidation.toString(), 18)
      ]
    );
    
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));
    attestationData.signature = signature;
  }
  
  // Optionally submit to external validation API
  if (VALIDATION_API_URL) {
    try {
      const response = await axios.post(VALIDATION_API_URL, attestationData);
      attestationData.externalValidation = response.data;
    } catch (err) {
      console.warn("Failed to get external validation:", err.message);
    }
  }
  
  // Store attestation in IPFS or local database
  await dalService.storeAttestation(attestationData);
  
  return attestationData;
}

/**
 * Get the current price from Chainlink oracle as secondary source
 */
async function getChainlinkPrice() {
  try {
    // Chainlink ETH/USD Price Feed address for Ethereum Mainnet
    const aggregatorAddress = process.env.CHAINLINK_ETH_USD_ADDRESS || "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
    
    // ABI for the Chainlink Aggregator interface (only the latestRoundData function)
    const aggregatorABI = [
      {
        "inputs": [],
        "name": "latestRoundData",
        "outputs": [
          { "internalType": "uint80", "name": "roundId", "type": "uint80" },
          { "internalType": "int256", "name": "answer", "type": "int256" },
          { "internalType": "uint256", "name": "startedAt", "type": "uint256" },
          { "internalType": "uint256", "name": "updatedAt", "type": "uint256" },
          { "internalType": "uint80", "name": "answeredInRound", "type": "uint80" }
        ],
        "stateMutability": "view",
        "type": "function"
      }
    ];
    
    const aggregator = new ethers.Contract(aggregatorAddress, aggregatorABI, provider);
    const roundData = await aggregator.latestRoundData();
    
    // Chainlink price feeds for ETH/USD have 8 decimals
    const price = parseFloat(ethers.formatUnits(roundData.answer, 8));
    return price;
  } catch (err) {
    console.error("Error fetching Chainlink price:", err.message);
    throw err;
  }
}

/**
 * Verify an existing attestation
 */
async function verifyAttestation(attestation) {
  try {
    // Check if the attestation has a signature
    if (!attestation.signature) {
      return { valid: false, reason: "No signature on attestation" };
    }
    
    // Recreate the message hash
    const messageHash = ethers.solidityPackedKeccak256(
      ["string", "bytes32", "address", "string", "uint256", "uint256"],
      [
        "RESTAKING_ATTESTATION",
        attestation.positionId,
        attestation.owner,
        attestation.action,
        attestation.timestamp,
        ethers.parseUnits(attestation.priceAtValidation.toString(), 18)
      ]
    );
    
    // Recover the signer
    const recoveredAddress = ethers.verifyMessage(ethers.getBytes(messageHash), attestation.signature);
    
    // Check if the signer is an approved validator
    const isApprovedValidator = await dalService.isApprovedValidator(recoveredAddress);
    
    return {
      valid: isApprovedValidator,
      signer: recoveredAddress,
      isApprovedValidator: isApprovedValidator
    };
  } catch (err) {
    console.error("Error verifying attestation:", err.message);
    return { valid: false, reason: err.message };
  }
}

/**
 * Helper function to convert Uniswap tick to price
 */
function tickToPrice(tick) {
  // Uniswap v3 tick to price formula: 1.0001^tick
  return Math.pow(1.0001, tick);
}

/**
 * Helper function to convert price to Uniswap tick
 */
function priceToTick(price) {
  // Uniswap v3 price to tick formula: log(price) / log(1.0001)
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

/**
 * Get multiple price sources to validate price
 */
async function validateMultiplePrices() {
  try {
    // Get prices from different sources
    const binancePrice = await oracleService.getPrice("ETHUSDT");
    const chainlinkPrice = await getChainlinkPrice();
    
    // Calculate average price
    const averagePrice = (parseFloat(binancePrice.price) + chainlinkPrice) / 2;
    
    // Check if prices are within acceptable range of each other
    const validation = validatePrices(parseFloat(binancePrice.price), chainlinkPrice);
    
    return {
      success: validation.success,
      averagePrice: averagePrice,
      sources: {
        binance: parseFloat(binancePrice.price),
        chainlink: chainlinkPrice
      },
      validation: validation
    };
  } catch (err) {
    console.error("Error validating prices:", err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  validatePositionMovement,
  verifyAttestation,
  validateMultiplePrices,
  validatePrices
};