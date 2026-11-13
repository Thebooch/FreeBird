import { PhoneProviderError } from "@freebirdai/phone";

/** A Telnyx answer that was not a success, in its own words. */
export class TelnyxError extends PhoneProviderError {
  override readonly name: string = "TelnyxError";
  constructor(message: string, status: number, code?: string) {
    super(message, "Telnyx", status, code);
  }
}
