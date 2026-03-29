// Message view encapsulates all DOM concerns for chat message rendering.
// Keeping this separate makes app.js focused on orchestration and state flow.
export function createMessageView({ messagesElement, renderMarkdown, setStatus, logger }) {
  function scrollToBottom() {
    messagesElement.scrollTop = messagesElement.scrollHeight;
  }

  function createMessage(role, initialText) {
    const wrapper = document.createElement("article");
    wrapper.className = `message ${role}`;

    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = role === "user" ? "You" : "Java expert";

    const content = document.createElement("div");
    content.className = "message-content";
    if (role === "assistant") {
      content.dataset.rawText = initialText;
      content.innerHTML = renderMarkdown(initialText);
    } else {
      content.textContent = initialText;
    }

    const status = document.createElement("div");
    status.className = "message-status";

    wrapper.append(meta, content, status);
    messagesElement.append(wrapper);
    scrollToBottom();

    return { wrapper, content, status };
  }

  function updateMessageStatus(message, text) {
    message.status.textContent = text;
  }

  function appendAssistantText(message, text) {
    const current = message.content.dataset.rawText || "";
    const next = `${current}${text}`;
    message.content.dataset.rawText = next;
    message.content.innerHTML = renderMarkdown(next);
    scrollToBottom();
  }

  function replaceAssistantText(message, text) {
    message.content.dataset.rawText = text;
    message.content.innerHTML = renderMarkdown(text);
    scrollToBottom();
  }

  // Converts stream protocol events into concrete UI mutations.
  function createStreamEventHandler(assistantMessage) {
    return (payload) => {
      if (payload.event === "status") {
        updateMessageStatus(assistantMessage, payload.data.message || "Working...");
        setStatus(payload.data.message || "Working");
        return;
      }

      if (payload.event === "progress") {
        updateMessageStatus(assistantMessage, payload.data.message || `Progress ${payload.data.progress}%`);
        setStatus(payload.data.message || "Working");
        return;
      }

      if (payload.event === "delta") {
        appendAssistantText(assistantMessage, payload.data.delta || "");
        updateMessageStatus(assistantMessage, "Streaming response...");
        return;
      }

      if (payload.event === "replace") {
        replaceAssistantText(assistantMessage, payload.data.text || "");
        return;
      }

      if (payload.event === "done") {
        if (!(assistantMessage.content.dataset.rawText || "") && payload.data.text) {
          replaceAssistantText(assistantMessage, payload.data.text);
        }
        updateMessageStatus(assistantMessage, "Complete");
        setStatus("Idle");
        return;
      }

      if (payload.event === "error") {
        updateMessageStatus(assistantMessage, payload.data.message || "Request failed.");
        setStatus("Error");
        logger.log("chat", "server reported stream error", payload.data);
      }
    };
  }

  function addUserMessage(prompt) {
    return createMessage("user", prompt);
  }

  function addAssistantMessage(initialText = "") {
    return createMessage("assistant", initialText);
  }

  function showAssistantError(errorMessage) {
    const assistantMessage = addAssistantMessage("");
    updateMessageStatus(assistantMessage, errorMessage);
    return assistantMessage;
  }

  function clear() {
    messagesElement.innerHTML = "";
  }

  return {
    scrollToBottom,
    createStreamEventHandler,
    addUserMessage,
    addAssistantMessage,
    showAssistantError,
    updateMessageStatus,
    clear
  };
}