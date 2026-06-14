// Service-account authentication for the gdrive provider.
//
// Two ways to pass credentials:
//
//   - `keyFile`: absolute path to the JSON key file (recommended;
//     matches Google's GOOGLE_APPLICATION_CREDENTIALS env var convention).
//   - `credentials`: an object `{ client_email, private_key, ... }`
//     (useful when secrets come from a secret manager and you'd rather
//     not write them to disk).
//
// Scope is `drive.readonly` — v1 is read-only. Two-way sync is v2.
// If you ever want write access, this is the line to change.

import { google } from 'googleapis'

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

export async function createDriveClient({ keyFile, credentials } = {}) {
    if (!keyFile && !credentials) {
        // No explicit options — fall back to the ambient Google
        // Application Default Credentials. Works when running on GCP
        // (Cloud Run, GKE, etc.) or when the env var
        // GOOGLE_APPLICATION_CREDENTIALS is set.
        keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined
    }

    const authOptions = {
        scopes: SCOPES,
    }
    if (keyFile) authOptions.keyFile = keyFile
    if (credentials) authOptions.credentials = credentials

    const auth = new google.auth.GoogleAuth(authOptions)
    const client = await auth.getClient()
    const drive = google.drive({ version: 'v3', auth: client })

    // One cheap call to verify the credentials work. `about.get` with
    // `fields=user` returns the service account's own identity; any
    // auth/permission/network failure surfaces here with a clear error
    // BEFORE we start trying to list folders.
    let identity
    try {
        const about = await drive.about.get({ fields: 'user(emailAddress)' })
        identity = about.data.user?.emailAddress ?? '(unknown)'
    } catch (err) {
        throw new Error(
            `gdrive: failed to authenticate with Drive. ` +
            `Check that your service account key is valid and Drive API is enabled.\n` +
            `Underlying error: ${err.message}`
        )
    }

    return { drive, identity }
}
