// How a tool is declared on the MCP side: a name, a description and a zod shape.
// The handler lives in the daemon; the MCP server only validates and forwards.
import { z, type ZodRawShape } from "zod";

export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  /** Read-only tools are annotated as such for the client. */
  readOnly?: boolean;
}

export const tabId = z
  .number()
  .int()
  .optional()
  .describe("Tab to act on, from tabs_context. Omitted: this session's active tab. Pass it always when several agents share the session.");

export const revealValues = z
  .boolean()
  .optional()
  .describe("Show secrets (cookie values, tokens, passwords) instead of masking them. They end up in the transcript; use only when the value itself is needed.");

export const profileArg = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "profile names match [a-z0-9][a-z0-9-]*")
  .max(64)
  .optional();
