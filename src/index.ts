import { getConfig } from "./config.js";
import type { RocketChatConfig } from "./types/types.js";

const configvars = getConfig();

// let pluginApi: any;
// --- Logger ---
const logger = {
    info: (msg: string) => console.log(`[RC] ${msg}`),
    error: (msg: string) => console.error(`[RC] ${msg}`),
    warn: (msg: string) => console.warn(`[RC] ${msg}`),
    debug: (msg: string) => console.log(`[RC][DEBUG] ${msg}`),
};

// --- Config ---
const config: RocketChatConfig = {
    url: configvars.url || "http://localhost:3000",
    authToken: configvars.authToken || "ctY0f1vXHW3BLZGZiHN72m2X2QCmK_i7Vu3bDydCp07",
    userId: configvars.userId || "zHpQPbfjD9rEjyT92",
    defaultRoom: configvars.defaultRoom || "69c3a5f48b90145d5886b115",
    webhookSecret: configvars.webhookSecret || "my_secret_token",
};

if (!config.webhookSecret) {
    logger.warn("[RC Config] Warning: RC_WEBHOOK_SECRET is not set — webhook auth disabled.");
}
if (!config.authToken) {
    logger.warn("[RC Config] Warning: RC_AUTH_TOKEN is not set.");
}
if (!config.userId) {
    logger.warn("[RC Config] Warning: RC_USER_ID is not set.");
}

// --- Rocket.Chat API Client ---
async function rcSendMessage(
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

    logger.debug(`[RC API] POST ${config.url}/api/v1/chat.sendMessage`);
    logger.debug(`[RC API] roomId: ${roomId}, threadId: ${threadId}, text: ${text.slice(0, 60)}...`);

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
    logger.debug(`[RC API] Success — messageId: ${messageId}`);
    return { messageId };
}

