import path from "node:path";
import { fileURLToPath } from "node:url";
export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
export const fixtureDirectory = path.resolve(
  process.env.COD_TEST_VAULT_DIRECTORY ||
    path.join(repositoryRoot, "artifacts/bitwarden-fixture"),
);
export const fixturePath = (...parts) => path.join(fixtureDirectory, ...parts);
