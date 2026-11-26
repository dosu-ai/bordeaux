import { describe, expect, it } from 'vitest'
import { Lru } from '../src/worker/lru.ts'

describe('what an isolate keeps per team', () => {
  it('keeps at most its limit, dropping what was used longest ago', () => {
    const kept = new Lru<string, number>(2)
    kept.set('a', 1).set('b', 2)
    kept.get('a')
    kept.set('c', 3)
    expect([...kept.keys()]).toEqual(['a', 'c'])
    expect(kept.get('b')).toBeUndefined()
  })
})
