import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { useMongoDBAuthState, clearMongoSession, listStoredWhatsAppSessions } from "./mongo-auth-state";

const logger = pino({ level: "silent" });

// Memory optimization: cache Baileys version so it is fetched only ONCE
// instead of on every socket creation and reconnect
let _cachedVersion: number[] | null = null;
async function getCachedBaileysVersion(): Promise<number[]> {
  if (!_cachedVersion) {
    const result = await fetchLatestBaileysVersion();
    _cachedVersion = result.version;
  }
  return _cachedVersion;
}

let socketGenCounter = 0;

interface WhatsAppSession {
  socket: ReturnType<typeof makeWASocket> | null;
  connected: boolean;
  pairingCode: string | null;
  qrCode: string | null;
  qrExpiresAt: number | null;
  pairingMode: "code" | "qr";
  connecting: boolean;
  phoneNumber: string;
  codeRequested: boolean;
  wasConnected: boolean;
  retryCount: number;
  socketGenId: number;
  connectLock: boolean;
}

const sessions: Map<string, WhatsAppSession> = new Map();

async function clearSessionData(userId: string): Promise<void> {
  try {
    await clearMongoSession(userId);
    console.log(`[WA][${userId}] Cleared session from MongoDB`);
  } catch (err: any) {
    console.error(`[WA][${userId}] clearSessionData error:`, err?.message);
  }
}

function closeSocketSafe(sock: ReturnType<typeof makeWASocket> | null): void {
  if (!sock) return;
  try { sock.end(undefined); } catch {}
}

