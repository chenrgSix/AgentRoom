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

export async function validateContractPackage(packageRoot) {
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
    catalogVersion: catalog.catalogVersion,
    schemaCount: schemas.length
  };
}
