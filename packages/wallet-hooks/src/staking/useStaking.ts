import { Coin } from '@cosmjs/amino';
import { OfflineSigner } from '@cosmjs/proto-signing';
import { calculateFee, coin, StdFee } from '@cosmjs/stargate';
import {
  DefaultGasEstimates,
  Delegation,
  EthermintTxHandler,
  fromSmall,
  getSimulationFee,
  InjectiveTx,
  LedgerError,
  SeiTxHandler,
  simulateDelegate,
  simulateRedelegate,
  simulateUndelegate,
  simulateWithdrawRewards,
  toSmall,
  Tx,
  Validator,
} from '@leapwallet/cosmos-wallet-sdk';
import { GasPrice, SupportedChain } from '@leapwallet/cosmos-wallet-sdk';
import { DEFAULT_GAS_REDELEGATE, NativeDenom } from '@leapwallet/cosmos-wallet-sdk/dist/constants';
import Network from '@leapwallet/cosmos-wallet-sdk/dist/stake/network';
import { BigNumber } from 'bignumber.js';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { LeapWalletApi } from '../apis';
import { useGetTokenBalances } from '../bank';
import { CosmosTxType } from '../connectors';
import { useGasAdjustment } from '../fees';
import { currencyDetail, useformatCurrency, useUserPreferredCurrency } from '../settings';
import {
  useActiveChain,
  useActiveWalletStore,
  useAddress,
  useChainApis,
  useChainsStore,
  useDefaultGasEstimates,
  useDenoms,
  useGasPriceSteps,
  useGetChains,
  usePendingTxState,
  useSelectedNetwork,
  useStakeClaimRewards,
  useStakeDelegations,
  useStakeUndelegations,
  useStakeValidators,
  useTxMetadata,
} from '../store';
import { useTxHandler } from '../tx';
import { TxCallback, WALLETTYPE } from '../types';
import { STAKE_MODE } from '../types';
import { useGetGasPrice } from '../utils';
import { fetchCurrency } from '../utils/findUSDValue';
import { getNativeDenom } from '../utils/getNativeDenom';
import { capitalize, formatTokenAmount } from '../utils/strings';

function getStakeTxType(mode: STAKE_MODE): CosmosTxType {
  switch (mode) {
    case 'DELEGATE':
      return CosmosTxType.StakeDelegate;
    case 'UNDELEGATE':
      return CosmosTxType.StakeUndelegate;
    case 'REDELEGATE':
      return CosmosTxType.StakeRedelgate;
    default:
      return CosmosTxType.StakeClaim;
  }
}

export function useInvalidateDelegations() {
  const { refetchDelegations, refetchUnboundingDelegations } = useStaking();

  return useCallback(() => {
    refetchDelegations();
    refetchUnboundingDelegations();
  }, []);
}

