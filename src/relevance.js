// Strict topic filter for news: a story must be about trading cards (TCG) AND about one of the
// games/sports we cover (Pokémon, One Piece, baseball, basketball). Video game, anime, movie or
// general sports news doesn't count.

const TOPICS = {
  pokemon: /pok[eé]mon|pikachu|charizard|mewtwo|umbreon|eevee|scarlet\s*&?\s*violet|mega evolution/i,
  onepiece: /one\s*piece|luffy|zoro|\bnami\b|shanks|straw hat/i,
  baseball: /baseball|\bmlb\b|topps|bowman|ohtani|mickey mantle|aaron judge|world series/i,
  basketball: /basketball|\bnba\b|\bwnba\b|panini|prizm|hoops|donruss|lebron|wembanyama|jordan/i,
};

// Words that show the story is about cards, not the game/anime/sport itself. Kept to words that
// only make sense for cards ("expansion", "pack" or "promo" alone also match video game news).
const CARDS =
  /\b(cards?|trading cards?|tcg|ccg|booster|elite trainer|etb|psa|bgs|cgc|sgc|graded|grading|slabs?|rookie cards?|autograph(ed)?|parallels?|refractors?|illustration rare|full art|secret rare|hobby box|blaster box)\b/i;

// Other sports and card games we don't cover. A story about these is skipped unless it also clearly
// says baseball/basketball (e.g. "Topps" alone could be football or soccer).
const OTHER_SPORTS = /\b(football|nfl|soccer|mls|premier league|hockey|nhl|ufc|wwe|f1|formula 1|nascar|golf|tennis|cricket)\b/i;

/**
 * Is this item about Pokémon / One Piece / baseball / basketball trading cards?
 * A feed can declare what it's always about (e.g. r/PokemonTCG is always Pokémon cards)
 * with "impliedTopic" and "impliedCards" in feeds.json.
 */
function isRelevant(item, feed = {}) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const topic = feed.impliedTopic || Object.keys(TOPICS).find((k) => TOPICS[k].test(text));
  const cards = feed.impliedCards || CARDS.test(text);
  if (!topic || !cards) return false;
  if (OTHER_SPORTS.test(text) && !/baseball|basketball|\bmlb\b|\bnba\b|\bwnba\b/i.test(text)) return false;
  return true;
}

module.exports = { isRelevant, TOPICS, CARDS, OTHER_SPORTS };
