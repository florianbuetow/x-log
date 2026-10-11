import { describe, expect, it } from 'vitest'

import { parseImageDescriptors } from '../../src/application/image-files.js'

const image = {
  url: 'https://pbs.twimg.com/media/HUSb9onbUAA7C0V?format=jpg&name=medium',
  mediaId: 'HUSb9onbUAA7C0V',
  position: 1,
}

describe('image descriptors', () => {
  it('accepts a rendered X media URL on an original post', () => {
    expect(parseImageDescriptors([image], true)).toEqual([image])
    expect(parseImageDescriptors(undefined, true)).toEqual([])
    expect(parseImageDescriptors([], false)).toEqual([])
  })

  it('rejects image descriptors on replies', () => {
    expect(() => parseImageDescriptors([image], false)).toThrow('reply images')
  })

  it.each([
    null,
    'not an array',
    Array.from({ length: 11 }, (_, index) => ({
      ...image,
      mediaId: `media${index}`,
      position: index + 1,
    })),
  ])('rejects invalid image collections %#', (value) => {
    expect(() => parseImageDescriptors(value, true)).toThrow(
      'images must be an array',
    )
  })

  it.each([
    [null, 'descriptor must be an object'],
    [{ ...image, mediaId: '' }, 'mediaId is invalid'],
    [{ ...image, mediaId: '../escape' }, 'mediaId is invalid'],
    [{ ...image, position: 0 }, 'position must be an integer'],
    [{ ...image, position: 11 }, 'position must be an integer'],
    [{ ...image, position: 1.5 }, 'position must be an integer'],
    [{ ...image, position: '1' }, 'position must be an integer'],
    [{ ...image, url: 42 }, 'URL must be a string'],
    [{ ...image, url: 'not a URL' }, 'URL is invalid'],
    [
      { ...image, url: 'http://pbs.twimg.com/media/HUSb9onbUAA7C0V' },
      'pbs.twimg.com media URL',
    ],
    [
      {
        ...image,
        url: 'https://pbs.twimg.com.evil.example/media/HUSb9onbUAA7C0V',
      },
      'pbs.twimg.com media URL',
    ],
    [
      {
        ...image,
        url: 'https://user:pass@pbs.twimg.com/media/HUSb9onbUAA7C0V',
      },
      'pbs.twimg.com media URL',
    ],
    [
      { ...image, url: 'https://pbs.twimg.com/media/HUSb9onbUAA7C0V#fragment' },
      'pbs.twimg.com media URL',
    ],
    [
      { ...image, url: 'https://pbs.twimg.com/other/HUSb9onbUAA7C0V' },
      'pbs.twimg.com media URL',
    ],
    [
      { ...image, url: 'https://pbs.twimg.com/media/different' },
      'pbs.twimg.com media URL',
    ],
  ] as const)(
    'rejects unsafe or malformed descriptor %#',
    (candidate, message) => {
      expect(() => parseImageDescriptors([candidate], true)).toThrow(message)
    },
  )

  it('rejects duplicate media IDs and positions within one post', () => {
    expect(() =>
      parseImageDescriptors([image, { ...image, position: 2 }], true),
    ).toThrow('duplicate image')
    expect(() =>
      parseImageDescriptors(
        [
          image,
          {
            url: 'https://pbs.twimg.com/media/another',
            mediaId: 'another',
            position: 1,
          },
        ],
        true,
      ),
    ).toThrow('duplicate image')
  })
})
