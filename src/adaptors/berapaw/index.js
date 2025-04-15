const utils = require('../utils');
const sdk = require('@defillama/sdk');

const SECONDS_PER_YEAR = 31557600; // 365.25 days per year

// Contract addresses
const ADDRESSES = {
    LBGT: '0xBaadCC2962417C01Af99fb2B7C75706B9bd6Babe',
    PPAW: '0x03c86e21623f25Eca0eA544890c7603B9a33E1AC',
    WBERA_LBGT_WEIGHTED: '0x705Fc16BA5A1EB67051934F2Fb17EacaE660F6c7',
    WBERA_LBGT_WEIGHTED_POOL_ID: '0x705fc16ba5a1eb67051934f2fb17eacae660f6c70002000000000000000000d5',
    REWARD_COLLECTOR: '0x3ea91AE9e47EdBC43e64C6DDF99D67207296eC28',
    LBGT_WBERA_STAKING: '0xa77dee7bc36c463bB3E39804c9C7b13427D712B0',
    LBGT_WBERA_LBGT_STAKING: '0xF0422bC37f1d2D1B57596cCA5A64E30c71D10170',
    HUB_VAULT: '0x4Be03f781C497A489E3cB0287833452cA9B9E80B',
    ST_LBGT_VAULT: '0xFace73a169e2CA2934036C8Af9f464b5De9eF0ca'
};

// Helper functions
const callContract = async (target, abi, params = []) => {
    return sdk.api.abi.call({
        target,
        abi,
        params,
        chain: 'berachain',
    }).then(res => res.output);
};

const getTokenPrice = async (tokenAddress) => {
    const priceData = (await utils.getPrices([tokenAddress], 'berachain')).pricesByAddress;
    return priceData[String(tokenAddress).toLowerCase()] || 0;
};

const getRewardRate = async (address) => {
    return callContract(address, 'uint256:rewardRate');
};

const getTotalAssets = async (vaultAddress) => {
    return callContract(vaultAddress, 'uint256:totalAssets');
};

const getTotalSupply = async (address) => {
    return callContract(address, 'uint256:totalSupply');
};

const getActualSupply = async (address) => {
    return callContract(address, 'uint256:getActualSupply');
};

const getPoolTokens = async () => {
    return callContract(ADDRESSES.HUB_VAULT, 'function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)', [ADDRESSES.WBERA_LBGT_WEIGHTED_POOL_ID]);
};

// TVL and APR calculations
const getStLbgtTvlUsd = async () => {
    const deposits = await getTotalAssets(ADDRESSES.ST_LBGT_VAULT);
    const uTokenAddress = await callContract(ADDRESSES.ST_LBGT_VAULT, 'address:asset');
    const price = await getTokenPrice(uTokenAddress);
    return (deposits / 1e18) * price;
};

const getStLbgtApr = async () => {
    const rewardRate = await getRewardRate(ADDRESSES.REWARD_COLLECTOR);
    const poolAssets = await getTotalAssets(ADDRESSES.ST_LBGT_VAULT);
    const rewardRatePerYear = (rewardRate * SECONDS_PER_YEAR) / 1e18;
    return (rewardRatePerYear / poolAssets) * 100;
};

const getLpTvlUsd = async (vaultAddress, uTokenAddress) => {
    const [vaultSupply, totalSupply, poolData] = await Promise.all([
        getTotalSupply(vaultAddress),
        getActualSupply(uTokenAddress),
        getPoolTokens()
    ]);

    const tokenPrices = await Promise.all(
        poolData.tokens.map(token => getTokenPrice(token))
    );

    const totalPoolValue = poolData.balances.reduce((acc, balance, i) => {
        const tokenValue = (Number(balance) / 1e18) * tokenPrices[i];
        return acc + tokenValue;
    }, 0);

    return Number(vaultSupply) === 0 ? 0 : (Number(vaultSupply) / Number(totalSupply)) * totalPoolValue;
};

const calculateApr = async (stakingTvlUsd, rewardTokenAddress, stakingAddress) => {
    const [price, rewardRate] = await Promise.all([
        getTokenPrice(rewardTokenAddress),
        getRewardRate(stakingAddress)
    ]);

    if (!price) return 0;

    const rewardRatePerYear = (rewardRate * SECONDS_PER_YEAR) / (1e18 * 1e18); // additional 1e18 to account for rewardRate precision 
    return (rewardRatePerYear * price) / stakingTvlUsd * 100;
};

const getLpApr = async (stakingTvlUsd) => {
    const [aprPpaw, aprLbgt] = await Promise.all([
        calculateApr(stakingTvlUsd, ADDRESSES.PPAW, ADDRESSES.LBGT_WBERA_STAKING),
        calculateApr(stakingTvlUsd, ADDRESSES.LBGT, ADDRESSES.LBGT_WBERA_LBGT_STAKING)
    ]);
    return aprPpaw + aprLbgt;
};

const getPoolData = async () => {
    const [stLbgtTvl, lpLbgtWberaTvl] = await Promise.all([
        getStLbgtTvlUsd(),
        getLpTvlUsd(ADDRESSES.LBGT_WBERA_STAKING, ADDRESSES.WBERA_LBGT_WEIGHTED)
    ]);

    const stLbgt = {
        pool: ADDRESSES.ST_LBGT_VAULT,
        chain: 'berachain',
        project: 'berapaw',
        symbol: 'LBGT',
        tvlUsd: stLbgtTvl,
        apyBase: utils.aprToApy(await getStLbgtApr(), 365 * 24 * 60 / 5), // compounding every 5 minutes
        rewardTokens: [ADDRESSES.LBGT],
        underlyingTokens: [ADDRESSES.LBGT],
    };

    const lp_lbgt_wbera = {
        pool: ADDRESSES.LBGT_WBERA_STAKING,
        chain: 'berachain',
        project: 'berapaw',
        symbol: '50WBERA-50LBGT-WEIGHTED',
        tvlUsd: lpLbgtWberaTvl,
        apyBase: await getLpApr(lpLbgtWberaTvl),
        rewardTokens: [ADDRESSES.LBGT, ADDRESSES.PPAW],
        underlyingTokens: [ADDRESSES.WBERA_LBGT_WEIGHTED],
    };

    return [stLbgt, lp_lbgt_wbera];
};

module.exports = {
    timetravel: false,
    apy: getPoolData,
    url: 'https://www.berapaw.com/stake',
};
