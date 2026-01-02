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
/**
 * EnhancedFlowCompiler - Compiles visual flow nodes into ElevenLabs workflow format
 * 
 * Per ElevenLabs API documentation (https://elevenlabs.io/docs/agents-platform/api-reference/agents/update):
 * Valid workflow node types: start, end, phone_number, override_agent, standalone_agent, tool
 * 
 * Subagent nodes (override_agent in API) modify agent behavior at specific workflow points.
 * They can change: System Prompt, LLM, Voice, Tools, Knowledge Base
 * When the workflow transitions to a Subagent node, the agent uses the new prompt
 * to continue the conversation.
 * 
 * ElevenLabs Workflow Format:
 * - workflow.nodes: Record<string, Node>
 * - workflow.edges: Record<string, Edge>
 * 
 * Node Types (per API):
 * - start: Entry point
 * - override_agent: Subagent node - modifies agent config/prompt for this step
 * - end: End the call
 * - phone_number: Transfer to phone number
 * - standalone_agent: Transfer to another agent
 * - tool: Execute a tool
 * 
 * Edge Forward Conditions:
 * - unconditional: Always transition (use for start -> first node)
 * - llm: LLM evaluates condition text (use for user response detection)
 * - result: Based on tool success/failure
 * - expression: Complex boolean expressions
 */

import { FlowNode, FlowEdge } from '@shared/schema';
import { generateFormCollectionPrompt, FormFieldDefinition } from './form-elevenlabs-tool';

// ============================================================================
// LLM Condition Templates - Natural Language Conditions for ElevenLabs
// These descriptive conditions work better with LLM evaluation than short phrases
// ============================================================================

export const LLM_CONDITIONS = {
  // Generic response - use when any response should proceed
  GENERIC_RESPONSE: "The user has verbally responded with any answer. Continue to the next step in the workflow.",
  
  // Question answered - wait for user to provide an answer before proceeding
  QUESTION_ANSWERED: "The user has provided an answer or response to the question. They have given information, a number, a name, an address, or any substantive reply. Proceed to the next step.",
  
  // Yes/acceptance branch
  YES_ACCEPTANCE: "The user agreed, said yes, confirmed positively, or expressed interest.",
  
  // No/rejection branch
  NO_REJECTION: "The user declined, said no, refused, or expressed disinterest.",
  
  // User asked a question (for KB/natural mode handling)
  ASKED_QUESTION: "The user asked a question instead of directly answering. Switch to natural conversation mode and respond helpfully before continuing.",
  
  // User is confused
  CONFUSION: "The user sounded confused or asked for clarification. Ask again politely.",
  
  // No response / silence
  SILENCE: "The user did not respond or remained silent. Ask again or prompt gently.",
  
  // Interruption
  INTERRUPTING: "The user interrupted the message. Stop speaking and listen, then continue based on their intent.",
  
  // Form collection complete - agent has said the explicit completion phrase
  FORM_COMPLETE: "The agent has said 'Your information has been saved successfully' or a very similar confirmation phrase indicating the form submission is complete. Do not transition until this phrase is spoken.",
  
  // Appointment booking complete - agent has confirmed the booking
  APPOINTMENT_COMPLETE: "The agent has said 'Your appointment has been booked successfully' or a very similar confirmation phrase indicating the appointment is confirmed. Do not transition until this phrase is spoken.",
  
  // Transfer intent
  TRANSFER_INTENT: "The user requested to speak with a human, transfer the call, or be connected to support.",
  
  // Appointment specific
  APPOINTMENT_INFO: "The user provided a date, time, or scheduling information for the appointment.",
  
  // Form/data collection
  INFO_PROVIDED: "The user provided the requested information or data."
} as const;

// ============================================================================
// ElevenLabs Node Types
// ============================================================================

interface ElevenLabsPosition {
  x: number;
  y: number;
}

interface ElevenLabsBaseNode {
  type: string;
  position: ElevenLabsPosition;
  edge_order: string[];
}

interface ElevenLabsStartNode extends ElevenLabsBaseNode {
  type: 'start';
}

interface ElevenLabsEndNode extends ElevenLabsBaseNode {
  type: 'end';
}

// OVERRIDE_AGENT NODE - Subagent in ElevenLabs UI
// Per API docs: This is the correct type for Subagent nodes
// Modifies agent config/prompt at specific workflow points
// IMPORTANT: ElevenLabs ignores conversation_config.first_message on workflow nodes
// The actual spoken message must be embedded in additional_prompt as an instruction
interface ElevenLabsOverrideAgentNode extends ElevenLabsBaseNode {
  type: 'override_agent';
  label: string;
  override_prompt: true;  // CRITICAL: Locks the agent to node script, prevents improvisation
  additional_prompt: string;  // Contains "Say exactly: '[message]'" + behavior instructions
  additional_tool_ids: string[];
  additional_knowledge_base: any[];
  conversation_config: {};  // Must be empty {} per ElevenLabs API
}

