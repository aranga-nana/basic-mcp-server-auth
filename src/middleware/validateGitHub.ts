import { NextFunction, Request, Response } from "express";

import { getOAuthProtectedResourceUrl } from "../serverConfig.js";

export async function validateGitHub(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    // This challenge header is what VS Code uses to trigger the login popup.
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${getOAuthProtectedResourceUrl(req)}"`
    );
    res.status(401).json({ error: "Authentication Required" });
    return;
  }

  const response = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    res.status(403).json({ error: "Invalid or Expired Token" });
    return;
  }

  const user = await response.json();
  res.locals.user = user;
  res.locals.githubToken = token;
  next();
}
