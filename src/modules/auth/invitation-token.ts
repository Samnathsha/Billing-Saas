import { createHash, randomBytes } from "node:crypto";

// The secret in an invitation link, and the only form in which it is
// stored: its SHA-256 hash (like a password reset token).
export const newInvitationToken = (): string => randomBytes(32).toString("base64url");

export const hashInvitationToken = (token: string): string => createHash("sha256").update(token).digest("hex");
