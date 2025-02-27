
import "@uniswap/v4-core/contracts/interfaces/IPoolManager.sol";
import "@uniswap/v4-core/contracts/libraries/PoolKey.sol";

contract MyHook {
    IPoolManager public poolManager;

    constructor(address _poolManager) {
        poolManager = IPoolManager(_poolManager);
    }

    function createPoolWithHook(address token0, address token1, uint24 fee, address hook) external {
        // Define the pool key
        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: fee,
            hook: hook
        });

        // Create the pool
        poolManager.initialize(poolKey, sqrtPriceX96);
    }
}
