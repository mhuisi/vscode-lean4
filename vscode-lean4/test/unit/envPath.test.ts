import { describe, expect, it } from 'vitest'
import { withoutPSModulePath } from '../../src/utils/envPath'

describe('withoutPSModulePath', () => {
    it('removes `PSModulePath` in each spelling and keeps the other variables', () => {
        const env = {
            PATH: 'C:\\Windows\\System32',
            PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
            PSMODULEPATH: 'C:\\Program Files\\PowerShell\\Modules',
        }
        expect(withoutPSModulePath(env)).toEqual({ PATH: 'C:\\Windows\\System32' })
    })

    it('does not change its argument', () => {
        const env = { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules' }
        withoutPSModulePath(env)
        expect(env).toEqual({ PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules' })
    })
})
