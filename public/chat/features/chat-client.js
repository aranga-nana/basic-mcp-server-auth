function parseSseEvent(block) {
  const lines = block.split("\n");
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return {
    event,
    data: JSON.parse(dataLines.join("\n"))
  };
}

async function parseErrorFromResponse(response, fallback) {
  return await response
    .json()
    .then((payload) => payload.error || fallback)
    .catch(() => fallback);
}

// Streaming chat client that wraps the SSE protocol consumed by this page.
export function createChatClient({ chatApiBase, logger }) {
  let currentController;

  async function streamChat({ prompt, githubToken, conversationContext, onEvent }) {
    currentController = new AbortController();

    const response = await fetch(`${chatApiBase}/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        githubToken,
        conversationContext
      }),
      signal: currentController.signal
    });

    if (!response.ok || !response.body) {
      const error = await parseErrorFromResponse(response, `Request failed with ${response.status}`);
      logger.log("chat", "chat stream request failed", { status: response.status, error });
      throw new Error(error);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalAssistantText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const payload = parseSseEvent(part);
        if (!payload) {
          continue;
        }

        onEvent(payload);

        if (payload.event === "delta") {
          finalAssistantText += payload.data.delta || "";
        }

        if (payload.event === "replace") {
          finalAssistantText = payload.data.text || "";
        }

        if (payload.event === "done" && !finalAssistantText && payload.data.text) {
          finalAssistantText = payload.data.text;
        }
      }
    }

    return finalAssistantText;
  }

  function cancel() {
    currentController?.abort();
  }

  function hasPendingRequest() {
    return Boolean(currentController);
  }

  function clearPendingRequest() {
    currentController = undefined;
  }

  return {
    streamChat,
    cancel,
    hasPendingRequest,
    clearPendingRequest
  };
}
