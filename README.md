# fs-mcp-server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client read and write access to files inside directories you choose. It serves over stdio.

The tools are ported, in trimmed form, from the reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

## Tools

| Tool                  | What it does                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `read_text_file`      | Read a file as text. Optional `head` or `tail` returns only the first or last N lines (not both).         |
| `read_multiple_files` | Read several files at once. A failure on one file is reported inline and does not stop the others.        |
| `write_file`          | Create a file or overwrite it completely.                                                                 |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. `dryRun` previews without writing. |

### Edit behaviour

- Each edit replaces the first match of `oldText`, applied in order to the result of the previous edit.
- If there is no exact match, whole lines are matched ignoring leading and trailing whitespace, and the replacement takes the file's indentation.
- If any edit fails to match, nothing is written.
- Line endings (LF or CRLF) are preserved.

## Security model

Only paths inside the allowed directories are accessible.

- Paths are resolved to their real location before use, so a symlink pointing outside is refused.
- A new file is allowed only if its parent directory exists and is allowed.
- `write_file` creates files exclusively and never writes through a symlink. It refuses to overwrite anything that is not a regular file.
- Each allowed directory is stored both as given and realpath'd (for example macOS `/var` and `/private/var`).

Not covered: a directory being swapped for a symlink between validation and the write (a TOCTOU race), Windows/WSL path handling, and case-insensitive or Unicode-equivalent path matching. Do not treat this as a hardened sandbox.

## Usage

Requires Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node dist/index.js /path/to/dir [/another/dir ...]
```

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
| `pnpm typecheck`    | Type-check `src/` without emitting |
| `pnpm test`         | Run the vitest suite              |
| `pnpm format`       | Format with prettier              |
| `pnpm format:check` | Check formatting                  |

Source layout:

- `src/index.ts`: tool registration, command-line parsing, stdio entry point.
- `src/lib.ts`: path validation and file operations.
- `tests/`: vitest tests for `src/lib.ts`.

## License

MIT
