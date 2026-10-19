# Changelog

## 0.1.0

- OMP extension enrollment with single-use server pairing codes and local device-token storage.
- Automatic explicit-global settings and declarative provider synchronization while OMP runs.
- Three-way merge, explicit conflict/privileged-change review, exclusions, durable idempotent retries, and epoch-aware reconciliation.
- Built-in OMP auth broker configuration, explicit credential migration, status, manual sync, and non-destructive disconnect.
- Private atomic state persistence and crash-released cross-process synchronization.
- Exact-value approval binding with complete scrollable redacted previews; local publication/deletion is explicit.
- Strict device-token validation and literal OMP token resolution, including safe migration of owned legacy config.
- Shared enrollment/sync/review coordination across processes, staged pairing rollback and revoked-enrollment rediscovery.
- Per-record invalid/rejected-value isolation, durable size-safe snapshots and descriptor-based file protection.
- Symlink/alias-preserving provider writes, post-staging edit checks and conditional registry-error rollback.
- Bun 1.4.2 minimum; Linux/macOS ARM64/Intel CI loading the actual packed extension in native OMP.
