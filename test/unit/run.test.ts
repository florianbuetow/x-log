import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  run,
  type CliIo,
} from '../../src/cli/run.js'

interface Captured {
  readonly io: CliIo
  readonly stdout: () => string
  readonly stderr: () => string
}

function capture(stdinText: string): Captured {
  const out: string[] = []
  const err: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')))
  return {
    io: { stdin: Readable.from([stdinText]), stdout, stderr },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

describe('run', () => {
  it('prints usage and succeeds for --help', async () => {
    const captured = capture('')
    expect(await run(['--help'], captured.io)).toBe(EXIT_SUCCESS)
    expect(captured.stdout()).toContain('Usage:')
    expect(captured.stderr()).toBe('')
  })

  it('summarizes stdin as JSON', async () => {
    const captured = capture('1\n2\n3\n')
    expect(await run(['summarize', '-'], captured.io)).toBe(EXIT_SUCCESS)
    expect(JSON.parse(captured.stdout())).toEqual({
      count: 3,
      min: 1,
      max: 3,
      mean: 2,
    })
  })

  it('returns the usage exit code and prints usage to stderr for bad arguments', async () => {
    const captured = capture('')
    expect(await run(['frobnicate'], captured.io)).toBe(EXIT_USAGE)
    expect(captured.stdout()).toBe('')
    expect(captured.stderr()).toContain('error: unknown command: frobnicate')
    expect(captured.stderr()).toContain('Usage:')
  })

  it('returns the failure exit code for invalid input', async () => {
    const captured = capture('1\nnope\n')
    expect(await run(['summarize', '-'], captured.io)).toBe(EXIT_FAILURE)
    expect(captured.stderr()).toBe('error: line 2 is not a number: "nope"\n')
  })

  it('returns the failure exit code for an unreadable file', async () => {
    const captured = capture('')
    expect(
      await run(['summarize', 'data/does-not-exist.txt'], captured.io),
    ).toBe(EXIT_FAILURE)
    expect(captured.stderr()).toBe(
      'error: cannot read input from data/does-not-exist.txt\n',
    )
  })

  it('initializes and migrates SQLite feeds through the CLI layer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'run-feed-'))
    const initialized = join(dir, 'new.sqlite')
    const source = join(dir, 'old.json')
    const migrated = join(dir, 'migrated.sqlite')
    const initIo = capture('')
    expect(await run(['init-feed', initialized], initIo.io)).toBe(EXIT_SUCCESS)
    expect(JSON.parse(initIo.stdout())).toEqual({
      stateFile: initialized,
      followedHandles: [],
    })
    await writeFile(
      source,
      JSON.stringify({
        version: 1,
        followedHandles: ['another'],
        posts: {},
        threads: {},
      }),
    )
    const migrateIo = capture('')
    expect(await run(['migrate-feed', source, migrated], migrateIo.io)).toBe(
      EXIT_SUCCESS,
    )
    expect(JSON.parse(migrateIo.stdout())).toEqual({
      sourceFile: source,
      stateFile: migrated,
      followedHandles: ['another'],
    })
  })

  it('reports a missing SQLite database as a runtime failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'run-feed-'))
    const captured = capture('')
    expect(await run(['serve', join(dir, 'missing.sqlite')], captured.io)).toBe(
      EXIT_FAILURE,
    )
    expect(captured.stdout()).toBe('')
    expect(captured.stderr()).toContain('file does not exist')
  })
})
