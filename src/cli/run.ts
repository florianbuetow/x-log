import { once } from 'node:events'
import { join } from 'node:path'

import {
  initializeFeedFile,
  migrateFeedFile,
  openFeedStore,
} from '../application/feed-store.js'
import { summarizeText } from '../application/summarize-text.js'
import { parseArguments, USAGE, UsageError } from './arguments.js'
import { startFeedServer } from './feed-server.js'
import { readInput } from './input.js'

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const command = parseArguments(argv)
    if (command.kind === 'help') {
      io.stdout.write(USAGE)
      return EXIT_SUCCESS
    }
    if (command.kind === 'init-feed') {
      await initializeFeedFile(command.stateFile)
      io.stdout.write(
        `${JSON.stringify({ stateFile: command.stateFile, followedHandles: [] })}\n`,
      )
      return EXIT_SUCCESS
    }
    if (command.kind === 'migrate-feed') {
      const followedHandles = await migrateFeedFile(
        command.sourceFile,
        command.stateFile,
      )
      io.stdout.write(
        `${JSON.stringify({ sourceFile: command.sourceFile, stateFile: command.stateFile, followedHandles })}\n`,
      )
      return EXIT_SUCCESS
    }
    if (command.kind === 'serve') {
      const store = await openFeedStore(command.stateFile, {
        imageRoot: join(process.cwd(), 'data', 'media'),
      })
      try {
        const server = await startFeedServer(store, 4318)
        io.stderr.write('feed service listening on http://127.0.0.1:4318\n')
        await once(server, 'close')
        return EXIT_SUCCESS
      } finally {
        store.close()
      }
    }
    const input = await readInput(command.source, io.stdin)
    const summary = summarizeText(input)
    io.stdout.write(`${JSON.stringify(summary)}\n`)
    return EXIT_SUCCESS
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`error: ${message}\n`)
    if (error instanceof UsageError) {
      io.stderr.write(USAGE)
      return EXIT_USAGE
    }
    return EXIT_FAILURE
  }
}
