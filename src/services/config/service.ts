import {
  bool,
  level_attr,
  makeLogger,
  num,
  str,
  optional,
  log_format,
  json_arr,
} from 'lido-nanolib'

export type ConfigService = ReturnType<typeof makeConfig>

export const makeConfig = ({
  env,
}: {
  logger: ReturnType<typeof makeLogger>
  env: NodeJS.ProcessEnv
}) => ({
  EXECUTION_NODE: str(
    env.EXECUTION_NODE,
    'Please, setup EXECUTION_NODE address. Example: http://1.2.3.4:8545'
  ),
  CONSENSUS_NODE: str(
    env.CONSENSUS_NODE,
    'Please, setup CONSENSUS_NODE address. Example: http://1.2.3.4:5051'
  ),
  LOCATOR_ADDRESS: str(
    env.LOCATOR_ADDRESS,
    'Please, setup LOCATOR_ADDRESS address. Example: 0xXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
  ),
  STAKING_MODULE_ID: str(
    env.STAKING_MODULE_ID,
    'Please, setup STAKING_MODULE_ID id. Example: 123'
  ),
  OPERATOR_ID: str(
    env.OPERATOR_ID,
    'Please, setup OPERATOR_ID id. Example: 123'
  ),
  ORACLE_ADDRESSES_ALLOWLIST: json_arr(
    env.ORACLE_ADDRESSES_ALLOWLIST,
    (oracles) => oracles.map(str),
    'Please, setup ORACLE_ADDRESSES_ALLOWLIST. Example: ["0x123","0x123"]'
  ),

  MESSAGES_LOCATION: optional(() => str(env.MESSAGES_LOCATION)),
  VALIDATOR_EXIT_WEBHOOK: optional(() => str(env.VALIDATOR_EXIT_WEBHOOK)),

  MESSAGES_PASSWORD: optional(() => str(env.MESSAGES_PASSWORD)),

  BLOCKS_PRELOAD: optional(() => num(env.BLOCKS_PRELOAD)) ?? 50000, // 7 days of blocks
  BLOCKS_LOOP: optional(() => num(env.BLOCKS_LOOP)) ?? 64, // 2 epochs
  JOB_INTERVAL: optional(() => num(env.JOB_INTERVAL)) ?? 384000, // 1 epoch

  HTTP_PORT: optional(() => num(env.HTTP_PORT)) ?? false,
  RUN_METRICS: optional(() => bool(env.RUN_METRICS)) ?? false,
  RUN_HEALTH_CHECK: optional(() => bool(env.RUN_HEALTH_CHECK)) ?? false,

  DRY_RUN: optional(() => bool(env.DRY_RUN)) ?? false,
})

export const makeLoggerConfig = ({ env }: { env: NodeJS.ProcessEnv }) => ({
  LOGGER_LEVEL: optional(() => level_attr(env.LOGGER_LEVEL)) ?? 'info',
  LOGGER_FORMAT: optional(() => log_format(env.LOGGER_FORMAT)) ?? 'simple',
  LOGGER_SECRETS:
    optional(() =>
      json_arr(env.LOGGER_SECRETS, (secrets) => secrets.map(str))
    ) ?? [],
})
