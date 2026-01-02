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
 * Outbound Call Service
 * 
 * Handles outbound calls via ElevenLabs Twilio integration.
 * This is separate from the main ElevenLabs service to keep incoming and outgoing call logic isolated.
 * 
 * API Endpoint: POST /v1/convai/twilio/outbound-call
 * @see https://elevenlabs.io/docs/api-reference/twilio/outbound-call
 */

export interface OutboundCallParams {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  conversationInitiationClientData?: {
    conversationConfigOverride?: {
      agent?: {
        prompt?: {
          prompt?: string;
        };
        firstMessage?: string;
      };
    };
  };
}

export interface OutboundCallResponse {
  success: boolean;
  message: string;
  conversationId: string | null;
  callSid: string | null;
}

export class OutboundCallService {
  private apiKey: string;
  private baseUrl: string = 'https://api.elevenlabs.io/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Initiate an outbound call via ElevenLabs Twilio integration
   * POST /v1/convai/twilio/outbound-call
   * 
   * @param params - Outbound call parameters (camelCase as per ElevenLabs SDK)
   * @returns Call response with conversation ID and call SID
   */
  async initiateCall(params: OutboundCallParams): Promise<OutboundCallResponse> {
    console.log(`📞 [OutboundCallService] Initiating outbound call`);
    console.log(`   Agent ID: ${params.agentId}`);
    console.log(`   Phone Number ID: ${params.agentPhoneNumberId}`);
    console.log(`   To: ${params.toNumber}`);

    // Build request body with snake_case keys as per ElevenLabs REST API
    // Note: The SDK uses camelCase but converts to snake_case internally
    const requestBody: Record<string, any> = {
      agent_id: params.agentId,
      agent_phone_number_id: params.agentPhoneNumberId,
      to_number: params.toNumber,
    };

    // Add optional conversation config override (also uses snake_case)
    if (params.conversationInitiationClientData) {
      requestBody.conversation_initiation_client_data = params.conversationInitiationClientData;
    }

    console.log(`📤 [OutboundCallService] POST /convai/twilio/outbound-call`);
    console.log(`   Payload:`, JSON.stringify(requestBody, null, 2));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`${this.baseUrl}/convai/twilio/outbound-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseText = await response.text();
      console.log(`📥 [OutboundCallService] Response status: ${response.status}`);
      console.log(`📥 [OutboundCallService] Response body: ${responseText}`);

      if (!response.ok) {
        const errorMsg = `ElevenLabs outbound call failed: ${response.status} - ${responseText}`;
        console.error(`❌ [OutboundCallService] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const result = JSON.parse(responseText);

      console.log(`✅ [OutboundCallService] Call initiated successfully`);
      console.log(`   Success: ${result.success}`);
      console.log(`   Message: ${result.message}`);
      console.log(`   Conversation ID: ${result.conversationId || result.conversation_id}`);
      console.log(`   Call SID: ${result.callSid}`);

      // Handle both camelCase and snake_case response formats for compatibility
      return {
        success: result.success,
        message: result.message,
        conversationId: result.conversationId || result.conversation_id || null,
        callSid: result.callSid || result.call_sid || null,
      };
    } catch (error) {
      console.error(`❌ [OutboundCallService] Error initiating call:`, error);
      throw error;
    }
  }

  /**
   * Helper to create conversation config override for custom prompts/messages
   */
  static createConfigOverride(options: {
    customPrompt?: string;
    firstMessage?: string;
  }): OutboundCallParams['conversationInitiationClientData'] | undefined {
    if (!options.customPrompt && !options.firstMessage) {
      return undefined;
    }

    return {
      conversationConfigOverride: {
        agent: {
          ...(options.customPrompt && {
            prompt: {
              prompt: options.customPrompt,
            },
          }),
          ...(options.firstMessage && {
            firstMessage: options.firstMessage,
          }),
        },
      },
    };
  }
}
