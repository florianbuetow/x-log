import { describe, expect, it } from 'vitest'

import { parseArguments, UsageError } from '../../src/cli/arguments.js'

describe('parseArguments', () => {
  it('recognizes both help flags', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' })
    expect(parseArguments(['-h'])).toEqual({ kind: 'help' })
  })

  it('parses a summarize command with a file source', () => {
    expect(parseArguments(['summarize', 'data/numbers.txt'])).toEqual({
      kind: 'summarize',
      source: 'data/numbers.txt',
    })
  })

  it('parses a summarize command that reads stdin', () => {
    expect(parseArguments(['summarize', '-'])).toEqual({
      kind: 'summarize',
      source: '-',
    })
  })

  it('parses feed database commands with explicit paths', () => {
    expect(parseArguments(['init-feed', 'feed.sqlite'])).toEqual({
      kind: 'init-feed',
      stateFile: 'feed.sqlite',
    })
    expect(parseArguments(['serve', 'feed.sqlite'])).toEqual({
      kind: 'serve',
      stateFile: 'feed.sqlite',
    })
    expect(parseArguments(['migrate-feed', 'old.json', 'feed.sqlite'])).toEqual(
      {
        kind: 'migrate-feed',
        sourceFile: 'old.json',
        stateFile: 'feed.sqlite',
      },
    )
  })

  it('requires both migration paths and rejects empty paths', () => {
    expect(() => parseArguments(['migrate-feed'])).toThrow(
      'JSON source and SQLite destination',
    )
    expect(() => parseArguments(['migrate-feed', 'old.json'])).toThrow(
      'JSON source and SQLite destination',
    )
    expect(() => parseArguments(['migrate-feed', 'old.json', ''])).toThrow(
      'JSON source and SQLite destination',
    )
    expect(() => parseArguments(['init-feed', ''])).toThrow(
      'state file path must not be empty',
    )
    expect(() => parseArguments(['serve'])).toThrow(
      'takes exactly one state file path',
    )
  })

  it('rejects a missing command', () => {
    expect(() => parseArguments([])).toThrow(UsageError)
    expect(() => parseArguments([])).toThrow('missing command')
  })

  it('rejects an unknown command', () => {
    expect(() => parseArguments(['frobnicate'])).toThrow(
      'unknown command: frobnicate',
    )
  })

  it('rejects a missing or surplus source', () => {
    expect(() => parseArguments(['summarize'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
    expect(() => parseArguments(['summarize', 'a', 'b'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
  })

  it('rejects an empty source', () => {
    expect(() => parseArguments(['summarize', ''])).toThrow(
      'summarize source must not be empty',
    )
  })
})
