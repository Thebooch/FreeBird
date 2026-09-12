import {
  buildSchema, getOperationAST, getVariableValues, Kind, parse, validate,
  type GraphQLSchema, type SelectionSetNode, type FragmentDefinitionNode,
} from "graphql";
import { allowedHost, interpolate, type ConnectionSpec, type OpSpec } from "@freebirdai/dash-spec";
import { AdapterError, type FetchContext, type FetchResult, type SourceAdapter } from "./types.js";
import { applyRequestAuth } from "./auth.js";
import { queryCompleteness } from "./completeness.js";
import { firstPageParams, mergePages, nextPageParams, rowsAt } from "./paginate.js";
import type { HttpResponse } from "./rest.js";

export type GraphqlHttpFetch = (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }, host: string | null) => Promise<HttpResponse>;
const invalid = (message: string): never => { throw new AdapterError(message, { status: 400 }); };

/** Expand fragments for cost accounting; repeated spreads must not evade the limit. */
export const validateGraphqlRead = (schema: GraphQLSchema, text: string, operationName: string | undefined, maxDepth: number, maxFields: number) => {
  const document = parse(text, { maxTokens: 20000 });
  if (document.definitions.some(def => def.kind === Kind.OPERATION_DEFINITION && def.operation !== "query")) invalid("Only GraphQL queries are supported; mutations and subscriptions cannot be executed.");
  const errors = validate(schema, document);
  if (errors.length) invalid(errors.slice(0, 5).map(error => error.message).join(" "));
  const operation = getOperationAST(document, operationName);
  if (!operation || operation.operation !== "query") return invalid("Choose one named GraphQL query.");
  const fragments = new Map(document.definitions.filter((def): def is FragmentDefinitionNode => def.kind === Kind.FRAGMENT_DEFINITION).map(def => [def.name.value, def]));
  let fields = 0;
  const walk = (selection: SelectionSetNode, depth: number) => {
    if (depth > maxDepth) invalid("This query exceeds its depth limit.");
    for (const child of selection.selections) {
      if (child.kind === Kind.FIELD) {
        if (++fields > maxFields) invalid("This query exceeds its field complexity limit.");
        if (child.selectionSet) walk(child.selectionSet, depth + 1);
      } else if (child.kind === Kind.INLINE_FRAGMENT) walk(child.selectionSet, depth);
      else {
        const fragment = fragments.get(child.name.value);
        if (fragment) walk(fragment.selectionSet, depth);
      }
    }
  };
  walk(operation.selectionSet, 1);
  return operation;
};

export class GraphqlAdapter implements SourceAdapter {
  readonly kind = "graphql" as const;
  readonly transport = "proxy" as const;
  private schemas = new Map<string, GraphQLSchema>();
  constructor(private readonly http: GraphqlHttpFetch) {}

