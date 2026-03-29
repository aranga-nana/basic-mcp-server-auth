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

function readOAuthTokenError(payload: Record<string, unknown>) {
  const error = typeof payload.error === "string" ? payload.error : "oauth_error";
  const description = typeof payload.error_description === "string" ? payload.error_description : "";
  return description ? `${error}: ${description}` : error;
}

function buildToolQuestion(prompt: string, conversationContext: string) {
  if (!conversationContext) {
    return prompt;
  }

  return [
    "Use this conversation context to answer the latest user question.",
    "If context conflicts with the latest question, prioritize the latest question.",
    "",
    "Conversation context:",
    conversationContext,
    "",
    "Latest user question:",
    prompt
  ].join("\n");
}

function oauthHint(errorCode: string, hasClientSecret: boolean) {
  if (errorCode === "incorrect_client_credentials" && !hasClientSecret) {
    return "Set CLIENT_SECRET in .env.local and restart the server. GitHub OAuth app web flows usually require the client secret on token exchange.";
  }

  if (errorCode === "bad_verification_code") {
    return "Authorization code expired or was reused. Retry sign-in and complete the flow once.";
  }

  if (errorCode === "redirect_uri_mismatch") {
    return "The redirect URI used by the browser must be added to the GitHub OAuth app callback URLs.";
  }

  return "";
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

  router.post("/api/oauth/token", async (req: Request, res: Response) => {
    const code = readBodyString(req.body?.code);
    const codeVerifier = readBodyString(req.body?.codeVerifier);
    const redirectUri = readBodyString(req.body?.redirectUri);

    if (!code || !codeVerifier || !redirectUri) {
      res.status(400).json({ error: "code, codeVerifier and redirectUri are required." });
      return;
    }

    if (!process.env.CLIENT_ID) {
      res.status(500).json({ error: "CLIENT_ID is not configured." });
      return;
    }

    const body = new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });

    if (process.env.CLIENT_SECRET) {
      body.set("client_secret", process.env.CLIENT_SECRET);
    }

    try {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      });

      const payload = (await tokenResponse.json()) as Record<string, unknown>;
      const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
      const providerError = typeof payload.error === "string" ? payload.error : "";
      const providerErrorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
      const hint = oauthHint(providerError, Boolean(process.env.CLIENT_SECRET));

      if (!tokenResponse.ok || !accessToken) {
        res.status(400).json({
          error: readOAuthTokenError(payload),
          hint,
          provider: {
            error: providerError,
            error_description: providerErrorDescription
          }
        });
        return;
      }

      res.json({
        accessToken,
        tokenType: typeof payload.token_type === "string" ? payload.token_type : "bearer",
        scope: typeof payload.scope === "string" ? payload.scope : ""
      });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  router.post("/api/stream", async (req: Request, res: Response) => {
    const prompt = readBodyString(req.body?.prompt);
    const githubToken = readBodyString(req.body?.githubToken);
    const conversationContext = readBodyString(req.body?.conversationContext);

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
    res.on("close", abortRequest);
    req.on("aborted", abortRequest);

    try {
      sendSseEvent(res, "status", { message: "Connecting to the MCP server" });
      await client.connect(transport);
      sendSseEvent(res, "status", { message: "Connected. Asking the Java expert" });

      const result = await client.callTool(
        {
          name: "java_expert_answer",
          arguments: {
            question: buildToolQuestion(prompt, conversationContext),
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
      res.off("close", abortRequest);
      req.off("aborted", abortRequest);
      await transport.close().catch(() => undefined);
      res.end();
    }
  });

  app.use("/chat", router);
}