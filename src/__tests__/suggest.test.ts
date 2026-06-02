import assert from "node:assert/strict";
import test from "node:test";
import { expandSeedQueries, fetchAutocomplete } from "../suggest.js";
import type { FetchLike } from "../suggest.js";

function stubFetch(body: string, ok = true): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return { ok, text: async () => body };
  };
  return { fetchImpl, urls };
}

test("fetchAutocomplete parses the firefox-format suggestion array", async () => {
  const body = JSON.stringify([
    "furnace blowing cold air",
    [
      "furnace blowing cold air",
      "furnace blowing cold air after power outage",
      "furnace blowing cold air no heat",
    ],
  ]);
  const { fetchImpl, urls } = stubFetch(body);

  const suggestions = await fetchAutocomplete("furnace blowing cold air", { fetchImpl });

  assert.deepEqual(suggestions, [
    "furnace blowing cold air",
    "furnace blowing cold air after power outage",
    "furnace blowing cold air no heat",
  ]);
  assert.ok(
    urls[0]!.includes("suggestqueries.google.com") &&
      urls[0]!.includes("furnace%20blowing%20cold%20air"),
    "should hit the keyless suggest endpoint with the url-encoded query",
  );
});

test("fetchAutocomplete returns [] on a network error (never throws)", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const suggestions = await fetchAutocomplete("ac repair", { fetchImpl });
  assert.deepEqual(suggestions, []);
});

test("fetchAutocomplete returns [] on a non-ok response", async () => {
  const { fetchImpl } = stubFetch("rate limited", false);
  const suggestions = await fetchAutocomplete("ac repair", { fetchImpl });
  assert.deepEqual(suggestions, []);
});

test("fetchAutocomplete returns [] when the body is not valid JSON", async () => {
  const { fetchImpl } = stubFetch("<html>blocked</html>");
  const suggestions = await fetchAutocomplete("ac repair", { fetchImpl });
  assert.deepEqual(suggestions, []);
});

test("expandSeedQueries includes the topic, a local query, and question/intent prefixes", () => {
  const seeds = expandSeedQueries("heat pump vs furnace", ["heat pump", "furnace"], "Sacramento");

  assert.ok(seeds.includes("heat pump vs furnace"), "includes the raw topic");
  assert.ok(
    seeds.some((s) => s.includes("Sacramento")),
    "includes a locally-modified query",
  );
  assert.ok(
    seeds.some((s) => s.startsWith("how to") || s.startsWith("cost to") || s.startsWith("why")),
    "includes at least one intent-prefixed query",
  );
  assert.equal(new Set(seeds).size, seeds.length, "seeds are deduplicated");
  assert.ok(seeds.length <= 8, "seed count is capped to keep fetches bounded");
});
