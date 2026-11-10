# AGENTS.md

Guidance for AI coding agents working in this repo. See [README.md](README.md) for what the server does and how to run it.

## Overview

A stdio MCP server (TypeScript, ESM, Node) exposing four filesystem tools: `read_file`, `read_multiple_files`, `write_file`, `edit_file`. It is a trimmed port of the reference server at `modelcontextprotocol/servers/src/filesystem`.

## Layout

- `src/index.ts`: CLI arg parsing (`--read-only`), stdio entry point. `main()` runs only when the file is the process entry point, so importing it (as tests do) starts nothing.
- `src/server.ts`: `createServer` and the tool registrations. Handlers stay thin; logic lives in the modules below.
- `src/paths.ts`: `validatePath`.
- `src/files.ts`: read, head, tail and write.
- `src/edit.ts`: the `edit_file` engine and its mismatch error.
- `tests/*.test.ts`: vitest. `lib.test.ts` covers paths, files and edit; `server.test.ts` drives `createServer` through an in-memory MCP client.
- `dist/`: build output (`pnpm build`). Never edit by hand.

## Commands

Use pnpm (the repo pins it via `devEngines`; plain npm refuses to run).

- `pnpm build`: compile with tsc
- `pnpm typecheck`: type-check `src/` and `tests/` (via `tsconfig.test.json`)
- `pnpm test`: run vitest
- `pnpm format`: prettier (no semicolons, single quotes, trailing commas)

Before finishing a change, run `pnpm typecheck && pnpm test && pnpm format:check`.

## Conventions

- Match the existing style; run prettier rather than hand-formatting.
- Prefer Node built-ins and already-installed deps (`zod`, `diff`, `@modelcontextprotocol/server`) over hand-rolled code.
- Keep it minimal. Do not add features, abstractions or tools that were not requested.
- Tool schemas use `zod` objects. Handlers return `{ content: [{type: 'text', text}] }` (no `structuredContent`: it would duplicate the payload) and signal failure by throwing.
- Read-only mode keys on the `readOnlyHint` annotation. Every tool must set it truthfully; a tool without `readOnlyHint: true` is withheld under `--read-only`.

## Security invariants

Every tool handler must call `validatePath(path, allowedDirs)` before touching the filesystem, and use the path it returns. When changing the `src/` modules:

- Never skip the realpath check; symlinks pointing outside the allowed directories must be refused.
- Never write through a symlink: new files use exclusive create (`wx`), existing ones must be regular files and are opened with `O_NOFOLLOW`.
- Allowed directories are stored both as given and realpath'd (macOS `/var` vs `/private/var`); keep both.
- Add a test in `tests/` for any change to path validation or write behaviour, including a failing case such as traversal, a sibling directory sharing a prefix, or a symlink.

Known gaps (do not claim otherwise in docs): no protection against directory-swap races between validation and write, no Windows/WSL path handling, no case or Unicode path equivalence.

## Gotchas

- `tsconfig.json` has `rootDir: src` so the build emits `dist/index.js`; `tests/` is type-checked only through `tsconfig.test.json`. Do not add `tests` to `tsconfig.json` `include`.
- Tool calls sent without waiting for earlier responses run concurrently; a read right after a write on the same file can race. This is expected, not a server bug.
- The server logs to stderr only. stdout is the MCP protocol channel; never `console.log` in server code.