export function useStaking() {
  const chainInfos = useGetChains();
  const activeChain = useActiveChain();
  const { allAssets } = useGetTokenBalances();
  const isTestnet = useSelectedNetwork() === 'testnet';

  const { rewards, loadingRewardsStatus, isFetchingRewards, refetchDelegatorRewards } = useStakeClaimRewards();
  const { delegationInfo, loadingDelegations, refetchDelegations } = useStakeDelegations();
  const { unboundingDelegationsInfo, loadingUnboundingDegStatus, refetchUnboundingDelegations } =
    useStakeUndelegations();
  const { validatorData, validatorDataStatus, refetchNetwork } = useStakeValidators();

  const activeChainInfo = chainInfos[activeChain];
  const token = allAssets?.find((e) => e.symbol === activeChainInfo.denom);

  const networkData = useMemo(() => {
    if (validatorData?.chainData && validatorData?.validators)
      return new Network(validatorData?.chainData, validatorData?.validators);
    else return;
  }, [validatorData, validatorData?.chainData, validatorData?.validators]);

  const loadingUnboundingDelegations =
    loadingUnboundingDegStatus !== 'success' && loadingUnboundingDegStatus !== 'error';
  const loadingRewards = loadingRewardsStatus !== 'success' && loadingRewardsStatus !== 'error';
  const loadingNetwork = validatorDataStatus !== 'success' && validatorDataStatus !== 'error';

  const refetchAllStakingData = async () => {
    await refetchDelegations();
    await refetchDelegatorRewards();
    await refetchNetwork();
    await refetchUnboundingDelegations();
  };

  return {
    isTestnet,
    rewards: rewards?.result,
    totalRewardsDollarAmt: rewards?.totalRewardsDollarAmt,
    formattedTotalRewardAmount: rewards?.formattedTotalRewards,
    totalRewards: rewards?.totalRewards,
    network: networkData,
    minMaxApy: networkData?.minMaxApy,
    delegations: delegationInfo?.delegations,
    token,
    totalDelegationAmount: delegationInfo?.totalDelegationAmount,
    currencyAmountDelegation: delegationInfo?.currencyAmountDelegation,
    unboundingDelegationsInfo,
    loadingUnboundingDelegations,
    loadingRewards: loadingRewards,
    isFetchingRewards,
    loadingNetwork: loadingNetwork,
    loadingDelegations,
    refetchAllStakingData,
    refetchDelegations,
    refetchDelegatorRewards,
    refetchNetwork,
    refetchUnboundingDelegations,
  };
}

export function useSimulateStakeTx(
  mode: STAKE_MODE,
  toValidator: Validator,
  fromValidator?: Validator,
  delegations?: Delegation[],
) {
  const address = useAddress();
  const selectedNetwork = useSelectedNetwork();
  const activeChain = useActiveChain();
  const { chains } = useChainsStore();
  const { lcdUrl } = useChainApis();

  const getAmount = useCallback(
    (amount: string) => {
      const denom = getNativeDenom(chains, activeChain, selectedNetwork);
      switch (mode) {
        case 'REDELEGATE':
          return coin(toSmall(amount, denom?.coinDecimals), delegations?.[0].balance.denom ?? '');
        case 'DELEGATE':
        case 'UNDELEGATE':
          return coin(toSmall(amount, denom?.coinDecimals), denom.coinMinimalDenom);
        default:
          return coin(toSmall('0'), denom.coinMinimalDenom);
      }
    },
    [mode, activeChain, delegations, chains],
  );

  const simulateTx = useCallback(
    async (_amount: string, feeDenom: string) => {
      const amount = getAmount(_amount);
      const fee = getSimulationFee(feeDenom);
      switch (mode) {
        case 'REDELEGATE':
          return await simulateRedelegate(
            lcdUrl ?? '',
            address,
            toValidator?.address ?? '',
            fromValidator?.address ?? '',
            amount,
            fee,
          );
        case 'DELEGATE':
          return await simulateDelegate(lcdUrl ?? '', address, toValidator?.address ?? '', amount, fee);
        case 'CLAIM_REWARDS': {
          const validators =
            (toValidator ? [toValidator.operator_address] : delegations?.map((d) => d.delegation.validator_address)) ??
            [];
          return await simulateWithdrawRewards(lcdUrl ?? '', address, validators, fee);
        }
        case 'UNDELEGATE':
          return await simulateUndelegate(lcdUrl ?? '', address, toValidator?.address ?? '', amount, fee);
      }
    },
    [address, toValidator, fromValidator, mode, delegations],
  );

  return simulateTx;
}

