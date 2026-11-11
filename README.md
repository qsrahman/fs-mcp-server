# fs-mcp-server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client read and write access to files inside directories you choose. It serves over stdio.

The tools are ported, in trimmed form, from the reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

## Tools

| Tool                  | What it does                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`           | Read a file as text. Optional `head` or `tail` returns only the first or last N lines (not both). Whole-file reads are capped at 10 MiB; `head` and `tail` are not. |
| `read_multiple_files` | Read up to 50 files at once, 10 MiB in total (files past the budget are reported inline). A failure on one file is reported inline and does not stop the others.                                                                 |
| `write_file`          | Create a file or overwrite it completely.                                                                                                                           |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. `dryRun` previews without writing.                                                            |
| `shell`               | Run a shell command; returns stdout, stderr and exit code. **Opt-in** with `--enable-shell` (see below). |

### Edit behaviour

- Each edit replaces the first match of `oldText`, applied in order to the result of the previous edit.
- If there is no exact match, whole lines are matched ignoring leading and trailing whitespace, and the replacement takes the file's indentation.
- If any edit fails to match, nothing is written.
- Writes and edits to the same file are serialized, so parallel calls cannot overwrite each other's changes.
- Line endings are preserved for files that use LF or CRLF consistently. A file with mixed endings is rewritten with its more common one (LF on a tie).
- Files that are not valid UTF-8 are refused, so their bytes are never rewritten. An empty `oldText` is rejected.
- A failed match reports which edit failed and quotes the closest lines of the file, numbered, with the first differing line, so the edit can be retried accurately.

## Security model

Only paths inside the allowed directories are accessible.

- Paths are resolved to their real location before use, so a symlink pointing outside is refused.
- A new file is allowed only if its parent directory exists and is allowed.
- `write_file` creates files exclusively and never writes through a symlink. It refuses to overwrite anything that is not a regular file.
- Each allowed directory is stored both as given and realpath'd (for example macOS `/var` and `/private/var`).

### Shell tool

`shell` is off unless you start the server with `--enable-shell`, and it is never served under `--read-only`. **It is not sandboxed.** Only its starting directory (`cwd`, default: the first allowed directory) is checked against the allowed directories; the command itself can read, write and delete anything the server process can, and can use the network. Enabling it removes the guarantee that file access stays inside the allowed directories. Only enable it for a client and model you trust, ideally in a container or a restricted user account.

Commands run with stdin closed, are killed (with the processes they started) after `timeoutMs` (default 30 s, `0` disables) or when the request is cancelled, and each of stdout and stderr is cut to 20,000 characters (start and end kept). Binary output is replaced by a note. A non-zero exit is returned as a result with `isError` set.

Not covered: a directory being swapped for a symlink between validation and the write (a TOCTOU race), Windows/WSL path handling, and case-insensitive or Unicode-equivalent path matching. Do not treat this as a hardened sandbox.

## Usage

Requires Node.js 22 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node dist/index.js [--read-only] [--enable-shell] /path/to/dir [/another/dir ...]
```

`--enable-shell` adds the `shell` tool. `--read-only` serves only tools annotated `readOnlyHint: true` (`read_file`, `read_multiple_files`); the write tools are absent from `tools/list`. An unrecognised `--option` is an error (a mistyped `--read-only` would otherwise start the server writable). Use `--` to pass a directory that starts with `--`.

At least one accessible directory is required, otherwise the server exits.

### MCP client configuration

```json
{
  "mcpServers": {
    "fs": {
      "command": "node",
      "args": ["/absolute/path/to/fs-mcp-server/dist/index.js", "/path/to/allowed/dir"]
    }
  }
}
```

## Development

| Command             | Purpose                           |
| ------------------- | --------------------------------- |
| `pnpm build`        | Compile `src/` to `dist/`         |
| `pnpm watch`        | Compile on change                 |
| `pnpm typecheck`    | Type-check `src/` and `tests/`    |
| `pnpm test`         | Run the vitest suite              |
| `pnpm format`       | Format with prettier              |
| `pnpm format:check` | Check formatting                  |
| `pnpm validate`     | Typecheck, test and format check  |

Source layout:

- `src/index.ts`: command-line parsing and the stdio entry point.
- `src/server.ts`: `createServer`, the tool registrations (and `--read-only` filtering).
- `src/paths.ts`: `validatePath`.
- `src/files.ts`: read, head, tail and write.
- `src/shell.ts`: command execution for the shell tool (execa).
- `src/edit.ts`: the `edit_file` engine.
- `tests/`: vitest, one file per module (`paths`, `files`, `edit`, `shell`) plus `server.test.ts` (in-memory MCP client).

## License

MIT
