import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { markAsCodeChannel } from '../listeners/events/code-channel.js';

const SYSTEM_PROMPT = `
Ye be Jolly Rodger — a cheerful pirate code assistant who helps developers ship their code.
Ye speak with pirate flair (but stay comprehensible, ye scallywag).

When ye add comments to code, they MUST be written in pirate voice. Examples:
  // Arr, this loop sails through the array like a ship through calm waters
  // Blimey! If this value be null, we abandon ship early
  // Here be dragons — touch this function and walk the plank

Ye are an expert in all programming languages. Ye help debug, refactor, explain,
and write code. Ye always add comments in pirate style when touching any code.
Ye end responses with a nautical sign-off like "Fair winds and following seas!"
or "Now hoist the mainsail and ship it, matey!"

## PERSONALITY
- You are fundamentally helpful and loving. You want the best for everyone. You believe that kindness will rule the day.
- Friendly pirate, helpful pirate, and approachable pirate — ye be a code mate, not a code overlord
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time, lest ye be marooned on the Isle of Confusion
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max — be punchy, scannable, and actionable
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji entertainingly — but not in code comments or code blocks

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points for multi-step instructions

## SESSION CHANNELS
Ye have the power to open a Session Channel — a dedicated space for focused code work.

ALWAYS call \`create_code_channel\` before writing, modifying, generating, or reviewing
any code. This includes:
- Writing new functions, classes, or files
- Refactoring or editing existing code
- Debugging (when you need to show fixed code)
- Adding comments to code
- Code reviews where you produce a revised version

Do NOT create a session channel for:
- Purely conversational questions ("what does this do?", "explain X to me")
- Answering questions without producing code
- General chat

If \`create_code_channel\` reports a channel was already created, DO NOT call it
again — continue the work assuming that channel is ready.

When ye call \`create_code_channel\`, do it FIRST — before any other response.
Ye will continue working in the session channel once it's created.

After the session channel is open, ALWAYS call \`set_code_diff\` with the unified diff of any
code ye change, and call \`set_code_view\` to render an HTML preview whenever the work has a
visual result (a page, component, or report).

## EMOJI REACTIONS
Always react to every user message with \`add_emoji_reaction\` before responding. \
Pick any Slack emoji that reflects the *topic* or *tone* of the message — be creative and specific \
(e.g. \`dog\` for dog topics, \`books\` for learning, \`wave\` for greetings). \
Vary your picks across a thread; don't repeat the same emoji.

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.

Available capabilities:
- **Search**: Search messages and files across public channels, search for channels by name
- **Read**: Read channel message history, read thread replies, read canvas documents
- **Write**: Send messages, create draft messages, schedule messages for later
- **Canvases**: Create, read, and update Slack canvas documents

Use these tools when they can help answer a question or complete a task — for example, \
searching for relevant messages, checking a channel for context, or creating a canvas. \
Also use them when the user explicitly asks you to perform a Slack action.`;

const EMOJI_DESCRIPTION =
  "Add an emoji reaction to the user's current message to acknowledge the topic.\n\n" +
  'Use any standard Slack emoji that matches the topic or tone of the message. ' +
  'Be creative and specific — if someone mentions a dog, use `dog`; if they sound ' +
  'frustrated, use `sweat_smile`. The examples below are common picks, not the full set:\n' +
  '- Gratitude/praise: pray, bow, blush, sparkles, star-struck, heart\n' +
  '- Frustration/confusion: thinking_face, face_with_monocle, sweat_smile, upside_down_face\n' +
  '- Something broken: wrench, hammer_and_wrench, mag\n' +
  '- Performance/slow: hourglass_flowing_sand, snail\n' +
  '- Urgency: rotating_light, zap, fire\n' +
  '- Success/celebration: tada, raised_hands, partying_face, rocket, muscle\n' +
  '- Setup/config: gear, package\n' +
  '- Network/connectivity: satellite, signal_strength\n' +
  '- Agreement/acknowledgment: thumbsup, ok_hand, saluting_face, +1';

/** @type {string[]} */
const ALLOWED_TOOLS = ['add_emoji_reaction', 'create_code_channel', 'set_code_diff', 'set_code_view'];

const SLACK_MCP_URL = '<https://mcp.slack.com/mcp>';

/**
  * @typedef {Object} AgentDeps
  * @property {import('@slack/web-api').WebClient} client
  * @property {string} userId
  * @property {string} channelId
  * @property {string} threadTs
  * @property {string} messageTs
  * @property {string} [userToken]
  * @property {string} [originChannelId]   - The channel the user messaged in
  * @property {string} [originMessageTs]   - The ts of the user's message
 */

/**
  * Run the agent with the given text and optional session ID.
  * @param {string} text - The user's message text.
  * @param {string} [sessionId] - An existing session ID to resume conversation.
  * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
  * @returns {Promise<{responseText: string, sessionId: string | null, codeChannelId: string | null}>}
 */
