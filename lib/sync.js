// Drive folder sync — cold scan + incremental change polling.
//
// Cold path (first run, or after --clear wiped the catalog):
//   drive.files.list with `'<folder_id>' in parents` + recursive walk
//   into subfolders. For each file emit createEntity. Stash the
//   current Drive change-page-token so the next tick goes incremental.
//
// Incremental path:
//   drive.changes.list with `pageToken` from the state table. Drive's
//   change feed reports adds / edits / trashes / renames as ONE
//   stream — we map each to mikser's createEntity / updateEntity /
//   deleteEntity per change type. New nextPageToken persists at the
//   end of the loop so a crash mid-iter doesn't lose progress.
//
// Drive quota stays sane via `pageSize: 100` (default cap) and
// `fields` projections that only ask for the columns we use.

import path from 'node:path'
import { minimatch } from 'minimatch'
import {
    getChangeToken, setChangeToken,
    rememberFile, forgetFile, recordedFile,
} from './state.js'

// Operator-visible noise that nobody wants in their catalog. Always
// excluded unless the author explicitly overrides via a matching
// include pattern that wins.
const DEFAULT_EXCLUDE = [
    '.DS_Store',
    '.~lock.*',
    '~$*',
    'Thumbs.db',
    'desktop.ini',
]

// Glob match against a Drive-side relative path (`subfolder/file.gdoc`).
// Patterns are interpreted with dot=true so `_archive/**` matches inside
// dot-prefixed folders too. include defaults to "match everything";
// exclude wins over include when both match.
export function passesFilters(relativePath, { include, exclude } = {}) {
    const allExcludes = [...DEFAULT_EXCLUDE, ...(exclude ?? [])]
    for (const pattern of allExcludes) {
        if (minimatch(relativePath, pattern, { dot: true, matchBase: true })) return false
    }
    if (include?.length) {
        return include.some(p => minimatch(relativePath, p, { dot: true, matchBase: true }))
    }
    return true
}

const FILE_FIELDS = 'id, name, mimeType, modifiedTime, parents, trashed, size, md5Checksum, webViewLink'
const PAGE_SIZE   = 100

// Build the mikser entity id + uri for a Drive file. The uri is the
// dispatch key the engine's readEntityContent uses to find this
// provider; the id needs to be stable across runs (the file id is
// the only thing Drive guarantees never changes).
function entityFromFile(file, { collection, prefix }) {
    const ext = pickExtension(file)
    const slug = file.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
    const id = path.posix.join(prefix || `/${collection}/drive/`, `${slug}-${file.id}${ext}`)
    return {
        id,
        uri: `gdrive://${file.id}/${slug}${ext}`,
        collection,
        type: collectionToType(collection),
        name: stripExt(`${slug}-${file.id}${ext}`),
        format: ext.replace(/^\./, ''),
        meta: {
            driveId:           file.id,
            driveName:         file.name,
            driveMimeType:     file.mimeType,
            driveModifiedTime: file.modifiedTime,
            driveSize:         file.size ?? null,
            driveMd5:          file.md5Checksum ?? null,
            driveWebViewLink:  file.webViewLink ?? null,
        },
        time: file.modifiedTime ? Date.parse(file.modifiedTime) : Date.now(),
    }
}

function collectionToType(collection) {
    if (collection === 'documents') return 'document'
    if (collection === 'files')     return 'file'
    if (collection === 'assets')    return 'asset'
    return collection
}

// Extension picked from name when present; otherwise inferred from the
// Drive mimeType (Google-native types export to a specific format that
// the read() pipeline produces).
function pickExtension(file) {
    const native = NATIVE_EXT[file.mimeType]
    if (native) return native
    const dot = file.name.lastIndexOf('.')
    return dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
}

function stripExt(name) {
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(0, dot) : name
}

// Default extension contract for Google-native types — what read()
// will produce when content is fetched. Override at config level
// (folder.exportFormats) if you want different mappings.
const NATIVE_EXT = {
    'application/vnd.google-apps.document':     '.md',
    'application/vnd.google-apps.spreadsheet':  '.csv',
    'application/vnd.google-apps.presentation': '.pdf',
    'application/vnd.google-apps.drawing':      '.png',
}

// Iterate every non-trashed file reachable under a root folder. Yields
// `{ file, relativePath }` tuples — the relativePath is the Drive-side
// path from the configured root, used by include/exclude glob matching
// and persisted on the file row so subsequent change events can match
// against the same path without a parents walk.
async function* walkFolder(drive, rootFolderId) {
    const stack = [{ folderId: rootFolderId, basePath: '' }]
    const seen = new Set()
    while (stack.length) {
        const { folderId, basePath } = stack.pop()
        if (seen.has(folderId)) continue
        seen.add(folderId)

        let pageToken
        do {
            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: `nextPageToken, files(${FILE_FIELDS})`,
                pageSize: PAGE_SIZE,
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            })
            for (const file of res.data.files ?? []) {
                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    stack.push({ folderId: file.id, basePath: basePath ? `${basePath}/${file.name}` : file.name })
                    continue
                }
                const relativePath = basePath ? `${basePath}/${file.name}` : file.name
                yield { file, relativePath }
            }
            pageToken = res.data.nextPageToken
        } while (pageToken)
    }
}

// Establish a Drive change-page-token at the current head. Called
// after a cold scan so the next tick can go incremental.
async function getStartChangeToken(drive) {
    const res = await drive.changes.getStartPageToken({
        supportsAllDrives: true,
    })
    return res.data.startPageToken
}

