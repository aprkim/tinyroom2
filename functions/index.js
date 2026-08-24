const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const contextId = defineSecret("CONTEXT_ID");
const contextAuthToken = defineSecret("CONTEXT_AUTH_TOKEN");

const VIBELIVE_API = "https://proxy2.makedo.com/v05/api";
const ALLOWED_ACTIONS = ["createUser", "getToken"];

exports.proxy = onRequest(
  { cors: true, secrets: [contextId, contextAuthToken] },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { action, ...rest } = req.body || {};

    if (!action || !ALLOWED_ACTIONS.includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const body = {
      ...rest,
      action,
      contextId: contextId.value(),
      contextAuthToken: contextAuthToken.value(),
    };

    try {
      const response = await fetch(VIBELIVE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return res.json(data);
    } catch (e) {
      return res.status(502).json({ error: "Failed to reach VibeLive API" });
    }
  }
);
