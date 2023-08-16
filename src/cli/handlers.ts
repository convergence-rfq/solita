import {
  RustbinConfig,
  RustbinMatchReturn,
  ConfirmInstallArgs,
  rustbinMatch,
} from '@metaplex-foundation/rustbin'
import { spawn, SpawnOptionsWithoutStdio } from 'child_process'
import { SolitaConfig, SolitaConfigAnchor, SolitaConfigShank } from './types'
import path from 'path'
import { enhanceIdl } from './enhance-idl'
import { generateTypeScriptSDK } from './gen-typescript'
import { logError, logInfo } from '../utils'
import { Options as PrettierOptions } from 'prettier'
import { parse } from 'toml'
import { promises as fs } from 'fs'

export async function handleAnchor(
  config: SolitaConfigAnchor,
  prettierConfig?: PrettierOptions
) {
  const { idlDir, programDir, programName, sdkDir, anchorRemainingAccounts } =
    config
  const spawnArgs = ['build', '--idl', idlDir]
  const spawnOpts: SpawnOptionsWithoutStdio = {
    cwd: programDir,
  }

  const cargoToml = path.join(programDir, 'Cargo.toml')
  const anchorCliVersion = await getAnchorCommandVersion()
  const cargoAnchorVersion = await getAnchorVersionInToml(cargoToml)

  if (anchorCliVersion !== cargoAnchorVersion) {
    throw Error(
      `Anchor version mismatch! Selected anchor cli: ${anchorCliVersion}, in Cargo.toml: ${cargoAnchorVersion}`
    )
  }

  return new Promise<void>((resolve, reject) => {
    const idlGenerator = spawn('anchor', spawnArgs, spawnOpts)
      .on('error', (err) => {
        logError(`${programName} idl generation failed`)
        reject(err)
      })
      .on('exit', async () => {
        logInfo('IDL written to: %s', path.join(idlDir, `${programName}.json`))
        const idl = await enhanceIdl(
          config,
          anchorCliVersion,
          cargoAnchorVersion
        )
        await generateTypeScriptSDK(
          idl,
          sdkDir,
          prettierConfig,
          config.typeAliases,
          config.serializers,
          anchorRemainingAccounts
        )
        resolve()
      })

    idlGenerator.stdout.on('data', (buf) => process.stdout.write(buf))
    idlGenerator.stderr.on('data', (buf) => process.stderr.write(buf))
  })
}

async function getAnchorCommandVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('anchor', ['--version'], { stdio: 'pipe' })

    let stdoutData = ''

    child.stdout.on('data', (data) => {
      stdoutData += data.toString()
    })

    child.on('error', (error) => {
      if (error.name === 'Error' && error.message.includes('ENOENT')) {
        reject('Anchor is not installed!')
        return
      }

      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        const re = /anchor-cli (\d+\.\d+\.\d+)/
        const match = stdoutData.match(re)
        if (match === null) {
          reject('Anchor version matching failed')
        } else {
          resolve(match[1])
        }
      } else {
        reject(new Error(`Process exited with code ${code}`))
      }
    })
  })
}

async function getAnchorVersionInToml(cargoToml: string) {
  const { parsed } = await parseCargoToml(cargoToml)
  const libVersion = parsed.dependencies['anchor-lang']
  if (libVersion == null) {
    throw new Error(`anchor_lang not found as dependency in ${cargoToml}`)
  }
  return typeof libVersion === 'string' ? libVersion : libVersion.version
}

export type CargoToml = {
  dependencies: Record<string, string | { version: string }>
}

export async function parseCargoToml(fullPath: string) {
  let toml
  try {
    toml = await fs.readFile(fullPath, 'utf8')
  } catch (err) {
    logError('Failed to read Cargo.toml at "%s"\n', fullPath, err)
    throw err
  }
  try {
    const parsed: CargoToml = parse(toml)
    return { parsed, toml }
  } catch (err) {
    logError('Failed to parse Cargo.toml:\n%s\n%s', toml, err)
    throw err
  }
}

export function handleShank(
  config: SolitaConfigShank,
  prettierConfig?: PrettierOptions
) {
  const { idlDir, binaryInstallDir, programDir } = config
  const spawnArgs = ['idl', '--out-dir', idlDir, '--crate-root', programDir]
  const spawnOpts: SpawnOptionsWithoutStdio = {
    cwd: programDir,
  }
  const rustbinConfig: RustbinConfig = {
    rootDir: binaryInstallDir,
    binaryName: 'shank',
    binaryCrateName: 'shank-cli',
    libName: 'shank',
    cargoToml: path.join(programDir, 'Cargo.toml'),
    dryRun: false,
  }

  return handle(
    config,
    rustbinConfig,
    spawnArgs,
    spawnOpts,
    prettierConfig,
    false
  )
}

async function handle(
  config: SolitaConfig,
  rustbinConfig: RustbinConfig,
  spawnArgs: string[],
  spawnOpts: SpawnOptionsWithoutStdio,
  prettierConfig?: PrettierOptions,
  anchorRemainingAccounts?: boolean
) {
  const { programName, idlDir, sdkDir } = config

  const { fullPathToBinary, binVersion, libVersion }: RustbinMatchReturn =
    await rustbinMatch(rustbinConfig, confirmAutoMessageLog)

  if (binVersion == null) {
    throw new Error(
      `rustbin was unable to determine installed version ${rustbinConfig.binaryName}, it may ` +
        `not have been installed correctly.`
    )
  }

  return new Promise<void>((resolve, reject) => {
    const idlGenerator = spawn(fullPathToBinary, spawnArgs, spawnOpts)
      .on('error', (err) => {
        logError(`${programName} idl generation failed`)
        reject(err)
      })
      .on('exit', async () => {
        logInfo('IDL written to: %s', path.join(idlDir, `${programName}.json`))
        const idl = await enhanceIdl(config, binVersion, libVersion)
        await generateTypeScriptSDK(
          idl,
          sdkDir,
          prettierConfig,
          config.typeAliases,
          config.serializers,
          anchorRemainingAccounts
        )
        resolve()
      })

    idlGenerator.stdout.on('data', (buf) => process.stdout.write(buf))
    idlGenerator.stderr.on('data', (buf) => process.stderr.write(buf))
  })
}

function confirmAutoMessageLog({
  binaryName,
  libVersion,
  libName,
  binVersion,
  fullPathToBinary,
}: ConfirmInstallArgs) {
  if (binVersion == null) {
    logInfo(`No existing version found for ${binaryName}.`)
  } else {
    logInfo(`Version for ${binaryName}: ${binVersion}`)
  }
  logInfo(
    `Will install version matching "${libName}: '${libVersion}'" to ${fullPathToBinary}`
  )
  return Promise.resolve(true)
}
