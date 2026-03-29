const storageKey = "enterprise-mcp-chat-token";
const chatApiBase = "/chat/api";

const tokenInput = document.querySelector("#token-input");
const promptInput = document.querySelector("#prompt-input");
const form = document.querySelector("#chat-form");
const messages = document.querySelector("#messages");
const statusLabel = document.querySelector("#connection-status");
const clearButton = document.querySelector("#clear-chat");
const cancelButton = document.querySelector("#cancel-button");
const sendButton = document.querySelector("#send-button");
const promptButtons = document.querySelectorAll("[data-prompt]");

let currentController;

function setStatus(text) {
  statusLabel.textContent = text;
}

function restoreToken() {
  const saved = window.localStorage.getItem(storageKey);
  if (saved) {
    tokenInput.value = saved;
  }
}

function persistToken() {
  const token = tokenInput.value.trim();
  if (!token) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  window.localStorage.setItem(storageKey, token);
}

function createMessage(role, initialText) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;

  const meta = document.createElement("span");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "You" : "Java expert";

  const content = document.createElement("div");
  content.textContent = initialText;

  const status = document.createElement("div");
  status.className = "message-status";

  wrapper.append(meta, content, status);
  messages.append(wrapper);
  messages.scrollTop = messages.scrollHeight;

  return { wrapper, content, status };
}

function updateMessageStatus(message, text) {
  message.status.textContent = text;
}

function appendAssistantDelta(message, delta) {
  message.content.textContent += delta;
  messages.scrollTop = messages.scrollHeight;
}

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

async function streamChat(prompt, githubToken) {
  currentController = new AbortController();
  cancelButton.disabled = false;
  sendButton.disabled = true;

  createMessage("user", prompt);
  const assistantMessage = createMessage("assistant", "");
  updateMessageStatus(assistantMessage, "Connecting...");
  setStatus("Running");

  const response = await fetch(`${chatApiBase}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt, githubToken }),
    signal: currentController.signal
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      if (payload.event === "status") {
        updateMessageStatus(assistantMessage, payload.data.message || "Working...");
        setStatus(payload.data.message || "Working");
        continue;
      }

      if (payload.event === "progress") {
        updateMessageStatus(assistantMessage, payload.data.message || `Progress ${payload.data.progress}%`);
        setStatus(payload.data.message || "Working");
        continue;
      }

      if (payload.event === "delta") {
        appendAssistantDelta(assistantMessage, payload.data.delta || "");
        updateMessageStatus(assistantMessage, "Streaming response...");
        continue;
      }

      if (payload.event === "replace") {
        assistantMessage.content.textContent = payload.data.text || "";
        continue;
      }

      if (payload.event === "done") {
        if (!assistantMessage.content.textContent && payload.data.text) {
          assistantMessage.content.textContent = payload.data.text;
        }
        updateMessageStatus(assistantMessage, "Complete");
        setStatus("Idle");
        continue;
      }

      if (payload.event === "error") {
        updateMessageStatus(assistantMessage, payload.data.message || "Request failed.");
        setStatus("Error");
      }
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = promptInput.value.trim();
  const githubToken = tokenInput.value.trim();

  if (!githubToken) {
    setStatus("GitHub token required");
    tokenInput.focus();
    return;
  }

  if (!prompt) {
    setStatus("Prompt required");
    promptInput.focus();
    return;
  }

  persistToken();
  promptInput.value = "";

  try {
    await streamChat(prompt, githubToken);
  } catch (error) {
    const assistantMessage = createMessage("assistant", "");
    updateMessageStatus(assistantMessage, error instanceof Error ? error.message : String(error));
    setStatus("Error");
  } finally {
    currentController = undefined;
    cancelButton.disabled = true;
    sendButton.disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
});

cancelButton.addEventListener("click", () => {
  currentController?.abort();
  setStatus("Cancelled");
});

clearButton.addEventListener("click", () => {
  messages.innerHTML = "";
  setStatus("Idle");
});

promptButtons.forEach((button) => {
  button.addEventListener("click", () => {
    promptInput.value = button.getAttribute("data-prompt") || "";
    promptInput.focus();
  });
});

tokenInput.addEventListener("change", persistToken);

restoreToken();
setStatus("Idle");