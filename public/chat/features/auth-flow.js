function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  window.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes) {
  const base64 = window.btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function buildPkceChallenge(codeVerifier) {
  const verifierBytes = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", verifierBytes);
  return toBase64Url(new Uint8Array(digest));
}

async function buildPkcePair() {
  // Use oauth4webapi if available to reduce custom cryptography logic.
  if (window.oauth4webapi?.generateRandomCodeVerifier && window.oauth4webapi?.calculatePKCECodeChallenge) {
    const codeVerifier = window.oauth4webapi.generateRandomCodeVerifier();
    const codeChallenge = await window.oauth4webapi.calculatePKCECodeChallenge(codeVerifier);
    return { codeVerifier, codeChallenge };
  }

  const codeVerifier = randomHex(64);
  const codeChallenge = await buildPkceChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

function randomState() {
  if (window.oauth4webapi?.generateRandomState) {
    return window.oauth4webapi.generateRandomState();
  }

  return randomHex(16);
}

export function createAuthManager(options) {
  const {
    chatApiBase,
    oauthCallbackPath,
    sessionTokenKey,
    logger,
    onTokenChanged
  } = options;

  let accessToken = null;
  window.__mcpAccessToken = null;

  function readTokenFromSession() {
    try {
      return window.sessionStorage.getItem(sessionTokenKey) || "";
    } catch {
      return "";
    }
  }

  function writeTokenToSession(token) {
    try {
      if (token) {
        window.sessionStorage.setItem(sessionTokenKey, token);
        return;
      }

      window.sessionStorage.removeItem(sessionTokenKey);
    } catch {
      // Ignore storage errors; in-memory token still works.
    }
  }

  function setAccessToken(token) {
    accessToken = token;
    window.__mcpAccessToken = token;
    writeTokenToSession(token);
    logger.log("auth", "token set", { hasAccessToken: Boolean(accessToken) });
    onTokenChanged(accessToken);
  }

  function clearAccessToken() {
    accessToken = null;
    window.__mcpAccessToken = null;
    writeTokenToSession("");
    logger.log("auth", "token cleared", { hasAccessToken: false });
    onTokenChanged(accessToken);
  }

  function getAccessToken() {
    return accessToken;
  }

  function restoreTokenFromStorage() {
    if (accessToken) {
      return accessToken;
    }

    const restored = readTokenFromSession();
    if (restored) {
      setAccessToken(restored);
      logger.log("auth", "restored token from session", { hasAccessToken: true });
    }

    return accessToken;
  }

  async function discoverOAuthConfig() {
    const res = await fetch("/.well-known/oauth-protected-resource");
    if (!res.ok) {
      throw new Error("Failed to discover OAuth config");
    }

    const config = await res.json();
    logger.log("oauth", "discovered oauth config", {
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
      clientIdPresent: Boolean(config.client_id),
      scopes: config.scopes_supported
    });
    return config;
  }

  async function exchangeCodeForToken(code, codeVerifier, redirectUri) {
    logger.log("oauth", "exchanging authorization code", {
      redirectUri,
      codeLength: code.length,
      verifierLength: codeVerifier.length
    });

    const response = await fetch(`${chatApiBase}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ code, codeVerifier, redirectUri })
    });

    const payload = await response.json().catch(() => ({}));
    logger.log("oauth", "token endpoint response", { status: response.status, payload });

    if (!response.ok || !payload.accessToken) {
      const hint = typeof payload.hint === "string" ? payload.hint : "";
      const message = payload.error || "Token exchange failed";
      throw new Error(hint ? `${message} (${hint})` : message);
    }

    setAccessToken(payload.accessToken);
    logger.log("auth", "token persisted from exchange", { hasAccessToken: true });
    return payload.accessToken;
  }

  async function startOAuthPopupFlow(config) {
    const state = randomState();
    const { codeVerifier, codeChallenge } = await buildPkcePair();
    const redirectUri = `${window.location.origin}${oauthCallbackPath}`;

    const scopes = Array.isArray(config.scopes_supported) ? config.scopes_supported : ["read:user"];
    const params = new URLSearchParams({
      client_id: config.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    if (config.resource) {
      params.set("resource", config.resource);
    }

    logger.log("oauth", "opening authorization popup", {
      authorizationEndpoint: config.authorization_endpoint,
      redirectUri,
      scope: scopes,
      hasResource: Boolean(config.resource),
      usingOauthLibrary: Boolean(window.oauth4webapi)
    });

    const popup = window.open(
      `${config.authorization_endpoint}?${params.toString()}`,
      "oauth2-login",
      "width=500,height=700"
    );

    if (!popup) {
      throw new Error("Popup blocked");
    }

    return await new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        window.clearInterval(closeWatcher);
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const succeed = (token) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(token);
      };

      const onMessage = async (event) => {
        if (event.origin !== window.location.origin || event.source !== popup) {
          return;
        }

        const data = event.data;
        if (!data || data.type !== "oauth_callback") {
          return;
        }

        logger.log("oauth", "received popup callback", {
          hasCode: Boolean(data.code),
          state: data.state,
          error: data.error,
          error_description: data.error_description
        });

        if (data.state !== state) {
          fail(new Error("OAuth state mismatch"));
          return;
        }

        if (data.error) {
          fail(new Error(data.error_description || data.error));
          return;
        }

        const code = typeof data.code === "string" ? data.code : "";
        if (!code) {
          fail(new Error("Authorization code not found"));
          return;
        }

        try {
          const token = await exchangeCodeForToken(code, codeVerifier, redirectUri);
          popup.close();
          succeed(token);
        } catch (error) {
          logger.log("oauth", "token exchange failed", {
            message: error instanceof Error ? error.message : String(error)
          });
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const closeWatcher = window.setInterval(() => {
        if (popup.closed) {
          fail(new Error("Popup closed"));
        }
      }, 300);

      window.addEventListener("message", onMessage);
      window.setTimeout(() => {
        if (!settled) {
          fail(new Error("OAuth timed out"));
        }
      }, 180000);
    });
  }

  return {
    getAccessToken,
    setAccessToken,
    clearAccessToken,
    restoreTokenFromStorage,
    discoverOAuthConfig,
    startOAuthPopupFlow
  };
}