export function useStakeTx(
  mode: STAKE_MODE,
  toValidator: Validator,
  fromValidator?: Validator,
  delegations?: Delegation[],
) {
  // HOOKS
  const denoms = useDenoms();
  const txMetadata = useTxMetadata();
  const chainInfos = useGetChains();
  const getTxHandler = useTxHandler();
  const activeChain = useActiveChain();
  const { activeWallet } = useActiveWalletStore();
  const address = useAddress();
  const [preferredCurrency] = useUserPreferredCurrency();
  const [formatCurrency] = useformatCurrency();
  const { setPendingTx } = usePendingTxState();
  const txPostToDB = LeapWalletApi.useOperateCosmosTx();
  const defaultGasEstimates = useDefaultGasEstimates();
  const gasPriceSteps = useGasPriceSteps();

  // STATES
  const [memo, setMemo] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [fees, setFees] = useState<StdFee>();
  const [currencyFees, setCurrencyFees] = useState<string>();
  const [error, setError] = useState<string>();
  const [ledgerError, setLedgerErrorMsg] = useState<string>();
  const [isLoading, setLoading] = useState<boolean>(false);
  const [showLedgerPopup, setShowLedgerPopup] = useState(false);
  const [, setGasPriceFactor] = useState<'low' | 'average' | 'high'>('low');
  const selectedNetwork = useSelectedNetwork();
  const [recommendedGasLimit, setRecommendedGasLimit] = useState(() => {
    if (mode === 'REDELEGATE') return DEFAULT_GAS_REDELEGATE.toString();
    return defaultGasEstimates[activeChain]?.DEFAULT_GAS_STAKE.toString() ?? DefaultGasEstimates.DEFAULT_GAS_STAKE;
  });

  const denom = getNativeDenom(chainInfos, activeChain, selectedNetwork);
  const { lcdUrl } = useChainApis();
  const getGasPrice = useGetGasPrice(activeChain);
  const gasAdjustment = useGasAdjustment();

  // FUNCTIONS
  const onTxSuccess = async (promise: any, txHash: string, callback?: TxCallback) => {
    const amtKey = mode === 'UNDELEGATE' || mode === 'CLAIM_REWARDS' ? 'receivedAmount' : 'sentAmount';
    const title = mode === 'CLAIM_REWARDS' ? 'claim rewards' : mode.toLowerCase();

    let subtitle1: string;
    if (mode === 'CLAIM_REWARDS') {
      subtitle1 = `From ${
        ((toValidator ? [toValidator.operator_address] : delegations?.map((d) => d.delegation.validator_address)) ?? [])
          .length
      } validators`;
    } else {
      subtitle1 = `Validator ${toValidator?.moniker ?? 'Unkown'}`;
    }

    setPendingTx({
      img: chainInfos[activeChain].chainSymbolImageUrl,
      [amtKey]: formatTokenAmount(amount, '', 4),
      sentTokenInfo: denom,
      title1: `${capitalize(title)}`,
      subtitle1,
      title2: 'Transaction Successful',
      txStatus: 'loading',
      txType: mode === 'DELEGATE' || mode === 'REDELEGATE' ? 'delegate' : 'undelegate',
      promise,
      txHash,
    });
    if (showLedgerPopup) {
      setShowLedgerPopup(false);
    }
    callback?.('success');
  };

  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

  const setLedgerError = (error?: string) => {
    setLedgerErrorMsg(error);
    setShowLedgerPopup(false);
  };

  const simulateTx = useCallback(
    (amount: Coin, feeDenom: string) => {
      const fee = getSimulationFee(feeDenom);
      switch (mode) {
        case 'REDELEGATE':
          return simulateRedelegate(
            lcdUrl ?? '',
            address,
            toValidator?.address ?? '',
            fromValidator?.address ?? '',
            amount,
            fee,
          );
        case 'DELEGATE':
          return simulateDelegate(lcdUrl ?? '', address, toValidator?.address ?? '', amount, fee);
        case 'CLAIM_REWARDS': {
          const validators =
            (toValidator ? [toValidator.operator_address] : delegations?.map((d) => d.delegation.validator_address)) ??
            [];
          return simulateWithdrawRewards(lcdUrl ?? '', address, validators, fee);
        }
        case 'UNDELEGATE':
          return simulateUndelegate(lcdUrl ?? '', address, toValidator?.address ?? '', amount, fee);
      }
    },
    [address, toValidator, fromValidator, memo, mode, delegations],
  );

  const executeTx = useCallback(
    async (amount: Coin, fee: StdFee, txHandler: Tx | InjectiveTx | EthermintTxHandler | SeiTxHandler) => {
      switch (mode) {
        case 'UNDELEGATE':
          return await txHandler.unDelegate(address, toValidator?.address ?? '', amount, fee, memo);
        case 'CLAIM_REWARDS': {
          const validators =
            (toValidator ? [toValidator.operator_address] : delegations?.map((d) => d.delegation.validator_address)) ??
            [];
          return await txHandler.withdrawRewards(address, validators, fee, memo);
        }
        case 'DELEGATE':
          return await txHandler.delegate(address, toValidator?.address ?? '', amount, fee, memo);
        case 'REDELEGATE':
          return await txHandler.reDelegate(
            address,
            toValidator?.address ?? '',
            fromValidator?.address ?? '',
            amount,
            fee,
            memo,
          );
      }
    },
    [address, toValidator, fromValidator, memo, mode, delegations],
  );

  const getAmount = useCallback(
    (amount: string) => {
      const denom = getNativeDenom(chainInfos, activeChain, selectedNetwork);
      switch (mode) {
        case 'REDELEGATE':
          return coin(toSmall(amount, denom?.coinDecimals), delegations?.[0].balance.denom ?? '');
        case 'DELEGATE':
        case 'UNDELEGATE':
          return coin(toSmall(amount, denom?.coinDecimals), denom.coinMinimalDenom);
        default:
          return coin(toSmall('0'), denom.coinMinimalDenom);
      }
    },
    [mode, activeChain, delegations, chainInfos],
  );

  const executeDelegateTx = async ({
    wallet,
    callback,
    isSimulation = true,
    customFee,
  }: {
    wallet?: OfflineSigner;
    callback?: TxCallback;
    isSimulation: boolean;
    customFee?: {
      stdFee: StdFee;
      feeDenom: NativeDenom;
    };
  }) => {
    if (isLoading || !address || !activeChain) {
      return;
    }
    if (mode === 'REDELEGATE' && (!toValidator || !fromValidator || !delegations)) {
      return;
    }
    if (mode === 'CLAIM_REWARDS' && (!delegations || new BigNumber(amount).lte(0.00001))) {
      setError('Reward is too low');
      return;
    }
    if ((mode === 'DELEGATE' || mode === 'UNDELEGATE') && !toValidator) {
      return;
    }

    setError(undefined);

    if (!amount || new BigNumber(amount).lte(0)) {
      setFees(undefined);
      setCurrencyFees('');
      return;
    }

    setLoading(true);

    try {
      const tx = !isSimulation && wallet ? await getTxHandler(wallet) : undefined;

      const denom = getNativeDenom(chainInfos, activeChain, selectedNetwork);
      const amt = getAmount(amount);

      let fee: StdFee;
      let feeDenom: NativeDenom;

      if (customFee !== undefined) {
        fee = customFee.stdFee;
        feeDenom = customFee.feeDenom;
      } else {
        let gasPrice = await getGasPrice();
        if (activeChain === 'akash') {
          gasPrice = GasPrice.fromString(
            `${gasPriceSteps[activeChain].high.toString()}${denoms.uakt.coinMinimalDenom}`,
          );
        }

        const defaultGasStake =
          defaultGasEstimates[activeChain]?.DEFAULT_GAS_STAKE || DefaultGasEstimates.DEFAULT_GAS_STAKE;
        let gasEstimate = defaultGasStake;

        if (mode === 'CLAIM_REWARDS' && delegations) {
          gasEstimate = defaultGasStake * Math.max(delegations?.length, 1);
        }

        try {
          const { gasUsed } = await simulateTx(amt, gasPrice.denom);
          gasEstimate = gasUsed;
          setRecommendedGasLimit(gasUsed.toString());
        } catch (error: any) {
          if (error.message.includes('redelegation to this validator already in progress')) {
            setError(error.message);
            return;
          }
        }

        fee = calculateFee(Math.round((gasEstimate ?? defaultGasStake) * gasAdjustment), gasPrice);

        feeDenom = getNativeDenom(chainInfos, activeChain, selectedNetwork);
      }

      if (isSimulation) {
        const feeCurrencyValue = await fetchCurrency(
          fromSmall(fee.amount[0].amount, feeDenom.coinDecimals),
          feeDenom.coinGeckoId,
          feeDenom.chain as SupportedChain,
          currencyDetail[preferredCurrency].currencyPointer,
        );
        setCurrencyFees(feeCurrencyValue ?? '0');
        setFees(fee);
      }

      setError(undefined);
      setLedgerError(undefined);

      if (tx) {
        if (activeWallet?.walletType === WALLETTYPE.LEDGER) {
          setShowLedgerPopup(true);
        }
        const txHash = await executeTx(amt, fee, tx);
        const txType = getStakeTxType(mode);
        let metadata = {};
        if (mode === 'REDELEGATE') {
          metadata = {
            ...txMetadata,
            fromValidator: fromValidator?.address,
            toValidator: toValidator?.address,
            token: {
              amount: amt.amount,
              denom: amt.denom,
            },
          };
        } else if (mode === 'DELEGATE' || mode === 'UNDELEGATE') {
          metadata = {
            ...txMetadata,
            validatorAddress: toValidator?.address,
            token: {
              amount: amt.amount,
              denom: amt.denom,
            },
          };
        } else if (mode === 'CLAIM_REWARDS') {
          metadata = {
            ...txMetadata,
            validators:
              (toValidator
                ? [toValidator.operator_address]
                : delegations?.map((d) => d.delegation.validator_address)) ?? [],
            token: {
              amount: toSmall(amount.toString(), denom?.coinDecimals ?? 6),
              denom: amt?.denom,
            },
          };
        }

        await txPostToDB({
          txHash,
          txType,
          metadata,
          feeDenomination: fee.amount[0].denom,
          feeQuantity: fee.amount[0].amount,
        });
        const txResult = tx.pollForTx(txHash);

        if (txResult) onTxSuccess(txResult, txHash, callback);
        setError(undefined);
      }
    } catch (e: any) {
      if (e instanceof LedgerError) {
        setLedgerError(e.message.toString());
      } else {
        setError(e.message.toString());
      }
    } finally {
      setLoading(false);
      setShowLedgerPopup(false);
    }
  };

  const onReviewTransaction = async (
    wallet: OfflineSigner,
    callback: TxCallback,
    isSimulation: boolean,
    customFee?: {
      stdFee: StdFee;
      feeDenom: NativeDenom;
    },
  ) => {
    try {
      executeDelegateTx({ wallet, callback, isSimulation, customFee });
    } catch {
      //
    }
  };

  const onSimulateTx = () => {
    try {
      executeDelegateTx({ isSimulation: true });
    } catch {
      //
    }
  };

  useEffect(() => {
    const timeoutID = setTimeout(() => {
      const amountBN = new BigNumber(amount);
      if (!amountBN.isNaN() && amountBN.gt(0)) {
        try {
          executeDelegateTx({ isSimulation: true });
        } catch {
          //
        }
      }
    }, 750);

    return () => clearTimeout(timeoutID);
  }, [amount]);

  const displayFeeText =
    amount.length === 0 || !fees
      ? 'Enter amount to see the transaction fee'
      : `Transaction fee: ${formatTokenAmount(fromSmall(fees?.amount[0]?.amount, denom?.coinDecimals), '', 5)} ${
          denom?.coinDenom
        } (${formatCurrency(new BigNumber(currencyFees ?? '0'))})`;

  return {
    error,
    clearError,
    isLoading,
    memo,
    fees: fromSmall(fees?.amount[0]?.amount ?? '0', denom?.coinDecimals),
    currencyFees,
    amount,
    displayFeeText,
    onReviewTransaction,
    setAmount,
    setMemo,
    showLedgerPopup,
    onSimulateTx,
    setGasPriceFactor,
    setLedgerError,
    ledgerError,
    recommendedGasLimit,
  };
}
