# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-16

### Changed

- Releases are now published from GitHub Actions using npm trusted publishing, so each version carries a provenance attestation. No library code changes.

## [0.1.0] - 2026-10-16

### Added

- `retry(fn, options)` with exponential backoff, `full` / `equal` / `none` jitter, `retries`, `minDelay`, `maxDelay`, `factor`, `shouldRetry`, and `onRetry`.
- `AbortSignal` support that cancels waits and in-flight attempts immediately.
- `RetryError` with `attempts`, `errors`, and `cause`.
- `backoff(retryNumber, options)` helper for custom retry loops.
- Clear `TypeError` / `RangeError` messages for invalid input, including suggestions for option names used by other libraries.
- ESM and CommonJS builds with TypeScript types.

[0.1.1]: https://github.com/acus9345/retry-jitter/releases/tag/v0.1.1
[0.1.0]: https://github.com/acus9345/retry-jitter/releases/tag/v0.1.0
