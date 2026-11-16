import { z } from "zod";
import { revealValues, tabId, type ToolDef } from "./defs.js";

const requestFilter = {
  pattern: z.string().optional().describe("Regular expression matched against the URL (case-insensitive)."),
  since: z.number().int().min(0).optional().describe("Only requests with an id greater than this."),
  resource_type: z.string().optional().describe("document, xhr, fetch, script, stylesheet, image, font, websocket, ..."),
  method: z.string().optional(),
  failed_only: z.boolean().optional().describe("Only failed requests and 4xx / 5xx responses."),
};

export const networkTools: ToolDef[] = [
  {
    name: "read_console_messages",
    description:
      "Console messages and uncaught page errors of a tab, captured since the tab opened. Filter with `pattern` (a regular expression) and `level`. Untrusted page data.",
    shape: {
      pattern: z.string().optional().describe("Regular expression matched against the message text."),
      level: z.enum(["error", "warning", "info", "log", "debug", "all"]).optional(),
      limit: z.number().int().positive().optional().describe("Newest N messages (default 100)."),
      clear: z.boolean().optional().describe("Empty the buffer after reading."),
      reveal_values: revealValues,
      tabId,
    },
    readOnly: true,
  },
  {
    name: "read_network_requests",
    description:
      "Requests a tab made, captured since the tab opened: id, method, status, URL, type, size, time. Use get_network_request(id) for headers and bodies - reading an API's JSON there is often better than scraping the page.",
    shape: {
      ...requestFilter,
      limit: z.number().int().positive().optional().describe("Newest N requests (default 100)."),
      clear: z.boolean().optional().describe("Empty the buffer after reading."),
      reveal_values: revealValues,
      tabId,
    },
    readOnly: true,
  },
  {
    name: "get_network_request",
    description:
      "One captured request by id: request and response headers, request body, and the response body when it is text (JSON, HTML, ...). Secrets are masked unless reveal_values. Untrusted page data.",
    shape: {
      id: z.number().int().describe("Request id from read_network_requests."),
      max_chars: z.number().int().positive().optional().describe("Cap per body (default 20000)."),
      reveal_values: revealValues,
      tabId,
    },
    readOnly: true,
  },
  {
    name: "wait_for_network",
    description:
      "Wait for a request matching a URL pattern and return it with headers and bodies. By default it waits for a response that finishes after this call; pass `since` (a request id noted before the action) to also accept one that already happened, e.g. the XHR a click just fired.",
    shape: {
      pattern: z.string().describe("Regular expression matched against the URL."),
      method: z.string().optional(),
      phase: z.enum(["request", "response"]).optional().describe('"response" (default): the response has finished. "request": the request was sent.'),
      since: z.number().int().min(0).optional().describe("Accept requests with an id greater than this (0: any captured request)."),
      timeout_s: z.number().min(0.1).max(120).optional().describe("Seconds to wait (default 15)."),
      max_chars: z.number().int().positive().optional(),
      reveal_values: revealValues,
      tabId,
    },
    readOnly: true,
  },
  {
    name: "block_requests",
    description:
      "Block requests of a tab by resource type (image, font, media, stylesheet, script, ...) and / or URL pattern (substring, or * wildcards), e.g. to speed up heavy pages. Replaces the previous rule; off=true stops blocking.",
    shape: {
      resource_types: z.array(z.string()).optional(),
      url_patterns: z.array(z.string()).optional(),
      off: z.boolean().optional(),
      tabId,
    },
  },
  {
    name: "export_har",
    description:
      "Write a tab's captured requests to a HAR 1.2 file (mode 0600; it contains real cookies and tokens). Default location: the downloads directory. The reply gives the path, not the content.",
    shape: {
      ...requestFilter,
      path: z.string().optional().describe("Where to write (relative to the working directory, or absolute)."),
      tabId,
    },
  },
  {
    name: "export_curl",
    description: "One captured request as a curl command. Secrets are masked unless reveal_values (then the command runs as is).",
    shape: {
      id: z.number().int().describe("Request id from read_network_requests."),
      reveal_values: revealValues,
      tabId,
    },
    readOnly: true,
  },
];
