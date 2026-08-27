import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import type { AuthContext, LlmAdapter } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import {
  compileServerRegistry,
  parseManifest,
  type RegistrationManifest,
} from "@freebirdai/manifest";
import { createFreeBirdRouter } from "@freebirdai/server/express";

/**
 * A minimal multi-tenant FreeBird backend for the static-embed demo.
 *
 * Two "sites" share one process. Each request resolves its own registry
 * (compiled from that site's manifest) and — in a real deployment — its own
 * LLM key. This is the same wiring FreeBird Studio's managed backend uses,
 * shrunk to one file.
 *
 * The LLM here is a canned offline echo so the demo runs with no API key.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);

// ── Per-site manifests (Studio would store these; here they're inline). ──────
const siteManifests: Record<string, RegistrationManifest> = {
  fb_bakery: parseManifest({
    version: 1,
    siteId: "fb_bakery",
    components: [
      {
        id: "openingHours",
        title: "Opening hours",
        description: "Bella's Bakery weekly opening hours.",
        kind: "dom-region",
        source: { selector: "#hours" },
        actions: [
          { id: "show_hours", description: "Scroll the visitor to the opening hours", kind: "local-dom", directive: "scroll-to" },
        ],
      },
      {
        id: "orderForm",
        title: "Cake order form",
        description: "Order a custom cake.",
        kind: "dom-region",
        source: { selector: "#order" },
        actions: [
          { id: "highlight_order", description: "Highlight the order form", kind: "local-dom", directive: "highlight" },
        ],
      },
    ],
    // Site-wide knowledge (what Studio's site ingestion produces): first-class
    // items with stable ids and page/section provenance, citable via
    // [[cite:<id>]] — clicking the chip deep-links to the source section.
    knowledge: [
      {
        id: "kb_parking01",
        title: "Parking",
        text: "Free parking is available behind the building, including two accessible spots.",
        source: { page: "/about.html", selector: "#parking", heading: "Parking" },
        origin: "ingested",
      },
      {
        // Page-only provenance — no section anchor; the chip lands on the page.
        id: "kb_delivery01",
        title: "Delivery",
        text: "We deliver cakes within the city on Fridays and Saturdays.",
        source: { page: "/about.html" },
        origin: "ingested",
      },
    ],
  }),
  // A second tenant proves isolation — different components entirely.
  fb_garage: parseManifest({
    version: 1,
    siteId: "fb_garage",
    components: [
      {
        id: "bookingForm",
        title: "Service booking",
        description: "Book a car service.",
        kind: "dom-region",
        source: { selector: "#book" },
      },
    ],
  }),
};

// Latest DOM snapshots posted by each site's embed, keyed "siteId:componentId".
const snapshots = new Map<string, unknown>();

// ── Offline echo LLM (no API key needed). ────────────────────────────────────
// Scripted answers for knowledge questions demonstrate the citation flow end
// to end (marker → chip → navigate → highlight) without a real model.
const echoReply = (messages: ReadonlyArray<{ role: string; content: string }>): string => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const asked = lastUser?.content.toLowerCase() ?? "";
  if (asked.includes("parking") || asked.includes("park")) {
    return "Yes — free parking is available behind the building, including two accessible spots. [[cite:kb_parking01]]";
  }
  if (asked.includes("deliver")) {
    return "We deliver cakes within the city on Fridays and Saturdays. [[cite:kb_delivery01]]";
  }
  if (asked.includes("hour") || asked.includes("open")) {
    return "We're open Mon–Fri 7:00–15:00, Saturday 8:00–13:00, closed Sundays. [[cite:openingHours]]";
  }
  return (
    `Thanks for your message${lastUser ? `: "${lastUser.content.slice(0, 80)}"` : ""}. ` +
    `This is the offline demo assistant — try asking about parking, delivery, or opening hours.`
  );
};

const echoLlm: LlmAdapter = {
  defaultModel: "echo",
  async *stream(opts) {
    for (const word of echoReply(opts.messages).split(" ")) {
      yield { textDelta: word + " " };
    }
  },
  async generate(opts) {
    return { text: echoReply(opts.messages), toolCalls: [] };
  },
};

// ── Per-tenant registry cache via the compiler. ──────────────────────────────
const registryFor = (siteId: string) => {
  const manifest = siteManifests[siteId];
  if (!manifest) throw new Error(`unknown site "${siteId}"`);
  return compileServerRegistry<unknown>(manifest, {
    getSnapshot: (componentId) => snapshots.get(`${siteId}:${componentId}`) ?? null,
  });
};

const app = express();
app.use(express.json({ limit: "1mb" }));

// Handshake: the embed sends its scanned manifest; we (would) validate origin,
// store it, and return a session token. Here the token IS the site id.
app.post("/v1/sites/:siteId/handshake", (req, res) => {
  const { siteId } = req.params;
  if (!siteManifests[siteId]) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  res.json({ token: siteId });
});

// Snapshots: store the latest per component for the LLM's dataSource.
app.post("/v1/sites/:siteId/snapshots", (req, res) => {
  const { siteId } = req.params;
  const list = Array.isArray(req.body?.snapshots) ? req.body.snapshots : [];
  for (const snap of list) {
    if (snap?.componentId) snapshots.set(`${siteId}:${snap.componentId}`, snap);
  }
  res.status(204).end();
});

// Mount FreeBird with a per-tenant registry resolver. The tenant comes from the
// Bearer token the embed got at handshake.
const router = createFreeBirdRouter({
  db: createMemoryDb(),
  llm: echoLlm,
  citations: { enabled: true },
  registry: (auth: AuthContext) => registryFor(auth.orgId ?? "fb_bakery"),
  getAuthContext: (request) => {
    const req = request as express.Request;
    const authz = String(req.headers["authorization"] ?? "");
    const token = authz.replace(/^Bearer\s+/i, "").trim();
    return token ? { orgId: token } : { orgId: "fb_bakery" };
  },
});
app.use("/freebird", router as unknown as express.Router);

// Serve the built embed bundle and the static site.
app.get("/freebird-embed.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(join(__dirname, "../../packages/embed/dist/freebird.js"));
});
app.use(express.static(join(__dirname, "public")));

app.listen(PORT, () => {
   
  console.log(`static-embed demo on http://localhost:${PORT} (sites: ${Object.keys(siteManifests).join(", ")})`);
});
