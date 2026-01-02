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
import { Router, Response } from "express";
import { db } from "../db";
import { type AuthRequest } from "../middleware/auth";
import { 
  flows, createFlowSchema,
  webhooks, createWebhookSchema,
  webhookLogs,
  appointments, createAppointmentSchema,
  appointmentSettings, createAppointmentSettingsSchema,
  forms, createFormSchema,
  formFields, insertFormFieldSchema,
  formSubmissions, insertFormSubmissionSchema,
  flowExecutions,
  phoneNumbers, calls, agents, contacts,
  incomingConnections, campaigns,
  plivoPhoneNumbers, plivoCalls,
  sipPhoneNumbers, sipCalls, twilioOpenaiCalls
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { webhookDeliveryService } from "../services/webhook-delivery";
import { flowTemplates } from "../services/flow-templates";
import { storage } from "../storage";
import { ElevenLabsService } from "../services/elevenlabs";
import { ElevenLabsPoolService } from "../services/elevenlabs-pool";
import { FlowAgentService } from "../services/flow-agent";
import { OutboundCallService } from "../services/outbound-call-service";
import { PhoneMigrator } from "../engines/elevenlabs-migration";
import { TwilioOpenAICallService } from "../engines/twilio-openai/services/twilio-openai-call.service";
import { PlivoCallService } from "../engines/plivo/services/plivo-call.service";
import { OpenAIAgentFactory } from "../engines/plivo/services/openai-agent-factory";
import type { CompiledFlowConfig } from "../engines/plivo/types";
import { OpenAIVoiceAgentCompiler } from "../services/openai-voice-agent";
import type { FlowNode, FlowEdge } from "../services/openai-voice-agent";
import { getPluginStatus } from "../plugins/loader";

const router = Router();

// Default working hours - used when user hasn't configured settings
const DEFAULT_WORKING_HOURS: Record<string, { start: string; end: string; enabled: boolean }> = {
  monday: { start: "09:00", end: "17:00", enabled: true },
  tuesday: { start: "09:00", end: "17:00", enabled: true },
  wednesday: { start: "09:00", end: "17:00", enabled: true },
  thursday: { start: "09:00", end: "17:00", enabled: true },
  friday: { start: "09:00", end: "17:00", enabled: true },
  saturday: { start: "09:00", end: "17:00", enabled: false },
  sunday: { start: "09:00", end: "17:00", enabled: false },
};

/**
 * Validates if an appointment date/time falls within the user's working hours settings.
 * Returns { valid: true } if valid, or { valid: false, message: string } if not.
 */
async function validateWorkingHours(
  userId: string,
  appointmentDate: string,
  appointmentTime: string,
  duration: number = 30
): Promise<{ valid: true } | { valid: false; message: string }> {
  try {
    const [userSettings] = await db
      .select()
      .from(appointmentSettings)
      .where(eq(appointmentSettings.userId, userId));
    
    // Parse the date to get day of week
    const parsedDate = new Date(appointmentDate + 'T12:00:00');
    if (isNaN(parsedDate.getTime())) {
      console.log(`📅 [Working Hours] Could not parse date: ${appointmentDate}`);
      return { 
        valid: false, 
        message: `I couldn't understand the date "${appointmentDate}". Please provide a valid date in YYYY-MM-DD format.` 
      };
    }
    
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const dayOfWeek = parsedDate.getDay();
    const dayName = dayNames[dayOfWeek];
    
    // Merge user settings with defaults per-day
    const userWorkingHours = userSettings?.workingHours as Record<string, { start: string; end: string; enabled: boolean }> | undefined;
    const daySettings = userWorkingHours?.[dayName] 
      ? { ...DEFAULT_WORKING_HOURS[dayName], ...userWorkingHours[dayName] }
      : DEFAULT_WORKING_HOURS[dayName];
    
    console.log(`📅 [Working Hours] Checking ${dayName} (${appointmentDate} ${appointmentTime}):`, daySettings);
    
    // Check if day is enabled
    if (!daySettings?.enabled) {
      const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      console.log(`📅 [Working Hours] Rejected: ${dayName} is not available for appointments`);
      return {
        valid: false,
        message: `We're not available on ${capitalizedDay}s. Please choose a different day.`
      };
    }
    
    // Parse and check time
    const parseTimeToMinutes = (timeStr: string): number => {
      const parts = timeStr.split(':');
      if (parts.length !== 2) throw new Error(`Invalid time format: ${timeStr}`);
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time values: ${timeStr}`);
      return hours * 60 + minutes;
    };
    
    const requestedMinutes = parseTimeToMinutes(appointmentTime);
    const startMinutes = parseTimeToMinutes(daySettings.start || "09:00");
    const endMinutes = parseTimeToMinutes(daySettings.end || "17:00");
    const appointmentEndMinutes = requestedMinutes + duration;
    
    if (requestedMinutes < startMinutes || appointmentEndMinutes > endMinutes) {
      const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      console.log(`📅 [Working Hours] Rejected: ${appointmentTime} (duration: ${duration}min) is outside working hours (${daySettings.start} - ${daySettings.end})`);
      return {
        valid: false,
        message: `${appointmentTime} is outside our available hours on ${capitalizedDay}. We're available from ${daySettings.start} to ${daySettings.end}.`
      };
    }
    
    console.log(`📅 [Working Hours] Validated: ${appointmentTime} is within ${daySettings.start} - ${daySettings.end}`);
    return { valid: true };
  } catch (error: any) {
    console.error(`📅 [Working Hours] Validation error:`, error.message);
    return { 
      valid: false, 
      message: `I'm having trouble validating the appointment time. Please provide the time in HH:MM format (like "14:00" or "2:30 PM").` 
    };
  }
}

