import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  FetchingJSONSchemaStore,
  InputData,
  JSONSchemaInput,
  quicktype
} from "quicktype-core";

const BRIDGE_SCHEMA_ID =
  "https://agentroom.dev/schemas/bridge/messages.schema.json";
const PAIRING_SCHEMA_ID =
  "https://agentroom.dev/schemas/bridge/pairing-session.schema.json";
const WORK_SCHEMA_ID =
  "https://agentroom.dev/schemas/work/task-result.schema.json";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function resolveJsonPointer(document, fragment) {
  if (fragment === "" || fragment === "#") {
    return document;
  }

  if (!fragment.startsWith("#/")) {
    throw new Error(`Unsupported JSON Schema fragment: ${fragment}`);
  }

  return fragment
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => {
      if (value === null || typeof value !== "object" || !(part in value)) {
        throw new Error(`Unresolved JSON Schema pointer: ${fragment}`);
      }
      return value[part];
    }, document);
}

function dereference(value, currentSchema, schemas, stack = []) {
  if (Array.isArray(value)) {
    return value.map((item) => dereference(item, currentSchema, schemas, stack));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (typeof value.$ref === "string") {
    const reference = new URL(value.$ref, currentSchema.$id);
    const schemaId = `${reference.origin}${reference.pathname}`;
    const targetSchema = schemas.get(schemaId);

    if (!targetSchema) {
      throw new Error(`Cannot resolve JSON Schema reference: ${value.$ref}`);
    }

    const referenceKey = `${schemaId}${reference.hash}`;
    if (stack.includes(referenceKey)) {
      throw new Error(`Recursive JSON Schema reference: ${referenceKey}`);
    }

    const target = resolveJsonPointer(targetSchema, reference.hash);
    const resolved = dereference(
      target,
      targetSchema,
      schemas,
      [...stack, referenceKey]
    );
    const siblings = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "$ref")
    );

    return {
      ...resolved,
      ...dereference(siblings, currentSchema, schemas, stack)
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      dereference(child, currentSchema, schemas, stack)
    ])
  );
}

async function loadSchemas(packageRoot) {
  const catalog = await readJson(path.join(packageRoot, "catalog.json"));
  const schemas = new Map();

  for (const entry of catalog.schemas) {
    const schema = await readJson(path.join(packageRoot, entry.path));
    schemas.set(entry.id, schema);
  }

  return schemas;
}