async function createSocket(
  userId: string,
  phoneNumber: string,
  pairingMode: "code" | "qr",
  onCode: (code: string) => void,
  onQr: (qr: string, expiresAt: number) => void,
  onConnected: () => void,
  onDisconnected: (reason: string) => void,
  session: WhatsAppSession
): Promise<void> {
  if (session.socket) {
    closeSocketSafe(session.socket);
    session.socket = null;
  }

  const myGenId = ++socketGenCounter;
  session.socketGenId = myGenId;
  session.codeRequested = false;

  let { state, saveCreds } = await useMongoDBAuthState(userId);

  if (state.creds.registered && session.retryCount >= 3 && !session.wasConnected) {
    console.log(`[WA][${userId}] gen=${myGenId} Stale registered session after ${session.retryCount} fails — clearing`);
    await clearSessionData(userId);
    session.retryCount = 0;
    const fresh = await useMongoDBAuthState(userId);
    state = fresh.state;
    saveCreds = fresh.saveCreds;
  }

  const version = await getCachedBaileysVersion();
  console.log(`[WA][${userId}] Creating socket gen=${myGenId} version=${version.join(".")} registered=${state.creds.registered}`);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    // Browsers.ubuntu("Chrome") = ["Ubuntu", "Chrome", "20.0.04"]
    // This is required for phone number pairing to work correctly
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 250,
    getMessage: async () => undefined, // No in-memory message buffering
  });

  session.socket = sock;
  sock.ev.on("creds.update", saveCreds);

  if (!state.creds.registered && pairingMode === "code") {
    const cleaned = phoneNumber.replace(/[^0-9]/g, "");
    let codeRequestScheduled = false;

    const requestCode = async () => {
      if (session.socketGenId !== myGenId) {
        console.log(`[WA][${userId}] Pairing code skipped — socket gen changed (was ${myGenId})`);
        return;
      }
      if (!sessions.has(userId)) {
        console.log(`[WA][${userId}] Session gone — skipping pairing code`);
        return;
      }
      if (session.codeRequested) {
        console.log(`[WA][${userId}] Code already requested gen=${myGenId}`);
        return;
      }
      session.codeRequested = true;
      try {
        console.log(`[WA][${userId}] Requesting pairing code for ${cleaned} gen=${myGenId}...`);
        const code = await sock.requestPairingCode(cleaned);
        if (!code) {
          console.error(`[WA][${userId}] requestPairingCode returned empty gen=${myGenId}`);
          session.codeRequested = false;
          return;
        }
        if (session.socketGenId !== myGenId) {
          console.log(`[WA][${userId}] Got code but socket gen changed — discarding gen=${myGenId}`);
          return;
        }
        const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
        session.pairingCode = formatted;
        session.connecting = false;
        console.log(`[WA][${userId}] Got pairing code: ${formatted} gen=${myGenId}`);
        onCode(formatted);
      } catch (err: any) {
        console.error(`[WA][${userId}] requestPairingCode failed gen=${myGenId}: ${err?.message}`);
        session.codeRequested = false;
        setTimeout(async () => {
          if (session.socketGenId !== myGenId || !sessions.has(userId)) return;
          session.codeRequested = false;
          try {
            const code2 = await sock.requestPairingCode(cleaned);
            if (!code2 || session.socketGenId !== myGenId) return;
            const formatted2 = code2.match(/.{1,4}/g)?.join("-") ?? code2;
            session.pairingCode = formatted2;
            session.codeRequested = true;
            console.log(`[WA][${userId}] Got pairing code (retry): ${formatted2} gen=${myGenId}`);
            onCode(formatted2);
          } catch (err2: any) {
            console.error(`[WA][${userId}] requestPairingCode retry also failed gen=${myGenId}: ${err2?.message}`);
            closeSocketSafe(sock);
            session.socket = null;
            sessions.delete(userId);
            onDisconnected("Pairing code nahi mil raha. Thodi der baad dobara try karein.");
          }
        }, 5000);
      }
    };

    // Strategy: wait for "connecting" state then hold 3s for WebSocket handshake to settle.
    // Fallback: request after 10s regardless, for slow/cold-start servers (e.g. Render).
    // Requesting code too early (< 2s after "connecting") causes WhatsApp to issue a
    // "fake" code that appears valid but cannot be entered on the phone.
    const fallbackTimer = setTimeout(async () => {
      if (!codeRequestScheduled) {
        codeRequestScheduled = true;
        console.log(`[WA][${userId}] gen=${myGenId} Fallback: requesting pairing code after 10s`);
        await requestCode();
      }
    }, 10000);

    sock.ev.on("connection.update", async (update) => {
      if (codeRequestScheduled || session.codeRequested) return;
      const { connection } = update;
      // Only trigger on "connecting" — this means the WebSocket is being established.
      // Do NOT trigger on "open" (that means already registered / re-auth).
      // Wait 3s after "connecting" so the noise handshake with WA servers completes.
      if (connection === "connecting") {
        codeRequestScheduled = true;
        clearTimeout(fallbackTimer);
        console.log(`[WA][${userId}] gen=${myGenId} Socket connecting — requesting pairing code in 3s`);
        setTimeout(async () => {
          await requestCode();
        }, 3000);
      }
    });
  }

  sock.ev.on("connection.update", async (update) => {
    // Stale socket check
    if (session.socketGenId !== myGenId) {
      console.log(`[WA][${userId}] Ignoring stale socket gen=${myGenId} (current=${session.socketGenId})`);
      closeSocketSafe(sock);
      return;
    }

    const currentSession = sessions.get(userId);
    if (!currentSession || currentSession !== session) {
      console.log(`[WA][${userId}] Session replaced, ignoring gen=${myGenId}`);
      closeSocketSafe(sock);
      return;
    }

    const { connection, lastDisconnect, qr } = update;
    console.log(`[WA][${userId}] Update gen=${myGenId}: connection=${connection}`);

    if (pairingMode === "qr" && qr && !session.connected) {
      const expiresAt = Date.now() + 60000;
      session.qrCode = qr;
      session.qrExpiresAt = expiresAt;
      session.connecting = false;
      console.log(`[WA][${userId}] QR generated gen=${myGenId}`);
      onQr(qr, expiresAt);
    }

    if (connection === "open") {
      console.log(`[WA][${userId}] Connected! gen=${myGenId}`);
      session.connected = true;
      session.wasConnected = true;
      session.connecting = false;
      session.qrCode = null;
      session.qrExpiresAt = null;
      session.retryCount = 0;
      onConnected();
    }

    if (connection === "close") {
      session.connected = false;
      session.connecting = false;

      const boom = lastDisconnect?.error as Boom | undefined;
      const statusCode = boom?.output?.statusCode;
      const reason = boom?.message || "Unknown";

      console.log(`[WA][${userId}] Closed gen=${myGenId}. code=${statusCode} reason=${reason} wasConnected=${session.wasConnected} retries=${session.retryCount}`);

      // Real logout — user manually unlinked from WA settings
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[WA][${userId}] Logout detected gen=${myGenId}`);
        clearSessionData(userId);
        sessions.delete(userId);
        onDisconnected("WhatsApp ne logout kar diya. Dobara connect karein.");
        return;
      }

      // 401 = stale credentials, clear and retry
      if (statusCode === 401 && !session.wasConnected) {
        console.log(`[WA][${userId}] 401 invalid creds gen=${myGenId} — clearing and retrying`);
        closeSocketSafe(sock);
        session.socket = null;
        clearSessionData(userId);
        session.codeRequested = false;
        session.retryCount++;

        if (session.retryCount > 3) {
          sessions.delete(userId);
          onDisconnected("Connection baar baar fail ho raha hai. Dobara try karein.");
          return;
        }

        setTimeout(async () => {
          if (session.socketGenId !== myGenId) return;
          const currentSession = sessions.get(userId);
          if (!currentSession || currentSession !== session) return;
          try {
            await createSocket(userId, phoneNumber, pairingMode, onCode, onQr, onConnected, onDisconnected, session);
          } catch (e: any) {
            sessions.delete(userId);
            onDisconnected(`Retry failed: ${e?.message}`);
          }
        }, 3000);
        return;
      }

      // 515 = "Stream Errored (restart required)"
      // This is NORMAL after user successfully enters pairing code.
      // WhatsApp saves credentials first, then sends 515.
      // DO NOT clear session files — registered=true must persist for reconnect.
      if (statusCode === 515 || reason.includes("Stream Errored")) {
        console.log(`[WA][${userId}] 515 stream restart gen=${myGenId} — normal after pairing, reconnecting (session preserved)`);
        closeSocketSafe(sock);
        session.socket = null;
        session.codeRequested = false;
        session.retryCount++;

        if (session.retryCount > 8) {
          sessions.delete(userId);
          onDisconnected("Bahut zyada reconnect attempts. Dobara try karein.");
          return;
        }

        const delay = session.wasConnected ? 3000 : 2000;
        setTimeout(async () => {
          if (session.socketGenId !== myGenId) return;
          const currentSession = sessions.get(userId);
          if (!currentSession || currentSession !== session) return;
          try {
            await createSocket(userId, phoneNumber, pairingMode, onCode, onQr, onConnected, onDisconnected, session);
          } catch (e: any) {
            sessions.delete(userId);
            onDisconnected(`Reconnect failed: ${e?.message}`);
          }
        }, delay);
        return;
      }

      // 403 = WhatsApp permanently rejected this session (banned, session invalidated, or device unlinked remotely)
      // Retrying endlessly on 403 causes memory leaks (500+ sockets accumulate). Cap retries tightly.
      if (statusCode === 403) {
        session.retryCount++;
        const MAX_403_RETRIES = session.wasConnected ? 10 : 3;
        if (session.retryCount > MAX_403_RETRIES) {
          console.log(`[WA][${userId}] 403 repeated ${session.retryCount}x — WhatsApp permanently rejected. Stopping reconnect.`);
          closeSocketSafe(sock);
          session.socket = null;
          sessions.delete(userId);
          clearSessionData(userId);
          onDisconnected("WhatsApp ne connection reject kar diya (403). Dobara connect karein.");
          return;
        }
        // Exponential backoff for 403: 10s, 20s, 40s... up to 2 min
        const delay = Math.min(10000 * Math.pow(2, session.retryCount - 1), 120000);
        console.log(`[WA][${userId}] 403 retry ${session.retryCount}/${MAX_403_RETRIES} in ${delay / 1000}s gen=${myGenId}...`);
        session.codeRequested = false;
        setTimeout(async () => {
          if (session.socketGenId !== myGenId) return;
          const currentSession = sessions.get(userId);
          if (!currentSession || currentSession !== session) return;
          try {
            await createSocket(userId, phoneNumber, pairingMode, onCode, onQr, onConnected, onDisconnected, session);
          } catch (e: any) {
            sessions.delete(userId);
            onDisconnected(`Reconnect failed: ${e?.message}`);
          }
        }, delay);
        return;
      }

      // All other close reasons — reconnect after delay with a safety cap
      const MAX_RETRIES = 50;
      session.codeRequested = false;
      session.retryCount++;
      if (session.retryCount > MAX_RETRIES) {
        console.log(`[WA][${userId}] Too many retries (${session.retryCount}) — stopping reconnect to prevent memory leak.`);
        closeSocketSafe(sock);
        session.socket = null;
        sessions.delete(userId);
        onDisconnected("Connection baar baar fail ho raha hai. Dobara connect karein.");
        return;
      }
      // Exponential backoff: 5s → 10s → 20s → max 2 min
      const reconnectDelay = Math.min(5000 * Math.pow(1.5, Math.floor(session.retryCount / 5)), 120000);
      console.log(`[WA][${userId}] Will reconnect in ${reconnectDelay / 1000}s gen=${myGenId}...`);
      setTimeout(async () => {
        if (session.socketGenId !== myGenId) return;
        const currentSession = sessions.get(userId);
        if (!currentSession || currentSession !== session) return;
        try {
          await createSocket(userId, phoneNumber, pairingMode, onCode, onQr, onConnected, onDisconnected, session);
        } catch (e: any) {
          sessions.delete(userId);
          onDisconnected(`Reconnect failed: ${e?.message}`);
        }
      }, reconnectDelay);
    }
  });
}

export async function connectWhatsApp(
  userId: string,
  phoneNumber: string,
  onCode: (code: string) => void,
  onConnected: () => void,
  onDisconnected: (reason: string) => void
): Promise<void> {
  const existing = sessions.get(userId);

  if (existing?.connectLock) {
    console.log(`[WA][${userId}] Connection already in progress, ignoring duplicate`);
    return;
  }

  // Close and remove old session
  if (existing?.socket) {
    closeSocketSafe(existing.socket);
    existing.socket = null;
  }
  sessions.delete(userId);

  const session: WhatsAppSession = {
    socket: null,
    connected: false,
    pairingCode: null,
    qrCode: null,
    qrExpiresAt: null,
    pairingMode: "code",
    connecting: true,
    phoneNumber,
    codeRequested: false,
    wasConnected: false,
    retryCount: 0,
    socketGenId: 0,
    connectLock: true,
  };
  sessions.set(userId, session);

  try {
    await createSocket(userId, phoneNumber, "code", onCode, () => {}, onConnected, onDisconnected, session);
  } finally {
    session.connectLock = false;
  }
}

export async function connectWhatsAppQr(
  userId: string,
  onQr: (qr: string, expiresAt: number) => void,
  onConnected: () => void,
  onDisconnected: (reason: string) => void
): Promise<void> {
  const existing = sessions.get(userId);

  if (existing?.connectLock) {
    console.log(`[WA][${userId}] QR connection already in progress, ignoring duplicate`);
    return;
  }

  if (existing?.socket) {
    closeSocketSafe(existing.socket);
    existing.socket = null;
  }
  sessions.delete(userId);

  const session: WhatsAppSession = {
    socket: null,
    connected: false,
    pairingCode: null,
    qrCode: null,
    qrExpiresAt: null,
    pairingMode: "qr",
    connecting: true,
    phoneNumber: "",
    codeRequested: false,
    wasConnected: false,
    retryCount: 0,
    socketGenId: 0,
    connectLock: true,
  };
  sessions.set(userId, session);

  try {
    await createSocket(userId, "", "qr", () => {}, onQr, onConnected, onDisconnected, session);
  } finally {
    session.connectLock = false;
  }
}

export function getSession(userId: string): WhatsAppSession | undefined {
  return sessions.get(userId);
}

export function isConnected(userId: string): boolean {
  const s = sessions.get(userId);
  return s?.connected === true && s?.socket !== null;
}

export function getConnectedWhatsAppNumber(userId: string): string | null {
  const s = sessions.get(userId);
  if (!s?.connected || !s.socket) return null;

  const savedDigits = s.phoneNumber.replace(/[^0-9]/g, "");
  if (savedDigits.length >= 7) return `+${savedDigits}`;

  const socketUserId = s.socket.user?.id || "";
  const socketDigits = socketUserId.split(":")[0].split("@")[0].replace(/[^0-9]/g, "");
  return socketDigits.length >= 7 ? `+${socketDigits}` : null;
}

// Optional callback that gets invoked whenever a session disconnects.
// Used to push English-language Telegram alerts to the user with their phone number.
let disconnectNotifier: ((userId: string, reason: string, phoneNumber: string | null) => void) | null = null;

export function setDisconnectNotifier(fn: (userId: string, reason: string, phoneNumber: string | null) => void): void {
  disconnectNotifier = fn;
}

export function notifyDisconnect(userId: string, reason: string): void {
  try {
    const phone = getConnectedWhatsAppNumber(userId) ?? sessions.get(userId)?.phoneNumber ?? null;
    disconnectNotifier?.(userId, reason, phone);
  } catch {}
}

export async function restoreWhatsAppSessions(): Promise<void> {
  const storedSessions = await listStoredWhatsAppSessions();
  console.log(`[WA][RESTORE] Found ${storedSessions.length} saved WhatsApp session(s)`);

  for (let _i = 0; _i < storedSessions.length; _i++) {
    const stored = storedSessions[_i];
    if (sessions.has(stored.userId)) continue;
    if (_i > 0) {
      // Memory optimization: stagger restores to avoid RAM spike
      await new Promise((r) => setTimeout(r, 3000));
    }

    const session: WhatsAppSession = {
      socket: null,
      connected: false,
      pairingCode: null,
      qrCode: null,
      qrExpiresAt: null,
      pairingMode: "code",
      connecting: true,
      phoneNumber: stored.phoneNumber,
      codeRequested: false,
      wasConnected: true,
      retryCount: 0,
      socketGenId: 0,
      connectLock: true,
    };

    sessions.set(stored.userId, session);
    try {
      await createSocket(
        stored.userId,
        stored.phoneNumber,
        "code",
        () => {},
        () => {},
        () => console.log(`[WA][RESTORE][${stored.userId}] Session restored`),
        (reason) => {
          console.log(`[WA][RESTORE][${stored.userId}] Restore disconnected: ${reason}`);
          notifyDisconnect(stored.userId, reason);
        },
        session
      );
    } catch (err: any) {
      console.error(`[WA][RESTORE][${stored.userId}] Failed:`, err?.message);
      sessions.delete(stored.userId);
    } finally {
      session.connectLock = false;
    }
  }
}

// Reconnect the existing WhatsApp socket WITHOUT clearing saved credentials.
// Used by the "Session Refresh" feature to force baileys to re-sync the latest
// groups/admin state from WhatsApp servers (helps when the bot was made admin
// in a new group but doesn't see it yet).
export async function refreshWhatsAppSession(
  userId: string,
  onConnected: () => void,
  onError: (reason: string) => void
): Promise<void> {
  const existing = sessions.get(userId);
  if (!existing) {
    onError("No active session found. Please connect WhatsApp first.");
    return;
  }
  if (existing.connectLock) {
    onError("Another connect/refresh is already in progress. Please wait.");
    return;
  }

  const { state } = await useMongoDBAuthState(userId);
  if (!state.creds.registered) {
    onError("Saved credentials are missing — please use Connect WhatsApp instead.");
    return;
  }

  // Close current socket but keep the in-memory session shell so other callers
  // see "connecting" state during the refresh.
  if (existing.socket) {
    closeSocketSafe(existing.socket);
    existing.socket = null;
  }
  existing.connected = false;
  existing.connecting = true;
  existing.connectLock = true;
  existing.retryCount = 0;
  existing.wasConnected = false;

  const phoneNumber = existing.phoneNumber || "";

  try {
    await createSocket(
      userId,
      phoneNumber,
      "code",
      () => {}, // no pairing code expected for already-registered session
      () => {}, // no QR
      () => {
        try { onConnected(); } catch {}
      },
      (reason) => {
        try { onError(reason); } catch {}
      },
      existing,
    );
  } catch (err: any) {
    onError(err?.message || "Refresh failed");
  } finally {
    existing.connectLock = false;
  }
}

export async function disconnectWhatsApp(userId: string): Promise<void> {
  const session = sessions.get(userId);
  if (session) {
    session.socketGenId = -1;
    if (session.socket) {
      try { await session.socket.logout(); } catch {}
      closeSocketSafe(session.socket);
    }
  }
  sessions.delete(userId);
  clearSessionData(userId);
}

export interface GroupResult {
  id: string;
  inviteCode: string;
  addedParticipants?: number;
  participantsFailed?: boolean;
}

export async function createWhatsAppGroup(
  userId: string,
  groupName: string,
  participants: string[] = []
): Promise<GroupResult | null> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return null;

  // Convert phone numbers to JIDs (handles both raw numbers and already-formatted JIDs)
  const jids = participants
    .map(p => p.includes("@") ? p : `${p.replace(/[^0-9]/g, "")}@s.whatsapp.net`)
    .filter(j => j.split("@")[0].length >= 10);

  // Helper to attempt groupCreate with exponential backoff
  async function tryCreate(participantList: string[], attempt = 1): Promise<{ id: string; participants?: boolean } | null> {
    try {
      const group = await session.socket!.groupCreate(groupName, participantList);
      return { id: group.id, participants: participantList.length > 0 };
    } catch (err: any) {
      const msg = err?.message || "";
      console.error(`[WA][${userId}] groupCreate attempt ${attempt} failed:`, msg);
      if (attempt < 3) {
        const delay = attempt * 3000;
        console.log(`[WA][${userId}] Retrying groupCreate in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return tryCreate(participantList, attempt + 1);
      }
      return null;
    }
  }

  // Step 1: Try creating WITH participants (bypasses WhatsApp privacy restrictions at creation time)
  let groupId: string | null = null;
  let participantsFailed = false;

  if (jids.length > 0) {
    const res = await tryCreate(jids);
    if (res) {
      groupId = res.id;
    } else {
      // Step 2: If that failed, try creating WITHOUT participants
      console.log(`[WA][${userId}] Retrying group creation without participants...`);
      await new Promise(r => setTimeout(r, 2000));
      const res2 = await tryCreate([]);
      if (res2) {
        groupId = res2.id;
        participantsFailed = true;
      }
    }
  } else {
    const res = await tryCreate([]);
    if (res) groupId = res.id;
  }

  if (!groupId) return null;

  try {
    const inviteCode = await session.socket.groupInviteCode(groupId);
    return {
      id: groupId,
      inviteCode: `https://chat.whatsapp.com/${inviteCode}`,
      addedParticipants: participantsFailed ? 0 : jids.length,
      participantsFailed,
    };
  } catch (err: any) {
    console.error(`[WA][${userId}] groupInviteCode error:`, err?.message);
    // Group was created but invite code failed — still return without invite link
    return {
      id: groupId,
      inviteCode: "",
      addedParticipants: participantsFailed ? 0 : jids.length,
      participantsFailed,
    };
  }
}

