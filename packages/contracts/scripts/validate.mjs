import { fileURLToPath } from "node:url";

import { validateContractPackage } from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const result = await validateContractPackage(packageRoot);

console.log(
  `Validated ${result.schemaCount} schema(s) from catalog ${result.catalogVersion}`
);
