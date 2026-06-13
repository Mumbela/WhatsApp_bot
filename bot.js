const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const axios = require("axios");

const RAILS_URL = "http://127.0.0.1:3000/api/v1/message";

// Simple in-memory anti-loop + dedupe
const processedMessages = new Set();

function makeMessageId(msg) {
  return msg.key.id + ":" + msg.key.remoteJid;
}

async function startBot() {

  const { state, saveCreds } =
    await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  // Save auth state
  sock.ev.on("creds.update", saveCreds);

  // Connection handler
  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut;

      console.log("Connection closed:", statusCode);

      if (shouldReconnect) {
        startBot();
      }
    }

    if (connection === "open") {
      console.log("Bot connected");
    }
  });

  // MAIN MESSAGE HANDLER
  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages?.[0];
    if (!msg?.message) return;

    // 1. Ignore bot's own messages (CRITICAL)
    if (msg.key.fromMe) return;

    // 2. Only process "notify" messages
    if (msg.messageStubType) return;

    const sender = msg.key.remoteJid;
    const messageId = makeMessageId(msg);

    // 3. Deduplicate (prevents retry loops)
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);

    // Cleanup memory (avoid leaks)
    setTimeout(() => {
      processedMessages.delete(messageId);
    }, 60_000);

    // 4. Extract text safely
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption;

    if (!text) return;

    console.log(`[${sender}] ${text}`);

    try {

      // 5. Send ONLY user messages to Rails
      const response = await axios.post(
        RAILS_URL,
        {
          phone: sender,
          message: text
        },
        {
          timeout: 15000
        }
      );

      const reply = response?.data?.reply;

      if (!reply) return;

      // 6. Send response back to WhatsApp
      await sock.sendMessage(sender, {
        text: reply
      });

    } catch (err) {
      console.error("Rails error:", err.message);

      await sock.sendMessage(sender, {
        text: "System error. Try again later."
      });
    }

  });
}

startBot();