export interface GroupPermissions {
  editGroupInfo: boolean;
  sendMessages: boolean;
  addMembers: boolean;
  approveJoin: boolean;
}

export async function applyGroupSettings(
  userId: string,
  groupId: string,
  perms: GroupPermissions,
  description: string
): Promise<void> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return;
  const sock = session.socket;

  try {
    if (description) await sock.groupUpdateDescription(groupId, description);
  } catch (e: any) { console.error(`[WA][${userId}] desc error:`, e?.message); }

  try {
    await sock.groupSettingUpdate(groupId, perms.editGroupInfo ? "unlocked" : "locked");
  } catch (e: any) { console.error(`[WA][${userId}] editGroupInfo error:`, e?.message); }

  try {
    await sock.groupSettingUpdate(groupId, perms.sendMessages ? "not_announcement" : "announcement");
  } catch (e: any) { console.error(`[WA][${userId}] sendMsg error:`, e?.message); }

  try {
    await (sock as any).groupMemberAddMode(groupId, perms.addMembers ? "all_member_add" : "admin_add");
  } catch (e: any) { console.error(`[WA][${userId}] addMembers error:`, e?.message); }

  try {
    await (sock as any).groupJoinApprovalMode(groupId, perms.approveJoin ? "on" : "off");
  } catch (e: any) { console.error(`[WA][${userId}] approveJoin error:`, e?.message); }
}

