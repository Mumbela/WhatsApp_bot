const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const axios = require("axios");

const RAILS_URL = "http://127.0.0.1:3000/api/v1/message";

const processedMessages = new Set();

function makeMessageId(msg) {
  return `${msg.key.id}:${msg.key.remoteJid}`;
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  );
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

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
      console.log("VIREMOSA bot connected");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];

    if (!msg?.message) return;
    if (msg.key.fromMe) return;
    if (msg.messageStubType) return;

    const sender = msg.key.remoteJid;
    const messageId = makeMessageId(msg);

    if (processedMessages.has(messageId)) return;

    processedMessages.add(messageId);

    setTimeout(() => {
      processedMessages.delete(messageId);
    }, 60_000);

    const text = extractText(msg);

    if (!text) return;

    console.log("📩 RECEIVED:", text);

    try {
      const response = await axios.post(
        RAILS_URL,
        {
          phone: sender,
          message: text.trim()
        },
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
        }
      );

      console.log(
        "⬅️ FROM RAILS:",
        JSON.stringify(response.data, null, 2)
      );

      const reply = response.data?.reply;

      if (!reply) {
        console.log("No reply received from Rails");
        return;
      }

      await sock.sendMessage(sender, {
        text: reply
      });

    } catch (err) {
      console.error("❌ Rails error:", err.message);

      if (err.response) {
        console.error(
          "❌ Rails response:",
          err.response.data
        );
      }

      await sock.sendMessage(sender, {
        text: "System error. Try again later."
      });
    }
  });
}

startBot();