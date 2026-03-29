import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express, { Express, Request, Response } from "express";
import { resolve } from "node:path";

import { getMcpEndpointUrl } from "../serverConfig.js";

type ProgressNotification = {
  progress: number;
  total?: number;
  message?: string;
};

type TextContent = {
  type: "text";
  text: string;
};

type ToolCallResult = {
  content?: TextContent[];
};

type StreamDeltaPayload = {
  kind: "answer_delta";
  delta: string;
};

function sendSseEvent(res: Response, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readTextContent(result: ToolCallResult) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n\n") ?? "";
}

function parseStreamDelta(message: string | undefined) {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Partial<StreamDeltaPayload>;
    if (parsed.kind !== "answer_delta" || typeof parsed.delta !== "string") {
      return undefined;
    }

    return parsed as StreamDeltaPayload;
  } catch {
    return undefined;
  }
}

function readBodyString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function registerChatApp(app: Express) {
  const chatUiDir = resolve(process.cwd(), "public/chat");
  const router = express.Router();

  router.use(express.static(chatUiDir, { index: false }));

  router.get("/", (_req, res) => {
    res.sendFile(resolve(chatUiDir, "index.html"));
  });

  router.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/api/stream", async (req: Request, res: Response) => {
    const prompt = readBodyString(req.body?.prompt);
    const githubToken = readBodyString(req.body?.githubToken);

    if (!prompt) {
      res.status(400).json({ error: "Prompt is required." });
      return;
    }

    if (!githubToken) {
      res.status(400).json({ error: "GitHub token is required." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abortController = new AbortController();
    const transport = new StreamableHTTPClientTransport(new URL(getMcpEndpointUrl(req)), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${githubToken}`
        }
      }
    });
    const client = new Client({ name: "browser-chat-client", version: "1.0.0" });

    let streamedAnswer = "";
    const abortRequest = () => abortController.abort();
    req.on("close", abortRequest);

    try {
      sendSseEvent(res, "status", { message: "Connecting to the MCP server" });
      await client.connect(transport);
      sendSseEvent(res, "status", { message: "Connected. Asking the Java expert" });

      const result = await client.callTool(
        {
          name: "java_expert_answer",
          arguments: {
            question: prompt,
            streamResponse: true
          }
        },
        undefined,
        {
          signal: abortController.signal,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: 300000,
          onprogress: (progress: ProgressNotification) => {
            const delta = parseStreamDelta(progress.message);
            if (delta) {
              streamedAnswer += delta.delta;
              sendSseEvent(res, "delta", { delta: delta.delta });
              return;
            }

            sendSseEvent(res, "progress", {
              progress: progress.progress,
              total: progress.total,
              message: progress.message ?? ""
            });
          }
        }
      );

      const finalAnswer = readTextContent(result as ToolCallResult);
      if (!streamedAnswer && finalAnswer) {
        sendSseEvent(res, "delta", { delta: finalAnswer });
      } else if (finalAnswer && finalAnswer !== streamedAnswer) {
        sendSseEvent(res, "replace", { text: finalAnswer });
      }

      sendSseEvent(res, "done", { text: finalAnswer });
    } catch (error) {
      if (!abortController.signal.aborted) {
        sendSseEvent(res, "error", { message: errorMessage(error) });
      }
    } finally {
      req.off("close", abortRequest);
      await transport.close().catch(() => undefined);
      res.end();
    }
  });

  app.use("/chat", router);
}