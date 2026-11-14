# Changelog

Versions follow [semver](https://semver.org). Each release's notes on GitHub are taken from the matching section here, and a release tag fails to publish without one.

## [0.6.2] - 2026-11-14

### Fixed

- `shell`: the note added when a command's output exceeds 10,485,760 characters no longer says the command was killed. A command can exit cleanly before the limit stops it, so the note now says the output was cut off.
- `shell`: `timeoutMs` is capped at 2,147,483,647 (the largest timeout the process library accepts). A larger value used to fail with an error that did not name the parameter; it is now refused as invalid input, and the parameter description states the limit.

## [0.6.1] - 2026-11-13

### Changed

- Tool and parameter descriptions were revised against the tool-design guidance of the MCP specification and of the Anthropic, OpenAI and Google docs. They now say what to use for the neighbouring job (`list_directory` and `search_files`, `read_multiple_files` instead of repeated `read_file` calls, `brave_web_search` then `fetch_url` when `fetch_url` is offered), what a tool cannot do (`read_file` is not for directories or binary files, `fetch_url` does not run JavaScript), and what a parameter does (`dryRun` returns the diff without changing the file; `oldText` and `newText` are explained). About 75 tokens more in the default setup.

## [0.6.0] - 2026-11-12

### Added

- **`search_files`**, a read-only tool that finds files and directories by name with a glob (`*.ts` directly under the directory, `**/*.ts` at any depth) and optional `excludePatterns`, adapted from the reference filesystem server. It never reads file contents. Results are paths relative to the searched directory, directories end in `/`, symbolic links end in `@` and are never followed, `.git` and `node_modules` are not entered, and a search stops at 1,000 matches or after looking at 100,000 entries, with a note. It adds one dependency, `minimatch`.

### Changed

- **`list_directory` and `search_files` are offered only when the shell is not available** (`--no-shell` or `--read-only`). With the shell on, which is the default, `ls` and `find` do the same job, and the two tools would add about 560 tokens to every conversation. 0.5.0 offered `list_directory` in every configuration; with the shell on, use `ls` through `shell`.
- Shorter tool descriptions, parameter descriptions and server instructions, without dropping any information: repeated sentences were merged, and the instructions no longer repeat what a tool's own description says. `fetch_url` no longer names `brave_web_search`, which is not always offered. The server instructions now say to look around with `ls`, `find` and `grep` when the shell is on.

## [0.5.0] - 2026-11-12

### Added

- **`list_directory`**, a read-only tool that lists a directory (optionally recursively), so an agent can explore a project when the shell is off or under `--read-only`. Directories end in `/` and come first, symbolic links end in `@` and are never followed, `.git` and `node_modules` are listed but not entered, a listing stops at 1,000 entries with a note, and a directory that does not answer within 15 seconds (a stalled network or cloud drive) fails with a clear message instead of hanging.

## [0.4.1] - 2026-11-12

No change in what the server does; the changes are to tests and tooling.

### Changed

- `read_file` on a directory checks for it before reading again, so the clear "is a directory" message comes from a deliberate check (0.3.4's refactor had left that check unreachable).
- The release workflow's smoke test retries the provenance check for about three minutes, since the registry can serve the attestation a little after the version.

### Added

- 16 tests for previously uncovered code (`read_multiple_files` budget, cache eviction, `deflate`, IPv6 exceptions, the mismatch search limit and others), a `pnpm test:coverage` script, and a coverage floor that CI enforces.
- A rule in `AGENTS.md` for refactor-only commits.

## [0.4.0] - 2026-11-12

### Removed

- **`brave_news_search`.** Use `brave_web_search` with `freshness` (`pd`, `pw`, `pm`) for recent results. `brave_web_search` is unchanged.

## [0.3.5] - 2026-11-12

Fixes for regressions introduced by the refactors in 0.3.4.

### Fixed

- `edit_file` no longer fails with "Cannot read properties of undefined" when `oldText` runs past the end of a file that has no final newline; it explains the mismatch again.
- The robots.txt check of the resolved path no longer doubles the `?` of a query string (`/private??id=1`), which stopped query-specific rules from matching.
- A page declared `text/plain` is converted to markdown again only when `<html` opens it, as before 0.3.4, instead of whenever it starts like a page.
- `--allowed-hosts` rejects entries with stray brackets (`[example.com]`) again instead of silently accepting them.
- The Brave tool descriptions read "The results are untrusted text" again (0.3.4 had "The results is").

## [0.3.4] - 2026-11-12

No change in behaviour.

### Added

- A security policy (`SECURITY.md`): how to report a vulnerability privately, and what counts as one.

### Changed

- Internal: refactors across the source (constants and helpers extracted, duplicated code and error handling consolidated). No change in behaviour.

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
