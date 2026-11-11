# AGENTS.md

Guidance for AI coding agents working in this repo. See [README.md](README.md) for what the server does and how to run it.

## Overview

A stdio MCP server (TypeScript, ESM, Node) exposing four filesystem tools (`read_file`, `read_multiple_files`, `write_file`, `edit_file`) plus a `shell` tool (ported from tiny-code). **By default it is unrestricted and the shell is on**; `--no-shell`, `--read-only` and optional directories take access away. It is a trimmed port of the reference server at `modelcontextprotocol/servers/src/filesystem`.

## Layout

- `src/index.ts`: CLI arg parsing (`--read-only`), stdio entry point. `main()` runs only when the file is the process entry point, so importing it (as tests do) starts nothing.
- `src/server.ts`: `createServer` and the tool registrations. Handlers stay thin; logic lives in the modules below.
- `src/paths.ts`: `validatePath`.
- `src/files.ts`: `readText` (offset/limit, capped), `tailFile`, `writeFileContent` (creates parent dirs), `withFileLock`, `friendlyFsError`.
- `src/shell.ts`: `runShell` (execa), output truncation.
- `src/edit.ts`: the `edit_file` engine and its mismatch error.
- `src/brave.ts`: Brave Search client and result formatting for `brave_web_search` / `brave_news_search` (adapted from brave/brave-search-mcp-server).
- `THIRD_PARTY_NOTICES.md`: licences of the code adapted from other projects; it ships in the npm package.
- `tests/*.test.ts`: vitest, one file per `src/` module; `server.test.ts` drives `createServer` through an in-memory MCP client. `helpers.ts` makes the temp directories.
- `dist/`: build output (`pnpm build`). Never edit by hand.

## Commands

Use pnpm (the repo pins it via `devEngines`; plain npm refuses to run).

- `pnpm build`: compile with tsc
- `pnpm typecheck`: type-check `src/` and `tests/` (via `tsconfig.test.json`)
- `pnpm test`: run vitest
- `pnpm format`: prettier (no semicolons, single quotes, trailing commas)

Before finishing a change, run `pnpm validate` (typecheck, test, format check).

## Conventions

- Match the existing style; run prettier rather than hand-formatting.
- Built-ins already in use: `util.parseArgs`, `util.stripVTControlCharacters`, `buffer.isUtf8`, `TextDecoder`, `FileHandle` (each file is opened once per read), `String.replaceAll`, `timers/promises` (in tests). Use stable APIs only: `engines` is `>=22`, so avoid `import.meta.main` (22.18+, "early development"), `worker_threads.locks` (24.5+, experimental) and `util.diff` (experimental, no unified-diff output).
- Prefer Node built-ins and already-installed deps (`zod`, `diff`, `execa`, `@modelcontextprotocol/server`) over hand-rolled code.
- Keep it minimal. Do not add features, abstractions or tools that were not requested.
- Tool input schemas use `z.strictObject` (and so does `fileEditSchema`): zod's default silently drops unknown keys, so a model's misspelled argument would be ignored and the call would succeed with the wrong meaning. Give every parameter, including nested ones, a `.describe()`; a test in `server.test.ts` fails on an open object or an undescribed property.
- `createServer` sets `maxToolInputElements` (`MAX_TOOL_INPUT_ELEMENTS`). It counts array elements and object members, not string length, so it bounds argument shape without limiting file contents. Keep any new array-valued parameter well inside it.
- The tool list is static, so `createServer` sets `capabilities.tools.listChanged: false` and a `tools/list` cache hint. If tools ever become dynamic, remove both.
- Tool schemas use `zod` objects. Handlers return `{ content: [{type: 'text', text}] }` (no `structuredContent`: it would duplicate the payload) and signal failure by throwing.
- Reads are capped for the model's context (`MAX_READ_CHARS`, `MAX_MULTI_READ_CHARS` in `files.ts`), not for memory: a cut result must end with the offset to continue from. New file-touching handlers should wrap their fs calls in `guard(path, ...)` so errors name the path as the client wrote it.
- `edit_file` fails on an ambiguous `oldText` unless `replaceAll` is set. Keep that: a silent wrong-place edit is the worst agent failure.
- The Brave tools exist only when `createServer` gets a `brave` option, which `index.ts` builds from the `BRAVE_API_KEY` environment variable (never from a command-line option, which would show in process listings). Never log the key, put it in a URL, or return it in a tool result or error; `brave.test.ts` and `server.test.ts` check this. `runShell` removes `BRAVE_API_KEY` from the shell's environment (`shell.test.ts` pins it): keep that, and do the same for any future secret the server holds.
- Search results are untrusted web text. Keep the "untrusted" wording in the tool descriptions and the server instructions, and keep the tools to a minimal parameter set: each parameter and enum costs tokens in every conversation.
- When adapting code from another project, check its licence first, add an "adapted from" line to the file, and add the licence to `THIRD_PARTY_NOTICES.md`. The modelcontextprotocol/servers repository is mid-way from MIT to Apache-2.0, so its whole licence file is reproduced there.
- Read-only mode keys on the `readOnlyHint` annotation. Every tool must set it truthfully; a tool without `readOnlyHint: true` is withheld under `--read-only`.

## Security invariants

Every tool handler must call `validatePath(path, allowedDirs)` before touching the filesystem, and use the path it returns. `allowedDirs` is `null` when no directories were given (nothing is restricted) and a non-empty array otherwise. When changing the `src/` modules:

- **`null` and `[]` are different.** `null` means unrestricted; an empty list means nothing is allowed. Directories that were given but could not be opened must make `main()` exit; never turn that into `null`. Keep the tests that pin this (`paths.test.ts`, `server.test.ts`).

- When directories are given, never skip the realpath check; symlinks pointing outside the allowed directories must be refused.
- `validatePath` returns the nearest existing ancestor's real path plus the missing names; `writeFileContent` creates those directories. Do not create directories from any other path than one `validatePath` returned.
- Never write through a symlink: new files use exclusive create (`wx`), existing ones must be regular files and are opened with `O_NOFOLLOW`.
- Allowed directories are stored both as given and realpath'd (macOS `/var` vs `/private/var`); keep both.
- Add a test in `tests/` for any change to path validation or write behaviour, including a failing case such as traversal, a sibling directory sharing a prefix, or a symlink.

The `shell` tool is unconfined by design, with or without directories: when directories are given only its `cwd` goes through `validatePath`; the command can touch anything. It is **on by default** (`ServerOptions.shell` defaults to true, `--no-shell` turns it off), must keep `readOnlyHint: false` so `--read-only` withholds it, and the README must keep saying plainly that the server has no sandbox by default and that directories alone are not a boundary while the shell is on. Descriptions and instructions are worded per configuration (restricted or not); do not hard-code "allowed directories" into text that is shown when there are none.

`validatePath` bounds its `realpath` and `lstat` calls with `withFsTimeout` (15 s). That only stops *waiting*; Node cannot cancel an fs call, so a stalled one keeps a libuv thread until the provider answers. Do not add timeouts around reads and writes of file contents: a slow cloud download is legitimate.

Known gaps (do not claim otherwise in docs): no protection against directory-swap races between validation and write (this includes the directories `write_file` creates), no Windows/WSL path handling, no case or Unicode path equivalence, and no time limit on reading or writing file contents.

## Publishing

- `files` is a whitelist (`dist`, minus source maps, plus README and LICENSE); `prepare` runs `tsc`, so `npm publish`, `pnpm publish` and git installs all build first. Check the contents with `pnpm pack` before publishing.
- `devEngines` pins pnpm, and plain `npm` commands in this repo fail with EBADDEVENGINES, so a manual publish uses `pnpm publish`. Normal releases go through the workflow below.
- The package is scoped (`@qsrahman/fs-mcp-server`); the command it installs is still `fs-mcp-server`, so `npx -y @qsrahman/fs-mcp-server` works because the package has a single `bin`. `publishConfig.access` is `public`, which a first publish of a scoped package needs. Keep `server.ts`'s `serverInfo.name` (`fs-mcp-server`) as the display name; it is not the npm name.
- The `bin` entry works through npm's symlink because `index.ts` compares real paths before running `main()`. Keep that guard.

### Releasing (GitHub Actions)

`.github/workflows/release.yml` publishes to npm when a `vX.Y.Z` tag is pushed. It uses npm trusted publishing (OIDC), so no npm token is stored anywhere. Two jobs: `verify` installs, runs `pnpm validate`, builds and packs, with no publish rights; `publish` has the only `id-token: write` and runs no repository code, only `npm publish` on the tarball `verify` produced. Actions are pinned to commit SHAs (version in a comment); update them deliberately.

One-time setup on npmjs.com (only the package owner can do this): the package's Settings → Trusted Publisher → GitHub Actions, with organization or user `qsrahman`, repository `fs-mcp-server`, workflow filename `release.yml` (exactly, it is case-sensitive), and the environment name `npm` or blank. **Tick `npm publish` under allowed actions**: the default allows only `npm stage publish`. npm's docs say a new trusted-publisher configuration must complete its first successful publish within two days. Then set the package's Publishing access to "Require two-factor authentication and disallow tokens" and revoke any publish tokens. Optionally add required reviewers to the `npm` environment (repo Settings → Environments) for a manual approval before each publish.

To release:

1. Bump `version` in `package.json`, run `pnpm validate`, commit to `main` and push.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must match `package.json` and point at a commit on `main`, or `verify` fails.
3. Watch the run: `gh run watch`. A manual run (`gh workflow run release.yml`) rehearses everything except the upload; on an already-released version it only prints a notice, because npm refuses to republish a version even for `--dry-run`.

Things to know: `repository.url` in `package.json` must match the GitHub repository exactly, or npm rejects the OIDC token; the publish uses `npm` (not `pnpm`) on a tarball from a directory with no `package.json`, because `devEngines` makes `npm` fail inside this repo; provenance is attached automatically. If trusted publishing stops working, `pnpm publish` with a granular token still works as a fallback.

## Gotchas

- `tsconfig.json` has `rootDir: src` so the build emits `dist/index.js`; `tests/` is type-checked only through `tsconfig.test.json`. Do not add `tests` to `tsconfig.json` `include`.
- Tool calls run concurrently. Any tool that reads a file and writes it back must hold `withFileLock(path, ...)` (keyed on the path `validatePath` returned) for the whole read-modify-write, or parallel calls lose updates. Plain reads are not locked, so a read racing a write can see a partly written file.
- `parseArgs` wraps `util.parseArgs` in strict mode on purpose: an unknown option must throw, because a mistyped security flag (`--read-only`, `--no-shell`) must not fall through as a directory and start the server with more access than asked for. Do not switch `strict` off.
- The server logs to stderr only. stdout is the MCP protocol channel; never `console.log` in server code.
