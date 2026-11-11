# fs-mcp-server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client read and write access to files inside directories you choose. It serves over stdio.

The tools are ported, in trimmed form, from the reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`           | Read a text file. Output is capped at about 100,000 characters; a longer file ends with the offset to continue from. `offset` and `limit` read a range of lines, `head` / `tail` the first / last N lines (use only one of the three). Directories, binary files and text that is not valid UTF-8 are refused with a clear message. |
| `read_multiple_files` | Read up to 50 files at once, about 200,000 characters in total (a file that does not fit is cut, with where to continue). A failure on one file is reported inline and does not stop the others.                                                                                                                                    |
| `write_file`          | Create a file or overwrite it completely, creating any missing parent directories inside the allowed directories.                                                                                                                                                                                                                   |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. Each `oldText` must match exactly one place unless `replaceAll` is set. `dryRun` previews without writing.                                                                                                                                                    |
| `shell`               | Run a shell command; returns stdout, stderr and exit code. **Opt-in** with `--enable-shell` (see below).                                                                                                                                                                                                                            |

### For agents

The server sends MCP `instructions` when a client connects: the allowed directories, how relative paths resolve, and advice to read before editing, to prefer `edit_file` over `write_file`, and to use `offset` and `limit` on long files. Errors name the path as the client wrote it (`File not found: src/a.ts`, `src is a directory, not a file`). Tool inputs are strict: an unknown or misspelled argument (for example `start_line` for `offset`) is an error that names it, not something silently ignored. Every parameter has a description. The tool list never changes while the server runs, so it is announced with `listChanged: false`, and a client on the 2026-07-28 protocol revision may cache it for five minutes. A call whose arguments hold more than 5,000 array elements and object members combined (about 1,600 edits) is rejected before it runs; string contents such as a file's text do not count.

### Edit behaviour

- Edits apply in order, each to the result of the previous one. `oldText` must match exactly one place: if it matches several, the edit fails and lists the line numbers, so add surrounding lines to make it unique or set `replaceAll: true` to replace every match.
- If there is no exact match, whole lines are matched ignoring leading and trailing whitespace, and the replacement takes the file's indentation.
- If any edit has no match or an ambiguous one, nothing is written.
- Writes and edits to the same file are serialized, so parallel calls cannot overwrite each other's changes.
- Line endings are preserved for files that use LF or CRLF consistently. A file with mixed endings is rewritten with its more common one (LF on a tie).
- Files that are not valid UTF-8 are refused, so their bytes are never rewritten. An empty `oldText` is rejected.
- A failed match reports which edit failed and quotes the closest lines of the file, numbered, with the first differing line, so the edit can be retried accurately.

## Security model

Only paths inside the allowed directories are accessible.

- Paths are resolved to their real location before use, so a symlink pointing outside is refused.
- A new path is allowed when its nearest existing ancestor is inside the allowed directories (that ancestor is resolved through symlinks first). `write_file` then creates the missing directories below it.
- `write_file` creates files exclusively and never writes through a symlink. It refuses to overwrite anything that is not a regular file.
- Each allowed directory is stored both as given and realpath'd (for example macOS `/var` and `/private/var`).

### Shell tool

`shell` is off unless you start the server with `--enable-shell`, and it is never served under `--read-only`. **It is not sandboxed.** Only its starting directory (`cwd`, default: the first allowed directory) is checked against the allowed directories; the command itself can read, write and delete anything the server process can, and can use the network. Enabling it removes the guarantee that file access stays inside the allowed directories. Only enable it for a client and model you trust, ideally in a container or a restricted user account.

Commands run with stdin closed, are killed (with the processes they started) after `timeoutMs` (default 30 s, `0` disables) or when the request is cancelled, and each of stdout and stderr is cut to 20,000 characters (start and end kept). Terminal escape sequences are stripped and binary output is replaced by a note. A non-zero exit is returned as a result with `isError` set.

Path resolution (`realpath`, `lstat`) gives up after 15 seconds with a message naming the path, so a file on a stalled cloud-storage or network drive does not hang the request forever. Reads and writes of the file itself are not time-limited. Not covered: a directory being swapped for a symlink between validation and the write (a TOCTOU race), Windows/WSL path handling, and case-insensitive or Unicode-equivalent path matching. Do not treat this as a hardened sandbox.

## Usage

Requires Node.js 22 or newer.

### With npx

Once the package is published to npm:

```bash
npx -y fs-mcp-server [--read-only] [--enable-shell] /path/to/dir [/another/dir ...]
```

Before then, run a built tarball (`pnpm pack`, then `npx -y --package ./fs-mcp-server-0.1.0.tgz fs-mcp-server /path/to/dir`) or build from source below. Installing straight from a git URL builds the package with its `prepare` script, which npm skips if `ignore-scripts` is set in your npm config.

### From source

Requires [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node dist/index.js [--read-only] [--enable-shell] /path/to/dir [/another/dir ...]
```

