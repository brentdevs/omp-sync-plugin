# OMP sync plugin

Automatic settings/provider synchronization for [oh-my-pi](https://github.com/can1357/oh-my-pi), using your own [OMP sync server](https://github.com/brentdevs/omp-sync-server). Runs inside OMP; no client daemon, GitHub storage, or additional listening port.

Requires **OMP 18.12.2** and **Bun 1.4.2 or newer** (including installation: the lockfile uses Bun 1.4's format). The peer version is pinned to the inspected APIs. CI covers Linux x64 and macOS ARM64/Intel; Windows has not been verified.

## Install and connect

This repository is not yet published to npm. Install from a local clone:

```sh
git clone https://github.com/brentdevs/omp-sync-plugin.git
cd omp-sync-plugin
bun install --frozen-lockfile
omp install "$PWD"
```

Start a new OMP session. After updating the plugin, restart **all** OMP processes using this agent directory: older running code does not participate in the updated enrollment/sync coordination.

```text
/sync connect https://sync.example.com
```

The plugin asks for trust confirmation and a single-use pairing code. Generate a code **for each device**, choosing the same server profile when they should share settings:

```sh
# On the server, for a Compose deployment:
docker compose exec sync bun /app/src/main.ts pair --name laptop --profile personal
```

Pairing codes expire after ten minutes. Do not put device tokens in slash commands or URLs. HTTPS is required except for loopback development, such as `http://127.0.0.1:8787`. Server URL paths, userinfo, query strings, and fragments are rejected. Unset `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` before pairing: environment overrides otherwise take precedence over the plugin's enrollment.

An unpaired installation does not contact a server and checks local enrollment every thirty seconds. Once paired, the main OMP session checks changes every two seconds; subagents do not start independent loops. Sync stops on exit and catches up next launch, including local edits made while closed. All updated OMP processes sharing an agent directory use one crash-released SQLite enrollment lease for sync, review mutations, connect/disconnect, and migration, always before their per-device lease. Disconnect waits for in-flight work; an old enrollment cannot keep applying or publishing after that barrier.

The footer is quiet while paired sync is healthy: there is no persistent `Sync: connected` badge. Review items, connection errors, revocation, pairing prompts and broker-routing warnings remain visible; the footer clears again after successful synchronization resolves them. Use `/sync status` for connection details at any time. This changes display only, not the polling interval or synchronization behavior.

## What synchronizes

- **Explicit global settings** from OMP's `config.yml`/`config.yaml`, keyed by registered setting ID. Defaults, project settings, additional config overlays, runtime flags and environment values are never exported as global preferences.
- **Declarative provider entries** from global `models.yml`/`models.yaml`, keyed by provider ID. Symlinks are preserved and their writable real targets updated. YAML aliases are materialized before edits so unrelated providers keep their values. Approved changes reload the model registry offline, without discovery or forcing a new active session model.
- **Provider login credentials through OMP's existing auth broker**, not by copying `agent.db` or refresh-token snapshots. Pairing configures OMP's built-in broker client with the server origin and this device's bearer. The built-in client handles credential snapshots, access-token updates, and broker-side OAuth refresh.

Portable UI/model-selection settings apply automatically: `theme.dark`, `theme.light`, `defaultThinkingLevel`, `hideThinkingBlock`, `expandThinkingBlocks`, `readLineNumbers`, `read.renderMarkdown`, `read.defaultLimit`, `symbolPreset`, `colorBlindMode`, `composer.shape`, `composer.tokenRate`, `modelRoles`, `modelProviderOrder`, `cycleOrder`, and the simple string-array forms of `enabledModels`, `enabledProviders`, `disabledProviders`. Some OMP consumers apply preferences on the next session rather than changing the active model/UI immediately.

**Other registered settings and all incoming provider changes require `/sync review` approval on each receiving device.** This includes deletions. Approval is bound to the exact local/server values and expires if either changes. Provider URLs, transport, discovery, headers and security settings are privileged inputs; do not approve an untrusted server's configuration.

Reviews show the server value first, with secret-field fingerprints instead of secret text. Large comparisons open OMP's full scrollable editor; submit the preview unchanged to continue, or cancel. No truncated preview can authorize a change. Choosing **Publish this device's value** uploads that local value—including a deletion—to the server and every device on the profile; it does not mean “keep local only.” Use exclusion for local-only configuration.

Credential-marked settings, `auth.*` bootstrap/routing settings, setup markers, extension installation paths, shell paths, sleep-prevention settings, and registered settings ending in `Directory`, `Directories`, `Path` or `Paths` stay device-local. Unknown setting IDs are not applied. Path-scoped provider/model filters are not imported as portable arrays. Command-backed `!command` values, prototype-sensitive keys, non-JSON data, and schema-invalid records cannot be approved or synchronized. The plugin does not synchronize session history, project files, installed extension code or arbitrary files.

### Provider configuration can itself contain secrets

A provider's declarative `apiKey` or headers are part of that complete atomic entry. Static values/references are preserved, **not resolved or silently stripped**, because custom model definitions may require them. Such values therefore appear in the server's configuration/history and private local merge cache. Prefer broker-managed login credentials and avoid literal secrets in provider definitions. Environment-variable references keep OMP's ordinary interpretation and require the appropriate environment on each device; the plugin never exports environment contents automatically. Command-backed entries are held as invalid/local-only until changed or explicitly excluded.

Provider approvals redact secret-like fields in the review dialog. They do not make a provider URL safe: a changed endpoint can receive credentials from OMP. All devices sharing a server can access the same broker vault; server sync profiles are **not** credential trust boundaries.

Provider writes stage and fsync the replacement before their final expected-content/symlink check. Newly introduced registry reload errors restore the previous file only while it is still the plugin's installed output; concurrent editor saves are never deliberately rolled back. An unchanged pre-existing diagnostic is not attributed to the new entry. These are best-effort external-editor guards, not an OS-level compare-and-swap: portable filesystems have a narrow race between the last comparison and rename. Cooperating plugin processes are serialized; avoid saving the same provider file in an external editor during sync.

## Existing credentials and future logins

Pairing does **not** silently upload your old local API keys or OAuth refresh tokens. After connecting, run:

```text
/sync migrate
```

The plugin confirms API-key migration and separately asks whether to include OAuth accounts and environment API keys. It invokes OMP's existing `auth-broker migrate --from-local` command, which preserves existing broker accounts. Migration reuses the running OMP executable for compiled/Nix installations, or the current Bun executable and the running host's `Bun.main` CLI entrypoint for npm/source installations. It never resolves a CLI from the plugin's own peer dependencies. A separate `omp` executable on `PATH` is not required, including when starting OMP with `nix run`. Migration is not repeated in the background and does not delete local credential copies.

Enrollment changes are locked throughout migration consent/execution. The child command is pinned to the consented server/device bearer in its environment, not token-bearing command-line arguments; a concurrent config edit cannot redirect the upload.

Alternatively, inspect and run migration directly:

```sh
omp auth-broker migrate --from-local --dry-run
omp auth-broker migrate --from-local
# Additional explicit opt-ins:
omp auth-broker migrate --from-local --include-oauth --include-env
```

For a Nix-launched installation, pass application arguments after `--`:

```sh
nix --extra-experimental-features 'nix-command flakes' run github:yuxqiu/omp-nix -- \
  auth-broker migrate --from-local --include-oauth --dry-run
# Remove --dry-run only after reviewing the planned accounts.
```

If the migration subprocess cannot execute, the plugin reports general execution guidance without displaying subprocess output or credentials. Authored safe errors retain their guidance. Cancellation is checked after child exit as well as before launch: it reports cancellation rather than a generic nonzero exit, but some credentials may already have reached the broker. Local copies remain. A nonzero migration exit still requires inspection with the direct dry-run command through your usual OMP launcher.

After migrating OAuth, do not continue independently refreshing copied refresh tokens. Perform subsequent logins on the broker host using `omp auth-broker login` (see the server's login/SSH instructions). Broker snapshots then propagate new usable credentials automatically. Config/environment/runtime key overrides retain normal OMP precedence; connecting does not silently remove them.

## Commands

| Command | Purpose |
| --- | --- |
| `/sync connect [HTTPS_ORIGIN]` | Enroll with a code and save broker configuration |
| `/sync status` | Show device name **and ID**, profile, cached cursor, issues and broker mismatch; never the token |
| `/sync now` | Run a serialized sync cycle immediately |
| `/sync review` | Review full redacted values; use server, publish this device's value/deletion, or exclude |
| `/sync exclude setting KEY` | Keep this setting local on this enrolled device |
| `/sync exclude provider ID` | Keep this provider local on this enrolled device |
| `/sync include setting KEY` | Remove that local exclusion; normal conflict/approval rules still apply |
| `/sync include provider ID` | Remove that provider exclusion |
| `/sync migrate` | Explicit credential migration with separate OAuth/environment consent |
| `/sync disconnect` | Stop sync, remove enrollment, and restore previous broker settings if they remain plugin-owned |

Invalid records cannot be approved: fix their source or exclude them. Exclusions do not remove local or server data. An exclusion for a record with an uncertain write must wait until that request's outcome is known. Disconnect preserves current settings/provider files and private merge history; it is not a destructive rollback. Broker settings independently changed since pairing are left alone. To invalidate the device remotely, use the server's `revoke DEVICE_ID` command as well.

Enrollment/review/migration dialogs require interactive OMP; headless attempts fail explicitly. Provider symlink targets must be writable—immutable Nix/dotfile deployments should manage those entries locally and exclude them. A crash-staged enrollment is rolled back on the next available startup rather than treated as successfully paired. If pairing fails after the server enrolled a device, the error identifies the server device to revoke before retrying with a new code.

## Offline behavior and conflicts

The merge compares the last reconciled base with current local and server values:

- Local-only changes upload with revision preconditions; remote-only changes apply after validation/approval.
- Equal changes converge. Divergent changes are preserved for explicit resolution, never last-writer-wins.
- Initial differing values also require resolution. A new device cannot silently resurrect a server tombstone.
- An uncertain write is durably recorded **before** sending and retried with the same operation ID/payload after restart. Later local edits remain separate.
- Epoch changes fetch a fresh snapshot while retaining merge bases; restored databases cannot silently erase the evidence needed to detect offline conflicts.
- Keys outside the server protocol's Unicode/length/control-character rules become invalid-record issues before queuing a write, rather than trapping all later sync behind a rejected pending request.
- Invalid local values use opaque diagnostics instead of persisting unsafe/deep/cyclic payloads. Raw remote JSON is cached inertly and validated per record, so one reserved-key value does not block unrelated records.
- Definitive write rejections are separated from uncertain outcomes. A rejected unchanged value is held for review instead of retried forever; changing it, resolving it explicitly, or resetting its exclusion can retry with a new operation ID. Cancellation, malformed acknowledgments, server errors, and retryable/auth responses retain the exact uncertain operation.

Incremental `/changes` pages are drained and cached durably. Cached records and feed cursor are saved together; held issues remain available. Mutation acknowledgments never skip unrelated writes. HTTP polling backs off to thirty seconds on failures; intentional pauses are not failures. Revoked tokens stop network sync, but local enrollment discovery continues, so re-pairing in another OMP process is detected automatically.

**OAuth is not independently offline-refreshable.** OMP may use its encrypted broker snapshot cache while eligible, but expired access tokens require the broker. OMP discovers its broker before loading extensions: an unreachable broker without a usable cache can prevent startup before this plugin can run. Repair connectivity, or disable broker settings outside the session:

```sh
omp config reset auth.broker.url
omp config reset auth.broker.token
# Also unset any OMP_AUTH_BROKER_* environment overrides.
```

If temporarily disabling the broker, disconnect/re-enroll deliberately before expecting broker-backed authentication again. The plugin reports routing mismatches instead of overwriting independent operator changes.

## Local storage and trust

Under OMP's selected agent directory (normally `~/.omp/agent`):

- `sync/connection.json`: server origin, raw device bearer, profile, previous broker configuration, and an interrupted-enrollment marker during pairing.
- `sync/devices/<device-id-hash>/state.json`: remote cache, merge bases, exact pending operation, rejected-value holds, issues, approvals and exclusions.
- `lock.sqlite` files: cross-process synchronization only; no credential database copy.

Plugin directories are mode `0700`; files are atomically replaced/fsynced with mode `0600`. Reads check descriptor size/type before allocation and chmod the opened descriptor; saves enforce the same **64 MiB limit before replacing** the previous readable snapshot. Oversized state is refused with guidance, not installed. Only exact owned atomic-write remnants are removed under writer leases; provider temp cleanup also verifies the owning process is dead.

OMP's global writer stores `auth.broker.url` and a **plugin-generated fixed `printf` token expression** in its mode-`0600` config file. Server token bytes must match `omps_` plus 43 base64url characters; they can never become executable syntax. The fixed expression returns the literal token even when a same-named environment variable exists. Raw secrets remain in the private enrollment file and config expression; this is not encryption. Protect both files and use encrypted disks/backups. The trusted server/devices can read synced values; deletion/disconnect does not erase server history or upstream credentials already received.

**Before upgrading a previously tested installation paired to an untrusted server**, reset `auth.broker.url`/`auth.broker.token` outside OMP and unset broker environment overrides. OMP discovers credentials before loading extensions, so a plugin cannot retroactively prevent execution of an already malicious old config. Ordinary previously issued tokens are rewritten to the safe literal representation when their still-owned enrollment loads; independently edited broker settings are not redirected.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run smoke:package
```

CI runs the test script and real packed-extension smoke on Linux and both macOS architectures. The smoke installs the tarball into a clean consumer, launches native OMP over RPC, checks discovery, and executes `/sync status`; a local inference trap verifies no model request occurs. Tests cover token resolution, invalid-record isolation, retry/epoch transitions, HTTP boundaries, size-safe persistence, process coordination, approval completeness, aliases, symlinks and conditional rollback.