interface ElevenLabsPhoneNumberNode extends ElevenLabsBaseNode {
  type: 'phone_number';
  transfer_destination: {
    type: 'phone';
    phone_number: string;
  };
  transfer_type: 'conference' | 'blind';
}

interface ElevenLabsStandaloneAgentNode extends ElevenLabsBaseNode {
  type: 'standalone_agent';
  agent_id: string;
  delay_ms: number;
  enable_transferred_agent_first_message: boolean;
}

interface ElevenLabsToolNode extends ElevenLabsBaseNode {
  type: 'tool';
  tools: { tool_id: string }[];
}

// Per ElevenLabs API: Valid node types are start, end, phone_number, override_agent, standalone_agent, tool
type ElevenLabsNode = 
  | ElevenLabsStartNode 
  | ElevenLabsOverrideAgentNode  // Subagent node - modifies agent config/prompt
  | ElevenLabsEndNode 
  | ElevenLabsPhoneNumberNode 
  | ElevenLabsStandaloneAgentNode
  | ElevenLabsToolNode;

// ============================================================================
// ElevenLabs Edge Types
// ============================================================================

interface UnconditionalCondition {
  type: 'unconditional';
}

interface LLMCondition {
  type: 'llm';
  condition: string;
}

interface ResultCondition {
  type: 'result';
  successful: boolean;
}

interface ExpressionCondition {
  type: 'expression';
  expression: any;
}

type ForwardCondition = UnconditionalCondition | LLMCondition | ResultCondition | ExpressionCondition;

interface ElevenLabsEdge {
  source: string;
  target: string;
  forward_condition: ForwardCondition;
}

// ============================================================================
// Output Types
// ============================================================================

export interface ElevenLabsWorkflow {
  nodes: Record<string, ElevenLabsNode>;
  edges: Record<string, ElevenLabsEdge>;
}

export interface FormNodeInfo {
  formId: string;
  formName: string;
  fields: FormFieldDefinition[];
}

export interface WebhookNodeInfo {
  toolId: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  payload?: Record<string, any>;
}

export interface PlayAudioNodeInfo {
  nodeId: string;
  audioUrl: string;
  audioFileName: string;
  interruptible: boolean;
  waitForComplete: boolean;
}

export interface EnhancedCompileResult {
  workflow: ElevenLabsWorkflow;
  firstMessage?: string;
  hasTransferNodes: boolean;
  hasAppointmentNodes?: boolean;
  hasFormNodes?: boolean;
  formNodes?: FormNodeInfo[];
  hasWebhookNodes?: boolean;
  webhookNodes?: WebhookNodeInfo[];
  hasPlayAudioNodes?: boolean;
  playAudioNodes?: PlayAudioNodeInfo[];
  toolIds: string[];
}

// ============================================================================
// Enhanced Flow Compiler
// ============================================================================

export class EnhancedFlowCompiler {
  private nodes: FlowNode[];
  private edges: FlowEdge[];
  private compiledNodes: Record<string, ElevenLabsNode> = {};
  private compiledEdges: Record<string, ElevenLabsEdge> = {};
  private edgeIdCounter = 0;
  private entryNodeId: string | null = null;
  private hasTransferNodes = false;
  private hasAppointmentNodes = false;
  private hasFormNodes = false;
  private hasWebhookNodes = false;
  private hasPlayAudioNodes = false;
  private formNodes: FormNodeInfo[] = [];
  private webhookNodes: WebhookNodeInfo[] = [];
  private playAudioNodes: PlayAudioNodeInfo[] = [];
  private toolIds: string[] = [];

  constructor(nodes: FlowNode[], edges: FlowEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
  }

