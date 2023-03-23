import bls from '@chainsafe/bls'
import { decrypt } from '@chainsafe/bls-keystore'

import { ssz } from '@lodestar/types'
import { fromHex, toHexString } from '@lodestar/utils'
import { DOMAIN_VOLUNTARY_EXIT } from '@lodestar/params'
import { computeDomain, computeSigningRoot } from '@lodestar/state-transition'

import { encryptedMessageDTO, exitOrEthDoExitDTO } from './dto.js'

import type { LoggerService } from 'lido-nanolib'
import type { ConsensusApiService } from '../consensus-api/service.js'
import type { ExecutionApiService } from '../execution-api/service.js'
import type { ConfigService } from '../config/service.js'
import type { MetricsService } from '../prom/service.js'
import type { S3StoreService } from '../s3-store/service.js'
import type { GsStoreService } from '../gs-store/service.js'

type ExitMessage = {
  message: {
    epoch: string
    validator_index: string
  }
  signature: string
}

type EthDoExitMessage = {
  exit: ExitMessage
  fork_version: string
}

export type MessagesProcessorService = ReturnType<typeof makeMessagesProcessor>

export const makeMessagesProcessor = ({
  logger,
  config,
  consensusApi,
  executionApi,
  metrics,
  s3Service,
  gsService,
}: {
  logger: LoggerService
  config: ConfigService
  consensusApi: ConsensusApiService
  executionApi: ExecutionApiService
  metrics: MetricsService
  s3Service: S3StoreService
  gsService: GsStoreService
}) => {
  const load = async () => {
    const messages: ExitMessage[] = []

    for (const file of config.MESSAGES_LOCATIONS) {
      let read: string
      try {
        read = await readFile(file)
      } catch (error) {
        logger.warn(`Unparseable read file ${file}`, error)
        continue
      }
      
      let json: Record<string, unknown>
      try {
        json = JSON.parse(read)
      } catch (error) {
        logger.warn(`Unparseable JSON in file ${file}`, error)
        metrics.exitMessages.inc({
          valid: 'false',
        })
        continue
      }

      if ('crypto' in json) {
        try {
          json = await decryptMessage(json)
        } catch (e) {
          logger.warn(`Unable to decrypt encrypted file: ${file}`)
          metrics.exitMessages.inc({
            valid: 'false',
          })
          continue
        }
      }

      let validated: ExitMessage | EthDoExitMessage

      try {
        validated = exitOrEthDoExitDTO(json)
      } catch (e) {
        logger.error(`${file} failed validation:`, e)
        metrics.exitMessages.inc({
          valid: 'false',
        })
        continue
      }

      const message = 'exit' in validated ? validated.exit : validated
      messages.push(message)
    }

    return messages
  }

  const readFile = async (uri: string): Promise<string> => {
    return uri.startsWith('s3://') ? s3Service.read(uri) : gsService.read(uri)
  }

  const decryptMessage = async (input: Record<string, unknown>) => {
    if (!config.MESSAGES_PASSWORD) {
      throw new Error('Password was not supplied')
    }

    const checked = encryptedMessageDTO(input)

    const content = await decrypt(checked, config.MESSAGES_PASSWORD)

    const stringed = new TextDecoder().decode(content)

    let json: Record<string, unknown>
    try {
      json = JSON.parse(stringed)
    } catch {
      throw new Error('Unparseable JSON after decryption')
    }

    return json
  }

  const verify = async (messages: ExitMessage[]): Promise<ExitMessage[]> => {
    const genesis = await consensusApi.genesis()
    const state = await consensusApi.state()

    const validMessages: ExitMessage[] = []

    for (const m of messages) {
      const { message, signature: rawSignature } = m
      const { validator_index: validatorIndex, epoch } = message

      let validatorInfo: { pubKey: string; isExiting: boolean }
      try {
        validatorInfo = await consensusApi.validatorInfo(validatorIndex)
      } catch (e) {
        logger.error(
          `Failed to get validator info for index ${validatorIndex}`,
          e
        )
        metrics.exitMessages.inc({
          valid: 'false',
        })
        continue
      }

      if (validatorInfo.isExiting) {
        logger.debug(`${validatorInfo.pubKey} exiting(ed), skipping validation`)
        metrics.exitMessages.inc({
          valid: 'false',
        })
        continue
      }

      const pubKey = fromHex(validatorInfo.pubKey)
      const signature = fromHex(rawSignature)

      const GENESIS_VALIDATORS_ROOT = fromHex(genesis.genesis_validators_root)
      const CURRENT_FORK = fromHex(state.current_version)
      const PREVIOUS_FORK = fromHex(state.previous_version)

      const verifyFork = (fork: Uint8Array) => {
        const domain = computeDomain(
          DOMAIN_VOLUNTARY_EXIT,
          fork,
          GENESIS_VALIDATORS_ROOT
        )

        const parsedExit = {
          epoch: parseInt(epoch, 10),
          validatorIndex: parseInt(validatorIndex, 10),
        }

        const signingRoot = computeSigningRoot(
          ssz.phase0.VoluntaryExit,
          parsedExit,
          domain
        )

        const isValid = bls.verify(pubKey, signingRoot, signature)

        logger.debug(
          `Singature ${
            isValid ? 'valid' : 'invalid'
          } for validator ${validatorIndex} for fork ${toHexString(fork)}`
        )

        return isValid
      }

      let isValid = false

      isValid = verifyFork(CURRENT_FORK)
      if (!isValid) isValid = verifyFork(PREVIOUS_FORK)

      if (!isValid) {
        logger.error(`Invalid signature for validator ${validatorIndex}`)
        metrics.exitMessages.inc({
          valid: 'false',
        })
        continue
      }

      validMessages.push(m)

      metrics.exitMessages.inc({
        valid: 'true',
      })
    }

    return validMessages
  }

  const exit = async (messages: ExitMessage[], pubKey: string) => {
    if ((await consensusApi.validatorInfo(pubKey)).isExiting) {
      logger.debug(
        `Exit was initiated, but ${pubKey} is already exiting(ed), skipping`
      )
      return
    }

    const validatorIndex = (await consensusApi.validatorInfo(pubKey)).index
    const message = messages.find(
      (msg) => msg.message.validator_index === validatorIndex
    )

    if (!message) {
      logger.error(
        'Validator needs to be exited but required message was not found / accessible!'
      )
      metrics.exitActions.inc({ result: 'error' })
      return
    }

    try {
      await consensusApi.exitRequest(message)
      logger.info(
        'Voluntary exit message sent successfully to Consensus Layer',
        { pubKey, validatorIndex }
      )
      metrics.exitActions.inc({ result: 'success' })
    } catch (e) {
      logger.error(
        'Failed to send out exit message',
        e instanceof Error ? e.message : e
      )
      metrics.exitActions.inc({ result: 'error' })
    }
  }

  const runJob = async ({
    eventsNumber,
    messages,
  }: {
    eventsNumber: number
    messages: ExitMessage[]
  }) => {
    logger.info('Job started', {
      operatorId: config.OPERATOR_ID,
      stakingModuleId: config.STAKING_MODULE_ID,
      loadedMessages: messages.length,
    })

    // Resolving contract addresses on each job to automatically pick up changes without requiring a restart
    await executionApi.resolveExitBusAddress()
    await executionApi.resolveConsensusAddress()

    const toBlock = await executionApi.latestBlockNumber()
    const fromBlock = toBlock - eventsNumber
    logger.info('Fetched the latest block from EL', { latestBlock: toBlock })

    logger.info('Fetching request events from the Exit Bus', {
      eventsNumber,
      fromBlock,
      toBlock,
    })

    const eventsForEject = await executionApi.logs(fromBlock, toBlock)

    logger.info('Handling ejection requests', {
      amount: eventsForEject.length,
    })

    for (const event of eventsForEject) {
      logger.info('Handling exit', event)
      try {
        await exit(messages, event.validatorPubkey)
      } catch (e) {
        logger.error(`Unable to process exit for ${event.validatorPubkey}`, e)
      }
    }

    logger.info('Job finished')
  }

  return { load, verify, exit, runJob }
}
