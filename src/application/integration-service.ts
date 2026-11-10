import {
  discoverIntegrationProfiles,
  inspectIntegration,
  installIntegration,
} from "../agent-plugin";
import type { OperationRequest } from "../types";
import { requiredString } from "./request";
export class IntegrationApplicationService {
  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
    switch (request.op) {
      case "agent-integration.profiles":
        return discoverIntegrationProfiles();

      case "agent-integration.inspect":

      case "agent-integration.install": {
        const provider = requiredString(request, "provider");
        if (
          provider !== "codex" &&
          provider !== "kimi" &&
          provider !== "claude"
        )
          throw new Error("Unsupported integration provider");
        const options: import("../agent-plugin").IntegrationOptions = {
          provider,
          profilePath: requiredString(request, "profilePath"),
        };
        return request.op === "agent-integration.inspect"
          ? inspectIntegration(options)
          : installIntegration({
              ...options,
              expectedPreviewHash: requiredString(
                request,
                "expectedPreviewHash",
              ),
            });
      }

      default:
        throw new Error("Unknown integration operation");
    }
  }
}
