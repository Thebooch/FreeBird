/**
 * Everything a host that serves the engine itself reaches for: the catalog
 * and vault, discovery, the broker, the stores' interfaces, the query and
 * integration helpers. `createConnect` (the package root) is the way in for
 * everybody else; this is the way in for a host like FreeBird Dash and for
 * the add-on packages.
 *
 * One entry point rather than a path per module, so the files behind it can
 * move without breaking anybody.
 */
export { CredentialBroker, pkcePair, signInAddressAllowed, vaultApps } from "./auth/broker.js";
export type { OAuthAppRegistry } from "./auth/broker.js";
export { MemoryCredentialMetaStore } from "./auth/credential-meta.js";
export type { CredentialMeta, CredentialMetaStore } from "./auth/credential-meta.js";
export { OAuthRetryAdapter, RateLimitWaitAdapter } from "./auth/retry-adapter.js";
export { waitPhrase } from "./cache/cooldown.js";
export { Priority } from "./cache/gate.js";
export { MemoryCacheStore } from "./cache/memory.js";
export { QueryCache, clampMaxAge } from "./cache/queryCache.js";
export type { CacheStore } from "./cache/store.js";
export { analyseConnection, analyseStructure, estimateEnumeration, findFilterParam, fromReport, toReport, withVerifiedParams } from "./capabilities.js";
export type { AnalyseOptions, SampleFn } from "./capabilities.js";
export { CatalogStore, connectionFromCatalog, refreshCatalogConnection } from "./catalog.js";
export type { ConnectionRepository } from "./connections.js";
export { ConnectorAdapter, connectorHash } from "./connector/adapter.js";
export { MemoryConnectorTokens } from "./connector/host.js";
export type { ConnectorTokenStore } from "./connector/host.js";
export { DEFAULT_LIMITS, SandboxError } from "./connector/sandbox.js";
export type { ConnectorSandbox, SandboxHost, SandboxLimits, SandboxSession } from "./connector/sandbox.js";
export { AUTO_INDEX_PAGES, RENDERER_DOWNLOAD_MB, discover, readIndex } from "./discovery/index.js";
export type { DocsRenderer, RendererSetup, RendererStatus } from "./discovery/index.js";
export { refreshOutdatedConnectDetails, withConnectDetails } from "./discovery/connect-details.js";
export { analysePage, endpointsNamed } from "./discovery/docs.js";
export { extractInlineSpec } from "./discovery/inline-spec.js";
export { looksLikeOpenApi, parseOpenApi, parseSpecDocument } from "./discovery/openapi.js";
export { nextAddressPaths, probePagination } from "./discovery/probe-pagination.js";
export { searchFromEnv } from "./discovery/search.js";
export type { SearchProvider } from "./discovery/search.js";
export { driftBetween, driftFields, driftNote, likelyRenames, shapeOf } from "./drift/detect.js";
export type { AcceptedShape, Drift } from "./drift/detect.js";
export { MemoryShapeStore } from "./drift/store.js";
export type { OpenDrift, ShapeStore } from "./drift/store.js";
export { createEngine, nodeHttp } from "./engine.js";
export { EVIDENCE_PER_OP, MemoryEvidenceStore, scopedEvidence } from "./evidence/store.js";
export type { EvidenceStore } from "./evidence/store.js";
export { EACH_MAX, eachKey } from "./fanout/each.js";
export type { EachRequest } from "./fanout/each.js";
export { integrate } from "./integrate/agent.js";
export { authorConnector, connectorReader } from "./integrate/connector.js";
export type { ConnectorKit } from "./integrate/connector.js";
export { docsKnowledge } from "./integrate/docs.js";
export { inputSources, namedInRequest } from "./integrate/inputs.js";
export { observedShape, withAddedReads, withEntryResources, withObservedFields } from "./integrate/observed.js";
export { applyPatch, sameSite, siteOf } from "./integrate/patch.js";
export { budgetOf, tryRead } from "./integrate/read.js";
export { createIntegrationRunner, integrationTargets, samplingTargets } from "./integrate/runner.js";
export type { IntegrateRouteDeps, IntegrationRunner } from "./integrate/runner.js";
export { seekRecords } from "./integrate/seek.js";
export { isProving } from "./integrate/templates.js";
export { seenByRecordType, seenValues } from "./integrate/values.js";
export type { SeenSet } from "./integrate/values.js";
export { CheckQueue } from "./jobs/check-queue.js";
export { LongReads, longReadId } from "./jobs/long-reads.js";
export type { LongReadDeps } from "./jobs/long-reads.js";
export { MemoryJobStore, matches, ordered } from "./jobs/store.js";
export type { Job, JobFilter, JobStore, RowCipher } from "./jobs/store.js";
export { writeJsonAtomic } from "./json-file.js";
export { FAILURE_BACKOFF_MS, Keeper, LastSeen, retryAfterMs } from "./keeper/keeper.js";
export type { RefreshOutcome, WarmTarget } from "./keeper/keeper.js";
export { decideAll, hasRhythm, mergeApiRhythm, opsOfResource } from "./keeper/rhythm.js";
export { describeCatalogRecords, describeMissingRecords, entityState, mapState, mergeDescribedEntities, mergeRefreshedOps, mergeRelations, schemaMoved, withDeclaredValues } from "./map.js";
export type { MapRouteDeps } from "./map.js";
export { openMcpClient, rpcAnswerIn } from "./mcp/client.js";
export { discoverMcp, looksLikeMcpAddress, readGround, toolOps } from "./mcp/discover.js";
export { MemoryLeaseLock } from "./platform/lease.js";
export type { LeaseLock } from "./platform/lease.js";
export type { EngineStores } from "./platform/stores.js";
export { buildQueryRequest, resolveRequestedRange, splitOpInputs } from "./query.js";
export { fromRegistry, httpRegistry, registryIndex, syncRegistry } from "./registry/registry.js";
export { RhythmStore } from "./rhythm-store.js";
export { BlockedUrlError, allowlistEgress, assertAllowedHost, assertPublicHttpUrl, configureEgress, fetchPublicDocument, guardedFetch, isPrivateIp } from "./safe-fetch.js";
export { MemorySeenValueStore } from "./values/store.js";
export type { SeenValueStore } from "./values/store.js";
export { KeyStore, LocalAesVault } from "./vault.js";
export type { SecretRepository } from "./vault.js";
export { MAX_VALIDATION_CANDIDATES, catalogEntryToVerify, rowsFromBody, usableRows, validationCandidates } from "./verified.js";
export { VERIFY_BUDGET_DEFAULT, VERIFY_BUDGET_MAX, verifyRecords } from "./verify-records.js";
export { Discovered, catalogForBrowser, preservedWrites } from "./writes/catalog-writes.js";
export { MemoryJournal, nullJournal } from "./writes/journal.js";
export type { ReadEvent, WriteEvent, WriteJournal, WriteOnBehalfOf, WriteReversal, WriteVia } from "./writes/journal.js";
export { createRecordReader, freshness } from "./read.js";
export type { ReadRequest, ReadResult, RecordReader, RecordReaderDeps } from "./read.js";
export type { WriteIntent, WriteReview } from "./writes/pending.js";
export { WriteEndpointReader, readWriteEndpoints } from "./writes/read-writes.js";
export type { FetchDocument } from "./writes/read-writes.js";
export { WriteError, WriteService, describeFields } from "./writes/service.js";
export type { CommitResult } from "./writes/service.js";
export type { PolicyDecision, WriteActor, WritePermission, WritePolicy, WriteScope } from "./writes/policy.js";
export { DriftWatch, type DriftWatchDeps } from "./drift/watch.js";
export type { EngineReadInput, EngineReadResult } from "./engine.js";
