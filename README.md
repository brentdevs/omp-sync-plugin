# OMP sync plugin

Automatic settings/provider synchronization for [oh-my-pi](https://github.com/can1357/oh-my-pi), using your own [OMP sync server](https://github.com/brentdevs/omp-sync-server). Runs inside OMP; no client daemon, GitHub storage, or additional listening port.

Requires **OMP 18.12.2** and Bun 1.3.14 or newer. The peer version is pinned to the inspected extension/settings APIs. Linux and macOS are checked in CI; Windows has not been verified.

## Install and connect

This repository is not yet published to npm. Install from a local clone:

```sh
git clone https://github.com/brentdevs/omp-sync-plugin.git
cd omp-sync-plugin
bun install --frozen-lockfile
omp install "$PWD"
```

Start a new OMP session (or reload extensions), then:

```text
/sync connect https://sync.example.com
```

The plugin asks for trust confirmation and a single-use pairing code. Generate a code **for each device**, choosing the same server profile when they should share settings:

```sh
# On the server, for a Compose deployment:
docker compose exec sync bun /app/src/main.ts pair --name laptop --profile personal
```

Pairing codes expire after ten minutes. Do not put device tokens in slash commands or URLs. HTTPS is required except for loopback development, such as `http://127.0.0.1:8787`. Server URL paths, userinfo, query strings, and fragments are rejected. Unset `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` before pairing: environment overrides otherwise take precedence over the plugin's enrollment.

An unpaired installation does not contact a server. Once paired, the main OMP session checks for changes every two seconds; subagents do not start independent sync loops. Sync stops when OMP exits, then catches up on the next launch. Local edits made while OMP is closed are detected then. Multiple OMP processes share durable state and serialize sync cycles with a crash-released SQLite lock.

## What synchronizes

- **Explicit global settings** from OMP's `config.yml`/`config.yaml`, keyed by registered setting ID. Defaults, project settings, additional config overlays, runtime flags and environment values are never exported as global preferences.
- **Declarative provider entries** from global `models.yml`/`models.yaml`, keyed by provider ID. Comments and unrelated entries are preserved when writing. Approved changes reload the model registry offline, without catalog discovery or forcing a new active session model.
- **Provider login credentials through OMP's existing auth broker**, not by copying `agent.db` or refresh-token snapshots. Pairing configures OMP's built-in broker client with the server origin and this device's bearer. The built-in client handles credential snapshots, access-token updates, and broker-side OAuth refresh.

Portable UI/model-selection settings apply automatically: `theme.dark`, `theme.light`, `defaultThinkingLevel`, `hideThinkingBlock`, `expandThinkingBlocks`, `readLineNumbers`, `read.renderMarkdown`, `read.defaultLimit`, `symbolPreset`, `colorBlindMode`, `composer.shape`, `composer.tokenRate`, `modelRoles`, `modelProviderOrder`, `cycleOrder`, and the simple string-array forms of `enabledModels`, `enabledProviders`, `disabledProviders`. Some OMP consumers apply preferences on the next session rather than changing the active model/UI immediately.

**Other registered settings and all incoming provider changes require `/sync review` approval on each receiving device.** This includes deletions. Approval is bound to the exact local/server values and expires if either changes. Provider URLs, transport, discovery, headers and security settings are privileged inputs; do not approve an untrusted server's configuration.

Credential-marked settings, `auth.*` bootstrap/routing settings, setup markers, extension installation paths, shell paths, sleep-prevention settings, and registered settings ending in `Directory`, `Directories`, `Path` or `Paths` stay device-local. Unknown setting IDs are not applied. Path-scoped provider/model filters are not imported as portable arrays. Command-backed `!command` values, prototype-sensitive keys, non-JSON data, and schema-invalid records cannot be approved or synchronized. The plugin does not synchronize session history, project files, installed extension code or arbitrary files.

### Provider configuration can itself contain secrets

A provider's declarative `apiKey` or headers are part of that complete atomic entry. Static values/references are preserved, **not resolved or silently stripped**, because custom model definitions may require them. Such values therefore appear in the server's configuration/history and private local merge cache. Prefer broker-managed login credentials and avoid literal secrets in provider definitions. Environment-variable references keep OMP's ordinary interpretation and require the appropriate environment on each device; the plugin never exports environment contents automatically. Command-backed entries are held as invalid/local-only until changed or explicitly excluded.

Provider approvals redact secret-like fields in the review dialog. They do not make a provider URL safe: a changed endpoint can receive credentials from OMP. All devices sharing a server can access the same broker vault; server sync profiles are **not** credential trust boundaries.

## Existing credentials and future logins

Pairing does **not** silently upload your old local API keys or OAuth refresh tokens. After connecting, run:

```text
/sync migrate
```

The plugin confirms API-key migration and separately asks whether to include OAuth accounts and environment API keys. It invokes OMP's existing `auth-broker migrate --from-local` command, which preserves existing broker accounts. The `omp` executable must be on `PATH`. Migration is not repeated in the background and does not delete local credential copies.

Enrollment changes are locked throughout migration consent/execution. The child command is pinned to the consented server/device bearer in its environment, not token-bearing command-line arguments; a concurrent config edit cannot redirect the upload.

Alternatively, inspect and run migration directly:

```sh
omp auth-broker migrate --from-local --dry-run
omp auth-broker migrate --from-local
# Additional explicit opt-ins:
omp auth-broker migrate --from-local --include-oauth --include-env
```

After migrating OAuth, do not continue independently refreshing copied refresh tokens. Perform subsequent logins on the broker host using `omp auth-broker login` (see the server's login/SSH instructions). Broker snapshots then propagate new usable credentials automatically. Config/environment/runtime key overrides retain normal OMP precedence; connecting does not silently remove them.

## Commands

| Command | Purpose |
| --- | --- |
| `/sync connect [HTTPS_ORIGIN]` | Enroll with a code and save broker configuration |
| `/sync status` | Show device/profile, cached cursor, outstanding issues and broker mismatch; never the token |
| `/sync now` | Run a serialized sync cycle immediately |
| `/sync review` | Review a conflict/approval; choose server, this device, or exclusion |
| `/sync exclude setting KEY` | Keep this setting local on this enrolled device |
| `/sync exclude provider ID` | Keep this provider local on this enrolled device |
| `/sync include setting KEY` | Remove that local exclusion; normal conflict/approval rules still apply |
| `/sync include provider ID` | Remove that provider exclusion |
| `/sync migrate` | Explicit credential migration with separate OAuth/environment consent |
| `/sync disconnect` | Stop sync, remove enrollment, and restore previous broker settings if they remain plugin-owned |

Invalid records cannot be approved: fix their source or exclude them. Exclusions do not remove local or server data. An exclusion for a record with an uncertain write must wait until that request's outcome is known. Disconnect preserves current settings/provider files and private merge history; it is not a destructive rollback. Broker settings independently changed since pairing are left alone. To invalidate the device remotely, use the server's `revoke DEVICE_ID` command as well.

## Offline behavior and conflicts

The merge compares the last reconciled base with current local and server values:

- Local-only changes upload with revision preconditions; remote-only changes apply after validation/approval.
- Equal changes converge. Divergent changes are preserved for explicit resolution, never last-writer-wins.
- Initial differing values also require resolution. A new device cannot silently resurrect a server tombstone.
- An uncertain write is durably recorded **before** sending and retried with the same operation ID/payload after restart. Later local edits remain separate.
- Epoch changes fetch a fresh snapshot while retaining merge bases; restored databases cannot silently erase the evidence needed to detect offline conflicts.
- Keys outside the server protocol's Unicode/length/control-character rules become invalid-record issues before queuing a write, rather than trapping all later sync behind a rejected pending request.

Incremental `/changes` pages are drained and cached durably. The cached records and feed cursor are saved together; held approvals/conflicts remain in the cache for subsequent reconciliation. A mutation acknowledgment never advances the feed cursor past unrelated writes. This client uses bounded HTTP polling, not an SSE dependency. Network failures back off to thirty seconds; local edits remain in their original files. A revoked token stops background sync and requires disconnect/re-enrollment.

**OAuth is not independently offline-refreshable.** OMP may use its encrypted broker snapshot cache while eligible, but expired access tokens require the broker. OMP discovers its broker before loading extensions: an unreachable broker without a usable cache can prevent startup before this plugin can run. Repair connectivity, or disable broker settings outside the session:

```sh
omp config reset auth.broker.url
omp config reset auth.broker.token
# Also unset any OMP_AUTH_BROKER_* environment overrides.
```

If temporarily disabling the broker, disconnect/re-enroll deliberately before expecting broker-backed authentication again. The plugin reports routing mismatches instead of overwriting independent operator changes.

## Local storage and trust

Under OMP's selected agent directory (normally `~/.omp/agent`):

- `sync/connection.json`: server origin, device bearer, profile and previous broker configuration.
- `sync/devices/<device-id-hash>/state.json`: remote cache, merge bases, exact pending operation, conflicts, approvals and exclusions, isolated per enrollment.
- `lock.sqlite` files: cross-process synchronization only; no credential database copy.

Plugin directories are mode `0700`; files are atomically replaced/fsynced with mode `0600`. OMP's own global settings writer saves `auth.broker.url` and the literal device token in its mode-`0600` config file so broker discovery works before extension startup and in subagents/CLI commands. Protect both config and plugin state. These permissions are not encryption at rest; use encrypted disks/backups. The trusted server and enrolled devices can read synchronized values. Server history retains old values, so deletion/disconnect is not secure erasure.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun pm pack --dry-run
```

CI checks Linux/macOS, validates installation through the real OMP CLI, and checks the distributable package. Tests cover merge/retry/epoch transitions, HTTP boundaries, private persistence and process locking, explicit-layer selection, approval validation and YAML preservation.
