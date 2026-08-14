import { execFileSync } from 'node:child_process'

const packageManagerCli = process.env.npm_execpath

if (packageManagerCli === undefined) {
  throw new Error('pack check requires a package-manager lifecycle with npm_execpath')
}

execFileSync(process.execPath, [
  packageManagerCli,
  'pack',
  '--pack-destination',
  '.pack',
], { stdio: 'inherit' })