export async function setGroupDisappearingMessages(
  userId: string,
  groupId: string,
  duration: number
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.groupToggleEphemeral(groupId, duration);
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] setGroupDisappearingMessages error:`, err?.message);
    return false;
  }
}

export async function setGroupIcon(
  userId: string,
  groupId: string,
  imageBuffer: Buffer
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.updateProfilePicture(groupId, imageBuffer);
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Group icon error:`, err?.message);
    return false;
  }
}

function extractInviteCode(link: string): string {
  const withoutQuery = link.split("?")[0];
  return withoutQuery
    .replace("https://chat.whatsapp.com/", "")
    .replace("http://chat.whatsapp.com/", "")
    .replace(/\/$/, "")
    .trim();
}

export async function joinGroupWithLink(
  userId: string,
  link: string
): Promise<{ success: boolean; groupName?: string; error?: string }> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) {
    return { success: false, error: "WhatsApp not connected" };
  }
  try {
    const code = extractInviteCode(link);
    const result = await session.socket.groupAcceptInvite(code);
    let groupName = "Group";
    if (typeof result === "string" && result) {
      try {
        const metadata = await session.socket.groupMetadata(result);
        groupName = metadata?.subject || result;
      } catch {
        groupName = result;
      }
    }
    return { success: true, groupName };
  } catch (err: any) {
    console.error(`[WA][${userId}] Join group error:`, err?.message);
    return { success: false, error: err?.message || "Failed to join" };
  }
}

