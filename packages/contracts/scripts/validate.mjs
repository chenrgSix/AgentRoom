import { fileURLToPath } from "node:url";

import {
  validateContractFixtures,
  validateContractPackage
} from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const result = await validateContractPackage(packageRoot);
const fixtures = await validateContractFixtures(packageRoot);

console.log(
  `Validated ${result.schemaCount} schema(s) and ` +
  `${fixtures.fixtureCount} fixture(s) from catalog ${result.catalogVersion}`
);
