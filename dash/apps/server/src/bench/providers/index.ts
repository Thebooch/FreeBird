import type { MockProvider, Split } from "../types.js";
import { billhub } from "./billhub.js";
import { emptyco } from "./emptyco.js";
import { helpline, stockroom, vaultbank } from "./heldout.js";
import { ledgerline, quotient } from "./heldout-step3.js";
import { harborline } from "./heldout-step4.js";
import { keyring } from "./keyring.js";
import { ledgerly } from "./ledgerly.js";
import { multicur } from "./multicur.js";
import { prosebook } from "./prosebook.js";
import { rentroll } from "./rentroll.js";
import { filterly, oauthco, searchy } from "./step3-dev.js";
import { sessionly, stampede } from "./step4-dev.js";
import { taskpad } from "./taskpad.js";

/** Every mock provider. The split is on each one, and never changes quietly — see PROTOCOL.md. */
export const PROVIDERS: readonly MockProvider[] = [
  ledgerly,
  taskpad,
  rentroll,
  emptyco,
  prosebook,
  multicur,
  billhub,
  keyring,
  searchy,
  oauthco,
  filterly,
  sessionly,
  stampede,
  stockroom,
  helpline,
  vaultbank,
  quotient,
  ledgerline,
  harborline,
];

export const providersIn = (split: Split): readonly MockProvider[] =>
  PROVIDERS.filter((provider) => provider.split === split);
