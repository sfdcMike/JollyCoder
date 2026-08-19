import { runAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';
import { isCodeChannel, markAsCodeChannel } from './code-channel.js';

// Dedupe: Slack redelivers app_mention for the same message when it gets
// edited afterward (e.g. to add the "Started a session in #channel" unfurl).
// Track which (channel, ts) pairs we've already started processing so those
// redeliveries don't spawn duplicate code channels.
const processedMentions = new Set();

export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  const mentionKey = event.channel + ':' + event.ts;
  if (processedMentions.has(mentionKey)) {
    logger.debug(`Skipping duplicate/redelivered app_mention for ${mentionKey}`);
    return;
  }
  processedMentions.add(mentionKey);

  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs = event.thread_ts || event.ts;
  const channelId = event.channel;
  const userId = /** @type {string} */ (context.userId);

  if (!text) {
    await say({ text: "Arr, what can I do for ye, matey? 🏴‍☠️", thread_ts: threadTs });
    return;
  }

  await setStatus({
    status: 'Thinking\u2026',
    loading_messages: [
      'Wondering why my boat has so many sails…',
      'Getting Polly a cracker. This bird is so needy.',
      'Asking a mermaid for advice.',
      'Feeling some scurvy coming on…',
      'Land-ho! Oh wait, its just a big wave.',
      'All the rats left. How odd.',
      'You know, the plank is really just decor.',
      'I put a mop on me peg-leg. Innovation.',
      "Captain's log: consultin' the seastars.",
    ],
  });

  try {
    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // If this mention is happening *inside* a code channel Jolly already
    // created, don't let the agent create another one — that's the
    // mirrored-origin loop. Omit the origin fields so create_code_channel
    // has nothing to work with.
    const alreadyInCodeChannel = isCodeChannel(channelId);

    const deps = {
      client,
      userId,
      channelId,
      threadTs,
      messageTs: event.ts,
      userToken: context.userToken,
      originChannelId: alreadyInCodeChannel ? null : channelId,
      originMessageTs: alreadyInCodeChannel ? null : event.ts,
    };

    const { responseText, sessionId: newSessionId, codeChannelId } = await runAgent(
      text,
      existingSessionId ?? undefined,
      deps,
    );

    if (codeChannelId) {
      markAsCodeChannel(codeChannelId);
      // Agent created a session channel — post response there, clear status
      await client.chat.postMessage({ channel: codeChannelId, text: responseText });
      try {
        await client.apiCall('codeChannels.setProperties', {
          channel_id: codeChannelId,
          properties: { status: { emoji: '✅', text: 'Done' } },
        });
      } catch (e) {
        // Non-fatal — this is just a cosmetic status badge.
        logger.debug(`Failed to set "Done" status on ${codeChannelId}: ${e}`);
      }
    } else {
      // Conversational — reply in thread as before
      const streamer = sayStream();
      await streamer.append({ markdown_text: responseText });
      await streamer.stop({ blocks: buildFeedbackBlocks() });
    }

    if (newSessionId) sessionStore.setSession(channelId, threadTs, newSessionId);
  } catch (e) {
    logger.error(`Failed to handle app mention: ${e}`);
    await say({ text: `:warning: Something went wrong! (${e})`, thread_ts: threadTs });
  }
}