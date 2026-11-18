import { createHash, randomBytes } from "node:crypto";

/** High-entropy bearer secrets need hashing, not password stretching. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}
