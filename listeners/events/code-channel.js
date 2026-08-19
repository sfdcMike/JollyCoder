import { runAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';

// Tracks channel IDs that Jolly created as code channels.
// Used to prevent nested/looping code channel creation when Slack
// mirrors the origin mention into the new channel and re-triggers app_mention.
const createdChannelIds = new Set();

export function isCodeChannel(channelId) {
  return createdChannelIds.has(channelId);
}

export function markAsCodeChannel(channelId) {
  createdChannelIds.add(channelId);
}

/**
  * Create a session channel from an app_mention or channel message,
  * run the agent inside it, and archive when done.
  * @param {import('@slack/bolt').App} app
  * @param {object} args
  * @param {import('@slack/web-api').WebClient} args.client
  * @param {object} args.event
  * @param {object} args.context
  * @param {import('@slack/bolt').Logger} args.logger
  * @returns {Promise<void>}
 */
export async function createAndRunCodeChannel({ client, event, context, logger }) {
  const originChannelId = event.channel;

  if (isCodeChannel(originChannelId)) {
    logger.debug(`Skipping nested code channel creation triggered from ${originChannelId}`);
    return;
  }

  const originMessageTs = event.ts;
  const threadTs = event.thread_ts || event.ts;
  const userId = /** @type {string} */ (context.userId);
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) return;

  let codeChannelId;

  try {
    const createResp = await client.apiCall('codeChannels.create', {
      origin_channel_id: originChannelId,
      origin_message_ts: originMessageTs,
    });

    codeChannelId = /** @type {any} */ (createResp).channel_id;
    markAsCodeChannel(codeChannelId);
    logger.debug(`Session channel created: ${codeChannelId}`);
  } catch (e) {
    logger.error(`Failed to create session channel: ${e}`);
    await client.chat.postMessage({
      channel: originChannelId,
      thread_ts: threadTs,
      text: `:warning: Couldn't create a session channel: ${e}`,
    });
    return;
  }

  try {
    await client.apiCall('codeChannels.setProperties', {
      channel_id: codeChannelId,
      properties: {
        status: {
          emoji: '⚓',
          text: "Sailin' the code seas…",
        },
      },
    });

    const existingSessionId = sessionStore.getSession(originChannelId, threadTs);

    const deps = {
      client,
      userId,
      channelId: codeChannelId,
      threadTs: null,
      messageTs: originMessageTs,
      userToken: context.userToken,
    };
    const { responseText, sessionId: newSessionId } = await runAgent(text, existingSessionId ?? undefined, deps);

    await client.chat.postMessage({
      channel: codeChannelId,
      text: responseText,
    });

    if (newSessionId) {
      sessionStore.setSession(originChannelId, threadTs, newSessionId);
    }

    await client.apiCall('codeChannels.setProperties', {
      channel_id: codeChannelId,
      properties: { status: { emoji: '', text: '' } },
    });
  } catch (e) {
    logger.error(`Agent failed in session channel: ${e}`);
    await client.chat.postMessage({
      channel: codeChannelId,
      text: `:warning: Something went wrong! (${e})`,
    });
  }
}

/**
  * Handle message_stream_stopped — archive the session channel.
  * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message_stream_stopped'>} args
  * @returns {Promise<void>}
 */
export async function handleMessageStreamStopped({ client, event, logger }) {
  const channelId = /** @type {any} */ (event).channel;
  if (!channelId) return;

  try {
    await client.apiCall('codeChannels.archive', { channel_id: channelId });
    logger.debug(`Session channel archived: ${channelId}`);
  } catch (e) {
    logger.error(`Failed to archive session channel: ${e}`);
  }
}