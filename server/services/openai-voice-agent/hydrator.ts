'use strict';
/**
 * ============================================================
 * Flow Hydrator Utility
 * 
 * Takes pre-compiled flow data from the flows table and creates
 * executable agent configurations with proper tool handlers.
 * 
 * This utility converts stored CompiledFunctionTool definitions
 * into runtime AgentTool objects with actual handler functions.
 * ============================================================
 */

import type { CompiledFunctionTool, CompiledConversationState } from '@shared/schema';
import { RAGKnowledgeService } from '../rag-knowledge';
import { db } from '../../db';
import { appointments, appointmentSettings, agents, formSubmissions, forms, formFields as formFieldsTable } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/**
 * Runtime AgentTool with handler function
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Agent configuration with tool context
 */
export interface AgentConfigWithContext {
  voice: string;
  model: string;
  systemPrompt: string;
  firstMessage?: string;
  temperature?: number;
  tools: AgentTool[];
  toolContext?: ToolContext;
  knowledgeBaseIds?: string[];
}

/**
 * Context for tool execution
 */
export interface ToolContext {
  userId: string;
  agentId: string;
  callId?: string;
}

/**
 * Parameters for hydrating a compiled flow
 */
export interface HydrateFlowParams {
  compiledSystemPrompt: string;
  compiledFirstMessage: string | null;
  compiledTools: CompiledFunctionTool[];
  compiledStates: CompiledConversationState[];
  voice: string;
  model: string;
  temperature: number;
  toolContext: ToolContext;
  language?: string;
  knowledgeBaseIds?: string[];
  transferPhoneNumber?: string;
  transferEnabled?: boolean;
}

/**
 * Language code to name mapping
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  cs: 'Czech',
  el: 'Greek',
  he: 'Hebrew',
  hu: 'Hungarian',
  ro: 'Romanian',
  uk: 'Ukrainian',
};

/**
 * Get language name from code
 */
function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

/**
 * Substitute {{variable}} placeholders in a value recursively
 */
function substituteVariables(
  template: unknown,
  params: Record<string, unknown>
): unknown {
  if (typeof template === 'string') {
    let result = template;
    const variablePattern = /\{\{(\w+)\}\}/g;
    let match;
    while ((match = variablePattern.exec(template)) !== null) {
      const varName = match[1];
      const value = params[varName];
      if (value !== undefined) {
        result = result.replace(match[0], String(value));
      }
    }
    return result;
  }
  if (Array.isArray(template)) {
    return template.map(item => substituteVariables(item, params));
  }
  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = substituteVariables(value, params);
    }
    return result;
  }
  return template;
}

/**
 * Create end_call tool handler
 */
function createEndCallHandler(): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    console.log(`[End Call Tool] Ending call, reason: ${params.reason || 'conversation complete'}`);
    return { 
      action: 'end_call',
      reason: params.reason as string || 'conversation complete'
    };
  };
}

/**
 * Create transfer_call tool handler
 */
function createTransferHandler(transferPhoneNumber?: string): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    const phoneNumber = (params.destination as string) || transferPhoneNumber || 'unknown';
    console.log(`[Transfer Tool] Initiating transfer to ${phoneNumber}, reason: ${params.reason || 'none'}`);
    return { 
      action: 'transfer',
      phoneNumber,
      reason: params.reason as string
    };
  };
}

/**
 * Create knowledge base lookup tool handler
 */
function createKnowledgeBaseHandler(
  knowledgeBaseIds: string[],
  userId: string
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    try {
      const query = params.query as string;
      console.log(`[KB Tool] Searching: "${query?.substring(0, 50)}..."`);
      
      if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) {
        return { found: false, message: 'No knowledge base configured.' };
      }
      
      const results = await RAGKnowledgeService.searchKnowledge(
        query,
        knowledgeBaseIds,
        userId,
        5
      );
      
      if (results.length === 0) {
        return { found: false, message: 'No relevant information found.' };
      }
      
      const formattedResponse = RAGKnowledgeService.formatResultsForAgent(results, 400);
      console.log(`[KB Tool] Found ${results.length} results`);
      
      return { found: true, information: formattedResponse };
    } catch (error: any) {
      console.error(`[KB Tool] Error:`, error.message);
      return { found: false, message: 'Unable to search knowledge base.' };
    }
  };
}

