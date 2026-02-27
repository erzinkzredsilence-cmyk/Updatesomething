const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware for CORS and JSON handling
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

let minecraftData = null;
const clients = new Map(); // WebSocket Client -> Data
const pttStates = new Map(); // Gamertag -> PTT State
const voiceDetectionStates = new Map(); // Gamertag -> Voice Detection State

// Endpoint to receive data from the Minecraft Server Behavior Pack
app.post("/minecraft-data", (req, res) => {
  minecraftData = req.body;
  console.log("📦 Minecraft data received");

  const muteStates = minecraftData.players?.map(player => ({
    gamertag: player.name,
    isMuted: player.data.isMuted,
    isDeafened: player.data.isDeafened,
    micVolume: player.data.micVolume
  })) || [];

  const pttStatesArray = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));

  const voiceStatesArray = Array.from(voiceDetectionStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    isTalking: state.isTalking,
    volume: state.volume
  }));

  // Broadcast update to all connected WebSocket clients (players)
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'minecraft-update',
        data: minecraftData,
        muteStates: muteStates,
        pttStates: pttStatesArray,
        voiceStates: voiceStatesArray
      }));
    }
  });

  res.json({ 
    success: true,
    pttStates: pttStatesArray,
    voiceStates: voiceStatesArray
  });
});

function isGamertagTaken(gamertag) {
  for (const [_, clientData] of clients.entries()) {
    if (clientData.gamertag === gamertag) {
      return true;
    }
  }
  return false;
}

