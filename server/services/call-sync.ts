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
import { db } from '../db';
import { calls, agents, campaigns } from '../../shared/schema';
import { eq, or, and, isNull, isNotNull } from 'drizzle-orm';
import { twilioService } from './twilio';
import { ElevenLabsService, elevenLabsService } from './elevenlabs';
import { ElevenLabsPoolService } from './elevenlabs-pool';

export interface SyncResult {
  callId: string;
  success: boolean;
  error?: string;
  skipped?: boolean; // True if sync was skipped due to missing external IDs
  updatedFields: string[];
}

export interface SyncSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number; // Calls skipped due to missing external IDs
  errors?: string[];
  results?: SyncResult[];
}

/**
 * Unified Call Sync Service
 * Fetches and combines call data from both ElevenLabs and Twilio sources
 * to provide the most complete call information possible
 */
export class CallSyncService {
  
  /**
   * Sync a single call from both sources (ElevenLabs + Twilio)
   * Combines data to get the best possible information
   */
  async syncCall(callId: string): Promise<SyncResult> {
    const updatedFields: string[] = [];
    let twilioFetchSuccess = false;
    let elevenLabsFetchSuccess = false;
    
    try {
      // Get the call record
      const [callRecord] = await db
        .select()
        .from(calls)
        .where(eq(calls.id, callId))
        .limit(1);
      
      if (!callRecord) {
        return { callId, success: false, error: 'Call not found', updatedFields };
      }

      // Skip if no external IDs to sync from (mark as skipped, not failed)
      if (!callRecord.twilioSid && !callRecord.elevenLabsConversationId) {
        return { callId, success: false, skipped: true, error: 'No external IDs available for sync', updatedFields };
      }

      console.log(`🔄 [Sync] Syncing call ${callId}`);
      console.log(`   Twilio SID: ${callRecord.twilioSid || 'N/A'}`);
      console.log(`   ElevenLabs Conv ID: ${callRecord.elevenLabsConversationId || 'N/A'}`);

      // Prepare update object
      const updates: Record<string, any> = {};
      
      // 1. Fetch from Twilio (for phone numbers, duration, recording)
      if (callRecord.twilioSid) {
        try {
          console.log(`   📞 Fetching from Twilio...`);
          const twilioData = await twilioService.getCallDetails(callRecord.twilioSid);
          
          if (twilioData) {
            twilioFetchSuccess = true;
            
            // Update phone number if missing
            if (!callRecord.phoneNumber && twilioData.to) {
              updates.phoneNumber = twilioData.to;
              updatedFields.push('phoneNumber');
            }
            
            // Update duration if missing or different
            if (!callRecord.duration && twilioData.duration) {
              updates.duration = twilioData.duration;
              updatedFields.push('duration');
            }
            
            // Update recording URL if missing
            if (!callRecord.recordingUrl && twilioData.recordingUrl) {
              updates.recordingUrl = twilioData.recordingUrl;
              updatedFields.push('recordingUrl');
            }
            
            // Update call direction based on Twilio data
            if (!callRecord.callDirection) {
              const direction = twilioData.direction === 'inbound' ? 'incoming' : 'outgoing';
              updates.callDirection = direction;
              updatedFields.push('callDirection');
            }
            
            // Store Twilio metadata
            const existingMetadata = callRecord.metadata as object || {};
            updates.metadata = {
              ...existingMetadata,
              twilioFrom: twilioData.from,
              twilioTo: twilioData.to,
              twilioStatus: twilioData.status,
              twilioDirection: twilioData.direction,
              twilioSyncedAt: new Date().toISOString(),
            };
            
            console.log(`   ✅ Twilio data: from=${twilioData.from}, to=${twilioData.to}, duration=${twilioData.duration}s`);
          }
        } catch (twilioError: any) {
          console.warn(`   ⚠️ Twilio fetch failed: ${twilioError.message}`);
        }
      }
      
      // 2. Fetch from ElevenLabs (for transcript, analysis, conversation data)
      if (callRecord.elevenLabsConversationId) {
        try {
          console.log(`   🤖 Fetching from ElevenLabs...`);
          
          // Get the correct ElevenLabs service for this call's agent
          let agentElevenLabsService: ElevenLabsService = elevenLabsService;
          
          // Try to find the agent and use their credential
          let agentId: string | null = null;
          if (callRecord.campaignId) {
            const [campaign] = await db
              .select()
              .from(campaigns)
              .where(eq(campaigns.id, callRecord.campaignId))
              .limit(1);
            agentId = campaign?.agentId || null;
          }
          
          if (agentId) {
            const [agent] = await db
              .select()
              .from(agents)
              .where(eq(agents.id, agentId))
              .limit(1);
            
            if (agent?.elevenLabsCredentialId) {
              const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
              if (credential) {
                agentElevenLabsService = new ElevenLabsService(credential.apiKey);
              }
            }
          }
          
          const elevenLabsData = await agentElevenLabsService.getConversationDetails(
            callRecord.elevenLabsConversationId
          );
          
          if (elevenLabsData) {
            elevenLabsFetchSuccess = true;
            
            // Update transcript if missing
            if (!callRecord.transcript && elevenLabsData.transcript?.length > 0) {
              const transcriptText = elevenLabsData.transcript.map(entry => 
                `${entry.role.toUpperCase()} (${entry.time_in_call_secs}s): ${entry.message}`
              ).join('\n');
              updates.transcript = transcriptText;
              updatedFields.push('transcript');
            }
            
            // Update AI summary if missing
            if (!callRecord.aiSummary && elevenLabsData.analysis?.summary) {
              updates.aiSummary = elevenLabsData.analysis.summary;
              updatedFields.push('aiSummary');
            }
            
            // Update classification based on analysis
            if (!callRecord.classification && elevenLabsData.analysis) {
              const classification = elevenLabsData.analysis.call_successful 
                ? 'completed_successful' 
                : 'completed';
              updates.classification = classification;
              updatedFields.push('classification');
            }
            
            // Update duration from ElevenLabs if Twilio didn't have it
            if (!updates.duration && !callRecord.duration && elevenLabsData.call_duration_secs) {
              updates.duration = elevenLabsData.call_duration_secs;
              updatedFields.push('duration');
            }
            
            // Update phone numbers from ElevenLabs metadata if still missing
            if (!updates.phoneNumber && !callRecord.phoneNumber) {
              const fromNumber = elevenLabsData.metadata?.from_number;
              const toNumber = elevenLabsData.metadata?.to_number;
              if (callRecord.callDirection === 'incoming' && fromNumber) {
                updates.phoneNumber = fromNumber;
                updatedFields.push('phoneNumber');
              } else if (toNumber) {
                updates.phoneNumber = toNumber;
                updatedFields.push('phoneNumber');
              }
            }
            
            // Update recording URL from ElevenLabs if still missing
            if (!updates.recordingUrl && !callRecord.recordingUrl && elevenLabsData.recording_url) {
              updates.recordingUrl = elevenLabsData.recording_url;
              updatedFields.push('recordingUrl');
            }
            
            // Merge ElevenLabs metadata
            const existingMetadata = updates.metadata || callRecord.metadata as object || {};
            updates.metadata = {
              ...existingMetadata,
              elevenLabsStatus: elevenLabsData.status,
              elevenLabsAnalysis: elevenLabsData.analysis,
              elevenLabsFrom: elevenLabsData.metadata?.from_number,
              elevenLabsTo: elevenLabsData.metadata?.to_number,
              elevenLabsSyncedAt: new Date().toISOString(),
            };
            
            console.log(`   ✅ ElevenLabs data: status=${elevenLabsData.status}, transcript=${elevenLabsData.transcript?.length || 0} entries`);
          }
        } catch (elevenLabsError: any) {
          console.warn(`   ⚠️ ElevenLabs fetch failed: ${elevenLabsError.message}`);
        }
      }
      
      // 3. Apply updates if any fields were updated
      if (updatedFields.length > 0) {
        // Update status to completed if we have transcript
        if (updates.transcript && callRecord.status !== 'completed') {
          updates.status = 'completed';
          updatedFields.push('status');
        }
        
        await db
          .update(calls)
          .set(updates)
          .where(eq(calls.id, callId));
        
        console.log(`   ✅ Updated ${updatedFields.length} fields: ${updatedFields.join(', ')}`);
        return { callId, success: true, updatedFields };
      } else if (twilioFetchSuccess || elevenLabsFetchSuccess) {
        // Data was fetched but no new fields to update (already up to date)
        console.log(`   ℹ️ No new data to update (already synced)`);
        return { callId, success: true, updatedFields };
      } else {
        // Neither source returned data
        console.log(`   ⚠️ No data returned from either source`);
        return { callId, success: false, error: 'No data returned from external sources', updatedFields };
      }
      
    } catch (error: any) {
      console.error(`❌ [Sync] Error syncing call ${callId}:`, error.message);
      return { callId, success: false, error: error.message, updatedFields };
    }
  }
  
