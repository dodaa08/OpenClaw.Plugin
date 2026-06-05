import { getConfig } from "./config.js";
import type { RocketChatConfig } from "./types/types.js";

const configvars = getConfig();

const config: RocketChatConfig = {
    url: configvars.url || "http://localhost:3000",
    authToken: configvars.authToken || "ctY0f1vXHW3BLZGZiHN72m2X2QCmK_i7Vu3bDydCp07",
    userId: configvars.userId || "zHpQPbfjD9rEjyT92",
    defaultRoom: configvars.defaultRoom || "69c3a5f48b90145d5886b115",
    webhookSecret: configvars.webhookSecret || "my_secret_token",
};

// --- Rocket.Chat API Client ---
export async function rcSendMessage(
    roomId: string, 
    text: string, 
    threadId?: string | null
): Promise<{ messageId: string }> {
    const payload: any = {
        message: {
            rid: roomId,
            msg: text,
        }
    };
    
    if (threadId) {
        payload.message.tmid = String(threadId);
    }


    const res = await fetch(`${config.url}/api/v1/chat.sendMessage`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Auth-Token": config.authToken,
            "X-User-Id": config.userId,
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Rocket.Chat API error ${res.status}: ${body}`);
    }

    const data : any = await res.json();
    const messageId = data.message?._id || `rc_${Date.now()}`;
    // logger.debug(`[RC API] Success — messageId: ${messageId}`);
    return { messageId };
}