// Broadcast message to everyone except the sender
function broadcast(senderWs, message) {
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

// Broadcast message to everyone
function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

// WebSocket connection handling (Voice Data & Signaling)
wss.on("connection", (ws) => {
  console.log("🔌 Client connected");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // 1. Join Request
      if (data.type === 'join') {
        if (isGamertagTaken(data.gamertag)) {
          console.log(`❌ Duplicate gamertag rejected: ${data.gamertag}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Gamertag already in use. Please choose a different one.'
          }));
          ws.close();
          return;
        }

        clients.set(ws, { gamertag: data.gamertag });
        
        // Initialize default states
        pttStates.set(data.gamertag, { isTalking: true, isMuted: false });
        voiceDetectionStates.set(data.gamertag, { isTalking: false, volume: 0 });
        
        console.log(`👤 ${data.gamertag} joined (${clients.size} total users)`);

        broadcast(ws, {
          type: 'join',
          gamertag: data.gamertag
        });

        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        // Send current list to the new user
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));

        // Broadcast updated list to everyone
        broadcast(ws, {
          type: 'participants-list',
          list: participantsList
        });

        return;
      }

      // 2. Leave Request
      if (data.type === 'leave') {
        const clientData = clients.get(ws);
        if (clientData) {
          console.log(`👋 ${clientData.gamertag} left (${clients.size - 1} users remaining)`);

          broadcast(ws, {
            type: 'leave',
            gamertag: clientData.gamertag
          });

          pttStates.delete(clientData.gamertag);
          voiceDetectionStates.delete(clientData.gamertag);
          clients.delete(ws);
        }
        return;
      }

      // 3. Voice Detection (Volume-based)
      if (data.type === 'voice-detection') {
        const gamertag = data.gamertag;
        const isTalking = data.isTalking;
        const volume = data.volume || 0;

        voiceDetectionStates.set(gamertag, { isTalking, volume });

        console.log(`🎤 Voice Detection: ${gamertag} → ${isTalking ? `TALKING (${volume}dB)` : 'SILENT'}`);
        return;
      }

      // 4. Push-to-Talk Status
      if (data.type === 'ptt-status') {
        const gamertag = data.gamertag;
        const isTalking = data.isTalking;
        const isMuted = data.isMuted;

        pttStates.set(gamertag, { isTalking, isMuted });

        console.log(`🎙️ PTT: ${gamertag} → ${isTalking ? 'TALKING' : 'MUTED'}`);

        broadcastToAll({
          type: 'ptt-update',
          gamertag: gamertag,
          isTalking: isTalking,
          isMuted: isMuted
        });

        return;
      }

      // 5. WebRTC Signaling (Offer, Answer, ICE Candidate)
      if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
        if (!data.to || !data.from) {
          console.warn(`⚠️ Message missing 'to' or 'from':`, data.type);
          return;
        }

        const targetGamertag = data.to;
        let targetWs = null;
        
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.gamertag === targetGamertag) {
            targetWs = clientWs;
            break;
          }
        }

        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(data));
          
          if (data.type === 'ice-candidate') {
            console.log(`🧊 ICE ${data.from} → ${data.to}`);
          } else {
            console.log(`📨 ${data.type} from ${data.from} → ${data.to}`);
          }
        } else {
          console.warn(`⚠️ Recipient not found: ${targetGamertag}`);
        }

        return;
      }

      // 6. Heartbeat/Keep-alive
      if (data.type === 'heartbeat') {
        return;
      }

      // 7. Request Participant List
      if (data.type === 'request-participants') {
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        
        broadcastToAll({
          type: 'participants-list',
          list: participantsList
        });
        
        console.log(`📋 Participant list sent (${participantsList.length} users)`);
        return;
      }

      console.warn(`⚠️ Unknown message type: ${data.type}`);

    } catch (e) {
      console.error("❌ Error processing message:", e);
    }
  });

  // Cleanup on disconnection
  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`🔌 ${clientData.gamertag} disconnected (${clients.size - 1} users remaining)`);

      broadcast(ws, {
        type: 'leave',
        gamertag: clientData.gamertag
      });

      pttStates.delete(clientData.gamertag);
      voiceDetectionStates.delete(clientData.gamertag);
      clients.delete(ws);
      
      const updatedList = Array.from(clients.values()).map(c => c.gamertag);
      broadcastToAll({
        type: 'participants-list',
        list: updatedList
      });
    }
  });

  ws.on('error', (error) => {
    const clientData = clients.get(ws);
    const gamertag = clientData ? clientData.gamertag : 'Unknown';
    console.error(`❌ WebSocket error for ${gamertag}:`, error.message);
  });

  // Send initial Minecraft data if available
  if (minecraftData) {
    ws.send(JSON.stringify({
      type: 'minecraft-update',
      data: minecraftData
    }));
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  const status = {
    status: 'ok',
    connected_users: clients.size,
    minecraft_data: !!minecraftData,
    ptt_active_users: pttStates.size,
    voice_detection_users: voiceDetectionStates.size,
    uptime: process.uptime()
  };
  res.json(status);
});

// Xbox Gamertag verifier
app.get("/gamertag/:tag", async (req, res) => {
  const tag = req.params.tag;
  const encoded = encodeURIComponent(tag);
  const url = `https://xboxgamertag.com/search/${encoded}`;

  console.log("🔍 Verifying gamertag:", tag);

  try {
    const { data: html } = await axios.get(url);
    const exists = html.includes("Gamerscore");

    res.json({
      gamertag: tag,
      exists: exists
    });

  } catch (err) {
    console.error("❌ Error verifying gamertag:", err.message);
    res.status(500).json({
      error: "Verification failed",
      message: err.message
    });
  }
});

// Endpoint to get all PTT states
app.get("/ptt-states", (req, res) => {
  const states = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));
  res.json({ pttStates: states });
});

// Endpoint to get all Voice Detection states
app.get("/voice-states", (req, res) => {
  const states = Array.from(voiceDetectionStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));
  res.json({ voiceStates: states });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  
  broadcastToAll({ type: 'server-shutdown' });
  
  wss.clients.forEach(client => {
    client.close();
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 EnviroVoice Server v2.2 (English)`);
  console.log(`🌐 Server listening on port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🎮 Minecraft endpoint: POST http://localhost:${PORT}/minecraft-data`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/health`);
  console.log(`🎙️ PTT states: GET http://localhost:${PORT}/ptt-states`);
  console.log(`🎤 Voice states: GET http://localhost:${PORT}/voice-states`);
});
