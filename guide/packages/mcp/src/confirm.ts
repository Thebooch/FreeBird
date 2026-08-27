import { createHash, randomBytes } from "node:crypto";

export interface ConfirmationPayload {
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  sessionId: string;
  authFingerprint: string;
  expiresAt: number;
}

export class ConfirmationTokenStore {
  private readonly tokens = new Map<string, ConfirmationPayload>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  issue(input: Omit<ConfirmationPayload, "expiresAt">): string {
    this.prune();
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, {
      ...input,
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  consume(
    token: string,
    expected: {
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      sessionId: string;
      authFingerprint: string;
    },
  ): { ok: true } | { ok: false; reason: string } {
    this.prune();
    const payload = this.tokens.get(token);
    if (!payload) {
      return { ok: false, reason: "invalid or expired confirmation token" };
    }
    this.tokens.delete(token);

    if (payload.expiresAt < Date.now()) {
      return { ok: false, reason: "confirmation token expired" };
    }
    if (payload.componentId !== expected.componentId) {
      return { ok: false, reason: "confirmation token does not match componentId" };
    }
    if (payload.actionId !== expected.actionId) {
      return { ok: false, reason: "confirmation token does not match actionId" };
    }
    if (payload.sessionId !== expected.sessionId) {
      return { ok: false, reason: "confirmation token does not match sessionId" };
    }
    if (payload.authFingerprint !== expected.authFingerprint) {
      return { ok: false, reason: "confirmation token does not match auth context" };
    }
    if (!argsEqual(payload.args, expected.args)) {
      return { ok: false, reason: "confirmation token does not match args" };
    }
    return { ok: true };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, payload] of this.tokens) {
      if (payload.expiresAt < now) this.tokens.delete(token);
    }
  }
}

export const authFingerprint = (auth: unknown): string => {
  return createHash("sha256")
    .update(JSON.stringify(auth ?? null))
    .digest("hex");
};

const argsEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => {
  return JSON.stringify(a) === JSON.stringify(b);
};
