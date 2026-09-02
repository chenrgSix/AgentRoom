import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

function createValidator() {
  const validator = new Ajv2020({
    allErrors: true,
    strict: true
  });

  addFormats(validator);
  return validator;
}

async function readJson(filePath) {
  let source;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`, {
      cause: error
    });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, {
      cause: error
    });
  }
}

async function collectSchemaFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectSchemaFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export function validateSchemaDocument(schema, source = "schema") {
  const validator = createValidator();

  try {
    validator.addSchema(schema);
  } catch (error) {
    throw new Error(`Invalid JSON Schema in ${source}: ${error.message}`, {
      cause: error
    });
  }
}

async function loadContractPackage(packageRoot) {
  const schemasRoot = path.join(packageRoot, "schemas");
  const schemaFiles = await collectSchemaFiles(schemasRoot);

  if (schemaFiles.length === 0) {
    throw new Error("The contract package must contain at least one schema");
  }

  const validator = createValidator();
  const schemas = [];

  for (const schemaFile of schemaFiles) {
    const schema = await readJson(schemaFile);

    try {
      validator.addSchema(schema);
    } catch (error) {
      throw new Error(`Invalid JSON Schema in ${schemaFile}: ${error.message}`, {
        cause: error
      });
    }

    schemas.push({
      id: schema.$id,
      path: path.relative(packageRoot, schemaFile).split(path.sep).join("/")
    });
  }

  for (const schema of schemas) {
    try {
      validator.getSchema(schema.id);
    } catch (error) {
      throw new Error(`Cannot compile JSON Schema ${schema.id}: ${error.message}`, {
        cause: error
      });
    }
  }

  const catalog = await readJson(path.join(packageRoot, "catalog.json"));
  const catalogSchemaId = "https://agentroom.dev/schemas/catalog.schema.json";
  const validateCatalog = validator.getSchema(catalogSchemaId);

  if (!validateCatalog) {
    throw new Error(`Catalog schema is not registered: ${catalogSchemaId}`);
  }

  if (!validateCatalog(catalog)) {
    throw new Error(
      `Invalid contract catalog: ${validator.errorsText(validateCatalog.errors)}`
    );
  }

  const expected = schemas
    .map(({ id, path: schemaPath }) => `${id}|${schemaPath}`)
    .sort();
  const actual = catalog.schemas
    .map(({ id, path: schemaPath }) => `${id}|${schemaPath}`)
    .sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "catalog.json must list every schema exactly once with its matching $id"
    );
  }

  return {
    catalog,
    schemas,
    validator
  };
}

export async function validateContractPackage(packageRoot) {
  const { catalog, schemas } = await loadContractPackage(packageRoot);

  return {
    catalogVersion: catalog.catalogVersion,
    schemaCount: schemas.length
  };
}

export async function validateContractFixtures(packageRoot) {
  const { validator } = await loadContractPackage(packageRoot);
  const fixturePaths = [
    "cases.json",
    "execution-plan-cases.json",
    "execution-runtime-cases.json",
    "evidence-adoption-cases.json"
  ].map((name) =>
    path.join(packageRoot, "fixtures", name)
  );
  const suites = await Promise.all(fixturePaths.map(readJson));
  for (const [index, suite] of suites.entries()) {
    if (suite?.fixtureVersion !== "1.0" || !Array.isArray(suite.cases)) {
      throw new Error(`${fixturePaths[index]} must contain fixtureVersion 1.0 and cases`);
    }
  }
  const fixturePath = fixturePaths.join(", ");
  const fixtureSuite = {
    fixtureVersion: "1.0",
    cases: suites.flatMap((suite) => suite.cases)
  };

  if (
    typeof fixtureSuite.fixtureVersion !== "string" ||
    !Array.isArray(fixtureSuite.cases)
  ) {
    throw new Error(`${fixturePath} must contain fixtureVersion and cases`);
  }

  const names = new Set();
  let validCount = 0;
  let invalidCount = 0;

  for (const fixture of fixtureSuite.cases) {
    if (
      typeof fixture?.name !== "string" ||
      typeof fixture.schemaId !== "string" ||
      typeof fixture.valid !== "boolean" ||
      !("instance" in fixture)
    ) {
      throw new Error(`Malformed fixture entry in ${fixturePath}`);
    }

    if (names.has(fixture.name)) {
      throw new Error(`Duplicate fixture name: ${fixture.name}`);
    }
    names.add(fixture.name);

    const validate = validator.getSchema(fixture.schemaId);
    if (!validate) {
      throw new Error(
        `Fixture ${fixture.name} references unknown schema ${fixture.schemaId}`
      );
    }

    const roundTripped = JSON.parse(JSON.stringify(fixture.instance));
    const actual = validate(roundTripped);
    if (actual !== fixture.valid) {
      const errors = actual
        ? "expected rejection but validation passed"
        : validator.errorsText(validate.errors);
      throw new Error(`Fixture ${fixture.name} disagrees: ${errors}`);
    }

    if (fixture.valid) {
      validCount += 1;
    } else {
      invalidCount += 1;
    }
  }

  return {
    fixtureCount: fixtureSuite.cases.length,
    fixtureVersion: fixtureSuite.fixtureVersion,
    invalidCount,
    validCount
  };
}
