// The news deck's shape and parsing (app/apps/news/news-deck.ts). Pins the
// defensive-backstop behaviour at the boundary where the client trusts a
// GET /api/news/today response it did not itself produce, and the read-state
// key scoping that keeps the walk from re-narrating a card it already read.
const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeNewsCard, parseNewsDeck, newsReadKey } = require("../.test-build/app/apps/news/news-deck.js");

test("normalizeNewsCard keeps a well-formed card as-is", () => {
  const card = normalizeNewsCard(
    { id: "excise", headline: "A tax bill.", ghost: "Take.", why: "Why.", speak: "A tax bill, spoken." },
    0,
  );
  assert.deepEqual(card, {
    id: "excise",
    headline: "A tax bill.",
    ghost: "Take.",
    why: "Why.",
    speak: "A tax bill, spoken.",
  });
});

test("normalizeNewsCard drops a card with neither headline nor speak", () => {
  assert.equal(normalizeNewsCard({ id: "x", ghost: "Take.", why: "Why." }, 0), null);
  assert.equal(normalizeNewsCard(null, 0), null);
  assert.equal(normalizeNewsCard("not an object", 0), null);
});

test("normalizeNewsCard falls back headline<->speak and synthesizes an id", () => {
  const noHeadline = normalizeNewsCard({ speak: "Only spoken." }, 2);
  assert.equal(noHeadline.headline, "Only spoken.");
  assert.equal(noHeadline.id, "card-3");

  const noSpeak = normalizeNewsCard({ headline: "Only written." }, 0);
  assert.equal(noSpeak.speak, "Only written.");
});

test("normalizeNewsCard trims and tolerates missing ghost/why", () => {
  const card = normalizeNewsCard({ id: "  padded  ", headline: "  H  ", speak: "  S  " }, 0);
  assert.equal(card.id, "padded");
  assert.equal(card.headline, "H");
  assert.equal(card.speak, "S");
  assert.equal(card.ghost, "");
  assert.equal(card.why, "");
});

test("parseNewsDeck accepts a well-formed /api/news/today response", () => {
  const deck = parseNewsDeck({
    date: "2026-09-04",
    uuid: "news:2026-09-04:abc",
    cards: [
      { id: "a", headline: "A", ghost: "ga", why: "wa", speak: "sa" },
      { id: "b", headline: "B", ghost: "gb", why: "wb", speak: "sb" },
    ],
  });
  assert.ok(deck);
  assert.equal(deck.date, "2026-09-04");
  assert.equal(deck.uuid, "news:2026-09-04:abc");
  assert.equal(deck.cards.length, 2);
  assert.equal(deck.cards[0].id, "a");
});

test("parseNewsDeck drops unusable cards but keeps the usable ones", () => {
  const deck = parseNewsDeck({
    cards: [{ headline: "Keep me" }, { ghost: "no headline or speak" }, null, { speak: "Keep me too" }],
  });
  assert.ok(deck);
  assert.equal(deck.cards.length, 2);
});

test("parseNewsDeck returns null for a deck with no usable cards at all", () => {
  assert.equal(parseNewsDeck({ cards: [] }), null);
  assert.equal(parseNewsDeck({ cards: [{ ghost: "only a take" }] }), null);
});

test("parseNewsDeck returns null for a malformed response", () => {
  assert.equal(parseNewsDeck(null), null);
  assert.equal(parseNewsDeck({}), null);
  assert.equal(parseNewsDeck({ cards: "not an array" }), null);
});

test("parseNewsDeck synthesizes a uuid when the server omits one", () => {
  const deck = parseNewsDeck({ cards: [{ headline: "H", speak: "S" }] });
  assert.ok(deck.uuid.startsWith("news-"));
});

test("newsReadKey scopes by deck, card, and depth independently", () => {
  const a = newsReadKey("deck-1", "card-1", 0);
  const b = newsReadKey("deck-1", "card-1", 1);
  const c = newsReadKey("deck-2", "card-1", 0);
  const d = newsReadKey("deck-1", "card-2", 0);
  const keys = new Set([a, b, c, d]);
  assert.equal(keys.size, 4, "each of deck/card/depth must produce a distinct key");
});
