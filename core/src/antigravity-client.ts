// The OAuth client identifiers of Google Antigravity's desktop app, as published in opencodex
// (src/oauth/google-antigravity.ts, MIT), commit 5841269073b3898e5dd3ac9dcd956c7e56c1bb34.
// Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
//
// TEMPORARY, BY THE OWNER'S DECISION (BACKLOG B56): these two values are written here so that the sign-in
// works at all; the plan is to read them at run time from where the user's own machine has them.
// They are the only secret-looking strings the repository may hold, they live in this one file, and they
// must be removed before any public release: the release check reports them on purpose and nothing
// whitelists them (see PROVENANCE.md).

export const ANTIGRAVITY_CLIENT_ID = process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_ID
  || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_SECRET
  || "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";

/** The endpoints; tests point these at a fake Google. */
export const antigravityEndpoints = () => ({
  auth: process.env.EASYSWITCH_ANTIGRAVITY_AUTH ?? "https://accounts.google.com/o/oauth2/v2/auth",
  token: process.env.EASYSWITCH_ANTIGRAVITY_TOKEN ?? "https://oauth2.googleapis.com/token",
  userinfo: process.env.EASYSWITCH_ANTIGRAVITY_USERINFO ?? "https://www.googleapis.com/oauth2/v2/userinfo",
  api: (process.env.EASYSWITCH_ANTIGRAVITY_API ?? "https://cloudcode-pa.googleapis.com").replace(/\/+$/, ""),
  onboardApi: (process.env.EASYSWITCH_ANTIGRAVITY_API ?? "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, ""),
});

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** The port Google's client allows for the loopback redirect (a free one is used when it is taken). */
export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_API_VERSION = "v1internal";

const IDE_VERSION = "2.5.5";

/**
 * The backend answers requests by the client family in the User-Agent: the IDE family is the one that is let
 * through to the newer agent models. The platform tokens are this machine's own.
 */
export function antigravityUserAgent(): string {
  const override = process.env.EASYSWITCH_ANTIGRAVITY_USER_AGENT?.trim();
  if (override) return override;
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `antigravity/ide/${IDE_VERSION} (os_type=${os}; arch=${arch}; aidev_client; auth_method=oauth)`;
}
