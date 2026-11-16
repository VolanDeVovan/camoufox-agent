import type { ToolDef } from "./defs.js";
import { readTools } from "./read.js";
import { tabTools } from "./tabs.js";

export const allTools: ToolDef[] = [...tabTools, ...readTools];
