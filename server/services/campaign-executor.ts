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
import { ElevenLabsService } from './elevenlabs';
import { ElevenLabsPoolService } from './elevenlabs-pool';
import { BatchCallingService, BatchJob, BatchJobWithRecipients } from './batch-calling';
import { db } from '../db';
import { campaigns, contacts, calls, agents, phoneNumbers, flowExecutions, flows } from '../../shared/schema';
import { nanoid } from 'nanoid';
import { eq, inArray, sql } from 'drizzle-orm';
import { CampaignScheduler } from './campaign-scheduler';
import { webhookDeliveryService } from './webhook-delivery';
import { emailService } from './email-service';
import { 
  isConcurrencyLimitError, 
  markCampaignForRetry, 
  autoMigrateUser,
  hasAnyAvailableCapacity,
  PhoneMigrator 
} from '../engines/elevenlabs-migration';
import { PlivoBatchCallingService } from '../engines/plivo/services/plivo-batch-calling.service';
import { TwilioOpenAIBatchCallingService } from '../engines/twilio-openai/services/twilio-openai-batch-calling.service';
import { batchInsertCalls, batchInsertFlowExecutions, FlowExecutionInsert } from '../utils/batch-utils';

import * as path from 'path';
import * as fs from 'fs';

// SIP plugin is fully optional - loaded dynamically only when actually needed
// This ensures the main codebase compiles and runs without the plugin
interface ISipBatchCallingService {
  getInstance(campaignId: string): {
    executeCampaign(campaignId: string): Promise<{
      status: string;
      totalCalls: number;
      completedCalls: number;
      failedCalls: number;
    }>;
  };
}

function getSipBatchCallingService(): ISipBatchCallingService | null {
  try {
    // Build path dynamically to prevent TypeScript from resolving at compile time
    const pluginDir = path.resolve(__dirname, '..', '..', 'plugins', 'sip-engine');
    const servicePath = path.join(pluginDir, 'services', 'sip-batch-calling.service');
    
    // Check if plugin directory exists first
    if (!fs.existsSync(pluginDir)) {
      return null;
    }
    
    // Dynamic require using computed path (not a string literal TypeScript can resolve)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(servicePath);
    return module.SipBatchCallingService;
  } catch (e) {
    // SIP plugin not installed or failed to load - that's okay
    console.log('[Campaign Executor] SIP Engine plugin not available');
    return null;
  }
}

interface CallConfig {
  campaignId: string;
  userId: string; // Direct user ownership for guaranteed isolation
  contactId: string;
  agentId: string;
  phoneNumberId: string;
  voiceId: string;
  customScript?: string;
}

interface CallResult {
  callId: string;
  status: 'completed' | 'failed' | 'no-answer' | 'busy';
  duration?: number;
  transcript?: string;
  summary?: string;
  classification?: string;
  recordingUrl?: string;
  twilioCallSid?: string;
  error?: string;
}

export class CampaignExecutor {
  private activeWebSockets: Map<string, WebSocket> = new Map();

