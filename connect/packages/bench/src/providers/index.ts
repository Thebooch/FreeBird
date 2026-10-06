import type { MockProvider, Split } from "../types.js";
import { archivist } from "./archivist.js";
import { billhub } from "./billhub.js";
import { casebook } from "./casebook.js";
import { depotline } from "./depotline.js";
import { drawnhub } from "./drawnhub.js";
import { emptyco } from "./emptyco.js";
import { filterly } from "./filterly.js";
import { gazette } from "./gazette.js";
import { helpline, stockroom, vaultbank } from "./heldout.js";
import { brightbooks, chargebolt, deskpoint, leasewise, pipeforce, shopwell, trackwell } from "./heldout-2026-09-28.js";
import { cashloom } from "./heldout-2026-09-29.js";
import { keyholder, marketlane, payrail } from "./heldout-2026-09-30.js";
import { staffnest } from "./heldout-2026-10-03.js";
import { harborline } from "./heldout-harborline.js";
import { ledgerline, quotient } from "./heldout-ledgerline-quotient.js";
import { keyring } from "./keyring.js";
import { ledgerly } from "./ledgerly.js";
import { linkfold } from "./linkfold.js";
import { longhaul } from "./longhaul.js";
import { multicur } from "./multicur.js";
import { oauthco } from "./oauthco.js";
import { postline } from "./postline.js";
import { prosebook } from "./prosebook.js";
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
import { rentroll } from "./rentroll.js";
import { searchy } from "./searchy.js";
import { sessionly } from "./sessionly.js";
import { stampede } from "./stampede.js";
import { taskpad } from "./taskpad.js";
import { twofold } from "./twofold.js";
import { workroom } from "./workroom.js";

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
  twofold,
  postline,
  workroom,
  longhaul,
  drawnhub,
  stockroom,
  helpline,
  vaultbank,
  quotient,
  ledgerline,
  /* Moved to dev on 2026-09-29: a unit written as a field was fixed from its outcome line (PROTOCOL.md). */
  { ...harborline, split: "dev" as const },
  /* Moved to dev after checkpoint 4: silently wrong, and its log read to find why (PROTOCOL.md). */
  { ...shopwell, split: "dev" as const },
  deskpoint,
  brightbooks,
  leasewise,
  /* Moved to dev after checkpoint 3: its log was read to diagnose a silently wrong total (PROTOCOL.md). */
  { ...chargebolt, split: "dev" as const },
  /*
   * Chargebolt's replacement, written by a separate author. Moved to dev after
   * checkpoint 4: silently incomplete, and its log read to find why.
   */
  { ...cashloom, split: "dev" as const },
  /* Moved to dev after checkpoint 7: silently incomplete, and its files read to find why (PROTOCOL.md). */
  { ...trackwell, split: "dev" as const },
  pipeforce,
  /* Replacements for harborline, shopwell and cashloom, written by a separate author and wired in unread (PROTOCOL.md). */
  payrail,
  marketlane,
  keyholder,
  /* Trackwell's replacement, written by a separate author and wired in unread (PROTOCOL.md). */
  staffnest,
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
