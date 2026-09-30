import type { MockProvider, Split } from "../types.js";
import { billhub } from "./billhub.js";
import { emptyco } from "./emptyco.js";
import { helpline, stockroom, vaultbank } from "./heldout.js";
import { brightbooks, chargebolt, deskpoint, leasewise, pipeforce, shopwell, trackwell } from "./heldout-2026-09-28.js";
import { cashloom } from "./heldout-2026-09-29.js";
import { keyholder, marketlane, payrail } from "./heldout-2026-09-30.js";
import { ledgerline, quotient } from "./heldout-step3.js";
import { harborline } from "./heldout-step4.js";
import {
  catfact,
  dummyjsonCarts,
  dummyjsonProducts,
  jsonplaceholderTodos,
  openbrewerydb,
  pokeapiPokemon,
  rickandmortyCharacters,
  rickandmortyEpisodes,
} from "./real.js";
import { keyring } from "./keyring.js";
import { ledgerly } from "./ledgerly.js";
import { multicur } from "./multicur.js";
import { prosebook } from "./prosebook.js";
import { rentroll } from "./rentroll.js";
import { filterly, oauthco, searchy } from "./step3-dev.js";
import { sessionly, stampede } from "./step4-dev.js";
import { taskpad } from "./taskpad.js";
import { casebook, gazette } from "./track-a-dev.js";
import { archivist, depotline } from "./track-b-dev.js";
import { linkfold } from "./track-d-dev.js";

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
  casebook,
  gazette,
  depotline,
  archivist,
  linkfold,
  stockroom,
  helpline,
  vaultbank,
  quotient,
  ledgerline,
  /* Moved to dev on 2026-09-29: a unit written as a field (checkpoint 3, #9) was fixed from its outcome (PROTOCOL.md). */
  { ...harborline, split: "dev" as const },
  /* Moved to dev after checkpoint 4: silently wrong, and its log read to find why (PROTOCOL.md). */
  { ...shopwell, split: "dev" as const },
  deskpoint,
  brightbooks,
  leasewise,
  /* Moved to dev after checkpoint 3: its log was read to diagnose a silently wrong total (PROTOCOL.md). */
  { ...chargebolt, split: "dev" as const },
  /*
   * Chargebolt's replacement, written by the separate session. Moved to dev
   * after checkpoint 4: silently incomplete, and its log read to find why.
   */
  { ...cashloom, split: "dev" as const },
  trackwell,
  pipeforce,
  /* Replacements for harborline, shopwell and cashloom, written by the separate session and wired in unread (PROTOCOL.md). */
  payrail,
  marketlane,
  keyholder,
  dummyjsonProducts,
  dummyjsonCarts,
  jsonplaceholderTodos,
  rickandmortyCharacters,
  rickandmortyEpisodes,
  pokeapiPokemon,
  openbrewerydb,
  catfact,
];

export const providersIn = (split: Split): readonly MockProvider[] =>
  PROVIDERS.filter((provider) => provider.split === split);
