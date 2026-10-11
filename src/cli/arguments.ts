export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'summarize'; readonly source: string }
  | { readonly kind: 'init-feed'; readonly stateFile: string }
  | { readonly kind: 'serve'; readonly stateFile: string }
  | {
      readonly kind: 'migrate-feed'
      readonly sourceFile: string
      readonly stateFile: string
    }

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage:
  xlog summarize <file>   Summarize the numbers in <file>, one per line
  xlog summarize -        Summarize the numbers read from stdin
  xlog init-feed <db>               Create a new SQLite feed
  xlog migrate-feed <json> <db>     Copy a JSON feed archive into SQLite
  xlog serve <db>                   Serve the feed API on 127.0.0.1:4318
  xlog --help             Show this help

Exit codes:
  0  success
  1  runtime failure (unreadable input, invalid number)
  2  usage error
`

export function parseArguments(argv: readonly string[]): Command {
  if (argv.length === 0) {
    throw new UsageError('missing command')
  }
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h') {
    return { kind: 'help' }
  }
  if (command === 'migrate-feed') {
    if (rest.length !== 2 || rest.some((part) => part.length === 0)) {
      throw new UsageError(
        'migrate-feed takes a JSON source and SQLite destination',
      )
    }
    const [sourceFile, stateFile] = rest
    if (sourceFile === undefined || stateFile === undefined) {
      throw new UsageError(
        'migrate-feed takes a JSON source and SQLite destination',
      )
    }
    return { kind: 'migrate-feed', sourceFile, stateFile }
  }
  if (
    command !== 'summarize' &&
    command !== 'init-feed' &&
    command !== 'serve'
  ) {
    throw new UsageError(`unknown command: ${command}`)
  }
  if (rest.length !== 1) {
    throw new UsageError(
      command === 'summarize'
        ? 'summarize takes exactly one source: a file path or -'
        : `${command} takes exactly one state file path`,
    )
  }
  const [source] = rest
  if (source === undefined || source.length === 0) {
    throw new UsageError(
      command === 'summarize'
        ? 'summarize source must not be empty'
        : `${command} state file path must not be empty`,
    )
  }
  return command === 'summarize'
    ? { kind: 'summarize', source }
    : { kind: command, stateFile: source }
}
