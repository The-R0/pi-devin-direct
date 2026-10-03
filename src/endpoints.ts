export const DEFAULT_API_SERVER = "https://server.codeium.com";
export const SIGN_IN_URL = "https://windsurf.com/windsurf/signin";
export const REGISTER_USER_URL = "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser";
export const OAUTH_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";

/** Tenant routes include a path prefix; preserve it when validating the destination. */
export function validateApiServer(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid Devin API server URL."); }
  const allowed = ["server.codeium.com", "server-staging.codeium.com", "server-beta.codeium.com", "windsurf.com", "windsurf.fedstart.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !(allowed.includes(url.hostname) || url.hostname.endsWith(".windsurf.com"))) {
    throw new Error("Devin API server must be an HTTPS Cognition/Windsurf endpoint.");
  }
  return url.toString().replace(/\/+$/, "");
}
