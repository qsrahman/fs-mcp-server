# AGENTS.md

Guidance for AI coding agents working in this repo. See [README.md](README.md) for what the server does and how to run it.

## Overview

A stdio MCP server (TypeScript, ESM, Node) exposing four filesystem tools (`read_file`, `read_multiple_files`, `write_file`, `edit_file`) plus an opt-in `shell` tool (`--enable-shell`, ported from tiny-code). It is a trimmed port of the reference server at `modelcontextprotocol/servers/src/filesystem`.

## Layout

- `src/index.ts`: CLI arg parsing (`--read-only`), stdio entry point. `main()` runs only when the file is the process entry point, so importing it (as tests do) starts nothing.
- `src/server.ts`: `createServer` and the tool registrations. Handlers stay thin; logic lives in the modules below.
- `src/paths.ts`: `validatePath`.
- `src/files.ts`: `readText` (offset/limit, capped), `tailFile`, `writeFileContent` (creates parent dirs), `withFileLock`, `friendlyFsError`.
- `src/shell.ts`: `runShell` (execa), output truncation.
- `src/edit.ts`: the `edit_file` engine and its mismatch error.
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
- Prefer Node built-ins and already-installed deps (`zod`, `diff`, `execa`, `@modelcontextprotocol/server`) over hand-rolled code.
- Keep it minimal. Do not add features, abstractions or tools that were not requested.
- Tool schemas use `zod` objects. Handlers return `{ content: [{type: 'text', text}] }` (no `structuredContent`: it would duplicate the payload) and signal failure by throwing.
- Reads are capped for the model's context (`MAX_READ_CHARS`, `MAX_MULTI_READ_CHARS` in `files.ts`), not for memory: a cut result must end with the offset to continue from. New file-touching handlers should wrap their fs calls in `guard(path, ...)` so errors name the path as the client wrote it.
- `edit_file` fails on an ambiguous `oldText` unless `replaceAll` is set. Keep that: a silent wrong-place edit is the worst agent failure.
- Read-only mode keys on the `readOnlyHint` annotation. Every tool must set it truthfully; a tool without `readOnlyHint: true` is withheld under `--read-only`.

## Security invariants

Every tool handler must call `validatePath(path, allowedDirs)` before touching the filesystem, and use the path it returns. When changing the `src/` modules:

- Never skip the realpath check; symlinks pointing outside the allowed directories must be refused.
- `validatePath` returns the nearest existing ancestor's real path plus the missing names; `writeFileContent` creates those directories. Do not create directories from any other path than one `validatePath` returned.
- Never write through a symlink: new files use exclusive create (`wx`), existing ones must be regular files and are opened with `O_NOFOLLOW`.
- Allowed directories are stored both as given and realpath'd (macOS `/var` vs `/private/var`); keep both.
- Add a test in `tests/` for any change to path validation or write behaviour, including a failing case such as traversal, a sibling directory sharing a prefix, or a symlink.

The `shell` tool is the deliberate exception: only its `cwd` goes through `validatePath`; the command is unconfined. It must stay opt-in (`enableShell`, default off), must keep `readOnlyHint: false` so `--read-only` withholds it, and the README must keep saying it is not sandboxed. Do not describe the server as confining file access when the shell is enabled.

`validatePath` bounds its `realpath` and `lstat` calls with `withFsTimeout` (15 s). That only stops *waiting*; Node cannot cancel an fs call, so a stalled one keeps a libuv thread until the provider answers. Do not add timeouts around reads and writes of file contents: a slow cloud download is legitimate.

Known gaps (do not claim otherwise in docs): no protection against directory-swap races between validation and write (this includes the directories `write_file` creates), no Windows/WSL path handling, no case or Unicode path equivalence, and no time limit on reading or writing file contents.

## Publishing

- `files` is a whitelist (`dist`, minus source maps, plus README and LICENSE); `prepare` runs `tsc`, so `npm publish`, `pnpm publish` and git installs all build first. Check the contents with `pnpm pack` before publishing.
- `devEngines` pins pnpm, and plain `npm` commands in this repo fail with EBADDEVENGINES, so publish with `pnpm publish`.
- The `bin` entry works through npm's symlink because `index.ts` compares real paths before running `main()`. Keep that guard.

## Gotchas

- `tsconfig.json` has `rootDir: src` so the build emits `dist/index.js`; `tests/` is type-checked only through `tsconfig.test.json`. Do not add `tests` to `tsconfig.json` `include`.
- Tool calls run concurrently. Any tool that reads a file and writes it back must hold `withFileLock(path, ...)` (keyed on the path `validatePath` returned) for the whole read-modify-write, or parallel calls lose updates. Plain reads are not locked, so a read racing a write can see a partly written file.
- `parseArgs` wraps `util.parseArgs` in strict mode on purpose: an unknown option must throw, because a mistyped security flag must not fall through as a directory. Do not switch `strict` off.
- The server logs to stderr only. stdout is the MCP protocol channel; never `console.log` in server code.
