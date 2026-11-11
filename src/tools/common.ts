import type { McpServer } from '@modelcontextprotocol/server'

/** `server.registerTool`, except that `--read-only` drops tools that write. */
export type RegisterTool = McpServer['registerTool']

export const text = (content: string) => ({
  content: [{ type: 'text' as const, text: content }],
})

/** For tools that only read local state. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

/**
 * For tools that only read from the internet. They change nothing locally, so
 * they are served under --read-only, but they do reach out (openWorldHint).
 */
export const WEB_ANNOTATIONS = { ...READ_ANNOTATIONS, openWorldHint: true }
