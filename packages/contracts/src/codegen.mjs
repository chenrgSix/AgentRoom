import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  FetchingJSONSchemaStore,
  InputData,
  JSONSchemaInput,
  quicktype
} from "quicktype-core";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const BRIDGE_SCHEMA_ID =
  "https://agentroom.dev/schemas/bridge/messages.schema.json";
const PAIRING_SCHEMA_ID =
  "https://agentroom.dev/schemas/bridge/pairing-session.schema.json";
const WORK_SCHEMA_ID =
  "https://agentroom.dev/schemas/work/task-result.schema.json";
const EXECUTION_SCHEMA_ID =
  "https://agentroom.dev/schemas/work/execution-plan.schema.json";
const EXECUTION_RUNTIME_SCHEMA_ID =
  "https://agentroom.dev/schemas/work/execution-runtime.schema.json";

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
    const errorLine = Number(result.stderr.match(/:(\d+):\d+:/u)?.[1]);
    const context = Number.isInteger(errorLine)
      ? source.split("\n").slice(Math.max(0, errorLine - 3), errorLine + 3).join("\n")
      : "";
    throw new Error(`gofmt failed: ${result.stderr.trim()}\n${context}`);
  }
  return result.stdout;
}

function formatTypeScript(source) {
  return source.replace(/^( +)/gmu, (indentation) =>
    " ".repeat(Math.ceil(indentation.length / 2))
  );
}

function preserveGoOpenErrorDetails(source) {
  const detailsField = /Details\s+\*Details\s+`json:"details,omitempty"`/u;
  if (!detailsField.test(source)) {
    throw new Error("Generated Bridge error details field is missing");
  }
  return source.replace(
    detailsField,
    'Details map[string]interface{} `json:"details,omitempty"`'
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

// Execution digests bind the exact UTC string, including fractional precision.
// Keep the legacy Bridge timestamps unchanged outside the execution subtree.
function preserveGoExecutionWireStrings(value) {
  if (Array.isArray(value)) return value.map(preserveGoExecutionWireStrings);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === "execution" ? preserveTypeScriptWireStrings(child) : preserveGoExecutionWireStrings(child)
  ]));
}

function removeNestedSchemaIdentities(value, isRoot = true) {
  if (Array.isArray(value)) {
    return value.map((item) => removeNestedSchemaIdentities(item, false));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => isRoot || (key !== "$id" && key !== "$schema"))
      .map(([key, child]) => [
        key,
        removeNestedSchemaIdentities(child, false)
      ])
  );
}

function mergeCanonicalPropertyTrees(...trees) {
  const merged = {};
  for (const tree of trees) {
    if (!tree || typeof tree !== "object") continue;
    if (tree.n) {
      merged.n = true;
    }
    if (tree.d) {
      merged.d = true;
    }
    for (const bound of ["l", "u"]) {
      if (tree[bound] === undefined) continue;
      if (merged[bound] !== undefined && merged[bound] !== tree[bound]) {
        throw new Error(`Bridge numeric bounds disagree at one declared path`);
      }
      merged[bound] = tree[bound];
    }
    if (tree.p) {
      merged.p ??= {};
      for (const [property, child] of Object.entries(tree.p)) {
        merged.p[property] = mergeCanonicalPropertyTrees(
          merged.p[property],
          child
        );
      }
    }
    if (tree.i) {
      merged.i = mergeCanonicalPropertyTrees(merged.i, tree.i);
    }
    if (tree.a) {
      merged.a = mergeCanonicalPropertyTrees(merged.a, tree.a);
    }
  }
  return merged;
}

function createCanonicalPropertyTree(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const branches = [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    schema.if,
    schema.then,
    schema.else
  ].filter(Boolean).map(createCanonicalPropertyTree);
  const direct = {};
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("integer")) {
    direct.n = true;
  } else if (types.includes("number")) {
    direct.d = true;
  }
  if (schema.minimum !== undefined) {
    direct.l = String(schema.minimum);
  }
  if (schema.maximum !== undefined) {
    direct.u = String(schema.maximum);
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const property of Object.keys(schema.properties)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(property)) {
        throw new Error(`Bridge canonical property cannot form a safe matcher: ${property}`);
      }
    }
    direct.p = Object.fromEntries(
      Object.entries(schema.properties).map(([property, child]) => [
        property,
        createCanonicalPropertyTree(child)
      ])
    );
  }
  if (schema.items && typeof schema.items === "object") {
    direct.i = createCanonicalPropertyTree(schema.items);
  }
  if (schema.additionalProperties &&
      typeof schema.additionalProperties === "object") {
    direct.a = createCanonicalPropertyTree(schema.additionalProperties);
  }
  return mergeCanonicalPropertyTrees(direct, ...branches);
}

