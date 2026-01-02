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
import { Campaign, campaigns, calls } from "@shared/schema";
import { db } from '../db';
import { eq, and, or, isNotNull, sql } from 'drizzle-orm';

export class CampaignScheduler {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isRunning = false;

  /**
   * Start the background scheduler that checks campaigns every minute
   */
  static startBackgroundScheduler(): void {
    if (this.intervalId) {
      console.log('[Campaign Scheduler] Background scheduler already running');
      return;
    }

    console.log('🕐 [Campaign Scheduler] Starting background scheduler (60s interval)');
    
    // Run immediately on start
    this.checkScheduledCampaigns().catch(err => {
      console.error('[Campaign Scheduler] Initial check failed:', err);
    });
    this.pollRunningBatchJobs().catch(err => {
      console.error('[Campaign Scheduler] Initial batch poll failed:', err);
    });

    // Then run every 60 seconds
    this.intervalId = setInterval(() => {
      this.checkScheduledCampaigns().catch(err => {
        console.error('[Campaign Scheduler] Scheduled check failed:', err);
      });
      this.pollRunningBatchJobs().catch(err => {
        console.error('[Campaign Scheduler] Batch poll failed:', err);
      });
    }, 60 * 1000);
  }

  /**
   * Stop the background scheduler
   */
  static stopBackgroundScheduler(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Campaign Scheduler] Background scheduler stopped');
    }
  }

  /**
   * Check all scheduled campaigns and auto-pause/resume based on time windows
   */
  static async checkScheduledCampaigns(): Promise<void> {
    if (this.isRunning) {
      console.log('[Campaign Scheduler] Check already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    
    try {
      // Import campaignExecutor dynamically to avoid circular dependency
      const { campaignExecutor } = await import('./campaign-executor');

      // Find running campaigns that need to be paused (outside time window)
      const runningCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'running'),
            eq(campaigns.scheduleEnabled, true),
            isNotNull(campaigns.batchJobId)
          )
        );

      for (const campaign of runningCampaigns) {
        const isWithinWindow = this.isWithinCallWindow(campaign);
        
        if (!isWithinWindow) {
          console.log(`⏸️ [Campaign Scheduler] Auto-pausing campaign "${campaign.name}" (outside time window)`);
          try {
            await campaignExecutor.pauseCampaign(campaign.id, 'scheduled');
          } catch (err: any) {
            console.error(`   Failed to pause: ${err.message}`);
          }
        }
      }

      // Find paused campaigns that can be resumed (inside time window)
      const pausedCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'paused'),
            eq(campaigns.scheduleEnabled, true),
            isNotNull(campaigns.batchJobId)
          )
        );

      for (const campaign of pausedCampaigns) {
        // Only auto-resume if it was paused by the scheduler (not manually)
        const config = campaign.config as Record<string, any> || {};
        if (config.pauseReason !== 'scheduled') {
          continue;
        }

        const isWithinWindow = this.isWithinCallWindow(campaign);
        
        if (isWithinWindow) {
          console.log(`▶️ [Campaign Scheduler] Auto-resuming campaign "${campaign.name}" (inside time window)`);
          try {
            await campaignExecutor.resumeCampaign(campaign.id, 'scheduled');
          } catch (err: any) {
            console.error(`   Failed to resume: ${err.message}`);
          }
        }
      }

    } catch (error) {
      console.error('[Campaign Scheduler] Error checking campaigns:', error);
    } finally {
      this.isRunning = false;
    }
  }

  static isWithinCallWindow(campaign: Campaign): boolean {
    if (!campaign.scheduleEnabled) {
      return true;
    }

    const now = new Date();
    const timezone = campaign.scheduleTimezone || "America/New_York";
    
    const currentTimeInZone = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    const dayOfWeek = currentTimeInZone.toLocaleDateString("en-US", { weekday: "long", timeZone: timezone }).toLowerCase();
    
    if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
      if (!campaign.scheduleDays.includes(dayOfWeek)) {
        return false;
      }
    }
    
    if (campaign.scheduleTimeStart && campaign.scheduleTimeEnd) {
      const currentHours = currentTimeInZone.getHours();
      const currentMinutes = currentTimeInZone.getMinutes();
      const currentTimeMinutes = currentHours * 60 + currentMinutes;
      
      const [startHours, startMinutes] = campaign.scheduleTimeStart.split(":").map(Number);
      const startTimeMinutes = startHours * 60 + startMinutes;
      
      const [endHours, endMinutes] = campaign.scheduleTimeEnd.split(":").map(Number);
      const endTimeMinutes = endHours * 60 + endMinutes;
      
      if (currentTimeMinutes < startTimeMinutes || currentTimeMinutes > endTimeMinutes) {
        return false;
      }
    }
    
    return true;
  }

  static getNextCallWindow(campaign: Campaign): Date | null {
    if (!campaign.scheduleEnabled) {
      return new Date();
    }

    const timezone = campaign.scheduleTimezone || "America/New_York";
    const now = new Date();
    
    for (let daysAhead = 0; daysAhead < 7; daysAhead++) {
      const checkDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      
      const dayOfWeek = checkDate.toLocaleDateString("en-US", { 
        weekday: "long", 
        timeZone: timezone 
      }).toLowerCase();
      
      if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
        if (!campaign.scheduleDays.includes(dayOfWeek)) {
          continue;
        }
      }
      
      if (campaign.scheduleTimeStart) {
        const [startHours, startMinutes] = campaign.scheduleTimeStart.split(":").map(Number);
        
        // NOTE: This timezone conversion uses an iterative approach to handle most cases.
        // Known limitation: May have edge cases during DST transitions (spring forward/fall back).
        // For production use with precise DST handling, consider using a library like Temporal or luxon.
        
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        
        const parts = formatter.formatToParts(checkDate);
        const targetYear = parseInt(parts.find(p => p.type === "year")!.value, 10);
        const targetMonth = parseInt(parts.find(p => p.type === "month")!.value, 10) - 1;
        const targetDay = parseInt(parts.find(p => p.type === "day")!.value, 10);
        
        let guessUTC = Date.UTC(targetYear, targetMonth, targetDay, startHours, startMinutes, 0);
        let iterations = 0;
        const maxIterations = 3;
        
        while (iterations < maxIterations) {
          const guessDate = new Date(guessUTC);
          const guessParts = formatter.formatToParts(guessDate);
          
          const guessYear = parseInt(guessParts.find(p => p.type === "year")!.value, 10);
          const guessMonth = parseInt(guessParts.find(p => p.type === "month")!.value, 10) - 1;
          const guessDay = parseInt(guessParts.find(p => p.type === "day")!.value, 10);
          const guessHour = parseInt(guessParts.find(p => p.type === "hour")!.value, 10);
          const guessMinute = parseInt(guessParts.find(p => p.type === "minute")!.value, 10);
          
          if (guessYear === targetYear && guessMonth === targetMonth && guessDay === targetDay && guessHour === startHours && guessMinute === startMinutes) {
            break;
          }
          
          const actualLocalTime = Date.UTC(guessYear, guessMonth, guessDay, guessHour, guessMinute, 0);
          const desiredLocalTime = Date.UTC(targetYear, targetMonth, targetDay, startHours, startMinutes, 0);
          const offset = actualLocalTime - guessUTC;
          
          guessUTC = desiredLocalTime - offset;
          iterations++;
        }
        
        const correctUTC = new Date(guessUTC);
        
        if (correctUTC > now) {
          return correctUTC;
        }
      } else {
        return checkDate;
      }
    }
    
    return null;
  }

  static formatTimeWindow(campaign: Campaign): string {
    if (!campaign.scheduleEnabled) {
      return "24/7 (No restrictions)";
    }

    const parts: string[] = [];
    
    if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
      const days = campaign.scheduleDays.map(d => 
        d.charAt(0).toUpperCase() + d.slice(1)
      ).join(", ");
      parts.push(days);
    }
    
    if (campaign.scheduleTimeStart && campaign.scheduleTimeEnd) {
      parts.push(`${campaign.scheduleTimeStart} - ${campaign.scheduleTimeEnd}`);
    }
    
    if (campaign.scheduleTimezone) {
      parts.push(campaign.scheduleTimezone);
    }
    
    return parts.join(" | ");
  }

  /**
   * Poll running campaigns with batch jobs and sync status from ElevenLabs
   */
  static async pollRunningBatchJobs(): Promise<void> {
    try {
      // Find running campaigns with batch job IDs
      const runningCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'running'),
            isNotNull(campaigns.batchJobId)
          )
        );

      if (runningCampaigns.length === 0) {
        return;
      }

      console.log(`🔄 [Campaign Scheduler] Polling ${runningCampaigns.length} running batch jobs`);

      // Import campaignExecutor dynamically to avoid circular dependency
      const { campaignExecutor } = await import('./campaign-executor');

      for (const campaign of runningCampaigns) {
        try {
          console.log(`   Checking batch status for "${campaign.name}" (${campaign.batchJobId})`);
          
          // Get latest batch status from ElevenLabs
          const batchJob = await campaignExecutor.getBatchJobStatus(campaign.id);
          
          if (batchJob) {
            console.log(`   Batch status: ${batchJob.status}, dispatched: ${batchJob.total_calls_dispatched}/${batchJob.total_calls_scheduled}`);
            
            // Update pending call records based on recipient status
            if (batchJob.recipients && batchJob.recipients.length > 0) {
              await this.syncCallRecordsFromBatch(campaign.id, batchJob.recipients);
            }
          }
        } catch (err: any) {
          console.error(`   Error polling batch for "${campaign.name}": ${err.message}`);
        }
      }
    } catch (error) {
      console.error('[Campaign Scheduler] Error polling batch jobs:', error);
    }
  }

  /**
   * Sync call records based on ElevenLabs batch recipient status
   */
  private static async syncCallRecordsFromBatch(
    campaignId: string, 
    recipients: Array<{
      recipient_id: string;
      phone_number: string;
      status: string;
      conversation_id?: string;
      call_duration_secs?: number;
      error_message?: string;
    }>
  ): Promise<void> {
    for (const recipient of recipients) {
      // Skip pending recipients
      if (recipient.status === 'pending' || recipient.status === 'in_progress') {
        continue;
      }

      // Find matching call record by phone number
      const [callRecord] = await db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.campaignId, campaignId),
            eq(calls.phoneNumber, recipient.phone_number),
            eq(calls.status, 'pending')
          )
        )
        .limit(1);

      if (!callRecord) {
        // Try without country code prefix
        const phoneWithoutPlus = recipient.phone_number.replace(/^\+/, '');
        const [altCallRecord] = await db
          .select()
          .from(calls)
          .where(
            and(
              eq(calls.campaignId, campaignId),
              eq(calls.phoneNumber, phoneWithoutPlus),
              eq(calls.status, 'pending')
            )
          )
          .limit(1);
        
        if (!altCallRecord) continue;
        
        // Update the alt record
        await this.updateCallRecordFromRecipient(altCallRecord.id, recipient);
      } else {
        await this.updateCallRecordFromRecipient(callRecord.id, recipient);
      }
    }
  }

  /**
   * Update a call record based on recipient status from ElevenLabs
   */
  private static async updateCallRecordFromRecipient(
    callId: string,
    recipient: {
      status: string;
      conversation_id?: string;
      call_duration_secs?: number;
      error_message?: string;
    }
  ): Promise<void> {
    // Map ElevenLabs recipient status to our call status
    let callStatus: 'completed' | 'failed' | 'no-answer' = 'failed';
    if (recipient.status === 'completed') {
      callStatus = 'completed';
    } else if (recipient.status === 'no_response') {
      callStatus = 'no-answer';
    }

    const updateData: Record<string, any> = {
      status: callStatus,
      duration: recipient.call_duration_secs || 0,
    };

    if (recipient.conversation_id) {
      updateData.elevenLabsConversationId = recipient.conversation_id;
    }

    // Store error message in metadata if present
    if (recipient.error_message) {
      updateData.metadata = sql`COALESCE(${calls.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorMessage: recipient.error_message })}::jsonb`;
    }

    await db
      .update(calls)
      .set(updateData)
      .where(eq(calls.id, callId));

    console.log(`   Updated call ${callId}: status=${callStatus}, conversation_id=${recipient.conversation_id || 'N/A'}`);
  }
}
