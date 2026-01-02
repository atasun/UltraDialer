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
 * Appointment ElevenLabs Tool Configuration
 * 
 * Configures the book_appointment webhook tool for ElevenLabs agents.
 * When a Flow Agent needs to book an appointment during a call, ElevenLabs calls
 * our webhook with the appointment details, which saves it to the database.
 * 
 * Tool Type: "webhook" (server-side) - ElevenLabs calls our endpoint directly
 * Security: Uses a shared secret token in header for webhook authentication
 */

import { getDomain } from "../utils/domain";
import crypto from "crypto";

let appointmentWebhookSecret: string | null = null;

export function getAppointmentWebhookSecret(): string {
  if (!appointmentWebhookSecret) {
    appointmentWebhookSecret = process.env.APPOINTMENT_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
    if (!process.env.APPOINTMENT_WEBHOOK_SECRET) {
      console.log(`📅 [Appointment Tool] Generated new webhook secret (set APPOINTMENT_WEBHOOK_SECRET env var for persistence)`);
    }
  }
  return appointmentWebhookSecret;
}

export function validateAppointmentWebhookToken(providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }
  const secret = getAppointmentWebhookSecret();
  
  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);
  
  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}

export interface AppointmentWebhookToolConfig {
  type: "webhook";
  name: string;
  description: string;
  api_schema: {
    url: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    request_body_schema?: Record<string, any>;
  };
}

/**
 * Get the book_appointment webhook tool configuration for ElevenLabs
 * @param agentId - The database agent ID (not ElevenLabs agent ID) for appointment ownership
 * @param callId - Optional call ID to associate the appointment with
 */
export function getBookAppointmentWebhookTool(agentId: string, callId?: string): AppointmentWebhookToolConfig {
  const domain = getDomain();
  const secret = getAppointmentWebhookSecret();
  
  const queryParams = callId ? `?callId=${encodeURIComponent(callId)}` : '';
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/appointment/${secret}/${agentId}${queryParams}`;
  
  const agentIdSuffix = agentId.slice(-8);
  const toolName = `book_appointment_${agentIdSuffix}`;
  
  console.log(`📅 [Appointment Tool] Creating webhook tool config for agent ${agentId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Webhook URL: ${webhookUrl.replace(secret, '[TOKEN]')}`);
  
  return {
    type: "webhook",
    name: toolName,
    description: "Book an appointment for the caller. Use this tool when the caller wants to schedule an appointment. Collect the date, time, and their contact information before calling this tool.",
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          contactName: {
            type: "string",
            description: "The name of the person booking the appointment"
          },
          contactPhone: {
            type: "string",
            description: "The phone number exactly as spoken by the caller. Accept any format - with or without country code, spaces, dashes, or parentheses. Do NOT ask the caller to repeat or reformat their number. Examples: '9990155993', '999-015-5993', '+1 555 123 4567', '(555) 123-4567' are all valid."
          },
          contactEmail: {
            type: "string",
            description: "Optional email address of the person"
          },
          appointmentDate: {
            type: "string",
            description: "The appointment date. Can be relative like 'tomorrow', 'next Monday', 'in 3 days' OR in YYYY-MM-DD format. The server will parse relative dates automatically."
          },
          appointmentTime: {
            type: "string",
            description: "The appointment time in HH:MM format (24-hour). Convert spoken times: '2pm' becomes '14:00', '9:30am' becomes '09:30'"
          },
          duration: {
            type: "number",
            description: "Duration in minutes (default 30)"
          },
          serviceName: {
            type: "string",
            description: "Optional name of the service/reason for appointment"
          },
          notes: {
            type: "string",
            description: "Optional additional notes about the appointment"
          }
        },
        required: ["contactName", "contactPhone", "appointmentDate", "appointmentTime"]
      }
    }
  };
}

/**
 * Get the appointment webhook tool for a specific ElevenLabs agent
 * Used when creating/updating Flow agents
 * 
 * @param elevenLabsAgentId - The ElevenLabs agent ID (required after agent is created in ElevenLabs)
 */
export function getAppointmentToolForAgent(elevenLabsAgentId: string): AppointmentWebhookToolConfig {
  const domain = getDomain();
  const secret = getAppointmentWebhookSecret();
  
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/appointment/${secret}/${elevenLabsAgentId}`;
  
  // Use agent-specific tool name to prevent conflicts
  const agentIdSuffix = elevenLabsAgentId.slice(-8);
  const toolName = `book_appointment_${agentIdSuffix}`;
  
  console.log(`📅 [Appointment Tool] Creating webhook tool for ElevenLabs agent ${elevenLabsAgentId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Webhook URL: ${webhookUrl.replace(secret, '[TOKEN]')}`);
  
  return {
    type: "webhook",
    name: toolName,
    description: "Book an appointment for the caller. Use this tool when the caller wants to schedule an appointment. Collect the date, time, and their contact information before calling this tool.",
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: {
          contactName: {
            type: "string",
            description: "The name of the person booking the appointment"
          },
          contactPhone: {
            type: "string",
            description: "The phone number exactly as spoken by the caller. Accept any format - with or without country code, spaces, dashes, or parentheses. Do NOT ask the caller to repeat or reformat their number. Examples: '9990155993', '999-015-5993', '+1 555 123 4567', '(555) 123-4567' are all valid."
          },
          contactEmail: {
            type: "string",
            description: "Optional email address of the person"
          },
          appointmentDate: {
            type: "string",
            description: "The appointment date. Can be relative like 'tomorrow', 'next Monday', 'in 3 days' OR in YYYY-MM-DD format. The server will parse relative dates automatically."
          },
          appointmentTime: {
            type: "string",
            description: "The appointment time in HH:MM format (24-hour). Convert spoken times: '2pm' becomes '14:00', '9:30am' becomes '09:30'"
          },
          duration: {
            type: "number",
            description: "Duration in minutes (default 30)"
          },
          serviceName: {
            type: "string",
            description: "Optional name of the service/reason for appointment"
          },
          notes: {
            type: "string",
            description: "Optional additional notes about the appointment"
          }
        },
        required: ["contactName", "contactPhone", "appointmentDate", "appointmentTime"]
      }
    }
  };
}