function createBridgeCanonicalPropertyTrees(messages, bundledSchemas) {
  const schemasByName = new Map(bundledSchemas.map((schema) => [
    schema.name,
    schema.schema
  ]));
  return Object.fromEntries(messages.map((message) => {
    const messageType = message.schema.allOf?.[1]?.properties?.type?.const;
    const bundledSchema = schemasByName.get(message.name);
    if (typeof messageType !== "string" || !bundledSchema) {
      throw new Error(`Bridge message type is missing: ${message.name}`);
    }
    return [messageType, createCanonicalPropertyTree(bundledSchema)];
  }));
}

function renderBridgeStandaloneValidator(schema) {
  const validator = new Ajv2020({
    code: {
      optimize: 2,
      source: true
    },
    strict: true
  });
  addFormats(validator);
  const validate = validator.compile(schema);

  return `${standaloneCode(validator, validate).trimEnd()}\n`;
}

function renderExecutionValidators(schemas) {
  const validator = new Ajv2020({
    code: { optimize: 2, source: true },
    strict: true,
    ownProperties: true
  });
  addFormats(validator);
  for (const schema of schemas.values()) validator.addSchema(schema);
  return `${standaloneCode(validator, {
    planDefinition: `${EXECUTION_SCHEMA_ID}#/$defs/planDefinition`,
    proposalCommand: `${EXECUTION_SCHEMA_ID}#/$defs/proposalCommand`,
    revisionCommand: `${EXECUTION_SCHEMA_ID}#/$defs/revisionCommand`,
    approvalCommand: `${EXECUTION_SCHEMA_ID}#/$defs/approvalCommand`,
    controlCommand: `${EXECUTION_SCHEMA_ID}#/$defs/controlCommand`,
    decisionContent: `${EXECUTION_SCHEMA_ID}#/$defs/decisionContent`,
    executionManifest: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/manifest`,
    executionInputBinding: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/inputBinding`,
    executionCapability: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/capability`,
    runtimeAuthorityRequest: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/runtimeAuthorityRequest`,
    runtimeAuthorityView: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/runtimeAuthorityView`,
    repositoryBinding: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/bindingSummary`,
    executionGrant: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/grantSummary`,
    repositoryOperation: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/operationRequest`,
    repositoryReceipt: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/operationReceipt`,
    executionCheckpoint: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/checkpoint`,
    verificationReceipt: `${EXECUTION_RUNTIME_SCHEMA_ID}#/$defs/verificationReceipt`
  }).trimEnd()}\n`;
}

function renderBridgeRuntimeModule(canonicalPropertyTrees) {
  const canonicalPropertyTreesSource = JSON.stringify(
    canonicalPropertyTrees,
    null,
    2
  );
  return `// Code generated from JSON Schema; DO NOT EDIT.

import validate from "./bridge-validator.cjs";

