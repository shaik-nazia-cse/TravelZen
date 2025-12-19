// --- MODULES & SETUP ---
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Load environment variables FIRST
dotenv.config();

// Import DB connection & routes
const connectDB = require("./db/connect");
const authRoutes = require("./routes/auth");
const tripRoutes = require("./routes/trips");
const budgetTripRoutes = require("./routes/budgetTrips");
const journalRoutes = require("./routes/journal");
const preferenceRoutes = require("./routes/preferenceRoutes");
const memoryRoutes = require("./routes/memory");
const itineraryRoutes = require("./routes/itineraryRoutes"); // ✅ Existing route
const Itinerary = require("./models/Itinerary"); // ✅ Added model import
const generateItineraryFn = require("./utils/generateItenary"); // reusable generator with backoff & cooldown
const userProfileRoutes = require("./routes/userRoutes.js");

// Initialize Express app
const app = express();

// --- GEMINI AI SETUP ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ ERROR: GEMINI_API_KEY not set in environment variables.");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- DATABASE CONNECTION ---
connectDB();

// --- AI ITINERARY CONTROLLER ---
const generateItinerary = async (req, res) => {
  const { tripId, destinations, startDate, endDate, budget, preferences } = req.body;

  try {
    // Use the shared utility which includes retries and safer JSON handling
    const newItinerary = await generateItineraryFn({
      tripId,
      destinations,
      startDate,
      endDate,
      budget,
      preferences,
    });

    console.log("✅ Itinerary generated & saved (via util):", newItinerary._id);
    return res.json(newItinerary);
  } catch (error) {
    console.error("❌ Itinerary generation failed (AI):", error.message || error);

    // Graceful fallback: create a simple itinerary entry so the user still has something useful
    try {
      const fallback = {
        title: `Simple itinerary to ${destinations.map((d) => d.to).join(", ")}`,
        startDate,
        endDate,
        budget,
        destinations: destinations.map((d) => `${d.from} to ${d.to}`),
        transport: { type: "Unknown", detail: "N/A", price: "0" },
        stays: [],
        packingList: ["Clothes", "Toiletries"],
        apps: ["Google Maps"],
        days: [
          {
            day: "Day 1",
            date: startDate,
            title: "Arrival & local exploration",
            activities: [{ name: "Settle in and explore nearby spots", price: "0" }],
          },
        ],
      };

      const savedFallback = await new Itinerary({ ...fallback }).save();

      // Link to trip if provided
      if (tripId) {
        const Trip = require("./models/Trip");
        await Trip.findByIdAndUpdate(tripId, { itineraryId: savedFallback._id });
        console.log("🔗 Linked fallback itinerary to trip:", tripId);
      }

      return res.status(200).json({
        message: "AI generation failed; a simple fallback itinerary was created.",
        itinerary: savedFallback,
        error: error.message || String(error),
      });
    } catch (fallbackErr) {
      console.error("💥 Fallback itinerary creation failed:", fallbackErr);
      return res.status(500).json({ message: "Failed to generate itinerary", error: fallbackErr.message || String(fallbackErr) });
    }
  }
};


// --- ROUTE MOUNTING ---
app.use("/api/auth", authRoutes);
app.use("/api/trips", tripRoutes);
app.use("/api/budget-trips", budgetTripRoutes);
app.use("/api/journal", journalRoutes);
app.use("/api/preferences", preferenceRoutes);
app.use("/api/memories", memoryRoutes);
app.use("/api/itineraries", itineraryRoutes); // ✅ Already added
app.use("/api/user", userProfileRoutes);


// AI Generation Route
app.post("/api/generate-itinerary", generateItinerary);

// Generate a short, destination-specific description (used by TripSuccess)
const generateDescription = async (req, res) => {
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ message: 'destination required' });

  const prompt = `Write a short, evocative 1-2 sentence summary of a trip to ${destination}. Keep it warm and memory-focused.`;

  try {
    // reuse the resilient Gemini helper (respects RetryInfo & cooldown)
    const text = await generateItineraryFn.callGemini(prompt);
    const cleaned = text.replace(/```/g, '').trim();
    return res.json({ description: cleaned });
  } catch (err) {
    console.error('Description generation failed:', err.message || err);

    // Friendly fallback (local generator) so the front-end always gets something useful
    const fallback = `A trip to ${destination} — full of small, golden moments and vivid memories.`;
    return res.json({ description: fallback, fallback: true, error: err.message || String(err) });
  }
};

// Diagnostics endpoint to inspect cooldown state
app.get('/api/ai-status', (req, res) => {
  const cd = generateItineraryFn.getCooldown ? generateItineraryFn.getCooldown() : null;
  const now = Date.now();
  res.json({ cooldownUntil: cd, inCooldown: cd ? now < cd : false, now });
});

app.post('/api/generate-description', generateDescription);

// --- ROOT & ERROR HANDLING ---
app.get("/", (req, res) => {
  res.send("🌍 TravelZen API running! Try /api/generate-itinerary or /api/itineraries");
});

app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ message: "Internal Server Error", error: err.message });
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