function extractNumber(jid: string): string {
  return jid.replace(/:\d+@/, "@").replace(/@.*$/, "").replace(/[^0-9]/g, "");
}

export async function getGroupPendingRequests(
  userId: string,
  groupId: string
): Promise<string[]> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const requests = await session.socket.groupRequestParticipantsList(groupId);
    return requests.map((r: any) => extractNumber(r.jid || "")).filter(Boolean);
  } catch (err: any) {
    console.error(`[WA][${userId}] Pending requests error:`, err?.message);
    return [];
  }
}

// Returns raw normalized JIDs from pending list (preserves @lid or @s.whatsapp.net format)
// Use this for actual approval calls — do NOT reconstruct JIDs from phone numbers
export async function getGroupPendingRequestsJids(
  userId: string,
  groupId: string
): Promise<string[]> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const requests = await session.socket.groupRequestParticipantsList(groupId);
    console.log(`[WA][${userId}] getGroupPendingRequestsJids raw count: ${requests.length}`);
    if (requests.length > 0) {
      console.log(`[WA][${userId}] first pending raw:`, JSON.stringify(requests[0]));
    }
    return requests
      .map((r: any) => {
        const jid: string = r.jid || "";
        // Normalize device suffix (e.g. 91xxx:2@s.whatsapp.net → 91xxx@s.whatsapp.net)
        return jid.replace(/:\d+@/, "@");
      })
      .filter(Boolean);
  } catch (err: any) {
    console.error(`[WA][${userId}] getGroupPendingRequestsJids error:`, err?.message);
    return [];
  }
}

// Returns pending requests with both raw JID (for approval calls) and resolved phone
// (for matching against user-supplied numbers). Handles both @s.whatsapp.net and @lid JIDs.
export async function getGroupPendingRequestsDetailed(
  userId: string,
  groupId: string
): Promise<Array<{ jid: string; phone: string }>> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const requests = await session.socket.groupRequestParticipantsList(groupId);
    if (requests.length > 0) {
      console.log(`[WA][${userId}] getGroupPendingRequestsDetailed first raw:`, JSON.stringify(requests[0]));
    }
    return requests
      .map((r: any) => {
        const rawJid: string = r.jid || "";
        const jid = rawJid.replace(/:\d+@/, "@");
        let phone = "";
        // For @lid jids the local part is NOT a phone number — try the phoneNumber field instead.
        if (jid.endsWith("@lid")) {
          const phoneJid: string = r.phoneNumber || r.phone_number || r.lidPhoneNumber || "";
          phone = extractPhoneFromJid(phoneJid);
        } else {
          phone = extractPhoneFromJid(jid);
        }
        return { jid, phone };
      })
      .filter((x: any) => !!x.jid);
  } catch (err: any) {
    console.error(`[WA][${userId}] getGroupPendingRequestsDetailed error:`, err?.message);
    return [];
  }
}

// Extract the numeric phone from a WhatsApp JID
// "919898989898@s.whatsapp.net" → "919898989898"
// "919898989898:2@s.whatsapp.net" → "919898989898"
function extractPhoneFromJid(jid: string): string {
  if (!jid) return "";
  const stripped = jid.replace(/:\d+@/, "@");
  const [part] = stripped.split("@");
  return /^\d+$/.test(part) ? part : "";
}

// Match a cleaned phone number against a set — tries exact match first,
// then last-10-digit suffix match to handle country code variations
function phoneMatchesSet(phone: string, set: Set<string>): boolean {
  if (set.has(phone)) return true;
  if (phone.length >= 10) {
    const last10 = phone.slice(-10);
    for (const p of set) {
      if (p.endsWith(last10)) return true;
    }
  }
  return false;
}

