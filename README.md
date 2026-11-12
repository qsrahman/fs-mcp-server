# workshop-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client tools to read, write and edit files, run shell commands, fetch web pages and (with a Brave API key) search the web. It serves over stdio.

**By default it is not restricted to any directory and the shell is on.** Turn things off with `--no-shell`, `--no-fetch` and `--read-only`, or limit file access by listing directories. See [Security model](#security-model) before pointing it at a model you do not fully trust.

> **Formerly `@qsrahman/fs-mcp-server`.** That name described only the file tools; the package was renamed when the web tools arrived. The old package is deprecated and stays at 0.2.0. To switch, replace `@qsrahman/fs-mcp-server` with `@qsrahman/workshop-mcp` in your client configuration; the command it installs is now `workshop-mcp`.

The file tools are ported, in trimmed form, from the reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem), and the optional web search tools from the [Brave Search MCP server](https://github.com/brave/brave-search-mcp-server). See [License](#license).

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`           | Read a text file. Output is capped at about 100,000 characters; a longer file ends with the offset to continue from. `offset` and `limit` read a range of lines, `head` / `tail` the first / last N lines (use only one of the three). Directories, binary files and text that is not valid UTF-8 are refused with a clear message. |
| `read_multiple_files` | Read up to 50 files at once, about 200,000 characters in total (a file that does not fit is cut, with where to continue). A failure on one file is reported inline and does not stop the others.                                                                                                                                    |
| `write_file`          | Create a file or overwrite it completely, creating any missing parent directories.                                                                                                                                                                                                                                                  |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. Each `oldText` must match exactly one place unless `replaceAll` is set. `dryRun` previews without writing.                                                                                                                                                    |
| `shell`               | Run a shell command; returns its output as plain text, starting with the exit code when it fails and labelling stderr when there is any. On by default; turn it off with `--no-shell` (see below).                                                                                                                                                                                                                |
| `fetch_url`           | Fetch a web page and return its readable content as markdown, in parts for a long page. On by default; turn it off with `--no-fetch`. Refuses private and local addresses, and obeys `robots.txt`.                                                                                                                                  |
| `brave_web_search`    | Search the web with Brave Search; returns a numbered list of results (title, source, age, URL, description). **Only offered when `BRAVE_API_KEY` is set** (see Web search).                                                                                                                                                         |

### For agents

The server sends MCP `instructions` when a client connects: whether file access is limited to directories, how relative paths resolve, and advice to read before editing, to prefer `edit_file` over `write_file`, and to use `offset` and `limit` on long files. Errors name the path as the client wrote it (`File not found: src/a.ts`, `src is a directory, not a file`). Tool inputs are strict: an unknown or misspelled argument (for example `start_line` for `offset`) is an error that names it, not something silently ignored. Every parameter has a description. The tool list never changes while the server runs, so it is announced with `listChanged: false`, and a client on the 2026-07-28 protocol revision may cache it for five minutes. A call whose arguments hold more than 5,000 array elements and object members combined (about 1,600 edits) is rejected before it runs; string contents such as a file's text do not count.

### Fetching web pages

`fetch_url` fetches a URL and returns the page's main content as markdown, without the navigation and footers. It is on by default, needs no key, and is the natural partner of `brave_web_search`: search to find a page, fetch to read it.

- It asks the site for markdown first and returns markdown as it is, otherwise it extracts the article from the HTML (with Mozilla's Readability) and converts it. `raw: true` returns the source instead. Text such as JSON passes through; images, PDFs and other binary content are refused.
- A long page is cut at `max_length` characters (default 20,000), and the result says which `start_index` to continue from. The page is kept in memory for five minutes, so reading the rest does not fetch it again.
- It sends an honest `User-Agent` (`workshop-mcp/<version>`) and **obeys `robots.txt`**, on every redirect hop. A site that forbids automated access, or whose `robots.txt` cannot be read, is refused with a message that tells the model to let you know. `--ignore-robots-txt` turns that off.
- **Private and local addresses are refused**: loopback (`localhost`, `127.0.0.1`), private ranges, link-local and cloud metadata addresses such as `169.254.169.254`, however they are spelled, and after every redirect. The check is made at the moment of connecting, so a host name cannot answer differently the second time. Fetching your own dev server needs `--allow-private-ips`.
- `--allowed-hosts example.com,*.docs.example.org` limits fetching to those hosts (an exact host, or `*.domain` for any subdomain but not the domain itself), for every request including `robots.txt` and redirects.
- Responses are read up to 5 MiB (counted after decompression), with a 30 second default timeout per request, and at most 10 redirects. Only the first 1.5 million characters of a very large HTML page are converted, because conversion runs on the server's main thread.
- The content is untrusted text from third parties. The tool description and server instructions tell the model to use it as information, never as instructions, and to cite the URL, but see Security model.

### Web search (optional)

`brave_web_search` searches the web through the [Brave Search API](https://brave.com/search/api/). They are offered only when the `BRAVE_API_KEY` environment variable is set, so without a key nothing changes. Create a key in the [Brave Search API dashboard](https://api-dashboard.search.brave.com/app/keys) and give it to the server through your client's `env` setting (examples below), not on the command line, where it would show in process listings.

- It takes a `query` and, optionally, `count`, `offset` (pages), `freshness` (`pd`, `pw`, `pm`, `py`, or a date range), `country`, `search_lang` and `safesearch`. Results come back as a short numbered list to keep them cheap in tokens. Snippets are requested without highlight markup.
- The results are third-party web text. The tool descriptions and server instructions tell the model to treat them as information, never as instructions, and to cite URLs, but a prompt injection in a page remains a risk while the shell and file-writing tools are on. If that matters, start the server with `--no-shell` or `--read-only`. Searching changes nothing locally, so `--read-only` keeps this tool.
- The key is removed from the environment of the `shell` tool, so commands the model runs cannot print it. With the default unrestricted file access, though, the model can read any file you can, including a client config file that contains the key. List directories and use `--no-shell` if the key must stay out of reach (see Security model).
- Brave's free plan allows about one request per second. A rate-limit answer that resets within five seconds is waited out and retried once; a longer one, such as a used-up monthly quota, is reported as an error that says when it resets. Your search queries go to Brave.

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
| no web fetching                              | `--no-fetch`                               |
| fetching only from some sites                | `--allowed-hosts a.com,*.b.org`            |
| no writing or editing, and no shell          | `--read-only`                              |
| the file tools limited to some directories   | list them: `workshop-mcp /path/a /path/b` |
| file access limited to directories, for real | list them **and** add `--no-shell`         |

The last row matters: listing directories limits the file tools and the shell's _starting_ directory, but a shell command can still touch anything, so directories alone are not a boundary while the shell is on.

### Limiting file access to directories (optional)

When directories are listed, only paths inside them are accessible to the file tools.

- Paths are resolved to their real location before use, so a symlink pointing outside is refused.
- A new path is allowed when its nearest existing ancestor is inside the allowed directories (that ancestor is resolved through symlinks first). `write_file` then creates the missing directories below it.
- Each allowed directory is stored both as given and realpath'd (for example macOS `/var` and `/private/var`).
- If directories are given but none can be opened, the server exits. It never falls back to being unrestricted.

With or without directories, `write_file` creates files exclusively and never writes through a symlink, and refuses to overwrite anything that is not a regular file. Relative paths resolve against the first allowed directory, or against the server's working directory when there are none.

### Fetching web pages

`fetch_url` can request any public URL, which makes it a way for data to leave the machine: a page the model reads may carry hidden instructions telling it to read a file and put the contents in a URL it then fetches. The server cannot tell such a request from a legitimate one. The protections are the ones that limit what the model can do or reach: `--allowed-hosts` (the strongest, since an unlisted host is never contacted), `--no-fetch`, and keeping private data out of reach with directories and `--no-shell`. Note that `--read-only` does not turn fetching off, because a fetch changes nothing on this machine.

Separately, the address check keeps `fetch_url` from being used against services on your own machine or network (the classic server-side request forgery): see Fetching web pages above. It does not defend against a malicious page, only against being aimed inward.

### Web search

The two search tools send queries to Brave and return web text the model then reads. The text is untrusted, so a page can try to steer the model. The server tells the model not to follow it, which is a mitigation, not a boundary; what limits the damage is what the model is allowed to do next (`--no-shell`, `--read-only`, directories). The API key is held only in the server's memory and the `X-Subscription-Token` header of the request to Brave; it is never returned by a tool and is removed from the shell's environment.

### Shell tool

`shell` is on by default. `--no-shell` removes it, and `--read-only` never serves it. **It is not sandboxed:** the command can read, write and delete anything the server process can, and can use the network. Its starting directory (`cwd`) defaults to the first allowed directory, or the server's working directory when there are none; with directories listed, `cwd` must be inside them, but the command itself is not confined.

Commands run with stdin closed, are killed (with the processes they started) after `timeoutMs` (default 30 s, `0` disables) or when the request is cancelled, and each of stdout and stderr is cut to 20,000 characters (start and end kept). Terminal escape sequences are stripped and binary output is replaced by a note. A non-zero exit is returned as a result with `isError` set. The `BRAVE_API_KEY` environment variable is not passed to commands.

### Limits of the checks

Path resolution (`realpath`, `lstat`) gives up after 15 seconds with a message naming the path, so a file on a stalled cloud-storage or network drive does not hang the request forever. Reads and writes of the file itself are not time-limited. Not covered: a directory being swapped for a symlink between validation and the write (a TOCTOU race), Windows/WSL path handling, and case-insensitive or Unicode-equivalent path matching. Do not treat this as a hardened sandbox.

## Usage

Requires Node.js 22 or newer.

### With npx

Install nothing; npx fetches the [published package](https://www.npmjs.com/package/@qsrahman/workshop-mcp) on first use and caches it:

```bash
npx -y @qsrahman/workshop-mcp [--read-only] [--no-shell] [/path/to/dir ...]
```

Other ways to run it: build from source (below), or install straight from GitHub with `npx -y github:qsrahman/workshop-mcp`. A git install builds the package with its `prepare` script, which npm skips if `ignore-scripts` is set in your npm config. To try a local build, run `pnpm pack` and then `npx -y --package ./qsrahman-workshop-mcp-0.3.0.tgz workshop-mcp`.

### From source

Requires [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node dist/index.js [--read-only] [--no-shell] [/path/to/dir ...]
```

### Options

| Option                | Effect                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-shell`          | Do not serve the `shell` tool. It is on by default.                                                                                                   |
| `--read-only`         | Serve only `read_file` and `read_multiple_files` (tools annotated `readOnlyHint: true`). Writing, editing and the shell are absent from `tools/list`. |
| `--no-fetch`          | Do not serve `fetch_url`. It is on by default.                                                                                                        |
| `--allow-private-ips` | Let `fetch_url` reach private, loopback and link-local addresses (a local dev server). Refused by default.                                            |
| `--ignore-robots-txt` | Do not consult `robots.txt` before fetching a page.                                                                                                   |
| `--allowed-hosts`     | Limit `fetch_url` to these hosts: a comma-separated list (or repeat the option) of exact hosts and `*.domain` entries.                                |
| `<directory> ...`     | Optional. Limit the file tools to these directories (and the shell's starting directory). Use absolute paths. With none, nothing is limited.          |
| `--`                  | Ends the options, so a directory that starts with `--` can follow.                                                                                    |

An unrecognised option is an error and the server exits (a mistyped `--read-only` or `--no-shell` would otherwise start it with more access than you asked for). A listed directory that does not exist is skipped with a warning; if every listed directory is unusable the server exits, it does not become unrestricted.

### Connect a client

Every client below starts the server as a subprocess over stdio. The examples below are unrestricted with the shell on, which is the default. Add `--no-shell` or `--read-only` after the package name to take access away, and absolute directories after it to limit the file tools (see [Security model](#security-model)).

#### Claude Code

```bash
claude mcp add workshop -- npx -y @qsrahman/workshop-mcp
```

Everything after `--` is the server command, so server options go there too. The default scope is just you in the current project; add `--scope project` before the name to write a shareable `.mcp.json`, or `--scope user` to use it in every project:

```bash
claude mcp add --scope project workshop -- npx -y @qsrahman/workshop-mcp --no-shell /path/to/project
```

A project's `.mcp.json` looks like this (Claude Code asks you to approve a project server before using it):

```json
{
  "mcpServers": {
    "workshop": {
      "command": "npx",
      "args": ["-y", "@qsrahman/workshop-mcp"]
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
    "workshop": {
      "command": "npx",
      "args": ["-y", "@qsrahman/workshop-mcp"]
    }
  }
}
```

Quit and restart Claude Desktop completely after saving. The server's stderr (including the line it prints at startup that says whether file access is restricted) goes to `~/Library/Logs/Claude/mcp-server-workshop.log` on macOS, `%APPDATA%\Claude\logs` on Windows and `~/.config/Claude/logs` on Linux.

#### Cursor

Put this in `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (everywhere):

```json
{
  "mcpServers": {
    "workshop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@qsrahman/workshop-mcp"]
    }
  }
}
```

#### VS Code

Put this in `.vscode/mcp.json` in your workspace, or in your user profile's `mcp.json`. VS Code's format differs from the others: the top-level key is `servers`, not `mcpServers`, and `type` is required.

```json
{
  "servers": {
    "workshop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@qsrahman/workshop-mcp"]
    }
  }
}
```

#### Enabling web search

Add the key to the server's environment. For Claude Code, put another option between `--env` and the name:

```bash
claude mcp add --env BRAVE_API_KEY=YOUR_KEY --transport stdio workshop -- npx -y @qsrahman/workshop-mcp
```

For Claude Desktop and Cursor, add an `env` object to the server entry:

```json
"workshop": {
  "command": "npx",
  "args": ["-y", "@qsrahman/workshop-mcp"],
  "env": { "BRAVE_API_KEY": "YOUR_KEY" }
}
```

Keep the key out of anything you commit; `.mcp.json` and Cursor's project `mcp.json` are normally committed.

#### From a source checkout

To run your own build, after `pnpm install && pnpm build`, replace the command in any of the configs above with Node and the built entry point:

```json
{ "command": "node", "args": ["/absolute/path/to/workshop-mcp/dist/index.js"] }
```

For Claude Code: `claude mcp add workshop -- node /absolute/path/to/workshop-mcp/dist/index.js`.

#### If it does not connect

- Run the same command in a terminal. It prints `workshop-mcp running on stdio. File access is not restricted.` (or `Allowed: ...` when you listed directories) on stderr and then waits for input; press Ctrl-C to stop.
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
- `src/net.ts`: the safe HTTP GET behind `fetch_url` (address policy, redirects, size cap).
- `src/web.ts`: `fetch_url`: robots.txt, decoding, extraction to markdown, paging.
- `src/brave.ts`: the Brave Search client.
- `tests/`: vitest, one file per module (`paths`, `files`, `edit`, `shell`) plus `server.test.ts` (in-memory MCP client).

## License

MIT (see `LICENSE`). Parts are adapted from [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (the file tools) and [brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server) (the web search tools), under their own licences; the fetch tool follows the design of the fetch server in the same repository. See `THIRD_PARTY_NOTICES.md`.
