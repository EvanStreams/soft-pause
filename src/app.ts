import "dotenv/config";
import { App, SocketModeReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  trackThread,
  isTrackedThread,
  claimMessage,
  recordPost,
  getTotalPosts,
  getPostsToday,
  hasPostedBefore,
} from "./db.js";

const REQUIRED_ENV = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_USER_TOKEN",
];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

// Any uncaught error leaves state in doubt, so exit and let the container restart.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

const DAILY_LIMIT = 2;
const TOTAL_LIMIT = 3;

const THREAD_MESSAGE =
  "This thread limits each person to 2 replies per day and 3 replies total. Make it count.";

const FIRST_POST_MESSAGE =
  "Remember, you get 2 replies per day and 3 total. Messages over the limit will disappear.";

// Message subtypes that carry user-authored replies and must be counted.
const COUNTED_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);

const receiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN!,
  clientPingTimeout: 30000,
  serverPingTimeout: 30000,
});

const userClient = new WebClient(process.env.SLACK_USER_TOKEN);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
});

app.error(async (error) => {
  console.error("Unhandled Bolt error:", error);
});

let ownBotId: string | undefined;

// Deletes run one at a time; each caller gets whether its own delete succeeded.
let deleteChain: Promise<unknown> = Promise.resolve();

function removeMessage(msg: any): Promise<boolean> {
  const run = deleteChain.then(async () => {
    if (msg.subtype === "file_share") {
      for (const file of msg.files ?? []) {
        try {
          await userClient.files.delete({ file: file.id });
        } catch (e: any) {
          console.error(`Failed to delete file ${file.id}:`, e?.data?.error ?? e);
        }
      }
    }
    try {
      await userClient.chat.delete({ channel: msg.channel, ts: msg.ts });
      return true;
    } catch (e: any) {
      console.error(`Failed to delete message ${msg.ts}:`, e?.data?.error ?? e);
      return false;
    }
  });
  deleteChain = run.catch(() => {});
  return run;
}

app.command("/softpause", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "soft_pause_compose",
      private_metadata: body.channel_id,
      title: { type: "plain_text", text: "Soft Pause" },
      submit: { type: "plain_text", text: "Post" },
      blocks: [
        {
          type: "input",
          block_id: "message_block",
          element: {
            type: "rich_text_input",
            action_id: "message_input",
          },
          label: { type: "plain_text", text: " " },
        },
      ],
    },
  });
});

app.view("soft_pause_compose", async ({ ack, body, view, client }) => {
  const richText = view.state.values.message_block.message_input.rich_text_value;
  if (!richText?.elements?.length) {
    await ack({
      response_action: "errors",
      errors: { message_block: "Write something before posting." },
    });
    return;
  }
  await ack();

  const channelId = view.private_metadata;
  const userId = body.user.id;

  const attribution: any = {
    type: "rich_text_section",
    elements: [
      { type: "text", text: "\n\nSent by " },
      { type: "user", user_id: userId },
    ],
  };
  const blocks = [{ ...richText, elements: [...richText.elements, attribution] }];

  let result;
  try {
    result = await client.chat.postMessage({
      channel: channelId,
      blocks,
      text: "New Soft Pause thread",
      metadata: {
        event_type: "soft_pause_thread",
        event_payload: { creator: userId },
      },
    });
  } catch (e: any) {
    console.error(`Failed to post in ${channelId}:`, e?.data?.error ?? e);
    // The modal has already closed, so tell the author by DM what went wrong.
    await client.chat
      .postMessage({
        channel: userId,
        text: `Your Soft Pause could not be posted in <#${channelId}>: ${e?.data?.error ?? "unknown error"}`,
      })
      .catch((dmError) => console.error("Failed to DM author:", dmError));
    return;
  }

  const threadTs = result.ts!;

  trackThread(threadTs, channelId, userId);

  try {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: THREAD_MESSAGE,
    });
  } catch (e: any) {
    console.error(`Failed to post rules in ${channelId}:`, e?.data?.error ?? e);
  }
});

app.event("message", async ({ event, client }) => {
  const msg = event as any;

  if (msg.subtype && !COUNTED_SUBTYPES.has(msg.subtype)) return;
  if (!msg.thread_ts || !msg.ts) return;
  // Skip this app's own posts (the rules notice); other bots are limited like users.
  if (msg.bot_id && msg.bot_id === ownBotId) return;
  if (!isTrackedThread(msg.thread_ts, msg.channel)) return;
  if (!claimMessage(msg.channel, msg.ts)) return;

  const threadTs = msg.thread_ts;
  const channelId = msg.channel;
  const userId: string | undefined = msg.user;
  const limitedId = userId ?? `bot:${msg.bot_id}`;
  if (!userId && !msg.bot_id) return;

  const isFirstPost = !hasPostedBefore(threadTs, channelId, limitedId);
  const totalPosts = getTotalPosts(threadTs, channelId, limitedId);
  const postsToday = getPostsToday(threadTs, channelId, limitedId);

  if (totalPosts >= TOTAL_LIMIT || postsToday >= DAILY_LIMIT) {
    const removed = await removeMessage(msg);
    if (!userId) return;

    const reason =
      totalPosts >= TOTAL_LIMIT
        ? `you've used all ${TOTAL_LIMIT} of your replies in this thread.`
        : `you've used your ${DAILY_LIMIT} replies for today in this thread. Come back tomorrow!`;
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: userId,
      text: removed
        ? `Your message was removed — ${reason}`
        : `Your message is over the limit — ${reason} It could not be removed automatically; please ask an admin.`,
    });
    return;
  }

  recordPost(threadTs, channelId, limitedId);

  if (isFirstPost && userId) {
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: userId,
      text: FIRST_POST_MESSAGE,
    });
  }
});

(async () => {
  ownBotId = (await app.client.auth.test()).bot_id;
  await app.start();
  console.log("Soft Pause is running");
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
