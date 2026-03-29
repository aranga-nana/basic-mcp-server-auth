import { Request } from "express";

const defaultPort = 3000;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function parsePort(value: string | undefined) {
  if (!value) {
    return defaultPort;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultPort;
}

export const port = parsePort(process.env.PORT);

export function getPublicBaseUrl(req?: Request) {
  if (process.env.PUBLIC_BASE_URL) {
    return trimTrailingSlash(process.env.PUBLIC_BASE_URL);
  }

  if (req) {
    return `${req.protocol}://${req.get("host")}`;
  }

  return `http://localhost:${port}`;
}

export function getMcpEndpointUrl(req?: Request) {
  return `${getPublicBaseUrl(req)}/mcp`;
}

export function getOAuthProtectedResourceUrl(req?: Request) {
  return `${getPublicBaseUrl(req)}/.well-known/oauth-protected-resource`;
}