/**
 * Create appointment booking tool handler
 */
function createAppointmentHandler(
  userId: string,
  agentId: string,
  callId?: string
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    try {
      console.log(`[Appointment Tool] Booking:`, JSON.stringify(params));
      
      if (!params.contactName || !params.contactPhone || !params.appointmentDate || !params.appointmentTime) {
        return {
          success: false,
          message: 'Please provide name, phone, date and time for the appointment.'
        };
      }
      
      // Get agent's flowId if available
      const [agent] = await db
        .select({ flowId: agents.flowId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      
      // Check user's appointment settings for overlap validation and working hours
      const [settings] = await db
        .select()
        .from(appointmentSettings)
        .where(eq(appointmentSettings.userId, userId));
      
      // Default working hours
      const defaultWorkingHours: Record<string, { start: string; end: string; enabled: boolean }> = {
        monday: { start: "09:00", end: "17:00", enabled: true },
        tuesday: { start: "09:00", end: "17:00", enabled: true },
        wednesday: { start: "09:00", end: "17:00", enabled: true },
        thursday: { start: "09:00", end: "17:00", enabled: true },
        friday: { start: "09:00", end: "17:00", enabled: true },
        saturday: { start: "09:00", end: "17:00", enabled: false },
        sunday: { start: "09:00", end: "17:00", enabled: false },
      };
      
      // Validate working hours
      const appointmentDate = params.appointmentDate as string;
      const appointmentTime = params.appointmentTime as string;
      const parsedDate = new Date(appointmentDate + 'T12:00:00');
      
      if (!isNaN(parsedDate.getTime())) {
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
        const dayOfWeek = parsedDate.getDay();
        const dayName = dayNames[dayOfWeek];
        
        const userWorkingHours = settings?.workingHours as Record<string, { start: string; end: string; enabled: boolean }> | undefined;
        const daySettings = userWorkingHours?.[dayName] 
          ? { ...defaultWorkingHours[dayName], ...userWorkingHours[dayName] }
          : defaultWorkingHours[dayName];
        
        if (!daySettings?.enabled) {
          const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
          console.log(`[Appointment Tool] Rejected: ${dayName} is not available for appointments`);
          return {
            success: false,
            message: `We're not available on ${capitalizedDay}s. Please choose a different day.`
          };
        }
        
        // Check time is within working hours
        try {
          const parseTimeToMinutes = (timeStr: string): number => {
            const parts = timeStr.split(':');
            return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
          };
          
          const requestedMinutes = parseTimeToMinutes(appointmentTime);
          const startMinutes = parseTimeToMinutes(daySettings.start || "09:00");
          const endMinutes = parseTimeToMinutes(daySettings.end || "17:00");
          const duration = (params.duration as number) || 30;
          const appointmentEndMinutes = requestedMinutes + duration;
          
          if (requestedMinutes < startMinutes || appointmentEndMinutes > endMinutes) {
            const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
            console.log(`[Appointment Tool] Rejected: ${appointmentTime} is outside working hours`);
            return {
              success: false,
              message: `${appointmentTime} is outside our available hours on ${capitalizedDay}. We're available from ${daySettings.start} to ${daySettings.end}.`
            };
          }
        } catch (e) {
          console.log(`[Appointment Tool] Time validation error, allowing booking`);
        }
      }
      
      // Check for duplicate booking from same call
      if (callId) {
        const duplicateFromCall = await db
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.callId, callId),
              eq(appointments.appointmentDate, params.appointmentDate as string),
              eq(appointments.status, 'scheduled')
            )
          );
        
        if (duplicateFromCall.length > 0) {
          console.log(`[Appointment Tool] Duplicate booking attempt from same call ${callId}`);
          return {
            success: true,
            appointmentId: duplicateFromCall[0].id,
            message: `Your appointment is already confirmed for ${params.appointmentDate} at ${duplicateFromCall[0].appointmentTime}.`,
            alreadyBooked: true
          };
        }
      }

      // Check for duplicate booking by same contact phone on same date/time
      const duplicateByContact = await db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.userId, userId),
            eq(appointments.contactPhone, params.contactPhone as string),
            eq(appointments.appointmentDate, params.appointmentDate as string),
            eq(appointments.appointmentTime, params.appointmentTime as string),
            eq(appointments.status, 'scheduled')
          )
        );
      
      if (duplicateByContact.length > 0) {
        console.log(`[Appointment Tool] Duplicate booking attempt by same contact`);
        return {
          success: true,
          appointmentId: duplicateByContact[0].id,
          message: `You already have an appointment at this time. Your appointment is confirmed for ${params.appointmentDate} at ${params.appointmentTime}.`,
          alreadyBooked: true
        };
      }

      // Check for overlapping appointments if not allowed
      if (settings && !settings.allowOverlapping) {
        const existing = await db
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.userId, userId),
              eq(appointments.appointmentDate, params.appointmentDate as string),
              eq(appointments.appointmentTime, params.appointmentTime as string),
              eq(appointments.status, 'scheduled')
            )
          );
        
        if (existing.length > 0) {
          console.log(`[Appointment Tool] Slot conflict at ${params.appointmentDate} ${params.appointmentTime}`);
          return {
            success: false,
            message: `That time slot is already booked. Please choose a different time.`
          };
        }
      }
      
      const appointmentId = nanoid();
      await db
        .insert(appointments)
        .values({
          id: appointmentId,
          userId,
          callId: callId || null,
          flowId: agent?.flowId || null,
          contactName: params.contactName as string,
          contactPhone: params.contactPhone as string,
          contactEmail: (params.contactEmail as string) || null,
          appointmentDate: params.appointmentDate as string,
          appointmentTime: params.appointmentTime as string,
          duration: (params.duration as number) || 30,
          serviceName: (params.serviceName as string) || null,
          notes: (params.notes as string) || null,
          status: 'scheduled',
          metadata: { source: 'hydrated-flow', agentId },
        });
      
      console.log(`[Appointment Tool] Created appointment ${appointmentId}`);
      
      return { 
        success: true, 
        appointmentId,
        message: `Appointment booked for ${params.contactName} on ${params.appointmentDate} at ${params.appointmentTime}` 
      };
    } catch (error: any) {
      console.error(`[Appointment Tool] Error:`, error.message, error.stack);
      return { 
        success: false, 
        message: 'Unable to book appointment at this time. Please try again.' 
      };
    }
  };
}