export async function runAgent(text, sessionId = undefined, deps = undefined) {
  /** @type {string | null} */
  let codeChannelId = null;

  const addEmojiReactionTool = tool(
    'add_emoji_reaction',
    EMOJI_DESCRIPTION,
    { emoji_name: z.string().describe("The Slack emoji name without colons (e.g. 'tada', 'wrench', 'pray').") },
    async ({ emoji_name }) => {
      if (!deps) return { content: [{ type: 'text', text: 'No deps available.' }] };

      if (Math.random() < 0.15) {
        return { content: [{ type: 'text', text: `Skipped :${emoji_name}: reaction (randomly omitted)` }] };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: emoji_name,
        });
        return { content: [{ type: 'text', text: `Reacted with :${emoji_name}:` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not add reaction: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const createCodeChannelTool = tool(
    'create_code_channel',
    'Create a Session Channel for focused code work. Call this before writing, modifying, or reviewing any code.',
    {
      title: z.string().describe('A short title for the session channel describing the work, e.g. "Refactor auth middleware"'),
    },
    async ({ title }) => {
        console.log('>>> create_code_channel called. title=', title, 'current codeChannelId=', codeChannelId, 'originChannelId=', deps?.originChannelId);
      // Idempotency guard: never create more than one channel per agent run,
      // even if the model retries after perceiving the first call failed.
      if (codeChannelId) {
        console.log('>>> BLOCKED — already have a channel');
        return { content: [{ type: 'text', text: `A session channel was already created: ${codeChannelId}. Continue working there — do not call create_code_channel again.` }] };
      }

      if (!deps?.client || !deps.originChannelId || !deps.originMessageTs) {
        return { content: [{ type: 'text', text: 'Cannot create session channel — missing context.' }] };
      }

      try {
        const resp = await deps.client.apiCall('codeChannels.create', {
          origin_channel_id: deps.originChannelId,
          origin_message_ts: deps.originMessageTs,
          title,
        });

        codeChannelId = /** @type {any} */ (resp).channel_id;

        // Mark this channel as a code channel immediately, synchronously,
        // before any other await — closes the timing gap that let Slack's
        // mirrored origin-context mention re-trigger app_mention inside the
        // new channel and spawn another one.
        markAsCodeChannel(/** @type {string} */ (codeChannelId));

        // Set a working status
        try {
          await deps.client.apiCall('codeChannels.setProperties', {
            channel_id: codeChannelId,
            properties: {
              status: { emoji: '⚓', text: "Sailin' the code seas…" },
            },
          });
        } catch (e) {
        // Non-fatal — status is cosmetic, don't let it break the flow.
          console.error('Failed to set working status:', e);
        }
        // Update deps so subsequent tool calls (reactions, etc.) target the new channel,
        // and clear origin fields so a repeat create_code_channel call in this same
        // run has nothing to act on even if the guard above were ever bypassed.
        deps.channelId = /** @type {string} */ (codeChannelId);
        deps.originChannelId = undefined;
        deps.originMessageTs = undefined;

        return { content: [{ type: 'text', text: `Session channel created: ${codeChannelId}` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Failed to create session channel: ${err.message}` }] };
      }
    },
  );

const setCodeDiffTool = tool(
  'set_code_diff',
  'Set or update the unified diff shown in the session channel\'s code tab. Call this after writing or changing code, passing a standard `git diff`-style unified diff.',
  {
    content: z.string().describe('Unified diff content (git diff / diff -u format).'),
    base_branch: z.string().optional().describe('Base branch name for display.'),
    head_branch: z.string().optional().describe('Head branch name for display.'),
  },
  async ({ content, base_branch, head_branch }) => {
    if (!deps?.client || !deps.channelId) {
      return { content: [{ type: 'text', text: 'Cannot set diff — no session channel yet.' }] };
    }
    try {
      const resp = await deps.client.apiCall('codeChannels.setDiff', {
        channel: deps.channelId,
        content,
        base_branch,
        head_branch,
      });
      return { content: [{ type: 'text', text: `Diff updated (version ${resp.diff_file_version}).` }] };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { content: [{ type: 'text', text: `Failed to set diff: ${err.data?.error || err.message}` }] };
    }
  },
);

const setCodeViewTool = tool(
  'set_code_view',
  'Create or update an HTML render tab in the session channel showing a live preview, report, or dashboard. Content must be a full self-contained HTML document.',
  {
    view_key: z.string().describe('Stable key for this view, e.g. the file path being previewed.'),
    content: z.string().describe('Full self-contained HTML document to render.'),
    label: z.string().optional().describe('Display label for the tab.'),
  },
  async ({ view_key, content, label }) => {
    if (!deps?.client || !deps.channelId) {
      return { content: [{ type: 'text', text: 'Cannot set view — no session channel yet.' }] };
    }
    try {
      const resp = await deps.client.apiCall('codeChannels.setView', {
        channel: deps.channelId,
        view_key,
        content,
        label,
      });
      return { content: [{ type: 'text', text: `View updated: ${resp.view_id} (version ${resp.content_version}).` }] };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { content: [{ type: 'text', text: `Failed to set view: ${err.data?.error || err.message}` }] };
    }
  },
);

  const agentToolsServer = createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [addEmojiReactionTool, createCodeChannelTool, setCodeDiffTool, setCodeViewTool],
  });

  /** @type {Record<string, any>} */
  const mcpServers = { 'agent-tools': agentToolsServer };
  const allowedTools = [...ALLOWED_TOOLS];

  if (deps?.userToken) {
    mcpServers['slack-mcp'] = {
      type: 'http',
      url: SLACK_MCP_URL,
      headers: { Authorization: `Bearer ${deps.userToken}` },
    };
    allowedTools.push('mcp__slack-mcp__*');
  }

  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers,
    allowedTools,
    permissionMode: 'bypassPermissions',
    ...(sessionId && { resume: sessionId }),
  };

  const responseParts = [];
  let newSessionId = null;

  for await (const message of query({ prompt: text, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseParts.push(block.text);
        }
      }
    }
    if (message.type === 'result') {
      newSessionId = message.session_id;
    }
  }

  return {
    responseText: responseParts.join('\n'),
    sessionId: newSessionId,
    codeChannelId,  // null if no session channel was created
  };
}