// Cold scan: enumerate every file in the configured folder, emit a
// CREATE for each (after include/exclude filtering). Used on first
// run and after --clear.
export async function coldScan({ drive, folder, createEntity, logger }) {
    let emitted = 0
    let skipped = 0
    for await (const { file, relativePath } of walkFolder(drive, folder.folderId)) {
        if (!passesFilters(relativePath, folder)) {
            skipped++
            continue
        }
        const entity = entityFromFile(file, folder)
        await createEntity(entity)
        rememberFile({
            fileId: file.id,
            folderId: folder.folderId,
            entityId: entity.id,
            name: file.name,
            relativePath,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
        })
        emitted++
    }
    const token = await getStartChangeToken(drive)
    setChangeToken(folder.folderId, token)
    logger.info('gdrive: cold-scanned folder %s — %d files emitted%s',
        folder.folderId, emitted,
        skipped ? ` (${skipped} skipped by include/exclude)` : '')
    return emitted
}

// Incremental poll: list changes since the persisted page-token,
// dispatch each change to the right mikser primitive. Drive's change
// feed reports both folder-scoped and global changes; we filter to
// our configured folder via parents lookup.
export async function pollChanges({ drive, folder, createEntity, updateEntity, deleteEntity, logger }) {
    let pageToken = getChangeToken(folder.folderId)
    if (!pageToken) {
        // Should not happen if cold scan completed; defensive recovery.
        logger.warn('gdrive: no changeToken for folder %s — running cold scan', folder.folderId)
        return await coldScan({ drive, folder, createEntity, logger })
    }

    let processed = 0
    let nextPageToken = pageToken
    do {
        const res = await drive.changes.list({
            pageToken: nextPageToken,
            fields: `nextPageToken, newStartPageToken, changes(fileId, removed, time, file(${FILE_FIELDS}))`,
            pageSize: PAGE_SIZE,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        })

        for (const change of res.data.changes ?? []) {
            const fileId = change.fileId
            const known = recordedFile(fileId)
            const isOurs = known
                || (change.file?.parents ?? []).some(p => p === folder.folderId)
                || await fileIsUnderFolder(drive, change.file, folder.folderId)
            if (!isOurs) continue

            if (change.removed || change.file?.trashed) {
                const entityId = forgetFile(fileId)
                if (entityId) await deleteEntity({ id: entityId, collection: folder.collection })
                processed++
                continue
            }

            // The Drive change may carry a stripped file payload if
            // permissions changed without metadata changes. Skip those.
            if (!change.file) continue

            // Compute relative path for filter matching. Known files keep
            // their cached path (renames inside the same subtree won't move
            // them, only literal directory moves do, and those land in
            // change events as the parents list shifts). Unknown new files
            // walk parents back to the root once.
            const relativePath = known?.relative_path
                ?? await computeRelativePath(drive, change.file, folder.folderId)
                ?? change.file.name

            if (!passesFilters(relativePath, folder)) {
                // If a previously-included file moved into an excluded
                // path (e.g. renamed into _archive/), forget it and tell
                // the catalog. Symmetric to a delete.
                if (known) {
                    const entityId = forgetFile(fileId)
                    if (entityId) await deleteEntity({ id: entityId, collection: folder.collection })
                    processed++
                }
                continue
            }

            const entity = entityFromFile(change.file, folder)
            if (known) {
                await updateEntity(entity)
            } else {
                await createEntity(entity)
            }
            rememberFile({
                fileId,
                folderId: folder.folderId,
                entityId: entity.id,
                name: change.file.name,
                relativePath,
                mimeType: change.file.mimeType,
                modifiedTime: change.file.modifiedTime,
            })
            processed++
        }

        nextPageToken = res.data.nextPageToken
        if (!nextPageToken && res.data.newStartPageToken) {
            // End of stream: persist newStartPageToken for the next poll.
            setChangeToken(folder.folderId, res.data.newStartPageToken)
            break
        }
    } while (nextPageToken)

    if (processed > 0) {
        logger.info('gdrive: polled folder %s — %d changes processed', folder.folderId, processed)
    }
    return processed
}

// Walk Drive parents back to the root and return the relative
// `subfolder/subsubfolder/name` path. Returns null if the walk doesn't
// reach the configured root within MAX_PARENT_WALK hops (defensive
// against pathological deep nesting or permission-clipped trees).
const MAX_PARENT_WALK = 16
async function computeRelativePath(drive, file, rootFolderId) {
    if (!file?.id || !file.name) return null
    const segments = [file.name]
    let currentId = file.parents?.[0]
    let hops = 0
    while (currentId && hops < MAX_PARENT_WALK) {
        if (currentId === rootFolderId) {
            return segments.join('/')
        }
        try {
            const res = await drive.files.get({
                fileId: currentId,
                fields: 'id, name, parents',
                supportsAllDrives: true,
            })
            segments.unshift(res.data.name)
            currentId = res.data.parents?.[0]
            hops++
        } catch {
            return null
        }
    }
    return null
}

// Walk Drive parents to determine if a file is under a given folder.
// Used as a fallback when the change event doesn't include the parents
// list (Drive sometimes elides it on permission-only changes).
async function fileIsUnderFolder(drive, file, rootFolderId) {
    if (!file?.id) return false
    let currentId = file.id
    const visited = new Set()
    while (currentId && !visited.has(currentId)) {
        visited.add(currentId)
        try {
            const res = await drive.files.get({
                fileId: currentId,
                fields: 'parents',
                supportsAllDrives: true,
            })
            const parents = res.data.parents ?? []
            if (parents.includes(rootFolderId)) return true
            currentId = parents[0]
        } catch {
            return false
        }
    }
    return false
}