  async fetch(connection: ConnectionSpec, op: OpSpec, overrides: Readonly<Record<string, string | number | boolean>>, ctx: FetchContext): Promise<FetchResult> {
    const contract = op.graphql;
    if (!connection.baseUrl || !connection.graphqlSchema || !contract) return invalid("This GraphQL operation needs its schema and saved query configured.");
    if (op.authRequired || (op.auth === undefined && connection.authRequired && connection.auth.type === "none")) return invalid("This endpoint needs its authentication configured.");
    let schema = this.schemas.get(connection.graphqlSchema);
    if (!schema) {
      schema = buildSchema(connection.graphqlSchema);
      if (this.schemas.size >= 8) this.schemas.delete(this.schemas.keys().next().value!);
      this.schemas.set(connection.graphqlSchema, schema);
    }
    const operation = validateGraphqlRead(schema, contract.document, contract.operationName, contract.maxDepth, contract.maxFields);
    if (op.pagination.kind === "link-header") return invalid("GraphQL pagination must use declared variables, not HTTP link headers.");
    let variables: Record<string, unknown> = { ...contract.variables, ...ctx.params.filters, ...overrides };
    const pageParams = firstPageParams(op.pagination);
    for (const [name, value] of Object.entries(pageParams)) {
      if (variables[name] !== undefined && String(variables[name]) !== value) return invalid(`Pagination input ${name} conflicts with the saved query contract.`);
      const variable = operation.variableDefinitions?.find(item => item.variable.name.value === name);
      const type = variable?.type.kind === Kind.NON_NULL_TYPE ? variable.type.type : variable?.type;
      variables[name] = type?.kind === Kind.NAMED_TYPE && (type.name.value === "Int" || type.name.value === "Float") ? Number(value) : value;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(op.headers)) headers[name.toLowerCase()] = interpolate(value, ctx.params);
    const url = new URL(connection.baseUrl.replace(/\/$/, "") + (op.path === "/" ? "" : op.path.startsWith("/") ? op.path : `/${op.path}`));
    const query = new URLSearchParams();
    const redactedParam = await applyRequestAuth(op.auth ?? connection.auth, connection.title, ctx, headers, query);
    for (const [name, value] of query) url.searchParams.set(name, value);
    const safeUrl = new URL(url);
    if (redactedParam) safeUrl.searchParams.set(redactedParam, "***");
    const pages: unknown[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    let truncated = false;
    for (let page = 0; page < op.maxPages; page++) {
      ctx.signal?.throwIfAborted();
      const variableNames = new Set(operation.variableDefinitions?.map(item => item.variable.name.value));
      if (Object.keys(variables).some(name => !variableNames.has(name))) return invalid("The query received an undeclared variable.");
      const checked = getVariableValues(schema, operation.variableDefinitions ?? [], variables);
      if (checked.errors) return invalid(checked.errors.map(error => error.message).join(" "));
      const signature = JSON.stringify(checked.coerced);
      if (seen.has(signature)) { truncated = true; warnings.push("The pagination cursor repeated."); break; }
      seen.add(signature);
      let response: HttpResponse;
      try {
        response = await this.http(url.toString(), { headers, body: JSON.stringify({ query: contract.document, operationName: contract.operationName, variables: checked.coerced }), signal: ctx.signal }, allowedHost(connection));
      } catch {
        throw new AdapterError("The GraphQL endpoint could not be reached.");
      }
      if (response.status >= 400) throw new AdapterError(`GraphQL request failed (${response.status}).`, { status: response.status, retryAfter: response.header("retry-after") ?? undefined });
      let body: unknown;
      try { body = JSON.parse(response.text); } catch { throw new AdapterError("The GraphQL endpoint returned invalid JSON."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdapterError("The GraphQL response has no result object.");
      const result = body as { data?: unknown; errors?: unknown };
      if (result.data === undefined || result.data === null) throw new AdapterError("The GraphQL query did not return usable data.");
      pages.push(body);
      if (Array.isArray(result.errors) && result.errors.length) { truncated = true; warnings.push("The API returned partial data with GraphQL field errors."); break; }
      if (op.pagination.kind === "none") break;
      if (rowsAt(body, op.rowsPath) === null) { truncated = true; warnings.push("The declared record list is missing."); break; }
      const next = nextPageParams({ pagination: op.pagination, body, rowsPath: op.rowsPath, pageIndex: page + 1 });
      if (next.kind === "none") break;
      if (next.kind === "link-header") return invalid("GraphQL pagination must use declared variables, not HTTP link headers.");
      if (page + 1 >= op.maxPages) { truncated = true; warnings.push("The query reached its page limit."); break; }
      variables = { ...variables, ...next.params };
      for (const [name, value] of Object.entries(next.params)) {
        const variable = operation.variableDefinitions?.find(item => item.variable.name.value === name);
        const type = variable?.type.kind === Kind.NON_NULL_TYPE ? variable.type.type : variable?.type;
        if (type?.kind === Kind.NAMED_TYPE && (type.name.value === "Int" || type.name.value === "Float")) variables[name] = Number(value);
      }
    }
    return {
      body: pages.length === 1 ? pages[0] : mergePages(pages, op.rowsPath, warnings),
      meta: { url: safeUrl.toString(), status: 200, fetchedAt: ctx.now, durationMs: Date.now() - ctx.now, pages: pages.length, truncated, warnings,
        completeness: queryCompleteness({ pagination: op.pagination, lastBody: pages[pages.length - 1], rowsPath: op.rowsPath, truncated, paginationPending: connection.paginationPending, warnings }),
      },
    };
  }
}
