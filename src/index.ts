import { getConfig } from "./config.js";
import type { RocketChatConfig } from "./types/types.js";

const configvars = getConfig();
import { rcSendMessage } from "./rcAPI.js";

const logger = {
    info: (msg: string) => console.log(`[RC] ${msg}`),
    error: (msg: string) => console.error(`[RC] ${msg}`),
    warn: (msg: string) => console.warn(`[RC] ${msg}`),
    debug: (msg: string) => console.log(`[RC][DEBUG] ${msg}`),
};

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

async function handleWebhook(api: any, req: any, res: any): Promise<void> {
    const startTime = Date.now();
    try {
        let body: any;
        try {
            if (req.body && Object.keys(req.body).length > 0) {
                body = req.body;
            } else {
                const rawBody = await new Promise<string>((resolve, reject) => {
                    let data = "";
                    req.on("data", (chunk: any) => { data += chunk; });
                    req.on("end", () => resolve(data));
                    req.on("error", reject);
                });
                body = rawBody ? JSON.parse(rawBody) : {};
            }
        } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
        }

        if (!body.channel_id && !config.defaultRoom) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No target room specified" }));
            return;
        }

        if (body.bot === true || body.user_id === config.userId) {
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, skipped: "bot" }));
            return;
        }

        if (!(body.text ?? "").trim()) {
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, skipped: "empty" }));
            return;
        }

        // const roomId = body.channel_id || config.defaultRoom;
        // const scheduleFn = api.session?.workflow?.scheduleSessionTurn ?? api.scheduleSessionTurn;

       const roomId = body.channel_id || config.defaultRoom;

try {
    const result = await api.runtime.agent.runEmbeddedAgent({
    agentId: "main",
    sessionKey: `agent:main:rocketchat:group:${roomId}`,
    text: body.text ?? "",
    channel: "rocketchat",
    accountId: "default",
    to: roomId,
    from: body.user_name ?? "unknown",
    workspaceDir: "/home/dodaa08/.openclaw/workspace",
});
    logger.info(`[Webhook] Agent ran: ${JSON.stringify(result)}`);
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true }));
    return;
} catch (err) {
    logger.error(`[Webhook] runEmbeddedAgent failed: ${(err as Error).message}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Agent failed", detail: (err as Error).message }));
    return;
}

        // res.statusCode = 500;
        // res.end(JSON.stringify({ error: "No dispatch API available" }));

    } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "Internal Server Error", detail: (err as Error).message }));
    }
}

export default function register(api: any): void {
    // logger.info(JSON.stringify(Object.keys(api.runtime?.agent ?? {})));
logger.info(JSON.stringify(Object.keys(api.runtime?.agent ?? {})));
logger.info(`runEmbeddedAgent type: ${typeof api.runtime?.agent?.runEmbeddedAgent}`);

    api.registerChannel({
        plugin: {
            id: "rocketchat-webhook",
            meta: {
                id: "rocketchat-webhook",
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

           outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }: { to: string }) => ({
        ok: true,
        to: to || config.defaultRoom,
    }),
    async sendText({ to, text }: { to?: string; text: string }) {
        return rcSendMessage(to || config.defaultRoom, text);
    },
},
           
            message: {
                adapter: {
                    send: {
                        text: async (params: any) => {
                           
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
                 
                    ctx.setStatus({ accountId, state: "connected" });
                    return new Promise(() => {}); // Keep alive
                },
            },
        },
    });

  
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
    if (api.on) {
        api.on("message_received", (event: any, ctx: any) => {
            logger.info(`[Hook] message_received event: ${JSON.stringify({
                content: event.content?.slice(0, 50),
                from: event.from,
                to: event.to,
                channel: event.channel,
            })}`);
        });
       
    }

}