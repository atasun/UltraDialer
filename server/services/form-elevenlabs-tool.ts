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
 * Form Submission ElevenLabs Tool Configuration
 * 
 * Configures the submit_form webhook tool for ElevenLabs agents.
 * When a Flow Agent needs to submit form data during a call, ElevenLabs calls
 * our webhook with the collected responses, which saves it to the database.
 * 
 * Tool Type: "webhook" (server-side) - ElevenLabs calls our endpoint directly
 * Security: Uses a shared secret token in header for webhook authentication
 */

import { getDomain } from "../utils/domain";
import crypto from "crypto";

let formWebhookSecret: string | null = null;

export function getFormWebhookSecret(): string {
  if (!formWebhookSecret) {
    formWebhookSecret = process.env.FORM_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
    if (!process.env.FORM_WEBHOOK_SECRET) {
      console.log(`📋 [Form Tool] Generated new webhook secret (set FORM_WEBHOOK_SECRET env var for persistence)`);
    }
  }
  return formWebhookSecret;
}

export function validateFormWebhookToken(providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }
  const secret = getFormWebhookSecret();
  
  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);
  
  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}

export interface FormWebhookToolConfig {
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

export interface FormFieldDefinition {
  id: string;
  question: string;
  fieldType: string;
  options?: string[] | null;
  isRequired: boolean;
  order: number;
}

/**
 * Sanitize field ID for ElevenLabs API compatibility
 * ElevenLabs only allows: alphanumeric, underscores, non-consecutive dots, and @ symbols
 * Replace hyphens and other invalid characters with underscores
 */
export function sanitizeFieldId(fieldId: string): string {
  return fieldId
    .replace(/-/g, '_')  // Replace hyphens with underscores
    .replace(/[^a-zA-Z0-9_.@]/g, '_')  // Replace other invalid chars
    .replace(/\.{2,}/g, '.')  // Collapse consecutive dots
    .replace(/_{2,}/g, '_');  // Collapse consecutive underscores
}

/**
 * Generate request body schema properties from form fields
 * Each field becomes a property in the request body
 */
function generateFieldProperties(fields: FormFieldDefinition[]): Record<string, any> {
  const properties: Record<string, any> = {
    contactName: {
      type: "string",
      description: "The name of the person filling the form"
    },
    contactPhone: {
      type: "string", 
      description: "The phone number exactly as spoken by the caller. Accept any format - with or without country code, spaces, dashes, or parentheses. Do NOT ask the caller to repeat or reformat their number."
    }
  };
  
  for (const field of fields) {
    const fieldKey = `field_${sanitizeFieldId(field.id)}`;
    
    switch (field.fieldType) {
      case 'text':
        properties[fieldKey] = {
          type: "string",
          description: `Answer to: "${field.question}"`
        };
        break;
        
      case 'number':
        properties[fieldKey] = {
          type: "number",
          description: `Numeric answer to: "${field.question}"`
        };
        break;
        
      case 'yes_no':
        properties[fieldKey] = {
          type: "boolean",
          description: `Yes/No answer to: "${field.question}" (true = yes, false = no)`
        };
        break;
        
      case 'multiple_choice':
        properties[fieldKey] = {
          type: "string",
          description: `Choice for: "${field.question}"${field.options?.length ? `. Options: ${field.options.join(', ')}` : ''}`
        };
        break;
        
      case 'email':
        properties[fieldKey] = {
          type: "string",
          description: `Email address for: "${field.question}"`
        };
        break;
        
      case 'phone':
        properties[fieldKey] = {
          type: "string",
          description: `Phone number for: "${field.question}". Accept any format.`
        };
        break;
        
      case 'date':
        properties[fieldKey] = {
          type: "string",
          description: `Date for: "${field.question}". Can be natural language like 'tomorrow' or formatted date.`
        };
        break;
        
      case 'rating':
        properties[fieldKey] = {
          type: "number",
          description: `Rating (1-5 or 1-10) for: "${field.question}"`
        };
        break;
        
      default:
        properties[fieldKey] = {
          type: "string",
          description: `Answer to: "${field.question}"`
        };
    }
  }
  
  return properties;
}

/**
 * Get required fields array from form fields
 */
function getRequiredFields(fields: FormFieldDefinition[]): string[] {
  const required = ['contactName', 'contactPhone'];
  
  for (const field of fields) {
    if (field.isRequired) {
      required.push(`field_${sanitizeFieldId(field.id)}`);
    }
  }
  
  return required;
}

/**
 * Get the submit_form webhook tool configuration for ElevenLabs
 * @param formId - The database form ID
 * @param formName - The form name for the tool description
 * @param fields - The form fields to collect
 * @param agentId - The ElevenLabs agent ID
 */
export function getSubmitFormWebhookTool(
  formId: string,
  formName: string,
  fields: FormFieldDefinition[],
  agentId: string
): FormWebhookToolConfig {
  const domain = getDomain();
  const secret = getFormWebhookSecret();
  
  const webhookUrl = `${domain}/api/webhooks/elevenlabs/form/${secret}/${formId}/${agentId}`;
  
  const formIdSuffix = formId.slice(-8);
  const toolName = `submit_form_${formIdSuffix}`;
  
  console.log(`📋 [Form Tool] Creating webhook tool config for form ${formId}`);
  console.log(`   Tool name: ${toolName}`);
  console.log(`   Form: ${formName} (${fields.length} fields)`);
  console.log(`   Webhook URL: ${webhookUrl.replace(secret, '[TOKEN]')}`);
  
  const fieldDescriptions = fields
    .sort((a, b) => a.order - b.order)
    .map((f, i) => `${i + 1}. "${f.question}" (${f.fieldType}${f.isRequired ? ', required' : ''})`)
    .join('\n');
  
  return {
    type: "webhook",
    name: toolName,
    description: `Submit the "${formName}" form. Collect the following information from the caller before using this tool:\n${fieldDescriptions}\n\nOnce all required fields are collected, call this tool to save the form submission.`,
    api_schema: {
      url: webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      request_body_schema: {
        type: "object",
        properties: generateFieldProperties(fields),
        required: getRequiredFields(fields)
      }
    }
  };
}

/**
 * Generate the prompt for collecting form data
 * This creates detailed instructions for the AI to collect each field
 */
export function generateFormCollectionPrompt(
  introMessage: string,
  formName: string,
  fields: FormFieldDefinition[]
): string {
  const sortedFields = [...fields].sort((a, b) => a.order - b.order);
  
  const fieldInstructions = sortedFields.map((field, index) => {
    let instruction = `${index + 1}. Ask: "${field.question}"`;
    
    switch (field.fieldType) {
      case 'yes_no':
        instruction += ` (Accept yes/no, yeah/nah, affirmative/negative responses)`;
        break;
      case 'multiple_choice':
        if (field.options?.length) {
          instruction += ` (Options: ${field.options.join(', ')})`;
        }
        break;
      case 'number':
        instruction += ` (Collect a number)`;
        break;
      case 'email':
        instruction += ` (Collect email address, confirm spelling)`;
        break;
      case 'phone':
        instruction += ` (Accept any phone format)`;
        break;
      case 'rating':
        instruction += ` (Collect a rating, typically 1-5 or 1-10)`;
        break;
      case 'date':
        instruction += ` (Accept natural language dates like "tomorrow", "next week")`;
        break;
    }
    
    if (field.isRequired) {
      instruction += ` [REQUIRED]`;
    }
    
    return instruction;
  }).join('\n');
  
  const formIdSuffix = sortedFields[0]?.id ? sortedFields[0].id.split('_')[0] : 'form';
  
  return `Say exactly: '${introMessage}'

FORM COLLECTION INSTRUCTIONS for "${formName}":
After the caller responds, collect the following information in order:

${fieldInstructions}

IMPORTANT RULES:
1. Ask each question one at a time, wait for the response before proceeding.
2. If the caller's response is unclear, politely ask for clarification.
3. For required fields, do not skip - gently re-ask if needed.
4. Once all required fields are collected, use the submit_form tool to save the responses.
5. CRITICAL: After successful submission, you MUST say exactly: "Your information has been saved successfully." This exact phrase signals completion.
6. If submission fails, apologize and try again.
7. Only after saying "Your information has been saved successfully" should you proceed to the next step.

PHONE NUMBER PRONUNCIATION: When reading back or confirming any phone number, ALWAYS speak each digit separately with brief pauses. For example:
- "9990155993" should be spoken as "nine, nine, nine, zero, one, five, five, nine, nine, three"
- Never read phone numbers as large numbers (do NOT say "nine hundred ninety-nine million...")
- Group digits in sets of 3 or 4 for natural reading rhythm

Then stop speaking and wait for response.`;
}