  /**
   * Sync all calls that need syncing
   * Targets calls that have either Twilio SID or ElevenLabs conversation ID
   * and are missing data (transcript, recording, duration, etc.)
   */
  async syncAllCalls(): Promise<SyncSummary> {
    console.log('🔄 [Sync] Starting sync for all calls...');
    
    try {
      // Find calls that need syncing:
      // - Have Twilio SID OR ElevenLabs conversation ID
      // - Are completed/answered status
      // - Missing transcript OR recording OR duration
      const callsToSync = await db
        .select()
        .from(calls)
        .where(
          and(
            or(
              isNotNull(calls.twilioSid),
              isNotNull(calls.elevenLabsConversationId)
            ),
            or(
              eq(calls.status, 'completed'),
              eq(calls.status, 'answered')
            ),
            or(
              isNull(calls.transcript),
              isNull(calls.recordingUrl),
              isNull(calls.duration)
            )
          )
        );
      
      console.log(`📊 Found ${callsToSync.length} calls to sync`);
      
      const results: SyncResult[] = [];
      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];
      
      // Process calls one at a time to avoid rate limiting
      for (const call of callsToSync) {
        const result = await this.syncCall(call.id);
        results.push(result);
        
        if (result.success) {
          successCount++;
        } else if (result.skipped) {
          // Track skipped calls separately - not a failure
          skippedCount++;
        } else {
          failCount++;
          if (result.error) {
            errors.push(`Call ${call.id}: ${result.error}`);
          }
        }
        
        // Small delay between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      const summary: SyncSummary = {
        total: callsToSync.length,
        success: successCount,
        failed: failCount,
        skipped: skippedCount,
        errors: errors.length > 0 ? errors : undefined,
        results
      };
      
      console.log(`✅ [Sync] Complete: ${successCount} successful, ${skippedCount} skipped, ${failCount} failed out of ${callsToSync.length}`);
      
      return summary;
      
    } catch (error: any) {
      console.error('❌ [Sync] Error syncing calls:', error);
      return {
        total: 0,
        success: 0,
        failed: 1,
        skipped: 0,
        errors: [error.message]
      };
    }
  }
  
  /**
   * Sync a call from webhook data (combines ElevenLabs webhook + Twilio lookup)
   * Used when processing incoming webhooks to get complete call data
   */
  async syncFromWebhook(params: {
    conversationId: string;
    agentId?: string;
    transcript?: Array<{ role: string; message: string; time_in_call_secs: number }>;
    analysis?: { call_successful?: boolean; summary?: string; data_collected?: Record<string, any> };
    metadata?: { call_sid?: string; from_number?: string; to_number?: string; direction?: string };
    status?: string;
    callDurationSecs?: number;
  }): Promise<{
    phoneNumber: string | null;
    calledNumber: string | null;
    duration: number | null;
    recordingUrl: string | null;
    transcript: string | null;
    aiSummary: string | null;
    classification: string | null;
    metadata: Record<string, any>;
  }> {
    console.log(`🔄 [Sync] Syncing from webhook for conversation: ${params.conversationId}`);
    
    // Extract phone numbers from all possible nested locations
    // Priority: phone_call object > batch_call object > direct metadata fields
    const webhookMeta = params.metadata as any;
    let phoneNumber: string | null = 
      webhookMeta?.phone_call?.from || 
      webhookMeta?.phone_call?.from_number ||
      webhookMeta?.batch_call?.from ||
      webhookMeta?.from_number || 
      null;
    let calledNumber: string | null = 
      webhookMeta?.phone_call?.to || 
      webhookMeta?.phone_call?.to_number ||
      webhookMeta?.batch_call?.to ||
      webhookMeta?.to_number || 
      null;
    const callSidFromWebhook = 
      webhookMeta?.phone_call?.call_sid ||
      webhookMeta?.phone_call?.twilio_call_sid ||
      webhookMeta?.call_sid ||
      null;
    
    let duration: number | null = params.callDurationSecs || null;
    let recordingUrl: string | null = null;
    const metadata: Record<string, any> = {};
    
    console.log(`   Phone numbers from webhook:`);
    console.log(`     From: ${phoneNumber || 'N/A'}`);
    console.log(`     To: ${calledNumber || 'N/A'}`);
    console.log(`     CallSid: ${callSidFromWebhook || 'N/A'}`);
    
    // Format transcript from webhook data
    let transcript: string | null = null;
    if (params.transcript && params.transcript.length > 0) {
      transcript = params.transcript.map(entry => 
        `${entry.role.toUpperCase()} (${entry.time_in_call_secs}s): ${entry.message}`
      ).join('\n');
    }
    
    // Extract analysis - ElevenLabs sends transcript_summary in analysis object
    // Check multiple possible field names for compatibility
    const analysisObj = params.analysis as any;
    const aiSummary = analysisObj?.transcript_summary || analysisObj?.summary || null;
    
    // Extract lead classification from call analysis
    // Use hot/warm/cold/lost based on call_successful, sentiment, and duration
    let classification: string | null = null;
    if (analysisObj) {
      const callSuccessful = analysisObj.call_successful === 'success' || analysisObj.call_successful === true;
      const callFailed = analysisObj.call_successful === 'failure' || analysisObj.call_successful === false;
      
      // Extract sentiment from evaluation results if available
      const evaluationResults = analysisObj.evaluation_criteria_results || {};
      const sentimentResult = evaluationResults.sentiment || evaluationResults.customer_sentiment;
      const sentiment = sentimentResult?.result?.toLowerCase() || 
                       analysisObj.sentiment?.toLowerCase() || 
                       null;
      
      // Get call duration from webhook or params
      const callDuration = params.callDurationSecs || duration || 0;
      
      if (callFailed) {
        // Failed calls = lost leads
        classification = 'lost';
      } else if (callSuccessful) {
        // Successful calls - classify based on engagement level
        if (sentiment === 'positive' || sentiment === 'very positive' || callDuration >= 180) {
          // Positive sentiment OR engaged for 3+ minutes = hot lead
          classification = 'hot';
        } else if (sentiment === 'negative' || sentiment === 'very negative') {
          // Negative sentiment = cold lead
          classification = 'cold';
        } else if (callDuration >= 60) {
          // Neutral sentiment but decent engagement (1-3 min) = warm lead
          classification = 'warm';
        } else {
          // Short successful call = cold lead
          classification = 'cold';
        }
      } else {
        // Unknown status - mark as cold if we have some data
        classification = callDuration > 0 ? 'cold' : null;
      }
    }
    
    console.log(`   Webhook data extracted:`);
    console.log(`     Transcript: ${transcript ? `${transcript.length} chars, ${params.transcript?.length || 0} turns` : 'N/A'}`);
    console.log(`     AI Summary: ${aiSummary ? `${aiSummary.length} chars` : 'N/A'}`);
    console.log(`     Classification: ${classification || 'N/A'}`);
    
    // Try to get additional data from Twilio using call_sid (already extracted from nested locations)
    if (callSidFromWebhook) {
      console.log(`   📞 Fetching Twilio data for SID: ${callSidFromWebhook}`);
      try {
        const twilioData = await twilioService.getCallDetails(callSidFromWebhook);
        
        if (twilioData) {
          // Use Twilio phone numbers if ElevenLabs didn't provide them
          if (!phoneNumber && twilioData.from) {
            phoneNumber = twilioData.from;
          }
          if (!calledNumber && twilioData.to) {
            calledNumber = twilioData.to;
          }
          
          // Use Twilio duration if not provided
          if (!duration && twilioData.duration) {
            duration = twilioData.duration;
          }
          
          // Get recording URL from Twilio
          if (twilioData.recordingUrl) {
            recordingUrl = twilioData.recordingUrl;
          }
          
          // Store Twilio metadata
          metadata.twilioFrom = twilioData.from;
          metadata.twilioTo = twilioData.to;
          metadata.twilioStatus = twilioData.status;
          metadata.twilioDirection = twilioData.direction;
          
          console.log(`   ✅ Twilio data: from=${twilioData.from}, to=${twilioData.to}`);
        }
      } catch (twilioError: any) {
        console.warn(`   ⚠️ Twilio fetch failed: ${twilioError.message}`);
      }
    }
    
    // Store ElevenLabs metadata
    metadata.elevenLabsConversationId = params.conversationId;
    metadata.elevenLabsAgentId = params.agentId;
    metadata.elevenLabsStatus = params.status;
    metadata.elevenLabsAnalysis = params.analysis;
    metadata.syncedAt = new Date().toISOString();
    
    return {
      phoneNumber,
      calledNumber,
      duration,
      recordingUrl,
      transcript,
      aiSummary,
      classification,
      metadata
    };
  }
}

export const callSyncService = new CallSyncService();
