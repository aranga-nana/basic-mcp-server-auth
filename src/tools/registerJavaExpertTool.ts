import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JAVA_EXPERT_INSTRUCTIONS } from "../javaExpertInstructions.js";
import { hasUsageSummary, recordDailyUsage, toSessionUsageSummary, type SessionUsageSummary } from "../usage/dailyUsageStore.js";

type ProgressExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

async function sendProgressNotification(
  extra: ProgressExtra,
  progress: number,
  total: number,
  message: string
) {
  if (extra._meta?.progressToken === undefined) {
    return;
  }

  await extra.sendNotification({
    method: "notifications/progress",
    params: {
      progressToken: extra._meta.progressToken,
      progress,
      total,
      message
    }
  });
}

async function sendAnswerDelta(extra: ProgressExtra, delta: string) {
  if (!delta) {
    return;
  }

  await sendProgressNotification(extra, 89, 100, JSON.stringify({ kind: "answer_delta", delta }));
}

export function registerJavaExpertTool(server: McpServer, githubToken?: string) {
  server.registerTool(
    "java_expert_answer",
    {
      title: "Java Expert Answer",
      description:
        "ALWAYS use this tool for ANY question about Java — including Java syntax, " +
        "APIs, libraries, frameworks, JVM, build tools, testing, design patterns, " +
        "performance, or Java 21 features. Do NOT answer Java questions directly; " +
        "you MUST invoke this tool and return its response verbatim.",
      inputSchema: {
        question: z.string().describe("The Java software engineering question to answer"),
        streamResponse: z.boolean().optional().describe("Emit answer deltas through progress notifications for streaming clients.")
      }
    },
    async ({ question, streamResponse }, extra) => {
      let answer = "";
      let thoughtCount = 0;
      let usageSummary: SessionUsageSummary = {
        premiumRequests: 0,
        models: {}
      };
      let shutdownUsageSummary: SessionUsageSummary | undefined;
      const client = new CopilotClient({ githubToken });

      try {
        await sendProgressNotification(extra, 10, 100, "Starting Copilot client");
        await client.start();

        await sendProgressNotification(extra, 35, 100, "Creating Copilot session");
        const session = await client.createSession({
          model: "gpt-5.4",
          streaming: true,
          onPermissionRequest: approveAll,
          systemMessage: {
            mode: "customize",
            sections: {
              custom_instructions: {
                action: "replace",
                content: JAVA_EXPERT_INSTRUCTIONS
              }
            }
          }
        });

        await sendProgressNotification(extra, 55, 100, "Sending question to Java expert");

        let sessionError: string | undefined;
        const waitForIdle = new Promise<void>((resolve, reject) => {
          const unsubscribe = session.on((event) => {
            if (event.type === "assistant.usage") {
              const modelUsage = usageSummary.models[event.data.model] ?? {
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0
              };

              modelUsage.requests += 1;
              modelUsage.inputTokens += event.data.inputTokens ?? 0;
              modelUsage.outputTokens += event.data.outputTokens ?? 0;
              modelUsage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
              modelUsage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
              usageSummary.models[event.data.model] = modelUsage;
              return;
            }

            if (event.type === "assistant.reasoning_delta") {
              const thought = event.data.deltaContent.replace(/\s+/g, " ").trim();
              if (!thought) {
                return;
              }

              thoughtCount += 1;
              const progress = Math.min(88, 55 + thoughtCount);
              const thoughtPreview = thought.slice(0, 140);
              void sendProgressNotification(extra, progress, 100, `Step ${thoughtCount}: ${thoughtPreview}`).catch(() => undefined);
              return;
            }

            if (event.type === "assistant.message_delta") {
              answer += event.data.deltaContent;
              if (streamResponse) {
                void sendAnswerDelta(extra, event.data.deltaContent).catch(() => undefined);
              }
              return;
            }

            if (event.type === "assistant.message") {
              answer = event.data.content ?? answer;
              return;
            }

            if (event.type === "session.shutdown") {
              shutdownUsageSummary = toSessionUsageSummary(event.data);
              return;
            }

            if (event.type === "session.error") {
              sessionError = event.data.message;
              unsubscribe();
              reject(new Error(sessionError));
              return;
            }

            if (event.type === "session.idle") {
              unsubscribe();
              resolve();
            }
          });
        });

        await session.send({ prompt: question });
        await waitForIdle;

        if (sessionError) {
          throw new Error(sessionError);
        }

        await sendProgressNotification(extra, 95, 100, "Cleaning up session");
        await session.disconnect();

        usageSummary = shutdownUsageSummary ?? usageSummary;
        if (hasUsageSummary(usageSummary)) {
          await recordDailyUsage(usageSummary);
        }
      } catch (err) {
        answer = `Error fetching answer from Copilot LLM: ${err}`;
      } finally {
        await client.stop().catch(() => undefined);
      }

      await sendProgressNotification(extra, 100, 100, "Response ready");

      return {
        content: [{ type: "text", text: answer }]
      };
    }
  );
}