import { useEffect, useState } from "react";
import { api } from "../../../api.js";
import type { FieldOption } from "./model.js";

/**
 * The contact fields this workspace has set up, as `contact.<key>` paths for
 * the rule builder and grouping, with each one's trust and choices. Empty
 * until they load, and when they can't be read: the editors still take any
 * path typed.
 */
export const useContactFields = (): readonly FieldOption[] => {
  const [fields, setFields] = useState<readonly FieldOption[]>([]);
  useEffect(() => {
    let live = true;
    void api.contactSetup().then(
      (setup) =>
        live &&
        setFields(
          setup.fields.map((def) => ({
            path: `contact.${def.key}`,
            label: `Contact: ${def.label.toLowerCase()}`,
            trust: def.trust,
            ...(def.kind === "choice" && def.choices ? { choices: def.choices } : def.kind === "boolean" ? { choices: ["true", "false"] } : {}),
          })),
        ),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return fields;
};
