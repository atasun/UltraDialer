'use strict';
/**
 * ============================================================
 * Twilio-OpenAI Batch Calling Service
 * 
 * Manages bulk outbound calling campaigns via Twilio + OpenAI:
 * - Concurrent call management with configurable limits
 * - Rate limiting to avoid overwhelming Twilio API
 * - Queue processing for large contact lists
 * - Integration with OpenAI pool for slot reservation
 * - Campaign progress tracking with real-time updates
 * ============================================================
 */

import { db } from "../../../db";
import { campaigns, contacts, twilioOpenaiCalls, agents, phoneNumbers } from "@shared/schema";
import { eq, inArray, ne, and, sql } from "drizzle-orm";
import { TwilioOpenAICallService } from "./twilio-openai-call.service";
import { logger } from '../../../utils/logger';
import { OpenAIPoolService } from "../../plivo/services/openai-pool.service";
import { TWILIO_OPENAI_CONFIG } from "../config/twilio-openai-config";
import { webhookDeliveryService } from '../../../services/webhook-delivery';
import { storage } from '../../../storage';
import type { OpenAIVoice, OpenAIRealtimeModel } from "../types";

type Campaign = typeof campaigns.$inferSelect;
type Contact = typeof contacts.$inferSelect;
type Agent = typeof agents.$inferSelect;
type PhoneNumber = typeof phoneNumbers.$inferSelect;

interface BatchCallConfig {
  campaignId: string;
  userId: string;
  agentId: string;
  phoneNumberId: string;
  maxConcurrentCalls: number;
  callDelayMs: number;
}

interface BatchCallProgress {
  total: number;
  queued: number;
  inProgress: number;
  completed: number;
  failed: number;
  percentage: number;
}

interface ActiveCall {
  callId: string;
  contactId: string;
  twilioCallSid?: string;
  startTime: Date;
  openaiCredentialId?: string;
}

interface BatchJobResult {
  campaignId: string;
  status: 'completed' | 'failed' | 'cancelled';
  totalCalls: number;
  completedCalls: number;
  failedCalls: number;
  duration: number;
}

const DEFAULT_CONCURRENT_CALLS = 5;
const DEFAULT_CALL_DELAY_MS = 1000;
const DEFAULT_MAX_CALL_DURATION = 3600;

export class TwilioOpenAIBatchCallingService {
  private activeCalls: Map<string, ActiveCall> = new Map();
  private callQueue: Contact[] = [];
  private processedContactIds: Set<string> = new Set();
  private isProcessing: boolean = false;
  private isPaused: boolean = false;
  private isCancelled: boolean = false;
  private config: BatchCallConfig | null = null;
  private agent: Agent | null = null;
  private phoneNumber: PhoneNumber | null = null;
  private startTime: Date | null = null;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private lastProgressUpdate: number = 0;
  private totalContacts: number = 0;

  private static instances: Map<string, TwilioOpenAIBatchCallingService> = new Map();

  private constructor() {}

  static getInstance(campaignId: string): TwilioOpenAIBatchCallingService {
    if (!this.instances.has(campaignId)) {
      this.instances.set(campaignId, new TwilioOpenAIBatchCallingService());
    }
    return this.instances.get(campaignId)!;
  }

  static removeInstance(campaignId: string): void {
    this.instances.delete(campaignId);
  }

  static getActiveInstances(): string[] {
    return Array.from(this.instances.keys());
  }

  async executeCampaign(campaignId: string): Promise<BatchJobResult> {
    logger.info(`Starting campaign execution: ${campaignId}`, undefined, 'TwilioOpenAIBatch');

    try {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);

      if (!campaign) {
        throw new Error('Campaign not found');
      }

      if (!campaign.agentId) {
        throw new Error('Campaign has no agent configured');
      }

      if (!campaign.phoneNumberId) {
        throw new Error('Campaign has no phone number configured');
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, campaign.agentId))
        .limit(1);

      if (!agent) {
        throw new Error('Agent not found');
      }

