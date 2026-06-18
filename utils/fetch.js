// Shared fetch with an abort timeout. A slow or unresponsive upstream must
// never hang a whole screening/management cycle — every network call gets a
// bounded timeout. Pass timeoutMs <= 0 or non-finite to opt out (plain fetch).

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}