const canonicalPropertyTrees = ${canonicalPropertyTreesSource};
const foldPatterns = new Map();
const rawNumberSource = Symbol("ConveneWireRawNumberSource");
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
const maxJSONNumberLexemeLength = 256;
const maxJSONNumberExponentMagnitude = 512;
const maxJSONDepth = 64;
const maxJSONTotalNodes = 8192;
const maxJSONNumbers = 4096;
const jsonResourceLimitExceeded = Symbol("ConveneWireJSONResourceLimit");
const jsonLexicalAdmissionRejected = Symbol("ConveneWireJSONLexicalAdmission");
const jsonNumberPattern =
  /^(-?)(0|[1-9][0-9]*)(?:\\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u;

function equalFold(value, canonical) {
  let pattern = foldPatterns.get(canonical);
  if (!pattern) {
    pattern = new RegExp(\`^(?:\${canonical})$\`, "iu");
    foldPatterns.set(canonical, pattern);
  }
  return pattern.test(value);
}

function containsNonCanonicalProperty(value, tree) {
  if (Array.isArray(value)) {
    return tree?.i
      ? value.some((child) => containsNonCanonicalProperty(child, tree.i))
      : false;
  }
  if (value === null || typeof value !== "object") return false;
  const properties = tree?.p ?? {};
  for (const [property, child] of Object.entries(value)) {
    if (Object.hasOwn(properties, property)) {
      if (containsNonCanonicalProperty(child, properties[property])) return true;
      continue;
    }
    if (Object.keys(properties).some((canonical) =>
      equalFold(property, canonical)
    )) return true;
    if (tree?.a && containsNonCanonicalProperty(child, tree.a)) return true;
  }
  return false;
}

function parseExactDecimal(source) {
  const match = jsonNumberPattern.exec(source);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  let digits = (match[2] + fraction).replace(/^0+/u, "");
  if (digits.length === 0) {
    return { sign: 0, digits: "0", scale: 0n };
  }
  const trailingZeros = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);
  return {
    sign: match[1] === "-" ? -1 : 1,
    digits,
    scale: BigInt(match[4] ?? "0") - BigInt(fraction.length) +
      BigInt(trailingZeros)
  };
}

function compareExactDecimals(left, right) {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const leftMagnitude = BigInt(left.digits.length) + left.scale;
  const rightMagnitude = BigInt(right.digits.length) + right.scale;
  let compared = leftMagnitude < rightMagnitude
    ? -1
    : leftMagnitude > rightMagnitude ? 1 : 0;
  if (compared === 0) {
    const width = Math.max(left.digits.length, right.digits.length);
    const alignedLeft = left.digits.padEnd(width, "0");
    const alignedRight = right.digits.padEnd(width, "0");
    compared = alignedLeft < alignedRight ? -1 : alignedLeft > alignedRight ? 1 : 0;
  }
  return left.sign < 0 ? -compared : compared;
}

function declaredNumberWithinBounds(decimal, tree) {
  if (tree?.l !== undefined) {
    const minimum = parseExactDecimal(tree.l);
    if (!minimum || compareExactDecimals(decimal, minimum) < 0) return false;
  }
  if (tree?.u !== undefined) {
    const maximum = parseExactDecimal(tree.u);
    if (!maximum || compareExactDecimals(decimal, maximum) > 0) return false;
  }
  return true;
}

function numberMarkerSource(value) {
  return value !== null && typeof value === "object"
    ? value[rawNumberSource]
    : undefined;
}

function normalizeDeclaredNumbers(value, tree) {
  const source = numberMarkerSource(value);
  if (source !== undefined) {
    if (!tree?.n && !tree?.d) {
      const compatibleNumber = Number(source);
      const exact = parseExactDecimal(source);
      const roundTrip = Number.isFinite(compatibleNumber)
        ? parseExactDecimal(JSON.stringify(compatibleNumber))
        : undefined;
      return exact && roundTrip && compareExactDecimals(exact, roundTrip) === 0
        ? compatibleNumber
        : JSON.rawJSON(source);
    }
    const decimal = parseExactDecimal(source);
    if (!decimal || !declaredNumberWithinBounds(decimal, tree)) return undefined;
    if (tree.n && decimal.sign !== 0 && decimal.scale < 0n) return undefined;
    const number = Number(source);
    if (!Number.isFinite(number)) return undefined;
    if (tree.d && decimal.sign !== 0 && number === 0) return undefined;
    if (tree.n && !Number.isSafeInteger(number)) return undefined;
    return tree.n && decimal.sign === 0 ? 0 : number;
  }
  if (Array.isArray(value)) {
    const normalized = [];
    for (const child of value) {
      const next = normalizeDeclaredNumbers(child, tree?.i);
      if (next === undefined) return undefined;
      normalized.push(next);
    }
    return normalized;
  }
  if (value === null || typeof value !== "object") return value;
  const normalized = {};
  for (const [property, child] of Object.entries(value)) {
    const childTree = tree?.p?.[property] ?? tree?.a;
    const next = normalizeDeclaredNumbers(child, childTree);
    if (next === undefined) return undefined;
    normalized[property] = next;
  }
  return normalized;
}

function scanJSONResourceBounds(text) {
  let index = 0;
  let totalNodes = 0;
  let numberCount = 0;
  const malformed = () => {
    throw new SyntaxError("Malformed JSON");
  };
  const limited = () => {
    throw jsonResourceLimitExceeded;
  };
  const skipWhitespace = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      index += 1;
    }
  };
  const hexDigitValue = (code) => {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
  };
  const tryEscapedCodeUnit = (escapeIndex) => {
    if (text.charCodeAt(escapeIndex) !== 92 ||
        text.charCodeAt(escapeIndex + 1) !== 117 ||
        escapeIndex + 6 > text.length) return undefined;
    let codeUnit = 0;
    for (let offset = 2; offset < 6; offset += 1) {
      const digit = hexDigitValue(text.charCodeAt(escapeIndex + offset));
      if (digit < 0) return undefined;
      codeUnit = codeUnit * 16 + digit;
    }
    return codeUnit;
  };
  const escapedCodeUnit = (escapeIndex) => {
    const codeUnit = tryEscapedCodeUnit(escapeIndex);
    if (codeUnit === undefined) malformed();
    return codeUnit;
  };
  const rejectLexicalAdmission = () => {
    throw jsonLexicalAdmissionRejected;
  };
  const consumeString = () => {
    if (text.charCodeAt(index) !== 34) malformed();
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        index += 1;
        return;
      }
      if (code === 92) {
        const escape = text.charCodeAt(index + 1);
        if (escape === 117) {
          const codeUnit = escapedCodeUnit(index);
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const low = tryEscapedCodeUnit(index + 6);
            if (low === undefined || low < 0xdc00 || low > 0xdfff) {
              rejectLexicalAdmission();
            }
            index += 12;
            continue;
          }
          if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            rejectLexicalAdmission();
          }
          index += 6;
          continue;
        }
        if (![34, 47, 92, 98, 102, 110, 114, 116].includes(escape)) {
          malformed();
        }
        index += 2;
        continue;
      }
      if (code < 32) malformed();
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low < 0xdc00 || low > 0xdfff) rejectLexicalAdmission();
        index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) rejectLexicalAdmission();
      index += 1;
    }
    malformed();
  };
  const consumeNumber = () => {
    const start = index;
    if (text.charCodeAt(index) === 45) index += 1;
    if (text.charCodeAt(index) === 48) {
      index += 1;
    } else {
      const first = text.charCodeAt(index);
      if (first < 49 || first > 57) malformed();
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
    }
    if (text.charCodeAt(index) === 46) {
      index += 1;
      const fractionStart = index;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
      if (index === fractionStart) malformed();
    }
    let exponentDigitsStart = -1;
    const exponentMarker = text.charCodeAt(index);
    if (exponentMarker === 69 || exponentMarker === 101) {
      index += 1;
      const sign = text.charCodeAt(index);
      if (sign === 43 || sign === 45) index += 1;
      exponentDigitsStart = index;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
      if (index === exponentDigitsStart) malformed();
    }
    numberCount += 1;
    if (numberCount > maxJSONNumbers ||
        index - start > maxJSONNumberLexemeLength) limited();
    if (exponentDigitsStart >= 0) {
      let significantStart = exponentDigitsStart;
      while (significantStart < index &&
          text.charCodeAt(significantStart) === 48) significantStart += 1;
      const exponentDigits = index - significantStart;
      if (exponentDigits > 3 ||
          (exponentDigits > 0 &&
            Number(text.slice(significantStart, index)) >
              maxJSONNumberExponentMagnitude)) limited();
    }
  };
  const consumeValue = (depth) => {
    totalNodes += 1;
    if (totalNodes > maxJSONTotalNodes || depth > maxJSONDepth) limited();
    skipWhitespace();
    const code = text.charCodeAt(index);
    if (code === 123) {
      index += 1;
      skipWhitespace();
      if (text.charCodeAt(index) === 125) {
        index += 1;
        return;
      }
      const keys = new Set();
      while (true) {
        const keyStart = index;
        consumeString();
        // Compare decoded names so escaped aliases cannot hide duplicate grants
        // or generations from another JSON consumer's first/last-wins parser.
        const key = JSON.parse(text.slice(keyStart, index));
        if (keys.has(key)) rejectLexicalAdmission();
        keys.add(key);
        skipWhitespace();
        if (text.charCodeAt(index) !== 58) malformed();
        index += 1;
        consumeValue(depth + 1);
        skipWhitespace();
        const delimiter = text.charCodeAt(index);
        if (delimiter === 125) {
          index += 1;
          return;
        }
        if (delimiter !== 44) malformed();
        index += 1;
        skipWhitespace();
      }
    }
    if (code === 91) {
      index += 1;
      skipWhitespace();
      if (text.charCodeAt(index) === 93) {
        index += 1;
        return;
      }
      while (true) {
        consumeValue(depth + 1);
        skipWhitespace();
        const delimiter = text.charCodeAt(index);
        if (delimiter === 93) {
          index += 1;
          return;
        }
        if (delimiter !== 44) malformed();
        index += 1;
      }
    }
    if (code === 34) {
      consumeString();
      return;
    }
    if (code === 45 || (code >= 48 && code <= 57)) {
      consumeNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    malformed();
  };
  skipWhitespace();
  consumeValue(1);
  skipWhitespace();
  if (index !== text.length) malformed();
}

function parseRawBridgeMessage(source) {
  const text = typeof source === "string"
    ? source
    : source instanceof Uint8Array ? utf8Decoder.decode(source) : undefined;
  if (text === undefined) {
    throw new TypeError("Bridge message source must be text or UTF-8 bytes");
  }
  if (text.charCodeAt(0) === 0xfeff) return undefined;
  try {
    scanJSONResourceBounds(text);
  } catch (error) {
    if (error === jsonResourceLimitExceeded ||
        error === jsonLexicalAdmissionRejected) return undefined;
    throw error;
  }
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (typeof context?.source !== "string") {
      throw new SyntaxError("JSON parser did not retain the numeric lexeme");
    }
    return { [rawNumberSource]: context.source };
  });
}

export function validateBridgeMessage(value) {
  if (!validate(value)) return false;
  const tree = canonicalPropertyTrees[value.type];
  return tree !== undefined && !containsNonCanonicalProperty(value, tree);
}

export function decodeBridgeMessage(source) {
  const raw = parseRawBridgeMessage(source);
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const tree = typeof raw.type === "string"
    ? canonicalPropertyTrees[raw.type]
    : undefined;
  if (tree === undefined || containsNonCanonicalProperty(raw, tree)) {
    return undefined;
  }
  const normalized = normalizeDeclaredNumbers(raw, tree);
  return normalized !== undefined && validate(normalized)
    ? normalized
    : undefined;
}
`;
}

function renderBridgeRuntimeDeclaration() {
  return `// Code generated from JSON Schema; DO NOT EDIT.

import type { BridgeMessage } from "../typescript/bridge-messages.js";

export function validateBridgeMessage(value: unknown): value is BridgeMessage;
export function decodeBridgeMessage(
  source: string | Uint8Array
): BridgeMessage | undefined;
`;
}

function renderGoBridgeRuntimeValidator(canonicalPropertyTrees, messages) {
  const canonicalPropertyTreesSource = JSON.stringify(
    JSON.stringify(canonicalPropertyTrees)
  );
  const decodeCases = messages.map((message) => {
    const messageType = message.schema.allOf?.[1]?.properties?.type?.const;
    if (typeof messageType !== "string") {
      throw new Error(`Bridge message type is missing: ${message.name}`);
    }
    return `case "${messageType}":
		var message contracts.${message.name}
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil`;
  }).join("\n\t");
  return formatGo(`// Code generated from JSON Schema; DO NOT EDIT.

package runtimecontracts

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"

	contracts "convenewire.dev/contracts/generated/go"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const bridgeSchemaID = "${BRIDGE_SCHEMA_ID}"

//go:embed bridge-schema.json
var bridgeSchemaSource []byte

const bridgeCanonicalPropertyTreesSource = ${canonicalPropertyTreesSource}

const maxSafeJSONInteger int64 = 9007199254740991

const maxJSONNumberLexemeLength = 256

const maxJSONNumberExponentMagnitude = 512

const maxJSONDepth = 64

const maxJSONTotalNodes = 8192

const maxJSONNumbers = 4096

var ErrInvalidBridgeMessage = errors.New("Bridge message does not match the authoritative schema")

var bridgeSchema = mustCompileBridgeSchema()

var bridgeCanonicalPropertyTrees = mustDecodeCanonicalPropertyTrees()

type canonicalPropertyTree struct {
	Properties map[string]canonicalPropertyTree \`json:"p,omitempty"\`
	Items *canonicalPropertyTree \`json:"i,omitempty"\`
	Additional *canonicalPropertyTree \`json:"a,omitempty"\`
	Integer bool \`json:"n,omitempty"\`
	Number bool \`json:"d,omitempty"\`
	Minimum string \`json:"l,omitempty"\`
	Maximum string \`json:"u,omitempty"\`
}

func ValidateBridgeMessage(source []byte) error {
	_, err := ValidateAndNormalizeBridgeMessage(source)
	return err
}

func ValidateAndNormalizeBridgeMessage(source []byte) ([]byte, error) {
	if !utf8.Valid(source) ||
		!jsonStringsHaveValidUnicodeEscapes(source) ||
		!bridgeJSONWithinResourceBounds(source) {
		return nil, ErrInvalidBridgeMessage
	}
	value, err := decodeSingleJSONValue(source)
	if err != nil || bridgeSchema.Validate(value) != nil {
		return nil, ErrInvalidBridgeMessage
	}
	envelope, ok := value.(map[string]any)
	if !ok {
		return nil, ErrInvalidBridgeMessage
	}
	messageType, ok := envelope["type"].(string)
	if !ok {
		return nil, ErrInvalidBridgeMessage
	}
	propertyTree, ok := bridgeCanonicalPropertyTrees[messageType]
	if !ok || containsNonCanonicalProperty(value, propertyTree) {
		return nil, ErrInvalidBridgeMessage
	}
	normalized, err := normalizeDeclaredNumbers(value, propertyTree)
	if err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	return encoded, nil
}

func jsonStringsHaveValidUnicodeEscapes(source []byte) bool {
	inString := false
	for index := 0; index < len(source); {
		current := source[index]
		if !inString {
			if current == '"' {
				inString = true
			}
			index++
			continue
		}
		if current == '"' {
			inString = false
			index++
			continue
		}
		if current != '\\\\' {
			if current < 0x20 {
				return false
			}
			index++
			continue
		}
		if index+1 >= len(source) {
			return false
		}
		escape := source[index+1]
		if escape != 'u' {
			switch escape {
			case '"', '\\\\', '/', 'b', 'f', 'n', 'r', 't':
				index += 2
				continue
			default:
				return false
			}
		}
		codeUnit, ok := jsonEscapedCodeUnit(source, index)
		if !ok {
			return false
		}
		if codeUnit >= 0xd800 && codeUnit <= 0xdbff {
			low, ok := jsonEscapedCodeUnit(source, index+6)
			if !ok || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 12
			continue
		}
		if codeUnit >= 0xdc00 && codeUnit <= 0xdfff {
			return false
		}
		index += 6
	}
	return !inString
}

func jsonEscapedCodeUnit(source []byte, escapeIndex int) (uint16, bool) {
	if escapeIndex < 0 || escapeIndex+6 > len(source) ||
		source[escapeIndex] != '\\\\' || source[escapeIndex+1] != 'u' {
		return 0, false
	}
	var codeUnit uint16
	for index := escapeIndex + 2; index < escapeIndex+6; index++ {
		digit, ok := jsonHexNibble(source[index])
		if !ok {
			return 0, false
		}
		codeUnit = codeUnit*16 + uint16(digit)
	}
	return codeUnit, true
}

func jsonHexNibble(value byte) (byte, bool) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', true
	case value >= 'A' && value <= 'F':
		return value - 'A' + 10, true
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, true
	default:
		return 0, false
	}
}

func bridgeJSONWithinResourceBounds(source []byte) bool {
	type jsonContainerState struct {
		Object bool
		ExpectingKey bool
		Keys map[string]struct{}
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	containers := []jsonContainerState{}
	totalNodes := 0
	numberCount := 0
	rootValues := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return false
		}
		if delimiter, ok := token.(json.Delim); ok &&
			(delimiter == '}' || delimiter == ']') {
			if len(containers) == 0 {
				return false
			}
			current := containers[len(containers)-1]
			if (delimiter == '}') != current.Object ||
				(current.Object && !current.ExpectingKey) {
				return false
			}
			containers = containers[:len(containers)-1]
			continue
		}
		if len(containers) == 0 {
			rootValues++
		} else {
			parent := &containers[len(containers)-1]
			if parent.Object && parent.ExpectingKey {
				key, ok := token.(string)
				if !ok {
					return false
				}
				if _, duplicate := parent.Keys[key]; duplicate {
					return false
				}
				if parent.Keys == nil {
					parent.Keys = make(map[string]struct{})
				}
				parent.Keys[key] = struct{}{}
				parent.ExpectingKey = false
				continue
			}
			if parent.Object {
				parent.ExpectingKey = true
			}
		}
		totalNodes++
		if totalNodes > maxJSONTotalNodes ||
			len(containers)+1 > maxJSONDepth {
			return false
		}
		switch typed := token.(type) {
		case json.Number:
			numberCount++
			if numberCount > maxJSONNumbers ||
				!jsonNumberWithinResourceBounds(typed.String()) {
				return false
			}
		case json.Delim:
			if typed != '{' && typed != '[' {
				return false
			}
			containers = append(containers, jsonContainerState{
				Object: typed == '{',
				ExpectingKey: typed == '{',
			})
		}
	}
	return rootValues == 1 && len(containers) == 0
}

func jsonNumberWithinResourceBounds(source string) bool {
	if len(source) > maxJSONNumberLexemeLength {
		return false
	}
	exponentIndex := strings.IndexAny(source, "eE")
	if exponentIndex < 0 {
		return true
	}
	exponent := source[exponentIndex+1:]
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		return true
	}
	if len(exponent) > 3 {
		return false
	}
	magnitude, err := strconv.Atoi(exponent)
	return err == nil && magnitude <= maxJSONNumberExponentMagnitude
}

func DecodeBridgeMessage(source []byte) (any, error) {
	normalized, err := ValidateAndNormalizeBridgeMessage(source)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Type string \`json:"type"\`
	}
	if err := decodeNormalizedBridgeMessage(normalized, &envelope); err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	switch envelope.Type {
	${decodeCases}
	default:
		return nil, ErrInvalidBridgeMessage
	}
}

func decodeNormalizedBridgeMessage(source []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidBridgeMessage
	}
	return nil
}

func containsNonCanonicalProperty(value any, tree canonicalPropertyTree) bool {
	switch typed := value.(type) {
	case map[string]any:
		for property, child := range typed {
			childTree, exact := tree.Properties[property]
			if !exact {
				for canonical := range tree.Properties {
					if strings.EqualFold(property, canonical) {
						return true
					}
				}
				if tree.Additional != nil &&
					containsNonCanonicalProperty(child, *tree.Additional) {
					return true
				}
				continue
			}
			if containsNonCanonicalProperty(child, childTree) {
				return true
			}
		}
	case []any:
		if tree.Items != nil {
			for _, child := range typed {
				if containsNonCanonicalProperty(child, *tree.Items) {
					return true
				}
			}
		}
	}
	return false
}

func normalizeDeclaredNumbers(
	value any,
	tree canonicalPropertyTree,
) (any, error) {
	if tree.Integer {
		number, ok := value.(json.Number)
		if !ok {
			return value, nil
		}
		rational, ok := new(big.Rat).SetString(number.String())
		if !ok || !rational.IsInt() {
			return nil, ErrInvalidBridgeMessage
		}
		integer := rational.Num()
		maximum := big.NewInt(maxSafeJSONInteger)
		minimum := new(big.Int).Neg(maximum)
		if integer.Cmp(minimum) < 0 || integer.Cmp(maximum) > 0 {
			return nil, ErrInvalidBridgeMessage
		}
		return integer.Int64(), nil
	}
	if tree.Number {
		number, ok := value.(json.Number)
		if !ok {
			return value, nil
		}
		rational, ok := new(big.Rat).SetString(number.String())
		parsed, err := strconv.ParseFloat(number.String(), 64)
		if !ok || err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
			(parsed == 0 && rational.Sign() != 0) {
			return nil, ErrInvalidBridgeMessage
		}
		return parsed, nil
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			childTree, exact := tree.Properties[key]
			if !exact {
				if tree.Additional == nil {
					continue
				}
				childTree = *tree.Additional
			}
			normalized, err := normalizeDeclaredNumbers(child, childTree)
			if err != nil {
				return nil, err
			}
			typed[key] = normalized
		}
		return typed, nil
	case []any:
		if tree.Items == nil {
			return typed, nil
		}
		for index, child := range typed {
			normalized, err := normalizeDeclaredNumbers(child, *tree.Items)
			if err != nil {
				return nil, err
			}
			typed[index] = normalized
		}
		return typed, nil
	default:
		return value, nil
	}
}

func decodeSingleJSONValue(source []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidBridgeMessage
	}
	return value, nil
}

func mustCompileBridgeSchema() *jsonschema.Schema {
	document, err := decodeSingleJSONValue(bridgeSchemaSource)
	if err != nil {
		panic("generated Bridge schema is invalid JSON")
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource(bridgeSchemaID, document); err != nil {
		panic("generated Bridge schema cannot be registered")
	}
	schema, err := compiler.Compile(bridgeSchemaID)
	if err != nil {
		panic("generated Bridge schema cannot be compiled")
	}
	return schema
}

func mustDecodeCanonicalPropertyTrees() map[string]canonicalPropertyTree {
	var trees map[string]canonicalPropertyTree
	if err := json.Unmarshal([]byte(bridgeCanonicalPropertyTreesSource), &trees); err != nil {
		panic("generated Bridge canonical property trees are invalid JSON")
	}
	return trees
}
`);
}

export async function generateContractTypes(packageRoot) {
  const schemas = await loadSchemas(packageRoot);
  const bridgeSchema = schemas.get(BRIDGE_SCHEMA_ID);
  const pairingSchema = schemas.get(PAIRING_SCHEMA_ID);
  const workSchema = schemas.get(WORK_SCHEMA_ID);
  const executionSchema = schemas.get(EXECUTION_SCHEMA_ID);
  const executionRuntimeSchema = schemas.get(EXECUTION_RUNTIME_SCHEMA_ID);

  if (!bridgeSchema) {
    throw new Error(`Missing code generation schema: ${BRIDGE_SCHEMA_ID}`);
  }
  if (!pairingSchema) {
    throw new Error(`Missing code generation schema: ${PAIRING_SCHEMA_ID}`);
  }
  if (!workSchema) {
    throw new Error(`Missing code generation schema: ${WORK_SCHEMA_ID}`);
  }
  if (!executionSchema) {
    throw new Error(`Missing code generation schema: ${EXECUTION_SCHEMA_ID}`);
  }
  if (!executionRuntimeSchema) {
    throw new Error(`Missing code generation schema: ${EXECUTION_RUNTIME_SCHEMA_ID}`);
  }

  const bridgeCodegen = createBridgeCodegenSchemas(bridgeSchema);
  const pairingCodegen = createDefinitionCodegenSchemas(pairingSchema, [
    ["DevicePairingSessionCreated", "created"],
    ["DevicePairingMemberBinding", "memberBinding"],
    ["ClientEntryRequest", "clientEntryRequest"],
    ["ClientEntryTicket", "clientEntryTicket"],
    ["ClientEntryClaim", "clientEntryClaim"],
    ["ClientEntryIdentity", "clientEntryIdentity"],
    ["DevicePairingSessionCreateRequest", "createRequest"],
    ["DevicePairingSessionOwnerProjection", "ownerProjection"],
    ["DevicePairingSessionClaimRequest", "claimRequest"],
    ["DevicePairingSessionClaimed", "claimed"],
    ["DevicePairingSessionPollRequest", "pollRequest"],
    ["DevicePairingSessionPollProjection", "pollProjection"],
    ["DevicePairingSessionApproveRequest", "approveRequest"],
    ["DevicePairingSessionRejectRequest", "rejectRequest"],
    ["DevicePairingSessionCancelRequest", "cancelRequest"],
    ["DevicePairingPrivateTrustDescriptor", "privateTrustDescriptor"],
    ["DevicePairingPrivateCaRotationOffer", "privateCaRotationOffer"],
    [
      "DevicePairingPrivateCaRotationAcknowledgeRequest",
      "privateCaRotationAcknowledgeRequest"
    ]
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
  const executionCodegen = createDefinitionCodegenSchemas(executionSchema, [
    ["ExecutionPlanProjection", "planProjection"],
    ["ExecutionDecisionSourceSnapshot", "decisionSourceSnapshot"],
    ["ExecutionPlanPage", "planPage"],
    ["ExecutionPlanRevisionPage", "revisionPage"],
    ["ExecutionDecisionRecord", "decisionRecord"],
    ["ExecutionDecisionContent", "decisionContent"],
    ["ExecutionPlanDefinition", "planDefinition"],
    ["ExecutionPlanProposalCommand", "proposalCommand"],
    ["ExecutionPlanRevisionCommand", "revisionCommand"],
    ["ExecutionPlanApprovalCommand", "approvalCommand"],
    ["ExecutionPlanApprovalRecord", "approvalRecord"],
    ["ExecutionPlanApprovalReceipt", "approvalReceipt"],
    ["ExecutionPlanApprovalPage", "approvalPage"],
    ["ExecutionPlanControlCommand", "controlCommand"],
    ["ExecutionPlanRevision", "planRevision"],
    ["ExecutionAgentPlanProposalCommand", "agentProposalCommand"]
  ]);
  executionCodegen.push(...createDefinitionCodegenSchemas(executionRuntimeSchema, [
    ["GovernedExecutionManifest", "manifest"],
    ["ExecutionInputBinding", "inputBinding"],
    ["GovernedExecutionCapability", "capability"],
    ["RuntimeAuthorityRequest", "runtimeAuthorityRequest"],
    ["RuntimeAuthorityView", "runtimeAuthorityView"],
    ["RepositoryBindingSummary", "bindingSummary"],
    ["ExecutionGrantSummary", "grantSummary"],
    ["RepositoryOperationRequest", "operationRequest"],
    ["RepositoryOperationReceipt", "operationReceipt"],
    ["RepositoryCheckpoint", "checkpoint"],
    ["VerificationReceipt", "verificationReceipt"]
  ]));
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
  const bundledExecutionSchemas = executionCodegen.map(
    ({ name, schema, sourceSchema }) => ({
      name,
      schema: dereference(schema, sourceSchema, schemas)
    })
  );
  const bundledBridgeSchema = removeNestedSchemaIdentities(
    dereference(bridgeSchema, bridgeSchema, schemas)
  );
  const bridgeCanonicalPropertyTrees = createBridgeCanonicalPropertyTrees(
    bridgeCodegen.messages,
    bundledBridgeSchemas
  );
  const [
    renderedTypeScript,
    renderedGo,
    renderedPairingTypeScript,
    renderedPairingGo,
    renderedWorkTypeScript,
    renderedWorkGo,
    renderedExecutionTypeScript,
    renderedExecutionGo
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
    render(bundledBridgeSchemas.map(({ name, schema }) => ({ name, schema: preserveGoExecutionWireStrings(schema) })), "go", {
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
    }),
    render(
      bundledExecutionSchemas.map(({ name, schema }) => ({
        name,
        schema: preserveTypeScriptWireStrings(schema)
      })),
      "typescript",
      { "just-types": "true", "prefer-unions": "true" }
    ),
    render(bundledExecutionSchemas.map(({ name, schema }) => ({ name, schema: preserveTypeScriptWireStrings(schema) })), "go", {
      "just-types-and-package": "true",
      package: "executioncontracts"
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
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" +
      preserveGoOpenErrorDetails(renderedGo)
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
  const executionTypescript =
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" +
    formatTypeScript(renderedExecutionTypeScript).trimEnd() + "\n";
  const executionGo = formatGo(
    "// Code generated from JSON Schema; DO NOT EDIT.\n\n" + renderedExecutionGo
  );

  return {
    goExecutionSchema: `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://agentroom.dev/schemas/runtime/go-execution.json",
      $defs: Object.fromEntries(Object.entries({
        executionManifest: "manifest", executionInputBinding: "inputBinding", executionCapability: "capability",
        runtimeAuthorityRequest: "runtimeAuthorityRequest", runtimeAuthorityView: "runtimeAuthorityView",
        repositoryBinding: "bindingSummary", executionGrant: "grantSummary", repositoryOperation: "operationRequest",
        repositoryReceipt: "operationReceipt", executionCheckpoint: "checkpoint", verificationReceipt: "verificationReceipt"
      }).map(([kind, definition]) => [kind, removeNestedSchemaIdentities(
        dereference(executionRuntimeSchema.$defs[definition], executionRuntimeSchema, schemas), false)]))
    }, null, 2)}\n`,
    goExecutionRuntime: formatGo(await readFile(path.join(packageRoot, "src/go-execution-runtime.go.template"), "utf8")),
    executionTypescript,
    executionGo,
    executionValidators: renderExecutionValidators(schemas),
    bridgeRuntimeDeclaration: renderBridgeRuntimeDeclaration(),
    bridgeRuntimeModule: renderBridgeRuntimeModule(
      bridgeCanonicalPropertyTrees
    ),
    bridgeSchema: `${JSON.stringify(bundledBridgeSchema, null, 2)}\n`,
    bridgeStandaloneValidator:
      renderBridgeStandaloneValidator(bundledBridgeSchema),
    go,
    goBridgeRuntimeValidator: renderGoBridgeRuntimeValidator(
      bridgeCanonicalPropertyTrees,
      bridgeCodegen.messages
    ),
    pairingGo,
    pairingTypescript,
    typescript,
    workGo,
    workTypescript
  };
}
