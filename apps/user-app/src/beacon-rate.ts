/**
 * Client-side beacon backoff (ADR 0006, 0003). If the server rate-limits a guest, the beacon
 * must stop quietly for the advertised window instead of retrying every page view.
 */

export const BEACON_BACKOFF_KEY = "bulletin_beacon_retry_at";
export const BEACON_DEFAULT_BACKOFF_SECONDS = 60;

/** True while a previous `429` says the guest should not send another beacon yet. */
export function isBeaconBackedOff(value: string | null, now: number): boolean {
  const retryAt = Number(value);

  return Number.isFinite(retryAt) && retryAt > now;
}

/** Converts the endpoint's `retry-after` header into an absolute retry timestamp. */
export function beaconRetryAt(header: string | null, now: number): number {
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : BEACON_DEFAULT_BACKOFF_SECONDS;

  return now + delay * 1_000;
}
