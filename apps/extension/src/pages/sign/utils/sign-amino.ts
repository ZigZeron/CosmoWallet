import { EthSignType, GasPrice } from '@leapwallet/cosmos-wallet-sdk'
import BigNumber from 'bignumber.js'

import { getStdFee } from './get-fee'

export function getAminoSignDoc({
  signRequestData,
  gasPrice,
  gasLimit,
  isAdr36,
  memo,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signRequestData: Record<string, any>
  gasPrice: GasPrice
  gasLimit: string
  memo: string
  isAdr36?: boolean
}) {
  const signDoc = signRequestData['sign-request'].signDoc
  const signOptions = signRequestData['sign-request'].signOptions

  const defaultFee = signDoc.fee
  const defaultMemo = signDoc.memo

  const sortedSignDoc = {
    chain_id: signDoc.chain_id ?? signDoc.chainId,
    account_number: signDoc.account_number ?? signDoc.accountNumber,
    sequence: signDoc.sequence,
    fee: defaultFee,
    memo: defaultMemo,
    msgs: signDoc.msgs,
  }

  if (!isAdr36) {
    const customGasLimit = new BigNumber(gasLimit)

    const fee = signOptions?.preferNoSetFee
      ? sortedSignDoc.fee
      : getStdFee(
          !customGasLimit.isNaN() && customGasLimit.isGreaterThan(0)
            ? customGasLimit.toString()
            : 'gasLimit' in sortedSignDoc.fee
            ? sortedSignDoc.fee.gasLimit
            : sortedSignDoc.fee.gas,
          gasPrice,
        )

    sortedSignDoc.fee = fee
  }

  if (!defaultMemo) {
    sortedSignDoc.memo = memo
  }

  return {
    signDoc: { ...sortedSignDoc },
    fee: sortedSignDoc.fee,
    allowSetFee: !signOptions?.preferNoSetFee,
    defaultFee,
    defaultMemo,
  }
}