/**
 * Create form submission tool handler
 * Fetches form fields from database and saves submission
 */
function createFormSubmissionHandler(
  formId: string,
  compiledFields: Array<{ name?: string; id?: string; type?: string; required?: boolean; label?: string; description?: string }>,
  userId: string,
  callId?: string
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    try {
      console.log(`[Form Tool] Submitting to form ${formId}:`, JSON.stringify(params));
      
      // Fetch form from database to get current field definitions
      const [form] = await db
        .select()
        .from(forms)
        .where(eq(forms.id, formId))
        .limit(1);
      
      if (!form) {
        console.error(`[Form Tool] Form ${formId} not found in database`);
        return { 
          success: false, 
          message: 'Form configuration not found.' 
        };
      }
      
      // Fetch form fields from database (fields stored in separate formFields table)
      const formFieldRows = await db
        .select()
        .from(formFieldsTable)
        .where(eq(formFieldsTable.formId, formId))
        .orderBy(formFieldsTable.order);
      
      // Use form fields from database if available, otherwise fall back to compiled fields
      const formFields = formFieldRows.length > 0
        ? formFieldRows.map(f => ({
            id: f.id,
            question: f.question,
            fieldType: f.fieldType,
            isRequired: f.isRequired,
          }))
        : compiledFields.map(f => ({
            id: f.id || f.name || 'unknown',
            question: f.description || f.label || f.name || 'Field',
            fieldType: f.type || 'text',
            isRequired: f.required || false,
          }));
      
      // Build responses array from the params, tracking consumed param keys
      const responses: Array<{ fieldId: string; question: string; answer: string }> = [];
      const consumedParamKeys = new Set<string>();
      const metaFields = ['contactName', 'contactPhone', 'contactEmail', 'fullName', 'phone'];
      
      for (const field of formFields) {
        // Try different field key patterns
        const fieldKey = `field_${(field.id || '').replace(/-/g, '_')}`;
        const altKey = field.id;
        const nameKey = (field as any).name;
        
        // Find which key matched
        let matchedKey: string | null = null;
        let value: unknown = undefined;
        
        if (params[fieldKey] !== undefined) {
          matchedKey = fieldKey;
          value = params[fieldKey];
        } else if (params[altKey] !== undefined) {
          matchedKey = altKey;
          value = params[altKey];
        } else if (nameKey && params[nameKey] !== undefined) {
          matchedKey = nameKey;
          value = params[nameKey];
        }
        
        if (value !== undefined && value !== null && matchedKey) {
          responses.push({
            fieldId: field.id,
            question: (field as any).question || (field as any).label || field.id,
            answer: String(value),
          });
          // Mark all possible keys for this field as consumed
          consumedParamKeys.add(fieldKey);
          consumedParamKeys.add(altKey);
          if (nameKey) consumedParamKeys.add(nameKey);
        }
      }
      
      // No fallback loop needed - we only store responses for known form fields
      
      const submissionId = nanoid();
      await db
        .insert(formSubmissions)
        .values({
          id: submissionId,
          formId,
          callId: callId || null,
          contactName: (params.contactName as string) || (params.fullName as string) || null,
          contactPhone: (params.contactPhone as string) || (params.phone as string) || null,
          responses,
        });
      
      console.log(`[Form Tool] Created submission ${submissionId} with ${responses.length} responses`);
      
      return { 
        success: true, 
        submissionId,
        message: 'Your information has been saved successfully.' 
      };
    } catch (error: any) {
      console.error(`[Form Tool] Error:`, error.message, error.stack);
      return { 
        success: false, 
        message: 'Unable to save information at this time. Please try again.' 
      };
    }
  };
}

