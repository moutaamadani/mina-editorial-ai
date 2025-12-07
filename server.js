import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Mina Editorial AI" });
});

// Placeholder endpoint we’ll hook to GPT/Replicate later
app.post("/editorial/generate", (req, res) => {
  const payload = req.body || {};
  res.json({
    ok: true,
    message: "Mina Editorial API placeholder",
    received: payload
  });
});

app.listen(PORT, () => {
  console.log(`Mina Editorial API listening on port ${PORT}`);
});
