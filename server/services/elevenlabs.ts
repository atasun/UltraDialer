'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { Request } from "express";
import { ExternalServiceError } from '../utils/errors';
import { withServiceErrorHandling, wrapServiceError } from '../utils/service-error-wrapper';
import { getCorrelationHeaders } from '../middleware/correlation-id';
import { getAppointmentToolForAgent } from './appointment-elevenlabs-tool';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// ElevenLabs requires mixed API versions:
// - v1 for /convai/agents endpoints (agent management)
// - v2 for /voices endpoint (voice fetching)
const ELEVENLABS_V1_BASE_URL = "https://api.elevenlabs.io/v1";
const ELEVENLABS_V2_BASE_URL = "https://api.elevenlabs.io/v2";

// In-memory cache for workspace tool IDs 
// Keyed by "{apiKeyPrefix}:{toolName}" to prevent cross-workspace confusion
const workspaceToolCache = new Map<string, string>();

/**
 * Generate a cache key that's unique per API key (workspace)
 */
function getToolCacheKey(apiKey: string, toolName: string): string {
  // Use first 8 chars of API key as workspace identifier
  const keyPrefix = apiKey.substring(0, 8);
  return `${keyPrefix}:${toolName}`;
}

/**
 * Interface for ElevenLabs workspace tool
 */
export interface ElevenLabsWorkspaceTool {
  id: string;
  tool_config: {
    type: string;
    name?: string;
    description?: string;
    api_schema?: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      request_body_schema?: any;
    };
  };
}

if (!ELEVENLABS_API_KEY) {
  console.warn("⚠️  WARNING: ELEVENLABS_API_KEY not set. ElevenLabs features will not work.");
}

export interface TransferRule {
  transfer_type: "conference" | "sip_refer";
  number_type: "phone" | "sip_uri";
  destination: string;
  condition?: string;
  customer_message?: string;
  operator_message?: string;
}

export interface TransferToNumberTool {
  type: "transfer_to_number";
  description?: string;
  transfer_rules: TransferRule[];
}

interface KnowledgeBaseItem {
  type: string;
  title: string;
  elevenLabsDocId: string;
}

interface CreateAgentParams {
  name: string;
  prompt: string;
  voice_id: string;
  language?: string;
  model?: string;
  first_message?: string;
  temperature?: number;
  voice_tone?: string;
  personality?: string;
  tools?: TransferToNumberTool[];
  knowledge_bases?: KnowledgeBaseItem[];
  // Flag to indicate agent has RAG knowledge bases (even if they don't have ElevenLabs doc IDs)
  // This is used to add knowledge base tool instructions to the prompt
  hasRAGKnowledgeBases?: boolean;
  // System Tools Configuration
  transferEnabled?: boolean;
  transferPhoneNumber?: string;
  detectLanguageEnabled?: boolean;
  endConversationEnabled?: boolean;
  appointmentBookingEnabled?: boolean;
  // Database agent ID (needed for appointment webhook tool URL)
  databaseAgentId?: string;
  // Skip workflow creation for incoming agents (workflows cause "Invalid message received" errors)
  skipWorkflow?: boolean;
  // Skip workflow rebuild during updateAgent - used for Flow agents whose workflow is managed by the flow builder
  skipWorkflowRebuild?: boolean;
  // TTS model override (admin setting)
  tts_model?: string;
  // Voice quality settings
  voiceStability?: number;  // 0-1, balanced natural vs consistent (default 0.55)
  voiceSimilarityBoost?: number;  // 0-1, voice matching (default 0.85)
  voiceSpeed?: number;  // 0.5-2.0, speech rate (default 1.0)
  // Webhook tools (like RAG knowledge base tool) - added at agent root level
  webhookTools?: Array<{
    type: "webhook";
    name: string;
    description: string;
    api_schema: {
      url: string;
      method: "GET" | "POST";
      headers?: Record<string, string>;
      path_params_schema?: Record<string, any>;
      query_params_schema?: Record<string, any>;
      request_body_schema?: Record<string, any>;
    };
  }>;
}

