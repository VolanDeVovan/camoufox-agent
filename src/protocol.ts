// The wire between an MCP server and the daemon: newline-delimited JSON over a unix
// socket, one request per tool call. The daemon holds no MCP state.
import type { Socket } from "node:net";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface Hello {
  version: string;
  session: string;
  cwd: string;
  defaultProfile: string;
}

export interface Request {
  id: number;
  method: "hello" | "tool" | "status" | "exitWhenIdle";
  params?: any;
}

export interface Response {
  id: number;
  result?: any;
  error?: { message: string };
}

/** Calls `onMessage` for every complete JSON line arriving on the socket. */
export function readLines(socket: Socket, onMessage: (msg: any) => void): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a garbled line is dropped; the peer's request times out
      }
      onMessage(msg);
    }
  });
}

export function send(socket: Socket, msg: Request | Response): void {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + "\n");
}

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
