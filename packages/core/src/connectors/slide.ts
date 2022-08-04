import SlideSDK, { SlideInitOptions } from '@slide-web3/sdk'
import { providers } from 'ethers'
import { getAddress, hexValue } from 'ethers/lib/utils'

import {
  AddChainError,
  ChainNotConfiguredError,
  ProviderRpcError,
  SwitchChainError,
  UserRejectedRequestError,
} from '../errors'
import { Chain } from '../types'
import { normalizeChainId } from '../utils'
import { Connector } from './base'
import { SendReturn, SendReturnResult } from './types/slide'

type Options = SlideInitOptions

function parseSendReturn(sendReturn: SendReturnResult | SendReturn): any {
  return Object.prototype.hasOwnProperty.call(sendReturn, 'result')
    ? sendReturn.result
    : sendReturn
}

export class SlideConnector extends Connector<
  SlideSDK,
  Options,
  providers.JsonRpcSigner
> {
  readonly id = 'slide'
  readonly name = 'Slide'
  readonly ready = true

  #initOptions: SlideInitOptions

  #client?: SlideSDK
  #provider?: SlideSDK

  constructor(
    { chains, options }: { chains?: Chain[]; options: Options },
    initializeImmediately = false,
  ) {
    super({
      chains,
      options,
    })

    this.#initOptions = options

    if (initializeImmediately) {
      this.init()
    }

    this.onChainChanged = this.onChainChanged.bind(this)
    this.onAccountsChanged = this.onAccountsChanged.bind(this)
    this.onDisconnect = this.onDisconnect.bind(this)
  }

  public async init(): Promise<void> {
    if (!this.#provider) {
      const SlideSdk = await import('@slide-web3/sdk').then(
        (m) => m?.default ?? m,
      )
      this.#provider = new SlideSdk(this.#initOptions)
      this.#client = this.#provider
      await this.#provider.init()
    }
  }

  async connect({ chainId }: { chainId?: number } = {}) {
    try {
      const provider = await this.getProvider()
      provider.on('accountsChanged', this.onAccountsChanged)
      provider.on('chainChanged', this.onChainChanged)
      provider.on('disconnect', this.onDisconnect)

      this.emit('message', { type: 'connecting' })

      const accounts = await provider.enable()
      const account = getAddress(<string>accounts[0])
      // Switch to chain if provided
      let id = await this.getChainId()
      let unsupported = this.isChainUnsupported(id)
      if (chainId && id !== chainId) {
        const chain = await this.switchChain(chainId)
        id = chain.id
        unsupported = this.isChainUnsupported(id)
      }

      return {
        account,
        chain: { id, unsupported },
        provider: new providers.Web3Provider(
          <providers.ExternalProvider>(<unknown>provider),
        ),
      }
    } catch (error) {
      if (
        /(user closed modal|accounts received is empty)/i.test(
          (<ProviderRpcError>error).message,
        )
      )
        throw new UserRejectedRequestError(error)
      throw error
    }
  }

  async disconnect() {
    if (!this.#provider) return

    const provider = await this.getProvider()
    provider.removeListener('accountsChanged', this.onAccountsChanged)
    provider.removeListener('chainChanged', this.onChainChanged)
    provider.removeListener('disconnect', this.onDisconnect)
    provider.close()
  }

  async getAccount() {
    const provider = await this.getProvider()
    const accounts = await provider.request({
      method: 'eth_accounts',
    })

    return parseSendReturn(accounts)[0]
  }

  async getChainId() {
    const provider = await this.getProvider()

    let chainId
    try {
      chainId = await provider
        .request({ method: 'eth_chainId' })
        .then(parseSendReturn)
    } catch (e) {
      alert('eth_chainId was unsuccessful, falling back to net_version')
    }

    if (!chainId) {
      try {
        chainId = await provider
          .request({ method: 'net_version' })
          .then(parseSendReturn)
      } catch {
        alert('net_version was unsuccessful, falling back to net version v2')
      }
    }

    if (!chainId) {
      try {
        chainId = parseSendReturn(
          await provider.request({ method: 'net_version' }),
        )
      } catch {
        alert(
          'net_version v2 was unsuccessful, falling back to manual matches and static properties',
        )
      }
    }

    return chainId
  }

  async getProvider(): Promise<any> {
    if (!this.#provider) {
      await this.init()
    }

    return this.#provider
  }

  async getSigner() {
    const [provider, account] = await Promise.all([
      this.getProvider(),
      this.getAccount(),
    ])

    return new providers.Web3Provider(
      <providers.ExternalProvider>(<unknown>provider),
    ).getSigner(account)
  }

  async isAuthorized(): Promise<boolean> {
    const provider = await this.getProvider()

    try {
      return await provider
        .request({ method: 'eth_accounts' })
        .then((sendReturn: any) => {
          return parseSendReturn(sendReturn).length > 0
        })
    } catch {
      return false
    }
  }

  async switchChain(chainId: number) {
    const provider = await this.getProvider()
    const id = hexValue(chainId)

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: id }],
      })
      return (
        this.chains.find((x) => x.id === chainId) ?? {
          id: chainId,
          name: `Chain ${id}`,
          network: `${id}`,
          rpcUrls: { default: '' },
        }
      )
    } catch (error) {
      const chain = this.chains.find((x) => x.id === chainId)
      if (!chain) throw new ChainNotConfiguredError()

      // Indicates chain is not added to provider
      if ((<ProviderRpcError>error).code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: id,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: [chain.rpcUrls.public ?? chain.rpcUrls.default],
                blockExplorerUrls: this.getBlockExplorerUrls(chain),
              },
            ],
          })
          return chain
        } catch (addError) {
          if (this.#isUserRejectedRequestError(addError))
            throw new UserRejectedRequestError(addError)
          throw new AddChainError()
        }
      }

      if (this.#isUserRejectedRequestError(error))
        throw new UserRejectedRequestError(error)
      throw new SwitchChainError(error)
    }
  }

  async watchAsset({
    address,
    decimals = 18,
    image,
    symbol,
  }: {
    address: string
    decimals?: number
    image?: string
    symbol: string
  }) {
    const provider = await this.getProvider()
    return await provider.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: {
          address,
          decimals,
          image,
          symbol,
        },
      },
    })
  }

  protected onAccountsChanged = (accounts: string[]): void => {
    if (accounts.length === 0) this.emit('disconnect')
    else this.emit('change', { account: getAddress(<string>accounts[0]) })
  }

  protected onChainChanged = (chainId: number | string) => {
    const id = normalizeChainId(chainId)
    const unsupported = this.isChainUnsupported(id)
    this.emit('change', { chain: { id, unsupported } })
  }

  protected onDisconnect = () => {
    this.emit('disconnect')
  }

  #isUserRejectedRequestError(error: unknown) {
    return /(user rejected)/i.test((<Error>error).message)
  }
}