  /**
   * Compile the visual flow into ElevenLabs workflow format
   */
  compile(): EnhancedCompileResult {
    console.log(`🔧 [EnhancedFlowCompiler] Starting compilation...`);
    console.log(`   Input: ${this.nodes.length} nodes, ${this.edges.length} edges`);

    // Find the entry node (first node after start or first actionable node)
    const entryNode = this.findEntryNode();
    this.entryNodeId = entryNode?.id || null;

    // Extract first message from entry node if it's a Message type
    // NOTE: In scripted workflow mode (ignore_default_personality: true), 
    // ElevenLabs does NOT speak first_message. The entry node must speak it.
    // We extract it for logging only, but the entry node MUST handle the greeting.
    let firstMessage: string | undefined;
    
    if (entryNode) {
      const nodeType = this.getNodeType(entryNode);
      const config = this.getNodeConfig(entryNode);
      
      if (nodeType === 'message' && config.message) {
        const msg: string = config.message;
        firstMessage = msg;
        
        const preview = msg.length > 50 ? msg.substring(0, 50) + '...' : msg;
        console.log(`   📝 First message extracted: "${preview}"`);
        console.log(`   📢 Entry node will speak the greeting (scripted mode)`);
      }
    }

    // Create mandatory start node
    const startNodeId = 'start_node';
    this.compiledNodes[startNodeId] = {
      type: 'start',
      position: { x: 0, y: 0 },
      edge_order: []
    };

    // First pass: Compile all nodes
    // All nodes are compiled normally - entry node speaks the greeting
    for (const node of this.nodes) {
      const compiledNode = this.compileNode(node);
      if (compiledNode) {
        this.compiledNodes[node.id] = compiledNode;
      }
    }

    // Second pass: Process edges (no special handling needed - workflow structure intact)
    this.processEdges();

    // Connect start node to entry node (workflow structure stays intact)
    if (entryNode && this.compiledNodes[entryNode.id]) {
      const startEdgeId = 'start_to_entry';
      this.compiledEdges[startEdgeId] = {
        source: startNodeId,
        target: entryNode.id,
        forward_condition: { type: 'unconditional' }
      };
      (this.compiledNodes[startNodeId] as ElevenLabsStartNode).edge_order.push(startEdgeId);
      console.log(`   🔗 Connected start -> ${entryNode.id}`);
    }

    console.log(`   ✅ Compiled: ${Object.keys(this.compiledNodes).length} nodes, ${Object.keys(this.compiledEdges).length} edges`);
    console.log(`   📞 Has transfer nodes: ${this.hasTransferNodes}`);
    console.log(`   🔧 Tool IDs: ${this.toolIds.length > 0 ? this.toolIds.join(', ') : 'none'}`);
    
    // Debug: Log compiled node types and structure
    console.log(`\n   📊 Compiled Workflow Structure:`);
    for (const [nodeId, node] of Object.entries(this.compiledNodes)) {
      const nodeType = (node as any).type;
      const edgeCount = node.edge_order.length;
      let detail = '';
      
      if (nodeType === 'override_agent') {
        const overrideNode = node as ElevenLabsOverrideAgentNode;
        const label = overrideNode.label || '';
        detail = ` - label: "${label}"`;
      }
      
      console.log(`      [${nodeId}] type: ${nodeType}, edges: ${edgeCount}${detail}`);
    }
    
    console.log(`\n   🔗 Compiled Edges:`);
    for (const [edgeId, edge] of Object.entries(this.compiledEdges)) {
      const condType = edge.forward_condition.type;
      const condDetail = condType === 'llm' 
        ? ` "${(edge.forward_condition as LLMCondition).condition.substring(0, 30)}..."`
        : '';
      console.log(`      [${edgeId}] ${edge.source} -> ${edge.target} (${condType}${condDetail})`);
    }

    return {
      workflow: {
        nodes: this.compiledNodes,
        edges: this.compiledEdges
      },
      firstMessage,
      hasTransferNodes: this.hasTransferNodes,
      hasAppointmentNodes: this.hasAppointmentNodes,
      hasFormNodes: this.hasFormNodes,
      formNodes: this.formNodes,
      hasWebhookNodes: this.hasWebhookNodes,
      webhookNodes: this.webhookNodes,
      hasPlayAudioNodes: this.hasPlayAudioNodes,
      playAudioNodes: this.playAudioNodes,
      toolIds: this.toolIds
    };
  }

  /**
   * Find the entry node - first actionable node in the flow
   */
  private findEntryNode(): FlowNode | undefined {
    // Look for explicit start/trigger nodes
    const startNode = this.nodes.find(n => {
      const type = this.getNodeType(n);
      return type === 'start' || type === 'trigger';
    });

    if (startNode) {
      // Find the first node connected from start
      const outgoingEdge = this.edges.find(e => e.source === startNode.id);
      if (outgoingEdge) {
        return this.nodes.find(n => n.id === outgoingEdge.target);
      }
    }

    // Find nodes with no incoming edges (excluding condition nodes)
    const targetIds = new Set(this.edges.map(e => e.target));
    for (const node of this.nodes) {
      const type = this.getNodeType(node);
      if (!targetIds.has(node.id) && type !== 'condition' && type !== 'start' && type !== 'trigger') {
        return node;
      }
    }

    // Fall back to first non-utility node
    return this.nodes.find(n => {
      const type = this.getNodeType(n);
      return type !== 'condition' && type !== 'start' && type !== 'trigger';
    });
  }

  /**
   * Get node type from React Flow node
   */
  private getNodeType(node: FlowNode): string {
    const data = node.data || {};
    const config = data.config || {};
    return config.type || node.type || 'unknown';
  }

  /**
   * Get node config
   */
  private getNodeConfig(node: FlowNode): any {
    return node.data?.config || {};
  }