  /**
   * Pre-validate campaign before execution
   * Checks all requirements for the appropriate engine (ElevenLabs, Plivo+OpenAI, Twilio+OpenAI)
   * Returns detailed error messages if validation fails
   */
  async validateCampaign(campaignId: string): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Get campaign
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);

      if (!campaign) {
        return { valid: false, errors: ['Campaign not found'], warnings: [] };
      }

      // Check campaign status
      if (!['pending', 'draft', 'scheduled'].includes(campaign.status)) {
        errors.push(`Campaign cannot be started - current status is "${campaign.status}"`);
      }

      // Check agent
      if (!campaign.agentId) {
        errors.push('No agent assigned to this campaign. Please select an agent.');
      }

      // Check phone number
      if (!campaign.phoneNumberId) {
        errors.push('No phone number assigned to this campaign. Please select a phone number.');
      }

      // Get agent details
      let agent;
      if (campaign.agentId) {
        const [agentResult] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, campaign.agentId))
          .limit(1);
        agent = agentResult;
        
        if (!agent) {
          errors.push('Agent not found. The assigned agent may have been deleted.');
        }
      }

      // Get phone number details
      let phoneNumber;
      if (campaign.phoneNumberId) {
        const [phoneResult] = await db
          .select()
          .from(phoneNumbers)
          .where(eq(phoneNumbers.id, campaign.phoneNumberId))
          .limit(1);
        phoneNumber = phoneResult;
        
        if (!phoneNumber) {
          errors.push('Phone number not found. The assigned phone number may have been deleted.');
        }
      }

      // Check contacts
      const campaignContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.campaignId, campaignId));

      if (campaignContacts.length === 0) {
        errors.push('Campaign has no contacts. Please add at least one contact to start the campaign.');
      }

      // Engine-specific validation
      if (agent) {
        const provider = agent.telephonyProvider || 'twilio';

        if (provider === 'plivo') {
          // Plivo + OpenAI engine validation
          if (!agent.openaiCredentialId) {
            warnings.push('No OpenAI credential assigned to agent. Will use default pool.');
          }
        } else if (provider === 'twilio-openai') {
          // Twilio + OpenAI engine validation
          if (!agent.openaiCredentialId) {
            warnings.push('No OpenAI credential assigned to agent. Will use default pool.');
          }
        } else if (provider === 'elevenlabs-sip' || provider === 'fonoster-openai') {
          // SIP engine validation
          const SipBatchCallingService = getSipBatchCallingService();
          if (!SipBatchCallingService) {
            errors.push('SIP Engine plugin is not installed. Please install the sip-engine plugin to use SIP-based calling.');
          }
        } else {
          // ElevenLabs engine validation (default)
          if (!agent.elevenLabsAgentId) {
            errors.push('Agent is not synced with ElevenLabs. Please sync the agent from Agent Settings before starting the campaign.');
          }
          
          if (!agent.elevenLabsCredentialId) {
            errors.push('Agent is not assigned to an ElevenLabs API key. Please configure ElevenLabs credentials in Admin Settings.');
          }

          if (phoneNumber && !phoneNumber.elevenLabsPhoneNumberId) {
            errors.push('Phone number is not synced with ElevenLabs. Please sync your phone numbers from Admin Settings.');
          }

          // Check credential mismatch (warning, not error - we can auto-migrate)
          if (phoneNumber && agent.elevenLabsCredentialId && 
              phoneNumber.elevenLabsCredentialId && 
              phoneNumber.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
            warnings.push('Phone number and agent use different ElevenLabs credentials. The system will attempt auto-migration which may take a moment.');
          }
        }
      }

      return { 
        valid: errors.length === 0, 
        errors, 
        warnings 
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown validation error';
      return { valid: false, errors: [`Validation error: ${errorMessage}`], warnings: [] };
    }
  }

  /**
   * Execute a campaign using ElevenLabs Batch Calling API
   * 
   * This creates a single batch job with all contacts instead of queuing individual calls.
   * ElevenLabs handles the orchestration, rate limiting, and parallel execution.
   */
  async executeCampaign(campaignId: string): Promise<{ batchJob: BatchJob }> {
    try {
      // Get campaign details
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);

      if (!campaign) {
        throw new Error('Campaign not found');
      }

      if (campaign.status !== 'pending' && campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        throw new Error('Campaign is already running or completed');
      }

      // Validate campaign has required fields
      if (!campaign.agentId) {
        throw new Error('Campaign has no agent configured');
      }
      if (!campaign.phoneNumberId) {
        throw new Error('Campaign has no phone number configured');
      }

      // Get agent details
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, campaign.agentId))
        .limit(1);

      if (!agent) {
        throw new Error('Agent not found');
      }

      // Route to Plivo engine if agent uses Plivo telephony
      if (agent.telephonyProvider === 'plivo') {
        console.log(`📞 [Campaign Executor] Routing to Plivo + OpenAI engine for campaign ${campaignId}`);
        
        // Get all contacts for the campaign
        const campaignContacts = await db
          .select()
          .from(contacts)
          .where(eq(contacts.campaignId, campaignId));

        if (campaignContacts.length === 0) {
          throw new Error('Campaign has no contacts');
        }

        // Get campaign phone number for fromNumber
        const [campaignPhoneNumber] = await db
          .select()
          .from(phoneNumbers)
          .where(eq(phoneNumbers.id, campaign.phoneNumberId!))
          .limit(1);

        if (!campaignPhoneNumber) {
          throw new Error('Campaign phone number not found');
        }

        // Store Plivo-specific batch job ID for tracking
        const plivoBatchJobId = `plivo-${campaignId}`;
        
        // Update campaign status to 'running' and set startedAt BEFORE execution
        await db
          .update(campaigns)
          .set({
            status: 'running',
            startedAt: new Date(),
            batchJobId: plivoBatchJobId,
            batchJobStatus: 'running',
            totalContacts: campaignContacts.length,
          })
          .where(eq(campaigns.id, campaignId));

        // PRE-CREATE CALL RECORDS using batch insert for scalability (10,000+ contacts)
        const callInserts = campaignContacts.map(contact => ({
          userId: campaign.userId,
          campaignId: campaign.id,
          contactId: contact.id,
          phoneNumber: contact.phone,
          fromNumber: campaignPhoneNumber.phoneNumber,
          toNumber: contact.phone,
          status: 'pending' as const,
          callDirection: 'outgoing' as const,
          metadata: {
            batchCall: true,
            batchJobId: plivoBatchJobId,
            agentId: agent.id,
            telephonyProvider: 'plivo',
            contactName: `${contact.firstName} ${contact.lastName || ''}`.trim(),
          },
        }));

        const callResult = await batchInsertCalls(callInserts, '📞 [Plivo Campaign]');
        const preCreatedCalls = callResult.results;
        
        // Create flow execution records for flow-based agents using batch insert
        if (agent.flowId && preCreatedCalls.length > 0) {
          const flowExecInserts: FlowExecutionInsert[] = preCreatedCalls.map(callRecord => ({
            callId: callRecord.id,
            flowId: agent.flowId!,
            campaignId: campaign.id,
            campaignName: campaign.name,
            contactPhone: callRecord.phoneNumber || '',
            telephonyProvider: 'plivo',
          }));
          
          await batchInsertFlowExecutions(flowExecInserts, '🔀 [Plivo Campaign]');
        }
        
        const plivoBatchService = PlivoBatchCallingService.getInstance(campaignId);
        const result = await plivoBatchService.executeCampaign(campaignId);
        
        // Trigger campaign.completed webhook for Plivo campaigns
        if (campaign.userId && result.status === 'completed') {
          const campaignContacts = await db
            .select()
            .from(contacts)
            .where(eq(contacts.campaignId, campaignId));
          
          webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.completed', {
            campaign: {
              id: campaign.id,
              name: campaign.name,
              type: campaign.type,
              status: 'completed',
              totalContacts: result.totalCalls,
              startedAt: campaign.startedAt,
              completedAt: new Date().toISOString(),
              createdAt: campaign.createdAt,
            },
            stats: {
              successfulCalls: result.completedCalls,
              failedCalls: result.failedCalls,
              totalCalls: result.totalCalls,
              completedCalls: result.completedCalls + result.failedCalls,
            },
            contacts: campaignContacts.map(c => ({
              id: c.id,
              firstName: c.firstName,
              lastName: c.lastName,
              phone: c.phone,
              email: c.email,
              status: c.status,
            })),
          }, campaignId).catch(err => {
            console.error('❌ [Webhook] Error triggering campaign.completed event:', err);
          });
          
          // Send campaign completed email
          try {
            await emailService.sendCampaignCompleted(campaignId);
          } catch (emailError: any) {
            console.error(`❌ [Campaign] Failed to send campaign completed email:`, emailError);
          }
        }
        
        // Return a compatible BatchJob object for API consistency
        return {
          batchJob: {
            id: plivoBatchJobId,
            name: campaign.name,
            agent_id: agent.id,
            agent_name: agent.name,
            created_at_unix: Math.floor(Date.now() / 1000),
            scheduled_time_unix: 0,
            last_updated_at_unix: Math.floor(Date.now() / 1000),
            total_calls_scheduled: result.totalCalls,
            total_calls_dispatched: result.completedCalls + result.failedCalls,
            status: result.status === 'completed' ? 'completed' as const : 
                   result.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
          }
        };
      }

      // Route to Twilio-OpenAI engine if agent uses twilio-openai telephony
      if (agent.telephonyProvider === 'twilio-openai') {
        console.log(`📞 [Campaign Executor] Routing to Twilio + OpenAI engine for campaign ${campaignId}`);
        
        const campaignContacts = await db
          .select()
          .from(contacts)
          .where(eq(contacts.campaignId, campaignId));

        if (campaignContacts.length === 0) {
          throw new Error('Campaign has no contacts');
        }

        // Get campaign phone number for fromNumber
        const [campaignPhoneNumberTwilioOpenAI] = await db
          .select()
          .from(phoneNumbers)
          .where(eq(phoneNumbers.id, campaign.phoneNumberId!))
          .limit(1);

        if (!campaignPhoneNumberTwilioOpenAI) {
          throw new Error('Campaign phone number not found');
        }

        const twilioOpenAIBatchJobId = `twilio-openai-${campaignId}`;
        
        await db
          .update(campaigns)
          .set({
            status: 'running',
            startedAt: new Date(),
            batchJobId: twilioOpenAIBatchJobId,
            batchJobStatus: 'running',
            totalContacts: campaignContacts.length,
          })
          .where(eq(campaigns.id, campaignId));

        // PRE-CREATE CALL RECORDS using batch insert for scalability (10,000+ contacts)
        const callInsertsTwilioOpenAI = campaignContacts.map(contact => ({
          userId: campaign.userId,
          campaignId: campaign.id,
          contactId: contact.id,
          phoneNumber: contact.phone,
          fromNumber: campaignPhoneNumberTwilioOpenAI.phoneNumber,
          toNumber: contact.phone,
          status: 'pending' as const,
          callDirection: 'outgoing' as const,
          metadata: {
            batchCall: true,
            batchJobId: twilioOpenAIBatchJobId,
            agentId: agent.id,
            telephonyProvider: 'twilio-openai',
            contactName: `${contact.firstName} ${contact.lastName || ''}`.trim(),
          },
        }));

        const callResultTwilioOpenAI = await batchInsertCalls(callInsertsTwilioOpenAI, '📞 [Twilio-OpenAI Campaign]');
        const preCreatedCalls = callResultTwilioOpenAI.results;
        
        // Create flow execution records for flow-based agents using batch insert
        if (agent.flowId && preCreatedCalls.length > 0) {
          const flowExecInsertsTwilioOpenAI: FlowExecutionInsert[] = preCreatedCalls.map(callRecord => ({
            callId: callRecord.id,
            flowId: agent.flowId!,
            campaignId: campaign.id,
            campaignName: campaign.name,
            contactPhone: callRecord.phoneNumber || '',
            telephonyProvider: 'twilio-openai',
          }));
          
          await batchInsertFlowExecutions(flowExecInsertsTwilioOpenAI, '🔀 [Twilio-OpenAI Campaign]');
        }
        
        const twilioOpenAIBatchService = TwilioOpenAIBatchCallingService.getInstance(campaignId);
        const result = await twilioOpenAIBatchService.executeCampaign(campaignId);
        
        if (campaign.userId && result.status === 'completed') {
          const finalContacts = await db
            .select()
            .from(contacts)
            .where(eq(contacts.campaignId, campaignId));
          
          webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.completed', {
            campaign: {
              id: campaign.id,
              name: campaign.name,
              type: campaign.type,
              status: 'completed',
              totalContacts: result.totalCalls,
              startedAt: campaign.startedAt,
              completedAt: new Date().toISOString(),
              createdAt: campaign.createdAt,
            },
            stats: {
              successfulCalls: result.completedCalls,
              failedCalls: result.failedCalls,
              totalCalls: result.totalCalls,
              completedCalls: result.completedCalls + result.failedCalls,
            },
            contacts: finalContacts.map(c => ({
              id: c.id,
              firstName: c.firstName,
              lastName: c.lastName,
              phone: c.phone,
              email: c.email,
              status: c.status,
            })),
          }, campaignId).catch(err => {
            console.error('❌ [Webhook] Error triggering campaign.completed event:', err);
          });
          
          try {
            await emailService.sendCampaignCompleted(campaignId);
          } catch (emailError: any) {
            console.error(`❌ [Campaign] Failed to send campaign completed email:`, emailError);
          }
        }
        
        return {
          batchJob: {
            id: twilioOpenAIBatchJobId,
            name: campaign.name,
            agent_id: agent.id,
            agent_name: agent.name,
            created_at_unix: Math.floor(Date.now() / 1000),
            scheduled_time_unix: 0,
            last_updated_at_unix: Math.floor(Date.now() / 1000),
            total_calls_scheduled: result.totalCalls,
            total_calls_dispatched: result.completedCalls + result.failedCalls,
            status: result.status === 'completed' ? 'completed' as const : 
                   result.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
          }
        };
      }

      // Route to SIP engines (elevenlabs-sip or fonoster-openai)
      if (agent.telephonyProvider === 'elevenlabs-sip' || agent.telephonyProvider === 'fonoster-openai') {
        const sipEngine = agent.telephonyProvider as 'elevenlabs-sip' | 'fonoster-openai';
        console.log(`📞 [Campaign Executor] Routing to ${sipEngine} SIP engine for campaign ${campaignId}`);
        
        // Check if SIP plugin is installed (loaded dynamically)
        const SipBatchCallingService = getSipBatchCallingService();
        if (!SipBatchCallingService) {
          throw new Error('SIP Engine plugin is not installed. Please install the sip-engine plugin to use SIP-based calling.');
        }
        
        const campaignContacts = await db
          .select()
          .from(contacts)
          .where(eq(contacts.campaignId, campaignId));

        if (campaignContacts.length === 0) {
          throw new Error('Campaign has no contacts');
        }

        const sipBatchJobId = `${sipEngine}-${campaignId}`;
        
        await db
          .update(campaigns)
          .set({
            status: 'running',
            startedAt: new Date(),
            batchJobId: sipBatchJobId,
            batchJobStatus: 'running',
            totalContacts: campaignContacts.length,
          })
          .where(eq(campaigns.id, campaignId));

        console.log(`📞 [Campaign Executor] Starting ${sipEngine} batch calling for ${campaignContacts.length} contacts`);
        
        const sipBatchService = SipBatchCallingService.getInstance(campaignId);
        const result = await sipBatchService.executeCampaign(campaignId);
        
        // Trigger campaign.completed webhook for SIP campaigns
        if (campaign.userId && result.status === 'completed') {
          webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.completed', {
            campaign: {
              id: campaign.id,
              name: campaign.name,
              type: campaign.type,
              status: 'completed',
              totalContacts: result.totalCalls,
              startedAt: campaign.startedAt,
              completedAt: new Date().toISOString(),
              createdAt: campaign.createdAt,
            },
            stats: {
              successfulCalls: result.completedCalls,
              failedCalls: result.failedCalls,
              totalCalls: result.totalCalls,
              completedCalls: result.completedCalls + result.failedCalls,
            },
          }, campaignId).catch(err => {
            console.error('❌ [Webhook] Error triggering campaign.completed event:', err);
          });
          
          try {
            await emailService.sendCampaignCompleted(campaignId);
          } catch (emailError: any) {
            console.error(`❌ [Campaign] Failed to send campaign completed email:`, emailError);
          }
        }
        
        return {
          batchJob: {
            id: sipBatchJobId,
            name: campaign.name,
            agent_id: agent.id,
            agent_name: agent.name,
            created_at_unix: Math.floor(Date.now() / 1000),
            scheduled_time_unix: 0,
            last_updated_at_unix: Math.floor(Date.now() / 1000),
            total_calls_scheduled: result.totalCalls,
            total_calls_dispatched: result.completedCalls + result.failedCalls,
            status: result.status === 'completed' ? 'completed' as const : 
                   result.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
          }
        };
      }

      // ElevenLabs flow - requires elevenLabsAgentId
      if (!agent.elevenLabsAgentId) {
        throw new Error('Agent not synced with ElevenLabs. Please sync the agent first.');
      }

      // Get phone number details
      const [phoneNumber] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, campaign.phoneNumberId))
        .limit(1);

      if (!phoneNumber) {
        throw new Error('Phone number not found');
      }

      if (!phoneNumber.elevenLabsPhoneNumberId) {
        throw new Error('Phone number not synced with ElevenLabs. Please sync your phone numbers first.');
      }

      // Get the correct credential for this agent
      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        throw new Error("No ElevenLabs credential found for agent");
      }
      
      // PRE-FLIGHT CHECK: Ensure phone number is on the same ElevenLabs credential as the agent
      // If credentials differ, migrate the phone number to the agent's credential before batch calling
      let currentPhoneElevenLabsId = phoneNumber.elevenLabsPhoneNumberId;
      
      // Guard: both phone and agent must have credentials defined for migration check
      if (!agent.elevenLabsCredentialId) {
        throw new Error('Agent is not assigned to an ElevenLabs credential. Please configure ElevenLabs credentials in admin settings.');
      }
      
      if (!phoneNumber.elevenLabsCredentialId) {
        throw new Error('Phone number is not assigned to an ElevenLabs credential. Please re-sync phone numbers.');
      }
      
      if (phoneNumber.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
        console.log(`📞 [Campaign Executor] Phone credential mismatch - initiating migration`);
        console.log(`   Phone credential: ${phoneNumber.elevenLabsCredentialId}`);
        console.log(`   Agent credential: ${agent.elevenLabsCredentialId}`);
        
        const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
          phoneNumber.id,
          agent.id
        );
        
        if (!migrationResult.success) {
          throw new Error(`Phone migration failed: ${migrationResult.error}`);
        }
        
        if (!migrationResult.newElevenLabsPhoneId) {
          throw new Error('Phone migration incomplete: no new ElevenLabs phone ID returned');
        }
        
        console.log(`✅ [Campaign Executor] Phone migrated successfully`);
        console.log(`   Old ElevenLabs ID: ${migrationResult.oldElevenLabsPhoneId}`);
        console.log(`   New ElevenLabs ID: ${migrationResult.newElevenLabsPhoneId}`);
        
        currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;
      } else {
        console.log(`✅ [Campaign Executor] Phone and agent on same credential: ${agent.elevenLabsCredentialId}`);
      }
      
      // PRE-FLIGHT CHECK 2: Verify phone actually exists on ElevenLabs
      // The database may have a stale elevenLabsPhoneNumberId that no longer exists
      console.log(`📞 [Campaign Executor] Verifying phone exists on ElevenLabs...`);
      const verifyResult = await PhoneMigrator.verifyAndEnsurePhoneExists(
        phoneNumber.id,
        agent.elevenLabsCredentialId,
        agent.elevenLabsAgentId || undefined // Pass agent ID for assignment after re-import
      );
      
      if (!verifyResult.success) {
        throw new Error(`Phone number not available on ElevenLabs: ${verifyResult.error || 'Could not verify or re-import phone number'}`);
      }
      
      if (verifyResult.wasReimported) {
        console.log(`✅ [Campaign Executor] Phone was re-imported from Twilio`);
        console.log(`   New ElevenLabs ID: ${verifyResult.elevenLabsPhoneId}`);
      }
      
      // Use the verified (or re-imported) phone ID
      currentPhoneElevenLabsId = verifyResult.elevenLabsPhoneId!;

      // Get all contacts for the campaign
      const campaignContacts = await db
        .select()
        .from(contacts)
        .where(eq(contacts.campaignId, campaignId));

      if (campaignContacts.length === 0) {
        throw new Error('Campaign has no contacts');
      }

      console.log(`[Campaign Executor] Creating batch job for campaign ${campaignId} with ${campaignContacts.length} contacts`);
      console.log(`   Agent: ${agent.name} (ElevenLabs ID: ${agent.elevenLabsAgentId})`);
      console.log(`   Phone: ${phoneNumber.phoneNumber} (ElevenLabs ID: ${currentPhoneElevenLabsId})`);
      console.log(`   Credential: ${credential.name}`);

      // PRE-CREATE CALL RECORDS using batch insert for scalability (10,000+ contacts)
      const callInsertsElevenLabs = campaignContacts.map(contact => ({
        userId: campaign.userId,
        campaignId: campaign.id,
        contactId: contact.id,
        phoneNumber: contact.phone,
        status: 'pending' as const,
        callDirection: 'outgoing' as const,
        metadata: {
          batchCall: true,
          agentId: agent.id,
          elevenLabsAgentId: agent.elevenLabsAgentId,
          contactName: `${contact.firstName} ${contact.lastName || ''}`.trim(),
        },
      }));

      const callResultElevenLabs = await batchInsertCalls(callInsertsElevenLabs, '📞 [ElevenLabs Campaign]');
      const preCreatedCalls = callResultElevenLabs.results;

      // Create flow execution records for flow-based agents using batch insert
      if (agent.flowId && preCreatedCalls.length > 0) {
        const flowExecInsertsElevenLabs: FlowExecutionInsert[] = preCreatedCalls.map(callRecord => ({
          callId: callRecord.id,
          flowId: agent.flowId!,
          campaignId: campaign.id,
          campaignName: campaign.name,
          contactPhone: callRecord.phoneNumber || '',
          telephonyProvider: 'elevenlabs',
        }));
        
        await batchInsertFlowExecutions(flowExecInsertsElevenLabs, '🔀 [ElevenLabs Campaign]');
      }

      // Convert contacts to batch recipients format
      const recipients = BatchCallingService.contactsToBatchRecipients(
        campaignContacts.map(c => ({
          firstName: c.firstName,
          lastName: c.lastName,
          phone: c.phone,
          email: c.email,
          customFields: c.customFields as Record<string, any> | null,
        }))
      );

      // Create batch calling service with agent's credential
      const batchService = new BatchCallingService(credential.apiKey);

      // Calculate scheduled time if campaign has scheduling enabled
      let scheduledTimeUnix: number | undefined;
      if (campaign.scheduleEnabled) {
        const nextWindow = CampaignScheduler.getNextCallWindow(campaign);
        if (nextWindow) {
          scheduledTimeUnix = Math.floor(nextWindow.getTime() / 1000);
          console.log(`   Scheduled for: ${nextWindow.toISOString()}`);
        }
      }

      // Create the batch job with verified/migrated phone number
      const batchJob = await batchService.createBatch({
        call_name: campaign.name,
        agent_id: agent.elevenLabsAgentId,
        recipients: recipients,
        agent_phone_number_id: currentPhoneElevenLabsId,
        scheduled_time_unix: scheduledTimeUnix || null,
      });

      console.log(`✅ [Campaign Executor] Batch job created: ${batchJob.id}`);
      console.log(`   Status: ${batchJob.status}`);
      console.log(`   Total calls scheduled: ${batchJob.total_calls_scheduled}`);
      
      // Update pre-created call records with batch job ID for tracking
      if (preCreatedCalls.length > 0) {
        const callIds = preCreatedCalls.map(c => c.id);
        await db
          .update(calls)
          .set({
            metadata: sql`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{batchJobId}', ${JSON.stringify(batchJob.id)}::jsonb)`
          })
          .where(inArray(calls.id, callIds));
        console.log(`   Updated ${callIds.length} call records with batch job ID`);
      }

      // Update campaign with batch job ID and status
      await db
        .update(campaigns)
        .set({ 
          status: 'running',
          startedAt: new Date(),
          batchJobId: batchJob.id,
          batchJobStatus: batchJob.status,
          totalContacts: campaignContacts.length,
        })
        .where(eq(campaigns.id, campaignId));

      return { batchJob };

    } catch (error) {
      console.error('Campaign execution failed:', error);
      
      // Check if this is a concurrency limit error from ElevenLabs
      if (isConcurrencyLimitError(error)) {
        console.log(`🔄 [Campaign Executor] Concurrency limit hit, attempting migration for campaign ${campaignId}`);
        
        // Get the agent's current credential to attempt migration from
        const [campaignData] = await db
          .select()
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        
        if (campaignData?.agentId) {
          const [agentData] = await db
            .select()
            .from(agents)
            .where(eq(agents.id, campaignData.agentId))
            .limit(1);
          
          if (agentData?.elevenLabsCredentialId) {
            // Check if any other key has capacity
            const hasCapacity = await hasAnyAvailableCapacity();
            
            if (hasCapacity) {
              // Attempt automatic migration
              const migrationResult = await autoMigrateUser(
                campaignData.userId,
                agentData.elevenLabsCredentialId
              );
              
              if (migrationResult.success) {
                console.log(`✅ [Campaign Executor] Migration successful, retrying campaign...`);
                // Retry the campaign execution after migration
                return this.executeCampaign(campaignId);
              } else {
                console.log(`❌ [Campaign Executor] Migration failed: ${migrationResult.error}`);
              }
            }
            
            // No capacity available or migration failed - mark for retry queue
            console.log(`⏰ [Campaign Executor] No capacity available, marking campaign for retry queue`);
            await markCampaignForRetry(
              campaignId,
              'ElevenLabs concurrency limit reached - no available capacity'
            );
            
            // Don't throw - campaign is now in processing state waiting for retry
            // Return a minimal BatchJob object indicating the campaign is queued for retry
            return { 
              batchJob: { 
                id: 'pending-migration',
                name: 'Awaiting Capacity',
                agent_id: '',
                created_at_unix: Math.floor(Date.now() / 1000),
                scheduled_time_unix: 0,
                last_updated_at_unix: Math.floor(Date.now() / 1000),
                total_calls_scheduled: 0,
                total_calls_dispatched: 0,
                status: 'pending' as const,
                agent_name: '',
              } 
            };
          }
        }
      }
      
      // Not a concurrency error or couldn't handle - mark as failed
      // Get campaign data for webhook if available
      let failedCampaign;
      try {
        const [campaignForWebhook] = await db
          .select()
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        failedCampaign = campaignForWebhook;
      } catch (e) {
        console.warn('Could not fetch campaign for failure webhook:', e);
      }
      
      // Extract error details for storage and webhook
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = this.getErrorCode(errorMessage);
      
      // Save error message to database so users can see why campaign failed
      await db
        .update(campaigns)
        .set({ 
          status: 'failed',
          completedAt: new Date(),
          errorMessage: errorMessage,
          errorCode: errorCode,
        })
        .where(eq(campaigns.id, campaignId));
      
      console.error(`❌ [Campaign Executor] Campaign ${campaignId} failed with error: [${errorCode}] ${errorMessage}`);
      
      // Trigger campaign.failed webhook
      if (failedCampaign?.userId) {
        try {
          webhookDeliveryService.triggerEvent(failedCampaign.userId, 'campaign.failed', {
            campaignId: failedCampaign.id,
            campaignName: failedCampaign.name,
            status: 'failed',
            startedAt: failedCampaign.startedAt,
            failedAt: new Date().toISOString(),
            totalContacts: failedCampaign.totalContacts,
            completedCalls: failedCampaign.completedCalls || 0,
            failedCalls: failedCampaign.failedCalls || 0,
            error: {
              code: errorCode,
              message: errorMessage,
              details: null
            }
          }, campaignId).catch(err => {
            console.error('❌ [Webhook] Error triggering campaign.failed event:', err);
          });
        } catch (webhookErr) {
          console.error('Error triggering campaign.failed webhook:', webhookErr);
        }
      }
      
      throw error;
    }
  }

  /**
   * Get batch job status for a campaign
   */
  async getBatchJobStatus(campaignId: string): Promise<BatchJobWithRecipients | null> {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign || !campaign.batchJobId || !campaign.agentId) {
      return null;
    }

    // Get agent to find the credential
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, campaign.agentId))
      .limit(1);

    if (!agent) {
      return null;
    }

    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      return null;
    }

    const batchService = new BatchCallingService(credential.apiKey);
    const batchJob = await batchService.getBatch(campaign.batchJobId);

    // Update campaign with latest batch status
    await db
      .update(campaigns)
      .set({ 
        batchJobStatus: batchJob.status,
        completedCalls: batchJob.total_calls_dispatched,
      })
      .where(eq(campaigns.id, campaignId));

    // If batch is completed or failed, update campaign status
    if (batchJob.status === 'completed' || batchJob.status === 'failed' || batchJob.status === 'cancelled') {
      // Recalculate stats from actual database records for accuracy
      const campaignCalls = await db.select().from(calls).where(eq(calls.campaignId, campaignId));
      
      const completedCallsCount = campaignCalls.filter(c => 
        ['completed', 'failed', 'busy', 'no-answer'].includes(c.status)
      ).length;
      
      const successfulCallsCount = campaignCalls.filter(c => c.status === 'completed').length;
      const failedCallsCount = campaignCalls.filter(c => 
        ['failed', 'busy', 'no-answer'].includes(c.status)
      ).length;
      
      await db
        .update(campaigns)
        .set({ 
          status: batchJob.status === 'completed' ? 'completed' : batchJob.status,
          completedAt: new Date(),
          completedCalls: completedCallsCount,
          successfulCalls: successfulCallsCount,
          failedCalls: failedCallsCount,
        })
        .where(eq(campaigns.id, campaignId));
      
      // Trigger campaign.failed webhook if batch job failed
      if (campaign.userId && batchJob.status === 'failed') {
        try {
          webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.failed', {
            campaignId: campaign.id,
            campaignName: campaign.name,
            status: 'failed',
            startedAt: campaign.startedAt,
            failedAt: new Date().toISOString(),
            totalContacts: campaign.totalContacts,
            completedCalls: completedCallsCount,
            failedCalls: failedCallsCount,
            error: {
              code: 'BATCH_JOB_FAILED',
              message: 'Batch calling job failed during execution',
              details: { batchJobId: campaign.batchJobId }
            }
          }, campaignId).catch(err => {
            console.error('❌ [Webhook] Error triggering campaign.failed event:', err);
          });
        } catch (webhookErr) {
          console.error('Error triggering campaign.failed webhook:', webhookErr);
        }
      }
      
      if (campaign.userId && batchJob.status === 'completed') {
        // Fetch contacts for this campaign
        const campaignContacts = await db
          .select()
          .from(contacts)
          .where(eq(contacts.campaignId, campaignId));
        
        // Build contact lookup map
        const contactMap = new Map(campaignContacts.map(c => [c.id, c]));
        
        // Build rich call data with all details
        const callsData = campaignCalls.map(call => {
          const contact = call.contactId ? contactMap.get(call.contactId) : null;
          return {
            id: call.id,
            status: call.status,
            classification: call.classification,
            sentiment: call.sentiment,
            duration: call.duration,
            phoneNumber: call.phoneNumber,
            transcript: call.transcript,
            aiSummary: call.aiSummary,
            recordingUrl: call.recordingUrl,
            startedAt: call.startedAt,
            endedAt: call.endedAt,
            contact: contact ? {
              id: contact.id,
              firstName: contact.firstName,
              lastName: contact.lastName,
              phone: contact.phone,
              email: contact.email,
              customFields: contact.customFields,
            } : null,
          };
        });
        
        // Build rich contacts data
        const contactsData = campaignContacts.map(contact => ({
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
          email: contact.email,
          customFields: contact.customFields,
          status: contact.status,
        }));
        
        webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.completed', {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            type: campaign.type,
            status: 'completed',
            totalContacts: campaign.totalContacts,
            startedAt: campaign.startedAt,
            completedAt: new Date().toISOString(),
            createdAt: campaign.createdAt,
          },
          stats: {
            successfulCalls: successfulCallsCount,
            failedCalls: failedCallsCount,
            totalCalls: campaignCalls.length,
            completedCalls: completedCallsCount,
            hotLeads: campaignCalls.filter(c => c.classification === 'hot').length,
            warmLeads: campaignCalls.filter(c => c.classification === 'warm').length,
            coldLeads: campaignCalls.filter(c => c.classification === 'cold').length,
            lostLeads: campaignCalls.filter(c => c.classification === 'lost').length,
          },
          calls: callsData,
          contacts: contactsData,
        }, campaignId).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.completed event:', err);
        });
        
        // Send campaign completed email notification
        try {
          await emailService.sendCampaignCompleted(campaignId);
          console.log(`✅ [Campaign] Campaign completed email sent for campaign ${campaignId}`);
        } catch (emailError: any) {
          console.error(`❌ [Campaign] Failed to send campaign completed email:`, emailError);
        }
      }
    }

    return batchJob;
  }

  /**
   * Pause a running campaign's batch job
   * Uses ElevenLabs cancel API but keeps status as 'paused' so it can be resumed
   */
  async pauseCampaign(campaignId: string, reason: 'manual' | 'scheduled' = 'manual'): Promise<BatchJob | null> {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign || !campaign.agentId) {
      throw new Error('Campaign has no agent configured');
    }

    // Get agent to check telephony provider
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, campaign.agentId))
      .limit(1);

    if (!agent) {
      throw new Error('Agent not found');
    }

    // Route to Plivo engine if agent uses Plivo telephony
    if (agent.telephonyProvider === 'plivo') {
      const plivoBatchService = PlivoBatchCallingService.getInstance(campaignId);
      plivoBatchService.pause();
      
      await db
        .update(campaigns)
        .set({ 
          status: 'paused',
          batchJobStatus: 'paused',
          config: sql`jsonb_set(COALESCE(config, '{}'::jsonb), '{pauseReason}', ${JSON.stringify(reason)}::jsonb)`
        })
        .where(eq(campaigns.id, campaignId));
      
      console.log(`⏸️ [Campaign Executor] Paused Plivo campaign ${campaignId} (reason: ${reason})`);
      
      // Trigger webhook event for Plivo pause
      if (campaign.userId) {
        webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.paused', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          pausedAt: new Date().toISOString(),
          reason,
          engine: 'plivo',
        }, campaignId).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.paused event:', err);
        });
      }
      
      return null;
    }

    // ElevenLabs flow - requires batchJobId
    if (!campaign.batchJobId) {
      throw new Error('Campaign has no active batch job');
    }

    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      throw new Error('No ElevenLabs credential found for agent');
    }

    const batchService = new BatchCallingService(credential.apiKey);
    
    try {
      const batchJob = await batchService.cancelBatch(campaign.batchJobId);
      console.log(`⏸️ [Campaign Executor] Paused campaign ${campaignId} (reason: ${reason})`);

      // Update campaign status to 'paused' (NOT cancelled - so it can be resumed)
      await db
        .update(campaigns)
        .set({ 
          status: 'paused',
          batchJobStatus: 'cancelled',
          config: sql`jsonb_set(COALESCE(config, '{}'::jsonb), '{pauseReason}', ${JSON.stringify(reason)}::jsonb)`
        })
        .where(eq(campaigns.id, campaignId));

      // Trigger webhook event
      if (campaign.userId) {
        webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.paused', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            completedCalls: campaign.completedCalls,
            successfulCalls: campaign.successfulCalls,
            failedCalls: campaign.failedCalls,
          },
          pausedAt: new Date().toISOString(),
          reason,
          batchJobStatus: batchJob.status,
        }, campaignId).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.paused event:', err);
        });
      }

      return batchJob;
    } catch (error: any) {
      console.error(`❌ [Campaign Executor] Failed to pause campaign ${campaignId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel a running campaign's batch job (permanent stop)
   */
  async cancelCampaign(campaignId: string): Promise<BatchJob | null> {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign || !campaign.agentId) {
      throw new Error('Campaign has no agent configured');
    }

    // Get agent to check telephony provider
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, campaign.agentId))
      .limit(1);

    if (!agent) {
      throw new Error('Agent not found');
    }

    // Route to Plivo engine if agent uses Plivo telephony
    if (agent.telephonyProvider === 'plivo') {
      const plivoBatchService = PlivoBatchCallingService.getInstance(campaignId);
      await plivoBatchService.cancel();
      
      // Query current stats from database for accurate webhook payload
      const campaignCalls = await db.select().from(calls).where(eq(calls.campaignId, campaignId));
      const completedCallsCount = campaignCalls.filter(c => 
        ['completed', 'failed', 'busy', 'no-answer'].includes(c.status)
      ).length;
      const successfulCallsCount = campaignCalls.filter(c => c.status === 'completed').length;
      const failedCallsCount = campaignCalls.filter(c => 
        ['failed', 'busy', 'no-answer'].includes(c.status)
      ).length;
      
      await db
        .update(campaigns)
        .set({ 
          status: 'cancelled',
          batchJobStatus: 'cancelled',
          completedAt: new Date(),
          completedCalls: completedCallsCount,
          successfulCalls: successfulCallsCount,
          failedCalls: failedCallsCount,
        })
        .where(eq(campaigns.id, campaignId));
      
      console.log(`🛑 [Campaign Executor] Cancelled Plivo campaign ${campaignId}`);
      
      // Trigger webhook event for Plivo campaign cancellation
      if (campaign.userId) {
        webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.cancelled', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
            startedAt: campaign.startedAt,
            cancelledAt: new Date().toISOString(),
            createdAt: campaign.createdAt,
          },
          stats: {
            completedCalls: completedCallsCount,
            successfulCalls: successfulCallsCount,
            failedCalls: failedCallsCount,
            totalCalls: campaignCalls.length,
          },
          cancelledAt: new Date().toISOString(),
          engine: 'plivo',
        }, campaignId).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.cancelled event:', err);
        });
      }
      
      PlivoBatchCallingService.removeInstance(campaignId);
      return null;
    }

    // ElevenLabs flow - requires batchJobId
    if (!campaign.batchJobId) {
      throw new Error('Campaign has no active batch job');
    }

    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      throw new Error('No ElevenLabs credential found for agent');
    }

    const batchService = new BatchCallingService(credential.apiKey);
    const batchJob = await batchService.cancelBatch(campaign.batchJobId);
    console.log(`🛑 [Campaign Executor] Cancelled campaign ${campaignId}`);

    // Update campaign status
    await db
      .update(campaigns)
      .set({ 
        status: 'cancelled',
        batchJobStatus: 'cancelled',
        completedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    return batchJob;
  }

  /**
   * Resume a paused campaign or retry failed calls
   * Uses ElevenLabs retry API to continue with pending/failed/no-response recipients
   */
  async resumeCampaign(campaignId: string, reason: 'manual' | 'scheduled' = 'manual'): Promise<BatchJob | null> {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign || !campaign.agentId) {
      throw new Error('Campaign has no agent configured');
    }

    // Only allow resuming paused or completed/failed campaigns (for retry)
    if (campaign.status !== 'paused' && campaign.status !== 'completed' && campaign.status !== 'failed') {
      throw new Error(`Campaign status '${campaign.status}' cannot be resumed. Must be paused, completed, or failed.`);
    }

    // Get agent to check telephony provider
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, campaign.agentId))
      .limit(1);

    if (!agent) {
      throw new Error('Agent not found');
    }

    // Route to Plivo engine if agent uses Plivo telephony
    if (agent.telephonyProvider === 'plivo') {
      // For Plivo, resume means re-executing the campaign with pending contacts
      const plivoBatchService = PlivoBatchCallingService.getInstance(campaignId);
      
      // If paused, just resume; if completed/failed, re-execute
      if (plivoBatchService.isRunning() === false) {
        plivoBatchService.resume();
      }
      
      // Update campaign status to running BEFORE re-execution, clear completedAt, add resumeReason
      await db
        .update(campaigns)
        .set({ 
          status: 'running',
          batchJobStatus: 'running',
          completedAt: null,
          config: sql`jsonb_set(COALESCE(config, '{}'::jsonb), '{resumeReason}', ${JSON.stringify(reason)}::jsonb)`
        })
        .where(eq(campaigns.id, campaignId));
      
      // Re-execute the campaign (it will pick up pending contacts)
      const result = await plivoBatchService.executeCampaign(campaignId);
      
      console.log(`▶️ [Campaign Executor] Resumed Plivo campaign ${campaignId} (reason: ${reason})`);
      
      // Trigger webhook event for Plivo resume
      if (campaign.userId) {
        webhookDeliveryService.triggerEvent(campaign.userId, 'campaign.resumed', {
          campaign: { 
            id: campaign.id, 
            name: campaign.name,
            type: campaign.type,
            totalContacts: campaign.totalContacts,
          },
          resumedAt: new Date().toISOString(),
          reason,
          engine: 'plivo',
        }, campaignId).catch(err => {
          console.error('❌ [Webhook] Error triggering campaign.resumed event:', err);
        });
      }
      
      return {
        id: campaignId,
        name: campaign.name,
        agent_id: agent.id,
        agent_name: agent.name,
        created_at_unix: Math.floor(Date.now() / 1000),
        scheduled_time_unix: 0,
        last_updated_at_unix: Math.floor(Date.now() / 1000),
        total_calls_scheduled: result.totalCalls,
        total_calls_dispatched: result.completedCalls + result.failedCalls,
        status: result.status === 'completed' ? 'completed' as const : 
               result.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
      };
    }

    // ElevenLabs flow - requires batchJobId
    if (!campaign.batchJobId) {
      throw new Error('Campaign has no batch job to resume');
    }

    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      throw new Error('No ElevenLabs credential found for agent');
    }

    const batchService = new BatchCallingService(credential.apiKey);
    
    try {
      const batchJob = await batchService.retryBatch(campaign.batchJobId);
      console.log(`▶️ [Campaign Executor] Resumed campaign ${campaignId} (reason: ${reason})`);

      // Update campaign status back to running
      await db
        .update(campaigns)
        .set({ 
          status: 'running',
          batchJobStatus: batchJob.status,
          completedAt: null,
          config: sql`jsonb_set(COALESCE(config, '{}'::jsonb), '{resumeReason}', ${JSON.stringify(reason)}::jsonb)`
        })
        .where(eq(campaigns.id, campaignId));

      return batchJob;
    } catch (error: any) {
      console.error(`❌ [Campaign Executor] Failed to resume campaign ${campaignId}:`, error);
      throw error;
    }
  }

  /**
   * Retry failed and no-response calls in a campaign (alias for resumeCampaign)
   * @deprecated Use resumeCampaign instead
   */
  async retryCampaign(campaignId: string): Promise<BatchJob | null> {
    return this.resumeCampaign(campaignId, 'manual');
  }

  /**
   * Make a call using ElevenLabs native Twilio integration
   * ElevenLabs handles the call directly - we just initiate and track
   */
  private async makeCall(config: CallConfig): Promise<CallResult> {
    try {
      // Get phone number details - must have elevenLabsPhoneNumberId for native integration
      const [phoneNumber] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, config.phoneNumberId))
        .limit(1);

      if (!phoneNumber) {
        throw new Error('Phone number not found');
      }

      if (!phoneNumber.elevenLabsPhoneNumberId) {
        throw new Error('Phone number not synced with ElevenLabs. Please sync your phone numbers first.');
      }

      // Get contact details
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, config.contactId))
        .limit(1);

      if (!contact) {
        throw new Error('Contact not found');
      }

      // Get agent details
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, config.agentId))
        .limit(1);

      if (!agent) {
        throw new Error('Agent not found');
      }

      // Validate agent has ElevenLabs agent ID
      if (!agent.elevenLabsAgentId) {
        throw new Error('Agent not synced with ElevenLabs');
      }

      // Get the correct credential for this agent
      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        throw new Error("No ElevenLabs credential found for agent");
      }

      // Create ElevenLabsService with agent's credential
      const agentElevenLabsService = new ElevenLabsService(credential.apiKey);

      // Create call record first
      const [callRecord] = await db
        .insert(calls)
        .values({
          userId: config.userId, // Direct user ownership for guaranteed isolation
          campaignId: config.campaignId,
          contactId: config.contactId,
          phoneNumber: contact.phone,
          fromNumber: phoneNumber.phoneNumber,
          toNumber: contact.phone,
          status: 'initiated',
          callDirection: 'outgoing',
          startedAt: new Date(),
        })
        .returning();

      console.log(`[Campaign Executor] 📞 Initiating call via ElevenLabs native integration`);
      console.log(`   Contact: ${contact.firstName} ${contact.lastName || ''} (${contact.phone})`);
      console.log(`   From: ${phoneNumber.phoneNumber} (ElevenLabs ID: ${phoneNumber.elevenLabsPhoneNumberId})`);
      console.log(`   Agent: ${agent.name} (ElevenLabs ID: ${agent.elevenLabsAgentId})`);
      console.log(`   Credential: ${credential.name}`);

      try {
        // Initiate call via ElevenLabs API - they handle everything
        const callResult = await agentElevenLabsService.initiateOutboundCall({
          phoneNumberId: phoneNumber.elevenLabsPhoneNumberId,
          toNumber: contact.phone,
          agentId: agent.elevenLabsAgentId,
          firstMessage: config.customScript ? undefined : agent.firstMessage || undefined,
        });

        console.log(`✅ [Campaign Executor] ElevenLabs call initiated`);
        console.log(`   Conversation ID: ${callResult.conversation_id}`);
        if (callResult.call_sid) {
          console.log(`   Call SID: ${callResult.call_sid}`);
        }

        // Update call record with ElevenLabs conversation ID and Twilio SID
        await db
          .update(calls)
          .set({ 
            elevenLabsConversationId: callResult.conversation_id,
            twilioSid: callResult.call_sid || null,
            status: 'ringing',
            metadata: {
              initiatedVia: 'elevenlabs_native',
              agentName: agent.name,
              credentialName: credential.name,
            }
          })
          .where(eq(calls.id, callRecord.id));

        return {
          callId: callRecord.id,
          status: 'completed',
          twilioCallSid: callResult.call_sid
        };

      } catch (callError: any) {
        console.error(`❌ [Campaign Executor] ElevenLabs call initiation failed:`, callError);
        
        // Mark call as failed in database
        await db
          .update(calls)
          .set({ 
            status: 'failed',
            endedAt: new Date(),
            metadata: { error: `ElevenLabs error: ${callError.message}` }
          })
          .where(eq(calls.id, callRecord.id));
        
        return {
          callId: callRecord.id,
          status: 'failed',
          error: callError.message
        };
      }

    } catch (error) {
      console.error('Failed to make call:', error);
      
      return {
        callId: config.contactId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Map error messages to error codes for campaign.failed webhook
   */
  private getErrorCode(errorMessage: string): string {
    const message = errorMessage.toLowerCase();
    
    if (message.includes('insufficient') && message.includes('credit')) {
      return 'INSUFFICIENT_CREDITS';
    }
    if (message.includes('elevenlabs') || message.includes('eleven labs')) {
      return 'ELEVENLABS_API_ERROR';
    }
    if (message.includes('twilio')) {
      return 'TWILIO_API_ERROR';
    }
    if (message.includes('plivo')) {
      return 'PLIVO_API_ERROR';
    }
    if (message.includes('phone') && (message.includes('not found') || message.includes('not synced'))) {
      return 'PHONE_NUMBER_ERROR';
    }
    if (message.includes('agent') && (message.includes('not found') || message.includes('not synced'))) {
      return 'AGENT_ERROR';
    }
    if (message.includes('credential') && message.includes('not found')) {
      return 'CREDENTIAL_ERROR';
    }
    if (message.includes('campaign') && message.includes('not found')) {
      return 'CAMPAIGN_NOT_FOUND';
    }
    if (message.includes('no contacts') || message.includes('has no contacts')) {
      return 'NO_CONTACTS';
    }
    if (message.includes('database') || message.includes('db')) {
      return 'DATABASE_ERROR';
    }
    if (message.includes('concurrency') || message.includes('limit')) {
      return 'CONCURRENCY_LIMIT';
    }
    if (message.includes('migration')) {
      return 'MIGRATION_ERROR';
    }
    if (message.includes('timeout')) {
      return 'TIMEOUT_ERROR';
    }
    
    return 'EXECUTION_ERROR';
  }

  async stopCampaign(campaignId: string): Promise<void> {
    // Update campaign status
    await db
      .update(campaigns)
      .set({ 
        status: 'paused',
        completedAt: new Date()
      })
      .where(eq(campaigns.id, campaignId));

    // Close any active WebSocket connections for this campaign
    const entries = Array.from(this.activeWebSockets.entries());
    for (const [key, ws] of entries) {
      if (key.startsWith(campaignId)) {
        ws.close();
        this.activeWebSockets.delete(key);
      }
    }
  }
}

export const campaignExecutor = new CampaignExecutor();