router.get("/flows", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    const userFlows = await db
      .select()
      .from(flows)
      .where(eq(flows.userId, userId))
      .orderBy(desc(flows.updatedAt));
    
    res.json(userFlows);
  } catch (error: any) {
    console.error("Error fetching flows:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/flows/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, userId)));
    
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    
    res.json(flow);
  } catch (error: any) {
    console.error("Error fetching flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/flows", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    // Check flow limit (999 or -1 means unlimited)
    const effectiveLimits = await storage.getUserEffectiveLimits(userId);
    const currentFlowCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(flows)
      .where(eq(flows.userId, userId));
    
    const flowCount = Number(currentFlowCount[0]?.count || 0);
    // Ensure maxFlows is a concrete number (default to 3 if somehow undefined)
    const maxFlows = typeof effectiveLimits.maxFlows === 'number' ? effectiveLimits.maxFlows : 3;
    // Skip limit check if explicitly unlimited (999 or -1)
    if (maxFlows !== 999 && maxFlows !== -1 && flowCount >= maxFlows) {
      return res.status(403).json({ 
        error: "Flow limit reached", 
        message: `You have reached your maximum of ${maxFlows} flows. Please upgrade your plan or delete existing flows.`,
        limit: maxFlows,
        current: flowCount
      });
    }
    
    const validatedData = createFlowSchema.parse(req.body);
    
    const flowId = nanoid();
    // TODO: Drizzle type inference - validatedData from Zod schema doesn't perfectly match
    // the insert type due to optional fields and defaults. Using explicit type assertion.
    const [newFlow] = await db
      .insert(flows)
      .values({
        id: flowId,
        userId,
        ...validatedData,
      } as typeof flows.$inferInsert)
      .returning();
    
    res.json(newFlow);
  } catch (error: any) {
    console.error("Error creating flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/flows/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [existingFlow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, userId)));
    
    if (!existingFlow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    
    const [updatedFlow] = await db
      .update(flows)
      .set({
        ...req.body,
        updatedAt: new Date(),
      })
      .where(eq(flows.id, id))
      .returning();
    
    const flowAgentId = updatedFlow.agentId || req.body.agentId;
    if (flowAgentId) {
      try {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, flowAgentId));
        
        if (agent && agent.type === 'flow') {
          // Check if this is an OpenAI-based flow agent (Plivo or Twilio+OpenAI)
          const isOpenAIProvider = agent.telephonyProvider === 'plivo' || agent.telephonyProvider === 'twilio_openai';
          
          if (isOpenAIProvider) {
            // OpenAI-based flow agents - compile flow using shared OpenAI Voice Agent service
            console.log(`🔄 [Flow Save] OpenAI-based flow agent (${agent.telephonyProvider}) - compiling for OpenAI Realtime`);
            console.log(`   Agent: ${agent.name} (${agent.id})`);
            console.log(`   Flow: ${updatedFlow.name} (${updatedFlow.id})`);
            console.log(`   Voice: ${agent.openaiVoice || 'alloy'}`);
            
            // Compile flow for OpenAI engines and store in database
            try {
              const flowNodes = (updatedFlow.nodes || []) as FlowNode[];
              const flowEdges = (updatedFlow.edges || []) as FlowEdge[];
              
              if (flowNodes.length > 0) {
                const compiled = OpenAIVoiceAgentCompiler.compileFlow(flowNodes, flowEdges, {
                  language: agent.language || 'en',
                  voice: agent.openaiVoice || 'alloy',
                  model: 'gpt-4o-mini-realtime-preview',
                  agentName: agent.name,
                  agentPersonality: agent.systemPrompt || undefined,
                  knowledgeBaseIds: agent.knowledgeBaseIds || [],
                  transferPhoneNumber: agent.transferPhoneNumber || undefined,
                  transferEnabled: agent.transferEnabled || false,
                  endConversationEnabled: agent.endConversationEnabled ?? true,
                });
                
                await db.update(flows).set({
                  compiledSystemPrompt: compiled.systemPrompt,
                  compiledFirstMessage: compiled.firstMessage || null,
                  compiledStates: compiled.conversationStates,
                  compiledTools: compiled.tools,
                }).where(eq(flows.id, id));
                
                console.log(`✅ [Flow Save] Compiled for OpenAI: ${compiled.conversationStates.length} states, ${compiled.tools.length} tools`);
              } else {
                console.log(`⚠️ [Flow Save] Flow has no nodes, skipping OpenAI compilation`);
              }
            } catch (compileError: any) {
              console.error(`❌ [Flow Save] OpenAI compilation error:`, compileError.message);
            }
          } else {
            // ElevenLabs/Twilio flow agent - sync to ElevenLabs
            console.log(`🔄 [Flow Save] Syncing Flow agent to ElevenLabs...`);
            console.log(`   Agent: ${agent.name} (${agent.id})`);
            console.log(`   Flow: ${updatedFlow.name} (${updatedFlow.id})`);
          
            if (!agent.elevenLabsVoiceId) {
              console.log(`⚠️ [Flow Save] Agent missing voice configuration, skipping ElevenLabs sync`);
            } else {
            const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
            if (!credential) {
              console.log(`⚠️ [Flow Save] No ElevenLabs credential found for agent, skipping sync`);
            } else {
              const elevenlabsService = new ElevenLabsService(credential.apiKey);
              
              let flowNodes = (updatedFlow.nodes || []) as import('@shared/schema').FlowNode[];
              const flowEdges = (updatedFlow.edges || []) as import('@shared/schema').FlowEdge[];
              
              if (flowNodes.length > 0) {
                // Enrich form nodes with field definitions from database before compiling
                flowNodes = await FlowAgentService.enrichFormNodesWithFields(flowNodes);
                const compileResult = FlowAgentService.compileFlow(flowNodes, flowEdges);
                const { workflow: compiledWorkflow, firstMessage: flowFirstMessage, hasAppointmentNodes, hasFormNodes, formNodes, hasWebhookNodes, webhookNodes, hasPlayAudioNodes, playAudioNodes } = compileResult;
                
                console.log(`   Compiled workflow: ${Object.keys(compiledWorkflow.nodes).length} nodes, ${Object.keys(compiledWorkflow.edges).length} edges`);
                if (flowFirstMessage) {
                  console.log(`   First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
                }
                if (hasAppointmentNodes) {
                  console.log(`   📅 Flow contains appointment nodes`);
                }
                if (hasFormNodes) {
                  console.log(`   📋 Flow contains form nodes (${formNodes?.length || 0} forms)`);
                }
                if (hasWebhookNodes) {
                  console.log(`   🔗 Flow contains webhook nodes (${webhookNodes?.length || 0} webhooks)`);
                }
                if (hasPlayAudioNodes) {
                  console.log(`   🔊 Flow contains play audio nodes (${playAudioNodes?.length || 0} audio files)`);
                }
                
                if (!agent.elevenLabsAgentId) {
                  console.log(`   Creating new ElevenLabs Flow agent...`);
                  const elevenLabsAgent = await elevenlabsService.createFlowAgent({
                    name: agent.name,
                    voice_id: agent.elevenLabsVoiceId,
                    language: agent.language || 'en',
                    maxDurationSeconds: agent.maxDurationSeconds || 900,
                    detectLanguageEnabled: agent.detectLanguageEnabled || false,
                    workflow: compiledWorkflow,
                    firstMessage: flowFirstMessage,
                  });
                  
                  await db
                    .update(agents)
                    .set({ elevenLabsAgentId: elevenLabsAgent.agent_id })
                    .where(eq(agents.id, agent.id));
                  
                  console.log(`✅ [Flow Save] Created ElevenLabs agent: ${elevenLabsAgent.agent_id}`);
                  
                  // Build webhook tools array for new agents
                  let newAgentWebhookTools: any[] = [];
                  
                  // Add RAG tool if agent has knowledge bases assigned
                  if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
                    const { isRAGEnabled, getAskKnowledgeWebhookTool } = await import('../services/rag-elevenlabs-tool');
                    if (isRAGEnabled()) {
                      const ragTool = getAskKnowledgeWebhookTool(elevenLabsAgent.agent_id);
                      newAgentWebhookTools.push(ragTool);
                      console.log(`📚 [Flow Save] Adding RAG knowledge tool to new agent`);
                    }
                  }
                  
                  // Add appointment booking tool if flow has appointment nodes
                  if (hasAppointmentNodes) {
                    console.log(`📅 [Flow Save] Adding appointment booking tool to agent ${elevenLabsAgent.agent_id}`);
                    const { getAppointmentToolForAgent } = await import('../services/appointment-elevenlabs-tool');
                    const appointmentTool = getAppointmentToolForAgent(elevenLabsAgent.agent_id);
                    newAgentWebhookTools.push(appointmentTool);
                  }
                  
                  // Add form submission tools if flow has form nodes
                  if (hasFormNodes && formNodes && formNodes.length > 0) {
                    console.log(`📋 [Flow Save] Adding form submission tools (${formNodes.length} forms) to agent ${elevenLabsAgent.agent_id}`);
                    const { getSubmitFormWebhookTool } = await import('../services/form-elevenlabs-tool');
                    for (const formInfo of formNodes) {
                      const formTool = getSubmitFormWebhookTool(
                        formInfo.formId,
                        formInfo.formName,
                        formInfo.fields,
                        elevenLabsAgent.agent_id
                      );
                      newAgentWebhookTools.push(formTool);
                      console.log(`   📋 Added submit_form tool for "${formInfo.formName}"`);
                    }
                  }
                  
                  // Add custom webhook tools from flow builder (user-defined webhooks)
                  // Uses universal webhook builder to automatically include caller phone, conversation data, etc.
                  if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                    console.log(`🔗 [Flow Save] Adding universal webhook tools (${webhookNodes.length} webhooks) to agent ${elevenLabsAgent.agent_id}`);
                    const { buildUniversalWebhookTool } = await import('../services/universal-webhook-tool');
                    for (const webhookNode of webhookNodes) {
                      if (webhookNode.url) {
                        const webhookTool = buildUniversalWebhookTool({
                          toolId: webhookNode.toolId,
                          url: webhookNode.url,
                          method: webhookNode.method || 'POST',
                          headers: webhookNode.headers,
                          payload: webhookNode.payload
                        });
                        newAgentWebhookTools.push(webhookTool);
                        console.log(`   🔗 Added universal webhook tool: ${webhookNode.toolId} -> ${webhookNode.method} ${webhookNode.url}`);
                      }
                    }
                  }
                  
                  // Add play audio tools if flow has play_audio nodes
                  if (hasPlayAudioNodes && playAudioNodes && playAudioNodes.length > 0) {
                    console.log(`🔊 [Flow Save] Adding play audio tools (${playAudioNodes.length} nodes) to agent ${elevenLabsAgent.agent_id}`);
                    const { getPlayAudioWebhookTool } = await import('../services/play-audio-elevenlabs-tool');
                    for (const playAudioNode of playAudioNodes) {
                      const playAudioTool = getPlayAudioWebhookTool(
                        playAudioNode.nodeId,
                        playAudioNode.audioUrl,
                        playAudioNode.audioFileName,
                        playAudioNode.interruptible,
                        playAudioNode.waitForComplete,
                        elevenLabsAgent.agent_id
                      );
                      newAgentWebhookTools.push(playAudioTool);
                      console.log(`   🔊 Added play audio tool: ${playAudioTool.name}`);
                    }
                  }
                  
                  // Update agent with webhook tools if any
                  if (newAgentWebhookTools.length > 0) {
                    try {
                      await elevenlabsService.updateFlowAgentWorkflow(
                        elevenLabsAgent.agent_id,
                        compiledWorkflow,
                        agent.maxDurationSeconds || 900,
                        undefined, // detectLanguageEnabled
                        undefined, // language
                        undefined, // ttsModel
                        undefined, // llmModel
                        undefined, // temperature
                        undefined, // firstMessage
                        undefined, // voiceId
                        { webhookTools: newAgentWebhookTools }
                      );
                      console.log(`✅ [Flow Save] Webhook tools added (${newAgentWebhookTools.length} tools)`);
                    } catch (toolError: any) {
                      console.error(`❌ [Flow Save] Failed to add webhook tools:`, toolError.message);
                    }
                  }
                } else {
                  console.log(`   Updating existing ElevenLabs agent: ${agent.elevenLabsAgentId}`);
                  
                  // Build webhook tools array
                  let webhookTools: any[] = [];
                  
                  // Add RAG tool if agent has knowledge bases assigned
                  // This ensures KB tool is retained when flow is saved from flow editor
                  if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
                    const { isRAGEnabled, getAskKnowledgeWebhookTool } = await import('../services/rag-elevenlabs-tool');
                    if (isRAGEnabled()) {
                      const ragTool = getAskKnowledgeWebhookTool(agent.elevenLabsAgentId);
                      webhookTools.push(ragTool);
                      console.log(`📚 [Flow Save] Including RAG knowledge tool in update`);
                    }
                  }
                  
                  if (hasAppointmentNodes) {
                    const { getAppointmentToolForAgent } = await import('../services/appointment-elevenlabs-tool');
                    const appointmentTool = getAppointmentToolForAgent(agent.elevenLabsAgentId);
                    webhookTools.push(appointmentTool);
                    console.log(`📅 [Flow Save] Including appointment booking tool in update`);
                  }
                  
                  // Add form submission tools if flow has form nodes
                  if (hasFormNodes && formNodes && formNodes.length > 0) {
                    console.log(`📋 [Flow Save] Including form submission tools (${formNodes.length} forms) in update`);
                    const { getSubmitFormWebhookTool } = await import('../services/form-elevenlabs-tool');
                    for (const formInfo of formNodes) {
                      const formTool = getSubmitFormWebhookTool(
                        formInfo.formId,
                        formInfo.formName,
                        formInfo.fields,
                        agent.elevenLabsAgentId
                      );
                      webhookTools.push(formTool);
                      console.log(`   📋 Added submit_form tool for "${formInfo.formName}"`);
                    }
                  }
                  
                  // Add custom webhook tools from flow builder (user-defined webhooks)
                  // Uses universal webhook builder to automatically include caller phone, conversation data, etc.
                  if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                    console.log(`🔗 [Flow Save] Including universal webhook tools (${webhookNodes.length} webhooks) in update`);
                    const { buildUniversalWebhookTool } = await import('../services/universal-webhook-tool');
                    for (const webhookNode of webhookNodes) {
                      if (webhookNode.url) {
                        const webhookTool = buildUniversalWebhookTool({
                          toolId: webhookNode.toolId,
                          url: webhookNode.url,
                          method: webhookNode.method || 'POST',
                          headers: webhookNode.headers,
                          payload: webhookNode.payload
                        });
                        webhookTools.push(webhookTool);
                        console.log(`   🔗 Added universal webhook tool: ${webhookNode.toolId} -> ${webhookNode.method} ${webhookNode.url}`);
                      }
                    }
                  }
                  
                  // Add play audio tools if flow has play_audio nodes
                  if (hasPlayAudioNodes && playAudioNodes && playAudioNodes.length > 0) {
                    console.log(`🔊 [Flow Save] Including play audio tools (${playAudioNodes.length} nodes) in update`);
                    const { getPlayAudioWebhookTool } = await import('../services/play-audio-elevenlabs-tool');
                    for (const playAudioNode of playAudioNodes) {
                      const playAudioTool = getPlayAudioWebhookTool(
                        playAudioNode.nodeId,
                        playAudioNode.audioUrl,
                        playAudioNode.audioFileName,
                        playAudioNode.interruptible,
                        playAudioNode.waitForComplete,
                        agent.elevenLabsAgentId
                      );
                      webhookTools.push(playAudioTool);
                      console.log(`   🔊 Added play audio tool: ${playAudioTool.name}`);
                    }
                  }
                  
                  await elevenlabsService.updateFlowAgentWorkflow(
                    agent.elevenLabsAgentId, 
                    compiledWorkflow,
                    agent.maxDurationSeconds || 900,
                    agent.detectLanguageEnabled || false,
                    agent.language || undefined,
                    undefined, // ttsModel
                    undefined, // llmModel
                    undefined, // temperature
                    flowFirstMessage,
                    undefined, // voiceId
                    webhookTools.length > 0 ? { webhookTools } : undefined
                  );
                  
                  console.log(`✅ [Flow Save] Updated ElevenLabs agent workflow`);
                  if (webhookTools.length > 0) {
                    console.log(`   📦 Included ${webhookTools.length} webhook tools`);
                  }
                }
              } else {
                console.log(`⚠️ [Flow Save] Flow has no nodes, skipping ElevenLabs sync`);
              }
            }
            }
          }
        }
      } catch (syncError: any) {
        console.error(`❌ [Flow Save] ElevenLabs sync error:`, syncError.message);
      }
    }
    
    res.json(updatedFlow);
  } catch (error: any) {
    console.error("Error updating flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/flows/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [deletedFlow] = await db
      .delete(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, userId)))
      .returning();
    
    if (!deletedFlow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/flows/:id/test", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: "Phone number is required" });
    }
    
    if (!phoneNumber.startsWith("+") || phoneNumber.length < 11) {
      return res.status(400).json({ 
        error: "Invalid phone number format. Must be in E.164 format (e.g., +12025551234)" 
      });
    }
    
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, userId)));
    
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    
    if (!flow.isActive) {
      return res.status(400).json({ error: "Flow must be active to test" });
    }
    
    // ========================================
    // FETCH AGENT FIRST - needed to determine phone number selection strategy
    // ========================================
    if (!flow.agentId) {
      return res.status(400).json({ 
        error: "Flow must have an agent assigned before testing",
        message: "Please assign an agent to this flow in the flow builder settings."
      });
    }
    
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, flow.agentId));
    
    if (!agent) {
      return res.status(400).json({
        error: "Agent not found",
        message: "The agent assigned to this flow no longer exists."
      });
    }
    
    // ========================================
    // ELEVENLABS SIP PATH - Uses SIP phone numbers from plugin
    // Must be checked BEFORE regular phone number selection
    // ========================================
    if (agent.telephonyProvider === 'elevenlabs-sip') {
      console.log(`📞 [Flow Test] ElevenLabs SIP agent detected, using SIP phone numbers`);
      
      // Check if SIP plugin is enabled
      const plugins = await getPluginStatus();
      const sipPlugin = plugins.find(p => p.name === 'sip-engine');
      if (!sipPlugin?.enabled) {
        return res.status(400).json({
          error: "SIP Engine plugin not enabled",
          message: "The SIP Engine plugin must be enabled to use ElevenLabs SIP agents. Please contact your administrator."
        });
      }
      
      // Auto-select user's first available SIP phone number with ElevenLabs engine
      const [sipPhone] = await db
        .select()
        .from(sipPhoneNumbers)
        .where(and(
          eq(sipPhoneNumbers.userId, userId),
          eq(sipPhoneNumbers.engine, 'elevenlabs-sip'),
          eq(sipPhoneNumbers.isActive, true),
          eq(sipPhoneNumbers.outboundEnabled, true)
        ))
        .limit(1);
      
      if (!sipPhone) {
        return res.status(400).json({
          error: "No SIP phone number available",
          message: "Please import a phone number from your SIP trunk in the Phone Numbers section before making test calls."
        });
      }
      
      if (!sipPhone.externalElevenLabsPhoneId) {
        return res.status(400).json({
          error: "SIP phone number not provisioned",
          message: "This SIP phone number has not been provisioned with ElevenLabs. Please check your SIP trunk configuration."
        });
      }
      
      if (!agent.elevenLabsAgentId) {
        return res.status(400).json({
          error: "Agent not synced with ElevenLabs",
          message: "Please configure and sync the agent with ElevenLabs in the Agents section first."
        });
      }
      
      try {
        // Use the plugin's ElevenLabsSipService.makeOutboundCall
        const { ElevenLabsSipService } = await import('../../plugins/sip-engine/services/elevenlabs-sip.service');
        
        console.log(`📞 [Flow Test] Initiating SIP test call via ElevenLabs SIP Trunk API`);
        console.log(`   From SIP Phone: ${sipPhone.phoneNumber} (ElevenLabs ID: ${sipPhone.externalElevenLabsPhoneId})`);
        console.log(`   To: ${phoneNumber}`);
        console.log(`   Agent (ElevenLabs ID): ${agent.elevenLabsAgentId}`);
        
        const result = await ElevenLabsSipService.makeOutboundCall(
          userId,
          sipPhone as any,
          phoneNumber,
          agent.id,
          {
            source: 'flow_test',
            flowId: flow.id,
            flowName: flow.name,
            testCall: true,
          }
        );
        
        if (!result.success) {
          return res.status(400).json({
            error: "SIP call initiation failed",
            message: result.error || "Failed to initiate call via ElevenLabs SIP Trunk"
          });
        }
        
        console.log(`✅ [Flow Test] ElevenLabs SIP outbound call initiated`);
        console.log(`   Conversation ID: ${result.conversationId}`);
        console.log(`   Call ID: ${result.callId}`);
        
        // Create SIP call record
        const sipCallId = nanoid();
        await db.insert(sipCalls).values({
          id: sipCallId,
          sipPhoneNumberId: sipPhone.id,
          userId: userId,
          agentId: agent.id,
          direction: 'outbound',
          engine: 'elevenlabs-sip',
          toNumber: phoneNumber,
          fromNumber: sipPhone.phoneNumber,
          externalCallId: result.conversationId || result.callId || null,
          status: 'initiated',
          startedAt: new Date(),
          conversationData: {
            source: 'flow_test',
            flowId: flow.id,
            flowName: flow.name,
            testCall: true,
            conversationId: result.conversationId,
          },
        });
        
        // Create flow execution record
        await db.insert(flowExecutions).values({
          id: nanoid(),
          callId: sipCallId,
          flowId: flow.id,
          currentNodeId: null,
          status: 'running',
          variables: {},
          pathTaken: [],
          startedAt: new Date(),
          metadata: {
            campaignId: null,
            campaignName: null,
            contactPhone: phoneNumber,
            nativeExecution: true,
            telephonyProvider: 'elevenlabs-sip',
            testCall: true,
            conversationId: result.conversationId,
          },
        });
        
        return res.json({
          success: true,
          callId: sipCallId,
          conversationId: result.conversationId,
          callSid: result.callId,
          flowId: flow.id,
          flowName: flow.name,
          fromNumber: sipPhone.phoneNumber,
          toNumber: phoneNumber,
          message: "Test call initiated successfully via ElevenLabs SIP Trunk. The agent will execute the workflow.",
          engine: 'elevenlabs_sip',
        });
        
      } catch (sipError: any) {
        console.error(`❌ [Flow Test] ElevenLabs SIP call error:`, sipError);
        return res.status(400).json({
          error: "SIP call initiation failed",
          message: sipError.message || "Failed to initiate call via ElevenLabs SIP Trunk"
        });
      }
    }
    
    // ========================================
    // SMART PHONE NUMBER SELECTION (for non-SIP engines)
    // Find any available phone number not connected to incoming agents
    // ========================================
    const userPhoneNumbers = await db
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.userId, userId),
          eq(phoneNumbers.status, "active")
        )
      );
    
    // Get all phone numbers connected to incoming agents (to exclude them)
    const incomingConnectedPhoneIds = await db
      .select({ phoneNumberId: incomingConnections.phoneNumberId })
      .from(incomingConnections);
    
    const connectedPhoneIdSet = new Set(incomingConnectedPhoneIds.map(ic => ic.phoneNumberId));
    
    // Filter user phone numbers to find ones NOT connected to incoming agents
    const availableUserPhones = userPhoneNumbers.filter(
      phone => !connectedPhoneIdSet.has(phone.id)
    );
    
    let fromPhone;
    if (availableUserPhones.length > 0) {
      // Use first available phone number not connected to incoming
      fromPhone = availableUserPhones[0];
      console.log(`📞 [Flow Test] Using available user phone: ${fromPhone.phoneNumber} (not connected to incoming)`);
    } else if (userPhoneNumbers.length > 0) {
      // User has phone numbers but ALL are connected to incoming agents
      // Get connected agent names for helpful error message
      const connectedAgents = await db
        .select({ name: agents.name })
        .from(agents)
        .innerJoin(incomingConnections, eq(incomingConnections.agentId, agents.id))
        .where(inArray(incomingConnections.phoneNumberId, userPhoneNumbers.map(p => p.id)));
      
      const agentNames = connectedAgents.map(a => a.name).join(", ");
      
      return res.status(409).json({
        error: "Phone number conflict",
        message: `All your phone numbers are connected to incoming agents (${agentNames}). A phone number can only be used for either incoming calls OR outbound campaigns/tests, not both.`,
        suggestion: "Please purchase a new phone number for outbound calls, or disconnect one of your numbers from the incoming agent first.",
        conflictType: "incoming_connection",
        connectedAgentName: agentNames
      });
    } else {
      // No user phone numbers, try system pool
      const systemPoolNumbers = await db
        .select()
        .from(phoneNumbers)
        .where(
          and(
            eq(phoneNumbers.isSystemPool, true),
            eq(phoneNumbers.status, "active"),
            isNull(phoneNumbers.userId)
          )
        )
        .orderBy(desc(phoneNumbers.purchasedAt));
      
      // Filter system pool numbers to exclude those connected to incoming
      const availableSystemPhones = systemPoolNumbers.filter(
        phone => !connectedPhoneIdSet.has(phone.id)
      );
      
      if (availableSystemPhones.length === 0) {
        return res.status(400).json({ 
          error: "No active phone numbers found",
          message: "You need to purchase or rent a phone number before making test calls. Visit the Phone Numbers page to get started."
        });
      }
      
      fromPhone = availableSystemPhones[0];
      console.log(`📞 [Flow Test] Using system pool phone: ${fromPhone.phoneNumber}`);
    }
    
    // ========================================
    // CHECK FOR ACTIVE CAMPAIGN WARNING
    // Warn user if selected phone is attached to an active/running campaign
    // ========================================
    let activeCampaignWarning: { message: string; campaignName: string } | null = null;
    
    const activeCampaignsUsingPhone = await db
      .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.phoneNumberId, fromPhone.id),
          inArray(campaigns.status, ["running", "active", "in_progress"])
        )
      );
    
    if (activeCampaignsUsingPhone.length > 0) {
      const campaignNames = activeCampaignsUsingPhone.map(c => c.name).join(", ");
      activeCampaignWarning = {
        message: `Warning: This phone number is currently being used by an active campaign (${campaignNames}). Running this test may affect the ongoing campaign.`,
        campaignName: campaignNames
      };
      console.log(`⚠️ [Flow Test] Phone ${fromPhone.phoneNumber} is attached to active campaign(s): ${campaignNames}`);
    }
    
    // Check if this is an OpenAI-based flow agent (Plivo or Twilio+OpenAI)
    // OpenAI providers use twilioOpenaiCalls table, ElevenLabs uses calls table
    const isOpenAIProvider = agent.telephonyProvider === 'plivo' || agent.telephonyProvider === 'twilio_openai';
    
    // Only create calls table record for ElevenLabs provider
    // OpenAI provider creates its own record in twilioOpenaiCalls table via TwilioOpenAICallService
    let callId: string | null = null;
    let callRecord: any = null;
    
    if (!isOpenAIProvider) {
      callId = nanoid();
      const [record] = await db
        .insert(calls)
        .values({
          id: callId,
          userId: userId,
          campaignId: null,
          contactId: null,
          phoneNumber: phoneNumber,
          status: "initiated",
          callDirection: "outgoing",
          startedAt: new Date(),
          metadata: {
            source: "flow_test",
            flowId: flow.id,
            flowName: flow.name,
            fromNumber: fromPhone.phoneNumber,
            testCall: true,
          }
        })
        .returning();
      callRecord = record;
      
      // NOTE: pathTaken is left empty because ElevenLabs runs flows natively and
      // does not provide step-by-step execution telemetry. The UI will explain this
      // limitation and emphasize reliable data (variables, AI summary).
      const executionId = nanoid();
      await db.insert(flowExecutions).values({
        id: executionId,
        callId: callRecord.id,
        flowId: flow.id,
        currentNodeId: null,
        status: "running",
        variables: {},
        pathTaken: [],
        metadata: {
          testCall: true,
          phoneNumber,
          nativeElevenLabsExecution: true,
        }
      });
    }
    
    if (isOpenAIProvider) {
      // OpenAI-based flow agent validation
      if (!agent.openaiVoice) {
        return res.status(400).json({
          error: "Flow agent missing OpenAI voice configuration",
          message: "Please select an OpenAI voice for this Flow agent in the Agents section."
        });
      }
    } else {
      // ElevenLabs-based agent validation
      if (!agent.elevenLabsAgentId) {
        return res.status(400).json({
          error: "Agent not synced with ElevenLabs",
          message: "Please configure and sync the agent in the Agents section first."
        });
      }
      
      if (agent.type === 'flow') {
        if (!agent.elevenLabsVoiceId) {
          return res.status(400).json({
            error: "Flow agent missing voice configuration",
            message: "Please select a voice for this Flow agent in the Agents section."
          });
        }
      }
      
      // Validate phone number is synced with ElevenLabs (required for native outbound calls)
      if (!fromPhone.elevenLabsPhoneNumberId) {
        return res.status(400).json({
          error: "Phone number not synced with ElevenLabs",
          message: "Please sync your phone numbers with ElevenLabs in the Phone Numbers section before making test calls."
        });
      }
    }
    
    if (!flow.nodes || !Array.isArray(flow.nodes) || flow.nodes.length === 0) {
      return res.status(400).json({ 
        error: "Flow has no nodes defined",
        message: "Please add nodes to your flow in the visual flow builder."
      });
    }
    
    if (!flow.edges || !Array.isArray(flow.edges)) {
      return res.status(400).json({ 
        error: "Flow has no edges defined",
        message: "Please connect nodes in your flow in the visual flow builder."
      });
    }
    
    console.log(`🔀 [Flow Test] Flow validation passed`);
    console.log(`   Nodes: ${flow.nodes.length}`);
    console.log(`   Edges: ${flow.edges.length}`);
    
    // Route to appropriate call service based on agent's telephonyProvider
    if (agent.telephonyProvider === 'plivo') {
      // ========================================
      // PLIVO + OPENAI REALTIME PATH
      // Uses PlivoCallService with OpenAI Realtime for voice AI
      // ========================================
      console.log(`   Using Plivo + OpenAI Realtime API`);
      
      try {
        // Get a Plivo phone number for this user
        const [plivoPhone] = await db
          .select()
          .from(plivoPhoneNumbers)
          .where(and(
            eq(plivoPhoneNumbers.userId, userId),
            eq(plivoPhoneNumbers.status, 'active')
          ))
          .limit(1);
        
        if (!plivoPhone) {
          return res.status(400).json({
            error: "No Plivo phone number available",
            message: "Please purchase a Plivo phone number first in the Phone Numbers section."
          });
        }
        
        // Use pre-compiled flow data if available, otherwise compile at runtime
        const validatedVoice = OpenAIAgentFactory.validateVoice(agent.openaiVoice || 'sage');
        const validatedModel = OpenAIAgentFactory.validateModel(
          (agent.config as any)?.openaiModel || 'gpt-4o-realtime-preview',
          'pro'
        );
        
        let compiledConfig: any;
        
        // Generate a temporary call ID for tool context (will be replaced by actual call ID after initiation)
        const tempCallId = nanoid();
        
        if (flow.compiledSystemPrompt && flow.compiledTools && flow.compiledStates) {
          // Use pre-compiled flow data (compiled at save time)
          console.log(`   Using pre-compiled flow data (${(flow.compiledTools as any[]).length} tools, ${(flow.compiledStates as any[]).length} states)`);
          
          const { hydrateCompiledFlow } = await import('../services/openai-voice-agent/hydrator');
          compiledConfig = hydrateCompiledFlow({
            compiledSystemPrompt: flow.compiledSystemPrompt,
            compiledFirstMessage: flow.compiledFirstMessage || null,
            compiledTools: flow.compiledTools as any[],
            compiledStates: flow.compiledStates as any[],
            voice: validatedVoice,
            model: validatedModel,
            temperature: agent.temperature ?? 0.7,
            toolContext: {
              userId,
              agentId: agent.id,
              callId: tempCallId,
            },
            language: agent.language || 'en',
            knowledgeBaseIds: agent.knowledgeBaseIds || [],
            transferPhoneNumber: agent.transferPhoneNumber || undefined,
            transferEnabled: agent.transferEnabled || false,
          });
        } else {
          // Fall back to runtime compilation (legacy flows)
          console.log(`   Compiling flow at runtime (no pre-compiled data)`);
          
          const flowConfig: CompiledFlowConfig = {
            nodes: flow.nodes as any[],
            edges: flow.edges as any[],
            variables: {},
          };
          
          compiledConfig = await OpenAIAgentFactory.compileFlow(flowConfig, {
            voice: validatedVoice,
            model: validatedModel,
            userId,
            agentId: agent.id,
            temperature: agent.temperature ?? 0.7,
          });
        }
        
        const { callUuid, plivoCall } = await PlivoCallService.initiateCall({
          fromNumber: plivoPhone.phoneNumber,
          toNumber: phoneNumber,
          userId,
          agentId: agent.id,
          plivoPhoneNumberId: plivoPhone.id,
          flowId: flow.id, // Pass the tested flowId (not agent's default flow)
          agentConfig: {
            voice: compiledConfig.voice,
            model: compiledConfig.model,
            systemPrompt: compiledConfig.systemPrompt,
            firstMessage: compiledConfig.firstMessage,
            tools: compiledConfig.tools,
          },
        });
        
        console.log(`✅ [Flow Test] Plivo outbound call initiated`);
        console.log(`   Call ID: ${plivoCall.id}`);
        console.log(`   Plivo UUID: ${callUuid}`);
        console.log(`   Flow: ${flow.name} (${flow.id})`);
        console.log(`   From: ${plivoPhone.phoneNumber} -> To: ${phoneNumber}`);
        
        // Create flow execution record for test call
        try {
          await db.insert(flowExecutions).values({
            id: nanoid(),
            callId: plivoCall.id,
            flowId: flow.id,
            currentNodeId: null,
            status: 'running',
            variables: {},
            pathTaken: [],
            startedAt: new Date(),
            metadata: {
              campaignId: null,
              campaignName: null,
              contactPhone: phoneNumber,
              nativeExecution: true,
              telephonyProvider: 'plivo',
              testCall: true,
            },
          });
          console.log(`🔀 [Flow Test] Created flow execution for Plivo test call`);
        } catch (flowExecError: any) {
          console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
        }
        
        return res.json({
          success: true,
          callId: plivoCall.id,
          conversationId: plivoCall.id,
          plivoUuid: callUuid,
          flowId: flow.id,
          flowName: flow.name,
          fromNumber: plivoPhone.phoneNumber,
          toNumber: phoneNumber,
          message: "Test call initiated successfully via Plivo + OpenAI Realtime. The agent will execute the workflow.",
          engine: 'plivo_openai',
          ...(activeCampaignWarning && { warning: activeCampaignWarning })
        });
        
      } catch (plivoError: any) {
        console.error(`❌ [Flow Test] Plivo call error:`, plivoError);
        return res.status(400).json({
          error: "Call initiation failed",
          message: plivoError.message || "Failed to initiate call via Plivo"
        });
      }
    }
    
    if (agent.telephonyProvider === 'twilio_openai') {
      // ========================================
      // TWILIO + OPENAI REALTIME PATH
      // Creates record directly in twilioOpenaiCalls table (not calls table)
      // ========================================
      console.log(`   Using Twilio + OpenAI Realtime API`);
      
      try {
        const callResult = await TwilioOpenAICallService.initiateCall({
          userId,
          agentId: agent.id,
          toNumber: phoneNumber,
          fromNumberId: fromPhone.id,
          campaignId: undefined,
          contactId: undefined,
          flowId: flow.id,
          metadata: {
            source: 'flow_test',
            flowId: flow.id,
            flowName: flow.name,
            testCall: true,
          }
        });
        
        if (!callResult.success) {
          console.error(`❌ [Flow Test] Twilio+OpenAI call initiation failed:`, callResult.error);
          return res.status(400).json({
            error: "Call initiation failed",
            message: callResult.error || "Failed to initiate call via Twilio+OpenAI Realtime"
          });
        }
        
        console.log(`✅ [Flow Test] Twilio+OpenAI outbound call initiated`);
        console.log(`   Call ID: ${callResult.callId}`);
        console.log(`   Twilio SID: ${callResult.twilioCallSid}`);
        console.log(`   Flow: ${flow.name} (${flow.id})`);
        console.log(`   From: ${fromPhone.phoneNumber} -> To: ${phoneNumber}`);
        
        // Create flow execution record for test call
        if (callResult.callId) {
          try {
            await db.insert(flowExecutions).values({
              id: nanoid(),
              callId: callResult.callId,
              flowId: flow.id,
              currentNodeId: null,
              status: 'running',
              variables: {},
              pathTaken: [],
              startedAt: new Date(),
              metadata: {
                campaignId: null,
                campaignName: null,
                contactPhone: phoneNumber,
                nativeExecution: true,
                telephonyProvider: 'twilio-openai',
                testCall: true,
                twilioSid: callResult.twilioCallSid,
              },
            });
            console.log(`🔀 [Flow Test] Created flow execution for Twilio+OpenAI test call`);
          } catch (flowExecError: any) {
            console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
          }
        }
        
        // OpenAI calls use twilioOpenaiCalls table, return the callId from that table
        return res.json({
          success: true,
          callId: callResult.callId,
          conversationId: callResult.callId,
          twilioSid: callResult.twilioCallSid,
          flowId: flow.id,
          flowName: flow.name,
          fromNumber: fromPhone.phoneNumber,
          toNumber: phoneNumber,
          message: "Test call initiated successfully via Twilio+OpenAI Realtime. The agent will execute the workflow.",
          engine: 'twilio_openai',
          ...(activeCampaignWarning && { warning: activeCampaignWarning })
        });
        
      } catch (openaiError: any) {
        console.error(`❌ [Flow Test] Twilio+OpenAI call error:`, openaiError);
        throw new Error(`Failed to initiate call via Twilio+OpenAI: ${openaiError.message}`);
      }
    }
    
    // ========================================
    // ELEVENLABS PATH (Default)
    // ========================================
    console.log(`   Using ElevenLabs native outbound call API`);
    
    // Get the ElevenLabs credential for this agent from the pool
    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      return res.status(400).json({
        error: "No ElevenLabs credential available",
        message: "Please configure ElevenLabs API keys in the admin settings."
      });
    }
    
    // PRE-FLIGHT CHECK: Ensure phone number is on the same ElevenLabs credential as the agent
    // If credentials differ, migrate the phone number to the agent's credential before calling
    let currentPhoneElevenLabsId = fromPhone.elevenLabsPhoneNumberId;
    
    // Guard: both phone and agent must have credentials defined for migration check
    if (!agent.elevenLabsCredentialId) {
      return res.status(400).json({
        error: "Agent not assigned to credential",
        message: "This agent is not assigned to an ElevenLabs credential. Please configure ElevenLabs credentials in admin settings."
      });
    }
    
    if (!fromPhone.elevenLabsCredentialId) {
      return res.status(400).json({
        error: "Phone not assigned to credential", 
        message: "This phone number is not assigned to an ElevenLabs credential. Please re-sync phone numbers."
      });
    }
    
    if (fromPhone.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
      console.log(`📞 [Flow Test] Phone credential mismatch detected - initiating migration`);
      console.log(`   Phone credential: ${fromPhone.elevenLabsCredentialId}`);
      console.log(`   Agent credential: ${agent.elevenLabsCredentialId}`);
      
      try {
        const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
          fromPhone.id,
          agent.id
        );
        
        if (!migrationResult.success) {
          console.error(`❌ [Flow Test] Phone migration failed:`, migrationResult.error);
          return res.status(400).json({
            error: "Phone number migration failed",
            message: `Could not migrate phone number to agent's credential: ${migrationResult.error}`,
            details: migrationResult
          });
        }
        
        console.log(`✅ [Flow Test] Phone migrated successfully`);
        console.log(`   Old ElevenLabs ID: ${migrationResult.oldElevenLabsPhoneId}`);
        console.log(`   New ElevenLabs ID: ${migrationResult.newElevenLabsPhoneId}`);
        
        // Use the new ElevenLabs phone ID for the call
        if (!migrationResult.newElevenLabsPhoneId) {
          return res.status(400).json({
            error: "Phone number migration incomplete",
            message: "Migration succeeded but new ElevenLabs phone ID was not returned"
          });
        }
        currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;
        
      } catch (migrationError: any) {
        console.error(`❌ [Flow Test] Phone migration error:`, migrationError);
        return res.status(500).json({
          error: "Phone number migration failed",
          message: migrationError.message || "Failed to migrate phone number to agent's credential"
        });
      }
    } else {
      console.log(`✅ [Flow Test] Phone and agent on same credential: ${agent.elevenLabsCredentialId}`);
    }
    
    // PRE-FLIGHT CHECK 2: Verify phone actually exists on ElevenLabs
    // The database may have a stale elevenLabsPhoneNumberId that no longer exists
    console.log(`📞 [Flow Test] Verifying phone exists on ElevenLabs...`);
    const verifyResult = await PhoneMigrator.verifyAndEnsurePhoneExists(
      fromPhone.id,
      agent.elevenLabsCredentialId,
      agent.elevenLabsAgentId || undefined // Pass agent ID for assignment after re-import
    );
    
    if (!verifyResult.success) {
      console.error(`❌ [Flow Test] Phone verification failed:`, verifyResult.error);
      return res.status(400).json({
        error: "Phone number not available on ElevenLabs",
        message: verifyResult.error || "Could not verify or re-import phone number. Please check your Twilio configuration."
      });
    }
    
    if (verifyResult.wasReimported) {
      console.log(`✅ [Flow Test] Phone was re-imported from Twilio`);
      console.log(`   New ElevenLabs ID: ${verifyResult.elevenLabsPhoneId}`);
    }
    
    // Use the verified (or re-imported) phone ID
    currentPhoneElevenLabsId = verifyResult.elevenLabsPhoneId!;
    
    // Create OutboundCallService with the agent's credential (separate from ElevenLabsService)
    const outboundCallService = new OutboundCallService(credential.apiKey);
    
    let conversationId: string;
    let callSid: string | undefined;
    
    try {
      console.log(`📞 [Flow Test] Initiating test call via ElevenLabs Twilio API`);
      console.log(`   From Phone (ElevenLabs ID): ${currentPhoneElevenLabsId}`);
      console.log(`   To: ${phoneNumber}`);
      console.log(`   Agent (ElevenLabs ID): ${agent.elevenLabsAgentId}`);
      console.log(`   Flow ID: ${flow.id}`);
      
      // Use OutboundCallService for ElevenLabs Twilio outbound calls
      // POST /v1/convai/twilio/outbound-call with camelCase payload
      const result = await outboundCallService.initiateCall({
        agentId: agent.elevenLabsAgentId!,
        agentPhoneNumberId: currentPhoneElevenLabsId!,
        toNumber: phoneNumber,
      });
      
      conversationId = result.conversationId || '';
      callSid = result.callSid || undefined;
      
      console.log(`✅ [Flow Test] ElevenLabs outbound call initiated`);
      console.log(`   Conversation ID: ${conversationId}`);
      if (callSid) {
        console.log(`   Call SID: ${callSid}`);
      }
      
      // Create flow execution record for ElevenLabs test call
      if (callId) {
        try {
          await db.insert(flowExecutions).values({
            id: nanoid(),
            callId: callId,
            flowId: flow.id,
            currentNodeId: null,
            status: 'running',
            variables: {},
            pathTaken: [],
            startedAt: new Date(),
            metadata: {
              campaignId: null,
              campaignName: null,
              contactPhone: phoneNumber,
              nativeExecution: true,
              telephonyProvider: 'elevenlabs',
              testCall: true,
              conversationId: conversationId,
            },
          });
          console.log(`🔀 [Flow Test] Created flow execution for ElevenLabs test call`);
        } catch (flowExecError: any) {
          console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
        }
      }
      
      // Update call record with ElevenLabs conversation ID and Twilio SID
      // Note: callId is guaranteed to be set in ElevenLabs path (we only reach here when !isOpenAIProvider)
      const existingMetadata = (callRecord.metadata ?? {}) as import('@shared/schema').CallMetadata;
      await db
        .update(calls)
        .set({ 
          twilioSid: callSid || null,
          elevenLabsConversationId: conversationId,
          metadata: {
            ...existingMetadata,
            elevenLabsNative: true,
            conversationId: conversationId,
          }
        })
        .where(eq(calls.id, callId!));
        
    } catch (elevenLabsError: any) {
      console.error(`❌ [Flow Test] ElevenLabs call initiation failed:`, elevenLabsError);
      
      const failedMetadata = (callRecord.metadata ?? {}) as import('@shared/schema').CallMetadata;
      await db
        .update(calls)
        .set({
          status: 'failed',
          endedAt: new Date(),
          metadata: {
            ...failedMetadata,
            error: elevenLabsError.message || 'ElevenLabs call initiation failed'
          }
        })
        .where(eq(calls.id, callId!));
      
      throw new Error(`Failed to initiate call via ElevenLabs: ${elevenLabsError.message}`);
    }
    
    console.log(`✅ [Flow Test] Test call initiated successfully`);
    console.log(`   Call ID: ${callRecord.id}`);
    console.log(`   Conversation ID: ${conversationId}`);
    console.log(`   Flow: ${flow.name} (${flow.id})`);
    console.log(`   From: ${fromPhone.phoneNumber} -> To: ${phoneNumber}`);
    
    res.json({
      success: true,
      callId: callRecord.id,
      conversationId: conversationId,
      twilioSid: callSid,
      flowId: flow.id,
      flowName: flow.name,
      fromNumber: fromPhone.phoneNumber,
      toNumber: phoneNumber,
      message: "Test call initiated successfully via ElevenLabs. The agent will execute the workflow natively.",
      ...(activeCampaignWarning && { warning: activeCampaignWarning })
    });
  } catch (error: any) {
    console.error("Error testing flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/flow-templates", async (req: AuthRequest, res: Response) => {
  try {
    const templates = flowTemplates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      isTemplate: template.isTemplate,
      nodeCount: template.nodes.length,
      preview: template.nodes.slice(0, 3).map((n) => n.type),
    }));
    
    res.json(templates);
  } catch (error: any) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/flow-templates/:templateId/clone", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { templateId } = req.params;
    const { name } = req.body;
    
    const template = flowTemplates.find((t) => t.id === templateId);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    
    const newFlowId = nanoid();
    const now = new Date();
    // TODO: Drizzle type inference - template nodes/edges are typed but Drizzle insert expects exact match
    const [newFlow] = await db
      .insert(flows)
      .values({
        id: newFlowId,
        userId,
        name: name || template.name,
        description: template.description || null,
        nodes: template.nodes,
        edges: template.edges,
        isActive: false,
        isTemplate: false,
        createdAt: now,
        updatedAt: now,
      } as typeof flows.$inferInsert)
      .returning();
    
    res.json(newFlow);
  } catch (error: any) {
    console.error("Error cloning template:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/flows/:id/clone", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [originalFlow] = await db
      .select()
      .from(flows)
      .where(and(
        eq(flows.id, id),
        sql`(${flows.userId} = ${userId} OR ${flows.isTemplate} = true)`
      ));
    
    if (!originalFlow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    
    const newFlowId = nanoid();
    // TODO: Drizzle type inference - cloning flow with nodes/edges from existing record
    const [clonedFlow] = await db
      .insert(flows)
      .values({
        id: newFlowId,
        userId,
        name: `${originalFlow.name} (Copy)`,
        description: originalFlow.description,
        nodes: originalFlow.nodes,
        edges: originalFlow.edges,
        isActive: false,
        isTemplate: false,
      } as typeof flows.$inferInsert)
      .returning();
    
    res.json(clonedFlow);
  } catch (error: any) {
    console.error("Error cloning flow:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/webhooks", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    const userWebhooks = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.userId, userId))
      .orderBy(desc(webhooks.createdAt));
    
    res.json(userWebhooks);
  } catch (error: any) {
    console.error("Error fetching webhooks:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/webhooks", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const validatedData = createWebhookSchema.parse(req.body);
    
    const webhookId = nanoid();
    // TODO: Drizzle type inference - Zod validated data doesn't perfectly match insert type
    const [newWebhook] = await db
      .insert(webhooks)
      .values({
        id: webhookId,
        userId,
        ...validatedData,
      } as typeof webhooks.$inferInsert)
      .returning();
    
    res.json(newWebhook);
  } catch (error: any) {
    console.error("Error creating webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/webhooks/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [updatedWebhook] = await db
      .update(webhooks)
      .set({
        ...req.body,
        updatedAt: new Date(),
      })
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
      .returning();
    
    if (!updatedWebhook) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    
    res.json(updatedWebhook);
  } catch (error: any) {
    console.error("Error updating webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/webhooks/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    await db
      .delete(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/webhooks/:id/logs", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));
    
    if (!webhook) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    
    const logs = await db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.webhookId, id))
      .orderBy(desc(webhookLogs.createdAt))
      .limit(limit);
    
    res.json(logs);
  } catch (error: any) {
    console.error("Error fetching webhook logs:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/webhooks/:id/test", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const result = await webhookDeliveryService.testWebhook(id, userId);
    
    res.json(result);
  } catch (error: any) {
    console.error("Error testing webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/webhooks/logs/:logId/retry", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { logId } = req.params;
    
    const result = await webhookDeliveryService.retryWebhook(parseInt(logId, 10), userId);
    
    res.json(result);
  } catch (error: any) {
    console.error("Error retrying webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/appointments", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { startDate, endDate, status } = req.query;
    
    const conditions: any[] = [eq(appointments.userId, userId)];
    
    if (startDate && typeof startDate === 'string') {
      const parsedStartDate = new Date(startDate);
      if (!isNaN(parsedStartDate.getTime())) {
        conditions.push(gte(appointments.appointmentDate, parsedStartDate.toISOString().split('T')[0]));
      }
    }
    if (endDate && typeof endDate === 'string') {
      const parsedEndDate = new Date(endDate);
      if (!isNaN(parsedEndDate.getTime())) {
        conditions.push(lte(appointments.appointmentDate, parsedEndDate.toISOString().split('T')[0]));
      }
    }
    if (status) {
      conditions.push(eq(appointments.status, status as string));
    }
    
    const result = await db
      .select()
      .from(appointments)
      .where(and(...conditions))
      .orderBy(appointments.appointmentDate, appointments.appointmentTime);
    
    const appointmentsWithScheduledFor = result.map(apt => ({
      ...apt,
      scheduledFor: `${apt.appointmentDate}T${apt.appointmentTime}`,
    }));
    
    res.json(appointmentsWithScheduledFor);
  } catch (error: any) {
    console.error("Error fetching appointments:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/appointments", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const validatedData = createAppointmentSchema.parse(req.body);
    
    // Validate working hours
    const workingHoursResult = await validateWorkingHours(
      userId,
      validatedData.appointmentDate,
      validatedData.appointmentTime,
      validatedData.duration || 30
    );
    
    if (!workingHoursResult.valid) {
      return res.status(400).json({ error: workingHoursResult.message });
    }
    
    const [settings] = await db
      .select()
      .from(appointmentSettings)
      .where(eq(appointmentSettings.userId, userId));
    
    if (settings && !settings.allowOverlapping) {
      const existing = await db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.userId, userId),
            eq(appointments.appointmentDate, validatedData.appointmentDate),
            eq(appointments.appointmentTime, validatedData.appointmentTime),
            eq(appointments.status, "scheduled")
          )
        );
      
      if (existing.length > 0) {
        return res.status(409).json({ 
          error: "Appointment slot already booked",
          conflictingAppointment: existing[0]
        });
      }
    }
    
    const appointmentId = nanoid();
    const [newAppointment] = await db
      .insert(appointments)
      .values({
        id: appointmentId,
        userId,
        ...validatedData,
      })
      .returning();
    
    res.json(newAppointment);
  } catch (error: any) {
    console.error("Error creating appointment:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/appointments/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    // Fetch the original appointment to detect changes
    const [originalAppointment] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.userId, userId)));
    
    if (!originalAppointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    const [updatedAppointment] = await db
      .update(appointments)
      .set({
        ...req.body,
        updatedAt: new Date(),
      })
      .where(and(eq(appointments.id, id), eq(appointments.userId, userId)))
      .returning();
    
    if (!updatedAppointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    // Build common webhook payload
    const buildAppointmentPayload = (apt: typeof updatedAppointment) => ({
      appointmentId: apt.id,
      contactName: apt.contactName || null,
      contactPhone: apt.contactPhone || null,
      contactEmail: apt.contactEmail || null,
      date: apt.appointmentDate,
      time: apt.appointmentTime,
      duration: apt.duration || 30,
      serviceName: apt.serviceName || null,
      notes: apt.notes || null,
      status: apt.status,
      flowId: apt.flowId || null,
      callId: apt.callId || null,
    });
    
    // Trigger webhook events based on status changes
    const oldStatus = originalAppointment.status;
    const newStatus = updatedAppointment.status;
    const oldDate = originalAppointment.appointmentDate;
    const oldTime = originalAppointment.appointmentTime;
    const newDate = updatedAppointment.appointmentDate;
    const newTime = updatedAppointment.appointmentTime;
    
    // Check for reschedule (date or time changed)
    if ((oldDate !== newDate || oldTime !== newTime) && newStatus !== 'cancelled') {
      try {
        await webhookDeliveryService.triggerEvent(userId, 'appointment.rescheduled', {
          appointment: buildAppointmentPayload(updatedAppointment),
          previousDate: oldDate,
          previousTime: oldTime,
          newDate: newDate,
          newTime: newTime,
          rescheduledAt: new Date().toISOString(),
        });
        console.log(`📅 [Appointment Webhook] Triggered appointment.rescheduled for ${id}`);
      } catch (webhookError: any) {
        console.error(`📅 [Appointment Webhook] Failed to trigger rescheduled webhook:`, webhookError.message);
      }
    }
    
    // Check for status changes and trigger corresponding webhooks
    if (oldStatus !== newStatus) {
      try {
        switch (newStatus) {
          case 'confirmed':
            await webhookDeliveryService.triggerEvent(userId, 'appointment.confirmed', {
              appointment: buildAppointmentPayload(updatedAppointment),
              confirmedAt: new Date().toISOString(),
            });
            console.log(`📅 [Appointment Webhook] Triggered appointment.confirmed for ${id}`);
            break;
            
          case 'cancelled':
            await webhookDeliveryService.triggerEvent(userId, 'appointment.cancelled', {
              appointment: buildAppointmentPayload(updatedAppointment),
              cancelReason: req.body.cancelReason || null,
              cancelledAt: new Date().toISOString(),
            });
            console.log(`📅 [Appointment Webhook] Triggered appointment.cancelled for ${id}`);
            break;
            
          case 'completed':
            await webhookDeliveryService.triggerEvent(userId, 'appointment.completed', {
              appointment: buildAppointmentPayload(updatedAppointment),
              completedAt: new Date().toISOString(),
            });
            console.log(`📅 [Appointment Webhook] Triggered appointment.completed for ${id}`);
            break;
            
          case 'no_show':
          case 'noshow':
          case 'no-show':
            await webhookDeliveryService.triggerEvent(userId, 'appointment.no_show', {
              appointment: buildAppointmentPayload(updatedAppointment),
              markedNoShowAt: new Date().toISOString(),
            });
            console.log(`📅 [Appointment Webhook] Triggered appointment.no_show for ${id}`);
            break;
        }
      } catch (webhookError: any) {
        console.error(`📅 [Appointment Webhook] Failed to trigger ${newStatus} webhook:`, webhookError.message);
      }
    }
    
    res.json(updatedAppointment);
  } catch (error: any) {
    console.error("Error updating appointment:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/appointments/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    // Fetch the appointment before deletion to trigger webhook
    const [appointmentToDelete] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.userId, userId)));
    
    if (!appointmentToDelete) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    
    // Trigger appointment.cancelled webhook before deletion
    try {
      await webhookDeliveryService.triggerEvent(userId, 'appointment.cancelled', {
        appointment: {
          appointmentId: appointmentToDelete.id,
          contactName: appointmentToDelete.contactName || null,
          contactPhone: appointmentToDelete.contactPhone || null,
          contactEmail: appointmentToDelete.contactEmail || null,
          date: appointmentToDelete.appointmentDate,
          time: appointmentToDelete.appointmentTime,
          duration: appointmentToDelete.duration || 30,
          serviceName: appointmentToDelete.serviceName || null,
          notes: appointmentToDelete.notes || null,
          status: 'cancelled',
          flowId: appointmentToDelete.flowId || null,
          callId: appointmentToDelete.callId || null,
        },
        cancelReason: 'deleted',
        cancelledAt: new Date().toISOString(),
      });
      console.log(`📅 [Appointment Webhook] Triggered appointment.cancelled for deleted appointment ${id}`);
    } catch (webhookError: any) {
      console.error(`📅 [Appointment Webhook] Failed to trigger cancelled webhook:`, webhookError.message);
    }
    
    await db
      .delete(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.userId, userId)));
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting appointment:", error);
    res.status(500).json({ error: error.message });
  }
});

// TODO: appointment.reminder_sent webhook trigger
// This event should be triggered when an appointment reminder is sent to the contact.
// Currently, there is no appointment reminder system implemented.
// When a reminder system is added (e.g., a cron job that sends SMS/email reminders),
// uncomment and adapt the following code:
//
// async function sendAppointmentReminder(appointment: any, userId: string) {
//   // ... reminder sending logic ...
//   
//   // Trigger appointment.reminder_sent webhook
//   try {
//     await webhookDeliveryService.triggerEvent(userId, 'appointment.reminder_sent', {
//       appointment: {
//         appointmentId: appointment.id,
//         contactName: appointment.contactName || null,
//         contactPhone: appointment.contactPhone || null,
//         contactEmail: appointment.contactEmail || null,
//         date: appointment.appointmentDate,
//         time: appointment.appointmentTime,
//         duration: appointment.duration || 30,
//         serviceName: appointment.serviceName || null,
//         notes: appointment.notes || null,
//         status: appointment.status,
//         flowId: appointment.flowId || null,
//         callId: appointment.callId || null,
//       },
//       reminderType: 'email', // or 'sms'
//       reminderSentAt: new Date().toISOString(),
//       hoursBeforeAppointment: 24, // configurable
//     });
//     console.log(`📅 [Appointment Webhook] Triggered appointment.reminder_sent for ${appointment.id}`);
//   } catch (webhookError: any) {
//     console.error(`📅 [Appointment Webhook] Failed to trigger reminder_sent webhook:`, webhookError.message);
//   }
// }

router.get("/appointment-settings", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    const [settings] = await db
      .select()
      .from(appointmentSettings)
      .where(eq(appointmentSettings.userId, userId));
    
    // Convert database format to frontend format
    const convertToFrontendFormat = (workingHours: any) => {
      if (!workingHours) {
        return {
          workingHoursStart: "09:00",
          workingHoursEnd: "17:00",
          workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        };
      }
      
      // Extract enabled days
      const enabledDays: string[] = [];
      let startTime = "09:00";
      let endTime = "17:00";
      
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      for (const day of days) {
        const daySettings = workingHours[day];
        if (daySettings?.enabled) {
          enabledDays.push(day);
          // Use the first enabled day's times as the global times
          if (startTime === "09:00" && daySettings.start) startTime = daySettings.start;
          if (endTime === "17:00" && daySettings.end) endTime = daySettings.end;
        }
      }
      
      return {
        workingHoursStart: startTime,
        workingHoursEnd: endTime,
        workingDays: enabledDays,
      };
    };
    
    if (!settings) {
      return res.json({
        id: null,
        allowOverlap: false,
        bufferTime: 15,
        maxPerDay: null,
        workingHoursStart: "09:00",
        workingHoursEnd: "17:00",
        workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      });
    }
    
    // Convert to frontend format
    const frontendFormat = convertToFrontendFormat(settings.workingHours);
    
    res.json({
      id: settings.id,
      allowOverlap: settings.allowOverlapping,
      bufferTime: settings.bufferMinutes,
      maxPerDay: null,
      ...frontendFormat,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    });
  } catch (error: any) {
    console.error("Error fetching appointment settings:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/appointment-settings", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    // Accept frontend format and convert to database format
    const { 
      allowOverlap, 
      bufferTime, 
      workingHoursStart, 
      workingHoursEnd, 
      workingDays,
      // Also accept direct database format fields
      allowOverlapping,
      bufferMinutes,
      workingHours
    } = req.body;
    
    // Convert frontend format to database format
    const convertToDbFormat = () => {
      const start = workingHoursStart || "09:00";
      const end = workingHoursEnd || "17:00";
      const days = workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"];
      
      const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const result: Record<string, { start: string; end: string; enabled: boolean }> = {};
      
      for (const day of allDays) {
        result[day] = {
          start,
          end,
          enabled: days.includes(day),
        };
      }
      
      return result;
    };
    
    // Use provided workingHours object if given (direct database format), 
    // otherwise convert from frontend format
    const dbWorkingHours = workingHours || convertToDbFormat();
    const dbAllowOverlapping = allowOverlapping ?? allowOverlap ?? false;
    const dbBufferMinutes = bufferMinutes ?? bufferTime ?? 0;
    
    console.log('📅 [Settings] Saving appointment settings:', {
      allowOverlapping: dbAllowOverlapping,
      bufferMinutes: dbBufferMinutes,
      workingDays: workingDays,
      workingHours: dbWorkingHours,
    });
    
    const [existing] = await db
      .select()
      .from(appointmentSettings)
      .where(eq(appointmentSettings.userId, userId));
    
    if (existing) {
      const [updated] = await db
        .update(appointmentSettings)
        .set({
          allowOverlapping: dbAllowOverlapping,
          bufferMinutes: dbBufferMinutes,
          workingHours: dbWorkingHours,
          updatedAt: new Date(),
        })
        .where(eq(appointmentSettings.userId, userId))
        .returning();
      
      // Convert back to frontend format for response
      const frontendFormat = {
        id: updated.id,
        allowOverlap: updated.allowOverlapping,
        bufferTime: updated.bufferMinutes,
        maxPerDay: null,
        workingHoursStart: workingHoursStart || "09:00",
        workingHoursEnd: workingHoursEnd || "17:00",
        workingDays: workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
      
      return res.json(frontendFormat);
    } else {
      const settingsId = nanoid();
      const [created] = await db
        .insert(appointmentSettings)
        .values({
          id: settingsId,
          userId,
          allowOverlapping: dbAllowOverlapping,
          bufferMinutes: dbBufferMinutes,
          workingHours: dbWorkingHours,
        })
        .returning();
      
      // Convert back to frontend format for response
      const frontendFormat = {
        id: created.id,
        allowOverlap: created.allowOverlapping,
        bufferTime: created.bufferMinutes,
        maxPerDay: null,
        workingHoursStart: workingHoursStart || "09:00",
        workingHoursEnd: workingHoursEnd || "17:00",
        workingDays: workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
      
      return res.json(frontendFormat);
    }
  } catch (error: any) {
    console.error("Error updating appointment settings:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/appointments/sync", async (req: AuthRequest, res: Response) => {
  try {
    const {
      agentId,
      callId,
      contactName,
      contactPhone,
      contactEmail,
      appointmentDate,
      appointmentTime,
      duration,
      serviceName,
      notes,
      metadata
    } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }
    if (!contactName || !contactPhone) {
      return res.status(400).json({ error: "contactName and contactPhone are required" });
    }
    if (!appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: "appointmentDate and appointmentTime are required" });
    }

    const agent = await db
      .select({ userId: agents.userId, flowId: agents.flowId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (agent.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const userId = agent[0].userId;
    const flowId = agent[0].flowId;

    // Validate working hours
    const workingHoursResult = await validateWorkingHours(
      userId,
      appointmentDate,
      appointmentTime,
      duration || 30
    );
    
    if (!workingHoursResult.valid) {
      console.log(`📅 [Appointment Sync] Rejected due to working hours: ${workingHoursResult.message}`);
      return res.status(400).json({ 
        success: false,
        error: workingHoursResult.message 
      });
    }

    const appointmentId = nanoid();
    const [newAppointment] = await db
      .insert(appointments)
      .values({
        id: appointmentId,
        userId,
        callId: callId || null,
        flowId: flowId || null,
        contactName,
        contactPhone,
        contactEmail: contactEmail || null,
        appointmentDate,
        appointmentTime,
        duration: duration || 30,
        serviceName: serviceName || null,
        notes: notes || null,
        status: "scheduled",
        metadata: metadata || null,
      })
      .returning();

    console.log(`📅 [Appointment Sync] Created appointment ${appointmentId} for agent ${agentId}`);
    console.log(`   Contact: ${contactName} (${contactPhone})`);
    console.log(`   Date/Time: ${appointmentDate} at ${appointmentTime}`);

    res.json({
      success: true,
      appointment: newAppointment,
    });
  } catch (error: any) {
    console.error("Error syncing appointment:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/forms", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    
    const userForms = await db
      .select()
      .from(forms)
      .where(eq(forms.userId, userId))
      .orderBy(desc(forms.createdAt));
    
    // Include fields and submission count for each form
    const formsWithFieldsAndCount = await Promise.all(
      userForms.map(async (form) => {
        const fields = await db
          .select()
          .from(formFields)
          .where(eq(formFields.formId, form.id))
          .orderBy(formFields.order);
        
        // Get submission count
        const [submissionResult] = await db
          .select({ count: sql<number>`count(*)` })
          .from(formSubmissions)
          .where(eq(formSubmissions.formId, form.id));
        
        return { 
          ...form, 
          fields,
          submissionCount: Number(submissionResult?.count || 0)
        };
      })
    );
    
    res.json(formsWithFieldsAndCount);
  } catch (error: any) {
    console.error("Error fetching forms:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/forms/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [form] = await db
      .select()
      .from(forms)
      .where(and(eq(forms.id, id), eq(forms.userId, userId)));
    
    if (!form) {
      return res.status(404).json({ error: "Form not found" });
    }
    
    const fields = await db
      .select()
      .from(formFields)
      .where(eq(formFields.formId, id))
      .orderBy(formFields.order);
    
    res.json({ ...form, fields });
  } catch (error: any) {
    console.error("Error fetching form:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/forms", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { name, description, fields } = req.body;
    
    const formId = nanoid();
    const [newForm] = await db
      .insert(forms)
      .values({
        id: formId,
        userId,
        name,
        description,
      })
      .returning();
    
    if (fields && fields.length > 0) {
      const fieldValues = fields.map((field: any, index: number) => ({
        id: nanoid(),
        formId,
        question: field.question,
        fieldType: field.fieldType,
        options: field.options,
        isRequired: field.isRequired ?? true,
        order: index,
      }));
      
      await db.insert(formFields).values(fieldValues);
    }
    
    const createdFields = await db
      .select()
      .from(formFields)
      .where(eq(formFields.formId, formId))
      .orderBy(formFields.order);
    
    res.json({ ...newForm, fields: createdFields });
  } catch (error: any) {
    console.error("Error creating form:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/forms/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    const { name, description, fields } = req.body;
    
    const [updatedForm] = await db
      .update(forms)
      .set({
        name,
        description,
        updatedAt: new Date(),
      })
      .where(and(eq(forms.id, id), eq(forms.userId, userId)))
      .returning();
    
    if (!updatedForm) {
      return res.status(404).json({ error: "Form not found" });
    }
    
    if (fields) {
      await db.delete(formFields).where(eq(formFields.formId, id));
      
      if (fields.length > 0) {
        const fieldValues = fields.map((field: any, index: number) => ({
          id: nanoid(),
          formId: id,
          question: field.question,
          fieldType: field.fieldType,
          options: field.options,
          isRequired: field.isRequired ?? true,
          order: index,
        }));
        
        await db.insert(formFields).values(fieldValues);
      }
    }
    
    const updatedFields = await db
      .select()
      .from(formFields)
      .where(eq(formFields.formId, id))
      .orderBy(formFields.order);
    
    res.json({ ...updatedForm, fields: updatedFields });
  } catch (error: any) {
    console.error("Error updating form:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/forms/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    await db
      .delete(forms)
      .where(and(eq(forms.id, id), eq(forms.userId, userId)));
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting form:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/forms/:id/submissions", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { id } = req.params;
    
    const [form] = await db
      .select()
      .from(forms)
      .where(and(eq(forms.id, id), eq(forms.userId, userId)));
    
    if (!form) {
      return res.status(404).json({ error: "Form not found" });
    }
    
    const submissions = await db
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.formId, id))
      .orderBy(desc(formSubmissions.submittedAt));
    
    res.json(submissions);
  } catch (error: any) {
    console.error("Error fetching form submissions:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/executions", async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.userId!;
    const { flowId, callId, status } = req.query;
    
    const userFlows = await db
      .select({ id: flows.id, nodes: flows.nodes })
      .from(flows)
      .where(eq(flows.userId, userId));
    
    const userFlowIds = userFlows.map(f => f.id);
    
    if (userFlowIds.length === 0) {
      return res.json([]);
    }
    
    const flowNodesMap: Record<string, import('@shared/schema').FlowNode[]> = {};
    for (const flow of userFlows) {
      flowNodesMap[flow.id] = (flow.nodes || []) as import('@shared/schema').FlowNode[];
    }
    
    const conditions: any[] = [inArray(flowExecutions.flowId, userFlowIds)];
    
    if (flowId) conditions.push(eq(flowExecutions.flowId, flowId as string));
    if (callId) conditions.push(eq(flowExecutions.callId, callId as string));
    if (status) conditions.push(eq(flowExecutions.status, status as string));
    
    const executionsWithDetails = await db
      .select({
        id: flowExecutions.id,
        callId: flowExecutions.callId,
        flowId: flowExecutions.flowId,
        flowName: flows.name,
        flowNodes: flows.nodes,
        currentNodeId: flowExecutions.currentNodeId,
        status: flowExecutions.status,
        variables: flowExecutions.variables,
        pathTaken: flowExecutions.pathTaken,
        metadata: flowExecutions.metadata,
        error: flowExecutions.error,
        startedAt: flowExecutions.startedAt,
        completedAt: flowExecutions.completedAt,
        phoneNumber: calls.phoneNumber,
        callStatus: calls.status,
        contactId: calls.contactId,
        callDuration: calls.duration,
        callEndedAt: calls.endedAt,
        callTranscript: calls.transcript,
        callAiSummary: calls.aiSummary,
      })
      .from(flowExecutions)
      .leftJoin(flows, eq(flowExecutions.flowId, flows.id))
      .leftJoin(calls, eq(flowExecutions.callId, calls.id))
      .where(and(...conditions))
      .orderBy(desc(flowExecutions.startedAt))
      .limit(100);
    
    // Auto-sync: Fix any executions that show "running" but whose call is completed
    // First sync from main calls table
    const executionsToSync = executionsWithDetails.filter(
      e => e.status === 'running' && e.callStatus === 'completed' && e.callEndedAt
    );
    
    if (executionsToSync.length > 0) {
      console.log(`[Executions API] Syncing ${executionsToSync.length} stale executions from calls table`);
      for (const exec of executionsToSync) {
        await db
          .update(flowExecutions)
          .set({
            status: 'completed',
            completedAt: exec.callEndedAt,
          })
          .where(eq(flowExecutions.id, exec.id));
        
        // Update in-memory for this response - using Object.assign for type-safe mutation
        Object.assign(exec, { status: 'completed', completedAt: exec.callEndedAt });
      }
    }
    
    // Second pass: Sync from Plivo calls table for executions still showing "running"
    const stillRunningExecs = executionsWithDetails.filter(
      e => e.status === 'running' && !e.callStatus
    );
    
    if (stillRunningExecs.length > 0) {
      const stillRunningCallIds = stillRunningExecs.map(e => e.callId);
      
      // Check plivoCalls table
      const plivoCallStatuses = await db
        .select({ id: plivoCalls.id, status: plivoCalls.status, endedAt: plivoCalls.endedAt })
        .from(plivoCalls)
        .where(inArray(plivoCalls.id, stillRunningCallIds));
      
      const plivoCallMap = new Map(plivoCallStatuses.map(c => [c.id, c]));
      
      // Check twilioOpenaiCalls table
      const twilioOpenaiStatuses = await db
        .select({ id: twilioOpenaiCalls.id, status: twilioOpenaiCalls.status, endedAt: twilioOpenaiCalls.endedAt })
        .from(twilioOpenaiCalls)
        .where(inArray(twilioOpenaiCalls.id, stillRunningCallIds));
      
      const twilioOpenaiMap = new Map(twilioOpenaiStatuses.map(c => [c.id, c]));
      
      // Check sipCalls table
      const sipCallStatuses = await db
        .select({ id: sipCalls.id, status: sipCalls.status, endedAt: sipCalls.endedAt })
        .from(sipCalls)
        .where(inArray(sipCalls.id, stillRunningCallIds));
      
      const sipCallMap = new Map(sipCallStatuses.map(c => [c.id, c]));
      
      for (const exec of stillRunningExecs) {
        const plivoCall = plivoCallMap.get(exec.callId);
        const twilioCall = twilioOpenaiMap.get(exec.callId);
        const sipCall = sipCallMap.get(exec.callId);
        
        const callInfo = plivoCall || twilioCall || sipCall;
        
        if (callInfo && ['completed', 'failed', 'busy', 'no-answer', 'canceled', 'cancelled'].includes(callInfo.status)) {
          const execStatus = callInfo.status === 'completed' ? 'completed' : 'failed';
          await db
            .update(flowExecutions)
            .set({
              status: execStatus,
              completedAt: callInfo.endedAt || new Date(),
              error: callInfo.status !== 'completed' ? `Call ended with status: ${callInfo.status}` : null,
            })
            .where(eq(flowExecutions.id, exec.id));
          
          Object.assign(exec, { status: execStatus, completedAt: callInfo.endedAt || new Date() });
          console.log(`[Executions API] Synced execution ${exec.id} from alternate call table to ${execStatus}`);
        }
      }
    }
    
    // Third pass: Timeout-based cleanup for stale executions
    // If execution started >5 minutes ago and is still "running", mark as failed
    // This handles cases where status webhooks never arrived
    const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const now = new Date();
    
    const staleExecs = executionsWithDetails.filter(e => {
      if (e.status !== 'running') return false;
      if (!e.startedAt) return false;
      const startedAt = new Date(e.startedAt);
      const ageMs = now.getTime() - startedAt.getTime();
      return ageMs > STALE_TIMEOUT_MS;
    });
    
    if (staleExecs.length > 0) {
      console.log(`[Executions API] Found ${staleExecs.length} stale executions (>5 min old), marking as failed`);
      for (const exec of staleExecs) {
        await db
          .update(flowExecutions)
          .set({
            status: 'failed',
            completedAt: new Date(),
            error: 'Call status unknown - marked as failed after timeout (status webhook may not have been received)',
          })
          .where(eq(flowExecutions.id, exec.id));
        
        Object.assign(exec, { 
          status: 'failed', 
          completedAt: new Date(),
          error: 'Call status unknown - marked as failed after timeout'
        });
        console.log(`[Executions API] Marked stale execution ${exec.id} as failed (started ${exec.startedAt})`);
      }
    }
    
    // Look up contact names for executions with contactId
    const contactIds = executionsWithDetails
      .map(e => e.contactId)
      .filter((id): id is string => id !== null);
    
    const contactsMap: Record<string, { name: string; phone: string }> = {};
    if (contactIds.length > 0) {
      const contactRecords = await db
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, phone: contacts.phone })
        .from(contacts)
        .where(inArray(contacts.id, contactIds));
      
      for (const c of contactRecords) {
        const fullName = c.lastName ? `${c.firstName} ${c.lastName}` : c.firstName;
        contactsMap[c.id] = { name: fullName, phone: c.phone };
      }
    }
    
    const enrichedExecutions = executionsWithDetails.map(execution => {
      const nodes = (execution.flowNodes || []) as import('@shared/schema').FlowNode[];
      const pathTaken = (execution.pathTaken || []) as string[];
      
      // Get contact info - prioritize contacts table, fallback to call phoneNumber
      const contactInfo = execution.contactId ? contactsMap[execution.contactId] : null;
      
      const detailedPath = pathTaken.map((nodeId, index) => {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
          return {
            nodeId,
            stepNumber: index + 1,
            type: 'unknown',
            label: nodeId,
            content: null
          };
        }
        
        const config = (node.data?.config || {}) as any;
        let content: string | null = null;
        let label = node.data?.label || node.type || 'Unknown';
        
        switch (node.type) {
          case 'message':
            content = config.message || null;
            label = 'Message';
            break;
          case 'question':
            content = config.question || null;
            label = `Question: ${config.variableName || 'response'}`;
            break;
          case 'condition':
            content = `Checking: ${config.conditions?.map((c: any) => c.value).join(', ') || 'conditions'}`;
            label = 'Decision';
            break;
          case 'transfer':
            content = `Transfer to: ${config.transferNumber || 'unknown'}`;
            label = 'Transfer';
            break;
          case 'webhook':
            content = `Webhook: ${config.url || 'unknown'}`;
            label = 'Webhook';
            break;
          case 'appointment':
            content = config.serviceName || 'Schedule appointment';
            label = 'Appointment';
            break;
          case 'form':
            content = 'Collecting form data';
            label = 'Form';
            break;
          case 'delay':
            content = `Wait ${config.seconds || 0} seconds`;
            label = 'Delay';
            break;
          case 'end':
            content = config.message || 'End call';
            label = 'End';
            break;
        }
        
        return {
          nodeId,
          stepNumber: index + 1,
          type: node.type,
          label,
          content
        };
      });
      
      const { flowNodes, contactId, phoneNumber, callDuration, callEndedAt, callTranscript, callAiSummary, ...rest } = execution;
      const metadataObj = (execution.metadata || {}) as { contactPhone?: string; telephonyProvider?: string; testCall?: boolean };
      
      return {
        ...rest,
        contactPhone: contactInfo?.phone || phoneNumber || metadataObj.contactPhone || null,
        contactName: contactInfo?.name || null,
        duration: callDuration || null,
        transcriptPreview: callTranscript ? (callTranscript.length > 200 ? callTranscript.substring(0, 200) + '...' : callTranscript) : null,
        aiSummary: callAiSummary || null,
        detailedPath,
        isTestCall: metadataObj.testCall || false,
        telephonyProvider: metadataObj.telephonyProvider || null,
      };
    });
    
    res.json(enrichedExecutions);
  } catch (error: any) {
    console.error("Error fetching flow executions:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
