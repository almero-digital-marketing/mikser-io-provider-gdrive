// `read(entity)` implementation — what the engine calls when something
// downstream needs the content of a gdrive:// entity.
//
// Three families based on Drive mimeType:
//
//   - Google-native types (Docs / Sheets / Slides / Drawings) are
//     exported via drive.files.export to a chosen format. Output is
//     text (markdown / csv) for Docs and Sheets; binary (pdf / png)
//     for Slides and Drawings — those are mirrored to the local
//     cache and returned via contentSkipped pointing at the path.
//
//   - Plain text and code (.md, .txt, .html, .css, .json, .yml, ...)
//     come back via drive.files.get with alt=media. Returned as
//     { content: <text> }.
//
//   - Anything else binary (PDF, image, video, audio) is streamed to
//     the local cache folder. We return { contentSkipped } with the
//     local path so downstream plugins (assets, post-pdf, etc.) can
//     read it as a regular file. After the mirror lands, the entity
//     can be re-emitted with entity.uri = <local path> if you prefer
//     the local-fs read path entirely — but the default is to keep
//     gdrive:// as the canonical uri and let the cache live alongside.
//
// MIME-to-export defaults can be overridden per-folder in the plugin
// options. Anything not in the map and not text-shaped falls into the
// binary mirror path.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

const DEFAULT_EXPORT_FORMATS = {
    'application/vnd.google-apps.document':     'text/markdown',
    'application/vnd.google-apps.spreadsheet':  'text/csv',
    'application/vnd.google-apps.presentation': 'application/pdf',
    'application/vnd.google-apps.drawing':      'image/png',
}

const TEXT_LIKE_MIMES = new Set([
    'text/plain',
    'text/markdown',
    'text/html',
    'text/css',
    'application/javascript',
    'application/json',
    'application/yaml',
    'application/x-yaml',
    'text/x-yaml',
    'text/csv',
    'text/xml',
    'application/xml',
    'application/x-sh',
    'application/sql',
])

// Parse fileId out of `gdrive://<fileId>/<rest>` or `gdrive://<fileId>`.
function parseDriveUri(uri) {
    const m = /^gdrive:\/\/([^/]+)(\/.*)?$/i.exec(uri ?? '')
    return m?.[1] ?? null
}

function isTextLike(mimeType) {
    if (!mimeType) return false
    if (TEXT_LIKE_MIMES.has(mimeType)) return true
    if (mimeType.startsWith('text/')) return true
    return false
}

export async function readDriveEntity(entity, { drive, cacheFolder, exportFormats, logger }) {
    if (!drive) {
        return { contentError: 'gdrive: provider not initialized. Did you forget providerGdrive() in plugins[]?' }
    }
    const fileId = entity.meta?.driveId ?? parseDriveUri(entity.uri)
    if (!fileId) {
        return { contentError: `gdrive: cannot parse fileId from "${entity.uri}"` }
    }

    const mimeType = entity.meta?.driveMimeType
    const formats = { ...DEFAULT_EXPORT_FORMATS, ...(exportFormats ?? {}) }

    // Google-native types: export.
    if (mimeType?.startsWith('application/vnd.google-apps.')) {
        const exportMime = formats[mimeType]
        if (!exportMime) {
            return { contentSkipped: `gdrive: no export mime configured for ${mimeType}` }
        }
        try {
            // Text-shaped exports come back as strings via responseType='text'.
            if (isTextLike(exportMime)) {
                const res = await drive.files.export(
                    { fileId, mimeType: exportMime },
                    { responseType: 'text' },
                )
                return { content: String(res.data) }
            }
            // Binary export → stream to cache.
            const cachePath = await mirrorBinary({
                drive, fileId, cacheFolder, hint: cacheHintFromMime(exportMime),
                exportMime,
                expectedModifiedTime: entity.meta?.driveModifiedTime,
                logger,
            })
            return {
                contentSkipped: `gdrive: binary mirrored to ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
                cachedAt: cachePath,
            }
        } catch (err) {
            return { contentError: `gdrive export failed for ${fileId}: ${err.message}` }
        }
    }

    // Plain text / code: alt=media as text.
    if (isTextLike(mimeType)) {
        try {
            const res = await drive.files.get(
                { fileId, alt: 'media', supportsAllDrives: true },
                { responseType: 'text' },
            )
            return { content: String(res.data) }
        } catch (err) {
            return { contentError: `gdrive get failed for ${fileId}: ${err.message}` }
        }
    }

    // Binary native (PDF, image, video, audio, …) → cache.
    try {
        const cachePath = await mirrorBinary({
            drive, fileId, cacheFolder, hint: cacheHintFromMime(mimeType),
            expectedModifiedTime: entity.meta?.driveModifiedTime,
            logger,
        })
        return {
            contentSkipped: `gdrive: binary mirrored to ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
            cachedAt: cachePath,
        }
    } catch (err) {
        return { contentError: `gdrive mirror failed for ${fileId}: ${err.message}` }
    }
}

function cacheHintFromMime(mimeType) {
    if (!mimeType) return 'bin'
    if (mimeType === 'application/pdf') return 'pdf'
    if (mimeType.startsWith('image/'))  return mimeType.split('/')[1]
    if (mimeType.startsWith('video/'))  return mimeType.split('/')[1]
    if (mimeType.startsWith('audio/'))  return mimeType.split('/')[1]
    return 'bin'
}

// Stream a Drive file to the local cache. Reused on every read; the
// cache is keyed by fileId + a content marker so an unchanged file
// doesn't re-download. `expectedModifiedTime` (from entity.meta) is
// the cheapest invalidation marker — when Drive's last-modified
// matches the cached file's mtime, we keep the cache.
async function mirrorBinary({ drive, fileId, cacheFolder, hint, exportMime, expectedModifiedTime, logger }) {
    if (!cacheFolder) {
        throw new Error('gdrive: cacheFolder not configured — set cacheFolder option or rely on runtime.options.runtimeFolder default')
    }
    await mkdir(cacheFolder, { recursive: true })
    const filename = `${fileId}.${hint || 'bin'}`
    const cachePath = path.join(cacheFolder, filename)

    if (existsSync(cachePath) && expectedModifiedTime) {
        try {
            const st = await stat(cachePath)
            if (st.mtime.getTime() >= Date.parse(expectedModifiedTime)) {
                return cachePath
            }
        } catch { /* fall through to re-download */ }
    }

    let res
    if (exportMime) {
        res = await drive.files.export(
            { fileId, mimeType: exportMime },
            { responseType: 'arraybuffer' },
        )
    } else {
        res = await drive.files.get(
            { fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' },
        )
    }
    const buf = Buffer.from(res.data)
    await writeFile(cachePath, buf)
    logger.debug('gdrive: cached %s (%d bytes) → %s', fileId, buf.length, cachePath)
    return cachePath
}
