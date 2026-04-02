-- ============================================================
--  DiscordBot.js  |  Node.js — Bot Discord
--  Gestisce il comando /verificati per linkare Roblox ↔ Discord
--  Richiede: discord.js v14, axios, node-fetch
-- ============================================================
--
--  SETUP:
--  1. npm install discord.js axios dotenv
--  2. Crea file .env con:
--       DISCORD_TOKEN=il_tuo_token_bot
--       ROBLOX_OPEN_CLOUD_KEY=la_tua_api_key (opzionale, per MessagingService)
--       ROBLOX_UNIVERSE_ID=id_del_tuo_gioco
--       VERIFIED_ROLE_ID=id_del_ruolo_da_assegnare
--  3. node DiscordBot.js
-- ============================================================

/*
 * ⚠  NOTA: Questo file è JavaScript, NON Lua.
 *    Salvalo come DiscordBot.js nella cartella del tuo bot.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const UNIVERSE_ID      = process.env.ROBLOX_UNIVERSE_ID;
const OPEN_CLOUD_KEY   = process.env.ROBLOX_OPEN_CLOUD_KEY;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;

// Mappa temporanea codice -> promessa in attesa
const pendingVerifications = new Map();

// ============================================================
//  REGISTRA I COMANDI SLASH
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('verificati')
    .setDescription('Collega il tuo account Roblox al server Discord')
    .addStringOption(option =>
      option
        .setName('codice')
        .setDescription('Il codice di 6 caratteri mostrato in gioco (es. A3K9PQ)')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('chi_sono')
    .setDescription('Mostra le tue informazioni RP collegate')
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('[Bot] Registrazione comandi slash...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[Bot] Comandi registrati correttamente.');
  } catch (error) {
    console.error('[Bot] Errore registrazione comandi:', error);
  }
}

// ============================================================
//  MESSAGGIO AL GIOCO tramite Open Cloud MessagingService
// ============================================================
async function sendVerifyToGame(code, discordTag) {
  if (!OPEN_CLOUD_KEY || !UNIVERSE_ID) {
    console.warn('[Bot] ROBLOX_OPEN_CLOUD_KEY o UNIVERSE_ID non configurati.');
    return { success: false, msg: 'Bot non configurato correttamente.' };
  }

  try {
    const payload = JSON.stringify({ code: code, discordTag: discordTag });
    const response = await axios.post(
      `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/DiscordVerify`,
      { message: payload },
      {
        headers: {
          'x-api-key': OPEN_CLOUD_KEY,
          'Content-Type': 'application/json',
        }
      }
    );
    console.log(`[Bot] Messaggio inviato al gioco. Status: ${response.status}`);
    return { success: true };
  } catch (err) {
    console.error('[Bot] Errore invio al gioco:', err.response?.data || err.message);
    return { success: false, msg: 'Errore di comunicazione con il gioco.' };
  }
}

// ============================================================
//  ASCOLTA RISPOSTA DAL GIOCO
//  (polling su un endpoint HTTP del gioco, o via WebSocket)
//  Per semplicità usiamo un approccio con timeout e polling
// ============================================================
function waitForGameResponse(discordTag, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const key = discordTag;
    pendingVerifications.set(key, resolve);
    setTimeout(() => {
      if (pendingVerifications.has(key)) {
        pendingVerifications.delete(key);
        resolve(null); // timeout
      }
    }, timeoutMs);
  });
}

// Questa funzione viene chiamata quando il gioco risponde
// (tramite un webhook HTTP che il gioco invia al tuo server Node)
function handleGameResponse(data) {
  const key = data.discordTag;
  const resolver = pendingVerifications.get(key);
  if (resolver) {
    pendingVerifications.delete(key);
    resolver(data);
  }
}

// ============================================================
//  SERVER HTTP LOCALE per ricevere risposte dal gioco
//  Il gioco usa HttpService per POST su questo endpoint
// ============================================================
const http = require('http');

const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/game-response') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        handleGameResponse(data);
        res.writeHead(200);
        res.end('OK');
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

httpServer.listen(3001, () => {
  console.log('[Bot] HTTP server in ascolto sulla porta 3001');
});

// ============================================================
//  GESTIONE COMANDI
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ─── /verificati ───────────────────────────────────────────
  if (interaction.commandName === 'verificati') {
    const code = interaction.options.getString('codice').trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return interaction.reply({
        content: '❌ Il codice deve essere di esattamente **6 caratteri** alfanumerici.\nEsempio: `A3K9PQ`',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const discordTag = `${interaction.user.username}#${interaction.user.discriminator}`;

    // Manda il codice al gioco
    const sendResult = await sendVerifyToGame(code, discordTag);
    if (!sendResult.success) {
      return interaction.editReply(`❌ ${sendResult.msg}`);
    }

    // Aspetta risposta dal gioco (max 15 secondi)
    const gameResponse = await waitForGameResponse(discordTag, 15000);

    if (!gameResponse) {
      return interaction.editReply('⏱ **Timeout**: il gioco non ha risposto in tempo.\nAssicurati di essere in gioco e che il codice sia valido.');
    }

    if (!gameResponse.success) {
      return interaction.editReply(`❌ **Verifica fallita**: ${gameResponse.msg}`);
    }

    // Verifica riuscita!
    const rpName = gameResponse.rpName || 'Sconosciuto';

    // Assegna il ruolo verificato (se configurato)
    if (VERIFIED_ROLE_ID) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const role   = await interaction.guild.roles.fetch(VERIFIED_ROLE_ID);
        if (role) {
          await member.roles.add(role);
        }
        // Imposta il nickname al nome RP
        await member.setNickname(rpName).catch(() => {
          console.warn('[Bot] Impossibile cambiare nickname (permessi insufficienti?)');
        });
      } catch (err) {
        console.warn('[Bot] Errore assegnazione ruolo:', err.message);
      }
    }

    return interaction.editReply(
      `✅ **Verifica completata!**\n` +
      `👤 Nome RP: **${rpName}**\n` +
      `🔗 Account Discord collegato al tuo personaggio in gioco.`
    );
  }

  // ─── /chi_sono ─────────────────────────────────────────────
  if (interaction.commandName === 'chi_sono') {
    // Questa funzione richiederebbe una query al DataStore
    // tramite Open Cloud Data Store API
    const discordTag = `${interaction.user.username}`;
    return interaction.reply({
      content: `ℹ Ciao **${discordTag}**! Usa \`/verificati [codice]\` per collegare il tuo account se non l'hai già fatto.`,
      ephemeral: true
    });
  }
});

// ============================================================
//  AVVIO BOT
// ============================================================
client.once('ready', async () => {
  console.log(`[Bot] Connesso come ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('[Bot] Errore login:', err.message);
  process.exit(1);
});