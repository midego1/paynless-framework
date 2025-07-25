// Import types from the shared location
import type { AiProviderAdapter, ProviderModelInfo, ChatApiRequest, AdapterResponsePayload, ILogger } from '../types.ts';
import type { Database } from '../../types_db.ts';


// Anthropic API constants
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
// It is strongly recommended to use the latest version, check Anthropic docs
const ANTHROPIC_VERSION = '2023-06-01'; 

// Minimal interface for Anthropic Model items
interface AnthropicModelItem {
  id: string;
  name?: string;
  // Add other potential fields if needed
  [key: string]: unknown; // Allow other fields but treat as unknown
}

/**
 * Implements AiProviderAdapter for Anthropic models (Claude).
 */
export class AnthropicAdapter implements AiProviderAdapter {

  constructor(private apiKey: string, private logger: ILogger) {}

  // Hardcoded list as fallback for listModels
  private readonly hardcodedModels: ProviderModelInfo[] = [
      {
        api_identifier: "anthropic-claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: undefined
      },
      {
        api_identifier: "anthropic-claude-3-sonnet-20240229",
        name: "Claude 3 Sonnet",
        description: undefined
      },
      {
        api_identifier: "anthropic-claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
        description: undefined
      }
  ];

  async sendMessage(
    request: ChatApiRequest,
    modelIdentifier: string
  ): Promise<AdapterResponsePayload> {
    this.logger.debug('[AnthropicAdapter] sendMessage called', { modelIdentifier });
    const messagesUrl = `${ANTHROPIC_API_BASE}/messages`;
    const modelApiName = modelIdentifier.replace(/^anthropic-/i, '');
    let systemPrompt = '';
    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    const combinedMessages = [...(request.messages ?? [])];
    if (request.message) {
        combinedMessages.push({ role: 'user', content: request.message });
    }
    const preliminaryMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const message of combinedMessages) {
        if (message.role === 'system' && message.content) {
            systemPrompt = message.content;
        } else if (message.role === 'user' || message.role === 'assistant') {
            preliminaryMessages.push({ role: message.role, content: message.content });
        }
    }
    let expectedRole: 'user' | 'assistant' = 'user';
    for (const message of preliminaryMessages) {
        if (message.role === expectedRole) {
            anthropicMessages.push(message);
            expectedRole = (expectedRole === 'user') ? 'assistant' : 'user';
        } else {
             this.logger.warn(`Skipping message with role '${message.role}' because '${expectedRole}' was expected.`, { currentMessage: message, expectedRole });
        }
    }
     if (anthropicMessages.length === 0) {
        this.logger.error('Anthropic request format error: No valid user/assistant messages found after filtering.', { preliminaryMessages, modelApiName });
        throw new Error('Cannot send request to Anthropic: No valid messages to send.');
     }
    if (anthropicMessages[anthropicMessages.length - 1].role !== 'user') {
        this.logger.error('Anthropic request format error: Last message must be from user after filtering.', { anthropicMessages, modelApiName });
        throw new Error('Cannot send request to Anthropic: message history format invalid.');
    }

    // Determine max_tokens: use request.max_tokens_to_generate if valid, else default to 4096
    const maxTokensForPayload = 
        (request.max_tokens_to_generate && request.max_tokens_to_generate > 0) 
        ? request.max_tokens_to_generate 
        : 4096; // Default if not specified or invalid

    const anthropicPayload = {
      model: modelApiName,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      max_tokens: maxTokensForPayload,
    };
    this.logger.info('Sending request to Anthropic', { url: messagesUrl, modelApiName });
    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicPayload),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`Anthropic API error (${response.status}): ${errorBody}`, { modelApiName, status: response.status });
      throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}`);
    }
    const jsonResponse = await response.json();
    const assistantMessageContent =
        jsonResponse.content?.[0]?.type === 'text'
        ? jsonResponse.content[0].text.trim()
        : '';
    if (!assistantMessageContent) {
        this.logger.error("Anthropic response missing message content:", { response: jsonResponse, modelApiName });
        throw new Error("Received empty response from Anthropic.");
    }
    const tokenUsage: Database['public']['Tables']['chat_messages']['Row']['token_usage'] = jsonResponse.usage ? {
        prompt_tokens: jsonResponse.usage.input_tokens,  
        completion_tokens: jsonResponse.usage.output_tokens, 
        total_tokens: (jsonResponse.usage.input_tokens || 0) + (jsonResponse.usage.output_tokens || 0),
    } : null;

    // Standardize the finish reason from Anthropic's stop_reason
    let finish_reason: AdapterResponsePayload['finish_reason'] = 'unknown';
    if (jsonResponse.stop_reason) {
      switch (jsonResponse.stop_reason) {
        case 'end_turn':
        case 'stop_sequence':
          finish_reason = 'stop';
          break;
        case 'max_tokens':
          finish_reason = 'length';
          break;
        case 'tool_use':
          finish_reason = 'tool_calls';
          break;
        default:
          finish_reason = 'unknown'; // Keep as unknown for any other reason
          break;
      }
    }
    
    // Construct object matching AdapterResponsePayload
    const adapterResponse: AdapterResponsePayload = {
      role: 'assistant', // Explicitly "assistant" as per interface
      content: assistantMessageContent,
      ai_provider_id: request.providerId, // This is the DB ID of the provider
      system_prompt_id: request.promptId !== '__none__' ? request.promptId : null, // DB ID of system prompt
      token_usage: tokenUsage,
      finish_reason: finish_reason, // Pass the standardized reason
    };
    this.logger.debug('[AnthropicAdapter] sendMessage successful', { modelApiName });
    return adapterResponse; // Return the correctly typed object
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const modelsUrl = `${ANTHROPIC_API_BASE}/models`; // Correct endpoint
    this.logger.info("[AnthropicAdapter] Fetching models from Anthropic...", { url: modelsUrl });

    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION, 
      },
    });
    this.logger.debug(`[AnthropicAdapter] After fetch call for models (Status: ${response.status})`);

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`[AnthropicAdapter] Anthropic API error fetching models (${response.status}): ${errorBody}`, { status: response.status });
      // Fallback to hardcoded models if dynamic fetch fails
      // this.logger.warn("[AnthropicAdapter] Dynamic model fetch failed, returning hardcoded models as fallback.");
      // return this.hardcodedModels;
      throw new Error(`Anthropic API request failed fetching models: ${response.status} ${response.statusText}`);
    }

    const jsonResponse = await response.json();
    this.logger.debug("[AnthropicAdapter] After response.json() call for models");
    
    // Assuming response structure has a 'data' array based on docs
    if (!jsonResponse?.data || !Array.isArray(jsonResponse.data)) {
        this.logger.error("[AnthropicAdapter] listModels response missing or invalid 'data' array:", { response: jsonResponse });
        // Fallback to hardcoded models if dynamic fetch fails
        // this.logger.warn("[AnthropicAdapter] Dynamic model data invalid, returning hardcoded models as fallback.");
        // return this.hardcodedModels;
        throw new Error("Invalid response format received from Anthropic models API.");
    }

    const models: ProviderModelInfo[] = jsonResponse.data.map((item: AnthropicModelItem) => ({
        // Prepend 'anthropic-' for consistency with other adapters/DB entries
        api_identifier: `anthropic-${item.id}`,
        name: item.name || item.id, // Use name if available, fallback to id
        description: undefined // API does not provide description, use undefined
    }));

    this.logger.info(`[AnthropicAdapter] Found ${models.length} models from Anthropic dynamically.`);
    return models;
  }
}