function pascalCase(value) {
  return value
    .split(/[._-]/u)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function createBridgeCodegenSchemas(bridgeSchema) {
  const [envelope, messageContract] = bridgeSchema.allOf ?? [];
  const conditions = messageContract?.allOf;

  if (!envelope || !Array.isArray(conditions) || conditions.length === 0) {
    throw new Error("Bridge schema must define its envelope and message conditions");
  }

  const messages = conditions.map((condition) => {
    const messageType = condition.if?.properties?.type?.const;
    const payload = condition.then?.properties?.payload;

    if (typeof messageType !== "string" || typeof payload?.$ref !== "string") {
      throw new Error("Each Bridge condition must bind a type to a payload schema");
    }

    const name = pascalCase(messageType);
    return {
      name: `${name}Message`,
      schema: {
      title: `${name}Message`,
      allOf: [
        envelope,
        {
          type: "object",
          required: ["type", "payload"],
          properties: {
            type: { const: messageType },
            payload: {
              ...payload,
              title: `${name}Payload`
            }
          }
        }
      ]
      }
    };
  });
  const enrollment = [
    ["BridgeJoinRequest", "bridgeJoinRequest"],
    ["BridgeJoinChallenge", "bridgeJoinChallenge"],
    ["BridgeJoinApprovalRequest", "bridgeJoinApprovalRequest"],
    ["BridgeJoinApproval", "bridgeJoinApproval"],
    ["BridgeJoinClaimRequest", "bridgeJoinClaimRequest"],
    ["BridgeJoinPending", "bridgeJoinPending"],
    ["BridgeJoinPaired", "bridgeJoinPaired"]
  ].map(([name, definition]) => ({
    name,
    schema: {
      title: name,
      $ref: `#/$defs/${definition}`
    }
  }));

  return { messages, types: [...messages, ...enrollment] };
}

function createDefinitionCodegenSchemas(schema, definitions) {
  return definitions.map(([name, definition]) => ({
    name,
    schema: {
      title: name,
      $ref: `#/$defs/${definition}`
    },
    sourceSchema: schema
  }));
}

async function render(sources, language, rendererOptions) {
  const schemaInput = new JSONSchemaInput(new FetchingJSONSchemaStore());
  for (const source of sources) {
    await schemaInput.addSource({
      name: source.name,
      schema: JSON.stringify(source.schema)
    });
  }

  const inputData = new InputData();
  inputData.addInput(schemaInput);
  const result = await quicktype({
    inputData,
    lang: language,
    rendererOptions
  });

  return `${result.lines.join("\n")}\n`;
}

function formatGo(source) {
  const result = spawnSync("gofmt", {
    encoding: "utf8",
    input: source
  });

  if (result.error) {
    throw new Error(`Cannot run gofmt: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    throw new Error(`gofmt failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function formatTypeScript(source) {
  return source.replace(/^( +)/gmu, (indentation) =>
    " ".repeat(Math.ceil(indentation.length / 2))
  );
}

function preserveTypeScriptWireStrings(value) {
  if (Array.isArray(value)) {
    return value.map(preserveTypeScriptWireStrings);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "format" && child === "date-time"))
      .map(([key, child]) => [key, preserveTypeScriptWireStrings(child)])
  );
}

export async function generateContractTypes(packageRoot) {
  const schemas = await loadSchemas(packageRoot);
  const bridgeSchema = schemas.get(BRIDGE_SCHEMA_ID);
  const pairingSchema = schemas.get(PAIRING_SCHEMA_ID);
  const workSchema = schemas.get(WORK_SCHEMA_ID);

  if (!bridgeSchema) {
    throw new Error(`Missing code generation schema: ${BRIDGE_SCHEMA_ID}`);
  }
  if (!pairingSchema) {
    throw new Error(`Missing code generation schema: ${PAIRING_SCHEMA_ID}`);
  }
  if (!workSchema) {
    throw new Error(`Missing code generation schema: ${WORK_SCHEMA_ID}`);
  }

  const bridgeCodegen = createBridgeCodegenSchemas(bridgeSchema);
  const pairingCodegen = createDefinitionCodegenSchemas(pairingSchema, [
    ["DevicePairingSessionCreated", "created"],
    ["DevicePairingSessionCreateRequest", "createRequest"],
    ["DevicePairingSessionOwnerProjection", "ownerProjection"],
    ["DevicePairingSessionClaimRequest", "claimRequest"],
    ["DevicePairingSessionClaimed", "claimed"],
    ["DevicePairingSessionPollRequest", "pollRequest"],
    ["DevicePairingSessionPollProjection", "pollProjection"],
    ["DevicePairingSessionApproveRequest", "approveRequest"],
    ["DevicePairingSessionRejectRequest", "rejectRequest"],
    ["DevicePairingSessionCancelRequest", "cancelRequest"]
  ]);
  const workCodegen = createDefinitionCodegenSchemas(workSchema, [
    ["TaskProjection", "taskProjection"],
    ["TaskDefinitionCommand", "taskDefinitionCommand"],
    ["RunAttemptProjection", "runAttemptProjection"],
    ["RunContextManifest", "contextManifest"],
    ["AmbiguityAcknowledgement", "ambiguityAcknowledgement"],
    ["ResultProposal", "resultProposal"],
    ["AgentResultProposal", "agentResultProposal"],
    ["ResultReviewCommand", "resultReviewCommand"],
    ["ResultProjection", "resultProjection"],
    ["WorkbenchQuery", "workbenchQuery"],
    ["WorkbenchPage", "workbenchPage"],
    ["LegacyTaskMapping", "legacyTaskMapping"],
    ["ChildTaskFromResultCommand", "childTaskFromResultCommand"]
  ]);
  const bridgeSchemas = bridgeCodegen.types.map((entry) => ({
    ...entry,
    sourceSchema: bridgeSchema
  }));
  const bundledBridgeSchemas = bridgeSchemas.map(
    ({ name, schema, sourceSchema }) => ({
      name,
      schema: dereference(schema, sourceSchema, schemas)
    })
  );
  const bundledPairingSchemas = pairingCodegen.map(
    ({ name, schema, sourceSchema }) => ({
      name,
      schema: dereference(schema, sourceSchema, schemas)
    })
  );
  const bundledWorkSchemas = workCodegen.map(
    ({ name, schema, sourceSchema }) => ({
      name,
      schema: dereference(schema, sourceSchema, schemas)
    })
  );
  const [
    renderedTypeScript,
    renderedGo,
    renderedPairingTypeScript,
    renderedPairingGo,
    renderedWorkTypeScript,
    renderedWorkGo
  ] = await Promise.all([
    render(
      bundledBridgeSchemas.map(({ name, schema }) => ({
        name,
        schema: preserveTypeScriptWireStrings(schema)
      })),
      "typescript",
      {
        "just-types": "true",
        "prefer-unions": "true"
      }
    ),
    render(bundledBridgeSchemas, "go", {
      "just-types-and-package": "true",
      package: "contracts"
    }),
    render(
      bundledPairingSchemas.map(({ name, schema }) => ({
        name,
        schema: preserveTypeScriptWireStrings(schema)
      })),
      "typescript",
      {
        "just-types": "true",
        "prefer-unions": "true"
      }
    ),
    render(bundledPairingSchemas, "go", {
      "just-types-and-package": "true",
      package: "pairingcontracts"
    }),
    render(
      bundledWorkSchemas.map(({ name, schema }) => ({
        name,
        schema: preserveTypeScriptWireStrings(schema)
      })),
      "typescript",
      {
        "just-types": "true",
        "prefer-unions": "true"
      }
    ),
    render(bundledWorkSchemas, "go", {
      "just-types-and-package": "true",
      package: "workcontracts"
    })
  ]);

  const union = bridgeCodegen.messages
    .map(({ name }) => `  | ${name}`)
    .join("\n");
  const typescript =
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" +
    formatTypeScript(renderedTypeScript).trimEnd() +
    `\n\nexport type BridgeMessage =\n${union};\n`;
  const go = formatGo(
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" + renderedGo
  );
  const pairingTypescript =
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" +
    formatTypeScript(renderedPairingTypeScript).trimEnd() +
    "\n";
  const pairingGo = formatGo(
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" + renderedPairingGo
  );
  const workTypescript =
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" +
    formatTypeScript(renderedWorkTypeScript).trimEnd() +
    "\n";
  const workGo = formatGo(
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" + renderedWorkGo
  );

  return {
    go,
    pairingGo,
    pairingTypescript,
    typescript,
    workGo,
    workTypescript
  };
}
