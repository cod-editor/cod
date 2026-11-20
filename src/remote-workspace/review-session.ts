import type { Socket } from "node:net";
import {
  canUsePairedDesktop,
  maximumWorkspaceFrameBytes,
  type WorkspaceHostFrame,
} from "./protocol";
import {
  readWorkspaceSigners,
  verifyWorkspaceReview,
  workspaceReviewChallenge,
  workspaceSignersDigest,
} from "./review-signature";
import type { OperationRequest } from "../types";

const maximumProofFrameBytes = 32 * 1024;

export function serveWorkspaceReview(
  connection: Socket,
  profile: string,
  send: (frame: WorkspaceHostFrame) => void,
  dispatch: (request: OperationRequest) => Promise<unknown>,
): void {
  const challenge = workspaceReviewChallenge();
  const expires = Date.now() + 15_000;
  let challenged = true;
  let proof: string | undefined;
  let input: string[] = [];
  let bytes = 0;
  // Keep one request active on this review connection. A lost submission can
  // always be reconciled by asking the original round for its saved identity.
  let busy = false;
  const receive = async (line: string) => {
    const message = JSON.parse(line);
    if (message?.type === "review-proof") {
      if (!challenged) throw new Error("The review challenge was already used");
      challenged = false;
      try {
        if (Date.now() > expires || typeof message.signature !== "string")
          throw new Error("The review challenge expired");
        const signers = await readWorkspaceSigners(profile);
        await verifyWorkspaceReview(signers, challenge, message.signature);
        proof = workspaceSignersDigest(signers);
      } catch {
        proof = undefined;
      }
      send({ type: "review-access", value: !!proof });
      return;
    }
    if (message?.type !== "review-command" || !Number.isSafeInteger(message.id))
      throw new Error("Invalid remote review operation");
    const id = message.id as number;
    try {
      const request = message.request as OperationRequest;
      if (!proof || !canUsePairedDesktop(request))
        throw new Error("Pair this desktop to use remote review and approvals");
      const signers = await readWorkspaceSigners(profile).catch(
        () => undefined,
      );
      if (!signers || workspaceSignersDigest(signers) !== proof) {
        proof = undefined;
        send({ type: "review-access", value: false });
        throw new Error(
          "Review access was revoked. Reconnect with a paired key.",
        );
      }
      const result = await dispatch(request);
      send({ type: "review-reply", id, result });
    } catch (error) {
      send({
        type: "review-reply",
        id,
        error: error instanceof Error ? error.message : "Remote review failed",
      });
    }
  };
  connection.on("data", (chunk: string) => {
    const newline = chunk.indexOf("\n");
    const part = newline < 0 ? chunk : chunk.slice(0, newline);
    input.push(part);
    bytes += Buffer.byteLength(part);
    if (bytes > (proof ? maximumWorkspaceFrameBytes : maximumProofFrameBytes)) {
      connection.destroy();
      return;
    }
    if (newline < 0) return;
    if (busy || newline !== chunk.length - 1) {
      connection.destroy();
      return;
    }
    const line = input.join("");
    input = [];
    bytes = 0;
    busy = true;
    void receive(line)
      .catch(() => connection.destroy())
      .finally(() => (busy = false));
  });
  send({ type: "review-challenge", value: challenge });
}
