# Changelog

Versions follow [semver](https://semver.org). Each release's notes on GitHub are taken from the matching section here, and a release tag fails to publish without one.

## [0.3.4] - 2026-11-12

No change to the server.

### Added

- A security policy (`SECURITY.md`): how to report a vulnerability privately, and what counts as one.

## [0.3.3] - 2026-11-11

No change to the server. This release exercises the new release pipeline.

### Added

- This changelog. Each GitHub release now carries the notes of its version, and a release tag fails to publish without a section here.
- After publishing, the release workflow installs the published version from npm, checks its signatures and provenance, and starts it.

## [0.3.2] - 2026-11-11

### Changed

- **`shell` returns plain text instead of JSON.** A command that succeeded and printed only to stdout gives just that output (`(no output)` if there was none). A failed command starts with `exit code N`. `[stdout]` and `[stderr]` labels appear when stderr has content. `isError` is unchanged. A client that parsed the old JSON (`ok`, `stdout`, `stderr`, `exitCode`) must be updated.

### Added

- A test that runs the built server as a separate process, including through a symlink as npm starts a `bin`.
- Dependabot for npm dependencies and GitHub Actions.

## [0.3.1] - 2026-11-11

### Fixed

- `fetch_url` no longer hangs the server on a deeply nested page: Readability's cost grows steeply with nesting depth (a 22 KB page took about a minute). A page nested more than 256 levels is refused with a hint to use `raw=true`.
- The `fetch_url` description now reflects `--allow-private-ips`, `--ignore-robots-txt` and `--allowed-hosts` instead of always claiming the default policy.
- `read_file` rejects `head: 0`, which used to return a bogus "continue reading" note.
- An oversized response body reports the byte limit on Node 22 too (it surfaced as an abort error there).

### Changed

- Internal: tool registrations moved from `server.ts` into `src/tools/`, tests were split by tool group, and unused exports were removed.

## [0.3.0] - 2026-11-11

### Changed

- **Renamed** from `@qsrahman/fs-mcp-server` to `@qsrahman/workshop-mcp`. The command is now `workshop-mcp`: `npx -y @qsrahman/workshop-mcp`.

### Added

- `fetch_url`: read a web page as markdown, with `robots.txt` obeyed, private addresses refused (checked at connect time and after every redirect) and a response size cap. On by default; `--no-fetch` removes it.
- Options `--allow-private-ips`, `--ignore-robots-txt` and `--allowed-hosts` for `fetch_url`.

## [0.2.0] - 2026-11-11

### Added

- `brave_web_search` and `brave_news_search`, available when `BRAVE_API_KEY` is set.
- A GitHub Actions workflow that publishes to npm with trusted publishing when a version tag is pushed.

## [0.1.0] - 2026-11-11

First release, as `@qsrahman/fs-mcp-server`.

### Added

- Tools `read_file`, `read_multiple_files`, `write_file`, `edit_file` and `shell`.
- Unrestricted by default with the shell on; `--read-only`, `--no-shell` and optional allowed directories take access away.
