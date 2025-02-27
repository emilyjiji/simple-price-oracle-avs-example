const { getPrice } = require('./oracle.service.js'); 

async function getCurrentPrice() {
    try {
      const response = await getPrice('ETHUSDT');
      const price = parseFloat(response.price); // Current price of ETH in USDT
      console.log("Fetched Current Price:", price);
      return price;
    } catch (err) {
      console.error("Error fetching current price:", err.message);
      return null;
    }
  }


  
// Calculate active range (±30% of current price)
function calculateActiveRange(currentPrice) {
    const lowerBound = currentPrice * 0.7; // 30% below the current price
    const upperBound = currentPrice * 1.3; // 30% above the current price
    return { lowerBound, upperBound };
  }
  
  // Check if a position is active
  function isPositionActive(position, currentPrice) {
    const { lowerBound, upperBound } = calculateActiveRange(currentPrice);
    return position.lowerTick >= lowerBound && position.lowerTick <= upperBound || position.upperTick >= lowerBound && position.upperTick <= upperBound;
  }
  
  // Monitor liquidity positions
  async function monitorLiquidityPositions(positions) {
    try {
      // Fetch the current price of ETH
      const currentPrice = await getCurrentPrice(); // or getCurrentPriceUsingChainlink()
      if (!currentPrice) {
        throw new Error("Failed to fetch current price");
      }
  
      // Calculate the active range
      const { lowerBound, upperBound } = calculateActiveRange(currentPrice);
      console.log("Active Range:", lowerBound, "-", upperBound);
  
      // Check each position
      positions.forEach((position, index) => {
        const isActive = isPositionActive(position, currentPrice);
        console.log(`Position ${index + 1}:`, {
          lowerTick: position.lowerTick,
          upperTick: position.upperTick,
          isActive: isActive ? "Active" : "Inactive",
        });
  
        if (!isActive) {
          console.log(`Position ${index + 1} is inactive. Withdrawing liquidity...`);
          // Logic to withdraw liquidity and restake with P2P
        }
      });
    } catch (err) {
      console.error("Error monitoring liquidity positions:", err.message);
    }
  }
  
  // Example positions
  const positions = [
    { lowerTick: 1500, upperTick: 2000 }, // Example position 1
    { lowerTick: 2500, upperTick: 3000 }, // Example position 2
  ];
  
  // Monitor liquidity positions
  monitorLiquidityPositions(positions);