interface ElevenLabsAgent {
  agent_id: string;
  name: string;
  prompt: string;
  voice: {
    voice_id: string;
  };
  language: string;
  model: string;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export interface SharedVoice {
  voice_id: string;
  public_owner_id: string;
  name: string;
  description?: string;
  category?: string;
  labels?: Record<string, string>;
  accent?: string;
  age?: string;
  gender?: string;
  language?: string;
  use_case?: string;
  descriptive?: string;
  preview_url?: string;
  high_quality_base_model_ids?: string[];
  instagram_profile_url?: string;
  twitter_profile_url?: string;
  youtube_profile_url?: string;
  tiktok_profile_url?: string;
  image_url?: string;
  cloned_by_count?: number;
  usage_character_count_1y?: number;
  usage_character_count_7d?: number;
  play_api_usage_character_count_1y?: number;
  rate?: number;
  free_users_allowed?: boolean;
  live_moderation_enabled?: boolean;
  notice_period?: number;
}

// Default timeout for ElevenLabs API calls (30 seconds)
const ELEVENLABS_API_TIMEOUT_MS = 30000;

export class ElevenLabsService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || ELEVENLABS_API_KEY || "";
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, useV2 = false, timeoutMs = ELEVENLABS_API_TIMEOUT_MS): Promise<T> {
    // Use v2 for voices endpoint, v1 for everything else (agents, etc.)
    const baseUrl = useV2 ? ELEVENLABS_V2_BASE_URL : ELEVENLABS_V1_BASE_URL;
    
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          ...getCorrelationHeaders(), // Propagate correlation ID for distributed tracing
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ExternalServiceError(
          'ElevenLabs',
          `ElevenLabs API error: ${response.status} - ${errorText}`,
          undefined,
          { 
            operation: endpoint,
            statusCode: response.status,
            responseBody: errorText
          }
        );
      }

      return response.json();
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new ExternalServiceError(
          'ElevenLabs',
          `ElevenLabs API timeout after ${timeoutMs}ms: ${endpoint}`,
          undefined,
          { operation: endpoint, timeout: timeoutMs }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Builds ElevenLabs system tools as an ARRAY for prompt.tools
   * Per ElevenLabs API docs: System tools go in prompt.tools array with type: "system"
   * NOT in built_in_tools object (that's read-only, populated by ElevenLabs)
   * 
   * Available system tools: end_call, language_detection, transfer_to_number, 
   * transfer_to_agent, skip_turn, play_keypad_touch_tone, voicemail_detection
   * 
   * @param agentConfig - Agent configuration with tool enablement flags
   * @returns Array of system tool configurations for prompt.tools (empty array if none)
   */
  private buildSystemTools(agentConfig: {
    transferEnabled?: boolean;
    transferPhoneNumber?: string;
    detectLanguageEnabled?: boolean;
    endConversationEnabled?: boolean;
  }): any[] {
    const systemTools: any[] = [];

    // Transfer to Number tool - enables call transfer via Twilio
    // Per ElevenLabs docs: System tool with params.transfers array
    if (agentConfig.transferEnabled && agentConfig.transferPhoneNumber) {
      systemTools.push({
        type: "system",
        name: "transfer_to_number",
        description: "Transfer the caller to a human agent when they request it or when you cannot handle their request.",
        params: {
          system_tool_type: "transfer_to_number",
          transfers: [
            {
              transfer_destination: {
                type: "phone",
                phone_number: agentConfig.transferPhoneNumber
              },
              condition: "When the user asks to speak with a human or when the AI cannot handle the request.",
              transfer_type: "conference"
            }
          ]
        }
      });
      console.log(`   ✓ System Tool: transfer_to_number → ${agentConfig.transferPhoneNumber}`);
    }

    // Language Detection tool - enables automatic language switching
    if (agentConfig.detectLanguageEnabled) {
      systemTools.push({
        type: "system",
        name: "language_detection",
        description: "Automatically detect and switch to the user's preferred language"
      });
      console.log(`   ✓ System Tool: language_detection`);
    }

    // End Call tool - allows agent to gracefully terminate calls
    if (agentConfig.endConversationEnabled) {
      systemTools.push({
        type: "system",
        name: "end_call",
        description: "End the call when the user is finished or says goodbye"
      });
      console.log(`   ✓ System Tool: end_call`);
    }

    if (systemTools.length > 0) {
      console.log(`   📦 Built ${systemTools.length} system tool(s) for ElevenLabs agent`);
    }

    return systemTools;
  }

  /**
   * Build node-based workflow configuration for ElevenLabs agents
   * Per ElevenLabs API docs: workflow uses nodes and edges structure
   * Tool IDs must match the built-in tool names: transfer_to_number, language_detection, end_call
   */
  private buildWorkflow(agentConfig: {
    transferEnabled?: boolean;
    transferPhoneNumber?: string;
    detectLanguageEnabled?: boolean;
    endConversationEnabled?: boolean;
  }): any | null {
    // Build list of enabled tools that need workflow nodes
    const hasTransfer = agentConfig.transferEnabled && agentConfig.transferPhoneNumber;
    const hasDetectLanguage = agentConfig.detectLanguageEnabled;
    const hasEndConversation = agentConfig.endConversationEnabled;
    
    // Only create workflow if at least one tool is enabled
    if (!hasTransfer && !hasDetectLanguage && !hasEndConversation) {
      return null;
    }

    console.log(`   🔄 Building node-based workflow for enabled tools`);

    // Build nodes - start with conversation node
    const nodes: any = {
      start_node: { 
        type: "start", 
        edge_order: ["start_to_convo"] 
      },
      convo_node: { 
        type: "override_agent", 
        label: "Agent Conversation",
        edge_order: [] as string[]
      }
    };

    const edges: any = {
      start_to_convo: {
        source: "start_node",
        target: "convo_node",
        forward_condition: { type: "unconditional" }
      }
    };

    // Add transfer node if enabled - tool_id must match "transfer_to_number"
    if (hasTransfer) {
      nodes.transfer_node = {
        type: "tool",
        label: "Transfer to Human",
        tools: [{ tool_id: "transfer_to_number" }],
        edge_order: []
      };
      
      nodes.convo_node.edge_order.push("to_transfer");
      
      edges.to_transfer = {
        source: "convo_node",
        target: "transfer_node",
        forward_condition: {
          type: "llm",
          condition: "The user asked to talk to a human agent, requested a transfer, or the AI cannot handle the request."
        }
      };
      
      console.log(`   ✓ Workflow Node: transfer_to_number`);
    }

    // Add detect language node if enabled - tool_id must match "language_detection"
    if (hasDetectLanguage) {
      nodes.detect_language_node = {
        type: "tool",
        label: "Detect Language",
        tools: [{ tool_id: "language_detection" }],
        edge_order: []
      };
      
      nodes.convo_node.edge_order.push("to_detect_language");
      
      edges.to_detect_language = {
        source: "convo_node",
        target: "detect_language_node",
        forward_condition: {
          type: "llm",
          condition: "The user is speaking in a different language or requested a language change."
        }
      };
      
      console.log(`   ✓ Workflow Node: language_detection`);
    }

    // Add end call node if enabled - tool_id must match "end_call"
    if (hasEndConversation) {
      nodes.end_call_node = {
        type: "tool",
        label: "End Call",
        tools: [{ tool_id: "end_call" }],
        edge_order: []
      };
      
      nodes.convo_node.edge_order.push("to_end_call");
      
      edges.to_end_call = {
        source: "convo_node",
        target: "end_call_node",
        forward_condition: {
          type: "llm",
          condition: "The user said goodbye, indicated they are finished, or all their needs have been addressed."
        }
      };
      
      console.log(`   ✓ Workflow Node: end_call`);
    }

    const workflow = { nodes, edges };
    
    console.log(`   ✅ Node-based workflow configured with ${Object.keys(nodes).length} nodes and ${Object.keys(edges).length} edges`);
    return workflow;
  }


  /**
   * Enhances system prompt with tool usage instructions
   * Automatically adds guidance for LLM on when/how to use enabled tools
   * 
   * @param basePrompt - Original system prompt
   * @param agentConfig - Agent configuration with tool enablement flags
   * @returns Enhanced prompt with tool instructions appended
   */
  private enhanceSystemPromptWithTools(
    basePrompt: string,
    agentConfig: {
      detectLanguageEnabled?: boolean;
      endConversationEnabled?: boolean;
      hasKnowledgeBase?: boolean;
      appointmentBookingEnabled?: boolean;
    }
  ): string {
    const toolInstructions: string[] = [];

    // Add knowledge base instructions if agent has knowledge bases (PRIORITY - add first)
    // These instructions must be FORCEFUL to ensure the LLM actually CALLS the tool
    // rather than just talking about searching
    if (agentConfig.hasKnowledgeBase) {
      toolInstructions.push(
        `⚠️ CRITICAL KNOWLEDGE BASE INSTRUCTION ⚠️
You have access to a knowledge base tool called "ask_knowledge".

MANDATORY BEHAVIOR:
- When the user asks ANY question that might require information from the knowledge base, you MUST call the "ask_knowledge" tool IMMEDIATELY.
- Do NOT say things like "I will search the knowledge base" or "Let me check" or "Let me look that up".
- Do NOT explain what you are doing.
- Do NOT answer from memory if information could exist in the knowledge base.
- Instead, IMMEDIATELY EXECUTE the tool with the user's question as the query, then wait for the tool response before speaking.

QUESTIONS THAT MUST TRIGGER THE TOOL:
- Any question about pricing, plans, or costs
- Any question about features or capabilities
- Any question about policies (returns, refunds, shipping, etc.)
- Any question about how the product/service works
- Any question asking "what is...", "how does...", "tell me about..."
- Any question the user might expect you to have specific information about

CORRECT BEHAVIOR: User asks "What are your pricing plans?" → CALL ask_knowledge tool with query "pricing plans" → Wait for response → Answer based on tool response.

INCORRECT BEHAVIOR: User asks "What are your pricing plans?" → Say "Let me check our pricing for you" → Never call the tool.

Remember: EXECUTE the tool first, THEN speak. Never speak about searching - just DO IT.`
      );
    }

    // Add language detection instructions if enabled
    if (agentConfig.detectLanguageEnabled) {
      toolInstructions.push(
        `You can automatically detect and switch to the user's preferred language. The system will handle language detection when the user speaks a different language or requests a language change.`
      );
    }

    // Add end conversation instructions if enabled
    if (agentConfig.endConversationEnabled) {
      toolInstructions.push(
        `You can end the conversation gracefully when the user indicates they are finished. Use the end conversation tool when the user says goodbye, expresses that they're done, or when you've fully addressed their needs.`
      );
    }

    // Add appointment booking instructions if enabled
    if (agentConfig.appointmentBookingEnabled) {
      toolInstructions.push(
        `⚠️ APPOINTMENT BOOKING TOOL ⚠️
You have a tool called "book_appointment" to schedule appointments for callers.

WHEN TO USE THIS TOOL:
- When the caller wants to schedule, book, or set up an appointment
- When the caller asks about availability or wants to meet
- When the caller says things like "I'd like to book a time", "Can I schedule a meeting", "When are you available"

HOW TO USE:
1. First, collect the necessary information from the caller:
   - Their name (required)
   - Their phone number (required - accept any format they provide)
   - Preferred date (required - can be relative like "tomorrow" or "next Monday")
   - Preferred time (required - convert to 24-hour format, e.g., "2pm" becomes "14:00")
   - Optional: email, service/reason for appointment, any notes
2. Once you have the required information, IMMEDIATELY call the book_appointment tool
3. Confirm the booking details with the caller after the tool responds

IMPORTANT: Do NOT just say you will book the appointment - you MUST actually call the book_appointment tool to complete the booking.`
      );
    }

    // If any tool instructions were added, append them to the base prompt
    if (toolInstructions.length > 0) {
      const enhancedPrompt = `${basePrompt}\n\n## Available Tools\n${toolInstructions.map((instr, idx) => `${idx + 1}. ${instr}`).join('\n')}`;
      console.log(`   ✏️  Enhanced system prompt with ${toolInstructions.length} tool instruction(s)`);
      return enhancedPrompt;
    }

    return basePrompt;
  }

  async createAgent(params: CreateAgentParams): Promise<ElevenLabsAgent> {
    console.log(`📝 Creating ElevenLabs agent: ${params.name}`);
    console.log(`   Voice ID: ${params.voice_id}`);
    console.log(`   Language: ${params.language || "en"}`);
    console.log(`   Model: ${params.model || "gpt-4o-mini"}`);
    console.log(`   Temperature: ${params.temperature !== undefined ? params.temperature : 0.5}`);
    
    // Build enhanced prompt with voice tone and personality
    let enhancedPrompt = params.prompt;
    if (params.voice_tone || params.personality) {
      const toneText = params.voice_tone ? `Voice Tone: ${params.voice_tone}.` : '';
      const personalityText = params.personality ? `Personality: ${params.personality}.` : '';
      enhancedPrompt = `${toneText}${toneText && personalityText ? ' ' : ''}${personalityText}\n\n${params.prompt}`;
    }
    
    // Enhance prompt with system tools instructions (including knowledge base if present)
    const hasKnowledgeBase = params.knowledge_bases && params.knowledge_bases.length > 0;
    enhancedPrompt = this.enhanceSystemPromptWithTools(enhancedPrompt, {
      detectLanguageEnabled: params.detectLanguageEnabled,
      endConversationEnabled: params.endConversationEnabled,
      hasKnowledgeBase,
      appointmentBookingEnabled: params.appointmentBookingEnabled,
    });
    
    // Build system tools as ARRAY for prompt.tools (per ElevenLabs API docs)
    const systemTools = this.buildSystemTools({
      transferEnabled: params.transferEnabled,
      transferPhoneNumber: params.transferPhoneNumber,
      detectLanguageEnabled: params.detectLanguageEnabled,
      endConversationEnabled: params.endConversationEnabled,
    });
    
    // Build node-based workflow for enabled tools
    // Skip workflow for incoming agents as workflows cause "Invalid message received" errors
    // with ElevenLabs native Twilio integration
    let workflow = null;
    if (!params.skipWorkflow) {
      workflow = this.buildWorkflow({
        transferEnabled: params.transferEnabled,
        transferPhoneNumber: params.transferPhoneNumber,
        detectLanguageEnabled: params.detectLanguageEnabled,
        endConversationEnabled: params.endConversationEnabled,
      });
    } else {
      console.log(`   ⏭️  Skipping workflow creation (skipWorkflow=true)`);
    }
    
    // Build prompt config - system tools go in prompt.tools array (NOT built_in_tools)
    const promptConfig: any = {
      prompt: enhancedPrompt,
      llm: params.model || "gpt-4o-mini",
      temperature: params.temperature !== undefined ? params.temperature : 0.5,
    };
    
    // Add knowledge base if provided
    if (params.knowledge_bases !== undefined && params.knowledge_bases.length > 0) {
      promptConfig.knowledge_base = params.knowledge_bases.map(kb => ({
        type: kb.type,
        name: kb.title,
        id: kb.elevenLabsDocId
      }));
      console.log(`   Knowledge bases: ${params.knowledge_bases.length} KB(s)`);
    }
    
    // Combine system tools with any custom tools into prompt.tools array
    // Per ElevenLabs API: All tools (system and webhook) go in prompt.tools
    // Note: Appointment booking tools are added via updateAgent after creation
    // since we need the ElevenLabs agent ID for the webhook URL
    const allPromptTools: any[] = [...systemTools];
    if (params.tools && params.tools.length > 0) {
      allPromptTools.push(...params.tools);
    }
    
    if (allPromptTools.length > 0) {
      promptConfig.tools = allPromptTools;
      console.log(`   Prompt tools: ${allPromptTools.length} (${systemTools.length} system + ${params.tools?.length || 0} custom)`);
    }
    
    const agentConfig: any = {
      prompt: promptConfig,
      first_message: params.first_message || "Hello! How can I help you today?",
      language: params.language || "en",
    };
    
    const requestBody: any = {
      name: params.name,
      conversation_config: {
        agent: agentConfig,
        tts: {
          voice_id: params.voice_id,
          model_id: params.language === "en" ? "eleven_turbo_v2" : "eleven_multilingual_v2",
          agent_output_audio_format: "pcm_16000",  // PCM 16kHz for better quality
          stability: params.voiceStability ?? 0.55,  // Balanced: natural yet consistent
          similarity_boost: params.voiceSimilarityBoost ?? 0.85,  // High voice matching
          speed: params.voiceSpeed ?? 1.0,  // Consistent pacing
        },
        asr: {
          provider: "elevenlabs",
          model: "scribe_v2_realtime",  // Scribe v2 Realtime for better ASR accuracy
          user_input_audio_format: "pcm_16000",  // PCM 16kHz for Scribe
        },
        conversation: {
          max_duration_seconds: 900, // 15 minutes max call duration
          // Valid client events per ElevenLabs API documentation
          client_events: ["audio", "agent_response", "user_transcript", "interruption", "client_tool_call"],
        },
      },
    };
    
    // Add workflow at root level (per ElevenLabs API documentation)
    if (workflow) {
      requestBody.workflow = workflow;
    }
    
    // Add webhook tools at agent root level (per ElevenLabs API documentation)
    if (params.webhookTools && params.webhookTools.length > 0) {
      requestBody.tools = params.webhookTools;
      console.log(`   📚 Webhook tools: ${params.webhookTools.map(t => t.name).join(', ')}`);
    }
    
    console.log(`📤 Sending to ElevenLabs API:`, JSON.stringify(requestBody, null, 2));
    
    const result = await this.request<ElevenLabsAgent>("/convai/agents/create", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    
    console.log(`✅ ElevenLabs agent created successfully:`, result.agent_id);
    return result;
  }

  /**
   * Creates a Flow Agent in ElevenLabs with a compiled workflow from the visual flow builder.
   * Flow Agents use deterministic workflows instead of open-ended LLM conversations.
   * 
   * @param params - Flow agent configuration
   * @returns Created ElevenLabs agent
   */
  async createFlowAgent(params: {
    name: string;
    voice_id: string;
    language?: string;
    llmModel?: string;
    temperature?: number;
    maxDurationSeconds?: number;
    voiceStability?: number;
    voiceSimilarityBoost?: number;
    voiceSpeed?: number;
    detectLanguageEnabled?: boolean;
    systemPrompt?: string;
    firstMessage?: string;
    knowledgeBases?: Array<{ type: string; name: string; id: string }>;
    ttsModel?: string;
    workflow: {
      nodes: Record<string, any>;
      edges: Record<string, any>;
    };
    webhookTools?: any[];
  }): Promise<ElevenLabsAgent> {
    console.log(`📝 Creating ElevenLabs Flow Agent: ${params.name}`);
    console.log(`   Voice ID: ${params.voice_id}`);
    console.log(`   Language: ${params.language || "en"}`);
    console.log(`   LLM Model: ${params.llmModel || "gpt-4o-mini"}`);
    console.log(`   Temperature: ${params.temperature ?? 0.3}`);
    console.log(`   Max Duration: ${params.maxDurationSeconds || 600} seconds`);
    console.log(`   Language Detection: ${params.detectLanguageEnabled ? "enabled" : "disabled"}`);
    console.log(`   System Prompt: ${params.systemPrompt ? 'custom' : 'default'}`);
    console.log(`   First Message: ${params.firstMessage ? 'custom' : 'default'}`);
    console.log(`   Knowledge Bases: ${params.knowledgeBases?.length || 0}`);
    console.log(`   TTS Model: ${params.ttsModel || 'auto'}`);
    console.log(`   Workflow nodes: ${Object.keys(params.workflow.nodes).length}`);
    console.log(`   Workflow edges: ${Object.keys(params.workflow.edges).length}`);

    // Workflow is already in ElevenLabs format (objects keyed by ID)
    const workflowNodes = params.workflow.nodes;
    const workflowEdges = params.workflow.edges;

    // Detect if workflow has transfer nodes (phone_number type) for logging purposes
    // Note: ElevenLabs handles transfers via workflow nodes directly, not via prompt.tools
    const hasTransferNodes = Object.values(workflowNodes).some((node: any) => node.type === 'phone_number');

    // Detect if workflow has explicit end nodes (type === 'end')
    // Only true end nodes should trigger the end_call tool, not transfer or tool nodes at leaf positions
    // This enables the agent to properly hang up when the workflow reaches an explicit end
    const hasEndNodes = Object.values(workflowNodes).some((node: any) => node.type === 'end');

    // Extract tool nodes for custom webhook tool definitions
    // ElevenLabs expects server tools with tool_id matching the workflow node reference
    // ONLY auto-generate if webhookTools are NOT provided (they have full config from compiler)
    let webhookTools: any[] = [];
    
    if (params.webhookTools && params.webhookTools.length > 0) {
      // Use provided webhook tools (they have correct URLs from the flow compiler)
      webhookTools = params.webhookTools;
      console.log(`   📦 Using ${webhookTools.length} pre-configured webhook tool(s)`);
    } else {
      // Fallback: Auto-generate from workflow tool nodes (legacy behavior)
      // IMPORTANT: Skip tools that are handled in phase 2 (they need agent ID for valid webhook URLs)
      const phase2Prefixes = ['play_audio_', 'appointment_', 'form_submit_', 'submit_form_'];
      const toolNodes = Object.entries(workflowNodes).filter(([_, node]: [string, any]) => node.type === 'tool');
      webhookTools = toolNodes.flatMap(([nodeId, node]: [string, any]) => {
        const tools = node.tools || [];
        return tools.map((tool: any) => {
          const toolId = tool.tool_id || `webhook_${nodeId}`;
          // Skip phase-2 tools - they'll be added after agent creation with valid URLs
          if (phase2Prefixes.some(prefix => toolId.startsWith(prefix))) {
            console.log(`   ⏭️ Skipping phase-2 tool: ${toolId} (will be added after agent creation)`);
            return null;
          }
          return {
            type: "webhook",
            name: toolId,
            description: `Execute webhook action for ${toolId}`,
            api_schema: {
              url: tool.webhook_url || "",
              method: tool.method || "POST",
              request_headers: {
                "Content-Type": "application/json"
              }
            }
          };
        }).filter(Boolean);
      });
      if (webhookTools.length > 0) {
        console.log(`   📦 Auto-generated ${webhookTools.length} webhook tool(s) from workflow`);
      }
    }

    // Build base prompt for Flow Agent - use custom or default
    // The default prompt MUST enforce strict adherence to workflow messages
    let basePrompt = params.systemPrompt || `You are a SCRIPTED phone agent. You MUST follow the workflow EXACTLY.

ABSOLUTE RULES - NEVER BREAK THESE:
1. When a workflow step contains text between "---" markers, say that text VERBATIM - word for word, character for character.
2. NEVER paraphrase, summarize, translate, or modify scripted messages.
3. NEVER add your own words, greetings, small talk, or explanations.
4. NEVER improvise or respond naturally - you are reading a script.
5. If a step says "SAY THIS EXACT MESSAGE" or "ASK THIS EXACT QUESTION", output ONLY that text.
6. After saying your scripted message, STOP and wait for the user's response.
7. If the user doesn't understand, repeat the EXACT same scripted message.
8. Do NOT try to be helpful or conversational - just read the script.

IMPORTANT: Each workflow step will have "CRITICAL INSTRUCTION" with the exact text to say. Copy that text exactly.

You are a script reader, not a conversational AI. Execute the workflow mechanically.`;

    // Add language detection instructions if enabled
    if (params.detectLanguageEnabled) {
      basePrompt += `\n\nIMPORTANT: You have access to the language_detection tool. If the user speaks in a language other than the current conversation language, use the language_detection tool to switch to their preferred language automatically.`;
    }

    // Determine first message - use custom or default
    const firstMessage = params.firstMessage || "Hello! I'm calling to assist you today.";
    
    // Determine TTS model with smart auto-selection:
    // - English agents: Use eleven_turbo_v2 (required by ElevenLabs for conversational agents)
    // - Non-English agents: Use admin setting or eleven_multilingual_v2
    // Valid models for Conversational AI: eleven_turbo_v2, eleven_flash_v2, eleven_multilingual_v2
    // Note: v2_5 models are NOT supported for conversational/workflow agents
    const isEnglish = (params.language || "en") === "en";
    const defaultModel = isEnglish ? "eleven_turbo_v2" : "eleven_multilingual_v2";
    let ttsModel = params.ttsModel || defaultModel;
    
    // Validate the model is in the allowed list
    const validModels = ["eleven_turbo_v2", "eleven_flash_v2", "eleven_multilingual_v2"];
    if (!validModels.includes(ttsModel)) {
      console.log(`   ⚠️ TTS model ${ttsModel} is not valid, using ${defaultModel}`);
      ttsModel = defaultModel;
    }

    // Build system tools for Flow Agent as ARRAY for prompt.tools
    const systemTools: any[] = [];
    
    // Language detection system tool
    if (params.detectLanguageEnabled) {
      systemTools.push({
        type: "system",
        name: "language_detection",
        description: "Automatically detect and switch to the user's preferred language"
      });
      console.log(`   ✓ System Tool: language_detection`);
    }

    // End call system tool - allows agent to hang up when reaching workflow end
    // This is essential for Flow Agents to properly terminate calls
    if (hasEndNodes) {
      systemTools.push({
        type: "system",
        name: "end_call",
        description: "End the call when the conversation is complete, the user says goodbye, or the workflow reaches its end"
      });
      console.log(`   ✓ System Tool: end_call`);
    }

    // Note: Transfer functionality is handled by workflow phone_number nodes directly
    // ElevenLabs uses the workflow edges to determine when to transfer calls
    if (hasTransferNodes) {
      console.log(`   📞 Has transfer nodes: true (handled via workflow)`);
    }

    // Build knowledge base configuration if provided - requires type, id, and name
    const knowledgeBaseConfig = params.knowledgeBases && params.knowledgeBases.length > 0
      ? params.knowledgeBases.map(kb => ({ type: kb.type, id: kb.id, name: kb.name }))
      : undefined;

    // Combine system tools with webhook tools (already includes passed-in tools if provided)
    const allPromptTools = [
      ...systemTools, 
      ...webhookTools
    ];

    const requestBody: any = {
      name: params.name,
      conversation_config: {
        agent: {
          prompt: {
            prompt: basePrompt,
            llm: params.llmModel || "gpt-4o-mini",
            temperature: params.temperature ?? 0.3, // Lower temperature for more deterministic flow execution
            ...(allPromptTools.length > 0 && { tools: allPromptTools }),
            ...(knowledgeBaseConfig && { knowledge_base: knowledgeBaseConfig }),
          },
          first_message: firstMessage,
          language: params.language || "en",
        },
        tts: {
          voice_id: params.voice_id,
          model_id: ttsModel,
          agent_output_audio_format: "pcm_16000",  // PCM 16kHz for better quality
          stability: params.voiceStability ?? 0.55,  // Balanced: natural yet consistent
          similarity_boost: params.voiceSimilarityBoost ?? 0.85,  // High voice matching
          speed: params.voiceSpeed ?? 1.0,  // Consistent pacing
        },
        asr: {
          provider: "elevenlabs",
          model: "scribe_v2_realtime",  // Scribe v2 Realtime for better ASR accuracy
          user_input_audio_format: "pcm_16000",  // PCM 16kHz for Scribe
        },
        conversation: {
          max_duration_seconds: params.maxDurationSeconds || 600, // Use configured max duration
          client_events: ["audio", "agent_response", "user_transcript", "interruption", "client_tool_call"],
        },
      },
      workflow: {
        nodes: workflowNodes,
        edges: workflowEdges
      },
    };

    // Log combined prompt tools
    if (allPromptTools.length > 0) {
      const passedToolsCount = params.webhookTools?.length || 0;
      console.log(`   📦 Prompt tools: ${allPromptTools.length} (${systemTools.length} system + ${webhookTools.length} workflow + ${passedToolsCount} passed)`);
    }

    console.log(`📤 Sending Flow Agent to ElevenLabs API:`, JSON.stringify(requestBody, null, 2));

    const result = await this.request<ElevenLabsAgent>("/convai/agents/create", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    console.log(`✅ ElevenLabs Flow Agent created successfully:`, result.agent_id);
    return result;
  }

  /**
   * Updates a Flow Agent's workflow in ElevenLabs.
   * Called when the linked flow is modified.
   * 
   * @param agentId - ElevenLabs agent ID
   * @param workflow - Compiled workflow from visual flow builder
   * @param maxDurationSeconds - Optional max duration update
   * @param detectLanguageEnabled - Optional language detection setting
   * @param language - Optional language (pass to update TTS model for non-English)
   * @param ttsModel - Optional TTS model (admin-configured model)
   * @param llmModel - Optional LLM model update
   * @param temperature - Optional temperature update
   * @param firstMessage - Optional first message (extracted from flow's first Message node)
   * @param voiceId - Optional voice ID update
   * @returns Updated ElevenLabs agent
   */
  async updateFlowAgentWorkflow(agentId: string, workflow: {
    nodes: Record<string, any>;
    edges: Record<string, any>;
  }, maxDurationSeconds?: number, detectLanguageEnabled?: boolean, language?: string, ttsModel?: string, llmModel?: string, temperature?: number, firstMessage?: string, voiceId?: string, additionalOptions?: {
    knowledgeBases?: Array<{ type: string; title: string; elevenLabsDocId: string }>;
    webhookTools?: Array<{ type: "webhook"; name: string; description: string; api_schema: any }>;
    name?: string;
    basePrompt?: string;  // Base system prompt for the agent
    voiceStability?: number;  // TTS stability (0-1, lower = more expressive)
    voiceSimilarityBoost?: number;  // TTS similarity boost (0-1)
    voiceSpeed?: number;  // TTS speed (0.5-2.0)
  }): Promise<ElevenLabsAgent> {
    console.log(`🔄 Updating Flow Agent workflow: ${agentId}`);
    console.log(`   Workflow nodes: ${Object.keys(workflow.nodes).length}`);
    console.log(`   Workflow edges: ${Object.keys(workflow.edges).length}`);
    console.log(`   Language Detection: ${detectLanguageEnabled ? "enabled" : "disabled"}`);
    console.log(`   Language: ${language || "not changing"}`);
    console.log(`   TTS Model: ${ttsModel || "not changing"}`);
    console.log(`   LLM Model: ${llmModel || "not changing"}`);
    console.log(`   Temperature: ${temperature !== undefined ? temperature : "not changing"}`);
    console.log(`   First Message: ${firstMessage ? `"${firstMessage.substring(0, 50)}..."` : "not changing"}`);
    console.log(`   Voice ID: ${voiceId || "not changing"}`);

    // Workflow is already in ElevenLabs format (objects keyed by ID)
    const workflowNodes = workflow.nodes;
    const workflowEdges = workflow.edges;

    const updatePayload: any = {
      workflow: {
        nodes: workflowNodes,
        edges: workflowEdges
      },
      // Always include ASR and TTS config for consistent settings
      conversation_config: {
        asr: {
          provider: "elevenlabs",
          model: "scribe_v2_realtime",  // Scribe v2 Realtime for better ASR accuracy
          user_input_audio_format: "pcm_16000",  // PCM 16kHz for Scribe
        },
        tts: {
          agent_output_audio_format: "pcm_16000",  // PCM 16kHz for better quality
          stability: additionalOptions?.voiceStability ?? 0.55,  // Balanced: natural yet consistent
          similarity_boost: additionalOptions?.voiceSimilarityBoost ?? 0.85,  // High voice matching
          speed: additionalOptions?.voiceSpeed ?? 1.0,  // Consistent pacing (always set)
        }
      }
    };

    // Include max duration update if provided
    if (maxDurationSeconds !== undefined) {
      updatePayload.conversation_config.conversation = {
        max_duration_seconds: maxDurationSeconds
      };
    }
    
    // Include voice_id if provided
    if (voiceId) {
      updatePayload.conversation_config.tts.voice_id = voiceId;
      console.log(`   ✓ Voice ID update: ${voiceId}`);
    }
    
    // Set agent language if provided (non-English)
    if (language && language !== 'en') {
      if (!updatePayload.conversation_config.agent) {
        updatePayload.conversation_config.agent = {};
      }
      updatePayload.conversation_config.agent.language = language;
      
      // Handle non-English language TTS model
      // Valid models for Conversational AI: eleven_turbo_v2, eleven_flash_v2, eleven_multilingual_v2
      // Note: v2_5 models are NOT supported for conversational/workflow agents
      const validModels = ["eleven_turbo_v2", "eleven_flash_v2", "eleven_multilingual_v2"];
      let effectiveTtsModel = ttsModel || "eleven_multilingual_v2";
      
      // Validate the model is valid
      if (ttsModel && !validModels.includes(ttsModel)) {
        console.log(`   ⚠️ TTS model ${ttsModel} is not valid, using eleven_multilingual_v2`);
        effectiveTtsModel = "eleven_multilingual_v2";
      }
      
      updatePayload.conversation_config.tts.model_id = effectiveTtsModel;
      console.log(`   ✓ TTS config: model=${effectiveTtsModel}, language=${language}`);
    }

    // Include LLM model and temperature if provided
    if (llmModel !== undefined || temperature !== undefined) {
      if (!updatePayload.conversation_config) {
        updatePayload.conversation_config = {};
      }
      if (!updatePayload.conversation_config.agent) {
        updatePayload.conversation_config.agent = {};
      }
      if (!updatePayload.conversation_config.agent.prompt) {
        updatePayload.conversation_config.agent.prompt = {};
      }
      
      if (llmModel !== undefined) {
        updatePayload.conversation_config.agent.prompt.llm = llmModel;
        console.log(`   ✓ LLM Model update: ${llmModel}`);
      }
      if (temperature !== undefined) {
        updatePayload.conversation_config.agent.prompt.temperature = temperature;
        console.log(`   ✓ Temperature update: ${temperature}`);
      }
    }
    
    // Include first message if provided (extracted from flow's first Message node)
    if (firstMessage) {
      if (!updatePayload.conversation_config) {
        updatePayload.conversation_config = {};
      }
      if (!updatePayload.conversation_config.agent) {
        updatePayload.conversation_config.agent = {};
      }
      updatePayload.conversation_config.agent.first_message = firstMessage;
      console.log(`   ✓ First message set from flow`);
    }

    // Detect if workflow has transfer nodes (phone_number type) for logging purposes
    // Note: ElevenLabs handles transfers via workflow nodes directly, not via prompt.tools
    const hasTransferNodes = Object.values(workflowNodes).some((node: any) => node.type === 'phone_number');

    // Detect if workflow has explicit end nodes (type === 'end')
    // Only true end nodes should trigger the end_call tool, not transfer or tool nodes at leaf positions
    const hasEndNodes = Object.values(workflowNodes).some((node: any) => node.type === 'end');

    // Extract tool nodes for custom webhook tool definitions
    // ONLY auto-generate if webhookTools are NOT provided (they have full config from compiler)
    let webhookTools: any[] = [];
    
    if (additionalOptions?.webhookTools && additionalOptions.webhookTools.length > 0) {
      // Use provided webhook tools (they have correct URLs from the flow compiler)
      webhookTools = additionalOptions.webhookTools;
      console.log(`   📦 Using ${webhookTools.length} pre-configured webhook tool(s)`);
    } else {
      // Fallback: Auto-generate from workflow tool nodes (legacy behavior)
      // IMPORTANT: Skip tools that are handled in phase 2 (they need agent ID for valid webhook URLs)
      const phase2Prefixes = ['play_audio_', 'appointment_', 'form_submit_', 'submit_form_'];
      const toolNodes = Object.entries(workflowNodes).filter(([_, node]: [string, any]) => node.type === 'tool');
      webhookTools = toolNodes.flatMap(([nodeId, node]: [string, any]) => {
        const tools = node.tools || [];
        return tools.map((tool: any) => {
          const toolId = tool.tool_id || `webhook_${nodeId}`;
          // Skip phase-2 tools - they'll be added after agent creation with valid URLs
          if (phase2Prefixes.some(prefix => toolId.startsWith(prefix))) {
            console.log(`   ⏭️ Skipping phase-2 tool: ${toolId} (will be added after agent creation)`);
            return null;
          }
          return {
            type: "webhook",
            name: toolId,
            description: `Execute webhook action for ${toolId}`,
            api_schema: {
              url: tool.webhook_url || "",
              method: tool.method || "POST",
              request_headers: {
                "Content-Type": "application/json"
              }
            }
          };
        }).filter(Boolean);
      });
      if (webhookTools.length > 0) {
        console.log(`   📦 Auto-generated ${webhookTools.length} webhook tool(s) from workflow`);
      }
    }

    // CRITICAL: Register webhook tools as workspace tools and update workflow to use real tool IDs
    // ElevenLabs workflow tool nodes must reference actual workspace tool IDs (like tool_xxx),
    // not friendly names. Without this, workflow tool dispatch fails with "tool unavailable".
    if (webhookTools.length > 0) {
      try {
        await this.registerWorkflowToolsAndUpdateWorkflow(webhookTools, workflow);
      } catch (error: any) {
        console.error(`   ⚠️ Failed to register workspace tools: ${error.message}`);
        // Continue anyway - inline tool config in prompt.tools may still work for some cases
      }
    }

    // Build system tools as ARRAY for prompt.tools (per ElevenLabs API)
    const systemTools: any[] = [];

    // Language detection system tool
    if (detectLanguageEnabled) {
      systemTools.push({
        type: "system",
        name: "language_detection",
        description: "Automatically detect and switch to the user's preferred language"
      });
      console.log(`   ✓ System Tool: language_detection`);
    }

    // End call system tool - allows agent to hang up when reaching workflow end
    // This is essential for Flow Agents to properly terminate calls
    if (hasEndNodes) {
      systemTools.push({
        type: "system",
        name: "end_call",
        description: "End the call when the conversation is complete, the user says goodbye, or the workflow reaches its end"
      });
      console.log(`   ✓ System Tool: end_call`);
    }

    // Note: Transfer functionality is handled by workflow phone_number nodes directly
    // ElevenLabs uses the workflow edges to determine when to transfer calls
    if (hasTransferNodes) {
      console.log(`   📞 Has transfer nodes: true (handled via workflow)`);
    }

    // TOOL PRESERVATION: Fetch existing tools and preserve RAG/other tools not being updated
    // This prevents flow updates from removing RAG tools (ask_knowledge_*) that were added separately
    let preservedTools: any[] = [];
    try {
      const existingAgent = await this.getAgent(agentId);
      const existingTools = (existingAgent as any)?.conversation_config?.agent?.prompt?.tools || [];
      console.log(`   🔍 Found ${existingTools.length} existing tool(s)`);
      
      // Get names of tools we're about to add/update
      const newToolNames = new Set([
        ...systemTools.map((t: any) => t.name),
        ...webhookTools.map((t: any) => t.name)
      ]);
      
      // Preserve ALL existing tools that are NOT being explicitly updated
      // This ensures RAG tools, custom webhooks, and any other tools remain intact
      preservedTools = existingTools.filter((tool: any) => {
        const toolName = tool.name || '';
        const toolType = tool.type || '';
        
        // Skip system tools - we're rebuilding those based on current settings
        if (toolType === 'system') {
          return false;
        }
        
        // Skip if this exact tool name is being replaced by our update
        if (newToolNames.has(toolName)) {
          console.log(`   ↺ Replacing tool: ${toolName}`);
          return false;
        }
        
        // Preserve all other webhook tools (RAG, custom, etc.)
        if (toolType === 'webhook') {
          if (toolName.startsWith('ask_knowledge_')) {
            console.log(`   ✓ Preserving RAG tool: ${toolName}`);
          } else {
            console.log(`   ✓ Preserving webhook tool: ${toolName}`);
          }
          return true;
        }
        
        // Preserve any other non-system tools
        console.log(`   ✓ Preserving tool: ${toolName} (type: ${toolType})`);
        return true;
      });
      
      if (preservedTools.length > 0) {
        console.log(`   📦 Preserving ${preservedTools.length} existing tool(s)`);
      }
    } catch (error: any) {
      console.log(`   ⚠️ Could not fetch existing tools: ${error.message}`);
    }

    // Combine system tools + preserved tools + new webhook tools for prompt.tools array
    const allPromptTools = [...systemTools, ...preservedTools, ...webhookTools];
    
    // Log combined prompt tools
    if (allPromptTools.length > 0) {
      console.log(`   📦 Prompt tools: ${allPromptTools.length} (${systemTools.length} system + ${preservedTools.length} preserved + ${webhookTools.length} webhook)`);
      // Log all tool names for verification
      const toolNames = allPromptTools.map((t: any) => t.name).join(', ');
      console.log(`   📋 Final tools: [${toolNames}]`);
    }

    // Add tools to prompt config if any are defined
    if (allPromptTools.length > 0) {
      if (!updatePayload.conversation_config) {
        updatePayload.conversation_config = {};
      }
      if (!updatePayload.conversation_config.agent) {
        updatePayload.conversation_config.agent = {};
      }
      if (!updatePayload.conversation_config.agent.prompt) {
        updatePayload.conversation_config.agent.prompt = {};
      }
      updatePayload.conversation_config.agent.prompt.tools = allPromptTools;
    }
    
    // CRITICAL: Set ignore_default_personality UNCONDITIONALLY for flow agents
    // This prevents creative/ad-lib behavior and enforces strict script following
    if (!updatePayload.conversation_config) {
      updatePayload.conversation_config = {};
    }
    if (!updatePayload.conversation_config.agent) {
      updatePayload.conversation_config.agent = {};
    }
    if (!updatePayload.conversation_config.agent.prompt) {
      updatePayload.conversation_config.agent.prompt = {};
    }
    updatePayload.conversation_config.agent.prompt.ignore_default_personality = true;
    console.log(`   ✓ ignore_default_personality: true (scripted mode)`);
    
    // Add base system prompt if provided - required for agent to speak
    if (additionalOptions?.basePrompt) {
      updatePayload.conversation_config.agent.prompt.prompt = additionalOptions.basePrompt;
      console.log(`   ✓ Base prompt set (${additionalOptions.basePrompt.length} chars)`);
    }
    
    // Include knowledge bases if provided (consolidated in single request)
    if (additionalOptions?.knowledgeBases && additionalOptions.knowledgeBases.length > 0) {
      if (!updatePayload.conversation_config) {
        updatePayload.conversation_config = {};
      }
      if (!updatePayload.conversation_config.agent) {
        updatePayload.conversation_config.agent = {};
      }
      if (!updatePayload.conversation_config.agent.prompt) {
        updatePayload.conversation_config.agent.prompt = {};
      }
      updatePayload.conversation_config.agent.prompt.knowledge_base = additionalOptions.knowledgeBases.map(kb => ({
        type: kb.type === 'text' ? 'text' : 'file',
        name: kb.title,
        id: kb.elevenLabsDocId
      }));
      console.log(`   📚 Knowledge bases: ${additionalOptions.knowledgeBases.length}`);
    }
    
    // Include name update if provided
    if (additionalOptions?.name) {
      updatePayload.name = additionalOptions.name;
      console.log(`   📝 Name update: ${additionalOptions.name}`);
    }
    
    // Include ASR config for Twilio native integration (pcm_16000 for better accuracy)
    if (!updatePayload.conversation_config) {
      updatePayload.conversation_config = {};
    }
    updatePayload.conversation_config.asr = {
      provider: "elevenlabs",
      user_input_audio_format: "pcm_16000"
    };

    console.log(`📤 Sending Flow Agent workflow update (consolidated):`, JSON.stringify(updatePayload, null, 2));

    const result = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(updatePayload),
    });

    console.log(`✅ Flow Agent workflow updated successfully`);
    return result;
  }

  async listAgents(): Promise<{ agents: ElevenLabsAgent[] }> {
    return this.request<{ agents: ElevenLabsAgent[] }>("/convai/agents");
  }

  async getAgent(agentId: string): Promise<ElevenLabsAgent> {
    return this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`);
  }

  /**
   * Verifies agent configuration by fetching from ElevenLabs
   * Used before initiating calls to ensure agent is properly configured
   * @param agentId - ElevenLabs agent ID
   * @returns Full agent configuration from ElevenLabs
   */
  async verifyAgent(agentId: string): Promise<ElevenLabsAgent> {
    console.log(`🔍 Verifying ElevenLabs agent: ${agentId}`);
    const agent = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`);
    console.log(`✅ Agent verified: ${agent.name}`);
    const promptTools = (agent as any)?.conversation_config?.agent?.prompt?.tools;
    const systemToolCount = promptTools?.filter((t: any) => t.type === 'system').length || 0;
    const webhookToolCount = promptTools?.filter((t: any) => t.type === 'webhook').length || 0;
    console.log(`   Prompt tools: ${promptTools?.length || 0} (${systemToolCount} system, ${webhookToolCount} webhook)`);
    console.log(`   Workflow configured: ${(agent as any).workflow ? 'Yes' : 'No'}`);
    return agent;
  }

  /**
   * Updates agent tools configuration
   * Per ElevenLabs API docs: System tools go in prompt.tools array with type: "system"
   * @param agentId - ElevenLabs agent ID
   * @param toolsConfig - Tool configuration parameters
   */
  async updateAgentTools(agentId: string, toolsConfig: {
    transferEnabled?: boolean;
    transferPhoneNumber?: string;
    detectLanguageEnabled?: boolean;
    endConversationEnabled?: boolean;
  }): Promise<ElevenLabsAgent> {
    console.log(`🔧 Updating agent tools: ${agentId}`);
    
    const systemTools = this.buildSystemTools(toolsConfig);
    const workflow = this.buildWorkflow(toolsConfig);
    
    // Per ElevenLabs API docs: System tools go in prompt.tools array
    const updatePayload: any = {
      conversation_config: {
        agent: {
          prompt: {
            tools: systemTools  // Array of system tools
          }
        },
        asr: {
          provider: "elevenlabs",
          user_input_audio_format: "ulaw_8000", // µ-law format for Twilio native integration
        }
      },
      workflow: workflow || { nodes: {}, edges: {} }
    };
    
    console.log(`📤 Sending tools update:`, JSON.stringify(updatePayload, null, 2));
    
    const result = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(updatePayload),
    });
    
    console.log(`✅ Agent tools updated successfully`);
    return result;
  }

  /**
   * Updates agent workflow configuration
   * Separate PATCH call for workflow only
   * @param agentId - ElevenLabs agent ID
   * @param workflowConfig - Workflow configuration parameters
   */
  async updateAgentWorkflow(agentId: string, workflowConfig: {
    transferEnabled?: boolean;
    transferPhoneNumber?: string;
    detectLanguageEnabled?: boolean;
    endConversationEnabled?: boolean;
  }): Promise<ElevenLabsAgent> {
    console.log(`🔄 Updating agent workflow: ${agentId}`);
    
    const workflow = this.buildWorkflow(workflowConfig);
    
    const updatePayload: any = {
      workflow: workflow || { nodes: {}, edges: {} }
    };
    
    console.log(`📤 Sending workflow update:`, JSON.stringify(updatePayload, null, 2));
    
    const result = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(updatePayload),
    });
    
    console.log(`✅ Agent workflow updated successfully`);
    return result;
  }

  async updateAgent(agentId: string, params: Partial<CreateAgentParams>): Promise<ElevenLabsAgent> {
    console.log(`📝 Updating ElevenLabs agent: ${agentId}`);
    console.log(`   Updates:`, JSON.stringify(params, null, 2));
    
    // Build the update payload with correct structure
    const updatePayload: any = {};
    
    if (params.name) {
      updatePayload.name = params.name;
    }
    
    // Build conversation_config updates
    const conversationConfigUpdates: any = {};
    
    // Build agent config
    const agentUpdates: any = {};
    
    // Build system tools as ARRAY for prompt.tools (per ElevenLabs API docs)
    // Check if ANY tool-related property is provided
    const hasAnyToolConfig = params.transferEnabled !== undefined || 
                             params.transferPhoneNumber !== undefined ||
                             params.detectLanguageEnabled !== undefined || 
                             params.endConversationEnabled !== undefined ||
                             params.appointmentBookingEnabled !== undefined;
    
    // Build system tools as ARRAY
    let systemTools: any[] = [];
    let workflowConfig: any = null;
    
    if (hasAnyToolConfig) {
      console.log(`🔧 Building system tools for PATCH`);
      
      systemTools = this.buildSystemTools({
        transferEnabled: params.transferEnabled,
        transferPhoneNumber: params.transferPhoneNumber,
        detectLanguageEnabled: params.detectLanguageEnabled,
        endConversationEnabled: params.endConversationEnabled,
      });
      
      // Skip workflow rebuild if flag is set (for Flow agents whose workflow is managed by flow builder)
      if (params.skipWorkflowRebuild) {
        console.log(`   ⏭️ Skipping workflow rebuild (skipWorkflowRebuild=true)`);
      } else {
        workflowConfig = this.buildWorkflow({
          transferEnabled: params.transferEnabled,
          transferPhoneNumber: params.transferPhoneNumber,
          detectLanguageEnabled: params.detectLanguageEnabled,
          endConversationEnabled: params.endConversationEnabled,
        });
      }
    }
    
    // Build prompt config object - system tools go in prompt.tools array
    const promptConfig: any = {};
    
    if (params.prompt || params.model || params.temperature !== undefined || params.voice_tone || params.personality || params.knowledge_bases !== undefined || hasAnyToolConfig) {
      // Build enhanced prompt with voice tone and personality
      let enhancedPrompt = params.prompt;
      if ((params.voice_tone || params.personality) && params.prompt) {
        const toneText = params.voice_tone ? `Voice Tone: ${params.voice_tone}.` : '';
        const personalityText = params.personality ? `Personality: ${params.personality}.` : '';
        enhancedPrompt = `${toneText}${toneText && personalityText ? ' ' : ''}${personalityText}\n\n${params.prompt}`;
      }
      
      // Enhance prompt with system tools instructions if prompt is being updated
      // Include knowledge base instructions if agent has RAG knowledge bases or ElevenLabs KBs
      if (enhancedPrompt) {
        // Use hasRAGKnowledgeBases flag if provided (for RAG system), otherwise check knowledge_bases array
        const hasKnowledgeBase = params.hasRAGKnowledgeBases || (params.knowledge_bases && params.knowledge_bases.length > 0);
        enhancedPrompt = this.enhanceSystemPromptWithTools(enhancedPrompt, {
          detectLanguageEnabled: params.detectLanguageEnabled,
          endConversationEnabled: params.endConversationEnabled,
          hasKnowledgeBase,
          appointmentBookingEnabled: params.appointmentBookingEnabled,
        });
        promptConfig.prompt = enhancedPrompt;
      }
      
      if (params.model) {
        promptConfig.llm = params.model;
      }
      
      if (params.temperature !== undefined) {
        promptConfig.temperature = params.temperature;
      }
      
      if (params.knowledge_bases !== undefined) {
        promptConfig.knowledge_base = params.knowledge_bases.map(kb => ({
          type: kb.type,
          name: kb.title,
          id: kb.elevenLabsDocId
        }));
      }
      
      // Combine system tools with any custom webhook tools into prompt.tools array
      const allPromptTools: any[] = [...systemTools];
      if (params.tools && params.tools.length > 0) {
        allPromptTools.push(...params.tools);
      }
      
      // Add appointment booking webhook tool if enabled
      // Use the ElevenLabs agent ID (agentId) for the webhook URL since the webhook handler 
      // looks up agents by elevenLabsAgentId to find the database record
      if (params.appointmentBookingEnabled) {
        const appointmentTool = getAppointmentToolForAgent(agentId);
        allPromptTools.push(appointmentTool);
        console.log(`   📅 Appointment booking tool: ${appointmentTool.name}`);
      }
      
      // Add combined tools to prompt.tools (per ElevenLabs API docs)
      if (allPromptTools.length > 0) {
        promptConfig.tools = allPromptTools;
        console.log(`   Prompt tools: ${allPromptTools.length} (${systemTools.length} system + ${params.tools?.length || 0} custom)`);
      } else if (hasAnyToolConfig) {
        // Explicitly set empty tools array if all tools are disabled
        promptConfig.tools = [];
        console.log(`   Prompt tools cleared (all disabled)`);
      }
    }
    
    // Build agent updates
    if (Object.keys(promptConfig).length > 0) {
      agentUpdates.prompt = promptConfig;
    }
    
    if (params.first_message) {
      agentUpdates.first_message = params.first_message;
    }
    
    if (params.language) {
      agentUpdates.language = params.language;
    }
    
    if (Object.keys(agentUpdates).length > 0) {
      conversationConfigUpdates.agent = agentUpdates;
    }
    
    // Include TTS config when voice_id, language, or voice quality settings are provided
    // This prevents accidentally overwriting existing TTS settings when only updating other fields
    // For non-English languages, must use multilingual-compatible models
    const hasVoiceSettings = params.voiceStability !== undefined || 
                             params.voiceSimilarityBoost !== undefined || 
                             params.voiceSpeed !== undefined;
    if (params.voice_id || params.language || hasVoiceSettings) {
      const ttsConfig: any = {
        agent_output_audio_format: "ulaw_8000",
      };
      
      if (params.voice_id) {
        ttsConfig.voice_id = params.voice_id;
      }
      
      // Add voice settings directly to tts object (per ElevenLabs API)
      if (hasVoiceSettings) {
        ttsConfig.stability = params.voiceStability ?? 0.55;
        ttsConfig.similarity_boost = params.voiceSimilarityBoost ?? 0.85;
        ttsConfig.speed = params.voiceSpeed ?? 1.0;
        console.log(`   🎙️ Voice settings: stability=${ttsConfig.stability}, similarity=${ttsConfig.similarity_boost}, speed=${ttsConfig.speed}`);
      }
      
      // Determine TTS model with smart auto-selection
      // Valid models for Conversational AI: eleven_turbo_v2, eleven_flash_v2, eleven_multilingual_v2
      // Note: v2_5 models are NOT supported for conversational/workflow agents
      const validModels = ["eleven_turbo_v2", "eleven_flash_v2", "eleven_multilingual_v2"];
      const requestedModel = params.tts_model;
      const isEnglishLang = !params.language || params.language === "en";
      const smartDefault = isEnglishLang ? "eleven_turbo_v2" : "eleven_multilingual_v2";
      
      if (requestedModel && validModels.includes(requestedModel)) {
        // Use the requested model if valid
        ttsConfig.model_id = requestedModel;
      } else if (requestedModel && !validModels.includes(requestedModel)) {
        // Requested model not valid, use smart default
        console.log(`   ⚠️ TTS model ${requestedModel} is not valid, using ${smartDefault}`);
        ttsConfig.model_id = smartDefault;
      } else if (params.language || params.voice_id) {
        // No model specified but language or voice changed - use smart default
        ttsConfig.model_id = smartDefault;
      }
      
      conversationConfigUpdates.tts = ttsConfig;
    }
    
    // ALWAYS include ASR config for ElevenLabs to ensure proper audio format
    conversationConfigUpdates.asr = {
      provider: "elevenlabs",
      user_input_audio_format: "pcm_8000", // PCM format per ElevenLabs documentation
    };
    
    // Add conversation settings for timeout and events
    conversationConfigUpdates.conversation = {
      max_duration_seconds: 900, // 15 minutes max call duration
      // Valid client events per ElevenLabs API documentation
      client_events: ["audio", "agent_response", "user_transcript", "interruption", "client_tool_call"],
    };
    
    // Add workflow at root level (per ElevenLabs API)
    // Skip workflow updates entirely if skipWorkflowRebuild is set (for Flow agents)
    if (!params.skipWorkflowRebuild) {
      if (workflowConfig) {
        updatePayload.workflow = workflowConfig;
      } else if (hasAnyToolConfig) {
        // Explicitly clear workflow when all tools disabled
        updatePayload.workflow = { nodes: {}, edges: {} };
      }
    }
    
    if (Object.keys(conversationConfigUpdates).length > 0) {
      updatePayload.conversation_config = conversationConfigUpdates;
    }
    
    // Add webhook tools at agent root level (per ElevenLabs API documentation)
    if (params.webhookTools && params.webhookTools.length > 0) {
      updatePayload.tools = params.webhookTools;
      console.log(`   📚 Webhook tools: ${params.webhookTools.map(t => t.name).join(', ')}`);
    }
    
    // Log knowledge base count if provided
    if (params.knowledge_bases !== undefined) {
      console.log(`   Knowledge bases: ${params.knowledge_bases.length} KB(s)`);
    }
    
    console.log(`📤 Sending update to ElevenLabs API:`, JSON.stringify(updatePayload, null, 2));
    
    const result = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(updatePayload),
    });
    
    console.log(`✅ ElevenLabs agent updated successfully`);
    return result;
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/convai/agents/${agentId}`, {
      method: "DELETE",
    });
  }

  /**
   * Raw PATCH update for an agent - used by migration engine
   * Allows setting arbitrary fields without validation
   * 
   * @param agentId - ElevenLabs agent ID
   * @param payload - Raw payload to send to ElevenLabs
   * @returns Updated agent
   */
  async patchAgentRaw(agentId: string, payload: Record<string, any>): Promise<ElevenLabsAgent> {
    console.log(`📤 Raw PATCH to agent ${agentId}:`, JSON.stringify(payload, null, 2));
    
    const result = await this.request<ElevenLabsAgent>(`/convai/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    
    console.log(`✅ Agent raw patch completed`);
    return result;
  }

  /**
   * List all workspace tools from ElevenLabs
   * GET /v1/convai/tools
   */
  async listWorkspaceTools(): Promise<ElevenLabsWorkspaceTool[]> {
    try {
      console.log(`🔧 Fetching workspace tools from ElevenLabs...`);
      const response = await this.request<{ tools: ElevenLabsWorkspaceTool[] }>('/convai/tools');
      console.log(`   Found ${response.tools?.length || 0} workspace tool(s)`);
      return response.tools || [];
    } catch (error: any) {
      console.error(`❌ Failed to list workspace tools:`, error.message);
      return [];
    }
  }

  /**
   * Create a workspace tool in ElevenLabs
   * POST /v1/convai/tools
   * 
   * @param toolConfig - The webhook tool configuration
   * @returns The created tool with its ID
   */
  async createWorkspaceTool(toolConfig: {
    type: "webhook";
    name: string;
    description: string;
    api_schema: {
      url: string;
      method: "GET" | "POST";
      headers?: Record<string, string>;
      request_body_schema?: any;
    };
  }): Promise<ElevenLabsWorkspaceTool> {
    console.log(`🔧 Creating workspace tool: ${toolConfig.name}`);
    console.log(`   URL: ${toolConfig.api_schema.url}`);
    
    const response = await this.request<ElevenLabsWorkspaceTool>('/convai/tools', {
      method: 'POST',
      body: JSON.stringify({ tool_config: toolConfig }),
    });
    
    console.log(`✅ Workspace tool created: ${response.id}`);
    
    // Cache the tool ID (scoped by API key to prevent cross-workspace confusion)
    const cacheKey = getToolCacheKey(this.apiKey, toolConfig.name);
    workspaceToolCache.set(cacheKey, response.id);
    
    return response;
  }

  /**
   * Delete a workspace tool from ElevenLabs
   * DELETE /v1/convai/tools/:tool_id
   */
  async deleteWorkspaceTool(toolId: string): Promise<void> {
    console.log(`🗑️ Deleting workspace tool: ${toolId}`);
    await this.request(`/convai/tools/${toolId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Workspace tool deleted`);
  }

  /**
   * Get or create a workspace tool by name
   * Checks cache first, then lists existing tools, then creates if needed
   * 
   * @param toolConfig - The webhook tool configuration
   * @returns The tool ID
   */
  async getOrCreateWorkspaceTool(toolConfig: {
    type: "webhook";
    name: string;
    description: string;
    api_schema: {
      url: string;
      method: "GET" | "POST";
      headers?: Record<string, string>;
      request_body_schema?: any;
    };
  }): Promise<string> {
    // Check cache first (scoped by API key to prevent cross-workspace confusion)
    const cacheKey = getToolCacheKey(this.apiKey, toolConfig.name);
    const cachedId = workspaceToolCache.get(cacheKey);
    if (cachedId) {
      console.log(`🔧 Using cached workspace tool ID: ${cachedId}`);
      return cachedId;
    }

    // List existing tools to find by name AND URL (to handle agent-specific tools)
    const existingTools = await this.listWorkspaceTools();
    const existingTool = existingTools.find(t => 
      t.tool_config?.name === toolConfig.name &&
      t.tool_config?.api_schema?.url === toolConfig.api_schema.url
    );

    if (existingTool) {
      console.log(`🔧 Found existing workspace tool: ${existingTool.id}`);
      workspaceToolCache.set(cacheKey, existingTool.id);
      return existingTool.id;
    }

    // Create new tool
    const newTool = await this.createWorkspaceTool(toolConfig);
    return newTool.id;
  }

  /**
   * Create workspace tools for webhook nodes and update workflow to use real tool IDs
   * 
   * ElevenLabs workflow tool nodes reference tools by tool_id. For the dispatch to work,
   * these must be actual workspace tool IDs (like tool_xxx), not friendly names.
   * 
   * This function:
   * 1. Creates workspace tools for each webhook tool config
   * 2. Builds a mapping of friendly name -> workspace tool ID
   * 3. Updates the workflow nodes to use the real workspace tool IDs
   * 
   * @param webhookTools - Array of webhook tool configurations
   * @param workflow - The workflow to update (nodes will be modified in place)
   * @returns Map of friendly tool name -> workspace tool ID
   */
  async registerWorkflowToolsAndUpdateWorkflow(
    webhookTools: Array<{ type: "webhook"; name: string; description: string; api_schema: any }>,
    workflow: { nodes: Record<string, any>; edges: Record<string, any> }
  ): Promise<Map<string, string>> {
    const toolIdMapping = new Map<string, string>();
    
    if (!webhookTools || webhookTools.length === 0) {
      return toolIdMapping;
    }
    
    console.log(`🔧 [Workspace Tools] Registering ${webhookTools.length} workflow tool(s)...`);
    
    // Create workspace tools for each webhook and build ID mapping
    for (const tool of webhookTools) {
      try {
        // Create or get existing workspace tool
        const workspaceToolId = await this.getOrCreateWorkspaceTool({
          type: "webhook",
          name: tool.name,
          description: tool.description,
          api_schema: {
            url: tool.api_schema.url,
            method: tool.api_schema.method === 'GET' ? 'GET' : 'POST',
            headers: tool.api_schema.headers || tool.api_schema.request_headers,
            request_body_schema: tool.api_schema.request_body_schema
          }
        });
        
        toolIdMapping.set(tool.name, workspaceToolId);
        console.log(`   ✓ Registered: ${tool.name} -> ${workspaceToolId}`);
      } catch (error: any) {
        console.error(`   ✗ Failed to register ${tool.name}: ${error.message}`);
        // Keep using the friendly name if workspace tool creation fails
        toolIdMapping.set(tool.name, tool.name);
      }
    }
    
    // Update workflow tool nodes to use actual workspace tool IDs
    for (const [nodeId, node] of Object.entries(workflow.nodes)) {
      if (node.type === 'tool' && node.tools && Array.isArray(node.tools)) {
        const updatedTools = node.tools.map((tool: { tool_id: string }) => {
          const friendlyName = tool.tool_id;
          const workspaceToolId = toolIdMapping.get(friendlyName);
          
          if (workspaceToolId && workspaceToolId !== friendlyName) {
            console.log(`   🔄 Node ${nodeId}: ${friendlyName} -> ${workspaceToolId}`);
            return { tool_id: workspaceToolId };
          }
          return tool;
        });
        
        node.tools = updatedTools;
      }
    }
    
    console.log(`✅ [Workspace Tools] Registered ${toolIdMapping.size} tool(s) and updated workflow`);
    
    return toolIdMapping;
  }

  /**
   * Link webhook tools to an agent using full inline configuration
   * ElevenLabs requires full tool config when adding tools to agents
   * (Workspace tools are for dashboard visibility, but agents need inline config)
   * 
   * IMPORTANT: System tools should be passed as an array with type: "system"
   * Per ElevenLabs API: All tools (system + webhook) go in prompt.tools array
   * 
   * This function PRESERVES existing workflow webhook tools (like webhook_node-*)
   * that were set during agent creation, only adding/updating the specified tools.
   * 
   * @param agentId - The ElevenLabs agent ID
   * @param toolConfigs - Array of full webhook tool configurations to add/update
   * @param systemTools - Optional system tools array to merge with webhook tools
   */
  async linkToolsToAgent(agentId: string, toolConfigs: Array<{
    type: "webhook";
    name: string;
    description: string;
    api_schema: {
      url: string;
      method: "GET" | "POST";
      headers?: Record<string, string>;
      request_body_schema?: any;
    };
  }>, systemTools?: any[]): Promise<void> {
    console.log(`🔧 Linking tools to agent ${agentId}`);
    
    // Fetch existing agent to preserve workflow webhook tools
    let existingTools: any[] = [];
    try {
      const agent = await this.getAgent(agentId);
      existingTools = (agent as any)?.conversation_config?.agent?.prompt?.tools || [];
      console.log(`   Found ${existingTools.length} existing tool(s)`);
    } catch (error: any) {
      console.log(`   Could not fetch existing tools: ${error.message}`);
    }
    
    // Get names of tools we're about to add/update
    const newToolNames = new Set([
      ...(toolConfigs.map(t => t.name)),
      ...(systemTools?.map(t => t.name) || [])
    ]);
    
    // Preserve existing workflow webhook tools that we're NOT updating
    // These are typically named like "webhook_node-*" for flow webhook nodes
    const preservedTools = existingTools.filter((tool: any) => {
      if (!tool.name) return false;
      // Skip if we're updating this tool
      if (newToolNames.has(tool.name)) return false;
      // Preserve workflow webhook tools (webhook_node-* pattern)
      if (tool.type === 'webhook' && tool.name.startsWith('webhook_')) {
        console.log(`   Preserving workflow webhook: ${tool.name}`);
        return true;
      }
      return false;
    });
    
    // Per ElevenLabs API: All tools (system + webhook) go in prompt.tools array
    // System tools have type: "system", webhook tools have type: "webhook"
    const allTools: any[] = [];
    
    // Add system tools first (type: "system")
    if (systemTools && systemTools.length > 0) {
      allTools.push(...systemTools);
      console.log(`   System tools: ${systemTools.map(t => t.name).join(', ')}`);
    }
    
    // Add preserved workflow webhook tools
    if (preservedTools.length > 0) {
      allTools.push(...preservedTools);
      console.log(`   Preserved webhooks: ${preservedTools.map((t: any) => t.name).join(', ')}`);
    }
    
    // Add new webhook tools (already have type: "webhook")
    if (toolConfigs.length > 0) {
      allTools.push(...toolConfigs);
      console.log(`   New webhook tools: ${toolConfigs.map(t => t.name).join(', ')}`);
    }
    
    if (allTools.length === 0) {
      console.log(`🔧 No tools to link to agent ${agentId}`);
      return;
    }

    const updatePayload = {
      conversation_config: {
        agent: {
          prompt: {
            tools: allTools
          }
        }
      }
    };

    console.log(`📤 Linking ${allTools.length} tools (${systemTools?.length || 0} system + ${preservedTools.length} preserved + ${toolConfigs.length} new):`, JSON.stringify(updatePayload, null, 2));

    await this.request(`/convai/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(updatePayload),
    });

    console.log(`✅ Tools linked to agent successfully`);
  }

  /**
   * Unlink all custom tools from an agent
   * Sets conversation_config.agent.prompt.tools = []
   */
  async unlinkToolsFromAgent(agentId: string): Promise<void> {
    console.log(`🔧 Unlinking all tools from agent ${agentId}`);

    const updatePayload = {
      conversation_config: {
        agent: {
          prompt: {
            tools: []
          }
        }
      }
    };

    await this.request(`/convai/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(updatePayload),
    });

    console.log(`✅ Tools unlinked from agent`);
  }

  async listVoices(): Promise<{ voices: ElevenLabsVoice[] }> {
    try {
      console.log(`🎤 Fetching voices from ElevenLabs v2 API...`);
      
      // Fetch all voices using v2 API with pagination
      // v2 API uses next_page_token instead of cursor
      const allVoices: ElevenLabsVoice[] = [];
      let nextPageToken: string | null = null;
      let pageCount = 0;
      const maxPages = 10; // Fetch up to 1000 voices (100 per page)
      
      do {
        try {
          // Build URL with pagination token if available
          const url: string = nextPageToken 
            ? `/voices?page_size=100&next_page_token=${encodeURIComponent(nextPageToken)}`
            : `/voices?page_size=100`;
          
          const response: { 
            voices: ElevenLabsVoice[];
            has_more: boolean;
            next_page_token: string | null;
            total_count?: number;
          } = await this.request<{ 
            voices: ElevenLabsVoice[];
            has_more: boolean;
            next_page_token: string | null;
            total_count?: number;
          }>(url, {}, true); // Use v2 API for voices
          
          if (response.voices && response.voices.length > 0) {
            allVoices.push(...response.voices);
            console.log(`📄 Page ${pageCount + 1}: Fetched ${response.voices.length} voices (Total so far: ${allVoices.length})`);
            
            // Log total count if available
            if (pageCount === 0 && response.total_count !== undefined) {
              console.log(`📊 Total available voices: ${response.total_count}`);
            }
          }
          
          // Update pagination state
          nextPageToken = response.has_more && response.next_page_token ? response.next_page_token : null;
          pageCount++;
          
          // Safety check to prevent infinite loops
          if (pageCount >= maxPages) {
            console.log(`⚠️ Reached maximum page limit (${maxPages} pages). Stopping pagination.`);
            break;
          }
        } catch (pageError: any) {
          console.error(`⚠️ Failed to fetch voices page ${pageCount + 1}:`, pageError.message);
          break; // Stop pagination on error
        }
      } while (nextPageToken !== null);
      
      // Deduplicate voices by voice_id (just in case)
      const voiceMap = new Map<string, ElevenLabsVoice>();
      allVoices.forEach(voice => {
        if (voice.voice_id && !voiceMap.has(voice.voice_id)) {
          voiceMap.set(voice.voice_id, voice);
        }
      });
      
      const uniqueVoices = Array.from(voiceMap.values());
      console.log(`✅ Total unique voices fetched: ${uniqueVoices.length} (across ${pageCount} pages)`);
      
      // Print conversational voices in tabular format
      this.printConversationalVoices(uniqueVoices);
      
      return { voices: uniqueVoices };
    } catch (error: any) {
      console.error('❌ Error fetching voices from v2 API:', error);
      throw error;
    }
  }
  
  private printConversationalVoices(voices: ElevenLabsVoice[]): void {
    // Filter voices suitable for conversational/dialogue use
    const conversationalKeywords = ['conversational', 'chat', 'dialogue', 'natural', 'friendly', 'casual'];
    const conversationalVoices = voices.filter(voice => {
      const name = voice.name?.toLowerCase() || '';
      const category = voice.category?.toLowerCase() || '';
      const labels = Object.values(voice.labels || {}).join(' ').toLowerCase();
      
      return conversationalKeywords.some(keyword => 
        name.includes(keyword) || category.includes(keyword) || labels.includes(keyword)
      );
    });
    
    if (conversationalVoices.length > 0) {
      console.log(`\n${'='.repeat(100)}`);
      console.log(`🗣️  CONVERSATIONAL VOICES (${conversationalVoices.length} found)`);
      console.log(`${'='.repeat(100)}`);
      console.log(`${'voice_id'.padEnd(25)} | ${'name'.padEnd(30)} | ${'language'.padEnd(12)} | ${'category'.padEnd(15)}`);
      console.log(`${'-'.repeat(100)}`);
      
      conversationalVoices.forEach(voice => {
        const voiceId = (voice.voice_id || 'N/A').substring(0, 24).padEnd(25);
        const name = (voice.name || 'Unnamed').substring(0, 29).padEnd(30);
        const language = (voice.labels?.language || 'en').substring(0, 11).padEnd(12);
        const category = (voice.category || 'N/A').substring(0, 14).padEnd(15);
        
        console.log(`${voiceId} | ${name} | ${language} | ${category}`);
      });
      
      console.log(`${'='.repeat(100)}\n`);
    } else {
      console.log(`\n⚠️  No voices with conversational/dialogue keywords found.`);
    }
  }

  /**
   * Generate voice preview audio using ElevenLabs TTS API
   * Returns audio buffer in mp3 format
   */
  async generateVoicePreview(params: {
    voiceId: string;
    text: string;
    voiceSettings?: {
      stability?: number;
      similarity_boost?: number;
      speed?: number;
      use_speaker_boost?: boolean;
    };
    modelId?: string;
  }): Promise<Buffer> {
    const { voiceId, text, voiceSettings, modelId } = params;
    
    // Use v1 TTS endpoint
    const url = `${ELEVENLABS_V1_BASE_URL}/text-to-speech/${voiceId}`;
    
    const requestBody: any = {
      text: text,
      model_id: modelId || "eleven_multilingual_v2",
    };
    
    // Add voice settings if provided (style excluded - not supported by Conversational AI)
    if (voiceSettings) {
      requestBody.voice_settings = {
        stability: voiceSettings.stability ?? 0.5,
        similarity_boost: voiceSettings.similarity_boost ?? 0.75,
        speed: voiceSettings.speed ?? 1.0,
        use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
      };
    }
    
    console.log(`🎤 Generating voice preview for voice ${voiceId}...`);
    console.log(`   Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`   Model: ${requestBody.model_id}`);
    if (voiceSettings) {
      console.log(`   Settings: stability=${voiceSettings.stability}, similarity=${voiceSettings.similarity_boost}, speed=${voiceSettings.speed}`);
    }
    
    // Create AbortController for timeout (60 seconds for TTS which can be slow)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
          ...getCorrelationHeaders(), // Propagate correlation ID for distributed tracing
        },
        body: JSON.stringify(requestBody),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Voice preview generation failed: ${response.status} - ${errorText}`);
        throw new ExternalServiceError(
          'ElevenLabs',
          `Failed to generate voice preview: ${response.status} - ${errorText}`,
          undefined,
          { operation: 'voice_preview', statusCode: response.status }
        );
      }
      
      // Get audio as buffer
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      
      console.log(`✅ Voice preview generated: ${audioBuffer.length} bytes`);
      
      return audioBuffer;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new ExternalServiceError(
          'ElevenLabs',
          `Voice preview generation timeout after 60s`,
          undefined,
          { operation: 'voice_preview', timeout: 60000 }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get subscription info including voice slot usage and limits
   * Returns voice_count, max_voice_count and other subscription details
   */
  async getSubscription(): Promise<{
    voice_slots_used: number;
    voice_limit: number;
    professional_voice_slots_used: number;
    professional_voice_limit: number;
    tier: string;
    character_count: number;
    character_limit: number;
    can_extend_voice_limit: boolean;
  }> {
    try {
      const response = await this.request<{
        voice_slots_used: number;
        voice_limit: number;
        professional_voice_slots_used: number;
        professional_voice_limit: number;
        tier: string;
        character_count: number;
        character_limit: number;
        can_extend_voice_limit: boolean;
      }>('/user/subscription');
      
      return response;
    } catch (error: any) {
      console.error('❌ Error fetching subscription info:', error.message);
      throw error;
    }
  }

  /**
   * Fetch shared voices from ElevenLabs Voice Library
   * This returns community-shared voices (5000+) that can be added to any account
   */
  async listSharedVoices(options: {
    page?: number;
    pageSize?: number;
    search?: string;
    language?: string;
    gender?: string;
    age?: string;
    accent?: string;
    category?: string;
    useCases?: string[];
  } = {}): Promise<{
    voices: SharedVoice[];
    hasMore: boolean;
    totalCount?: number;
  }> {
    try {
      const params = new URLSearchParams();
      
      // Pagination
      params.append('page_size', String(options.pageSize || 100));
      if (options.page !== undefined) {
        params.append('page', String(options.page));
      }
      
      // Filters
      if (options.search) {
        params.append('search', options.search);
      }
      if (options.language) {
        params.append('language', options.language);
      }
      if (options.gender) {
        params.append('gender', options.gender);
      }
      if (options.age) {
        params.append('age', options.age);
      }
      if (options.accent) {
        params.append('accent', options.accent);
      }
      if (options.category) {
        params.append('category', options.category);
      }
      if (options.useCases && options.useCases.length > 0) {
        options.useCases.forEach(uc => params.append('use_cases', uc));
      }
      
      console.log(`🎤 Fetching shared voices from ElevenLabs library...`);
      
      const response = await this.request<{
        voices: SharedVoice[];
        has_more: boolean;
        last_sort_id?: string;
      }>(`/shared-voices?${params.toString()}`);
      
      console.log(`✅ Fetched ${response.voices?.length || 0} shared voices`);
      
      return {
        voices: response.voices || [],
        hasMore: response.has_more || false,
      };
    } catch (error: any) {
      console.error('❌ Error fetching shared voices:', error);
      throw error;
    }
  }

  /**
   * Add a shared voice from the library to the current account
   */
  async addSharedVoice(publicOwnerId: string, voiceId: string, newName?: string): Promise<{ voice_id: string }> {
    console.log(`➕ Adding shared voice ${voiceId} from owner ${publicOwnerId}...`);
    
    const response = await this.request<{ voice_id: string }>(
      `/voices/add/${publicOwnerId}/${voiceId}`,
      {
        method: 'POST',
        body: JSON.stringify(newName ? { new_name: newName } : {}),
      }
    );
    
    console.log(`✅ Voice added successfully with ID: ${response.voice_id}`);
    return response;
  }

  async createBatchCall(params: {
    agent_id: string;
    phone_number_id: string;
    recipients: Array<{ phone_number: string; name?: string }>;
  }): Promise<{ batch_id: string }> {
    return this.request<{ batch_id: string }>("/convai/batch-calling/create", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getConversationWebSocketAuth(
    agentId: string,
    customLlmWsUrl?: string
  ): Promise<{ signed_url: string; agent_id?: string }> {
    console.log(`🔐 Getting signed URL for ElevenLabs agent: ${agentId}`);
    
    // Build query parameters
    const params = new URLSearchParams({ agent_id: agentId });
    if (customLlmWsUrl) {
      params.append('custom_llm_ws_url', customLlmWsUrl);
    }

    try {
      const result = await this.request<{ signed_url: string; agent_id?: string }>(
        `/convai/conversation/get_signed_url?${params.toString()}`,
        {
          method: 'GET',
        }
      );
      
      console.log(`✅ Got signed URL for agent ${agentId} (expires in 15 minutes)`);
      return result;
    } catch (error: any) {
      console.error(`❌ Failed to get signed URL for agent ${agentId}:`, error);
      throw error;
    }
  }

  async addKnowledgeToAgent(agentId: string, knowledgeBaseId: string): Promise<void> {
    await this.request(`/convai/agents/${agentId}/add-to-knowledge-base`, {
      method: 'POST', 
      body: JSON.stringify({
        knowledge_base_id: knowledgeBaseId
      }),
    });
  }

  async uploadKnowledgeBaseFile(file: Buffer, filename: string, name?: string): Promise<{ id: string; name: string }> {
    console.log(`📤 Uploading knowledge base file: ${filename}`);
    
    // Determine MIME type from file extension
    const ext = filename.toLowerCase().split('.').pop();
    let mimeType = 'application/octet-stream';
    
    switch (ext) {
      case 'pdf':
        mimeType = 'application/pdf';
        break;
      case 'txt':
        mimeType = 'text/plain';
        break;
      case 'docx':
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        break;
      case 'html':
        mimeType = 'text/html';
        break;
      case 'epub':
        mimeType = 'application/epub+zip';
        break;
    }
    
    console.log(`   MIME type: ${mimeType}`);
    
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file)], { type: mimeType });
    formData.append('file', blob, filename);
    
    if (name) {
      formData.append('name', name);
    }

    // Create AbortController for timeout (60 seconds for file upload)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    try {
      const response = await fetch(`${ELEVENLABS_V1_BASE_URL}/convai/knowledge-base`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'xi-api-key': this.apiKey,
          ...getCorrelationHeaders(), // Propagate correlation ID for distributed tracing
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to upload file: ${response.status} - ${error}`);
      }

      const result = await response.json();
      console.log(`✅ Knowledge base file uploaded: ${result.id}`);
      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new ExternalServiceError(
          'ElevenLabs',
          `Knowledge base file upload timeout after 60s`,
          undefined,
          { operation: 'knowledge_base_upload', timeout: 60000 }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async addKnowledgeBaseFromUrl(url: string, name?: string): Promise<{ id: string; name: string }> {
    console.log(`📤 Adding knowledge base from URL: ${url}`);
    
    const result = await this.request<{ id: string; name: string }>('/convai/knowledge-base/url', {
      method: 'POST',
      body: JSON.stringify({ url, name }),
    });
    
    console.log(`✅ Knowledge base URL added: ${result.id}`);
    return result;
  }

  async addKnowledgeBaseFromText(text: string, name: string): Promise<{ id: string; name: string }> {
    console.log(`📤 Adding knowledge base from text: ${name}`);
    
    const result = await this.request<{ id: string; name: string }>('/convai/knowledge-base/text', {
      method: 'POST',
      body: JSON.stringify({ text, name }),
    });
    
    console.log(`✅ Knowledge base text added: ${result.id}`);
    return result;
  }

  async listKnowledgeBases(params?: {
    page_size?: number;
    search?: string;
    show_only_owned_documents?: boolean;
  }): Promise<{ documents: Array<{ id: string; name: string; type: string; created_at: string }> }> {
    const queryParams = new URLSearchParams();
    
    if (params?.page_size) queryParams.append('page_size', params.page_size.toString());
    if (params?.search) queryParams.append('search', params.search);
    if (params?.show_only_owned_documents !== undefined) {
      queryParams.append('show_only_owned_documents', params.show_only_owned_documents.toString());
    }

    const endpoint = `/convai/knowledge-base${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    return this.request<{ documents: Array<{ id: string; name: string; type: string; created_at: string }> }>(endpoint);
  }

  async getKnowledgeBase(documentId: string): Promise<{ id: string; name: string; type: string; created_at: string }> {
    return this.request<{ id: string; name: string; type: string; created_at: string }>(
      `/convai/knowledge-base/${documentId}`
    );
  }

  async updateKnowledgeBase(documentId: string, name: string): Promise<void> {
    await this.request(`/convai/knowledge-base/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  async deleteKnowledgeBase(documentId: string): Promise<void> {
    console.log(`🗑️  Deleting knowledge base document: ${documentId}`);
    await this.request(`/convai/knowledge-base/${documentId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Knowledge base document deleted`);
  }

  async getLLMPricing(params?: {
    promptLength?: number;
    numberOfPages?: number;
    ragEnabled?: boolean;
  }): Promise<{
    llm_prices: Array<{
      model: string;
      provider: string;
      cost_per_million_input_tokens: number;
      cost_per_million_output_tokens: number;
      cost_per_million_input_cache_read_tokens?: number;
      cost_per_million_input_cache_write_tokens?: number;
      recommended_for?: string[];
      tags?: string[];
    }>;
  }> {
    console.log(`💰 Fetching LLM pricing information from ElevenLabs`);
    
    const result = await this.request<{
      llm_prices: Array<{
        model: string;
        provider: string;
        cost_per_million_input_tokens: number;
        cost_per_million_output_tokens: number;
        cost_per_million_input_cache_read_tokens?: number;
        cost_per_million_input_cache_write_tokens?: number;
        recommended_for?: string[];
        tags?: string[];
      }>;
    }>('/llm-usage/calculate', {
      method: 'POST',
      body: JSON.stringify({
        prompt_length: params?.promptLength || 500,
        number_of_pages: params?.numberOfPages || 0,
        rag_enabled: params?.ragEnabled || false,
      }),
    });
    
    console.log(`✅ Fetched pricing for ${result.llm_prices.length} LLM models`);
    return result;
  }

  async syncPhoneNumberToElevenLabs(params: {
    phoneNumber: string;
    twilioAccountSid: string;
    twilioAuthToken: string;
    label?: string;
    enableOutbound?: boolean;
  }): Promise<{ phone_number_id: string }> {
    console.log(`📞 Syncing phone number to ElevenLabs: ${params.phoneNumber}`);
    
    const result = await this.request<{ phone_number_id: string }>('/convai/phone-numbers', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: params.phoneNumber,
        sid: params.twilioAccountSid,
        token: params.twilioAuthToken,
        label: params.label || params.phoneNumber,
      }),
    });
    
    console.log(`✅ Phone number synced to ElevenLabs: ${result.phone_number_id}`);
    
    // Enable outbound support after syncing (default true for purchased numbers)
    if (params.enableOutbound !== false) {
      console.log(`📞 Enabling outbound support for phone number`);
      await this.updatePhoneNumber(result.phone_number_id, {
        supportsOutbound: true,
      });
      console.log(`✅ Outbound support enabled`);
    }
    
    return result;
  }

  async listPhoneNumbers(): Promise<{
    phone_numbers: Array<{
      phone_number_id: string;
      phone_number: string;
      label: string;
      agent_id?: string;
    }>;
  }> {
    console.log(`📞 Fetching phone numbers from ElevenLabs`);
    const result = await this.request<{
      phone_numbers: Array<{
        phone_number_id: string;
        phone_number: string;
        label: string;
        agent_id?: string;
      }>;
    }>('/convai/phone-numbers');
    console.log(`✅ Fetched ${result.phone_numbers.length} phone number(s)`);
    return result;
  }

  async getPhoneNumber(phoneNumberId: string): Promise<{
    phone_number_id: string;
    phone_number: string;
    label: string;
    agent_id?: string;
  }> {
    return this.request<{
      phone_number_id: string;
      phone_number: string;
      label: string;
      agent_id?: string;
    }>(`/convai/phone-numbers/${phoneNumberId}`);
  }

  async updatePhoneNumber(phoneNumberId: string, params: {
    label?: string;
    agentId?: string | null;
    supportsInbound?: boolean;
    supportsOutbound?: boolean;
    inboundAgentId?: string | null;
  }): Promise<void> {
    console.log(`📞 Updating phone number in ElevenLabs: ${phoneNumberId}`);
    const body: any = {};
    
    if (params.label !== undefined) {
      body.label = params.label;
    }
    if (params.agentId !== undefined) {
      body.agent_id = params.agentId;
    }
    if (params.supportsInbound !== undefined) {
      body.supports_inbound = params.supportsInbound;
    }
    if (params.supportsOutbound !== undefined) {
      body.supports_outbound = params.supportsOutbound;
    }
    if (params.inboundAgentId !== undefined) {
      body.inbound_agent_id = params.inboundAgentId;
    }
    
    console.log(`📞 Update payload:`, JSON.stringify(body));
    
    await this.request(`/convai/phone-numbers/${phoneNumberId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    console.log(`✅ Phone number updated in ElevenLabs`);
  }

  async deletePhoneNumber(phoneNumberId: string): Promise<void> {
    console.log(`📞 Deleting phone number from ElevenLabs: ${phoneNumberId}`);
    await this.request(`/convai/phone-numbers/${phoneNumberId}`, {
      method: 'DELETE',
    });
    console.log(`✅ Phone number deleted from ElevenLabs`);
  }

  async assignAgentToPhoneNumber(phoneNumberId: string, agentId: string, forInbound: boolean = true): Promise<void> {
    console.log(`📞 Assigning agent ${agentId} to phone number ${phoneNumberId} (inbound: ${forInbound})`);
    
    if (forInbound) {
      await this.updatePhoneNumber(phoneNumberId, { 
        agentId,
        inboundAgentId: agentId,
        supportsInbound: true,
      });
    } else {
      await this.updatePhoneNumber(phoneNumberId, { agentId });
    }
    
    console.log(`✅ Agent assigned to phone number`);
  }

  async unassignAgentFromPhoneNumber(phoneNumberId: string): Promise<void> {
    console.log(`📞 Unassigning agent from phone number ${phoneNumberId}`);
    await this.updatePhoneNumber(phoneNumberId, { 
      agentId: null,
      inboundAgentId: null,
      supportsInbound: false,
    });
    console.log(`✅ Agent unassigned from phone number`);
  }

  // ============================================================================
  // CALL INITIATION & CONVERSATION APIs
  // ElevenLabs handles calls directly via native Twilio integration
  // ============================================================================

  /**
   * Initiate an outbound call via ElevenLabs Twilio integration
   * POST /v1/twilio/outbound-call
   * 
   * @see https://elevenlabs.io/docs/api-reference/twilio/outbound-call
   * 
   * @param phoneNumberId - ElevenLabs phone number ID (the "from" number)
   * @param toNumber - Recipient phone number in E.164 format (+1234567890)
   * @param agentId - ElevenLabs agent ID to use for the call
   * @param customSystemPrompt - Optional custom system prompt override
   * @param firstMessage - Optional custom first message
   * @returns Conversation ID and Call SID from ElevenLabs
   */
  async initiateOutboundCall(params: {
    phoneNumberId: string;
    toNumber: string;
    agentId: string;
    customSystemPrompt?: string;
    firstMessage?: string;
  }): Promise<{
    conversation_id: string;
    call_sid?: string;
  }> {
    console.log(`📞 Initiating outbound call via ElevenLabs Twilio API`);
    console.log(`   From (phone_number_id): ${params.phoneNumberId}`);
    console.log(`   To: ${params.toNumber}`);
    console.log(`   Agent: ${params.agentId}`);
    
    const requestBody: any = {
      agent_id: params.agentId,
      agent_phone_number_id: params.phoneNumberId,
      to_number: params.toNumber,
    };
    
    // Add optional overrides via conversation_initiation_client_data
    if (params.customSystemPrompt || params.firstMessage) {
      requestBody.conversation_initiation_client_data = {
        conversation_config_override: {
          agent: {
            ...(params.customSystemPrompt && {
              prompt: {
                prompt: params.customSystemPrompt,
              },
            }),
            ...(params.firstMessage && {
              first_message: params.firstMessage,
            }),
          },
        },
      };
    }
    
    console.log(`📤 Sending outbound call request to /twilio/outbound-call:`, JSON.stringify(requestBody, null, 2));
    
    // Use the correct Twilio outbound call endpoint
    const result = await this.request<{
      success: boolean;
      message: string;
      conversation_id: string | null;
      callSid: string | null;
    }>(`/twilio/outbound-call`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    
    console.log(`✅ Outbound call initiated`);
    console.log(`   Success: ${result.success}`);
    console.log(`   Message: ${result.message}`);
    console.log(`   Conversation ID: ${result.conversation_id}`);
    if (result.callSid) {
      console.log(`   Call SID: ${result.callSid}`);
    }
    
    // Map API response to expected return format
    return {
      conversation_id: result.conversation_id || '',
      call_sid: result.callSid || undefined,
    };
  }

  /**
   * Get list of conversations from ElevenLabs
   * GET /v1/convai/conversations
   * 
   * @param agentId - Optional filter by agent ID
   * @param cursor - Optional pagination cursor
   * @param pageSize - Number of results per page (default 30, max 100)
   * @returns List of conversations with pagination info
   */
  async getConversations(params?: {
    agentId?: string;
    cursor?: string;
    pageSize?: number;
  }): Promise<{
    conversations: Array<{
      conversation_id: string;
      agent_id: string;
      status: 'processing' | 'done' | 'failed';
      start_time_unix_secs: number;
      end_time_unix_secs?: number;
      call_duration_secs?: number;
      message_count?: number;
      metadata?: Record<string, any>;
    }>;
    next_cursor?: string;
    has_more: boolean;
  }> {
    console.log(`📋 Fetching conversations from ElevenLabs`);
    
    const queryParams = new URLSearchParams();
    if (params?.agentId) {
      queryParams.append('agent_id', params.agentId);
    }
    if (params?.cursor) {
      queryParams.append('cursor', params.cursor);
    }
    if (params?.pageSize) {
      queryParams.append('page_size', params.pageSize.toString());
    }
    
    const endpoint = `/convai/conversations${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    
    const result = await this.request<{
      conversations: Array<{
        conversation_id: string;
        agent_id: string;
        status: 'processing' | 'done' | 'failed';
        start_time_unix_secs: number;
        end_time_unix_secs?: number;
        call_duration_secs?: number;
        message_count?: number;
        metadata?: Record<string, any>;
      }>;
      next_cursor?: string;
      has_more: boolean;
    }>(endpoint);
    
    console.log(`✅ Fetched ${result.conversations.length} conversation(s)`);
    return result;
  }

  /**
   * Get detailed conversation information including transcript and recording
   * GET /v1/convai/conversations/{conversation_id}
   * 
   * @param conversationId - ElevenLabs conversation ID
   * @returns Full conversation details with transcript and recording URL
   */
  async getConversationDetails(conversationId: string): Promise<{
    conversation_id: string;
    agent_id: string;
    status: 'processing' | 'done' | 'failed';
    start_time_unix_secs: number;
    end_time_unix_secs?: number;
    call_duration_secs?: number;
    transcript: Array<{
      role: 'agent' | 'user';
      message: string;
      time_in_call_secs: number;
    }>;
    metadata?: {
      call_sid?: string;
      from_number?: string;
      to_number?: string;
      direction?: 'inbound' | 'outbound';
      [key: string]: any;
    };
    analysis?: {
      call_successful?: boolean;
      summary?: string;
      data_collected?: Record<string, any>;
      evaluation_criteria_results?: Record<string, {
        result: string;
        reason: string;
      }>;
    };
    recording_url?: string;
  }> {
    console.log(`📞 Fetching conversation details: ${conversationId}`);
    
    const result = await this.request<{
      conversation_id: string;
      agent_id: string;
      status: 'processing' | 'done' | 'failed';
      start_time_unix_secs: number;
      end_time_unix_secs?: number;
      call_duration_secs?: number;
      transcript: Array<{
        role: 'agent' | 'user';
        message: string;
        time_in_call_secs: number;
      }>;
      metadata?: {
        call_sid?: string;
        from_number?: string;
        to_number?: string;
        direction?: 'inbound' | 'outbound';
        [key: string]: any;
      };
      analysis?: {
        call_successful?: boolean;
        summary?: string;
        data_collected?: Record<string, any>;
        evaluation_criteria_results?: Record<string, {
          result: string;
          reason: string;
        }>;
      };
      recording_url?: string;
    }>(`/convai/conversations/${conversationId}`);
    
    console.log(`✅ Fetched conversation details`);
    console.log(`   Status: ${result.status}`);
    console.log(`   Duration: ${result.call_duration_secs || 0}s`);
    console.log(`   Transcript entries: ${result.transcript?.length || 0}`);
    console.log(`   Has recording: ${result.recording_url ? 'Yes' : 'No'}`);
    
    return result;
  }

  /**
   * Get conversation audio recording
   * GET /v1/convai/conversations/{conversation_id}/audio
   * 
   * @param conversationId - ElevenLabs conversation ID
   * @returns Audio buffer and content type for direct streaming
   */
  async getConversationAudio(conversationId: string): Promise<{
    audioBuffer: Buffer | null;
    contentType: string;
    error?: string;
  }> {
    console.log(`🎙️  Fetching conversation audio: ${conversationId}`);
    
    // Create AbortController for timeout (60 seconds for audio download)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    try {
      const audioUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`;
      
      const response = await fetch(audioUrl, {
        signal: controller.signal,
        headers: {
          'xi-api-key': this.apiKey,
          ...getCorrelationHeaders(), // Propagate correlation ID for distributed tracing
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ ElevenLabs audio fetch failed: ${response.status} - ${errorText}`);
        return {
          audioBuffer: null,
          contentType: 'audio/mpeg',
          error: `Audio not available: ${response.status}`,
        };
      }
      
      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      
      console.log(`✅ Audio fetched: ${audioBuffer.length} bytes`);
      return {
        audioBuffer,
        contentType,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.error(`❌ ElevenLabs audio fetch timeout after 60s`);
        return {
          audioBuffer: null,
          contentType: 'audio/mpeg',
          error: 'Audio fetch timeout after 60s',
        };
      }
      console.error(`❌ ElevenLabs audio fetch error:`, error.message);
      return {
        audioBuffer: null,
        contentType: 'audio/mpeg',
        error: error.message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Delete a conversation from ElevenLabs
   * DELETE /v1/convai/conversations/{conversation_id}
   * 
   * @param conversationId - ElevenLabs conversation ID
   */
  async deleteConversation(conversationId: string): Promise<void> {
    console.log(`🗑️  Deleting conversation: ${conversationId}`);
    
    await this.request(`/convai/conversations/${conversationId}`, {
      method: 'DELETE',
    });
    
    console.log(`✅ Conversation deleted`);
  }

  /**
   * Get agent webhook configuration
   * Used to configure conversation.completed and other webhooks
   * 
   * @param agentId - ElevenLabs agent ID
   * @returns Current webhook configuration
   */
  async getAgentWebhook(agentId: string): Promise<{
    webhook?: {
      url: string;
      events: string[];
      secret?: string;
    };
  }> {
    console.log(`🔗 Fetching webhook config for agent: ${agentId}`);
    
    const agent = await this.getAgent(agentId);
    const webhookConfig = (agent as any).webhook;
    
    console.log(`✅ Webhook config: ${webhookConfig ? JSON.stringify(webhookConfig) : 'Not configured'}`);
    return { webhook: webhookConfig };
  }

  /**
   * Configure webhook for agent to receive call completion notifications
   * PATCH /v1/convai/agents/{agent_id}
   * 
   * @param agentId - ElevenLabs agent ID
   * @param webhookUrl - URL to receive webhook notifications
   * @param events - Array of events to subscribe to (default: ['conversation.completed'])
   * @param secret - Optional secret for webhook signature verification
   */
  async configureAgentWebhook(agentId: string, params: {
    webhookUrl: string;
    events?: string[];
    secret?: string;
  }): Promise<void> {
    console.log(`🔗 Configuring webhook for agent: ${agentId}`);
    console.log(`   URL: ${params.webhookUrl}`);
    console.log(`   Events: ${params.events?.join(', ') || 'conversation.completed'}`);
    
    const updatePayload = {
      webhook: {
        url: params.webhookUrl,
        events: params.events || ['conversation.completed'],
        ...(params.secret && { secret: params.secret }),
      },
    };
    
    await this.request(`/convai/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(updatePayload),
    });
    
    console.log(`✅ Webhook configured for agent`);
  }

  /**
   * Remove webhook configuration from agent
   * 
   * @param agentId - ElevenLabs agent ID
   */
  async removeAgentWebhook(agentId: string): Promise<void> {
    console.log(`🔗 Removing webhook from agent: ${agentId}`);
    
    await this.request(`/convai/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        webhook: null,
      }),
    });
    
    console.log(`✅ Webhook removed from agent`);
  }
}

export const elevenLabsService = new ElevenLabsService();
