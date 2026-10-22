const bytes = new TextEncoder();

/** HMAC-SHA-256 as hex. Used for anonymous ids and rate-limit keys, so the raw values are never stored. */
export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", bytes.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, bytes.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
