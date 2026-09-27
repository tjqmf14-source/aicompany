# AI Company Bridge — Windows portable

1. Use Windows x64 with Git for Windows already installed and available on PATH.
   Node and npm are included. Codex is optional and needs the existing ChatGPT
   login only when a Codex task is requested. No API key or paid service is needed.
2. Extract the entire ZIP to a new folder. Never run from inside the ZIP.
3. Double-click **Start.cmd**. The server stays hidden and the dashboard opens in
   your browser. Do not run as administrator. A brief launcher window is normal.
4. Double-click **Stop.cmd** before backing up data, changing version or removing
   the package. Closing the browser alone does not stop the server.

Data: `%LOCALAPPDATA%\AICompanyBridge`. Logs: `server.log`, `server-error.log`.
Repository projects remain in their original locations. They are not copied into
the ZIP or deleted when you remove an app folder. There is no automatic migration
of old development `.ai-company` data. Back up that closed directory and configure
`AICOMPANY_DATA_DIR` explicitly if you want to reuse it; never run both servers.

For update/rollback, stop the current version and back up the entire closed data
directory, including SQLite sidecar files. Extract the new version alongside the
old one, then start the new one. Phase 9 introduces no application schema change.
Do not downgrade across future incompatible database schemas: restore the backup
to a separate directory and review compatibility first. Never delete lock files to
force a second instance. A crashed process releases its SQLite lock automatically.

Removal: stop the app and remove only its extracted package folder. Keep the data
directory for later reuse. This package does not create registry entries, services,
scheduled tasks, startup items or shortcuts. No automatic updater is installed.

The ZIP is unsigned. No SmartScreen reputation or publisher verification is
claimed. SHA-256 inventory checks detect corruption, not replacement of both the
manifest and executable by an attacker. Use only trusted release sources; do not
disable Windows security controls to bypass a warning. Managed devices may block
unsigned scripts. Contact your administrator instead of bypassing organization policy.

Troubleshooting: missing Git, denied filesystem access, linked data paths, damaged
package files and an already running data owner cause an explicit startup failure.
An unavailable Codex installation does not prevent dashboard startup. Do not put
the data directory in the application package, a cloud-synced share, or a network
filesystem. Loopback is not a sandbox against other processes under your account.
