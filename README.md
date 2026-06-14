# mikser-io-provider-gdrive

Google Drive as a content source for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). One Drive folder (or many) becomes a stream of mikser entities; everything downstream — layouts, renderers, vector indexing, MCP queries — works as if the docs lived on your local disk.

Two surfaces, one package:

- **Lifecycle plugin** — sits in your `mikser.config.js` plugins array, authenticates against Drive, polls the configured folders, emits `createEntity` / `updateEntity` / `deleteEntity` into the catalog.
- **`read(entity)` named export** — what mikser's engine dispatches into when something downstream needs the content of an entity whose `uri` is `gdrive://...`. You don't import it directly; mikser-io's `readEntityContent` does the dynamic import by package-name convention.

```
gdrive folder
   │
   ▼
providerGdrive() → emits entities with uri = "gdrive://<fileId>/<name>.<ext>"
                  + meta { driveId, driveMimeType, driveModifiedTime, ... }
   │
   ▼
catalog (mikser-io entities) — refs, manifest, lifecycle, render all work normally
   │
   ▼
readEntityContent(entity) → dispatches into THIS package's `read(entity)`
                          → Google Docs export as markdown,
                            Sheets as CSV,
                            Slides as PDF (mirrored to local cache),
                            plain text fetched as-is,
                            binaries mirrored to runtime/gdrive-cache/
```

## Install

```bash
npm install mikser-io-provider-gdrive
```

Peer dep on `mikser-io ^9`. Hard dep on `googleapis`.

## Setting up Google Drive access (one-time, ~10 minutes)

Drive access uses a **service account** — a non-human Google identity with its own credentials, perfect for headless processes like mikser. The flow:

1. Create a Google Cloud project (or reuse one)
2. Enable the Drive API on it
3. Create a service account
4. Download its JSON key file
5. Share your Drive folder(s) with the service account's email

Step-by-step:

### 1. Create or pick a Google Cloud project

Open https://console.cloud.google.com/ → top bar → project picker → **New Project**. Name it whatever (e.g. `mikser-drive-sync`). Note the project ID; you won't need it often after this.

If you already have a GCP project you don't mind using, skip this step.

### 2. Enable the Drive API

