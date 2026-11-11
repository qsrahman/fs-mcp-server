# fs-mcp-server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client tools to read, write and edit files and to run shell commands. It serves over stdio.

**By default it is not restricted to any directory and the shell is on.** Turn things off with `--no-shell` and `--read-only`, or limit file access by listing directories. See [Security model](#security-model) before pointing it at a model you do not fully trust.

The tools are ported, in trimmed form, from the reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`           | Read a text file. Output is capped at about 100,000 characters; a longer file ends with the offset to continue from. `offset` and `limit` read a range of lines, `head` / `tail` the first / last N lines (use only one of the three). Directories, binary files and text that is not valid UTF-8 are refused with a clear message. |
| `read_multiple_files` | Read up to 50 files at once, about 200,000 characters in total (a file that does not fit is cut, with where to continue). A failure on one file is reported inline and does not stop the others.                                                                                                                                    |
| `write_file`          | Create a file or overwrite it completely, creating any missing parent directories.                                                                                                                                                                                                                                                  |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. Each `oldText` must match exactly one place unless `replaceAll` is set. `dryRun` previews without writing.                                                                                                                                                    |
| `shell`               | Run a shell command; returns stdout, stderr and exit code. On by default; turn it off with `--no-shell` (see below).                                                                                                                                                                                                                |

### For agents

The server sends MCP `instructions` when a client connects: whether file access is limited to directories, how relative paths resolve, and advice to read before editing, to prefer `edit_file` over `write_file`, and to use `offset` and `limit` on long files. Errors name the path as the client wrote it (`File not found: src/a.ts`, `src is a directory, not a file`). Tool inputs are strict: an unknown or misspelled argument (for example `start_line` for `offset`) is an error that names it, not something silently ignored. Every parameter has a description. The tool list never changes while the server runs, so it is announced with `listChanged: false`, and a client on the 2026-07-28 protocol revision may cache it for five minutes. A call whose arguments hold more than 5,000 array elements and object members combined (about 1,600 edits) is rejected before it runs; string contents such as a file's text do not count.

### Edit behaviour

- Edits apply in order, each to the result of the previous one. `oldText` must match exactly one place: if it matches several, the edit fails and lists the line numbers, so add surrounding lines to make it unique or set `replaceAll: true` to replace every match.
- If there is no exact match, whole lines are matched ignoring leading and trailing whitespace, and the replacement takes the file's indentation.
- If any edit has no match or an ambiguous one, nothing is written.
- Writes and edits to the same file are serialized, so parallel calls cannot overwrite each other's changes.
- Line endings are preserved for files that use LF or CRLF consistently. A file with mixed endings is rewritten with its more common one (LF on a tie).
- Files that are not valid UTF-8 are refused, so their bytes are never rewritten. An empty `oldText` is rejected.
- A failed match reports which edit failed and quotes the closest lines of the file, numbered, with the first differing line, so the edit can be retried accurately.

## Security model

**By default there is no sandbox.** Started without directories, the file tools and the shell can reach anything the user running the server can: your home directory, SSH keys, credentials, other projects. The shell can also run any program and use the network. Use this server only with a client and model you trust, ideally as a restricted user or inside a container, and take away what an agent does not need:

| You want                                     | Start the server with                      |
| -------------------------------------------- | ------------------------------------------ |
| no shell                                     | `--no-shell`                               |
| no writing or editing, and no shell          | `--read-only`                              |
| the file tools limited to some directories   | list them: `fs-mcp-server /path/a /path/b` |
| file access limited to directories, for real | list them **and** add `--no-shell`         |

The last row matters: listing directories limits the file tools and the shell's _starting_ directory, but a shell command can still touch anything, so directories alone are not a boundary while the shell is on.

### Limiting file access to directories (optional)

When directories are listed, only paths inside them are accessible to the file tools.

- Paths are resolved to their real location before use, so a symlink pointing outside is refused.
- A new path is allowed when its nearest existing ancestor is inside the allowed directories (that ancestor is resolved through symlinks first). `write_file` then creates the missing directories below it.
- Each allowed directory is stored both as given and realpath'd (for example macOS `/var` and `/private/var`).
- If directories are given but none can be opened, the server exits. It never falls back to being unrestricted.

With or without directories, `write_file` creates files exclusively and never writes through a symlink, and refuses to overwrite anything that is not a regular file. Relative paths resolve against the first allowed directory, or against the server's working directory when there are none.

### Shell tool

`shell` is on by default. `--no-shell` removes it, and `--read-only` never serves it. **It is not sandboxed:** the command can read, write and delete anything the server process can, and can use the network. Its starting directory (`cwd`) defaults to the first allowed directory, or the server's working directory when there are none; with directories listed, `cwd` must be inside them, but the command itself is not confined.

Commands run with stdin closed, are killed (with the processes they started) after `timeoutMs` (default 30 s, `0` disables) or when the request is cancelled, and each of stdout and stderr is cut to 20,000 characters (start and end kept). Terminal escape sequences are stripped and binary output is replaced by a note. A non-zero exit is returned as a result with `isError` set.

### Limits of the checks

Path resolution (`realpath`, `lstat`) gives up after 15 seconds with a message naming the path, so a file on a stalled cloud-storage or network drive does not hang the request forever. Reads and writes of the file itself are not time-limited. Not covered: a directory being swapped for a symlink between validation and the write (a TOCTOU race), Windows/WSL path handling, and case-insensitive or Unicode-equivalent path matching. Do not treat this as a hardened sandbox.

## Usage

Requires Node.js 22 or newer.

### With npx

Once the package is published to npm:

```bash
npx -y @qsrahman/fs-mcp-server [--read-only] [--no-shell] [/path/to/dir ...]
```

Before then, run a built tarball (`pnpm pack`, then `npx -y --package ./qsrahman-fs-mcp-server-0.1.0.tgz fs-mcp-server`) or build from source below. Installing straight from a git URL builds the package with its `prepare` script, which npm skips if `ignore-scripts` is set in your npm config.

### From source

Requires [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node dist/index.js [--read-only] [--no-shell] [/path/to/dir ...]
```

### Options

| Option            | Effect                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-shell`      | Do not serve the `shell` tool. It is on by default.                                                                                                   |
| `--read-only`     | Serve only `read_file` and `read_multiple_files` (tools annotated `readOnlyHint: true`). Writing, editing and the shell are absent from `tools/list`. |
| `<directory> ...` | Optional. Limit the file tools to these directories (and the shell's starting directory). Use absolute paths. With none, nothing is limited.         |
| `--`              | Ends the options, so a directory that starts with `--` can follow.                                                                                    |

An unrecognised option is an error and the server exits (a mistyped `--read-only` or `--no-shell` would otherwise start it with more access than you asked for). A listed directory that does not exist is skipped with a warning; if every listed directory is unusable the server exits, it does not become unrestricted.

### Connect a client

Every client below starts the server as a subprocess over stdio. The examples below are unrestricted with the shell on, which is the default. Add `--no-shell` or `--read-only` after the package name to take access away, and absolute directories after it to limit the file tools (see [Security model](#security-model)). Until the package is published to npm, use the source-checkout form at the end of this section.

#### Claude Code

```bash
claude mcp add fs -- npx -y @qsrahman/fs-mcp-server
```

Everything after `--` is the server command, so server options go there too. The default scope is just you in the current project; add `--scope project` before the name to write a shareable `.mcp.json`, or `--scope user` to use it in every project:

```bash
claude mcp add --scope project fs -- npx -y @qsrahman/fs-mcp-server --no-shell /path/to/project
```

A project's `.mcp.json` looks like this (Claude Code asks you to approve a project server before using it):

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@qsrahman/fs-mcp-server"]
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
      "args": ["-y", "@qsrahman/fs-mcp-server"]
    }
  }
}
```

Quit and restart Claude Desktop completely after saving. The server's stderr (including the line it prints at startup that says whether file access is restricted) goes to `~/Library/Logs/Claude/mcp-server-fs.log` on macOS, `%APPDATA%\Claude\logs` on Windows and `~/.config/Claude/logs` on Linux.

#### Cursor

Put this in `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (everywhere):

```json
{
  "mcpServers": {
    "fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@qsrahman/fs-mcp-server"]
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
      "args": ["-y", "@qsrahman/fs-mcp-server"]
    }
  }
}
```

#### From a source checkout

After `pnpm install && pnpm build`, replace the command in any of the configs above with Node and the built entry point:

```json
{ "command": "node", "args": ["/absolute/path/to/fs-mcp-server/dist/index.js"] }
```

For Claude Code: `claude mcp add fs -- node /absolute/path/to/fs-mcp-server/dist/index.js`.

#### If it does not connect

- Run the same command in a terminal. It prints `FS MCP Server running on stdio. File access is not restricted.` (or `Allowed: ...` when you listed directories) on stderr and then waits for input; press Ctrl-C to stop.
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
