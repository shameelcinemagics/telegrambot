const express = require("express");
const { getMachineList, buildComparison, formatGChat } = require("./comparison");

const WEBHOOK_URL = process.env.GOOGLE_CHAT_WEBHOOK;

// Send a proactive message to Google Chat space via webhook
async function sendToGChat(text) {
  if (!WEBHOOK_URL) return null;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error("Google Chat webhook error:", res.status);
    return res.ok;
  } catch (err) {
    console.error("Google Chat webhook error:", err.message);
    return null;
  }
}

function createGoogleChatHandler(supabase) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    try {
      const event = req.body;
      console.log("Google Chat event type:", event.type);
      console.log("Full event keys:", Object.keys(event));

      let response;

      // Standard Chat app format
      switch (event.type) {
        case "ADDED_TO_SPACE":
          response = { text: "Hi! Type *compare* to compare machine sales before & after rollout." };
          break;

        case "MESSAGE":
          response = await handleMessage(event, supabase);
          break;

        case "CARD_CLICKED":
          response = await handleCardClicked(event, supabase);
          break;

        default:
          // Workspace add-on fallback: detect from event structure
          if (event.chat?.messagePayload?.message) {
            response = await handleMessageAddon(event, supabase);
          } else if (event.commonEventObject?.invokedFunction) {
            response = await handleCardClickedAddon(event, supabase);
          } else {
            response = { text: "Type *compare* to get started." };
          }
      }

      console.log("Response:", JSON.stringify(response).slice(0, 300));
      res.json(response);
    } catch (error) {
      console.error("Google Chat error:", error);
      res.json({ text: "Something went wrong. Please try again." });
    }
  });

  // API endpoints
  router.get("/machines", async (req, res) => {
    try {
      const machines = await getMachineList(supabase);
      if (!machines) return res.json({ error: "No rollouts found" });
      res.json({
        machines: machines.map((m) => ({
          id: m.id,
          name: m.vending_machines?.location || m.vending_machines?.machine_id || `Machine ${m.machineid}`,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to list machines" });
    }
  });

  router.post("/compare", async (req, res) => {
    try {
      const { rolloutId, mode } = req.body;
      if (!rolloutId || !mode) return res.status(400).json({ error: "rolloutId and mode required" });
      const result = await buildComparison(supabase, rolloutId, mode);
      const text = formatGChat(result);
      await sendToGChat(text);
      res.json({ sent: true, text });
    } catch (err) {
      res.status(500).json({ error: "Failed to run comparison" });
    }
  });

  return router;
}

// ---- Standard Chat app handlers (event.type = MESSAGE/CARD_CLICKED) ----

async function handleMessage(event, supabase) {
  const raw = event.message?.argumentText || event.message?.text || "";
  const cleanText = raw.toLowerCase().trim();

  if (cleanText === "compare" || cleanText === "/compare") {
    return buildMachineSelectionCard(supabase);
  }

  if (cleanText === "help" || cleanText === "/help") {
    return { text: "Available commands:\n• *compare* — Compare machine sales (daily/weekly/monthly)\n• *help* — Show this message" };
  }

  return { text: "Type *compare* to compare machine sales, or *help* for commands." };
}

async function handleCardClicked(event, supabase) {
  const params = event.common?.parameters || {};
  const fn = event.common?.invokedFunction || "";

  console.log("Card click — function:", fn, "params:", JSON.stringify(params));

  if (fn === "selectMachine") {
    return buildComparisonTypeCard(params.rolloutId, params.machineName);
  }

  if (fn === "runComparison") {
    const result = await buildComparison(supabase, params.rolloutId, params.mode);
    return { text: formatGChat(result) };
  }

  return { text: "Unknown action. Type *compare* to start over." };
}

// ---- Workspace add-on fallback handlers ----

async function handleMessageAddon(event, supabase) {
  const msg = event.chat.messagePayload.message;
  const raw = msg.argumentText || msg.text || "";
  const cleanText = raw.toLowerCase().trim();

  if (cleanText === "compare" || cleanText === "/compare") {
    return buildMachineSelectionCard(supabase);
  }

  if (cleanText === "help" || cleanText === "/help") {
    return { text: "Available commands:\n• *compare* — Compare machine sales (daily/weekly/monthly)\n• *help* — Show this message" };
  }

  return { text: "Type *compare* to compare machine sales, or *help* for commands." };
}

async function handleCardClickedAddon(event, supabase) {
  const params = event.commonEventObject?.parameters || {};
  const fn = event.commonEventObject?.invokedFunction || "";

  console.log("Add-on card click — function:", fn, "params:", JSON.stringify(params));

  if (fn === "selectMachine") {
    return buildComparisonTypeCard(params.rolloutId, params.machineName);
  }

  if (fn === "runComparison") {
    const result = await buildComparison(supabase, params.rolloutId, params.mode);
    return { text: formatGChat(result) };
  }

  return { text: "Unknown action. Type *compare* to start over." };
}

// ---- Card builders (standard Chat app format) ----

async function buildMachineSelectionCard(supabase) {
  const machines = await getMachineList(supabase);
  if (!machines) return { text: "No machine rollouts found." };

  const buttons = machines.map((m) => ({
    text: m.vending_machines?.location || m.vending_machines?.machine_id || `Machine ${m.machineid}`,
    onClick: {
      action: {
        function: "selectMachine",
        parameters: [
          { key: "rolloutId", value: String(m.id) },
          { key: "machineName", value: m.vending_machines?.location || m.vending_machines?.machine_id || `Machine ${m.machineid}` },
        ],
      },
    },
  }));

  const widgets = [];
  for (let i = 0; i < buttons.length; i += 2) {
    widgets.push({ buttonList: { buttons: buttons.slice(i, i + 2) } });
  }

  return {
    cardsV2: [{
      cardId: "machineSelect",
      card: {
        header: { title: "Select a Machine", subtitle: "Choose a machine to compare sales" },
        sections: [{ widgets }],
      },
    }],
  };
}

function buildComparisonTypeCard(rolloutId, machineName) {
  return {
    cardsV2: [{
      cardId: "compareType",
      card: {
        header: { title: machineName, subtitle: "Choose comparison type" },
        sections: [{
          widgets: [{
            buttonList: {
              buttons: ["daily", "weekly", "monthly"].map((mode) => ({
                text: mode.charAt(0).toUpperCase() + mode.slice(1),
                onClick: {
                  action: {
                    function: "runComparison",
                    parameters: [
                      { key: "rolloutId", value: rolloutId },
                      { key: "mode", value: mode },
                    ],
                  },
                },
              })),
            },
          }],
        }],
      },
    }],
  };
}

module.exports = { createGoogleChatHandler, sendToGChat };
