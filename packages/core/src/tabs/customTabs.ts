import type { DbAdapter } from "../adapters/db.js";
import type { AuthContext, CustomTab, DigestConfig, LayoutPlan } from "../types.js";

/**
 * Ensure a layout is fully locked before saving it as a custom tab.
 * Saved tabs are, by invariant, frozen — unlocked cells would create
 * ambiguous digest semantics ("summarize what exactly?").
 */
const lockLayout = (layout: LayoutPlan): LayoutPlan => ({
  gridCols: layout.gridCols,
  cells: layout.cells.map((c) => ({ ...c, locked: true })),
});

export interface SaveCustomTabInput {
  title: string;
  slug?: string;
  layout: LayoutPlan;
  digest?: DigestConfig;
}

export class CustomTabsService {
  constructor(private readonly db: DbAdapter) {}

  async save(input: SaveCustomTabInput, auth: AuthContext): Promise<CustomTab> {
    return this.db.createTab(
      {
        title: input.title,
        slug: input.slug ?? slugify(input.title),
        layout: lockLayout(input.layout),
        digest: input.digest,
      },
      auth,
    );
  }

  async list(auth: AuthContext): Promise<CustomTab[]> {
    return this.db.listTabs(auth);
  }

  async get(id: string, auth: AuthContext): Promise<CustomTab | null> {
    return this.db.getTab(id, auth);
  }

  async rename(id: string, title: string, auth: AuthContext): Promise<CustomTab> {
    return this.db.updateTab(id, { title, slug: slugify(title) }, auth);
  }

  async replaceLayout(id: string, layout: LayoutPlan, auth: AuthContext): Promise<CustomTab> {
    return this.db.updateTab(id, { layout: lockLayout(layout) }, auth);
  }

  async setDigest(
    id: string,
    digest: DigestConfig | null,
    auth: AuthContext,
  ): Promise<CustomTab> {
    return this.db.updateTab(id, { digest }, auth);
  }

  async remove(id: string, auth: AuthContext): Promise<void> {
    await this.db.deleteTab(id, auth);
  }
}

export const createCustomTabsService = (db: DbAdapter): CustomTabsService =>
  new CustomTabsService(db);

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tab";
