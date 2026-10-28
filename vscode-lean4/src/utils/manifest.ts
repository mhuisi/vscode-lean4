import * as fs from 'fs'
import { SemVer } from 'semver'
import { z } from 'zod'
import { FileUri } from './exturi'
import { semVerSchema } from './zod'

export interface DirectGitDependency {
    name: string
    uri: string
    revision: string
    inputRevision: string
}

export interface Manifest {
    name: string | undefined
    version: SemVer
    packagesDir: string
    directGitDependencies: DirectGitDependency[]
}

type ManifestVersion =
    | { kind: 'LegacyNumberVersion'; version: number; versionAsSemVer: SemVer }
    | { kind: 'SemVer'; version: SemVer }

function asManifestVersion(versionField: number | SemVer): ManifestVersion {
    if (typeof versionField === 'number') {
        return {
            kind: 'LegacyNumberVersion',
            version: versionField,
            versionAsSemVer: new SemVer(`0.${versionField}.0`),
        }
    }
    return { kind: 'SemVer', version: versionField }
}

function parseVersion1To6Manifest(version: SemVer, parsedJson: any) {
    const version1To6ManifestSchema = z.object({
        name: z.optional(z.string()),
        packagesDir: z.string(),
        packages: z.array(
            z.union([
                z.object({
                    git: z.object({
                        name: z.string(),
                        url: z.string(),
                        rev: z.string(),
                        inherited: z.boolean(),
                        'inputRev?': z.optional(z.nullable(z.string())),
                    }),
                }),
                z.object({
                    path: z.any(),
                }),
            ]),
        ),
    })

    const result = version1To6ManifestSchema.safeParse(parsedJson)
    if (!result.success) {
        return undefined
    }

    const manifest: Manifest = {
        name: result.data.name,
        version,
        packagesDir: result.data.packagesDir,
        directGitDependencies: [],
    }

    for (const pkg of result.data.packages) {
        if (!('git' in pkg)) {
            continue
        }
        if (pkg.git.inherited) {
            continue // Inherited Git packages are not direct dependencies
        }

        manifest.directGitDependencies.push({
            name: pkg.git.name,
            uri: pkg.git.url,
            revision: pkg.git.rev,
            inputRevision: pkg.git['inputRev?'] ?? 'master', // Lake also always falls back to master
        })
    }

    return manifest
}

function parseVersion7ToNManifest(version: SemVer, parsedJson: any) {
    const version7ToNManifestSchema = z.object({
        name: z.string(),
        packagesDir: z.string(),
        packages: z.array(
            z.union([
                z.object({
                    type: z.literal('git'),
                    name: z.string(),
                    url: z.string(),
                    rev: z.string(),
                    inherited: z.boolean(),
                    inputRev: z.optional(z.nullable(z.string())),
                }),
                z.object({
                    type: z.literal('path'),
                }),
            ]),
        ),
    })

    const result = version7ToNManifestSchema.safeParse(parsedJson)
    if (!result.success) {
        return undefined
    }

    const manifest: Manifest = {
        name: result.data.name,
        version,
        packagesDir: result.data.packagesDir,
        directGitDependencies: [],
    }

    for (const pkg of result.data.packages) {
        if (pkg.type !== 'git') {
            continue
        }
        if (pkg.inherited) {
            continue // Inherited Git packages are not direct dependencies
        }

        manifest.directGitDependencies.push({
            name: pkg.name,
            uri: pkg.url,
            revision: pkg.rev,
            inputRevision: pkg.inputRev ?? 'master', // Lake also always falls back to master
        })
    }

    return manifest
}

export function parseAsManifest(jsonString: string): Manifest | undefined {
    let parsedJson: any
    try {
        parsedJson = JSON.parse(jsonString)
    } catch (e) {
        return undefined
    }

    const versionSchema = z.object({
        version: z.union([
            z.number().int().nonnegative(),
            semVerSchema,
        ]),
    })
    const versionResult = versionSchema.safeParse(parsedJson)
    if (!versionResult.success) {
        return undefined
    }
    const version = asManifestVersion(versionResult.data.version)

    if (version.kind === 'LegacyNumberVersion') {
        if (version.version <= 6) {
            return parseVersion1To6Manifest(version.versionAsSemVer, parsedJson)
        } else {
            return parseVersion7ToNManifest(version.versionAsSemVer, parsedJson)
        }
    }
    return parseVersion7ToNManifest(version.version, parsedJson)
}

export type ManifestReadError = string

export async function parseManifestInFolder(folderUri: FileUri): Promise<Manifest | ManifestReadError> {
    const manifestPath: string = folderUri.join('lake-manifest.json').fsPath

    let jsonString: string
    try {
        jsonString = fs.readFileSync(manifestPath, 'utf8')
    } catch (e) {
        return `Cannot read 'lake-manifest.json' file at ${manifestPath}.`
    }

    const manifest: Manifest | undefined = parseAsManifest(jsonString)
    if (!manifest) {
        return `Cannot parse 'lake-manifest.json' file at ${manifestPath}.`
    }

    return manifest
}
