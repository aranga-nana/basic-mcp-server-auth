// Centralized UI state controller for status text and button/login visibility.
// This keeps low-level DOM toggles out of the app orchestration file.
export function createUiState(options) {
  const {
    statusLabel,
    cancelButton,
    sendButton,
    oauthLoginContainer,
    hasPendingRequest
  } = options;

  function setStatus(text) {
    statusLabel.textContent = text;
  }

  function setComposerBusy(isBusy) {
    cancelButton.disabled = !isBusy;
    sendButton.disabled = isBusy;
  }

  function setAuthUiState(accessToken) {
    const isSignedIn = Boolean(accessToken);
    if (oauthLoginContainer) {
      oauthLoginContainer.style.display = isSignedIn ? "none" : "";
    }

    // Send is enabled only after auth and when no request is in progress.
    if (!hasPendingRequest()) {
      sendButton.disabled = !isSignedIn;
    }
  }

  return {
    setStatus,
    setComposerBusy,
    setAuthUiState
  };
}