/**
 * Create webhook tool handler
 */
function createWebhookHandler(
  webhookUrl: string,
  webhookMethod: string = 'POST',
  payloadTemplate?: Record<string, any>
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    try {
      let payload: unknown;
      
      if (payloadTemplate && Object.keys(payloadTemplate).length > 0) {
        payload = substituteVariables(payloadTemplate, params);
        console.log(`[Webhook Tool] Substituted payload:`, JSON.stringify(payload));
      } else {
        payload = params;
        console.log(`[Webhook Tool] Using params as payload:`, JSON.stringify(params));
      }
      
      console.log(`[Webhook Tool] ${webhookMethod} ${webhookUrl}`);
      
      const fetchOptions: RequestInit = {
        method: webhookMethod,
        headers: { 'Content-Type': 'application/json' },
      };
      
      if (['POST', 'PUT', 'PATCH'].includes(webhookMethod.toUpperCase())) {
        fetchOptions.body = JSON.stringify(payload);
      }
      
      const response = await fetch(webhookUrl, fetchOptions);
      
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
      
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      
      console.log(`[Webhook Tool] Response received`);
      return { success: true, data };
    } catch (error: any) {
      console.error(`[Webhook Tool] Error:`, error.message);
      return { success: false, error: error.message };
    }
  };
}

/**
 * Hydrate compiled tools into executable AgentTools with handlers
 */
