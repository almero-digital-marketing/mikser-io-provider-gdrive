// mikser-io-provider-gdrive — Google Drive as a content source for mikser-io.
//
// Two surfaces in one package, following the v9 provider convention:
//
//   1. `providerGdrive(options)` — the lifecycle plugin. Sits in your
//      mikser.config.js `plugins: []`. Handles auth init, folder
//      polling, entity emission. Configured here; module-level state
//      (the auth'd drive client + the cache folder) is initialized
//      from its onLoaded.
//
//   2. `read(entity)` — the top-level named export. The mikser engine
//      calls this when something asks for the content of an entity
//      with a `gdrive://` uri (see mikser-io's
//      src/utils.js readEntityContent — it dynamic-imports
//      `mikser-io-provider-<scheme>` and calls that module's `read`).
//      Reuses the drive client + cacheFolder set up by the lifecycle
//      plugin via module-level variables.
//
// Module-level state is the simplest way to share auth between the
// lifecycle plugin and the read export — they live in the same Node
// module instance, so the cache survives between init and any number
// of subsequent read calls. If a future plugin author needs multiple
// gdrive instances with different accounts, the architecture would
// need a per-instance scope, but for v1 one Drive identity per mikser
// project is the sane default.

import path from 'node:path'
import './lib/state.js'                    // side-effect: registerSchema
import { createDriveClient } from './lib/auth.js'
import { coldScan, pollChanges } from './lib/sync.js'
import { readDriveEntity } from './lib/content.js'

let drive
let cacheFolder
let exportFormats
let logger

// v9 factory. Returns a `(core) => void` lifecycle plugin — the
// canonical mikser plugin shape (ADR-0010).
export function providerGdrive(options = {}) {
    return ({
        runtime,
        onLoaded,
        onImport,
        useLogger,
        createEntity, updateEntity, deleteEntity,
    }) => {
        logger = null  // captured at onLoaded time, after useLogger() works
        exportFormats = options.exportFormats

        const folders = Array.isArray(options.folders) ? options.folders : []
        if (folders.length === 0) {
            // Defensive: surface this immediately at onLoaded rather
            // than letting the plugin silently do nothing.
            onLoaded(() => {
                useLogger().warn(
                    'gdrive: no folders configured. Set providerGdrive({ folders: [{ folderId, collection }] }).'
                )
            })
            return
        }

        onLoaded(async () => {
            logger = useLogger()
            cacheFolder = options.cacheFolder
                ?? path.join(runtime.options.runtimeFolder ?? path.join(runtime.options.workingFolder, 'runtime'), 'gdrive-cache')

            const result = await createDriveClient(options.auth)
            drive = result.drive
            logger.info('gdrive: authenticated as %s (cache: %s)', result.identity, cacheFolder)

            const watchModeMs = options.pollIntervalMs ?? 30_000
            if (runtime.options.watch && watchModeMs > 0) {
                const tick = async () => {
                    try {
                        for (const folder of folders) {
                            await pollChanges({
                                drive, folder,
                                createEntity, updateEntity, deleteEntity,
                                logger,
                            })
                        }
                    } catch (err) {
                        logger.error('gdrive: poll tick failed — %s', err.message)
                    }
                }
                const handle = setInterval(tick, watchModeMs)
                handle.unref?.()
                logger.info('gdrive: watch poll every %dms', watchModeMs)
            }
        })

        // Cold scan or incremental — onImport is the right mikser hook:
        // it fires once at engine start, AFTER lifecycle init. For each
        // folder, decide based on whether we have a persisted change
        // token (cold scan if not, incremental if yes).
        onImport(async () => {
            for (const folder of folders) {
                const { getChangeToken } = await import('./lib/state.js')
                if (getChangeToken(folder.folderId)) {
                    await pollChanges({
                        drive, folder,
                        createEntity, updateEntity, deleteEntity,
                        logger,
                    })
                } else {
                    await coldScan({
                        drive, folder,
                        createEntity,
                        logger,
                    })
                }
            }
        })
    }
}

// Top-level named export — what the engine's readEntityContent
// dispatches into when an entity's uri starts with `gdrive://`. See
// mikser-io's src/utils.js for the dispatch shape (parses scheme out
// of entity.uri, dynamic-imports `mikser-io-provider-${scheme}`,
// calls `mod.read(entity)`).
export async function read(entity) {
    return readDriveEntity(entity, {
        drive,
        cacheFolder,
        exportFormats,
        logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    })
}
