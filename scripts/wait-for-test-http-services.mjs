const mailpitUrl = new URL(
  process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025",
);
const registryUrl = new URL(
  process.env.LOCAL_NPM_REGISTRY ?? "http://127.0.0.1:4873/",
);
const localHosts = ["localhost", "127.0.0.1", "::1"];

function assertLocalHttpUrl(url, name) {
  if (
    url.protocol !== "http:" ||
    !localHosts.includes(url.hostname.replace(/^\[|\]$/g, "").toLowerCase())
  ) {
    throw new Error(`${name} must be a loopback HTTP URL.`);
  }
}

assertLocalHttpUrl(mailpitUrl, "MAILPIT_API_URL");
assertLocalHttpUrl(registryUrl, "LOCAL_NPM_REGISTRY");

async function waitFor(name, url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`${name} did not become ready within 30 seconds${detail}.`);
}

await Promise.all([
  waitFor("Mailpit", new URL("/api/v1/info", mailpitUrl)),
  waitFor("Verdaccio", new URL("-/ping", registryUrl)),
]);
process.stdout.write("Mailpit and Verdaccio are ready.\n");