In the Cloud Console, navigate to **APIs & Services → Library**, search for "Google Drive API", and click **Enable**. (Direct link: https://console.cloud.google.com/apis/library/drive.googleapis.com)

Without this, the service account can authenticate but every Drive call will return 403. The error message even tells you the URL to enable it — but doing it now saves a round-trip later.

### 3. Create a service account

**APIs & Services → Credentials → Create credentials → Service account.**

Fill in:
- **Service account name**: anything readable, e.g. `mikser-sync`
- **Service account ID**: auto-generated; this becomes the email — `mikser-sync@<project>.iam.gserviceaccount.com`
- **Description**: optional but helpful future-you

Skip the "Grant this service account access to project" and "Grant users access" steps — neither is needed for read-only Drive access. Click **Done**.

### 4. Download the JSON key

Open the new service account from the credentials list → **Keys** tab → **Add Key → Create new key → JSON**. A `.json` file downloads.

Keep this file secret. It's the equivalent of a password for that service account. Common storage approaches:

- **Local dev**: drop it at e.g. `~/secrets/mikser-drive-sync.json` (outside any git repo).
- **CI / production**: paste the file contents into a secret manager (1Password, Doppler, Vercel/Netlify env, Kubernetes Secret, AWS Secrets Manager, etc.) and surface it via either `GOOGLE_APPLICATION_CREDENTIALS=<path>` or the inline `credentials` config option.
- **NEVER**: commit it to a public repo. Add `*.gserviceaccount.json` or your specific filename to `.gitignore`.

### 5. Share the Drive folder(s) with the service account

Service accounts can't browse arbitrary Drive folders — you have to explicitly share each one with the service account's email, exactly the way you'd share with a human collaborator.

In Drive (drive.google.com), right-click the folder → **Share** → paste the service account email (`mikser-sync@<project>.iam.gserviceaccount.com`) → set permission to **Viewer** (read-only access is all this plugin needs in v1) → uncheck "Notify people" → **Share**.

Repeat for every folder you want mikser to ingest.

### 6. Find each folder's ID

Open the folder in Drive. The URL looks like:

```
https://drive.google.com/drive/folders/0Bz4_FwGz_w7VTGFqMVBNUmZqSHM
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       this is the folder ID
```

Copy this ID into your mikser config (next section).

## Configure

```js
// mikser.config.js
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts }        from 'mikser-io-layouts'
import { providerGdrive } from 'mikser-io-provider-gdrive'

export default {
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true }),
        renderHbs(),

        providerGdrive({
            auth: {
                // EITHER: path to the JSON key (recommended).
                keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
                // OR: inline credentials from a secret manager.
                // credentials: { client_email: '...', private_key: '...' },
                // OR: rely on GCP ambient credentials (Cloud Run, GKE).
                // Leave both unset and the GoogleAuth client picks them up.
            },
            folders: [
                {
                    folderId:   '0Bz4_FwGz_w7VTGFqMVBNUmZqSHM',
                    collection: 'documents',                    // catalog collection to emit into
                    prefix:     '/drive/team-notes/',           // mikser-side id prefix
                },
                {
                    folderId:   'abc123xyz',
                    collection: 'files',                        // binary assets, etc.
                    prefix:     '/drive/assets/',
                },
            ],
            // Optional knobs (defaults shown).
            // pollIntervalMs: 30_000,
            // cacheFolder:    'runtime/gdrive-cache',
            // exportFormats: {
            //     'application/vnd.google-apps.document':     'text/markdown',
            //     'application/vnd.google-apps.spreadsheet':  'text/csv',
            //     'application/vnd.google-apps.presentation': 'application/pdf',
            // },
        }),
    ],
}
```

Run mikser:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/Users/me/secrets/mikser-drive-sync.json
mikser --watch
```

You should see something like:

```
gdrive: authenticated as mikser-sync@mikser-drive-sync.iam.gserviceaccount.com (cache: /path/to/runtime/gdrive-cache)
gdrive: cold-scanned folder 0Bz4_FwGz_w7VTGFqMVBNUmZqSHM — 47 files emitted
gdrive: watch poll every 30000ms
```

Subsequent ticks show only what changed:

```
gdrive: polled folder 0Bz4_FwGz_w7VTGFqMVBNUmZqSHM — 2 changes processed
```

## How it works

**Cold scan (first run, or after `--clear`):** the plugin walks the configured folder recursively, emits one `createEntity` per Drive file, stashes a Drive `changePageToken` in `mikser_provider_gdrive_state` so the next tick can go incremental.

**Incremental polling (every `pollIntervalMs` in watch mode):** `drive.changes.list` from the last persisted page token. New/edited files become `updateEntity` calls; trashed/removed files become `deleteEntity`. The new page token gets persisted before each batch finishes so a crash mid-iteration doesn't lose progress.

**Cache for binaries:** Slides, PDFs, images, video — anything that isn't text — is mirrored to `runtime/gdrive-cache/<fileId>.<ext>` the first time something reads it. Re-reads hit the local file and skip the Drive round-trip if Drive's `modifiedTime` matches the cached file's `mtime`. After a Drive edit, the cache invalidates and the next read re-downloads.

## URI scheme

Every entity emitted by this plugin has:

```js
entity.uri = 'gdrive://<fileId>/<slug>.<ext>'
entity.meta = {
    driveId:           '...',
    driveName:         'Original Doc Name.gdoc',
    driveMimeType:     'application/vnd.google-apps.document',
    driveModifiedTime: '2026-03-14T09:47:23.456Z',
    driveSize:         null,                     // null for Google-native types
    driveMd5:          'abc...',                 // present for binaries
    driveWebViewLink:  'https://docs.google.com/...',
}
```

When any downstream plugin calls `readEntityContent(entity)`, mikser-io's engine parses `gdrive` from the URI scheme and dynamic-imports `mikser-io-provider-gdrive` — exactly the way it dispatches renderers and postprocessors. The cache is reused; no new dispatch ceremony.

## Content mapping

| Drive mime type | What `read(entity)` returns |
|---|---|
| `application/vnd.google-apps.document` (Google Doc) | `{ content: <markdown> }` via `drive.files.export` |
| `application/vnd.google-apps.spreadsheet` (Google Sheet) | `{ content: <CSV> }` via export |
| `application/vnd.google-apps.presentation` (Google Slides) | `{ contentSkipped, cachedAt }` — PDF mirrored to local cache |
| `application/vnd.google-apps.drawing` (Google Drawing) | `{ contentSkipped, cachedAt }` — PNG mirrored |
| `text/*`, `.md`, `.html`, `.json`, `.yml`, `.css`, `.js`, … (recognised text-like mimes) | `{ content: <text> }` via `drive.files.get?alt=media` |
| Anything else (PDF, image, video, audio, blob) | `{ contentSkipped, cachedAt }` — file mirrored to local cache |

Override the Google-native exports per-project via the `exportFormats` option. Anything not in the map and not text-shaped falls into the binary mirror path.

## Watch mode

`mikser --watch` enables the polling loop. Each tick processes Drive changes since the last persisted token; only changed entities flow through the lifecycle, so `manifest.shouldSkip` short-circuits unchanged renders. Default poll interval is 30s — tune via `pollIntervalMs`. Setting it to 0 disables polling (one-shot semantics).

## State persistence

```sql
mikser_provider_gdrive_state (
    folder_id          TEXT PRIMARY KEY,
    change_page_token  TEXT,
    last_polled_at     INTEGER
);
mikser_provider_gdrive_files (
    file_id            TEXT PRIMARY KEY,
    folder_id          TEXT NOT NULL,
    entity_id          TEXT NOT NULL,
    name               TEXT NOT NULL,
    mime_type          TEXT,
    modified_time      TEXT,
    last_seen_at       INTEGER
);
```

Lives in mikser's main sqlite database (`runtime/mikser.sqlite`) via `registerSchema`. `--clear` wipes it; the next run does a fresh cold scan.

## What it does NOT do (v1)

- **Two-way sync.** Read-only. Edits in mikser don't get pushed back to Drive. Auth scope is `drive.readonly` — change it in `lib/auth.js` if you want write access, but you'll also need to implement the write path in the change-emission flow.
- **Push notifications (webhooks).** Drive's `changes.watch` requires a public HTTPS endpoint that Google can POST to. Polling is the v1 default. When v2 needs sub-30-second latency on shared spaces, the engine's `runtime.options.url` machinery is the place to wire a webhook receiver against.
- **OAuth (user-delegated access).** Service accounts only. Per-user OAuth makes sense for personal Drive sync (one mikser instance, your own files) but adds refresh-token persistence + the consent screen + the OAuth client setup. Defer to v2 if someone actually needs it.
- **Shared Drives (Team Drives) special handling.** The plugin sets `supportsAllDrives` and `includeItemsFromAllDrives`, so basic Team Drive folders work, but quota/permission edge cases there haven't been exercised.
- **Mid-content fuzzy matching.** A renamed Drive file gets a new entity (because its uri changes) and the old one gets deleted. Rename-aware tracking using Drive's `previousNames` field could be added in v2 if it matters.

## Troubleshooting

### `403: The caller does not have permission`

You forgot to share the Drive folder with the service account email. Open the folder in Drive, click Share, paste the service account email (`<name>@<project>.iam.gserviceaccount.com`), give it Viewer access.

If you DID share it: verify the service account email matches the one in your JSON key file (`client_email` field). Different projects have different service accounts; mixing them up is easy.

### `Google Drive API has not been used in project <id> before or it is disabled`

The error message includes a URL to enable it. Click it, click Enable, wait 30 seconds for it to propagate, restart mikser.

### `Error: invalid_grant — Invalid JWT signature`

Almost always a clock-skew issue on the machine running mikser. The JWT signed by the service account is timestamped; if the machine's clock is off by more than a few minutes, Google rejects it. Run `sudo ntpdate -u time.google.com` or rely on your OS's NTP.

### `Cannot find package 'mikser-io-provider-gdrive'` at read time

The provider package isn't installed in the resolution path of the running engine. With mikser's workspace dedupe this is usually fine; if you're outside the workspace, make sure the package is in `node_modules` next to (or above) the engine's running directory.

### Cold scan keeps re-running on every start

You're probably running `mikser --clear` or wiping `runtime/`. That's expected — `--clear` drops the `mikser_provider_gdrive_state` table along with everything else. Use `mikser` (without `--clear`) to keep the state.

### `Public URL: not set — plugins will not enable push webhooks`

Informational. The gdrive provider in v1 doesn't use push notifications, so this isn't a problem. The `runtime.options.url` system is there for when v2 adds them.

### Files appear with weird names like `Doc-1mE2x_fooBar...`

The plugin builds entity ids from `<slug>-<fileId>` to keep them stable across renames. The `slug` is the Drive file name with non-URL-safe characters stripped. If you want different naming, override `prefix` per-folder or post-process via mikser's lifecycle hooks.

## License

MIT