export function hydrateCompiledTools(
  compiledTools: CompiledFunctionTool[],
  context: {
    userId: string;
    agentId: string;
    callId?: string;
    knowledgeBaseIds?: string[];
    transferPhoneNumber?: string;
  }
): AgentTool[] {
  const tools: AgentTool[] = [];
  
  for (const compiledTool of compiledTools) {
    const toolName = compiledTool.function.name;
    const description = compiledTool.function.description;
    const parameters = compiledTool.function.parameters;
    
    let handler: (params: Record<string, unknown>) => Promise<unknown>;
    
    switch (toolName) {
      case 'end_call':
        handler = createEndCallHandler();
        break;
        
      case 'transfer_call':
        handler = createTransferHandler(context.transferPhoneNumber);
        break;
        
      case 'query_knowledge_base':
      case 'lookup_knowledge_base':
        handler = createKnowledgeBaseHandler(
          context.knowledgeBaseIds || [],
          context.userId
        );
        break;
        
      case 'book_appointment':
        handler = createAppointmentHandler(
          context.userId,
          context.agentId,
          context.callId
        );
        break;
        
      default:
        // Check for transfer_* pattern (flow node transfer tools)
        if (toolName.startsWith('transfer_')) {
          handler = createTransferHandler(context.transferPhoneNumber);
        }
        // Check for webhook_* pattern
        else if (toolName.startsWith('webhook_')) {
          const metadata = (compiledTool as any)._metadata;
          
          if (metadata?.webhookUrl) {
            handler = createWebhookHandler(
              metadata.webhookUrl,
              metadata.webhookMethod || 'POST',
              metadata.payloadTemplate
            );
          } else {
            console.warn(`[Hydrator] Webhook tool ${toolName} missing URL in metadata`);
            handler = async (params: Record<string, unknown>) => {
              console.log(`[Generic Tool] ${toolName} called with:`, params);
              return { success: true, toolName, params };
            };
          }
        }
        // Check for api_call_* pattern
        else if (toolName.startsWith('api_call_')) {
          const metadata = (compiledTool as any)._metadata;
          
          if (metadata?.webhookUrl) {
            handler = createWebhookHandler(
              metadata.webhookUrl,
              metadata.webhookMethod || 'GET',
              metadata.payloadTemplate
            );
          } else {
            handler = async (params: Record<string, unknown>) => {
              console.log(`[API Call Tool] ${toolName} called with:`, params);
              return { success: true, toolName, params };
            };
          }
        }
        // Check for submit_form_* pattern
        else if (toolName.startsWith('submit_form')) {
          const metadata = (compiledTool as any)._metadata;
          const formId = metadata?.formId;
          
          if (formId) {
            handler = createFormSubmissionHandler(
              formId,
              metadata?.fields || [],
              context.userId,
              context.callId
            );
          } else {
            console.warn(`[Hydrator] Form tool ${toolName} missing formId in metadata`);
            handler = async (params: Record<string, unknown>) => {
              console.log(`[Form Tool] ${toolName} called but no formId - params:`, params);
              return { success: false, message: 'Form configuration missing' };
            };
          }
        }
        // Check for play_audio_* pattern
        else if (toolName.startsWith('play_audio')) {
          const metadata = (compiledTool as any)._metadata;
          const audioUrl = metadata?.audioUrl;
          
          // Handler just returns acknowledgment - actual playback is handled by audio bridge
          handler = async (params: Record<string, unknown>) => {
            console.log(`[Play Audio Tool] ${toolName} called, audioUrl: ${audioUrl}`);
            return { 
              action: 'play_audio',
              audioUrl: audioUrl || '',
              audioFileName: metadata?.audioFileName || 'audio file',
              interruptible: metadata?.interruptible ?? false,
              waitForComplete: metadata?.waitForComplete ?? true,
              message: audioUrl ? 'Audio playback requested.' : 'No audio URL configured.'
            };
          };
        }
        // Generic handler for unknown tools
        else {
          handler = async (params: Record<string, unknown>) => {
            console.log(`[Generic Tool] ${toolName} called with:`, params);
            return { success: true, toolName, params };
          };
        }
        break;
    }
    
    // Build the tool object with handler
    const tool: AgentTool & Record<string, unknown> = {
      name: toolName,
      description,
      parameters,
      handler,
    };
    
    // Attach metadata properties for serialization (needed by Plivo call service)
    // These allow the tool to be recreated after being stored in call metadata
    const toolMetadata = (compiledTool as any)._metadata;
    if (toolMetadata) {
      if (toolMetadata.webhookUrl) tool._webhookUrl = toolMetadata.webhookUrl;
      if (toolMetadata.webhookMethod) tool._webhookMethod = toolMetadata.webhookMethod;
      if (toolMetadata.payloadTemplate) tool._payloadTemplate = toolMetadata.payloadTemplate;
      if (toolMetadata.bodyTemplate) tool._bodyTemplate = toolMetadata.bodyTemplate;
      if (toolMetadata.headers) tool._webhookHeaders = toolMetadata.headers;
      if (toolMetadata.responseMapping) tool._responseMapping = toolMetadata.responseMapping;
      if (toolMetadata.formId) tool._formId = toolMetadata.formId;
      if (toolMetadata.formName) tool._formName = toolMetadata.formName;
      if (toolMetadata.formFields) tool._formFields = toolMetadata.formFields;
      if (toolMetadata.action) tool._action = toolMetadata.action;
    }
    
    // Also check for transfer number - from context OR from compiled tool metadata
    if (toolName === 'transfer_call' || toolName.startsWith('transfer_')) {
      // Priority: context.transferPhoneNumber > _metadata.phoneNumber
      const transferNum = context.transferPhoneNumber || toolMetadata?.phoneNumber;
      if (transferNum) {
        tool._transferNumber = transferNum;
        // Merge with existing metadata to preserve nodeId and other fields
        tool._metadata = { ...(toolMetadata ?? {}), phoneNumber: transferNum };
      }
    }
    
    // Preserve _metadata for play_audio tools (audio bridge needs audioUrl)
    if (toolName.startsWith('play_audio') && toolMetadata) {
      tool._metadata = { 
        audioUrl: toolMetadata.audioUrl,
        audioFileName: toolMetadata.audioFileName,
        interruptible: toolMetadata.interruptible,
        waitForComplete: toolMetadata.waitForComplete,
        nodeId: toolMetadata.nodeId,
      };
    }
    
    tools.push(tool);
  }
  
  console.log(`[Hydrator] Hydrated ${tools.length} tools from compiled data`);
  return tools;
}