export async function checkContactsInGroup(
  userId: string,
  groupId: string,
  phoneNumbers: string[]
): Promise<{ inMembers: string[]; inPending: string[]; notFound: string[]; pendingAvailable: boolean; allMemberPhones: Set<string>; allPendingPhones: Set<string> }> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) {
    return { inMembers: [], inPending: [], notFound: phoneNumbers, pendingAvailable: false, allMemberPhones: new Set(), allPendingPhones: new Set() };
  }

  try {
    const [metaResult, pendingResult] = await Promise.allSettled([
      session.socket.groupMetadata(groupId),
      session.socket.groupRequestParticipantsList(groupId),
    ]);

    // Build phone set from member JIDs
    // IMPORTANT: When group uses LID addressing mode, p.id is a LID (not a phone JID).
    // In that case, p.phoneNumber contains the real phone in JID format.
    const memberPhones = new Set<string>();
    if (metaResult.status === "fulfilled") {
      for (const p of metaResult.value.participants) {
        const pId = p.id || "";
        if (pId.endsWith("@lid")) {
          // LID mode — use phoneNumber field for the real phone JID
          const ph = extractPhoneFromJid((p as any).phoneNumber || "");
          if (ph) memberPhones.add(ph);
        } else {
          // Normal phone JID
          const ph = extractPhoneFromJid(pId);
          if (ph) memberPhones.add(ph);
        }
      }
      console.log(`[WA][${userId}] CTC members extracted: ${memberPhones.size} (addressingMode: ${(metaResult.value as any).addressingMode || "pn"})`);
    } else {
      console.error(`[WA][${userId}] groupMetadata failed:`, (metaResult as PromiseRejectedResult).reason?.message);
    }

    // Build phone set from pending request attrs
    // Each item is the raw XML attrs: { jid, add_request_code, time, ... }
    // In LID groups the jid attr may itself be a LID — also check phone_number attr
    const pendingPhones = new Set<string>();
    let pendingAvailable = false;
    if (pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)) {
      pendingAvailable = true;
      const rawList = pendingResult.value as any[];
      console.log(`[WA][${userId}] CTC raw pending count: ${rawList.length}`);
      if (rawList.length > 0) {
        console.log(`[WA][${userId}] CTC first pending item keys:`, Object.keys(rawList[0]).join(", "));
        console.log(`[WA][${userId}] CTC first pending item:`, JSON.stringify(rawList[0]));
      }
      for (const r of rawList) {
        // Try all possible attribute names that could hold the phone/JID
        for (const key of ["jid", "phone_number", "pn", "participant"]) {
          const val = (r as any)[key] || "";
          if (!val) continue;
          const pjid = val.endsWith("@lid") ? "" : val; // skip pure LID values
          const ph = extractPhoneFromJid(pjid);
          if (ph) { pendingPhones.add(ph); break; }
        }
      }
      console.log(`[WA][${userId}] CTC pending phones extracted: ${pendingPhones.size}`);
    } else if (pendingResult.status === "rejected") {
      const err = (pendingResult as PromiseRejectedResult).reason;
      console.warn(`[WA][${userId}] groupRequestParticipantsList failed (need admin + approval mode):`, err?.message);
    }

    console.log(`[WA][${userId}] CTC check — members: ${memberPhones.size}, pending: ${pendingPhones.size}, contacts: ${phoneNumbers.length}`);

    const inMembers: string[] = [];
    const inPending: string[] = [];
    const notFound: string[] = [];

    for (const phone of phoneNumbers) {
      const cleaned = phone.replace(/[^0-9]/g, "");
      if (phoneMatchesSet(cleaned, memberPhones)) {
        inMembers.push(phone);
      } else if (phoneMatchesSet(cleaned, pendingPhones)) {
        inPending.push(phone);
      } else {
        notFound.push(phone);
      }
    }

    return { inMembers, inPending, notFound, pendingAvailable, allMemberPhones: memberPhones, allPendingPhones: pendingPhones };
  } catch (err: any) {
    console.error(`[WA][${userId}] checkContactsInGroup error:`, err?.message);
    return { inMembers: [], inPending: [], notFound: phoneNumbers, pendingAvailable: false, allMemberPhones: new Set(), allPendingPhones: new Set() };
  }
}

export async function getGroupIdFromLink(
  userId: string,
  inviteLink: string
): Promise<{ id: string; subject: string } | null> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return null;
  try {
    const code = extractInviteCode(inviteLink);
    const metadata = await session.socket.groupGetInviteInfo(code);
    return { id: metadata.id, subject: metadata.subject };
  } catch (err: any) {
    console.error(`[WA][${userId}] Group info error:`, err?.message);
    return null;
  }
}

export interface GroupInfo {
  id: string;
  subject: string;
  isAdmin: boolean;
  isMember: boolean;
  participantCount: number;
}

function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, "@").split("@")[0].replace(/[^0-9]/g, "");
}

export async function getAllGroups(userId: string): Promise<GroupInfo[]> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const groups = await session.socket.groupFetchAllParticipating();
    const sock = session.socket;

    const rawMyJid = sock.user?.id || "";
    const myLid = (sock.user as any)?.lid || "";

    const myJidNormalized = rawMyJid ? rawMyJid.replace(/:\d+@/, "@") : "";
    const myLidNormalized = myLid ? myLid.replace(/:\d+@/, "@") : "";
    const myNumber = normalizeJid(rawMyJid) || session.phoneNumber.replace(/[^0-9]/g, "");

    console.log(`[WA][${userId}] getAllGroups: myJid=${myJidNormalized} myLid=${myLidNormalized} myNumber=${myNumber} total=${Object.keys(groups).length}`);

    const result: GroupInfo[] = [];

    for (const [id, meta] of Object.entries(groups)) {
      const participants: any[] = (meta as any).participants || [];
      let isAdmin = false;

      for (const p of participants) {
        const pJid = (p.id || "").replace(/:\d+@/, "@");
        const pLid = ((p as any).lid || "").replace(/:\d+@/, "@");
        const pNumber = normalizeJid(p.id || "");

        const matchByJid = myJidNormalized && pJid && pJid === myJidNormalized;
        const matchByLid = myLidNormalized && pLid && pLid === myLidNormalized;
        const matchByLidCross1 = myLidNormalized && pJid && pJid === myLidNormalized;
        const matchByLidCross2 = myJidNormalized && pLid && pLid === myJidNormalized;
        const matchByNumber = myNumber.length >= 7 && pNumber.length >= 7 && (
          pNumber === myNumber || pNumber.endsWith(myNumber) || myNumber.endsWith(pNumber)
        );

        const isMe = matchByJid || matchByLid || matchByLidCross1 || matchByLidCross2 || matchByNumber;
        if (isMe) {
          isAdmin = p.admin === "admin" || p.admin === "superadmin";
          break;
        }
      }

      result.push({
        id,
        subject: (meta as any).subject || "Unknown",
        isAdmin,
        isMember: true,
        participantCount: participants.length,
      });
    }

    return result;
  } catch (err: any) {
    console.error(`[WA][${userId}] Get all groups error:`, err?.message);
    return [];
  }
}

