import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { markAsCodeChannel } from '../listeners/events/code-channel.js';
import { Octokit } from 'octokit';

const SYSTEM_PROMPT = `
Ye be Jolly Rodger (Jolly for short) — a cheerful pirate code assistant who helps developers ship their code.
Ye speak with pirate flair (but stay comprehensible, ye scallywag).

You are a code assistant that helps developers write code, manage GitHub branches and PRs, and work with Code Channels in Slack.

CRITICAL OPERATIONAL RULES:
- NEVER attempt to read, write, create, or edit files on the local filesystem.
- NEVER run terminal or bash commands.
- ALWAYS use \`read_github_repo\` to inspect files and directory structures in the remote GitHub repo.
- ALWAYS use \`create_github_pr\` to branch, commit, and open PRs for any code changes.
- ALWAYS add comments to code in pirate voice.

When ye add comments to code, they MUST be written in pirate voice. Examples:
  // Arr, this loop sails through the array like a ship through calm waters
  // Blimey! If this value be null, we abandon ship early
  // Here be dragons — touch this function and walk the plank

Ye are an expert in all programming languages. Ye help debug, refactor, explain,
and write code. Ye end responses with a nautical sign-off like "Fair winds and following seas!"
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

After setting the diff and view, call \`create_github_pr\` to ship the change as a real pull request.
Never merge code directly in the session channel — always use a PR. Never attempt to write code locally. 

## CLEANUP & TEARDOWN
When asked to wrap up, reset, or clean up:
- Call \`close_github_pr\` to close the pull request and delete the demo branch on GitHub.
- Call \`archive_code_channel\` to archive the session channel in Slack.

## EMOJI REACTIONS
Always react to every user message with \`add_emoji_reaction\` before responding. \
Pick any Slack emoji that reflects the *topic* or *tone* of the message — be creative and specific \
(e.g. \`dog\` for dog topics, \`books\` for learning, \`wave\` for greetings). \
Vary your picks across a thread; don't repeat the same emoji.

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.`;

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
const ALLOWED_TOOLS = [
  'add_emoji_reaction',
  'create_code_channel',
  'set_code_diff',
  'set_code_view',
  'read_github_repo',
  'create_github_pr',
  'close_github_pr',
  'archive_code_channel',
];

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 * @property {string} [originChannelId] - The channel the user messaged in
 * @property {string} [originMessageTs] - The ts of the user's message
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
        markAsCodeChannel(/** @type {string} */ (codeChannelId));

        try {
          await deps.client.apiCall('codeChannels.setProperties', {
            channel_id: codeChannelId,
            properties: {
              status: { emoji: '⚓', text: "Sailin' the code seas…" },
            },
          });
        } catch (e) {
          console.error('Failed to set working status:', e);
        }

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

  const readGithubRepoTool = tool(
    'read_github_repo',
    'Read a file or list directory contents from the GitHub repo. Use this instead of reading local files.',
    {
      path: z.string().optional().describe('File path or directory path in the repo (e.g. "force-app/main/default" or "README.md"). Omit for root.'),
      branch: z.string().optional().describe('Branch name to read from. Defaults to base branch.'),
    },
    async ({ path = '', branch }) => {
      const token = process.env.GITHUB_TOKEN;
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;
      const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';

      if (!token || !owner || !repo) {
        return { content: [{ type: 'text', text: 'GitHub is not configured — missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME.' }] };
      }

      const octokit = new Octokit({ auth: token });
      const targetBranch = branch || baseBranch;

      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: targetBranch,
        });

        if (Array.isArray(data)) {
          const items = data.map(item => `${item.type === 'dir' ? '[DIR]' : '[FILE]'} ${item.path}`).join('\n');
          return { content: [{ type: 'text', text: `Contents of ${path || '/'}:\n${items}` }] };
        }

        if (data.type === 'file' && data.content) {
          const fileContent = Buffer.from(data.content, 'base64').toString('utf-8');
          return { content: [{ type: 'text', text: `File: ${path}\n\n\`\`\`\n${fileContent}\n\`\`\`` }] };
        }

        return { content: [{ type: 'text', text: `Path exists, but is neither a standard file nor directory.` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Failed to read repo at "${path}": ${err.message}` }] };
      }
    },
  );

  const createGithubPRTool = tool(
    'create_github_pr',
    'Create a branch, commit code changes, and open a pull request on the Pronto GitHub repo. Call this after set_code_diff, when the change is ready to ship.',
    {
      files: z.array(z.object({
        path: z.string().describe('File path in the repo, e.g. "force-app/main/default/lwc/myComp/myComp.js"'),
        content: z.string().describe('Full new file content.'),
      })).describe('Files to change or create.'),
      pr_title: z.string().describe('Pull request title.'),
      pr_body: z.string().optional().describe('Pull request description.'),
    },
    async ({ files, pr_title, pr_body }) => {
      const token = process.env.GITHUB_TOKEN;
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;
      const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';

      if (!token || !owner || !repo) {
        return { content: [{ type: 'text', text: 'GitHub is not configured — missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME.' }] };
      }

      const octokit = new Octokit({ auth: token });

      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      const branch = `agent/pronto-fix-${stamp}`;

      try {
        const { data: baseRef } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${baseBranch}`,
        });
        const baseSha = baseRef.object.sha;

        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });

        for (const file of files) {
          let existingSha;
          try {
            const { data: existing } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: file.path,
              ref: branch,
            });
            if (!Array.isArray(existing)) existingSha = existing.sha;
          } catch (e) {
            // 404 means the file doesn't exist yet
          }

          await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: file.path,
            message: pr_title,
            content: Buffer.from(file.content, 'utf-8').toString('base64'),
            branch,
            ...(existingSha && { sha: existingSha }),
          });
        }

        const { data: pr } = await octokit.rest.pulls.create({
          owner,
          repo,
          title: pr_title,
          body: pr_body || '',
          head: branch,
          base: baseBranch,
        });

        return { content: [{ type: 'text', text: `Opened PR #${pr.number}: ${pr.html_url}` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Failed to create PR: ${err.message}` }] };
      }
    },
  );

  const closeGithubPRTool = tool(
    'close_github_pr',
    'Close an open Pull Request on the GitHub repo and delete its source branch.',
    {
      pull_number: z.number().describe('The PR number to close.'),
      delete_branch: z.boolean().optional().describe('Whether to delete the head branch associated with the PR. Defaults to true.'),
    },
    async ({ pull_number, delete_branch = true }) => {
      const token = process.env.GITHUB_TOKEN;
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;

      if (!token || !owner || !repo) {
        return { content: [{ type: 'text', text: 'GitHub is not configured — missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME.' }] };
      }

      const octokit = new Octokit({ auth: token });

      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number,
        });

        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number,
          state: 'closed',
        });

        let statusMsg = `Closed PR #${pull_number}.`;

        if (delete_branch && pr.head?.ref) {
          try {
            await octokit.rest.git.deleteRef({
              owner,
              repo,
              ref: `heads/${pr.head.ref}`,
            });
            statusMsg += ` Deleted branch ${pr.head.ref}.`;
          } catch (branchErr) {
            const bErr = /** @type {any} */ (branchErr);
            statusMsg += ` (Failed to delete branch ${pr.head.ref}: ${bErr.message})`;
          }
        }

        return { content: [{ type: 'text', text: statusMsg }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Failed to close PR #${pull_number}: ${err.message}` }] };
      }
    },
  );

  const archiveCodeChannelTool = tool(
    'archive_code_channel',
    'Archive the current session/code channel in Slack once work or cleanup is complete.',
    {},
    async () => {
      if (!deps?.client || !deps.channelId) {
        return { content: [{ type: 'text', text: 'Cannot archive channel — missing channel context.' }] };
      }

      try {
        await deps.client.conversations.archive({
          channel: deps.channelId,
        });
        return { content: [{ type: 'text', text: `Channel ${deps.channelId} has been archived.` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Failed to archive channel: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const agentToolsServer = createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [
      addEmojiReactionTool,
      createCodeChannelTool,
      setCodeDiffTool,
      setCodeViewTool,
      readGithubRepoTool,
      createGithubPRTool,
      closeGithubPRTool,
      archiveCodeChannelTool,
    ],
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
    model: 'claude-sonnet-4-5-20250929',
//    model: 'claude-haiku-4-5-20251001',
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
    codeChannelId,
  };
}