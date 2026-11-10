# AGENTS.md

Guidance for AI coding agents working in this repo. See [README.md](README.md) for what the server does and how to run it.

## Overview

A stdio MCP server (TypeScript, ESM, Node) exposing four filesystem tools: `read_text_file`, `read_multiple_files`, `write_file`, `edit_file`. It is a trimmed port of the reference server at `modelcontextprotocol/servers/src/filesystem`.

## Layout

- `src/index.ts`: tool registration (`createServer`), CLI arg handling, stdio entry point. Importing it starts the server.
- `src/lib.ts`: `validatePath` and all file operations. Put new filesystem logic here, not in the tool handlers.
- `tests/*.test.ts`: vitest. Currently covers `src/lib.ts`.
- `dist/`: build output (`pnpm build`). Never edit by hand.

## Commands

Use pnpm (the repo pins it via `devEngines`; plain npm refuses to run).

- `pnpm build`: compile with tsc
- `pnpm typecheck`: type-check `src/` only (tests are excluded because `rootDir` is `src`)
- `pnpm test`: run vitest
- `pnpm format`: prettier (no semicolons, single quotes, trailing commas)

Before finishing a change, run `pnpm typecheck && pnpm test && pnpm format:check`.

## Conventions

- Match the existing style; run prettier rather than hand-formatting.
- Prefer Node built-ins and already-installed deps (`zod`, `diff`, `@modelcontextprotocol/server`) over hand-rolled code.
- Keep it minimal. Do not add features, abstractions or tools that were not requested.
- Tool schemas use `zod` objects. Handlers return `{ content: [{type: 'text', text}], structuredContent: { content } }` and signal failure by throwing.

## Security invariants

Every tool handler must call `validatePath(path, allowedDirs)` before touching the filesystem, and use the path it returns. When changing `src/lib.ts`:

- Never skip the realpath check; symlinks pointing outside the allowed directories must be refused.
- Never write through a symlink: new files use exclusive create (`wx`), existing ones must be regular files and are opened with `O_NOFOLLOW`.
- Allowed directories are stored both as given and realpath'd (macOS `/var` vs `/private/var`); keep both.
- Add a test in `tests/` for any change to path validation or write behaviour, including a failing case such as traversal, a sibling directory sharing a prefix, or a symlink.

Known gaps (do not claim otherwise in docs): no protection against directory-swap races between validation and write, no Windows/WSL path handling, no case or Unicode path equivalence.

## Gotchas

- `tsconfig.json` has `rootDir: src`, so `tests/` is not part of `tsc`. Do not add it back to `include` without changing `rootDir` and the `bin` path.
- Tool calls sent without waiting for earlier responses run concurrently; a read right after a write on the same file can race. This is expected, not a server bug.
- The server logs to stderr only. stdout is the MCP protocol channel; never `console.log` in server code.