const FATAL_INVITE_ERRORS = ["not-authorized", "forbidden", "item-not-found", "not-participant", "403", "401"];

function isFatalInviteError(err: any): boolean {
  const msg = (err?.message ?? err?.data ?? String(err)).toLowerCase();
  return FATAL_INVITE_ERRORS.some((e) => msg.includes(e));
}

export async function getGroupInviteLink(userId: string, groupId: string, maxRetries: number = 3): Promise<string | null> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const code = await session.socket.groupInviteCode(groupId);
      if (code) return `https://chat.whatsapp.com/${code}`;
    } catch (err: any) {
      console.error(`[WA][${userId}] Get invite link error for ${groupId} (attempt ${attempt}/${maxRetries}):`, err?.message ?? err?.data);
      if (isFatalInviteError(err)) return null;
    }

    try {
      const meta = await session.socket!.groupMetadata(groupId);
      if (meta && (meta as any).inviteCode) {
        return `https://chat.whatsapp.com/${(meta as any).inviteCode}`;
      }
    } catch (err2: any) {
      console.error(`[WA][${userId}] groupMetadata fallback error for ${groupId} (attempt ${attempt}/${maxRetries}):`, err2?.message ?? err2?.data);
      if (isFatalInviteError(err2)) return null;
    }

    if (attempt < maxRetries) {
      const delay = 1500;
      console.log(`[WA][${userId}] Retrying getGroupInviteLink for ${groupId} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      if (!session.socket || !session.connected) return null;
    }
  }

  return null;
}

export async function leaveGroup(userId: string, groupId: string): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.groupLeave(groupId);
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Leave group error:`, err?.message);
    return false;
  }
}

export interface ParticipantInfo {
  jid: string;
  phone: string; // real phone number — works even in LID mode
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export async function getGroupParticipants(userId: string, groupId: string): Promise<ParticipantInfo[]> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const meta = await session.socket.groupMetadata(groupId);
    return meta.participants.map((p: any) => {
      const jidRaw: string = p.id || "";
      let phone: string;
      if (jidRaw.endsWith("@lid")) {
        // LID mode: p.phoneNumber holds the real phone JID e.g. "919234038011@s.whatsapp.net"
        phone = extractPhoneFromJid((p as any).phoneNumber || "") || extractPhoneFromJid(jidRaw);
      } else {
        phone = extractPhoneFromJid(jidRaw) || "";
      }
      return {
        jid: jidRaw,
        phone,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
        isSuperAdmin: p.admin === "superadmin",
      };
    });
  } catch (err: any) {
    console.error(`[WA][${userId}] Get participants error:`, err?.message);
    return [];
  }
}

export async function getGroupPendingList(
  userId: string
): Promise<Array<{ groupId: string; groupName: string; pendingCount: number }>> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return [];
  try {
    const groups = await session.socket.groupFetchAllParticipating();
    const rawMyJid = session.socket.user?.id || "";
    const myLid = (session.socket.user as any)?.lid || "";
    const myJidNormalized = rawMyJid ? rawMyJid.replace(/:\d+@/, "@") : "";
    const myLidNormalized = myLid ? myLid.replace(/:\d+@/, "@") : "";
    const myNumber = normalizeJid(rawMyJid) || session.phoneNumber.replace(/[^0-9]/g, "");

    console.log(`[WA][${userId}] getGroupPendingList: myJid=${myJidNormalized} myLid=${myLidNormalized} myNumber=${myNumber} total=${Object.keys(groups).length}`);

    const adminGroups: Array<{ id: string; subject: string }> = [];
    for (const [id, meta] of Object.entries(groups)) {
      const participants: any[] = (meta as any).participants || [];
      let isAdmin = false;
      for (const p of participants) {
        const pJid = (p.id || "").replace(/:\d+@/, "@");
        const pLid = ((p as any).lid || "").replace(/:\d+@/, "@");
        const pNumber = normalizeJid(p.id || "");

        const matchByJid    = myJidNormalized && pJid && pJid === myJidNormalized;
        const matchByLid    = myLidNormalized && pLid && pLid === myLidNormalized;
        const matchByLidCross1 = myLidNormalized && pJid && pJid === myLidNormalized;
        const matchByLidCross2 = myJidNormalized && pLid && pLid === myJidNormalized;
        const matchByNumber = myNumber.length >= 7 && pNumber.length >= 7 &&
          (pNumber === myNumber || pNumber.endsWith(myNumber) || myNumber.endsWith(pNumber));

        const isMe = matchByJid || matchByLid || matchByLidCross1 || matchByLidCross2 || matchByNumber;
        if (isMe) {
          isAdmin = p.admin === "admin" || p.admin === "superadmin";
          break;
        }
      }
      if (isAdmin) adminGroups.push({ id, subject: (meta as any).subject || id });
    }
    console.log(`[WA][${userId}] getGroupPendingList: adminGroups=${adminGroups.length}`);

    const results = await Promise.allSettled(
      adminGroups.map(async (g) => {
        try {
          const pending = await session.socket!.groupRequestParticipantsList(g.id);
          return { groupId: g.id, groupName: g.subject, pendingCount: Array.isArray(pending) ? pending.length : 0 };
        } catch {
          return { groupId: g.id, groupName: g.subject, pendingCount: 0 };
        }
      })
    );

    return results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<any>).value);
  } catch (err: any) {
    console.error(`[WA][${userId}] getGroupPendingList error:`, err?.message);
    return [];
  }
}

export async function removeGroupParticipant(
  userId: string,
  groupId: string,
  participantJid: string
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.groupParticipantsUpdate(groupId, [participantJid], "remove");
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Remove participant error:`, err?.message);
    return false;
  }
}

export async function makeGroupAdmin(
  userId: string,
  groupId: string,
  participantJid: string
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.groupParticipantsUpdate(groupId, [participantJid], "promote");
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Make admin error:`, err?.message);
    return false;
  }
}

