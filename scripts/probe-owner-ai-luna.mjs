import { pathToFileURL } from 'node:url';

const model = 'gpt-6-luna';
const maxOutputTokens = 64;
const request = {
  model,
  input: 'This is a synthetic connectivity check. Return the connection status as connected.',
  reasoning: { effort: 'none' },
  max_output_tokens: maxOutputTokens,
  store: false,
  stream: false,
  tools: [],
  tool_choice: 'none',
  text: {
    format: {
      type: 'json_schema',
      name: 'owner_ai_luna_connection',
      strict: true,
      schema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['connected'] } },
        required: ['status'],
        additionalProperties: false,
      },
    },
  },
};

function verifiedUsage(result) {
  if (
    result?.status !== 'completed' ||
    (result.model !== model && !/^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(result.model)) ||
    !Array.isArray(result.output)
  )
    return null;

  const messages = result.output.filter((item) => item?.type !== 'reasoning');
  const message = messages[0];
  if (
    messages.length !== 1 ||
    message?.type !== 'message' ||
    message.role !== 'assistant' ||
    message.status !== 'completed' ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  )
    return null;

  const content = message.content[0];
  if (content?.type !== 'output_text' || typeof content.text !== 'string') return null;
  const acknowledgement = JSON.parse(content.text);
  if (acknowledgement?.status !== 'connected' || Object.keys(acknowledgement).length !== 1) {
    return null;
  }

  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  } = result.usage ?? {};
  if (
    ![inputTokens, outputTokens, totalTokens].every(
      (count) => Number.isSafeInteger(count) && count > 0,
    ) ||
    outputTokens > maxOutputTokens ||
    totalTokens !== inputTokens + outputTokens
  )
    return null;

  return { inputTokens, outputTokens, totalTokens };
}

export async function runLunaAccessProbe({ args, env, fetchImpl = fetch }) {
  if (args.length !== 1 || args[0] !== '--run-approved-probe') return { status: 'disabled', model };

  const apiKey = env.OWNER_AI_OPENAI_API_KEY?.trim();
  const project = env.OWNER_AI_OPENAI_PROJECT_ID?.trim();
  if (!apiKey || !project) return { status: 'configuration_required', model };

  const signal = AbortSignal.timeout(5_000);
  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Project': project,
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal,
    });
    if (!response.ok) return { status: 'request_failed', model };

    const usage = verifiedUsage(await response.json());
    return usage ? { status: 'verified', model, usage } : { status: 'invalid_response', model };
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError') return { status: 'timed_out', model };
    if (error instanceof SyntaxError) return { status: 'invalid_response', model };
    return { status: 'request_failed', model };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runLunaAccessProbe({ args: process.argv.slice(2), env: process.env });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'verified' ? 0 : 1;
}
