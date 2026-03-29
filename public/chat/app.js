import {
  chatApiBase,
  oauthCallbackPath,
  sessionTokenKey,
  conversationMemoryKey,
  maxRecentTurns,
  maxContextChars
} from "./features/config.js";
import { createDevLogger } from "./features/logger.js";
import { renderMarkdown } from "./features/markdown-renderer.js";
import { createMessageView } from "./features/message-view.js";
import { createUiState } from "./features/ui-state.js";
import { createConversationMemoryStore } from "./features/conversation-memory.js";
import { createChatClient } from "./features/chat-client.js";
import { createAuthManager } from "./features/auth-flow.js";

// DOM references are collected once during startup so event handlers can stay lean.
const oauthLoginButton = document.querySelector("#oauth-login");
const promptInput = document.querySelector("#prompt-input");
const form = document.querySelector("#chat-form");
const messages = document.querySelector("#messages");
const statusLabel = document.querySelector("#connection-status");
const clearButton = document.querySelector("#clear-chat");
const cancelButton = document.querySelector("#cancel-button");
const sendButton = document.querySelector("#send-button");
const promptButtons = document.querySelectorAll("[data-prompt]");
const devLog = document.querySelector("#dev-log");
const clearDevConsoleButton = document.querySelector("#clear-dev-console");
const oauthLoginContainer = document.querySelector("#oauth-login-container");

const logger = createDevLogger(devLog);

const memoryStore = createConversationMemoryStore({
  storage: window.sessionStorage,
  storageKey: conversationMemoryKey,
  maxRecentTurns,
  maxContextChars
});

const chatClient = createChatClient({
  chatApiBase,
  logger
});

const uiState = createUiState({
  statusLabel,
  cancelButton,
  sendButton,
  oauthLoginContainer,
  hasPendingRequest: () => chatClient.hasPendingRequest()
});

const messageView = createMessageView({
  messagesElement: messages,
  renderMarkdown,
  setStatus: uiState.setStatus,
  logger
});

const auth = createAuthManager({
  chatApiBase,
  oauthCallbackPath,
  sessionTokenKey,
  logger,
  onTokenChanged: uiState.setAuthUiState
});

async function sendPromptWithRetry(prompt) {
  const token = auth.getAccessToken();
  messageView.addUserMessage(prompt);
  const assistantMessage = messageView.addAssistantMessage("");

  messageView.updateMessageStatus(assistantMessage, "Connecting...");
  uiState.setStatus("Running");

  try {
    return await chatClient.streamChat({
      prompt,
      githubToken: token,
      conversationContext: memoryStore.buildContext(),
      onEvent: messageView.createStreamEventHandler(assistantMessage)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/403|401|Invalid|Expired Token/i.test(message)) {
      auth.clearAccessToken();
      throw new Error("Session expired. Please sign in again.");
    }

    throw error;
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const prompt = promptInput.value.trim();
  logger.log("chat", "submit requested", {
    hasAccessToken: Boolean(auth.getAccessToken()),
    promptLength: prompt.length
  });

  // A page refresh should not force a new login when sessionStorage still has a token.
  auth.restoreTokenFromStorage();

  if (!auth.getAccessToken()) {
    uiState.setStatus("Sign in required");
    logger.log("chat", "submit blocked: missing token", {});
    return;
  }

  if (!prompt) {
    uiState.setStatus("Prompt required");
    promptInput.focus();
    return;
  }

  promptInput.value = "";
  uiState.setComposerBusy(true);

  try {
    memoryStore.addTurn("user", prompt);
    const assistantText = await sendPromptWithRetry(prompt);
    memoryStore.addTurn("assistant", assistantText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    memoryStore.addTurn("assistant", message);
    messageView.showAssistantError(message);
    uiState.setStatus("Error");
  } finally {
    chatClient.clearPendingRequest();
    uiState.setComposerBusy(false);
    uiState.setAuthUiState(auth.getAccessToken());
    messageView.scrollToBottom();
  }
}

function registerEventHandlers() {
  form.addEventListener("submit", handleSubmit);

  cancelButton.addEventListener("click", () => {
    chatClient.cancel();
    uiState.setStatus("Cancelled");
  });

  clearButton.addEventListener("click", () => {
    messageView.clear();
    memoryStore.clear();
    uiState.setStatus("Idle");
  });

  promptButtons.forEach((button) => {
    button.addEventListener("click", () => {
      promptInput.value = button.getAttribute("data-prompt") || "";
      promptInput.focus();
    });
  });

  if (clearDevConsoleButton && devLog) {
    clearDevConsoleButton.addEventListener("click", () => {
      devLog.textContent = "";
    });
  }

  window.addEventListener("error", (event) => {
    logger.log("browser", "uncaught error", { message: event.message });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logger.log("browser", "unhandled rejection", {
      reason: String(event.reason)
    });
  });

  if (oauthLoginButton) {
    oauthLoginButton.addEventListener("click", async () => {
      uiState.setStatus("Discovering OAuth config...");
      oauthLoginButton.disabled = true;

      try {
        const config = await auth.discoverOAuthConfig();
        uiState.setStatus("Opening GitHub login...");
        await auth.startOAuthPopupFlow(config);
        uiState.setStatus("Signed in");
        logger.log("oauth", "signin successful", { tokenReceived: true });
      } catch (error) {
        uiState.setStatus(error instanceof Error ? error.message : "Login failed");
        logger.log("oauth", "signin failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        oauthLoginButton.disabled = false;
      }
    });
  }
}

function initializeApp() {
  uiState.setStatus("Idle");
  logger.log("app", "chat app initialized", {
    apiBase: chatApiBase,
    callbackPath: oauthCallbackPath
  });

  const loadedMemory = memoryStore.load();
  logger.log("memory", "conversation memory initialized", {
    summaryChars: loadedMemory.summary.length,
    turns: loadedMemory.turns.length
  });

  auth.restoreTokenFromStorage();
  uiState.setAuthUiState(auth.getAccessToken());
  if (auth.getAccessToken()) {
    uiState.setStatus("Signed in");
  } else {
    uiState.setStatus("Idle");
    logger.log("auth", "no token in session", { hasAccessToken: false });
  }

  registerEventHandlers();
}

initializeApp();
