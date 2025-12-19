// 
const Itinerary = require("../models/Itinerary");
const Trip = require("../models/Trip");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// REUSABLE - resilient Gemini client with RetryInfo & cooldown
let cooldownUntil = 0; // timestamp (ms)
let consecutive429 = 0;

function parseRetryDelay(err) {
  if (!err || !err.errorDetails) return null;
  for (const item of err.errorDetails) {
    // some error details embed retryDelay directly
    if (item && item.retryDelay) {
      const s = String(item.retryDelay);
      let ms = 0;
      const minMatch = s.match(/(\d+)m/);
      const secMatch = s.match(/(\d+)s/);
      if (minMatch) ms += parseInt(minMatch[1], 10) * 60000;
      if (secMatch) ms += parseInt(secMatch[1], 10) * 1000;
      if (ms > 0) return ms;
    }
    // Some error structures place RetryInfo in nested fields
    if (item && item['@type'] && item['@type'].includes('RetryInfo') && item.retryDelay) {
      const s = String(item.retryDelay);
      let ms = 0;
      const minMatch = s.match(/(\d+)m/);
      const secMatch = s.match(/(\d+)s/);
      if (minMatch) ms += parseInt(minMatch[1], 10) * 60000;
      if (secMatch) ms += parseInt(secMatch[1], 10) * 1000;
      if (ms > 0) return ms;
    }
  }
  return null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(prompt) {
  const MAX_RETRIES = 4;
  const BASE_DELAY = 1500;

  // if we are in cooldown due to repeated 429s, short-circuit
  if (Date.now() < cooldownUntil) {
    const err = new Error('Gemini is in cooldown due to quota errors');
    err.code = 'COOLDOWN';
    err.cooldownUntil = cooldownUntil;
    throw err;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      // success → reset counters
      consecutive429 = 0;
      return result.response.text();
    } catch (err) {
      console.error(`❌ Gemini attempt ${attempt} failed:`, err.message || err);

      // if 429, increment counter and possibly set cooldown
      if (err && err.status === 429) {
        consecutive429++;
        const suggested = parseRetryDelay(err) || 60000; // default cooldown 60s
        if (consecutive429 >= 2) {
          cooldownUntil = Date.now() + suggested;
          console.warn(`🚫 Activating Gemini cooldown for ${suggested}ms until ${new Date(cooldownUntil).toISOString()}`);
          const e = new Error('Quota exceeded - cooldown activated');
          e.code = 'COOLDOWN';
          e.cooldownUntil = cooldownUntil;
          throw e;
        }
      }

      if (attempt === MAX_RETRIES) throw err;

      const retryAfterMs = parseRetryDelay(err);
      const waitMs = retryAfterMs ?? (BASE_DELAY * attempt + Math.floor(Math.random() * 500));
      console.log(`⏱ Waiting ${waitMs}ms before retrying (attempt ${attempt + 1})`);
      await sleep(waitMs);
    }
  }
}

async function generateItineraryFn({
  tripId,
  destinations,
  startDate,
  endDate,
  budget,
  preferences,
}) {
  const prompt = `
Generate itinerary JSON:
Destinations: ${JSON.stringify(destinations)}
Start: ${startDate}
End: ${endDate}
Budget: ${budget}
Preferences: ${JSON.stringify(preferences)}

Output ONLY valid JSON:
{
  "title": "",
  "startDate": "",
  "endDate": "",
  "budget": "",
  "days": [],
  "transport": {},
  "stays": [],
  "packingList": [],
  "apps": []
}
`;

  try {
    // ⭐ Safe Gemini call with retry
    let aiText = await callGemini(prompt);

    // ⭐ CLEAN JSON OUTPUT
    let cleaned = aiText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .replace(/\*\*/g, "")
      .replace(/^[^{]*/, "") // remove everything before first {
      .replace(/[^}]*$/, ""); // remove everything after last }

    let itineraryJson;

    try {
      itineraryJson = JSON.parse(cleaned);
    } catch (err) {
      console.error("🔥 CLEANED JSON ERROR:", cleaned);
      throw new Error("AI returned invalid JSON");
    }

    // // ⭐ Save new itinerary
    // const savedItinerary = await new Itinerary({
    //   ...itineraryJson,
    //   destinations: destinations.map((d) => `${d.from} to ${d.to}`),
    // }).save();
    // ---- CLEAN APPS ----
// If Gemini returns objects → convert to strings
let apps = [];

if (Array.isArray(itineraryJson.apps)) {
  apps = itineraryJson.apps.map((item) => {
    if (typeof item === "string") return item; // already a string
    if (typeof item === "object" && item.name) return item.name; // convert {name, category..} → name
    return JSON.stringify(item); // fallback
  });
}

const savedItinerary = await new Itinerary({
  ...itineraryJson,
  apps,
  destinations: destinations.map(d => `${d.from} to ${d.to}`),
}).save();


    // ⭐ Link trip → itinerary
    if (tripId) {
      await Trip.findByIdAndUpdate(tripId, {
        itineraryId: savedItinerary._id,
      });
    }

    return savedItinerary;
  } catch (err) {
    console.error("❌ Final Itinerary Generation Error:", err);
    throw new Error("Itinerary generation failed");
  }
}

// export main generator and helpers
module.exports = generateItineraryFn;
module.exports.callGemini = callGemini;
module.exports.getCooldown = () => cooldownUntil;
module.exports.getConsecutive429 = () => consecutive429;
