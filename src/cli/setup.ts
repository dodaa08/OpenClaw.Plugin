import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loginAs, createBotUser, getUserByUsername, createDirectMessage, sendMessage, isServerReachable } from "./admin-api.js";
import { updateConfig } from "./config-updater.js";
import type { RCLoginResult } from "../types/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");

function prompt(question: string, fallback?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = fallback ? ` [${fallback}]` : "";
    rl.question(`  ${bold(cyan(question))}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback || "");
    });
  });
}

function promptPassword(question: string, hint = " (Ctrl+R to reveal)"): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    const label = `  ${bold(cyan(question))}${dim(hint)}: `;
    stdout.write(label);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let password = "";
    let revealed = false;

    const redraw = () => {
      const display = revealed ? password : "*".repeat(password.length);
      stdout.write(`\r${label}${display}\x1b[K`);
    };

    const onData = (data: Buffer) => {
      const bytes = [...data];

      if (bytes[0] === 0x1b) return;

      if (bytes[0] === 0x12) {
        revealed = !revealed;
        redraw();
        return;
      }

      if (bytes[0] === 0x0d || bytes[0] === 0x0a) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdout.write("\n");
        resolve(password);
        return;
      }

      if (bytes[0] === 0x03) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        process.exit(1);
        return;
      }

      if (bytes[0] === 0x7f || bytes[0] === 0x08) {
        if (password.length > 0) {
          password = password.slice(0, -1);
          if (revealed) redraw();
          else stdout.write("\b \b");
        }
        return;
      }

      password += data.toString("utf-8");
      if (revealed) redraw();
      else stdout.write("*");
    };

    stdin.on("data", onData);
  });
}

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code: number | number[], s: string): string {
  if (!supportsColor) return s;
  const open = Array.isArray(code) ? code.map((c) => `\x1b[${c}m`).join("") : `\x1b[${code}m`;
  return `${open}${s}\x1b[0m`;
}
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);
const cyan = (s: string) => paint(36, s);
const bold = (s: string) => paint(1, s);
const dim = (s: string) => paint(2, s);

function info(msg: string) { console.log(`  ${dim(msg)}`); }
function ok(msg: string) { console.log(`  ${bold(green("OK"))}  ${msg}`); }
function fail(msg: string) { console.log(`  ${bold(red("ERR"))} ${msg}`); }

function heading(n: number, title: string) {
  console.log(`\n${bold(cyan(`Step ${n}:`))} ${bold(title)}`);
}

function isNetworkError(e: any): boolean {
  const code = e?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  if (e?.message && e.message.includes("fetch failed")) return true;
  return e?.cause ? isNetworkError(e.cause) : false;
}

async function main() {
  console.log(`\n  ${bold(cyan("OpenClaw Rocket.Chat Setup"))}\n`);

  heading(1, "Rocket.Chat Connection");
  const rcUrl = await prompt("Rocket.Chat URL", "http://localhost:3000");
  const adminUser = await prompt("Admin username");
  let adminPass = await promptPassword("Admin password");

  info("Checking server...");
  if (!(await isServerReachable(rcUrl))) {
    fail(`Cannot reach Rocket.Chat at ${rcUrl}`);
    info("Make sure the server is running and the URL is correct, then try again.");
    process.exit(1);
  }

  info("Logging in...");
  let adminAuth: RCLoginResult;
  let adminLoggedIn = false;
  for (let attempts = 0; attempts < 3 && !adminLoggedIn; attempts++) {
    try {
      adminAuth = await loginAs(rcUrl, adminUser, adminPass);
      adminLoggedIn = true;
      ok(`Logged in as ${adminUser}`);
    } catch (e: any) {
      if (isNetworkError(e)) {
        fail(`Cannot reach Rocket.Chat at ${rcUrl}`);
        info("Make sure the server is running and the URL is correct, then try again.");
        process.exit(1);
      }
      const remaining = 2 - attempts;
      if (remaining > 0) {
        fail(`Login failed: ${e.message}`);
        adminPass = await promptPassword(`Admin password (${remaining} attempt${remaining === 1 ? "" : "s"} left)`);
      } else {
        fail(`Login failed after 3 attempts: ${e.message}`);
        process.exit(1);
      }
    }
  }
  if (!adminLoggedIn || !adminAuth!) { process.exit(1); }

  heading(2, "Bot User");
  let useExisting = false;
  for (;;) {
    const botMode = (await prompt("Create your bot credentials? (new/existing)", "new"))
      .toLowerCase();
    if (botMode === "new" || botMode === "n" || botMode === "") {
      useExisting = false;
      break;
    }
    if (botMode === "existing" || botMode === "e" || botMode === "old") {
      useExisting = true;
      break;
    }
    fail(`"${botMode}" is not a valid choice — enter "new" or "existing".`);
  }

  if (useExisting) {
    info("You'll log in with an existing bot — no new account will be created.");
  } else {
    info("A new bot account will be created if it doesn't already exist.");
  }

  const botUsername = await prompt("Bot username", "rocketbot");
  if (!botUsername) { fail("Bot username is required"); process.exit(1); }

  let botName = botUsername;
  let botEmail = `${botUsername.toLowerCase()}@openclaw.local`;
  let botPassword = "";

  if (useExisting) {
    botPassword = await promptPassword("Bot password");
    if (!botPassword) { fail("Password is required to log in"); process.exit(1); }
  } else {
    botName = await prompt("Bot display name", botUsername);
    botEmail = await prompt("Bot email", botEmail);
    for (let attempts = 0; attempts < 2; attempts++) {
      botPassword = await promptPassword(attempts === 0 ? "Bot password" : "Bot password (min 6 chars)");
      if (!botPassword) { fail("Password is required"); }
      else if (botPassword.length < 6) { fail("Password must be at least 6 characters"); }
      else break;
    }
    if (!botPassword || botPassword.length < 6) { fail("Exiting — valid password required"); process.exit(1); }
  }

  info("Checking if bot already exists...");
  let botUser: { _id: string; username: string; name: string };
  const existing = await getUserByUsername(rcUrl, adminAuth, botUsername);

  if (existing) {
    ok(`Bot "${botUsername}" already exists (${existing._id}) -- reusing`);
    botUser = existing;
  } else if (useExisting) {
    fail(`Bot "${botUsername}" not found — cannot use existing credentials for a missing bot`);
    process.exit(1);
  } else {
    info("Creating bot...");
    try {
      botUser = await createBotUser(rcUrl, adminAuth, {
        username: botUsername, name: botName, password: botPassword, email: botEmail,
      });
      ok(`Created bot: ${botUser.username} (${botUser._id})`);
    } catch (e: any) {
      fail(`Failed: ${e.message}`);
      process.exit(1);
    }
  }

  info("Getting bot auth token...");
  let botAuth: RCLoginResult;
  try {
    botAuth = await loginAs(rcUrl, botUsername, botPassword);
    ok("Bot token obtained");
  } catch (e: any) {
    fail(`Bot login failed: ${e.message}`);
    process.exit(1);
  }

  heading(3, "Welcome Message");
  let dmRoomId = "";
  try {
    info("Creating DM channel...");
    dmRoomId = await createDirectMessage(rcUrl, adminAuth, botUsername);
    await sendMessage(rcUrl, botAuth, dmRoomId, "OpenClaw is connected! Restart OpenClaw (openclaw restart) then send me a message to start chatting.");
    ok(`Welcome message sent to @${botUsername}`);
  } catch (e: any) {
    info(`Welcome message skipped: ${e.message}`);
  }

  heading(4, "Save & Configure");

  try {
    updateConfig({
      pluginPath: PLUGIN_PATH,
      pluginId: "rocketchat",
      accountId: "main",
      serverUrl: rcUrl,
      transport: { mode: "polling" },
      mentionNames: [botUsername],
      auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
    });
    ok("Updated ~/.openclaw/openclaw.json (plugin paths + channel config)");
  } catch (e: any) {
    info(`Skipped openclaw.json update: ${e.message}`);
  }

  console.log(`\n${bold(green("Done!"))}`);
  console.log(`\n  ${bold("Credentials stored:")}
    - Admin & bot passwords: NOT saved anywhere (used only during setup to log in)
    - Bot access token + user ID: saved to ${dim("~/.openclaw/openclaw.json")}
      (used by OpenClaw to authenticate as the bot — keep this file private)

  ${bold("Next steps:")}
    1. Restart OpenClaw to activate the new bot:   ${cyan("openclaw restart")}
    2. Message ${bold("@" + botUsername)} in Rocket.Chat
  `);
}

main().catch((e) => { console.error("\nSetup failed:", e.message ?? e); process.exit(1); });
