/**
 * Redaction for a scenario saved from a real case: the people in it become
 * stand-ins before it is kept. The same value always becomes the same
 * stand-in within one scenario, so a check that names the sender still finds
 * the sender's stand-in. Keys, numbers that look like accounts and secrets in
 * links are masked; words stay, since a case's words are what it tests.
 *
 * It is a best effort on what looks like an address, a phone number or an
 * account number, plus the names the case says belong to its people. A
 * person still reads a saved scenario before sharing it anywhere: scenarios
 * stay in the workspace.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A phone number written the usual ways: +15125550142, (512) 555-0142, 512.555.0142. Never a date or a time. */
const PHONE = /\+\d{8,15}|(?<![\d-])\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\d-])/g;
/** Twelve or more digits in a row: a card, an account, a routing number. */
const ACCOUNT = /\b\d{12,19}\b/g;
const SECRET_PARAM = /([?&](?:api[_-]?key|key|token|access[_-]?token|secret|signature|sig|code)=)[^&\s"']+/gi;

export class Redactor {
  private readonly emails = new Map<string, string>();
  private readonly phones = new Map<string, string>();
  private readonly names = new Map<string, string>();

  /** Names to replace wherever they appear: the case's contact and sender names. */
  constructor(names: readonly string[] = []) {
    for (const name of names) this.name(name);
  }

  private name(raw: string): string {
    const name = raw.trim();
    if (name.length < 3 || name.includes("@")) return raw;
    let stand = this.names.get(name.toLowerCase());
    if (!stand) {
      stand = `Person ${this.names.size + 1}`;
      this.names.set(name.toLowerCase(), stand);
    }
    return stand;
  }

  text(value: string): string {
    let out = value
      .replace(SECRET_PARAM, "$1REDACTED")
      .replace(EMAIL, (email) => {
        const key = email.toLowerCase();
        let stand = this.emails.get(key);
        if (!stand) {
          stand = `person${this.emails.size + 1}@example.com`;
          this.emails.set(key, stand);
        }
        return stand;
      })
      .replace(ACCOUNT, (digits) => `${"0".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4).replace(/\d/g, "0")}`)
      .replace(PHONE, (phone) => {
        const key = phone.replace(/\D/g, "");
        if (key.length < 8) return phone;
        let stand = this.phones.get(key);
        if (!stand) {
          stand = `+1555010${String(this.phones.size + 1).padStart(4, "0")}`;
          this.phones.set(key, stand);
        }
        return stand;
      });
    for (const [name, stand] of this.names) out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), stand);
    return out;
  }

  /** Every string in a value, redacted; the shape kept. Keys that hold a name are replaced whole. */
  value<T>(value: T, key = ""): T {
    if (typeof value === "string") return (/^(name|fullName|firstName|lastName|displayName)$/i.test(key) ? this.name(value) : this.text(value)) as T;
    if (Array.isArray(value)) return value.map((one) => this.value(one, key)) as T;
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.value(v, k)])) as T;
    return value;
  }
}
