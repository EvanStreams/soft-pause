import "dotenv/config";
import { App, SocketModeReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  trackThread,
  isTrackedThread,
  recordPost,
  getTotalPosts,
  getPostsToday,
  hasPostedBefore,
} from "./db";

const DAILY_LIMIT = 2;
const TOTAL_LIMIT = 3;

const THREAD_MESSAGE =
  "This thread limits each person to 2 replies per day and 3 replies total. Make it count.";

const FIRST_POST_MESSAGE =
  "Remember, you get 2 replies per day and 3 total. Messages over the limit will disappear.";

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
  await ack();

  const channelId = view.private_metadata;
  const userId = body.user.id;
  const richText = view.state.values.message_block.message_input.rich_text_value!;

  const attribution: any = {
    type: "rich_text_section",
    elements: [
      { type: "text", text: "\n\nSent by " },
      { type: "user", user_id: userId },
    ],
  };
  const blocks = [{ ...richText, elements: [...richText.elements, attribution] }];

  const result = await client.chat.postMessage({
    channel: channelId,
    blocks,
    text: "New Soft Pause thread",
    metadata: {
      event_type: "soft_pause_thread",
      event_payload: { creator: userId },
    },
  });

  const threadTs = result.ts!;

  trackThread(threadTs, channelId, userId);

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: THREAD_MESSAGE,
  });
});

app.event("message", async ({ event, client }) => {
  const msg = event as any;

  const allowedSubtypes = new Set(["thread_broadcast", "file_share"]);
  if (msg.subtype && !allowedSubtypes.has(msg.subtype)) return;
  if (!msg.thread_ts || msg.bot_id) return;
  if (!isTrackedThread(msg.thread_ts, msg.channel)) return;

  const threadTs = msg.thread_ts;
  const channelId = msg.channel;
  const userId = msg.user;

  const isFirstPost = !hasPostedBefore(threadTs, channelId, userId);
  const totalPosts = getTotalPosts(threadTs, channelId, userId);
  const postsToday = getPostsToday(threadTs, channelId, userId);

  if (totalPosts >= TOTAL_LIMIT) {
    try { await userClient.chat.delete({ channel: channelId, ts: msg.ts }); } catch {}
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: userId,
      text: `Your message was removed — you've used all ${TOTAL_LIMIT} of your replies in this thread.`,
    });
    return;
  }

  if (postsToday >= DAILY_LIMIT) {
    try { await userClient.chat.delete({ channel: channelId, ts: msg.ts }); } catch {}
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: userId,
      text: `Your message was removed — you've used your ${DAILY_LIMIT} replies for today in this thread. Come back tomorrow!`,
    });
    return;
  }

  recordPost(threadTs, channelId, userId);

  if (isFirstPost) {
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: userId,
      text: FIRST_POST_MESSAGE,
    });
  }
});

(async () => {
  await app.start();
  console.log("Soft Pause is running");
})();