  /**
   * Generate unique edge ID
   */
  private generateEdgeId(source: string, target: string): string {
    this.edgeIdCounter++;
    return `edge_${this.edgeIdCounter}_${source.substring(0, 8)}_to_${target.substring(0, 8)}`;
  }

  /**
   * Create additional_prompt for message delivery nodes
   * STRICT FORMAT: Locks agent to exact script, prevents improvisation
   * NOTE: Message nodes have UNCONDITIONAL transitions - they speak and immediately proceed
   * Do NOT say "wait for response" as this conflicts with the unconditional edge
   */
  private createMessagePrompt(text: string, nodeLabel: string): string {
    return `Say exactly: '${text}' Do not add anything else. After speaking, proceed immediately to the next step.`;
  }

  /**
   * Create additional_prompt for question nodes
   * STRICT FORMAT: Locks agent to exact script, prevents improvisation
   */
  private createQuestionPrompt(question: string, variableName: string, nodeLabel: string): string {
    return `Say exactly: '${question}' Then stop speaking and wait for response. Do not add anything else.`;
  }

  /**
   * Create additional_prompt for appointment scheduling nodes
   * STRICT FORMAT: Locks agent to exact script, prevents improvisation
   */
  private createAppointmentPrompt(introMessage: string, config: any, nodeLabel: string): string {
    const serviceName = config.serviceName || config.service || 'appointment';
    const duration = config.duration || 30;
    
    return `Say exactly: '${introMessage}'

APPOINTMENT BOOKING INSTRUCTIONS:
1. After the caller responds, collect the following information:
   - Their name (if not already known)
   - Preferred date for the appointment
   - Preferred time for the appointment
   - Phone number (use the caller's number if available)
   - Email address (optional)

2. Once you have collected the date, time, and caller name, IMMEDIATELY use the book_appointment tool to save the appointment.
   - Pass the caller's name as contactName
   - Pass the caller's phone number as contactPhone
   - Pass the date as appointmentDate (format: YYYY-MM-DD)
   - Pass the time as appointmentTime (format: HH:MM)
   - Pass ${duration} as duration
   - Pass "${serviceName}" as serviceName
   - Pass any notes as notes

3. CRITICAL: After successfully booking, you MUST say exactly: "Your appointment has been booked successfully." This exact phrase signals completion.
4. If booking fails, apologize and try again or offer to transfer to a human.
5. Only after saying "Your appointment has been booked successfully" should you proceed to the next step.

PHONE NUMBER PRONUNCIATION: When reading back or confirming any phone number, ALWAYS speak each digit separately with brief pauses. For example:
- "9990155993" should be spoken as "nine, nine, nine, zero, one, five, five, nine, nine, three"
- Never read phone numbers as large numbers (do NOT say "nine hundred ninety-nine million...")
- Group digits in sets of 3 or 4 for natural reading rhythm

Then stop speaking and wait for response.`;
  }

  /**
   * Create additional_prompt for form/data collection nodes
   * Uses the generateFormCollectionPrompt from form-elevenlabs-tool for proper field collection
   */
  private createFormPrompt(introMessage: string, config: any, nodeLabel: string): string {
    const formName = config.formName || 'Data Collection';
    const fields: FormFieldDefinition[] = config.fields || [];
    
    // If we have fields defined, use the proper form collection prompt
    if (fields.length > 0) {
      return generateFormCollectionPrompt(introMessage, formName, fields);
    }
    
    // Fallback for forms without pre-loaded fields
    return `Say exactly: '${introMessage}'

FORM COLLECTION INSTRUCTIONS for "${formName}":
After speaking the introduction, collect the requested information from the caller.
Ask questions one at a time and wait for responses.
Once all information is collected, use the submit_form tool to save the responses.

Then stop speaking and wait for response.`;
  }

  /**
   * Create additional_prompt for delay/pause nodes
   * STRICT FORMAT: Locks agent to exact script, prevents improvisation
   * NOTE: Delay nodes typically have UNCONDITIONAL transitions - they speak and proceed
   */
  private createDelayPrompt(waitMessage: string, config: any, nodeLabel: string): string {
    return `Say exactly: '${waitMessage}' Do not add anything else. After speaking, proceed immediately to the next step.`;
  }

