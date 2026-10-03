import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDevinDesktopApiKey } from "./desktop-auth.js";
import { DEFAULT_API_SERVER, validateApiServer } from "./endpoints.js";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
  source: "environment" | "local-cli" | "local-desktop" | "browser" | "pi";
  path?: string;
}

export function credentialsPath(): string {
  return process.env.DEVIN_CREDENTIALS_PATH || join(homedir(), ".local/share/devin/credentials.toml");
}

/** Read only: importing a session never changes the Devin credential store. */
export function readCredentials(): DevinCredentials | null {
  const path = credentialsPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read Devin credentials. Check DEVIN_CREDENTIALS_PATH and file permissions.");
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!match) continue;
    try {
      values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1);
    } catch {
      throw new Error("Cannot parse Devin credentials. Sign in again or use DEVIN_AUTH_MODE=browser.");
    }
  }
  const apiKey = values.windsurf_api_key || values.api_key;
  if (!apiKey?.trim()) throw new Error("Devin credential file has no API key. Use DEVIN_AUTH_MODE=browser to sign in independently.");
  return { apiKey: apiKey.trim(), apiServerUrl: validateApiServer(values.api_server_url || DEFAULT_API_SERVER), source: "local-cli", path };
}

export async function readLocalCredentials(): Promise<DevinCredentials | null> {
  const cli = readCredentials();
  if (cli) return cli;
  const desktop = await readDevinDesktopApiKey();
  return desktop ? { apiKey: desktop.apiKey, apiServerUrl: validateApiServer(process.env.DEVIN_API_SERVER_URL || DEFAULT_API_SERVER), source: "local-desktop", path: desktop.source } : null;
}

export function readEnvironmentCredentials(): DevinCredentials | null {
  const apiKey = process.env.DEVIN_API_KEY?.trim();
  return apiKey ? {
    apiKey,
    apiServerUrl: validateApiServer(process.env.DEVIN_API_SERVER_URL || DEFAULT_API_SERVER),
    source: "environment",
  } : null;
}