/**
 * Hydrate a complete compiled flow into an executable agent configuration
 * 
 * This is the main entry point for using pre-compiled flow data at runtime.
 * It converts stored flow data into a ready-to-use agent configuration with
 * all tool handlers properly wired up.
 */
export function hydrateCompiledFlow(params: HydrateFlowParams): AgentConfigWithContext {
  const {
    compiledSystemPrompt,
    compiledFirstMessage,
    compiledTools,
    voice,
    model,
    temperature,
    toolContext,
    language,
    knowledgeBaseIds,
    transferPhoneNumber,
  } = params;
  
  // Build system prompt with language instructions if needed
  let systemPrompt = compiledSystemPrompt;
  if (language && language !== 'en' && !systemPrompt.includes('CRITICAL LANGUAGE REQUIREMENT')) {
    const languageName = getLanguageName(language);
    systemPrompt = `CRITICAL LANGUAGE REQUIREMENT: You MUST speak ONLY in ${languageName}. From the very first word you say, speak in ${languageName}. Do NOT speak English. This is mandatory.\n\n${systemPrompt}`;
  }
  
  // Hydrate the compiled tools with proper handlers
  const tools = hydrateCompiledTools(compiledTools, {
    userId: toolContext.userId,
    agentId: toolContext.agentId,
    callId: toolContext.callId,
    knowledgeBaseIds,
    transferPhoneNumber,
  });
  
  console.log(`[Hydrator] Created agent config: voice=${voice}, model=${model}, language=${language || 'en'}, tools=${tools.length}`);
  
  return {
    voice,
    model,
    systemPrompt,
    firstMessage: compiledFirstMessage || undefined,
    temperature,
    tools,
    toolContext,
    knowledgeBaseIds,
  };
}

/**
 * Substitute contact variables in a compiled flow's prompts
 * 
 * This handles {{contact_name}}, {{contact_phone}}, etc. placeholders
 * that need to be filled in at call time.
 */
export function substituteContactVariables(
  text: string,
  variables: Record<string, unknown>
): string {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    const replacement = String(value || '');
    result = result.split(placeholder).join(replacement);
  }
  return result;
}
