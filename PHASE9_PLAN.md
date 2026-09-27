# Phase 9 — Windows portable packaging

Baseline: `71cb7542dcf5cd7859577490aeac31cd4314937e` (Phase 8).

## Scope

- Unsigned, per-user portable ZIP. No installer, elevation, registry writes,
  startup registration, paid signing, automatic update or remote deployment.
- Bundle the build machine's supported Windows x64 Node runtime and npm,
  locked production dependencies, built server/web, licenses and launchers.
  Git for Windows remains an explicitly checked prerequisite; Codex is optional.
- Serve the built dashboard and API together on loopback without Vite.
- Keep state under LOCALAPPDATA/AICompanyBridge, outside the application directory.
  Use a dedicated SQLite exclusive transaction as a crash-released instance lock
  before opening the real application DB. Never delete state during shutdown.
- Double-click start/stop with a bounded readiness check, authenticated local
  shutdown, hidden server and logs. Refuse unknown or unhealthy existing instances.
- Package allowlist plus per-file SHA-256 manifest, no personal state/secrets/source
  maps/dev dependencies. Hashes detect corruption, not publisher authenticity.
- Side-by-side update/rollback: stop, retain data, extract another version, start.
  No automatic schema downgrade or deletion; back up closed state before upgrade.

## Acceptance / verification

Existing 198 tests retained. Add production static-path, instance-lock, lifecycle,
restart, package-integrity and data-retention regression tests. Run typecheck,
lint, complete test, build, audit and whitespace gates. Build and verify the actual
Windows ZIP; launch its extracted runtime, exercise HTTP/stop/restart and data
retention. Commit only after local QA, then browser smoke. Verify exact feature
HEAD CI before PR merge, and verify exact merged main CI independently.

Windows/Linux CI runs the normal checks; Windows additionally produces a verified
portable artifact. Final Release Audit remains a separate phase. A paid signature,
SmartScreen reputation and installer lifecycle are NOT CLAIMED by this scope.
