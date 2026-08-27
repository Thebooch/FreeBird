import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  validateActionArgs,
  type ValidateArgsResult,
} from "@freebirdai/core";

export const schemaToJson = (schema: z.ZodTypeAny): Record<string, unknown> => {
  return zodToJsonSchema(schema, {
    target: "openAi",
    $refStrategy: "none",
  }) as Record<string, unknown>;
};

export const listRequiredFields = (
  jsonSchema: Record<string, unknown>,
): string[] => {
  const required = jsonSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((f): f is string => typeof f === "string");
};

export interface PrepareSchemaResult {
  ready: boolean;
  missing: string[];
  errors?: string;
  normalizedArgs?: Record<string, unknown>;
}

export const formatValidationResult = <T>(
  validation: ValidateArgsResult<T>,
  normalizedArgs?: Record<string, unknown>,
): PrepareSchemaResult => {
  if (validation.ok) {
    return {
      ready: true,
      missing: [],
      normalizedArgs: (validation.data ?? normalizedArgs) as Record<
        string,
        unknown
      >,
    };
  }
  return {
    ready: false,
    missing: validation.missing,
    errors: validation.error,
    normalizedArgs,
  };
};

export const validatePartialArgs = <T>(
  schema: z.ZodType<T>,
  raw: unknown,
): PrepareSchemaResult => {
  const validation = validateActionArgs(schema, raw);
  return formatValidationResult(
    validation,
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined,
  );
};