  /**
   * Compile a single node into ElevenLabs format
   */
  private compileNode(node: FlowNode): ElevenLabsNode | null {
    const nodeType = this.getNodeType(node);
    const config = this.getNodeConfig(node);
    const position = node.position || { x: 0, y: 0 };
    const label = config.label || config.name || nodeType || 'Node';
    const isEntryNode = node.id === this.entryNodeId;

    switch (nodeType) {
      case 'start':
      case 'trigger':
        // Skip - we create our own start node
        return null;

      case 'message': {
        const messageText = config.message || 'Hello';
        
        console.log(`   📢 Compiling Message node: "${messageText.substring(0, 50)}..."`);
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label,
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createMessagePrompt(messageText, label),
          additional_tool_ids: [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }

      case 'question': {
        const questionText = config.question || config.message || 'How can I help you?';
        const variableName = config.variableName || config.variable || 'response';
        
        console.log(`   ❓ Compiling Question node: "${questionText.substring(0, 50)}..."`);
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label,
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createQuestionPrompt(questionText, variableName, label),
          additional_tool_ids: [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }

      case 'appointment': {
        const introMessage = config.message || config.introMessage || "I can help you schedule an appointment.";
        
        // Mark that this flow has appointment nodes (for webhook tool registration)
        this.hasAppointmentNodes = true;
        
        console.log(`   📅 Compiling Appointment node: "${introMessage.substring(0, 50)}..."`);
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label || 'Appointment',
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createAppointmentPrompt(introMessage, config, label),
          additional_tool_ids: [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }

      case 'form':
      case 'form_submission':
      case 'collect_info': {
        const introMessage = config.message || config.introMessage || "I need to collect some information from you.";
        const formId = config.formId;
        const formName = config.formName || 'Data Collection';
        const fields: FormFieldDefinition[] = config.fields || [];
        
        // Mark that this flow has form nodes (for webhook tool registration)
        this.hasFormNodes = true;
        
        // Track form info for tool registration
        if (formId) {
          this.formNodes.push({
            formId,
            formName,
            fields
          });
        }
        
        console.log(`   📋 Compiling Form node: "${introMessage.substring(0, 50)}..."`);
        console.log(`      Form ID: ${formId || 'none'}, Fields: ${fields.length}`);
        
        // Generate tool ID for submit_form webhook (must match what's registered with ElevenLabs)
        const formIdSuffix = formId ? formId.slice(-8) : '';
        const submitFormToolId = formId ? `submit_form_${formIdSuffix}` : '';
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label || 'Form',
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createFormPrompt(introMessage, config, label),
          additional_tool_ids: formId ? [submitFormToolId] : [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }

      case 'delay':
      case 'wait':
      case 'pause': {
        const waitMessage = config.message || config.waitMessage || "One moment please...";
        
        console.log(`   ⏳ Compiling Delay node: "${waitMessage.substring(0, 50)}..."`);
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label || 'Delay',
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createDelayPrompt(waitMessage, config, label),
          additional_tool_ids: [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }

      case 'transfer':
      case 'transfer_call':
      case 'phone_transfer': {
        this.hasTransferNodes = true;
        const phoneNumber = config.phoneNumber || config.transferNumber || config.number || '';
        const transferType = config.transferType || 'conference';

        return {
          type: 'phone_number',
          position,
          edge_order: [],
          transfer_destination: {
            type: 'phone',
            phone_number: phoneNumber
          },
          transfer_type: transferType as 'conference' | 'blind'
        };
      }

      case 'agent_transfer':
      case 'transfer_agent': {
        const agentId = config.agentId || config.agent_id || '';
        
        return {
          type: 'standalone_agent',
          position,
          edge_order: [],
          agent_id: agentId,
          delay_ms: config.delay_ms || 0,
          enable_transferred_agent_first_message: config.enableFirstMessage ?? true
        };
      }

      case 'end':
      case 'end_call':
      case 'hangup': {
        return {
          type: 'end',
          position,
          edge_order: []
        };
      }

      case 'webhook':
      case 'api_call':
      case 'tool': {
        // Check both config (node.data.config) and node.data for webhook properties
        // Templates may store properties directly on node.data instead of node.data.config
        const nodeData = (node.data || {}) as any;
        
        const toolId = config.toolId || config.tool_id || config.name || 
                       nodeData.toolId || nodeData.tool_id || nodeData.name || `webhook_${node.id}`;
        this.toolIds.push(toolId);
        
        // Capture webhook configuration for tool registration
        // Check multiple property names for URL (UI uses webhookUrl, templates use url)
        // Priority: config.url > config.webhookUrl > nodeData.url > nodeData.webhookUrl
        const webhookUrl = config.url || config.webhookUrl || nodeData.url || nodeData.webhookUrl || '';
        const webhookMethod = config.method || nodeData.method || 'POST';
        const webhookHeaders = config.headers || nodeData.headers;
        const webhookPayload = config.payload || nodeData.payload;
        
        if (webhookUrl) {
          this.hasWebhookNodes = true;
          this.webhookNodes.push({
            toolId,
            url: webhookUrl,
            method: webhookMethod as "GET" | "POST" | "PUT" | "PATCH",
            headers: webhookHeaders,
            payload: webhookPayload
          });
          console.log(`   🔗 Webhook node configured: ${toolId} -> ${webhookMethod} ${webhookUrl}`);
        } else {
          console.warn(`   ⚠️ Webhook node ${node.id} has no URL configured`);
        }
        
        return {
          type: 'tool',
          position,
          edge_order: [],
          tools: [{ tool_id: toolId }]
        };
      }

      case 'condition':
        // Condition nodes are processed as edge logic, not as workflow nodes
        return null;

      case 'play_audio': {
        const audioUrl = config.audioUrl || '';
        const audioFileName = config.audioFileName || 'audio';
        const interruptible = config.interruptible ?? false;
        const waitForComplete = config.waitForComplete ?? true;
        
        if (!audioUrl) {
          console.warn(`   ⚠️ Play Audio node ${node.id} has no audio URL configured`);
        }
        
        const toolId = `play_audio_${node.id.slice(-8)}`;
        this.toolIds.push(toolId);
        
        this.hasPlayAudioNodes = true;
        this.playAudioNodes.push({
          nodeId: node.id,
          audioUrl,
          audioFileName,
          interruptible,
          waitForComplete
        });
        
        console.log(`   🔊 Compiling Play Audio node: ${audioUrl}`);
        
        return {
          type: 'tool',
          position,
          edge_order: [],
          tools: [{ tool_id: toolId }]
        };
      }

      default: {
        // Unknown node types become override_agent (Subagent) with their content
        const message = config.message || config.text || 'How may I assist you?';
        
        console.log(`   🔄 Compiling unknown node type '${nodeType}' as Subagent`);
        
        return {
          type: 'override_agent',
          position,
          edge_order: [],
          label: label || nodeType,
          override_prompt: true,  // CRITICAL: Locks agent to exact script
          additional_prompt: this.createMessagePrompt(message, label),
          additional_tool_ids: [],
          additional_knowledge_base: [],
          conversation_config: {}
        };
      }
    }
  }

  /**
   * Process all edges in the flow
   */
  private processEdges(): void {
    // Identify condition nodes for special handling
    const conditionNodeIds = new Set(
      this.nodes
        .filter(n => this.getNodeType(n) === 'condition')
        .map(n => n.id)
    );

    // Map edges entering condition nodes
    const edgesToConditions: Map<string, FlowEdge> = new Map();
    
    for (const edge of this.edges) {
      if (conditionNodeIds.has(edge.target)) {
        edgesToConditions.set(edge.target, edge);
      }
    }

    // Process each edge
    for (const edge of this.edges) {
      const sourceNode = this.nodes.find(n => n.id === edge.source);
      const sourceType = this.getNodeType(sourceNode || {} as FlowNode);
      
      // Skip edges from start/trigger nodes (we handle start->entry separately)
      if (sourceType === 'start' || sourceType === 'trigger') {
        continue;
      }

      if (conditionNodeIds.has(edge.source)) {
        // Edge coming FROM a condition node - process as conditional
        this.processConditionEdge(edge, edgesToConditions);
      } else if (!conditionNodeIds.has(edge.target)) {
        // Normal edge (not involving condition nodes)
        // For message/question nodes, use LLM condition to wait for user response
        const forwardCondition = this.buildForwardConditionForNodeType(sourceType, sourceNode, edge);
        this.addEdge(edge.source, edge.target, forwardCondition);
      }
      // Edges TO condition nodes are handled when processing FROM edges
    }
  }

  /**
   * Build appropriate forward condition based on source node type and waitForResponse config
   * 
   * Dynamic behavior based on user-configurable waitForResponse setting:
   * - waitForResponse = true  → LLM condition (waits for user response before proceeding)
   * - waitForResponse = false → unconditional (proceeds immediately after speaking)
   * 
   * Smart defaults when waitForResponse is not explicitly set:
   * - Message nodes: false (proceed immediately)
   * - Question nodes: true (wait for answer)
   * - Form/Appointment: true (wait for data collection)
   * - Delay nodes: false (proceed after delay)
   */
  private buildForwardConditionForNodeType(
    sourceType: string, 
    sourceNode: FlowNode | undefined,
    edge: FlowEdge
  ): ForwardCondition {
    const config = sourceNode ? this.getNodeConfig(sourceNode) : {};
    const edgeData = (edge as any).data || {};
    
    // Priority 1: Custom condition from flow builder (edge.data.condition)
    if (edgeData.condition && typeof edgeData.condition === 'string') {
      return {
        type: 'llm',
        condition: edgeData.condition
      };
    }
    
    // Priority 2: Check if edge has explicit sourceHandle conditions (yes/no/transfer branching)
    if (edge.sourceHandle) {
      const handle = edge.sourceHandle.toLowerCase();
      
      // Yes/acceptance handles
      if (handle === 'yes' || handle === 'true' || handle === 'accept' || handle === 'agree') {
        return {
          type: 'llm',
          condition: LLM_CONDITIONS.YES_ACCEPTANCE
        };
      }
      
      // No/rejection handles
      if (handle === 'no' || handle === 'false' || handle === 'reject' || handle === 'decline') {
        return {
          type: 'llm',
          condition: LLM_CONDITIONS.NO_REJECTION
        };
      }
      
      // Transfer intent handles
      if (handle === 'transfer' || handle === 'human' || handle === 'agent') {
        return {
          type: 'llm',
          condition: LLM_CONDITIONS.TRANSFER_INTENT
        };
      }
      
      // Question/confusion handles
      if (handle === 'question' || handle === 'confused' || handle === 'clarify') {
        return {
          type: 'llm',
          condition: LLM_CONDITIONS.CONFUSION
        };
      }
      
      // Silence/no response handles
      if (handle === 'silence' || handle === 'noresponse' || handle === 'timeout') {
        return {
          type: 'llm',
          condition: LLM_CONDITIONS.SILENCE
        };
      }
    }
    
    // Priority 3: Use waitForResponse setting from node config (user-configurable)
    // This provides dynamic control over when agent waits vs proceeds immediately
    const waitForResponse = this.getWaitForResponseSetting(sourceType, config);
    
    // If waitForResponse is false, use unconditional (proceed immediately)
    if (!waitForResponse) {
      return { type: 'unconditional' };
    }
    
    // waitForResponse is true - generate appropriate LLM condition based on node type
    return this.buildWaitConditionForNodeType(sourceType, config);
  }
  
  /**
   * Get the waitForResponse setting for a node, using smart defaults per type
   */
  private getWaitForResponseSetting(sourceType: string, config: Record<string, any>): boolean {
    // If explicitly set in config, use that value
    if (typeof config.waitForResponse === 'boolean') {
      return config.waitForResponse;
    }
    
    // Smart defaults based on node type
    switch (sourceType) {
      case 'question':
        return true; // Questions should wait for answers by default
        
      case 'form':
      case 'form_submission':
      case 'collect_info':
        return true; // Forms need data collection to complete
        
      case 'appointment':
        return true; // Appointments need booking to complete
        
      case 'message':
      case 'greeting':
      case 'delay':
      case 'wait':
      case 'pause':
        return false; // Messages/delays proceed immediately by default
        
      default:
        return false; // Unknown types proceed immediately
    }
  }
  
  /**
   * Build the appropriate LLM wait condition for a node type
   * Called when waitForResponse is true
   */
  private buildWaitConditionForNodeType(sourceType: string, config: Record<string, any>): ForwardCondition {
    switch (sourceType) {
      case 'question':
        // Question nodes: LLM must wait for user to answer THIS SPECIFIC question
        const questionText = config.message || config.question || config.text || '';
        if (questionText) {
          const shortQuestion = questionText.substring(0, 100).replace(/['"]/g, '');
          return {
            type: 'llm',
            condition: `The agent just asked: "${shortQuestion}" and the user has now responded specifically to THIS question. The user's response directly addresses what was just asked. Proceed only after the user responds to this specific question.`
          };
        }
        return { 
          type: 'llm', 
          condition: LLM_CONDITIONS.QUESTION_ANSWERED 
        };
        
      case 'form':
      case 'form_submission':
      case 'collect_info':
        return { 
          type: 'llm', 
          condition: LLM_CONDITIONS.FORM_COMPLETE 
        };
        
      case 'appointment':
        return { 
          type: 'llm', 
          condition: LLM_CONDITIONS.APPOINTMENT_COMPLETE 
        };
        
      case 'message':
      case 'greeting':
        // When message node has waitForResponse=true, wait for any response
        const messageText = config.message || config.text || '';
        if (messageText) {
          const shortMessage = messageText.substring(0, 80).replace(/['"]/g, '');
          return {
            type: 'llm',
            condition: `The agent said: "${shortMessage}..." and is waiting for the user to respond before proceeding. Wait for the user to speak.`
          };
        }
        return { 
          type: 'llm', 
          condition: LLM_CONDITIONS.GENERIC_RESPONSE 
        };
        
      default:
        // For any other type with waitForResponse=true, wait for generic response
        return { 
          type: 'llm', 
          condition: LLM_CONDITIONS.GENERIC_RESPONSE 
        };
    }
  }

  /**
   * Process an edge coming from a condition node
   */
  private processConditionEdge(edge: FlowEdge, edgesToConditions: Map<string, FlowEdge>): void {
    const conditionNode = this.nodes.find(n => n.id === edge.source);
    if (!conditionNode) return;

    const incomingEdge = edgesToConditions.get(conditionNode.id);
    if (!incomingEdge) return;

    // Skip if source node doesn't exist in compiled nodes
    if (!this.compiledNodes[incomingEdge.source]) return;

    const config = this.getNodeConfig(conditionNode);
    const conditions = config.conditions || [];

    // Build condition text for this edge
    let conditionText = '';

    if (conditions.length > 0) {
      // Try to match by targetNodeId
      const matchingCondition = conditions.find((c: any) => c.targetNodeId === edge.target);
      
      if (matchingCondition) {
        conditionText = this.buildConditionText(matchingCondition, config);
      } else {
        // Try matching by sourceHandle
        const handleCondition = conditions.find((c: any) => 
          c.id === edge.sourceHandle || c.label === edge.sourceHandle
        );
        if (handleCondition) {
          conditionText = this.buildConditionText(handleCondition, config);
        }
      }
    }

    // Fallback to sourceHandle-based conditions
    if (!conditionText && edge.sourceHandle) {
      conditionText = this.buildHandleCondition(edge.sourceHandle);
    }

    // Create edge from the node before condition to the target
    const forwardCondition: ForwardCondition = conditionText
      ? { type: 'llm', condition: conditionText }
      : { type: 'unconditional' };

    this.addEdge(incomingEdge.source, edge.target, forwardCondition);
  }

  /**
   * Build condition text from a condition config
   */
  private buildConditionText(condition: any, nodeConfig: any): string {
    const conditionType = condition.type || 'keyword';
    const value = condition.value || condition.label || '';
    const description = condition.description || '';

    // Use description if provided
    if (description) {
      return description;
    }

    // Yes/No conditions
    if (conditionType === 'yes_no' || conditionType === 'boolean') {
      if (value.toLowerCase() === 'yes' || value.toLowerCase() === 'true') {
        return 'User said yes or agreed';
      } else if (value.toLowerCase() === 'no' || value.toLowerCase() === 'false') {
        return 'User said no or declined';
      }
    }

    // Sentiment conditions
    if (conditionType === 'sentiment') {
      const sentiment = value.toLowerCase();
      if (sentiment === 'positive' || sentiment === 'interested') {
        return 'User sounds interested';
      } else if (sentiment === 'negative' || sentiment === 'not_interested') {
        return 'User sounds not interested';
      } else if (sentiment === 'neutral') {
        return 'User sounds neutral';
      }
    }

    // Keyword/value matching
    if (value) {
      return `User mentioned "${value}"`;
    }

    return '';
  }

  /**
   * Build condition from edge sourceHandle
   */
  private buildHandleCondition(handle: string): string {
    const h = handle.toLowerCase();
    
    if (h === 'true' || h === 'yes') {
      return 'User said yes or agreed';
    }
    if (h === 'false' || h === 'no') {
      return 'User said no or declined';
    }
    if (h === 'default' || h === 'else' || h === 'otherwise') {
      return 'Other cases';
    }
    
    return `User mentioned "${handle}"`;
  }

  /**
   * Add an edge to the compiled output
   */
  private addEdge(source: string, target: string, forwardCondition: ForwardCondition): void {
    // Skip if source or target doesn't exist
    if (!this.compiledNodes[source]) return;
    if (!this.compiledNodes[target] && target !== 'start_node') return;

    const edgeId = this.generateEdgeId(source, target);

    this.compiledEdges[edgeId] = {
      source,
      target,
      forward_condition: forwardCondition
    };

    // Add to source node's edge_order
    const sourceNode = this.compiledNodes[source];
    if (sourceNode && 'edge_order' in sourceNode) {
      sourceNode.edge_order.push(edgeId);
    }
  }

  /**
   * Validate the compiled workflow
   */
  validate(): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for at least one node besides start
    const nodeCount = Object.keys(this.compiledNodes).length;
    if (nodeCount <= 1) {
      errors.push('Workflow must have at least one node besides start');
    }

    // Check for start node
    if (!this.compiledNodes['start_node']) {
      errors.push('Workflow must have a start node');
    }

    // Check that all edge targets exist
    for (const [edgeId, edge] of Object.entries(this.compiledEdges)) {
      if (!this.compiledNodes[edge.target]) {
        errors.push(`Edge ${edgeId} targets non-existent node ${edge.target}`);
      }
      if (!this.compiledNodes[edge.source]) {
        errors.push(`Edge ${edgeId} has non-existent source ${edge.source}`);
      }
    }

    // Check for unreachable nodes (excluding start)
    const reachableNodes = new Set(['start_node']);
    for (const edge of Object.values(this.compiledEdges)) {
      reachableNodes.add(edge.target);
    }
    
    for (const nodeId of Object.keys(this.compiledNodes)) {
      if (nodeId !== 'start_node' && !reachableNodes.has(nodeId)) {
        warnings.push(`Node ${nodeId} is not reachable from any other node`);
      }
    }

    // Check for nodes with no outgoing edges (excluding end nodes)
    for (const [nodeId, node] of Object.entries(this.compiledNodes)) {
      if (node.type !== 'end' && node.type !== 'phone_number' && node.type !== 'standalone_agent') {
        if (node.edge_order.length === 0 && nodeId !== 'start_node') {
          warnings.push(`Node ${nodeId} has no outgoing edges`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}
