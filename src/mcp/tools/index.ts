import { computerTools } from "./computer.js";
import type { ToolDef } from "./defs.js";
import { networkTools } from "./network.js";
import { readTools } from "./read.js";
import { tabTools } from "./tabs.js";
import { waitTools } from "./wait.js";

export const allTools: ToolDef[] = [...tabTools, ...readTools, ...computerTools, ...waitTools, ...networkTools];