export async function approveGroupParticipant(
  userId: string,
  groupId: string,
  participantJid: string
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.groupRequestParticipantsUpdate(groupId, [participantJid], "approve");
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Approve participant error:`, err?.message);
    return false;
  }
}

export async function setGroupApprovalMode(
  userId: string,
  groupId: string,
  mode: "on" | "off"
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await (session.socket as any).groupJoinApprovalMode(groupId, mode);
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] Set approval mode error:`, err?.message);
    return false;
  }
}

export async function findParticipantByPhone(
  userId: string,
  groupId: string,
  phoneNumber: string
): Promise<string | null> {
  const participants = await getGroupParticipants(userId, groupId);
  const cleaned = phoneNumber.replace(/[^0-9]/g, "");
  const last10 = cleaned.slice(-10);
  for (const p of participants) {
    const pCleaned = p.phone.replace(/[^0-9]/g, "");
    const pLast10 = pCleaned.slice(-10);
    if (pCleaned === cleaned || (last10.length >= 7 && pLast10 === last10)) {
      return p.jid;
    }
  }
  return null;
}

export async function addGroupParticipant(
  userId: string,
  groupId: string,
  phoneNumber: string
): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) {
    return { success: false, error: "WhatsApp not connected" };
  }
  try {
    const cleaned = phoneNumber.replace(/[^0-9]/g, "");
    const jid = `${cleaned}@s.whatsapp.net`;
    const result = await session.socket.groupParticipantsUpdate(groupId, [jid], "add");
    const status = Array.isArray(result) && result.length > 0 ? (result[0] as any) : null;
    if (status) {
      const statusCode = status.status || status.content?.attrs?.type || "";
      const statusStr = String(statusCode).toLowerCase();
      if (statusStr === "200" || statusStr === "success") {
        return { success: true };
      }
      if (statusStr === "409" || statusStr.includes("conflict") || statusStr.includes("exist")) {
        return { success: false, error: "Already in group" };
      }
      if (statusStr === "403" || statusStr.includes("invite") || statusStr.includes("not-authorized")) {
        return { success: false, error: "Invite required / Cannot add" };
      }
      if (statusStr === "408" || statusStr.includes("recently")) {
        return { success: false, error: "Recently left, cannot add now" };
      }
      if (statusStr === "404" || statusStr.includes("not-exist") || statusStr.includes("not on whatsapp")) {
        return { success: false, error: "Not on WhatsApp" };
      }
      return { success: false, error: `Status: ${statusStr}` };
    }
    return { success: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[WA][${userId}] Add participant error:`, msg);
    if (msg.includes("invite") || msg.includes("not-authorized") || msg.includes("403")) {
      return { success: false, error: "Invite required / Cannot add" };
    }
    return { success: false, error: msg };
  }
}

export async function addGroupParticipantsBulk(
  userId: string,
  groupId: string,
  phoneNumbers: string[]
): Promise<Array<{ phone: string; success: boolean; error?: string }>> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) {
    return phoneNumbers.map(p => ({ phone: p, success: false, error: "WhatsApp not connected" }));
  }
  try {
    const cleanedNumbers = phoneNumbers.map(p => p.replace(/[^0-9]/g, "")).filter(p => p.length >= 10);
    const jids = cleanedNumbers.map(p => `${p}@s.whatsapp.net`);
    let result: any;
    try {
      result = await session.socket.groupParticipantsUpdate(groupId, jids, "add");
    } catch (innerErr: any) {
      console.error(`[WA][${userId}] groupParticipantsUpdate threw:`, innerErr?.message);
      await new Promise((r) => setTimeout(r, 2000));
      result = await session.socket.groupParticipantsUpdate(groupId, jids, "add");
    }
    const results: Array<{ phone: string; success: boolean; error?: string }> = [];
    for (let i = 0; i < cleanedNumbers.length; i++) {
      const status = Array.isArray(result) && result[i] ? (result[i] as any) : null;
      if (status) {
        const statusCode = status.status || status.content?.attrs?.type || "";
        const statusStr = String(statusCode).toLowerCase();
        if (statusStr === "200" || statusStr === "success") {
          results.push({ phone: cleanedNumbers[i], success: true });
        } else if (statusStr === "403" || statusStr.includes("invite") || statusStr.includes("not-authorized")) {
          results.push({ phone: cleanedNumbers[i], success: false, error: "Invite required" });
        } else if (statusStr === "409" || statusStr.includes("exist") || statusStr.includes("conflict")) {
          results.push({ phone: cleanedNumbers[i], success: false, error: "Already in group" });
        } else if (statusStr === "404" || statusStr.includes("not-exist") || statusStr.includes("not on whatsapp")) {
          results.push({ phone: cleanedNumbers[i], success: false, error: "Not on WhatsApp" });
        } else {
          results.push({ phone: cleanedNumbers[i], success: false, error: `Status: ${statusStr}` });
        }
      } else {
        results.push({ phone: cleanedNumbers[i], success: true });
      }
    }
    return results;
  } catch (err: any) {
    console.error(`[WA][${userId}] Bulk add error:`, err?.message);
    return phoneNumbers.map(p => ({ phone: p, success: false, error: err?.message || "Failed" }));
  }
}

export async function isUserInGroup(
  userId: string,
  groupId: string
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    const groups = await session.socket.groupFetchAllParticipating();
    return groupId in groups;
  } catch {
    return false;
  }
}

export async function sendGroupMessage(
  userId: string,
  groupId: string,
  text: string
): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session?.socket || !session.connected) return false;
  try {
    await session.socket.sendMessage(groupId, { text });
    return true;
  } catch (err: any) {
    console.error(`[WA][${userId}] sendGroupMessage error:`, err?.message);
    return false;
  }
}

export function getAutoUserId(userId: string): string {
  return `${userId}_auto`;
}

export function isAutoConnected(userId: string): boolean {
  return isConnected(getAutoUserId(userId));
}

export function getAutoConnectedNumber(userId: string): string | null {
  return getConnectedWhatsAppNumber(getAutoUserId(userId));
}

// Returns all currently active session user IDs (used by cleanup to avoid deleting live sessions)
export function getActiveSessionUserIds(): Set<string> {
  return new Set(sessions.keys());
}
