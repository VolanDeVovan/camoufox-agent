import { z } from "zod";
import { actionSummary, revealValues, tabId, type ToolDef } from "./defs.js";

const point = z.array(z.number()).length(2);

export const computerTools: ToolDef[] = [
  {
    name: "computer",
    description: [
      "Mouse, keyboard and screenshots in a tab. Every click / key reply says what the page did: navigated, page changed, opened tab N, dialog (and how it was answered), download, or nothing happened. Disabled, hidden or covered elements are refused, not clicked.",
      "Actions:",
      "- left_click, right_click, double_click, triple_click: `ref` (from read_page / find) or `coordinate` [x, y] from the last screenshot; optional `modifiers` (\"ctrl+shift\").",
      "- type: `text` goes into the focused element (or into `ref`, which is clicked first). Pasted by default; `per_key: true` types key by key with human delays, for OTP boxes, autocomplete and sites that watch keydown.",
      '- key: `text` is a key or chord ("Enter", "ctrl+a", "cmd+k"), several separated by spaces; `repeat`.',
      "- scroll: `scroll_direction` (up/down/left/right), `scroll_amount` in wheel notches (default 3), at `coordinate` / `ref` (default: the centre).",
      "- scroll_to: bring `ref` into view.",
      "- left_click_drag: from `start_coordinate` or `start_ref` to `coordinate` or `ref`.",
      "- hover: `ref` or `coordinate`.",
      "- screenshot: the tab's viewport as an image, sized for you (`scale` 0.1-1 shrinks it further). Coordinates you pass afterwards are in this image's pixels.",
      "- zoom: `region` [x0, y0, x1, y1] of the last screenshot at full detail, for reading small text.",
      "- wait: `duration` seconds (at most 30).",
      "Input looks human by itself (cursor paths, paste, key rhythm); there is nothing to enable.",
    ].join("\n"),
    shape: {
      action: z.enum(["left_click", "right_click", "double_click", "triple_click", "type", "key", "scroll", "scroll_to", "left_click_drag", "hover", "screenshot", "zoom", "wait"]),
      ref: z.string().optional().describe("Element ref from read_page / find (e12, f1e12)."),
      coordinate: point.optional().describe("[x, y] in pixels of the last screenshot."),
      text: z.string().optional().describe("Text for type; key or chord for key."),
      per_key: z.boolean().optional().describe("type: key by key instead of paste."),
      modifiers: z.string().optional().describe('Keys held during a click: "ctrl", "shift", "alt", "cmd", joined with +.'),
      repeat: z.number().int().min(1).max(100).optional().describe("key: how many times."),
      scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
      scroll_amount: z.number().int().min(1).max(50).optional().describe("Wheel notches (about 100 px each)."),
      start_coordinate: point.optional().describe("left_click_drag: where the drag starts."),
      start_ref: z.string().optional().describe("left_click_drag: the element the drag starts on."),
      region: z.array(z.number()).length(4).optional().describe("zoom: [x0, y0, x1, y1] in pixels of the last screenshot."),
      scale: z.number().min(0.1).max(1).optional().describe("screenshot: shrink further (1 = the automatic size)."),
      duration: z.number().min(0).max(30).optional().describe("wait: seconds."),
      action_summary: actionSummary,
      reveal_values: revealValues,
      tabId,
    },
  },
  {
    name: "form_input",
    description:
      "Set a form field by ref: text for inputs and textareas (pasted, replacing the content), true / false for checkboxes and radios, an option's label for selects. The reply says what the page did. Disabled and hidden fields are refused. For file inputs use file_upload.",
    shape: {
      ref: z.string().describe("Field ref from read_page / find."),
      value: z.union([z.string(), z.boolean(), z.number()]).describe("Text, true / false, or the option to select."),
      action_summary: actionSummary,
      reveal_values: revealValues,
      tabId,
    },
  },
  {
    name: "javascript_tool",
    description:
      'Run JavaScript in a tab and return the value of the last expression (promises are awaited; the value must be JSON-serializable, DOM nodes cannot be returned). world "main" (default) is the page\'s own world, as in Claude in Chrome; "isolated" cannot be seen by the page and sees no page-defined globals. The result is returned as is: this is the one tool whose output is NOT masked, so do not print cookies or tokens you do not need. Do not call alert / confirm / prompt without arming handle_dialog.',
    shape: {
      text: z.string().describe("JavaScript. The value of the last expression is the result."),
      world: z.enum(["main", "isolated"]).optional(),
      timeout_s: z.number().min(1).max(60).optional().describe("Seconds before giving up (default 20)."),
      max_chars: z.number().int().positive().optional().describe("Cap on the result size (default 20000)."),
      tabId,
    },
  },
  {
    name: "file_upload",
    description:
      "Upload files through a file input (or a button that opens a file chooser). Relative paths are taken under the session's working directory and may not leave it; a file anywhere else needs an absolute path. The reply echoes the resolved paths.",
    shape: {
      ref: z.string().describe('Ref of the file input (read_page lists it with role "file") or of the element that opens the chooser.'),
      paths: z.array(z.string()).min(1).describe("Files to upload."),
      tabId,
    },
  },
  {
    name: "resize_window",
    description:
      "Resize a profile's window so that the page area has the given size in CSS pixels. A tiling window manager may refuse; the reply gives the size actually in effect.",
    shape: {
      width: z.number().int().min(200).max(7680),
      height: z.number().int().min(200).max(4320),
      tabId,
    },
  },
  {
    name: "browser_batch",
    description:
      "Run several tool calls in order in one round trip. Stops at the first error and says which steps did not run. Each step is {tool, args} with the same arguments as the tool itself.",
    shape: {
      actions: z
        .array(z.object({ tool: z.string().describe("Tool name."), args: z.record(z.string(), z.any()).optional().describe("That tool's arguments.") }))
        .min(1)
        .max(30),
    },
  },
];
