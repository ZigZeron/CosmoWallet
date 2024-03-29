import { sendTokensParams, useAddress, useSendModule } from '@leapwallet/cosmos-wallet-hooks'
import {
  getBlockChainFromAddress,
  isValidAddressWithPrefix,
  SupportedChain,
} from '@leapwallet/cosmos-wallet-sdk'
import { useSecretWallet } from 'hooks/wallet/useScrtWallet'
import { Wallet } from 'hooks/wallet/useWallet'
import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { assert } from 'utils/assert'
import { useTxCallBack } from 'utils/txCallback'

const useGetWallet = Wallet.useGetWallet

export type SendContextType = Readonly<
  {
    // eslint-disable-next-line no-unused-vars
    confirmSend: (args: Omit<sendTokensParams, 'gasEstimate' | 'getWallet'>) => Promise<void>
    sameChain: boolean
  } & ReturnType<typeof useSendModule>
>

export const SendContext = createContext<SendContextType | null>(null)

type SendContextProviderProps = {
  activeChain: SupportedChain
} & React.PropsWithChildren

export const SendContextProvider: React.FC<SendContextProviderProps> = ({ children }) => {
  const { tokenFiatValue, feeTokenFiatValue, confirmSend, selectedToken, ...rest } = useSendModule()

  const txCallback = useTxCallBack()
  const getWallet = useGetWallet()
  const currentWalletAddress = useAddress()
  const getSscrtWallet = useSecretWallet()

  const confirmSendTx = useCallback(
    async (args: Omit<sendTokensParams, 'gasEstimate' | 'getWallet'>) => {
      await confirmSend(
        {
          ...args,
          getWallet: () => {
            const isSnip20 = isValidAddressWithPrefix(
              selectedToken?.coinMinimalDenom ?? '',
              'secret',
            )
            if (isSnip20) {
              return getSscrtWallet()
            }
            return getWallet()
          },
        },
        txCallback,
      )
    },
    [confirmSend, getSscrtWallet, getWallet, selectedToken?.coinMinimalDenom, txCallback],
  )

  const value = useMemo(() => {
    const fromChain = getBlockChainFromAddress(currentWalletAddress)
    const { selectedAddress } = rest
    const toChain = getBlockChainFromAddress(selectedAddress ? selectedAddress.address ?? '' : '')

    const sameChain = fromChain === toChain

    return {
      tokenFiatValue: tokenFiatValue ?? '',
      feeTokenFiatValue: feeTokenFiatValue ?? '',
      selectedToken,
      confirmSend: confirmSendTx,
      sameChain,
      ...rest,
    } as const
  }, [confirmSendTx, currentWalletAddress, feeTokenFiatValue, rest, selectedToken, tokenFiatValue])

  return <SendContext.Provider value={value}>{children}</SendContext.Provider>
}

export const useSendContext = () => {
  const context = useContext(SendContext)

  assert(context !== null, 'useSendContext must be used within SendContextProvider')

  return context
}