// --- Inbound Webhook Handler ---
async function handleWebhook(api: any, req: any, res: any): Promise<void> {
    logger.info(`[Webhook] api.runtime.channel keys: ${Object.keys(api.runtime.channel).join(", ")}`);
    logger.info(`[Webhook] api.runtime.channel.inbound keys: ${api.runtime.channel.inbound ? Object.keys(api.runtime.channel.inbound).join(", ") : "undefined"}`);

    const startTime = Date.now();

    try {
        // --- Parse body ---
        let body: any;
        try {
            if (req.body && Object.keys(req.body).length > 0) {
                body = req.body;
                logger.debug("[Webhook] Body parsed from req.body");
            } else {
                logger.debug("[Webhook] Reading raw body stream...");
                const rawBody = await new Promise<string>((resolve, reject) => {
                    let data = "";
                    req.on("data", (chunk: any) => { data += chunk; });
                    req.on("end", () => resolve(data));
                    req.on("error", reject);
                });
                logger.debug(`[Webhook] Raw body length: ${rawBody.length}`);
                body = rawBody ? JSON.parse(rawBody) : {};
            }
        } catch (parseErr) {
            logger.error(`[Webhook] Body parse error: ${(parseErr as Error).message}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
        }

        // --- Validate payload ---
        if (!body.channel_id && !config.defaultRoom) {
            logger.error("[Webhook] ❌ No channel_id in payload and no defaultRoom configured!");
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No target room specified" }));
            return;
        }

        // --- Log payload ---
        logger.info("[Webhook] ═══════════════════════════════════════════");
        logger.info(`[Webhook] user_id:      ${body.user_id ?? "N/A"}`);
        logger.info(`[Webhook] user_name:    ${body.user_name ?? "N/A"}`);
        logger.info(`[Webhook] channel_id:   ${body.channel_id ?? "N/A"}`);
        logger.info(`[Webhook] text:         ${(body.text ?? "").slice(0, 100)}${(body.text?.length > 100 ? "..." : "")}`);

        // --- Skip bot/self messages ---
        if (body.bot === true || body.user_id === config.userId) {
            logger.info("[Webhook] ⏭️ Skipping bot/self message");
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, skipped: "bot" }));
            return;
        }

        // --- Skip empty messages ---
        const text = body.text ?? "";
        if (!text.trim()) {
            logger.info("[Webhook] ⏭️ Skipping empty text message");
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, skipped: "empty" }));
            return;
        }

        const roomId = body.channel_id || config.defaultRoom;
        const threadId = body.tmid ?? null;

        // --- Try modern API first ---
        if (api.runtime?.channel?.inbound?.run) {
            logger.info("[Webhook] 🚀 Using api.runtime.channel.inbound.run");

            try {
                // CORRECT WAY TO CALL inbound.run
                const result = await api.runtime.channel.inbound.run({
                    channel: "rocketchat",
                    accountId: "default",
                    message: {
                        body: body,
                        rawBody: body,
                        to: roomId,
                        from: body.user_name
                    }
                }, {
                    ingest: (raw: any) => {
                        return {
                            kind: "message",
                            id: raw.message_id ?? `${Date.now()}`,
                            rawText: raw.text ?? "",
                            textForAgent: raw.text ?? "",
                            textForCommands: raw.text ?? "",
                            from: raw.user_name ?? "unknown",
                            to: raw.channel_id ?? config.defaultRoom,
                            threadId: raw.tmid ?? null,
                            raw: raw
                        };
                    },
                    resolveTurn: (input: any) => {
                        const resolvedRoomId = input?.to ?? roomId;
                        if (!resolvedRoomId) {
                            throw new Error(`No roomId! input.to=${input?.to}, roomId=${roomId}`);
                        }
                        return {
                            channel: "rocketchat",
                            accountId: "default",
                            to: resolvedRoomId,
                            from: input?.from ?? body.user_name ?? "unknown",
                            threadId: input?.threadId ?? threadId,
                            delivery: {
                                deliver: async (payload: any) => {
                                    const replyText = payload.text ?? "Test reply";
                                    logger.info(`[Delivery] 💬 Sending reply to ${resolvedRoomId}: ${replyText}`);
                                    const result = await rcSendMessage(resolvedRoomId, replyText, input?.threadId);
                                    return result;
                                },
                            },
                        };
                    },
                });

                logger.info(`[Webhook] ✅ Dispatched successfully in ${Date.now() - startTime}ms`);
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, dispatched: "runtime.channel.inbound.run" }));
                return;
            } catch (dispatchErr) {
                logger.error(`[Webhook] runtime.channel.inbound.run failed: ${(dispatchErr as Error).message}`);
            }
        }

        // --- Fallback to legacy API ---
        if (api.scheduleSessionTurn) {
            logger.warn("[Webhook] ⚠️ Falling back to api.scheduleSessionTurn...");
            try {
                await api.scheduleSessionTurn({
                    channel: "rocketchat",
                    accountId: "default",
                    to: roomId,
                    from: body.user_name ?? "unknown",
                    text: body.text ?? "",
                    threadId: threadId,
                    messageId: body.message_id ?? `msg_${Date.now()}`,
                });
                logger.info("[Webhook] ✅ scheduleSessionTurn dispatched successfully");
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, dispatched: "scheduleSessionTurn" }));
                return;
            } catch (ssErr) {
                logger.error(`[Webhook] scheduleSessionTurn failed: ${(ssErr as Error).message}`);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "Fallback dispatch failed", detail: (ssErr as Error).message }));
                return;
            }
        }

        // --- No working API ---
        logger.error("[Webhook] ❌ No working dispatch API available!");
        res.statusCode = 500;
        res.end(JSON.stringify({
            error: "No dispatch API available",
            available: {
                runtimeChannelInboundRun: !!api.runtime?.channel?.inbound?.run,
                scheduleSessionTurn: !!api.scheduleSessionTurn,
            }
        }));

    } catch (err) {
        logger.error(`[Webhook] 💥 FATAL ERROR: ${(err as Error).message}`);
        logger.error(`[Webhook] Stack: ${(err as Error).stack}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "Internal Server Error", detail: (err as Error).message }));
    }
}
// --- Main Plugin Export ---
export default function register(api: any): void {
    // pluginApi = api;
    logger.info("╔══════════════════════════════════════════════════════╗");
    logger.info("║  Rocket.Chat Unified Plugin — Initializing...        ║");
    logger.info("╚══════════════════════════════════════════════════════╝");
    logger.info(`[Config] RC_URL:          ${config.url}`);
    logger.info(`[Config] RC_USER_ID:      ${config.userId || "NOT SET"}`);
    logger.info(`[Config] RC_AUTH_TOKEN:   ${config.authToken ? config.authToken.slice(0, 6) + "..." : "NOT SET"}`);
    logger.info(`[Config] DEFAULT_ROOM:    ${config.defaultRoom || "NOT SET"}`);
    logger.info(`[Config] WEBHOOK_SECRET:  ${config.webhookSecret ? "SET" : "NOT SET"}`);

    // --- Log available APIs at startup ---
    logger.info("[Init] Checking OpenClaw API surface...");
    logger.info(`[Init] api.runtime?.channel?.inbound?.run: ${!!api.runtime?.channel?.inbound?.run}`);
    logger.info(`[Init] api.scheduleSessionTurn: ${!!api.scheduleSessionTurn}`);
    logger.info(`[Init] api.registerHook: ${!!api.registerHook}`);
    logger.info(`[Init] api.on: ${!!api.on}`);
    logger.info(`[Init] api.registerHttpRoute: ${!!api.registerHttpRoute}`);

    // --- Register Channel Plugin ---
    api.registerChannel({
        plugin: {
            id: "rocketchat",
            meta: {
                id: "rocketchat",
                label: "Rocket.Chat",
                selectionLabel: "Rocket.Chat",
                blurb: "Unified Rocket.Chat Plugin with Inbound Webhook and Outbound REST",
                aliases: ["rc"],
            },
            capabilities: { 
                chatTypes: ["direct", "group"],
                supports: { mentions: true },
            },
            config: {
                listAccountIds: (_cfg: any) => ["default"],
                resolveAccount: (_cfg: any, accountId?: string) => ({
                    accountId: accountId || "default",
                }),
            },
            // --- Modern outbound structure per SDK spec ---
            outbound: {
                attachedResults: {
                    sendText: async (params: any) => {
                        logger.info(`[sendText] 📤 CALLED — to: ${params.to}, text: ${params.text?.slice(0, 50)}...`);
                        try {
                            const result = await rcSendMessage(params.to, params.text, params.threadId);
                            logger.info(`[sendText] ✅ SUCCESS — messageId: ${result.messageId}`);
                            return result;
                        } catch (err) {
                            logger.error(`[sendText] ❌ FAILED: ${(err as Error).message}`);
                            throw err;
                        }
                    },
                },
                base: {
                    sendMedia: async (params: any) => {
                        logger.info(`[sendMedia] Not implemented — to: ${params.to}`);
                        throw new Error("Media sending not implemented");
                    },
                },
            },
            // --- Message adapter (modern SDK) ---
            // This bridges inbound → outbound for core-managed replies
            message: {
                adapter: {
                    send: {
                        text: async (params: any) => {
                            logger.info(`[MessageAdapter] 📤 send.text — to: ${params.to}`);
                            const result = await rcSendMessage(params.to, params.text, params.threadId);
                            return {
                                receipt: {
                                    messageId: result.messageId,
                                    channel: "rocketchat",
                                    conversationId: params.to,
                                },
                            };
                        },
                    },
                },
            },
            gateway: {
                startAccount: async (ctx: any) => {
                    const accountId = ctx.account?.accountId ?? "default";
                    logger.info(`[Gateway] Starting account: ${accountId}`);
                    ctx.setStatus({ accountId, state: "connected" });
                    return new Promise(() => {}); // Keep alive
                },
            },
        },
    });

    // --- Register HTTP Webhook Route ---
    if (api.registerHttpRoute) {
        api.registerHttpRoute({
            method: "POST",
            path: "/rocketchat/webhook",
            auth: "plugin",
            handler: async (req: any, res: any) => {
                await handleWebhook(api, req, res);
            },
        });
        logger.info("🌐 Registered webhook at POST /rocketchat/webhook");
    } else {
        logger.error("❌ api.registerHttpRoute NOT AVAILABLE — webhook will not work!");
    }

    // --- Register message_received hook as workaround (may not work due to OpenClaw bug) ---
    // Using api.on instead of api.registerHook per bug report: api.on works, registerHook doesn't
    if (api.on) {
        api.on("message_received", (event: any, ctx: any) => {
            logger.info(`[Hook] message_received event: ${JSON.stringify({
                content: event.content?.slice(0, 50),
                from: event.from,
                to: event.to,
                channel: event.channel,
            })}`);
        });
        logger.info("🔔 Registered api.on('message_received') observer");
    }

    logger.info("✅ Rocket.Chat Plugin initialization complete.");
    logger.info("═══════════════════════════════════════════════════════");
}