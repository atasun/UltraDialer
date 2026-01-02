'use strict';
/**
 * ============================================================
 * Plivo-ElevenLabs Outbound Call Service
 * 
 * Handles outbound calls via Plivo SIP trunk to ElevenLabs.
 * Creates the ElevenLabs bridge session BEFORE initiating the Plivo call
 * to ensure audio streaming works correctly.
 * ============================================================
 */

import { ElevenLabsBridgeService, CreateBridgeSessionParams } from './elevenlabs-bridge.service';
import { getSipWebhookUrl } from '../config/config';

export interface OutboundCallParams {
  toNumber: string;
  fromNumber: string;
  agentId: string;
  elevenLabsApiKey: string;
  agentConfig?: {
    agentId: string;
    firstMessage?: string;
    language?: string;
    voiceId?: string;
  };
  plivoAuthId: string;
  plivoAuthToken: string;
}

export interface OutboundCallResult {
  success: boolean;
  callUuid?: string;
  error?: string;
}

export class PlivoElevenLabsOutboundService {
  
  /**
   * Initiate an outbound call
   * 
   * IMPORTANT: Creates ElevenLabs bridge session BEFORE calling Plivo
   * to ensure session exists when stream connects.
   */
  static async makeCall(params: OutboundCallParams): Promise<OutboundCallResult> {
    const {
      toNumber,
      fromNumber,
      agentId,
      elevenLabsApiKey,
      agentConfig,
      plivoAuthId,
      plivoAuthToken,
    } = params;
    
    const callUuid = `plivo-el-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    console.log(`[Plivo-ElevenLabs Outbound] Initiating call ${callUuid} to ${toNumber}`);
    
    try {
      const sessionParams: CreateBridgeSessionParams = {
        callUuid,
        agentId: agentConfig?.agentId || agentId,
        elevenLabsApiKey,
        agentConfig,
        fromNumber,
        toNumber,
        direction: 'outbound',
      };
      
      await ElevenLabsBridgeService.createSession(sessionParams);
      console.log(`[Plivo-ElevenLabs Outbound] Bridge session created for ${callUuid}`);
      
      const answerUrl = getSipWebhookUrl(`/voice/${callUuid}`);
      const statusUrl = getSipWebhookUrl('/voice/status');
      
      const plivoClient = await this.getPlivoClient(plivoAuthId, plivoAuthToken);
      
      const response = await plivoClient.calls.create(
        fromNumber,
        toNumber,
        answerUrl,
        {
          answerMethod: 'POST',
          hangupUrl: statusUrl,
          hangupMethod: 'POST',
          callbackUrl: statusUrl,
          callbackMethod: 'POST',
        }
      );
      
      console.log(`[Plivo-ElevenLabs Outbound] Plivo call initiated: ${response.requestUuid}`);
      
      return {
        success: true,
        callUuid,
      };
      
    } catch (error: any) {
      console.error(`[Plivo-ElevenLabs Outbound] Call failed:`, error.message);
      
      await ElevenLabsBridgeService.endSession(callUuid);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  /**
   * Get Plivo client instance
   */
  private static async getPlivoClient(authId: string, authToken: string): Promise<any> {
    const plivo = await import('plivo');
    return new plivo.Client(authId, authToken);
  }
}
