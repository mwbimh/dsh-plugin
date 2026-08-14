export function artifactFilename(name: string, version: string): string

export function assessCliCapabilities(help: string, pluginHelp: string): string[]

export function buildProfilePatch(options: {
  lanPort: number
  managementPort: number
  statePath: string
}): string

export function main(): Promise<void>
