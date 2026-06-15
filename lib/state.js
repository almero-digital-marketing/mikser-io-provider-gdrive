// Persistent state for the gdrive provider — Drive's per-folder
// `changeToken` and a small per-file cache of (driveId, modifiedTime,
// mimeType, name) used by the cold scan to detect renames and changes.
//
// Lives in the engine's own sqlite database via mikser-io's
// registerSchema convention. Table prefix `mikser_provider_gdrive_`
// follows the cross-plugin naming rule: strip `mikser-io-` from the
// package, replace `-` with `_`, prepend `mikser_`.

import { registerSchema, useDatabase } from 'mikser-io'

registerSchema('provider_gdrive', `
    CREATE TABLE IF NOT EXISTS mikser_provider_gdrive_state (
        folder_id          TEXT PRIMARY KEY,
        change_page_token  TEXT,
        last_polled_at     INTEGER
    );
    CREATE TABLE IF NOT EXISTS mikser_provider_gdrive_files (
        file_id            TEXT PRIMARY KEY,
        folder_id          TEXT NOT NULL,
        entity_id          TEXT NOT NULL,
        name               TEXT NOT NULL,
        relative_path      TEXT NOT NULL DEFAULT '',
        mime_type          TEXT,
        modified_time      TEXT,
        last_seen_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_provider_gdrive_files_folder
        ON mikser_provider_gdrive_files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_mikser_provider_gdrive_files_entity
        ON mikser_provider_gdrive_files(entity_id);
`)

export function getChangeToken(folderId) {
    const db = useDatabase()
    if (!db?.isOpen) return null
    return db.handle.prepare(
        `SELECT change_page_token FROM mikser_provider_gdrive_state WHERE folder_id = ?`
    ).get(folderId)?.change_page_token ?? null
}

export function setChangeToken(folderId, token) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_provider_gdrive_state (folder_id, change_page_token, last_polled_at)
        VALUES (?, ?, ?)
        ON CONFLICT(folder_id) DO UPDATE SET
            change_page_token = excluded.change_page_token,
            last_polled_at    = excluded.last_polled_at
    `).run(folderId, token, Date.now())
}

export function rememberFile({ fileId, folderId, entityId, name, relativePath = '', mimeType, modifiedTime }) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_provider_gdrive_files
            (file_id, folder_id, entity_id, name, relative_path, mime_type, modified_time, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
            folder_id     = excluded.folder_id,
            entity_id     = excluded.entity_id,
            name          = excluded.name,
            relative_path = excluded.relative_path,
            mime_type     = excluded.mime_type,
            modified_time = excluded.modified_time,
            last_seen_at  = excluded.last_seen_at
    `).run(fileId, folderId, entityId, name, relativePath, mimeType ?? null, modifiedTime ?? null, Date.now())
}

export function forgetFile(fileId) {
    const row = useDatabase().handle.prepare(
        `SELECT entity_id FROM mikser_provider_gdrive_files WHERE file_id = ?`
    ).get(fileId)
    if (row) {
        useDatabase().handle.prepare(
            `DELETE FROM mikser_provider_gdrive_files WHERE file_id = ?`
        ).run(fileId)
    }
    return row?.entity_id ?? null
}

export function recordedFile(fileId) {
    return useDatabase().handle.prepare(
        `SELECT * FROM mikser_provider_gdrive_files WHERE file_id = ?`
    ).get(fileId) ?? null
}
