import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

describe('Loader export shape', () => {
  it('keeps both entries as named function plugins', () => {
    expect('default' in plugin).toBe(false)
    expect(Loader.prototype.unwrapExports(plugin)).toBe(plugin)
    expect('default' in invariant).toBe(false)
    expect(Loader.prototype.unwrapExports(invariant)).toBe(invariant)
  })
})