### Options

`--enable-shell` adds the `shell` tool. `--read-only` serves only tools annotated `readOnlyHint: true` (`read_file`, `read_multiple_files`); the write tools are absent from `tools/list`. An unrecognised option is an error (a mistyped `--read-only` would otherwise start the server writable). Use `--` to pass a directory that starts with `--`.

At least one accessible directory is required, otherwise the server exits.

### Connect a client

Every client below starts the server as a subprocess over stdio. Use an **absolute** path for the allowed directory (and any more after it); add `--read-only` or `--enable-shell` after the package name if you want them. Until the package is published to npm, use the source-checkout form at the end of this section.

#### Claude Code

```bash
claude mcp add fs -- npx -y fs-mcp-server /path/to/allowed/dir
```

Everything after `--` is the server command, so server options go there too. The default scope is just you in the current project; add `--scope project` before the name to write a shareable `.mcp.json`, or `--scope user` to use it in every project:

```bash
claude mcp add --scope project fs -- npx -y fs-mcp-server --read-only /path/to/allowed/dir
```

A project's `.mcp.json` looks like this (Claude Code asks you to approve a project server before using it):

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "fs-mcp-server", "/path/to/allowed/dir"]
    }
  }
}
```

#### Claude Desktop

Open **Settings → Developer → Edit Config** (from the Claude menu in the menu bar), or edit the file directly:

| OS      | File                                                              |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                    |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "fs-mcp-server", "/Users/you/projects/app"]
    }
  }
}
```

Quit and restart Claude Desktop completely after saving. The server's stderr (including the "Allowed: ..." line it prints at startup) goes to `~/Library/Logs/Claude/mcp-server-fs.log` on macOS, `%APPDATA%\Claude\logs` on Windows and `~/.config/Claude/logs` on Linux.

#### Cursor

Put this in `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (everywhere):

```json
{
  "mcpServers": {
    "fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fs-mcp-server", "/path/to/allowed/dir"]
    }
  }
}
```

#### VS Code

Put this in `.vscode/mcp.json` in your workspace, or in your user profile's `mcp.json`. VS Code's format differs from the others: the top-level key is `servers`, not `mcpServers`, and `type` is required.

```json
{
  "servers": {
    "fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fs-mcp-server", "/path/to/allowed/dir"]
    }
  }
}
```

#### From a source checkout

After `pnpm install && pnpm build`, replace the command in any of the configs above with Node and the built entry point:

```json
{ "command": "node", "args": ["/absolute/path/to/fs-mcp-server/dist/index.js", "/path/to/allowed/dir"] }
```

For Claude Code: `claude mcp add fs -- node /absolute/path/to/fs-mcp-server/dist/index.js /path/to/allowed/dir`.

#### If it does not connect

- Run the same command in a terminal. It prints `FS MCP Server running on stdio. Allowed: ...` on stderr and then waits for input; press Ctrl-C to stop.
- A relative directory is resolved against the client's working directory, which is often not the one you expect, so always use absolute paths. A directory that does not exist is skipped with a warning; with none left the server exits.
- An unknown option such as `--readonly` is an error, not a directory. Check the spelling.
- The server needs Node.js 22 or newer on the `PATH` the client uses; GUI apps do not always see your shell's `PATH`.

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
