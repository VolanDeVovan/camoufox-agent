#!/usr/bin/env node
// camoufox-agent: the MCP server, one per Claude Code session. Thin: tool schemas and a
// daemon client. It starts no browser and no daemon until a tool needs one.
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION, defaultProfilesDir, expandHome, validateProfileName, type DaemonConfig } from "../paths.js";
import type { ToolResult } from "../protocol.js";
import { DaemonClient } from "./client.js";
import { INSTRUCTIONS } from "./instructions.js";
import { allTools } from "./tools/index.js";

const HELP = `camoufox-agent ${VERSION} - a Camoufox browser for coding agents (MCP server over stdio)

Usage: camoufox-agent [--default-profile NAME] [--profiles-dir DIR] [--headless]

  --default-profile NAME  profile used when a tool call names none (default: "default")
  --profiles-dir DIR      where profiles live (default: $XDG_DATA_HOME/camoufox-agent/profiles)
  --headless              run browsers without a window
  --version, --help

Register with Claude Code:  claude mcp add camoufox -- npx -y camoufox-agent
`;

function parseArgs(argv: string[]): { config: DaemonConfig; defaultProfile: string } {
  const config: DaemonConfig = { profilesDir: defaultProfilesDir(), headless: false };
  let defaultProfile = "default";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--default-profile") defaultProfile = validateProfileName(value());
    else if (a === "--profiles-dir") config.profilesDir = resolve(expandHome(value()));
    else if (a === "--headless") config.headless = true;
    else if (a === "--version" || a === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
  }
  return { config, defaultProfile };
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e: any) {
    console.error(String(e?.message || e));
    process.exit(2);
  }
  const client = new DaemonClient(parsed.config, parsed.defaultProfile);
  const server = new McpServer({ name: "camoufox-agent", version: VERSION }, { instructions: INSTRUCTIONS });
  const schemas = new Map(allTools.map((t) => [t.name, z.object(t.shape)]));

  const forward = async (name: string, args: unknown): Promise<ToolResult> => {
    try {
      return await client.call(name, args);
    } catch (e: any) {
      return { content: [{ type: "text", text: String(e?.message || e) }], isError: true };
    }
  };

  for (const def of allTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.shape, annotations: def.readOnly ? { readOnlyHint: true } : undefined },
      async (args: any) => {
        if (def.name === "browser_batch") {
          // Each step is validated against its own tool's schema before anything runs.
          const steps: { tool: string; args: unknown }[] = [];
          for (const [i, step] of (args.actions as any[]).entries()) {
            const schema = schemas.get(step.tool);
            if (!schema || step.tool === "browser_batch") {
              return { content: [{ type: "text" as const, text: `Step ${i + 1}: unknown tool "${step.tool}". Nothing was run.` }], isError: true };
            }
            const checked = schema.safeParse(step.args ?? {});
            if (!checked.success) {
              return {
                content: [{ type: "text" as const, text: `Step ${i + 1} (${step.tool}): invalid arguments: ${checked.error.message}. Nothing was run.` }],
                isError: true,
              };
            }
            steps.push({ tool: step.tool, args: checked.data });
          }
          return (await forward("browser_batch", { actions: steps })) as any;
        }
        return (await forward(def.name, args)) as any;
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const bye = () => {
    client.close();
    process.exit(0);
  };
  transport.onclose = bye;
  process.stdin.on("end", bye);
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

void main();
