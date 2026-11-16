import { computerTools } from "./computer.js";
import type { ToolDef } from "./defs.js";
import { httpTools } from "./http.js";
import { networkTools } from "./network.js";
import { readTools } from "./read.js";
import { storageTools } from "./storage.js";
import { tabTools } from "./tabs.js";
import { waitTools } from "./wait.js";

export const allTools: ToolDef[] = [...tabTools, ...readTools, ...computerTools, ...waitTools, ...networkTools, ...storageTools, ...httpTools];