      const [phoneNumber] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, campaign.phoneNumberId))
        .limit(1);

      if (!phoneNumber) {
        throw new Error('Phone number not found');
      }

      if (phoneNumber.status !== 'active') {
        throw new Error('Phone number is not active');
      }

      // Use paginated loading - get counts first, then load contacts in batches
      const CONTACT_BATCH_SIZE = 500;
      
      // Get counts by status using aggregate query (memory efficient)
      const statusCounts = await db
        .select({
          status: contacts.status,
          count: sql<number>`count(*)::int`,
        })
        .from(contacts)
        .where(eq(contacts.campaignId, campaignId))
        .groupBy(contacts.status);
      
      const totalCount = statusCounts.reduce((sum, s) => sum + s.count, 0);
      if (totalCount === 0) {
        throw new Error('Campaign has no contacts');
      }
      
      const initialCompleted = statusCounts.find(s => s.status === 'completed')?.count || 0;
      const initialFailed = statusCounts.find(s => s.status === 'failed')?.count || 0;
      const pendingCount = totalCount - initialCompleted - initialFailed;
      
      // Load first batch of pending contacts (pending or in_progress)
      const firstBatch = await db
        .select()
        .from(contacts)
        .where(and(
          eq(contacts.campaignId, campaignId),
          ne(contacts.status, 'completed'),
          ne(contacts.status, 'failed')
        ))
        .limit(CONTACT_BATCH_SIZE);

      this.agent = agent;
      this.phoneNumber = phoneNumber;
      this.callQueue = firstBatch;
      this.totalContacts = totalCount;
      this.startTime = new Date();
      this.completedCount = initialCompleted;
      this.failedCount = initialFailed;
      this.isProcessing = true;
      this.isPaused = false;
      this.isCancelled = false;

      const campaignConfig = campaign.config as Record<string, any> || {};
      
      // Read admin-configured concurrency limit from global settings
      const globalConcurrencySetting = await storage.getGlobalSetting('campaign_batch_concurrency');
      const adminConcurrencyLimit = typeof globalConcurrencySetting?.value === 'number' 
        ? globalConcurrencySetting.value 
        : (typeof globalConcurrencySetting?.value === 'string' ? parseInt(globalConcurrencySetting.value, 10) : null);
      
      // Priority: campaign config > admin setting > engine default
      const concurrencyLimit = campaignConfig.maxConcurrentCalls || adminConcurrencyLimit || DEFAULT_CONCURRENT_CALLS;
      const callDelay = campaignConfig.callDelayMs || DEFAULT_CALL_DELAY_MS;

      this.config = {
        campaignId,
        userId: campaign.userId,
        agentId: campaign.agentId,
        phoneNumberId: campaign.phoneNumberId,
        maxConcurrentCalls: concurrencyLimit,
        callDelayMs: callDelay,
      };

      logger.info(`Agent: ${agent.name}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Phone: ${phoneNumber.phoneNumber}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Total Contacts: ${totalCount}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Pending: ${pendingCount}, Already Completed: ${initialCompleted}, Already Failed: ${initialFailed}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Concurrency: ${concurrencyLimit} (paginated loading: ${CONTACT_BATCH_SIZE} contacts/batch)`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Call Delay: ${callDelay}ms`, undefined, 'TwilioOpenAIBatch');

      await db
        .update(campaigns)
        .set({
          status: 'running',
          startedAt: new Date(),
          totalContacts: totalCount,
        })
        .where(eq(campaigns.id, campaignId));

      await this.processQueue();

      const duration = this.startTime 
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : 0;

      // Query authoritative counts from database for accuracy (using aggregate for efficiency)
      const finalStatusCounts = await db
        .select({
          status: contacts.status,
          count: sql<number>`count(*)::int`,
        })
        .from(contacts)
        .where(eq(contacts.campaignId, campaignId))
        .groupBy(contacts.status);

      const dbCompletedCount = finalStatusCounts.find(s => s.status === 'completed')?.count || 0;
      const dbFailedCount = finalStatusCounts.find(s => s.status === 'failed')?.count || 0;

      const result: BatchJobResult = {
        campaignId,
        status: this.isCancelled ? 'cancelled' : 'completed',
        totalCalls: this.totalContacts,
        completedCalls: dbCompletedCount,
        failedCalls: dbFailedCount,
        duration,
      };

      await db
        .update(campaigns)
        .set({
          status: this.isCancelled ? 'cancelled' : 'completed',
          completedAt: new Date(),
          completedCalls: dbCompletedCount + dbFailedCount,
          successfulCalls: dbCompletedCount,
          failedCalls: dbFailedCount,
        })
        .where(eq(campaigns.id, campaignId));

      logger.info(`Campaign ${campaignId} finished`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Status: ${result.status}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Completed: ${result.completedCalls}/${result.totalCalls}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Failed: ${result.failedCalls}`, undefined, 'TwilioOpenAIBatch');
      logger.info(`Duration: ${result.duration}s`, undefined, 'TwilioOpenAIBatch');

      TwilioOpenAIBatchCallingService.removeInstance(campaignId);
      return result;

    } catch (error: any) {
      logger.error(`Campaign ${campaignId} failed`, error, 'TwilioOpenAIBatch');

      await db
        .update(campaigns)
        .set({
          status: 'failed',
          completedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId));

      TwilioOpenAIBatchCallingService.removeInstance(campaignId);

      throw error;
    }
  }

  /**
   * Process the call queue with concurrency limits and paginated loading
   */
  private async processQueue(): Promise<void> {
    const CONTACT_BATCH_SIZE = 500;
    logger.info(`Processing queue with ${this.callQueue.length} contacts (paginated)`, undefined, 'TwilioOpenAIBatch');

    while (true) {
      if (this.isCancelled) {
        logger.info('Campaign cancelled, stopping queue processing', undefined, 'TwilioOpenAIBatch');
        await this.releaseAllActiveSlots();
        break;
      }

      if (this.isPaused) {
        logger.info('Campaign paused, waiting...', undefined, 'TwilioOpenAIBatch');
        await this.sleep(1000);
        continue;
      }

      // Refill queue from database if running low and there are more pending contacts
      if (this.callQueue.length < 50 && this.config) {
        const moreContacts = await db
          .select()
          .from(contacts)
          .where(and(
            eq(contacts.campaignId, this.config.campaignId),
            ne(contacts.status, 'completed'),
            ne(contacts.status, 'failed'),
            ne(contacts.status, 'in_progress')
          ))
          .limit(CONTACT_BATCH_SIZE);
        
        if (moreContacts.length > 0) {
          // Filter out contacts already in queue
          const existingIds = new Set(this.callQueue.map(c => c.id));
          const newContacts = moreContacts.filter(c => !existingIds.has(c.id));
          if (newContacts.length > 0) {
            this.callQueue.push(...newContacts);
            logger.info(`Refilled queue with ${newContacts.length} contacts (total: ${this.callQueue.length})`, undefined, 'TwilioOpenAIBatch');
          }
        }
      }

      // Exit if no more work to do
      if (this.callQueue.length === 0 && this.activeCalls.size === 0) {
        break;
      }

      while (
        this.callQueue.length > 0 &&
        this.activeCalls.size < this.config!.maxConcurrentCalls
      ) {
        if (this.isPaused || this.isCancelled) {
          break;
        }

        const hasCapacity = await this.checkOpenAICapacity();
        if (!hasCapacity) {
          logger.info('No OpenAI capacity available, waiting...', undefined, 'TwilioOpenAIBatch');
          await this.sleep(2000);
          break;
        }

        const contact = this.callQueue.shift()!;
        this.initiateCallForContact(contact).catch(err => {
          logger.error(`Failed to initiate call for ${contact.phone}`, err, 'TwilioOpenAIBatch');
          this.failedCount++;
        });

        if (this.config!.callDelayMs > 0 && this.callQueue.length > 0) {
          await this.sleep(this.config!.callDelayMs);
        }
      }

      await this.updateProgress();
      await this.sleep(500);
    }

    this.isProcessing = false;
    logger.info('Queue processing complete', undefined, 'TwilioOpenAIBatch');
  }

  private async checkOpenAICapacity(): Promise<boolean> {
    const stats = await OpenAIPoolService.getPoolStats();
    return stats.availableCapacity > 0;
  }

  private async initiateCallForContact(contact: Contact): Promise<void> {
    if (!this.config || !this.agent || !this.phoneNumber) {
      throw new Error('Batch calling service not properly initialized');
    }

    logger.info(`Initiating call to ${contact.phone}`, undefined, 'TwilioOpenAIBatch');

    try {
      await db
        .update(contacts)
        .set({ status: 'in_progress' })
        .where(eq(contacts.id, contact.id));

      const systemPrompt = this.buildSystemPrompt(contact);
      const firstMessage = this.buildFirstMessage(contact);

      const result = await TwilioOpenAICallService.initiateCall({
        userId: this.config.userId,
        agentId: this.config.agentId,
        toNumber: contact.phone,
        fromNumberId: this.config.phoneNumberId,
        campaignId: this.config.campaignId,
        contactId: contact.id,
        metadata: {
          batchCall: true,
          contactName: `${contact.firstName} ${contact.lastName || ''}`.trim(),
          customSystemPrompt: systemPrompt,
          customFirstMessage: firstMessage,
        },
      });

      if (!result.success || !result.callId) {
        throw new Error(result.error || 'Failed to initiate call');
      }

      this.activeCalls.set(result.callId, {
        callId: result.callId,
        contactId: contact.id,
        twilioCallSid: result.twilioCallSid,
        startTime: new Date(),
      });

      // Trigger call.started webhook event
      if (this.config && this.config.userId) {
        try {
          const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';
          await webhookDeliveryService.triggerEvent(this.config.userId, 'call.started', {
            call: {
              id: result.callId,
              callSid: result.twilioCallSid || null,
              direction: 'outbound',
              status: 'initiated',
              startedAt: new Date().toISOString(),
              fromNumber: this.phoneNumber?.phoneNumber || null,
              toNumber: contact.phone,
            },
            contact: {
              id: contact.id,
              name: contactName,
              phone: contact.phone,
              email: contact.email || null,
            },
            campaign: {
              id: this.config.campaignId,
              name: null,
            },
            agent: {
              id: this.config.agentId,
              name: this.agent?.name || null,
            },
          });
          logger.info(`Triggered call.started webhook for call ${result.callId}`, undefined, 'TwilioOpenAIBatch');
        } catch (webhookError: any) {
          logger.error(`Failed to trigger call.started webhook: ${webhookError.message}`, undefined, 'TwilioOpenAIBatch');
        }
      }

      this.monitorCall(result.callId, contact.id);

    } catch (error: any) {
      logger.error(`Call initiation failed for ${contact.phone}`, error, 'TwilioOpenAIBatch');
      
      await db
        .update(contacts)
        .set({ status: 'failed' })
        .where(eq(contacts.id, contact.id));

      this.failedCount++;
    }
  }

  private async monitorCall(callId: string, contactId: string): Promise<void> {
    const checkInterval = 2000;
    const maxDuration = (TWILIO_OPENAI_CONFIG.maxCallDuration || DEFAULT_MAX_CALL_DURATION) * 1000;
    const startTime = Date.now();

    const checkStatus = async () => {
      try {
        if (this.isCancelled) {
          await this.endCall(callId);
          return;
        }

        const call = await TwilioOpenAICallService.getCallStatus(callId);
        if (!call) {
          await this.handleCallEnd(callId, contactId, false);
          return;
        }

        if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(call.status)) {
          const success = call.status === 'completed';
          await this.handleCallEnd(callId, contactId, success);
          return;
        }

        if (Date.now() - startTime > maxDuration) {
          logger.info(`Call ${callId} exceeded max duration, ending`, undefined, 'TwilioOpenAIBatch');
          await this.endCall(callId);
          return;
        }

        setTimeout(checkStatus, checkInterval);
      } catch (error) {
        logger.error(`Error monitoring call ${callId}`, error, 'TwilioOpenAIBatch');
        this.activeCalls.delete(callId);
        this.failedCount++;
      }
    };

    setTimeout(checkStatus, checkInterval);
  }

  private async handleCallEnd(callId: string, contactId: string, success: boolean): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      logger.info(`Call ${callId} already processed, skipping`, undefined, 'TwilioOpenAIBatch');
      return;
    }
    this.activeCalls.delete(callId);

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    if (!contact) {
      logger.warn(`Contact ${contactId} not found`, undefined, 'TwilioOpenAIBatch');
      return;
    }

    if (contact.status !== 'completed' && contact.status !== 'failed') {
      const newStatus = success ? 'completed' : 'failed';
      await db
        .update(contacts)
        .set({ status: newStatus })
        .where(eq(contacts.id, contactId));

      if (success) {
        this.completedCount++;
        logger.info(`Call ${callId} completed successfully`, undefined, 'TwilioOpenAIBatch');
      } else {
        this.failedCount++;
        logger.error(`Call ${callId} failed`, undefined, 'TwilioOpenAIBatch');
      }
    } else {
      if (contact.status === 'completed') {
        this.completedCount++;
      } else {
        this.failedCount++;
      }
      logger.info(`Call ${callId} already marked as ${contact.status} by webhook`, undefined, 'TwilioOpenAIBatch');
    }
  }

  private async endCall(callId: string): Promise<void> {
    try {
      const call = await TwilioOpenAICallService.getCallStatus(callId);
      if (call?.twilioCallSid) {
        await TwilioOpenAICallService.hangupCall(call.twilioCallSid);
      }
    } catch (error) {
      logger.error(`Failed to end call ${callId}`, error, 'TwilioOpenAIBatch');
    }
  }

  private async releaseAllActiveSlots(): Promise<void> {
    const entries = Array.from(this.activeCalls.entries());
    const contactIds: string[] = [];

    for (const [callId, activeCall] of entries) {
      contactIds.push(activeCall.contactId);
      try {
        await this.endCall(callId);
      } catch (e) {
        // Ignore errors when force-ending calls
      }
    }

    if (contactIds.length > 0) {
      await db
        .update(contacts)
        .set({ status: 'failed' })
        .where(inArray(contacts.id, contactIds));
      logger.info(`Marked ${contactIds.length} active contacts as failed`, undefined, 'TwilioOpenAIBatch');
    }

    this.activeCalls.clear();
  }

  private buildSystemPrompt(contact: Contact): string {
    let prompt = this.agent?.systemPrompt || '';
    
    prompt = prompt.replace(/\{firstName\}/g, contact.firstName);
    prompt = prompt.replace(/\{lastName\}/g, contact.lastName || '');
    prompt = prompt.replace(/\{phone\}/g, contact.phone);
    prompt = prompt.replace(/\{email\}/g, contact.email || '');

    const customFields = contact.customFields as Record<string, any> || {};
    for (const [key, value] of Object.entries(customFields)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value || ''));
    }

    return prompt;
  }

  private buildFirstMessage(contact: Contact): string | undefined {
    let message = this.agent?.firstMessage || '';
    if (!message) return undefined;

    message = message.replace(/\{firstName\}/g, contact.firstName);
    message = message.replace(/\{lastName\}/g, contact.lastName || '');
    message = message.replace(/\{phone\}/g, contact.phone);
    message = message.replace(/\{email\}/g, contact.email || '');

    const customFields = contact.customFields as Record<string, any> || {};
    for (const [key, value] of Object.entries(customFields)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value || ''));
    }

    return message;
  }

  private async updateProgress(): Promise<void> {
    const now = Date.now();
    if (now - this.lastProgressUpdate < 5000) return;
    this.lastProgressUpdate = now;

    if (!this.config) return;

    const campaignContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.campaignId, this.config.campaignId));

    const dbCompletedCount = campaignContacts.filter(c => c.status === 'completed').length;
    const dbFailedCount = campaignContacts.filter(c => c.status === 'failed').length;

    this.completedCount = dbCompletedCount;
    this.failedCount = dbFailedCount;

    await db
      .update(campaigns)
      .set({
        completedCalls: dbCompletedCount + dbFailedCount,
        successfulCalls: dbCompletedCount,
        failedCalls: dbFailedCount,
      })
      .where(eq(campaigns.id, this.config.campaignId));
  }

  getProgress(): BatchCallProgress {
    const total = this.completedCount + this.failedCount + this.callQueue.length + this.activeCalls.size;
    const processed = this.completedCount + this.failedCount;

    return {
      total,
      queued: this.callQueue.length,
      inProgress: this.activeCalls.size,
      completed: this.completedCount,
      failed: this.failedCount,
      percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
    };
  }

  pause(): void {
    logger.info('Pausing campaign', undefined, 'TwilioOpenAIBatch');
    this.isPaused = true;
  }

  resume(): void {
    logger.info('Resuming campaign', undefined, 'TwilioOpenAIBatch');
    this.isPaused = false;
  }

  async cancel(): Promise<void> {
    logger.info('Cancelling campaign', undefined, 'TwilioOpenAIBatch');
    this.isCancelled = true;

    if (this.callQueue.length > 0 && this.config) {
      const queuedContactIds = this.callQueue.map(c => c.id);
      await db
        .update(contacts)
        .set({ status: 'failed' })
        .where(inArray(contacts.id, queuedContactIds));
      logger.info(`Marked ${queuedContactIds.length} queued contacts as failed`, undefined, 'TwilioOpenAIBatch');
    }
    this.callQueue = [];

    await this.releaseAllActiveSlots();
  }

  isRunning(): boolean {
    return this.isProcessing && !this.isPaused && !this.isCancelled;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
